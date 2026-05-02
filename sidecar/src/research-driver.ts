// Deep-research driver per ADR-0017 / spec.md Flow M.
//
// Same shape as chat-driver / orchestrator-driver: opens a Claude Agent SDK
// session distinct from the build orchestrator (its own stream id in the
// `inflight` map), feeds it the current spec.md + recorded answers + approved
// file summaries, and lets it call two MCP tools:
//   - record_finding({ topic, body })           — streams progress to UI
//   - propose_spec_revision({ markdown, summaryOfChanges }) — closing action
//
// Cap: 5 minutes wall-clock + maxTurns: 8 (rule L19). The transport seam
// follows the validator/driver.ts pattern so tests run deterministically
// without a real SDK call (G4 echo-back decision #1, applied here too).
//
// The proposed spec is NOT written to disk by this driver. The webview
// receives it via a `proposal` event and is responsible for backing up the
// original (Tauri command `backup_target_spec`) before overwriting spec.md.
// See ADR-0017 §"Why the proposed spec is held in sidecar memory".

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  query,
  type Options,
  type SDKMessage,
  createSdkMcpServer,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { appendDirect as persistFinding } from "./handlers/research-findings.js";

// The system prompt now arrives in the params (the Rust shell embeds it
// via include_str!). The fallback file path is only used when the
// integration test calls runResearch directly without a Tauri shell —
// production paths always pass `systemPrompt`.
const RESEARCH_PROMPT_RELATIVE_PATH = "lib/llm/prompts/deep-research.v2.md";
// 10-min wall-clock + 15 SDK steps lets the agent actually do web
// research (search → fetch → synthesise) instead of just thinking
// from training data. Bumped from 5min/8 in v2.
const MAX_WALL_CLOCK_MS = 10 * 60 * 1000;
const MAX_STEPS = 15;

export interface ResearchOptions {
  projectId: string;
  projectPath: string;
  /** The current spec.md content, fenced into the user prompt. */
  specMarkdown: string;
  /** One line per recorded answer: "Q12 (confident): ..." */
  answersDigest: string;
  /** One block per approved file: "## file.pdf\n<summary>" */
  filesDigest: string;
  /** Pre-loaded system prompt (Rust shell ships this via include_str!).
   *  When present, the driver uses it verbatim and skips the file load. */
  systemPrompt?: string;
  /** Test-only fallback: path to the repo root for the file-based load
   *  branch (`lib/llm/prompts/...`). Production passes `systemPrompt`. */
  builderRepoPath?: string;
  /** Model id from settings — when omitted, the driver uses its
   *  built-in default (claude-opus-4-5). */
  model?: string;
}

export type ResearchEvent =
  | { kind: "session"; id: string }
  | { kind: "assistant_delta"; text: string }
  | {
      kind: "finding";
      topic: string;
      body: string;
      axis: string | null;
      sources: string[];
    }
  | { kind: "proposal"; markdown: string; summaryOfChanges: string }
  | {
      kind: "done";
      cost_usd: number | null;
      input_tokens: number | null;
      output_tokens: number | null;
      cancellation_reason: "none" | "user" | "wall_clock" | "step_cap";
    }
  | { kind: "rate_limit"; message: string }
  | { kind: "error"; message: string };

export interface ResearchSdkRunOptions {
  prompt: string;
  systemPrompt: string;
  cwd: string;
  /** Project ULID — used by the MCP tool to persist findings. */
  projectId: string;
  /** Scan id (driver streamId) — groups every record_finding from this run
   *  in the research_findings table. */
  scanId: string;
  /** Model id — passed through to the Claude Agent SDK. Optional;
   *  drivers fall back to their hardcoded default when undefined. */
  model?: string;
  abortController: AbortController;
  onFinding: (args: {
    topic: string;
    body: string;
    axis: string | null;
    sources: string[];
  }) => void;
  onProposal: (markdown: string, summaryOfChanges: string) => void;
}

/** Transport seam — production calls the real SDK; tests use stubTransport
 *  to drive the driver deterministically. Same pattern as
 *  `sidecar/src/debug/validator/driver.ts`. */
export interface ResearchTransport {
  run(opts: ResearchSdkRunOptions): AsyncIterable<SDKMessage>;
}

const inflight = new Map<string, AbortController>();

/** Build the MCP server that exposes record_finding + propose_spec_revision
 *  as plain Node functions. The handlers just route into the supplied
 *  callbacks; the driver holds the proposal in a closure variable. */
function buildResearchMcp(
  onFinding: (args: { topic: string; body: string; axis: string | null; sources: string[] }) => void,
  onProposal: (markdown: string, summaryOfChanges: string) => void,
) {
  return createSdkMcpServer({
    name: "research",
    version: "0.2.0",
    tools: [
      tool(
        "record_finding",
        "Stream a one-paragraph progress note for the live tail. Substantive observations only — cite WebFetch / Read sources via the sources array. The axis field maps to the prompt's 9 sections (problem_users, competitive_landscape, scope_expansion, out_of_scope, flows, data_model, integrations, nfr, open_questions) for downstream auditability.",
        {
          topic: z.string().min(1).max(120),
          body: z.string().min(1).max(2000),
          axis: z
            .enum([
              "problem_users",
              "competitive_landscape",
              "scope_expansion",
              "out_of_scope",
              "flows",
              "data_model",
              "integrations",
              "nfr",
              "open_questions",
            ])
            .nullable()
            .optional(),
          sources: z.array(z.string().min(1).max(500)).max(20).optional(),
        },
        async (args) => {
          onFinding({
            topic: args.topic,
            body: args.body,
            axis: args.axis ?? null,
            sources: args.sources ?? [],
          });
          return {
            content: [{ type: "text", text: `Recorded finding on ${args.topic}.` }],
          };
        },
      ),
      tool(
        "propose_spec_revision",
        "Submit the rewritten spec.md. Call this exactly once, at the end of the analysis.",
        {
          markdown: z.string().min(50),
          summaryOfChanges: z.string().min(10).max(4000),
        },
        async (args) => {
          onProposal(args.markdown, args.summaryOfChanges);
          return {
            content: [
              { type: "text", text: `Proposal accepted (${args.markdown.length} chars).` },
            ],
          };
        },
      ),
    ],
  });
}

/** Production transport: hands the prompt to the real Claude Agent SDK.
 *  v2 (ADR-0017 follow-up): switched to Opus + opened up WebSearch /
 *  WebFetch / Read so the run does *real* research, not just thinking. */
export const sdkTransport: ResearchTransport = {
  run(opts) {
    const mcp = buildResearchMcp(opts.onFinding, opts.onProposal);
    const sdkOptions: Options = {
      cwd: opts.cwd,
      additionalDirectories: [opts.cwd],
      // Opus for the depth + cross-doc reasoning the prompt demands.
      // Cost roughly 5× sonnet but gated to one run per project, opt-in.
      // Model can be overridden per-stage via the settings page; falls
      // back to the hardcoded default when the caller doesn't pass one.
      model: opts.model ?? "claude-opus-4-5",
      permissionMode: "default",
      allowedTools: [
        // Research tools — the whole point of v2: real web research,
        // not training-data recall.
        "WebSearch",
        "WebFetch",
        // Read into the project folder so the agent can open the
        // novice's uploaded PDFs / transcripts directly when a
        // summary is too compressed. cwd is the project path; SDK
        // path-sandboxes Read to additionalDirectories.
        "Read",
        "mcp__research__record_finding",
        "mcp__research__propose_spec_revision",
      ],
      mcpServers: { research: mcp },
      systemPrompt: opts.systemPrompt,
      maxTurns: MAX_STEPS,
      abortController: opts.abortController,
    };
    return query({ prompt: opts.prompt, options: sdkOptions });
  },
};

/** Stub transport for tests. The caller can pre-bake findings, a proposal,
 *  and any extra SDKMessages (assistant deltas, etc.) — the stub yields a
 *  session-init, fires the callbacks in order, replays the messages, then
 *  yields a result/success. */
export function stubTransport(opts: {
  findings?: ReadonlyArray<{
    topic: string;
    body: string;
    axis?: string | null;
    sources?: string[];
  }>;
  proposal?: { markdown: string; summaryOfChanges: string };
  extraMessages?: ReadonlyArray<SDKMessage>;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** When set, the stub aborts mid-run after firing N findings. The driver
   *  should still emit a `done` event with cancellation_reason="user". */
  abortAfterFindings?: number;
}): ResearchTransport {
  return {
    async *run(rOpts) {
      yield {
        type: "system",
        subtype: "init",
        session_id: "stub-research-session",
      } as unknown as SDKMessage;
      const findings = opts.findings ?? [];
      for (let i = 0; i < findings.length; i++) {
        if (opts.abortAfterFindings !== undefined && i >= opts.abortAfterFindings) {
          rOpts.abortController.abort();
          return;
        }
        const f = findings[i]!;
        rOpts.onFinding({
          topic: f.topic,
          body: f.body,
          axis: f.axis ?? null,
          sources: f.sources ?? [],
        });
      }
      if (opts.proposal) {
        rOpts.onProposal(opts.proposal.markdown, opts.proposal.summaryOfChanges);
      }
      for (const m of opts.extraMessages ?? []) yield m;
      yield {
        type: "result",
        subtype: "success",
        total_cost_usd: opts.costUsd ?? 0.0,
        usage: {
          input_tokens: opts.inputTokens ?? 0,
          output_tokens: opts.outputTokens ?? 0,
        },
      } as unknown as SDKMessage;
    },
  };
}

/** Build the user-message payload that goes to the deep-research session. */
export function buildResearchUserPrompt(opts: {
  specMarkdown: string;
  answersDigest: string;
  filesDigest: string;
}): string {
  const fileBlock =
    opts.filesDigest.trim().length === 0
      ? "(no approved files)"
      : opts.filesDigest.trim();
  return [
    "Here is the current `spec.md` to expand:",
    "",
    "```markdown",
    opts.specMarkdown,
    "```",
    "",
    "Recorded interview answers (Q1-Q35):",
    "",
    opts.answersDigest.trim().length === 0 ? "(none)" : opts.answersDigest.trim(),
    "",
    "Approved file summaries:",
    "",
    fileBlock,
    "",
    "Begin.",
  ].join("\n");
}

async function loadResearchPrompt(builderRepoPath: string | undefined): Promise<string> {
  const root = builderRepoPath ?? process.cwd();
  const path = join(root, RESEARCH_PROMPT_RELATIVE_PATH);
  return await readFile(path, "utf8");
}

export async function runResearch(
  streamId: string,
  opts: ResearchOptions,
  onEvent: (event: ResearchEvent) => void,
  transport: ResearchTransport = sdkTransport,
): Promise<void> {
  const ac = new AbortController();
  inflight.set(streamId, ac);

  // Wall-clock cap. setTimeout aborts the controller; the driver translates
  // the abort into a "done" event with cancellation_reason="wall_clock".
  let cancellationReason: "none" | "user" | "wall_clock" | "step_cap" = "none";
  const wallClockTimer = setTimeout(() => {
    if (!ac.signal.aborted) {
      cancellationReason = "wall_clock";
      ac.abort();
    }
  }, MAX_WALL_CLOCK_MS);

  try {
    const systemPrompt =
      opts.systemPrompt && opts.systemPrompt.trim().length > 0
        ? opts.systemPrompt
        : await loadResearchPrompt(opts.builderRepoPath);
    const userPrompt = buildResearchUserPrompt({
      specMarkdown: opts.specMarkdown,
      answersDigest: opts.answersDigest,
      filesDigest: opts.filesDigest,
    });
    const stream = transport.run({
      prompt: userPrompt,
      systemPrompt,
      cwd: opts.projectPath,
      projectId: opts.projectId,
      scanId: streamId,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      abortController: ac,
      onFinding: ({ topic, body, axis, sources }) => {
        // Best-effort DB persist for the audit trail. Stays in-tick
        // with the event emit so failures never desync the live tail
        // from the table; on failure we log to stderr (Tauri shell
        // captures it) and keep streaming the event regardless.
        try {
          persistFinding({
            projectId: opts.projectId,
            scanId: streamId,
            topic,
            body,
            axis,
            sources,
          });
        } catch (e) {
          process.stderr.write(
            JSON.stringify({
              level: "warn",
              message: `research_findings persist failed: ${
                e instanceof Error ? e.message : String(e)
              }`,
              at: new Date().toISOString(),
            }) + "\n",
          );
        }
        onEvent({ kind: "finding", topic, body, axis, sources });
      },
      onProposal: (markdown, summaryOfChanges) =>
        onEvent({ kind: "proposal", markdown, summaryOfChanges }),
    });

    let cost: number | null = null;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;

    for await (const msg of stream) {
      const events = translate(msg);
      for (const ev of events) {
        if (ev.kind === "_result") {
          cost = ev.cost_usd;
          inputTokens = ev.input_tokens;
          outputTokens = ev.output_tokens;
        } else {
          onEvent(ev);
        }
      }
    }

    // If the SDK reports more steps than allowed (defence in depth — the
    // SDK enforces maxTurns itself), still surface a step_cap reason.
    if (cancellationReason === "none" && ac.signal.aborted) {
      cancellationReason = "user";
    }

    onEvent({
      kind: "done",
      cost_usd: cost,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cancellation_reason: cancellationReason,
    });
  } catch (e) {
    if (ac.signal.aborted) {
      onEvent({
        kind: "done",
        cost_usd: null,
        input_tokens: null,
        output_tokens: null,
        cancellation_reason:
          cancellationReason === "none" ? "user" : cancellationReason,
      });
      return;
    }
    onEvent({ kind: "error", message: e instanceof Error ? e.message : String(e) });
  } finally {
    clearTimeout(wallClockTimer);
    inflight.delete(streamId);
  }
}

export function cancelResearch(streamId: string): boolean {
  const ac = inflight.get(streamId);
  if (!ac) return false;
  ac.abort();
  return true;
}

export function cancelAllResearch(): number {
  let count = 0;
  for (const [, ac] of inflight) {
    ac.abort();
    count++;
  }
  return count;
}

// Internal "_result" wrapper so translate() can return result data without
// emitting it directly — runResearch holds the cost/tokens until it knows
// the final cancellation_reason.
type InternalEvent =
  | Exclude<ResearchEvent, { kind: "done" }>
  | { kind: "_result"; cost_usd: number | null; input_tokens: number | null; output_tokens: number | null };

function translate(msg: SDKMessage): InternalEvent[] {
  switch (msg.type) {
    case "system": {
      const m = msg as { type: "system"; subtype?: string; session_id?: string };
      if (m.subtype === "init" && m.session_id) {
        return [{ kind: "session", id: m.session_id }];
      }
      return [];
    }
    case "assistant": {
      const m = msg as unknown as {
        type: "assistant";
        message: { content: Array<Record<string, unknown>> };
      };
      const content = Array.isArray(m.message?.content) ? m.message.content : [];
      let text = "";
      for (const block of content) {
        if (
          (block as { type?: string }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string"
        ) {
          text += (block as { text: string }).text;
        }
      }
      return text ? [{ kind: "assistant_delta", text }] : [];
    }
    case "result": {
      const m = msg as {
        type: "result";
        subtype?: string;
        total_cost_usd?: number;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      if (m.subtype !== "success") return [];
      return [
        {
          kind: "_result",
          cost_usd: typeof m.total_cost_usd === "number" ? m.total_cost_usd : null,
          input_tokens:
            typeof m.usage?.input_tokens === "number" ? m.usage.input_tokens : null,
          output_tokens:
            typeof m.usage?.output_tokens === "number" ? m.usage.output_tokens : null,
        },
      ];
    }
    default:
      return [];
  }
}
