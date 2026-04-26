import { describe, it, expect, vi, beforeEach } from "vitest";

import { invoke, Channel } from "@tauri-apps/api/core";
import { chatSend, type ChatChunk } from "./client";

vi.mock("@tauri-apps/api/core", () => {
  // Minimal Channel stand-in: tests pre-set onmessage, then trigger emit() to
  // simulate Rust pushing chunks through the channel.
  class FakeChannel<T> {
    onmessage: ((data: T) => void) | undefined;
    emit(data: T): void {
      this.onmessage?.(data);
    }
  }
  return {
    invoke: vi.fn(),
    Channel: FakeChannel,
  };
});

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  mockInvoke.mockReset();
});

describe("chatSend", () => {
  it("forwards prompt + sessionId + channel into invoke('chat_send')", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    const onChunk = vi.fn();
    const r = await chatSend({ prompt: "hi", sessionId: "s-1", onChunk });
    expect(r.isOk()).toBe(true);

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const call = mockInvoke.mock.calls[0];
    expect(call?.[0]).toBe("chat_send");
    const args = call?.[1] as { prompt: string; sessionId: string | null; onChunk: unknown };
    expect(args.prompt).toBe("hi");
    expect(args.sessionId).toBe("s-1");
    expect(args.onChunk).toBeInstanceOf(Channel);
  });

  it("defaults sessionId, projectId, projectPath to null when not provided", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    await chatSend({ prompt: "hi", onChunk: vi.fn() });
    const args = mockInvoke.mock.calls[0]?.[1] as {
      sessionId: string | null;
      projectId: string | null;
      projectPath: string | null;
    };
    expect(args.sessionId).toBeNull();
    expect(args.projectId).toBeNull();
    expect(args.projectPath).toBeNull();
  });

  it("forwards projectId + projectPath when supplied (used by Rust to wire MCP)", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    await chatSend({
      prompt: "hi",
      projectId: "01ABC",
      projectPath: "/tmp/preppilot",
      onChunk: vi.fn(),
    });
    const args = mockInvoke.mock.calls[0]?.[1] as {
      projectId: string | null;
      projectPath: string | null;
    };
    expect(args.projectId).toBe("01ABC");
    expect(args.projectPath).toBe("/tmp/preppilot");
  });

  it("delivers chunks pushed on the channel to the user-provided callback", async () => {
    const received: ChatChunk[] = [];
    const onChunk = (c: ChatChunk): void => {
      received.push(c);
    };

    mockInvoke.mockImplementationOnce(async (_cmd, args) => {
      const channel = (args as { onChunk: { emit: (c: ChatChunk) => void } }).onChunk;
      channel.emit({ kind: "session", id: "s-99" });
      channel.emit({ kind: "assistant_delta", text: "Hello" });
      channel.emit({ kind: "assistant_delta", text: " world" });
      channel.emit({
        kind: "done",
        cost_usd: 0.001,
        input_tokens: 10,
        output_tokens: 2,
      });
    });

    const r = await chatSend({ prompt: "hi", onChunk });
    expect(r.isOk()).toBe(true);
    expect(received).toHaveLength(4);
    expect(received[0]).toEqual({ kind: "session", id: "s-99" });
    expect(received[3]).toEqual({
      kind: "done",
      cost_usd: 0.001,
      input_tokens: 10,
      output_tokens: 2,
    });
  });

  it("returns Transport error when invoke rejects", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("ipc closed"));
    const r = await chatSend({ prompt: "hi", onChunk: vi.fn() });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error.kind).toBe("Transport");
      expect(r.error.message).toBe("ipc closed");
    }
  });

  it("delivers rate_limit chunk to callback when subprocess hits a rate limit", async () => {
    const received: ChatChunk[] = [];
    mockInvoke.mockImplementationOnce(async (_cmd, args) => {
      const channel = (args as { onChunk: { emit: (c: ChatChunk) => void } }).onChunk;
      channel.emit({
        kind: "rate_limit",
        message: "Claude is rate-limited. Try again in a few minutes.",
      });
    });

    await chatSend({
      prompt: "hi",
      onChunk: (c) => {
        received.push(c);
      },
    });
    expect(received[0]?.kind).toBe("rate_limit");
  });
});
