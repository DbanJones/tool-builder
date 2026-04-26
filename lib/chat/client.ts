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
  onChunk: (chunk: ChatChunk) => void;
}

const fromInvokeError = (e: unknown): ChatError => ({
  kind: "Transport",
  message: e instanceof Error ? e.message : String(e),
});

/**
 * Send a chat turn through the `claude` CLI subprocess (per ADR-0002).
 *
 * `sessionId` is the session id captured from the first turn's `Session`
 * chunk. Pass `null` for the first turn (Builder will append the interview
 * system prompt); pass the captured id on subsequent turns to maintain
 * conversation context via `claude --resume`.
 *
 * `projectId` + `projectPath` activate the `record_answer` MCP tool by
 * generating a per-project mcp-config.json and passing it via `--mcp-config`.
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
      onChunk: channel,
    }),
    fromInvokeError,
  );
}
