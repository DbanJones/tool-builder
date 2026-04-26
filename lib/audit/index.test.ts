import { describe, it, expect, vi, beforeEach } from "vitest";
import { okAsync, errAsync } from "neverthrow";

import { logAuditEvent, _resetAuditOnceCache } from "./index";
import { sidecarCall } from "@/lib/sidecar/client";

vi.mock("@/lib/sidecar/client", () => ({
  sidecarCall: vi.fn(),
}));

const mockSidecarCall = vi.mocked(sidecarCall);

beforeEach(() => {
  mockSidecarCall.mockReset();
  mockSidecarCall.mockReturnValue(okAsync({ id: "01TEST" }));
  _resetAuditOnceCache();
});

describe("logAuditEvent", () => {
  it("calls sidecar method audit.logEvent with the event type and JSON-serialised payload", async () => {
    await logAuditEvent("app_first_run", { foo: "bar" });
    expect(mockSidecarCall).toHaveBeenCalledWith("audit.logEvent", {
      eventType: "app_first_run",
      payload: JSON.stringify({ foo: "bar" }),
    });
  });

  it("uses an empty object payload when none provided", async () => {
    await logAuditEvent("app_first_run");
    expect(mockSidecarCall).toHaveBeenCalledWith("audit.logEvent", {
      eventType: "app_first_run",
      payload: "{}",
    });
  });

  it("with once: true, only logs the first occurrence of an event type", async () => {
    await logAuditEvent("app_first_run", {}, { once: true });
    await logAuditEvent("app_first_run", {}, { once: true });
    await logAuditEvent("app_first_run", {}, { once: true });
    expect(mockSidecarCall).toHaveBeenCalledTimes(1);
  });

  it("once: true on one event does not block a different event type", async () => {
    await logAuditEvent("app_first_run", {}, { once: true });
    await logAuditEvent("project_created", {}, { once: true });
    expect(mockSidecarCall).toHaveBeenCalledTimes(2);
  });

  it("swallows sidecar errors so audit failures do not affect the caller", async () => {
    mockSidecarCall.mockReturnValueOnce(
      errAsync({ kind: "Sidecar", code: "HANDLER_ERROR", message: "db gone" }),
    );
    await expect(logAuditEvent("app_first_run")).resolves.toBeUndefined();
  });

  it("swallows transport errors too", async () => {
    mockSidecarCall.mockReturnValueOnce(
      errAsync({ kind: "Transport", message: "ipc closed" }),
    );
    await expect(logAuditEvent("app_first_run")).resolves.toBeUndefined();
  });
});
