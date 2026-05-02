import { Channel, invoke } from "@tauri-apps/api/core";
import { ResultAsync } from "neverthrow";

// Mirror the discriminated union in src-tauri/src/orchestrator.rs.
// Wire format: `{ kind: "session" | "assistant_delta" | "tool_use" | "done"
// | "rate_limit" | "error", ... }` (snake_case via serde tag).
//
// `tool_use.raw_input` is a JSON-encoded string (not a parsed object) so the
// D2 translator can preserve key order and the dashboard can show it verbatim
// without a re-encode hop.
export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}

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

export type OrchestratorError = { kind: "Transport"; message: string };

export interface OrchestratorStartOptions {
  /** Project ULID — needed by the orchestrator's MCP server so permission
   *  requests are recorded against the right project. */
  projectId: string;
  /** Absolute path to the novice's project folder. The build subprocess
   *  runs with cwd set to this path; `~/...` is expanded by the Rust side. */
  projectPath: string;
  /** Optional override prompt. Defaults to the kickoff prompt that asks
   *  Claude to read CLAUDE.md and emit a `## Plan` section. */
  prompt?: string | null;
  /** Optional `claude` session id from a prior turn (used by D5/D6 resume). */
  sessionId?: string | null;
  /** Optional model id from settings; sidecar falls back to default. */
  model?: string;
  onEvent: (event: OrchestratorEvent) => void;
}

const fromInvokeError = (e: unknown): OrchestratorError => ({
  kind: "Transport",
  message: e instanceof Error ? e.message : String(e),
});

/**
 * Start a build subprocess inside the novice's project folder via the
 * `claude` CLI (per ADR-0002). Streams events to `onEvent`; the returned
 * promise resolves when the subprocess exits.
 *
 * Pass `sessionId` to resume a previous turn (Flow H: pause/resume).
 */
export function orchestratorStart(
  options: OrchestratorStartOptions,
): ResultAsync<void, OrchestratorError> {
  const channel = new Channel<OrchestratorEvent>();
  channel.onmessage = options.onEvent;
  return ResultAsync.fromPromise(
    invoke<void>("orchestrator_start", {
      projectId: options.projectId,
      projectPath: options.projectPath,
      prompt: options.prompt ?? null,
      sessionId: options.sessionId ?? null,
      model: options.model ?? null,
      onEvent: channel,
    }),
    fromInvokeError,
  );
}

/**
 * Cancel the in-flight build query (Flow H Stop). No-op when no build is
 * running. Per ADR-0005 the sidecar's orch.stop aborts the SDK's
 * AbortController, which terminates the query() generator and lets
 * orchestrator_start return.
 *
 * `streamId` is currently optional — without it the call is a no-op
 * (the webview is expected to remember the streamId from start; the
 * dashboard tracks it for D6 Stop). When omitted, the call resolves
 * silently rather than guessing which build to kill.
 */
export function orchestratorStop(
  options:
    | string
    | {
        streamId?: string | null;
        projectId?: string | null;
      } = {},
): ResultAsync<void, OrchestratorError> {
  const normalized = typeof options === "string" ? { streamId: options } : options;
  return ResultAsync.fromPromise(
    invoke<void>("orchestrator_stop", {
      streamId: normalized.streamId ?? null,
      projectId: normalized.projectId ?? null,
    }),
    fromInvokeError,
  );
}
