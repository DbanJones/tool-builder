import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { logAuditEvent, _resetAuditOnceCache } from "./index";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(undefined);
  _resetAuditOnceCache();
});

describe("logAuditEvent", () => {
  it("invokes audit_log_event with the event type and JSON-serialised payload", async () => {
    await logAuditEvent("app_first_run", { foo: "bar" });
    expect(mockInvoke).toHaveBeenCalledWith("audit_log_event", {
      eventType: "app_first_run",
      payload: JSON.stringify({ foo: "bar" }),
    });
  });

  it("uses an empty object payload when none provided", async () => {
    await logAuditEvent("app_first_run");
    expect(mockInvoke).toHaveBeenCalledWith("audit_log_event", {
      eventType: "app_first_run",
      payload: "{}",
    });
  });

  it("with once: true, only logs the first occurrence of an event type", async () => {
    await logAuditEvent("app_first_run", {}, { once: true });
    await logAuditEvent("app_first_run", {}, { once: true });
    await logAuditEvent("app_first_run", {}, { once: true });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("once: true on one event does not block a different event type", async () => {
    await logAuditEvent("app_first_run", {}, { once: true });
    await logAuditEvent("project_created", {}, { once: true });
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });

  it("swallows errors so audit failures do not affect the caller", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("ipc died"));
    await expect(logAuditEvent("app_first_run")).resolves.toBeUndefined();
  });
});
