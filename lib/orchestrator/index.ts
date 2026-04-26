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
  /** Absolute path to the novice's project folder. The build subprocess
   *  runs with cwd set to this path; `~/...` is expanded by the Rust side. */
  projectPath: string;
  /** Optional override prompt. Defaults to the kickoff prompt that asks
   *  Claude to read CLAUDE.md and emit a `## Plan` section. */
  prompt?: string | null;
  /** Optional `claude` session id from a prior turn (used by D5/D6 resume). */
  sessionId?: string | null;
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
      projectPath: options.projectPath,
      prompt: options.prompt ?? null,
      sessionId: options.sessionId ?? null,
      onEvent: channel,
    }),
    fromInvokeError,
  );
}

/**
 * Kill the in-flight build subprocess (Flow H Stop, and the force-kill
 * half of Pause). No-op when no build is running.
 */
export function orchestratorStop(): ResultAsync<void, OrchestratorError> {
  return ResultAsync.fromPromise(invoke<void>("orchestrator_stop"), fromInvokeError);
}
