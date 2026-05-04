import { Channel, invoke } from "@tauri-apps/api/core";
import { ResultAsync } from "neverthrow";

// Mirror the discriminated union in src-tauri/src/chat.rs ChatChunk.
// The Rust side serialises with `#[serde(tag = "kind", rename_all = "snake_case")]`,
// so the wire format is `{ kind: "session" | "assistant_delta" | ... , ... }`.
export interface QueuedQuestion {
  id: string;
  text: string;
  options: string[];
  allow_freeform: boolean;
}

export type ChatChunk =
  | { kind: "session"; id: string }
  | { kind: "assistant_delta"; text: string }
  | { kind: "questions_queued"; items: QueuedQuestion[] }
  | {
      kind: "done";
      cost_usd: number | null;
      input_tokens: number | null;
      output_tokens: number | null;
    }
  | { kind: "rate_limit"; message: string }
  | { kind: "error"; message: string };

export type ChatError = { kind: "Transport"; message: string };

export interface ChatSendOptions {
  prompt: string;
  sessionId?: string | null;
  /** When both projectId and projectPath are set, the chat turn is wired to
   * the record_answer MCP server (per ADR-0004 + build-order B2). Without
   * them, the chat falls back to plain (no-tools) Claude. */
  projectId?: string | null;
  projectPath?: string | null;
  /** Optional model id from settings; sidecar falls back to default. */
  model?: string;
  onChunk: (chunk: ChatChunk) => void;
}

const fromInvokeError = (e: unknown): ChatError => ({
  kind: "Transport",
  message: e instanceof Error ? e.message : String(e),
});

/**
 * Send a chat turn through the Claude Agent SDK (per ADR-0005).
 *
 * The Tauri command is a thin pass-through: chat_send → sidecar's
 * chat.start → query() in sidecar/src/chat-driver.ts. record_answer +
 * queue_questions are SDK MCP tools defined in-process by the driver
 * (no external subprocess, no per-turn config file, no permission UI).
 *
 * `sessionId` is the session id captured from the first turn's `Session`
 * chunk. Pass `null` for the first turn (driver uses Opus + injects the
 * interview system prompt); pass the captured id on subsequent turns
 * (driver uses Sonnet + resumes the same session).
 *
 * `projectId` + `projectPath` are REQUIRED — the driver needs them to
 * scope record_answer inserts to the right project and to set cwd.
 */
export function chatSend(options: ChatSendOptions): ResultAsync<void, ChatError> {
  const channel = new Channel<ChatChunk>();
  channel.onmessage = options.onChunk;
  return ResultAsync.fromPromise(
    invoke<void>("chat_send", {
      prompt: options.prompt,
      sessionId: options.sessionId ?? null,
      projectId: options.projectId ?? null,
      projectPath: options.projectPath ?? null,
      model: options.model ?? null,
      onChunk: channel,
    }),
    fromInvokeError,
  );
}
