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

const ORCHESTRATOR_KICKOFF_PROMPT = `You are the Builder's build-phase agent. The novice has clicked 'Start build' inside the Builder desktop app and is watching you work via a live dashboard. They can interrupt you at any time via the chat input on the build page.

Where to find context (read these in order on the first turn):
1. CLAUDE.md at the project root — binding rules for THIS project. Read it first.
2. spec.md at the project root — the SOURCE OF TRUTH for what to build. The Builder rebuilds it from the novice's interview answers EVERY time you are spawned. spec.md is the answer — do NOT go looking in .builder/ for it. .builder/ is internal orchestrator state and you can safely ignore it.
3. If spec.md is still the one-line placeholder ('Empty until the interview begins.'), the novice hasn't done the interview yet — ask them in ONE short sentence what they want to build, then use TodoWrite once they answer.

You have full read/write access to this target project folder (the current working directory). The Builder pre-flights writeability and the Agent SDK's canUseTool callback routes any sensitive tool calls through a dashboard banner the novice can Allow or Deny.

For the first turn (when spec.md HAS real content):
- Use TodoWrite to lay out 3-7 concrete next steps that move toward shipping spec.md's Phase 1. Each step at most one hour of work.
- Then STOP and wait for the novice to react before modifying any files.

Defaults:
- Build INSIDE this project folder. Don't create sibling folders or touch the user's home directory outside this folder.
- The novice is non-technical. Use plain language; bullet points and short sentences. Don't write multi-paragraph essays.
- Maintain your TodoWrite plan as the build progresses (mark items completed/in_progress) so the dashboard's plan panel stays accurate.
- They are inside the Builder app — they don't have a separate terminal — so don't tell them to run \`cd\` or open VS Code. Tell them what to do INSIDE the Builder.`;

export interface OrchestratorOptions {
  projectId: string;
  projectPath: string;
  prompt?: string | null;
  sessionId?: string | null;
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

// In-flight abort controllers keyed by streamId so orchestrator_stop
// can cancel a running query without killing the sidecar process.
const inflight = new Map<string, AbortController>();

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
  inflight.set(streamId, ac);
  try {
    const sdkOptions: Options = {
      cwd: opts.projectPath,
      additionalDirectories: [opts.projectPath],
      model: "claude-sonnet-4-5",
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
  const ac = inflight.get(streamId);
  if (!ac) return false;
  ac.abort();
  return true;
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
