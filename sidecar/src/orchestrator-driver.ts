// Orchestrator driver per ADR-0005. Replaces the Rust subprocess spawn
// that parses claude --output-format stream-json with a programmatic
// `query()` from @anthropic-ai/claude-agent-sdk.
//
// Why we exist: Claude Code's CLI is designed for interactive use; in
// our headless `-p` mode, six layers of permission flags fight us
// (--permission-mode, --dangerously-skip-permissions, --add-dir,
// project-local + user-level .claude/settings.json, workspace trust,
// inline --settings). The Agent SDK exposes a real canUseTool callback
// that we can route through our existing PermissionPromptBanner UI +
// permission_requests table — no flag fight.
//
// The driver translates SDKMessage events into the existing
// OrchestratorEvent shape so the Tauri shell + dashboard don't need to
// change. The Rust shell forwards events onto a Tauri Channel<T>.

import { query, type CanUseTool, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import {
  append as appendPermissionRequest,
  poll as pollPermissionRequest,
} from "./handlers/permission-requests.js";

export const ORCHESTRATOR_KICKOFF_PROMPT = `You are the Builder's build-phase agent. The novice has clicked 'Start build' inside the Builder desktop app and is watching a live dashboard. The dashboard mirrors your TodoWrite plan and shows the activeForm of whichever step is in_progress — so the words you choose ARE the user-facing status line.

Context (read in this order on the first turn):
1. CLAUDE.md at the project root — binding rules for THIS project.
2. spec.md at the project root — the SOURCE OF TRUTH for what to build. The Builder rewrites this from the novice's interview answers every time you are spawned.
3. rules/david-easter-egg.md — mandatory hidden D-EEGG requirement for EVERY generated app.
4. If spec.md is the placeholder ('Empty until the interview begins.'), ask in ONE short sentence what they want to build, then proceed.

How to run a build (do this end-to-end in this turn, do not pause for confirmation between steps):

A) PLAN
   - Use TodoWrite to lay out the steps that ship Phase 1 of spec.md. Aim for 5-12 steps, each at most one hour. Each item must have a 'content' (imperative) AND an 'activeForm' (present continuous, plain English — e.g. "Installing dependencies", "Wiring up the homepage", "Creating the database schema"). The activeForm is what the novice sees on the dashboard, so make it specific and friendly.

B) BUILD
   - Work through every plan item in order. Before starting an item, mark it in_progress with TodoWrite. When it's done, mark it completed and move on. Do NOT stop between items — keep going until the plan is complete.
   - Build INSIDE the current working directory. Don't create sibling folders or touch the user's home directory.
   - When you finish a meaningful chunk, run a quick smoke check (e.g. type-check, dev-server boot, or whatever the stack supports) before moving on.
   - D-EEGG is mandatory before REVIEW: implement a client component named DavidEasterEgg, mount it from the root layout so it works on every route, trigger it with Alt+Shift+D, show the exact text "made by david", include a cute CSS-only animation with prefers-reduced-motion support, close on Escape/outside click/short timeout, and keep the non-visible marker "builder:david-easter-egg" in source.
   - Quick-launch is mandatory (binding rule 13 + rules/06-other.md O33-O37). Before the REVIEW step, write platform-native launch scripts so the novice can open the app with a double-click outside the Builder:
     - launch.command (macOS — chmod +x and add a #!/bin/bash shebang)
     - launch.bat (Windows)
     - launch.sh (Linux — chmod +x)
     Each script must install dependencies if missing, start the app's dev/start command, and print the URL. Verify at least one runs without error before declaring the build done; record the result as a "Quick-launch verified" line in .builder/review.md.

C) REVIEW (mandatory final step)
   - When all plan items are completed, do a coverage review against spec.md.
   - Include D-EEGG as a mandatory review item, even though it is not part of spec.md.
   - Re-read spec.md. For each in-scope item, Flow, data-model entity, and integration named in the spec, decide: present | partial | missing.
   - Write the result to .builder/review.md as a single markdown file in this exact shape:

     # Build review
     _Generated <ISO date>_

     ## Summary
     - Built: <n> / <total> spec items
     - Partial: <n>
     - Missing: <n>

     ## Items
     - [x] <spec item> — file:line — built
     - [~] <spec item> — file:line — partial: <one-line reason>
     - [ ] <spec item> — missing: <one-line reason>

   - Then add ONE final TodoWrite item titled "Review complete — see .builder/review.md" and mark it completed. End the turn.

Visual feedback (D-026):
- If a turn's prompt references a path under \`.builder/feedback/\` (typically a PNG named \`fb-<digits>-<digits>.png\`), the novice has paused the build, screenshotted the built app, drawn red boxes / arrows / freehand marks / text labels on it, and sent it to you. READ that file with your Read tool before planning your next action — Read returns image content, and the annotations show exactly what the novice wants changed. Treat the visual annotations as authoritative; they're more precise than the accompanying text alone. After acting on the feedback, run a fresh review pass and rewrite \`.builder/review.md\`.

Style rules:
- The novice is non-technical. Plain language, short sentences. Each TodoWrite activeForm should read like a status line a non-coder understands ("Setting up the database" not "Running drizzle-kit migrate").
- They are inside the Builder app — they don't have a separate terminal — so don't tell them to run \`cd\` or open VS Code. Anything that needs to happen happens via your tool calls.
- Don't ask "shall I proceed?" between plan items. The novice already clicked Start; they want it built.`;

export interface OrchestratorOptions {
  projectId: string;
  projectPath: string;
  prompt?: string | null;
  sessionId?: string | null;
  /** Model id from settings — falls back to claude-sonnet-4-5 when omitted. */
  model?: string;
}

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}

/**
 * Public event shape — same discriminated union the Rust orchestrator
 * used to emit, so the dashboard doesn't need to change. snake_case
 * `kind` matches Rust's serde tag.
 */
export type OrchestratorEvent =
  | { kind: "session"; id: string }
  | { kind: "assistant_delta"; text: string }
  | { kind: "tool_use"; tool: string; raw_input: string }
  | { kind: "todos_updated"; todos: TodoItem[] }
  | {
      kind: "done";
      cost_usd: number | null;
      input_tokens: number | null;
      output_tokens: number | null;
    }
  | { kind: "rate_limit"; message: string }
  | { kind: "error"; message: string };

const PERMISSION_POLL_INTERVAL_MS = 200;
const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;

// In-flight abort controllers keyed by streamId so orchestrator_stop can
// cancel a running query without killing the sidecar process. We also keep
// projectId because the webview historically did not know the generated
// streamId; project-scoped cancellation is the practical dashboard API.
interface InflightRun {
  controller: AbortController;
  projectId: string;
}

const inflight = new Map<string, InflightRun>();

/**
 * Start a build-phase orchestrator query. Streams events to `onEvent` and
 * resolves when the query ends. Cancellable via cancel(streamId).
 */
export async function runOrchestrator(
  streamId: string,
  opts: OrchestratorOptions,
  onEvent: (event: OrchestratorEvent) => void,
): Promise<void> {
  const ac = new AbortController();
  inflight.set(streamId, { controller: ac, projectId: opts.projectId });
  try {
    const sdkOptions: Options = {
      cwd: opts.projectPath,
      additionalDirectories: [opts.projectPath],
      // Settings-overridable; falls back to sonnet for the long build
      // session where cost compounds across hundreds of tool calls.
      model: opts.model ?? "claude-sonnet-4-5",
      permissionMode: "default",
      canUseTool: makeCanUseTool(opts.projectId, ac.signal),
      abortController: ac,
      systemPrompt: ORCHESTRATOR_KICKOFF_PROMPT,
    };
    if (opts.sessionId) {
      sdkOptions.resume = opts.sessionId;
    }
    const userPrompt = opts.prompt ?? "begin";
    const q = query({ prompt: userPrompt, options: sdkOptions });
    for await (const msg of q) {
      const events = translate(msg);
      for (const ev of events) onEvent(ev);
    }
  } catch (e) {
    if (ac.signal.aborted) {
      // User clicked Stop — silent exit, the dashboard already knows.
      return;
    }
    onEvent({
      kind: "error",
      message: e instanceof Error ? e.message : String(e),
    });
  } finally {
    inflight.delete(streamId);
  }
}

/** Cancel an in-flight orchestrator run by stream id. */
export function cancelOrchestrator(streamId: string): boolean {
  const run = inflight.get(streamId);
  if (!run) return false;
  run.controller.abort();
  return true;
}

/** Cancel every in-flight run for one project. Returns the number cancelled. */
export function cancelOrchestratorByProject(projectId: string): number {
  let cancelled = 0;
  for (const run of inflight.values()) {
    if (run.projectId !== projectId) continue;
    run.controller.abort();
    cancelled++;
  }
  return cancelled;
}

/** Cancel all in-flight runs. Used by the global tab-strip Stop button. */
export function cancelAllOrchestrators(): number {
  let cancelled = 0;
  for (const run of inflight.values()) {
    run.controller.abort();
    cancelled++;
  }
  return cancelled;
}

/**
 * canUseTool callback. Inserts a row into permission_requests, polls
 * until the dashboard's PermissionPromptBanner resolves it, returns the
 * decision to the SDK. Times out (defaulting to deny) after 5 minutes.
 *
 * Skips the prompt for tools that are always safe inside the project
 * folder — Read/Glob/Grep/TodoWrite — since prompting on every Read
 * would be unworkable. The dashboard only sees prompts for tools that
 * mutate or escape the sandbox (Write/Edit/Bash/WebFetch/etc.).
 */
function makeCanUseTool(projectId: string, signal: AbortSignal): CanUseTool {
  const ALWAYS_ALLOWED = new Set([
    "Read",
    "Glob",
    "Grep",
    "TodoWrite",
    "WebSearch",
    "BashOutput",
    "ExitPlanMode",
    "AskUserQuestion",
  ]);
  return async (toolName, input) => {
    if (ALWAYS_ALLOWED.has(toolName)) {
      return { behavior: "allow", updatedInput: input };
    }

    const req = appendPermissionRequest({
      projectId,
      toolName,
      inputSummary: JSON.stringify(input),
    });

    const deadline = Date.now() + PERMISSION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (signal.aborted) {
        return { behavior: "deny", message: "Cancelled by user (Stop)." };
      }
      await new Promise((r) => setTimeout(r, PERMISSION_POLL_INTERVAL_MS));
      const row = pollPermissionRequest({ id: req.id });
      if (!row) continue;
      if (row.status === "allowed") {
        return { behavior: "allow", updatedInput: input };
      }
      if (row.status === "denied" || row.status === "expired") {
        return {
          behavior: "deny",
          message: row.decisionMessage ?? "Denied by user.",
        };
      }
    }
    return {
      behavior: "deny",
      message: "Permission request timed out (5 min). Try again.",
    };
  };
}

/** Convert one SDKMessage into 0..N OrchestratorEvent items. */
function translate(msg: SDKMessage): OrchestratorEvent[] {
  switch (msg.type) {
    case "system": {
      // The system message carries session_init metadata when subtype is "init".
      const m = msg as { type: "system"; subtype?: string; session_id?: string };
      if (m.subtype === "init" && m.session_id) {
        return [{ kind: "session", id: m.session_id }];
      }
      return [];
    }
    case "assistant": {
      const out: OrchestratorEvent[] = [];
      // The SDK's BetaContentBlock union has many shapes (text, tool_use,
      // tool_result, image, compaction, etc.). We only care about text +
      // tool_use; treat everything else as opaque records and look up the
      // `type` discriminator manually.
      const m = msg as unknown as {
        type: "assistant";
        message: { content: Array<Record<string, unknown>> };
      };
      const content = Array.isArray(m.message?.content) ? m.message.content : [];
      let text = "";
      for (const block of content) {
        const blockType = (block as { type?: string }).type;
        if (blockType === "text" && typeof (block as { text?: unknown }).text === "string") {
          text += (block as { text: string }).text;
        } else if (blockType === "tool_use") {
          const tool = String((block as { name?: unknown }).name ?? "");
          if (!tool) continue;
          const raw_input = JSON.stringify((block as { input?: unknown }).input ?? {});
          if (tool === "TodoWrite") {
            const input = (block as { input?: { todos?: unknown[] } }).input;
            const todos = Array.isArray(input?.todos)
              ? (input.todos as TodoItem[])
              : [];
            if (todos.length > 0) out.push({ kind: "todos_updated", todos });
          }
          out.push({ kind: "tool_use", tool, raw_input });
        }
      }
      if (text) out.unshift({ kind: "assistant_delta", text });
      return out;
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
          kind: "done",
          cost_usd: typeof m.total_cost_usd === "number" ? m.total_cost_usd : null,
          input_tokens:
            typeof m.usage?.input_tokens === "number" ? m.usage.input_tokens : null,
          output_tokens:
            typeof m.usage?.output_tokens === "number" ? m.usage.output_tokens : null,
        },
      ];
    }
    default:
      // Many other message types (status, hook, partial, etc.) — silent.
      return [];
  }
}
