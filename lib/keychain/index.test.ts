import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { keychainGet, keychainSet, keychainDelete } from "./index";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  mockInvoke.mockReset();
});

describe("keychainGet", () => {
  it("returns ok(secret) when invoke resolves with a string", async () => {
    mockInvoke.mockResolvedValueOnce("hunter2");
    const r = await keychainGet("vercel", "default");
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toBe("hunter2");
  });

  it("returns ok(null) when invoke resolves with null (no entry)", async () => {
    mockInvoke.mockResolvedValueOnce(null);
    const r = await keychainGet("vercel", "default");
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toBeNull();
  });

  it("namespaces the service with the Builder prefix", async () => {
    mockInvoke.mockResolvedValueOnce(null);
    await keychainGet("vercel", "default");
    expect(mockInvoke).toHaveBeenCalledWith("keychain_get", {
      service: "com.airtec.builder.vercel",
      account: "default",
    });
  });

  it("returns err(Backend) when invoke rejects", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("boom"));
    const r = await keychainGet("vercel", "default");
    expect(r.isErr()).toBe(true);
    const e = r._unsafeUnwrapErr();
    expect(e.kind).toBe("Backend");
    if (e.kind === "Backend") {
      expect(e.message).toBe("boom");
      expect(e.service).toBe("com.airtec.builder.vercel");
      expect(e.account).toBe("default");
    }
  });
});

describe("keychainSet", () => {
  it("invokes keychain_set with the namespaced service, account, and secret", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    const r = await keychainSet("vercel", "default", "hunter2");
    expect(r.isOk()).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith("keychain_set", {
      service: "com.airtec.builder.vercel",
      account: "default",
      secret: "hunter2",
    });
  });

  it("returns err(Backend) when invoke rejects", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("denied"));
    const r = await keychainSet("vercel", "default", "hunter2");
    expect(r.isErr()).toBe(true);
  });
});

describe("keychainDelete", () => {
  it("invokes keychain_delete with namespaced service and account", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    const r = await keychainDelete("vercel", "default");
    expect(r.isOk()).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith("keychain_delete", {
      service: "com.airtec.builder.vercel",
      account: "default",
    });
  });

  it("returns ok when the entry was already absent (idempotent)", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    const r = await keychainDelete("vercel", "missing");
    expect(r.isOk()).toBe(true);
  });
});
