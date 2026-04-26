import { beforeEach, describe, expect, it, vi } from "vitest";

import { invoke } from "@tauri-apps/api/core";
import { errAsync, okAsync } from "neverthrow";

import { sidecarCall } from "@/lib/sidecar/client";

import {
  appendDrift,
  listOpenDrifts,
  resolveDrift,
  type DriftEvent,
} from "./index";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/sidecar/client", () => ({
  sidecarCall: vi.fn(),
}));

const mockInvoke = vi.mocked(invoke);
const mockSidecar = vi.mocked(sidecarCall);

beforeEach(() => {
  mockInvoke.mockReset();
  mockSidecar.mockReset();
});

const fixtureEvent = (overrides: Partial<DriftEvent> = {}): DriftEvent => ({
  id: "01ABC",
  projectId: "01PROJ",
  phase: "phase-1",
  kind: "implementation",
  description: "Auth uses cookies; spec says JWT",
  resolution: null,
  commitHash: null,
  occurredAt: 1,
  resolvedAt: null,
  ...overrides,
});

describe("listOpenDrifts", () => {
  it("forwards the projectId to drift.listOpen and returns the rows", async () => {
    mockSidecar.mockReturnValueOnce(okAsync([fixtureEvent()]));
    const r = await listOpenDrifts("01PROJ");
    expect(r.isOk()).toBe(true);
    expect(mockSidecar).toHaveBeenCalledWith("drift.listOpen", { projectId: "01PROJ" });
  });

  it("translates a sidecar error into a DriftError", async () => {
    mockSidecar.mockReturnValueOnce(errAsync({ kind: "Transport", message: "ipc closed" }));
    const r = await listOpenDrifts("01PROJ");
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.kind).toBe("Sidecar");
  });
});

describe("appendDrift", () => {
  it("forwards the params to drift.append", async () => {
    mockSidecar.mockReturnValueOnce(okAsync(fixtureEvent()));
    await appendDrift({
      projectId: "01PROJ",
      phase: "phase-1",
      kind: "scope",
      description: "Added analytics route",
    });
    expect(mockSidecar).toHaveBeenCalledWith("drift.append", {
      projectId: "01PROJ",
      phase: "phase-1",
      kind: "scope",
      description: "Added analytics route",
    });
  });
});

describe("resolveDrift", () => {
  it("calls drift.resolve THEN append_drift_log_line in order", async () => {
    const callOrder: string[] = [];
    mockSidecar.mockImplementationOnce(((method: string) => {
      callOrder.push(`sidecar:${method}`);
      return okAsync(fixtureEvent({ resolution: "accept" }));
    }) as typeof sidecarCall);
    mockInvoke.mockImplementationOnce(async (cmd) => {
      callOrder.push(`invoke:${cmd}`);
      return "/tmp/drift-log.md";
    });

    const r = await resolveDrift({
      event: fixtureEvent(),
      resolution: "accept",
      projectPath: "/tmp/proj",
    });
    expect(r.isOk()).toBe(true);
    expect(callOrder).toEqual(["sidecar:drift.resolve", "invoke:append_drift_log_line"]);
  });

  it("forwards id + resolution + commitHash to drift.resolve", async () => {
    mockSidecar.mockReturnValueOnce(okAsync(fixtureEvent({ resolution: "revert" })));
    mockInvoke.mockResolvedValueOnce("/tmp/drift-log.md");

    await resolveDrift({
      event: fixtureEvent(),
      resolution: "revert",
      commitHash: "abc1234",
      projectPath: "/tmp/proj",
    });

    expect(mockSidecar).toHaveBeenCalledWith("drift.resolve", {
      id: "01ABC",
      resolution: "revert",
      commitHash: "abc1234",
    });
  });

  it("forwards the projectPath + drift fields to append_drift_log_line", async () => {
    mockSidecar.mockReturnValueOnce(okAsync(fixtureEvent({ resolution: "amend_spec" })));
    mockInvoke.mockResolvedValueOnce("/tmp/drift-log.md");

    await resolveDrift({
      event: fixtureEvent(),
      resolution: "amend_spec",
      commitHash: "def5678",
      projectPath: "/tmp/proj",
    });

    const args = mockInvoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(args["projectPath"]).toBe("/tmp/proj");
    expect(args["driftId"]).toBe("01ABC");
    expect(args["resolution"]).toBe("amend_spec");
    expect(args["commitHash"]).toBe("def5678");
  });

  it("does NOT call append_drift_log_line when drift.resolve fails", async () => {
    mockSidecar.mockReturnValueOnce(errAsync({ kind: "Transport", message: "ipc closed" }));
    const r = await resolveDrift({
      event: fixtureEvent(),
      resolution: "accept",
      projectPath: "/tmp/proj",
    });
    expect(r.isErr()).toBe(true);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns a Filesystem error when the log-file write fails (DB update still landed)", async () => {
    mockSidecar.mockReturnValueOnce(okAsync(fixtureEvent({ resolution: "accept" })));
    mockInvoke.mockRejectedValueOnce(new Error("permission denied"));
    const r = await resolveDrift({
      event: fixtureEvent(),
      resolution: "accept",
      projectPath: "/tmp/proj",
    });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error.kind).toBe("Filesystem");
      expect(r.error.message).toBe("permission denied");
    }
  });

  it("passes commitHash as null when not provided", async () => {
    mockSidecar.mockReturnValueOnce(okAsync(fixtureEvent({ resolution: "accept" })));
    mockInvoke.mockResolvedValueOnce("/tmp/drift-log.md");

    await resolveDrift({
      event: fixtureEvent(),
      resolution: "accept",
      projectPath: "/tmp/proj",
    });

    const args = mockInvoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(args["commitHash"]).toBeNull();
  });
});
