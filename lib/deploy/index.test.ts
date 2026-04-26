import { beforeEach, describe, expect, it, vi } from "vitest";

import { invoke } from "@tauri-apps/api/core";
import { errAsync, okAsync } from "neverthrow";

import { keychainGet, keychainSet } from "@/lib/keychain";
import { sidecarCall } from "@/lib/sidecar/client";

import { deployToVercel, getVercelToken, isVercelInstalled, setVercelToken } from "./index";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/keychain", () => ({
  keychainGet: vi.fn(),
  keychainSet: vi.fn(),
}));
vi.mock("@/lib/sidecar/client", () => ({
  sidecarCall: vi.fn(),
}));

const mockInvoke = vi.mocked(invoke);
const mockKeychainGet = vi.mocked(keychainGet);
const mockKeychainSet = vi.mocked(keychainSet);
const mockSidecar = vi.mocked(sidecarCall);

beforeEach(() => {
  mockInvoke.mockReset();
  mockKeychainGet.mockReset();
  mockKeychainSet.mockReset();
  mockSidecar.mockReset();
});

describe("isVercelInstalled", () => {
  it("returns Ok(true) when the Tauri probe succeeds", async () => {
    mockInvoke.mockResolvedValueOnce(true);
    const r = await isVercelInstalled();
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith("vercel_is_installed");
  });

  it("returns Ok(false) when the CLI is missing", async () => {
    mockInvoke.mockResolvedValueOnce(false);
    const r = await isVercelInstalled();
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value).toBe(false);
  });

  it("returns NotInstalled error when invoke rejects", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("which: command not found"));
    const r = await isVercelInstalled();
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.kind).toBe("NotInstalled");
  });
});

describe("getVercelToken / setVercelToken", () => {
  it("reads from the namespaced keychain entry", async () => {
    mockKeychainGet.mockReturnValueOnce(okAsync("vrc_secret"));
    const r = await getVercelToken();
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value).toBe("vrc_secret");
    expect(mockKeychainGet).toHaveBeenCalledWith("vercel", "default");
  });

  it("returns null when the keychain entry is absent", async () => {
    mockKeychainGet.mockReturnValueOnce(okAsync(null));
    const r = await getVercelToken();
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value).toBeNull();
  });

  it("translates a keychain backend error into a Keychain DeployError", async () => {
    mockKeychainGet.mockReturnValueOnce(
      errAsync({ kind: "Backend", service: "x", account: "y", message: "denied" }),
    );
    const r = await getVercelToken();
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error.kind).toBe("Keychain");
      expect(r.error.message).toContain("denied");
    }
  });

  it("setVercelToken writes through the namespaced wrapper", async () => {
    mockKeychainSet.mockReturnValueOnce(okAsync(undefined));
    const r = await setVercelToken("vrc_new");
    expect(r.isOk()).toBe(true);
    expect(mockKeychainSet).toHaveBeenCalledWith("vercel", "default", "vrc_new");
  });
});

describe("deployToVercel", () => {
  it("returns MissingToken when no token is in the keychain", async () => {
    mockKeychainGet.mockReturnValueOnce(okAsync(null));
    const r = await deployToVercel({ projectPath: "/tmp/x", projectId: "01PROJ" });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.kind).toBe("MissingToken");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("forwards the token to vercel_deploy when present and returns the URL", async () => {
    mockKeychainGet.mockReturnValueOnce(okAsync("vrc_secret"));
    mockInvoke.mockResolvedValueOnce({ previewUrl: "https://x.vercel.app" });
    mockSidecar.mockReturnValueOnce(okAsync({ id: "01EVT" }));
    const r = await deployToVercel({ projectPath: "/tmp/x", projectId: "01PROJ" });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value.previewUrl).toBe("https://x.vercel.app");
    const args = mockInvoke.mock.calls[0]?.[1] as { projectPath: string; vercelToken: string };
    expect(args.projectPath).toBe("/tmp/x");
    expect(args.vercelToken).toBe("vrc_secret");
  });

  it("writes a deployed_preview audit row with the preview URL in the payload", async () => {
    mockKeychainGet.mockReturnValueOnce(okAsync("vrc_secret"));
    mockInvoke.mockResolvedValueOnce({ previewUrl: "https://x.vercel.app" });
    mockSidecar.mockReturnValueOnce(okAsync({ id: "01EVT" }));
    await deployToVercel({ projectPath: "/tmp/x", projectId: "01PROJ" });
    expect(mockSidecar).toHaveBeenCalledWith("audit.logEvent", {
      action: "deployed_preview",
      targetId: "01PROJ",
      payload: JSON.stringify({ previewUrl: "https://x.vercel.app" }),
    });
  });

  it("does not fail the deploy when the audit insert fails (URL is load-bearing)", async () => {
    mockKeychainGet.mockReturnValueOnce(okAsync("vrc_secret"));
    mockInvoke.mockResolvedValueOnce({ previewUrl: "https://x.vercel.app" });
    mockSidecar.mockReturnValueOnce(errAsync({ kind: "Transport", message: "ipc closed" }));
    const r = await deployToVercel({ projectPath: "/tmp/x", projectId: "01PROJ" });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value.previewUrl).toBe("https://x.vercel.app");
  });

  it("propagates a Vercel error when the CLI exits non-zero", async () => {
    mockKeychainGet.mockReturnValueOnce(okAsync("vrc_secret"));
    mockInvoke.mockRejectedValueOnce(new Error("vercel deploy failed: project not found"));
    const r = await deployToVercel({ projectPath: "/tmp/x", projectId: "01PROJ" });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error.kind).toBe("Vercel");
      expect(r.error.message).toContain("project not found");
    }
    expect(mockSidecar).not.toHaveBeenCalled();
  });

  it("propagates a Keychain error from getVercelToken", async () => {
    mockKeychainGet.mockReturnValueOnce(
      errAsync({ kind: "Backend", service: "x", account: "y", message: "denied" }),
    );
    const r = await deployToVercel({ projectPath: "/tmp/x", projectId: "01PROJ" });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.kind).toBe("Keychain");
  });
});
