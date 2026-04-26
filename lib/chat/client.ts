import { Channel, invoke } from "@tauri-apps/api/core";
import { ResultAsync } from "neverthrow";

// Mirror the discriminated union in src-tauri/src/chat.rs ChatChunk.
// The Rust side serialises with `#[serde(tag = "kind", rename_all = "snake_case")]`,
// so the wire format is `{ kind: "session" | "assistant_delta" | ... , ... }`.
export type ChatChunk =
  | { kind: "session"; id: string }
  | { kind: "assistant_delta"; text: string }
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
 * Resolves once the subprocess has exited and all chunks have been delivered
 * (or rejects if the IPC transport itself fails). The terminal `done`,
 * `rate_limit`, or `error` chunk is delivered through `onChunk` before the
 * promise resolves.
 */
export function chatSend(options: ChatSendOptions): ResultAsync<void, ChatError> {
  const channel = new Channel<ChatChunk>();
  channel.onmessage = options.onChunk;
  return ResultAsync.fromPromise(
    invoke<void>("chat_send", {
      prompt: options.prompt,
      sessionId: options.sessionId ?? null,
      onChunk: channel,
    }),
    fromInvokeError,
  );
}
