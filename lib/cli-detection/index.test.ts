import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { detectCli } from "./index";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  mockInvoke.mockReset();
});

describe("detectCli", () => {
  it("returns 'missing' when cli_is_installed resolves false", async () => {
    mockInvoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === "cli_is_installed") return false;
      throw new Error(`unexpected command: ${String(cmd)}`);
    });
    const r = await detectCli();
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toBe("missing");
  });

  it("does not call cli_is_authenticated when not installed", async () => {
    mockInvoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === "cli_is_installed") return false;
      throw new Error(`unexpected command: ${String(cmd)}`);
    });
    await detectCli();
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("cli_is_installed");
  });

  it("returns 'unauthenticated' when installed but not authenticated", async () => {
    mockInvoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === "cli_is_installed") return true;
      if (cmd === "cli_is_authenticated") return false;
      throw new Error(`unexpected command: ${String(cmd)}`);
    });
    const r = await detectCli();
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toBe("unauthenticated");
  });

  it("returns 'ready' when installed and authenticated", async () => {
    mockInvoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === "cli_is_installed") return true;
      if (cmd === "cli_is_authenticated") return true;
      throw new Error(`unexpected command: ${String(cmd)}`);
    });
    const r = await detectCli();
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toBe("ready");
  });

  it("returns err(Backend) when cli_is_installed throws", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("ipc broken"));
    const r = await detectCli();
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error.kind).toBe("Backend");
      expect(r.error.message).toBe("ipc broken");
    }
  });

  it("returns err(Backend) when cli_is_authenticated throws", async () => {
    mockInvoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === "cli_is_installed") return true;
      throw new Error("auth probe broken");
    });
    const r = await detectCli();
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error.message).toBe("auth probe broken");
    }
  });

  it("wraps non-Error throw values as Backend.message", async () => {
    mockInvoke.mockRejectedValueOnce("string error");
    const r = await detectCli();
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error.message).toBe("string error");
    }
  });
});
