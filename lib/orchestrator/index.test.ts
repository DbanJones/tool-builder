import { describe, it, expect, vi, beforeEach } from "vitest";

import { invoke, Channel } from "@tauri-apps/api/core";
import { orchestratorStart, orchestratorStop, type OrchestratorEvent } from "./index";

vi.mock("@tauri-apps/api/core", () => {
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

describe("orchestratorStart", () => {
  it("forwards projectPath + sessionId + prompt + channel to invoke('orchestrator_start')", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    const onEvent = vi.fn();
    const r = await orchestratorStart({
      projectId: "01PROJ", projectPath: "/tmp/preppilot",
      sessionId: "build-1",
      prompt: "custom kickoff",
      onEvent,
    });
    expect(r.isOk()).toBe(true);

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const call = mockInvoke.mock.calls[0];
    expect(call?.[0]).toBe("orchestrator_start");
    const args = call?.[1] as {
      projectPath: string;
      sessionId: string | null;
      prompt: string | null;
      onEvent: unknown;
    };
    expect(args.projectPath).toBe("/tmp/preppilot");
    expect(args.sessionId).toBe("build-1");
    expect(args.prompt).toBe("custom kickoff");
    expect(args.onEvent).toBeInstanceOf(Channel);
  });

  it("defaults sessionId and prompt to null when not provided", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    await orchestratorStart({ projectId: "01PROJ", projectPath: "/tmp/x", onEvent: vi.fn() });
    const args = mockInvoke.mock.calls[0]?.[1] as {
      sessionId: string | null;
      prompt: string | null;
    };
    expect(args.sessionId).toBeNull();
    expect(args.prompt).toBeNull();
  });

  it("delivers events pushed on the channel to the user-provided callback in order", async () => {
    const received: OrchestratorEvent[] = [];
    mockInvoke.mockImplementationOnce(async (_cmd, args) => {
      const channel = (args as { onEvent: { emit: (e: OrchestratorEvent) => void } }).onEvent;
      channel.emit({ kind: "session", id: "build-99" });
      channel.emit({ kind: "assistant_delta", text: "## Plan" });
      channel.emit({
        kind: "tool_use",
        tool: "Read",
        raw_input: '{"file_path":"CLAUDE.md"}',
      });
      channel.emit({
        kind: "done",
        cost_usd: 0.05,
        input_tokens: 1500,
        output_tokens: 250,
      });
    });

    const r = await orchestratorStart({
      projectId: "01PROJ", projectPath: "/tmp/x",
      onEvent: (e) => {
        received.push(e);
      },
    });
    expect(r.isOk()).toBe(true);
    expect(received).toHaveLength(4);
    expect(received[0]).toEqual({ kind: "session", id: "build-99" });
    expect(received[1]).toEqual({ kind: "assistant_delta", text: "## Plan" });
    expect(received[2]).toEqual({
      kind: "tool_use",
      tool: "Read",
      raw_input: '{"file_path":"CLAUDE.md"}',
    });
  });

  it("returns Transport error when invoke rejects (e.g. project folder missing)", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("project folder not found"));
    const r = await orchestratorStart({ projectId: "01PROJ", projectPath: "/nope", onEvent: vi.fn() });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error.kind).toBe("Transport");
      expect(r.error.message).toBe("project folder not found");
    }
  });

  it("delivers rate_limit event to callback when subprocess hits a rate limit", async () => {
    const received: OrchestratorEvent[] = [];
    mockInvoke.mockImplementationOnce(async (_cmd, args) => {
      const channel = (args as { onEvent: { emit: (e: OrchestratorEvent) => void } }).onEvent;
      channel.emit({
        kind: "rate_limit",
        message: "Claude is rate-limited. Try again in a few minutes.",
      });
    });

    await orchestratorStart({
      projectId: "01PROJ", projectPath: "/tmp/x",
      onEvent: (e) => {
        received.push(e);
      },
    });
    expect(received[0]?.kind).toBe("rate_limit");
  });

  describe("orchestratorStop", () => {
    it("invokes orchestrator_stop with the given streamId", async () => {
      mockInvoke.mockResolvedValueOnce(undefined);
      const r = await orchestratorStop("stream-abc");
      expect(r.isOk()).toBe(true);
      expect(mockInvoke).toHaveBeenCalledWith("orchestrator_stop", {
        streamId: "stream-abc",
        projectId: null,
      });
    });

    it("invokes orchestrator_stop with a projectId when provided", async () => {
      mockInvoke.mockResolvedValueOnce(undefined);
      const r = await orchestratorStop({ projectId: "01PROJ" });
      expect(r.isOk()).toBe(true);
      expect(mockInvoke).toHaveBeenCalledWith("orchestrator_stop", {
        streamId: null,
        projectId: "01PROJ",
      });
    });

    it("invokes orchestrator_stop with null streamId when omitted", async () => {
      mockInvoke.mockResolvedValueOnce(undefined);
      const r = await orchestratorStop();
      expect(r.isOk()).toBe(true);
      expect(mockInvoke).toHaveBeenCalledWith("orchestrator_stop", {
        streamId: null,
        projectId: null,
      });
    });

    it("returns Transport error when the kill fails", async () => {
      mockInvoke.mockRejectedValueOnce(new Error("sidecar lock"));
      const r = await orchestratorStop("x");
      expect(r.isErr()).toBe(true);
      if (r.isErr()) expect(r.error.kind).toBe("Transport");
    });
  });

  it("forwards error events from a non-zero subprocess exit", async () => {
    const received: OrchestratorEvent[] = [];
    mockInvoke.mockImplementationOnce(async (_cmd, args) => {
      const channel = (args as { onEvent: { emit: (e: OrchestratorEvent) => void } }).onEvent;
      channel.emit({ kind: "error", message: "claude exited with status 1" });
    });
    await orchestratorStart({
      projectId: "01PROJ", projectPath: "/tmp/x",
      onEvent: (e) => {
        received.push(e);
      },
    });
    expect(received[0]?.kind).toBe("error");
  });
});
