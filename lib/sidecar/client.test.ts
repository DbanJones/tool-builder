import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { ping, sidecarCall } from "./client";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  mockInvoke.mockReset();
});

describe("sidecarCall", () => {
  it("returns ok(result) when the sidecar replies ok: true", async () => {
    mockInvoke.mockResolvedValueOnce({
      id: "1",
      ok: true,
      result: { hello: "world" },
    });
    const r = await sidecarCall<{ hello: string }>("anything");
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toEqual({ hello: "world" });
  });

  it("returns err(Sidecar) when the sidecar replies ok: false", async () => {
    mockInvoke.mockResolvedValueOnce({
      id: "1",
      ok: false,
      error: { code: "UNKNOWN_METHOD", message: "no handler for method 'nope'" },
    });
    const r = await sidecarCall<unknown>("nope");
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error.kind).toBe("Sidecar");
      if (r.error.kind === "Sidecar") {
        expect(r.error.code).toBe("UNKNOWN_METHOD");
        expect(r.error.message).toBe("no handler for method 'nope'");
      }
    }
  });

  it("returns err(Transport) when invoke rejects", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("ipc closed"));
    const r = await sidecarCall<unknown>("ping");
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error.kind).toBe("Transport");
      if (r.error.kind === "Transport") {
        expect(r.error.message).toBe("ipc closed");
      }
    }
  });

  it("forwards method and params through to invoke as sidecar_rpc args", async () => {
    mockInvoke.mockResolvedValueOnce({ id: "1", ok: true, result: null });
    await sidecarCall("foo", { a: 1, b: "two" });
    expect(mockInvoke).toHaveBeenCalledWith("sidecar_rpc", {
      method: "foo",
      params: { a: 1, b: "two" },
    });
  });

  it("defaults params to an empty object when not provided", async () => {
    mockInvoke.mockResolvedValueOnce({ id: "1", ok: true, result: null });
    await sidecarCall("foo");
    expect(mockInvoke).toHaveBeenCalledWith("sidecar_rpc", {
      method: "foo",
      params: {},
    });
  });
});

describe("ping convenience wrapper", () => {
  it("calls method ping and unpacks the typed result", async () => {
    mockInvoke.mockResolvedValueOnce({
      id: "1",
      ok: true,
      result: { pong: true, version: "0.1.0", at: "2026-04-25T22:00:00Z" },
    });
    const r = await ping();
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap().pong).toBe(true);
    expect(r._unsafeUnwrap().version).toBe("0.1.0");
  });
});
