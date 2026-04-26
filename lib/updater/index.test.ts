import { beforeEach, describe, expect, it, vi } from "vitest";

import { check, type Update } from "@tauri-apps/plugin-updater";

import { checkForUpdate, checkForUpdateQuiet, downloadAndInstall } from "./index";

vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));

const mockCheck = vi.mocked(check);

beforeEach(() => {
  mockCheck.mockReset();
});

// The plugin's Update type has many fields we don't exercise; cast a
// minimal stub so the tests focus on the wrapper's behaviour rather than
// matching every Tauri-internal property.
const fakeUpdate = (
  overrides: Partial<{ version: string; currentVersion: string; body: string }> = {},
): Update => {
  const base = {
    version: "0.2.0",
    currentVersion: "0.1.0",
    body: overrides.body,
    ...overrides,
    downloadAndInstall: vi.fn(),
  };
  return base as unknown as Update;
};

describe("checkForUpdate", () => {
  it("returns Ok(null) when there's no update available", async () => {
    mockCheck.mockResolvedValueOnce(null);
    const r = await checkForUpdate();
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value).toBeNull();
  });

  it("returns Ok(AvailableUpdate) shape when the plugin reports one", async () => {
    mockCheck.mockResolvedValueOnce(
      fakeUpdate({ version: "0.2.0", currentVersion: "0.1.0", body: "Bug fixes" }),
    );
    const r = await checkForUpdate();
    expect(r.isOk()).toBe(true);
    if (r.isOk() && r.value) {
      expect(r.value.version).toBe("0.2.0");
      expect(r.value.currentVersion).toBe("0.1.0");
      expect(r.value.body).toBe("Bug fixes");
    }
  });

  it("translates a placeholder-pubkey error into NotConfigured (E0 not done)", async () => {
    mockCheck.mockRejectedValueOnce(
      new Error("public key REPLACE_WITH_TAURI_SIGNER_PUBKEY is malformed"),
    );
    const r = await checkForUpdate();
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.kind).toBe("NotConfigured");
  });

  it("translates a network failure into Network", async () => {
    mockCheck.mockRejectedValueOnce(new Error("failed to fetch from updates.airtec.example"));
    const r = await checkForUpdate();
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.kind).toBe("Network");
  });

  it("translates an unknown error into Unknown rather than throwing", async () => {
    mockCheck.mockRejectedValueOnce(new Error("kaboom"));
    const r = await checkForUpdate();
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error.kind).toBe("Unknown");
      expect(r.error.message).toBe("kaboom");
    }
  });
});

describe("checkForUpdateQuiet", () => {
  it("swallows NotConfigured into Ok(null) so the launch flow stays quiet", async () => {
    mockCheck.mockRejectedValueOnce(
      new Error("public key REPLACE_WITH_TAURI_SIGNER_PUBKEY is malformed"),
    );
    const r = await checkForUpdateQuiet();
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value).toBeNull();
  });

  it("propagates Network errors so the user can see them", async () => {
    mockCheck.mockRejectedValueOnce(new Error("failed to fetch"));
    const r = await checkForUpdateQuiet();
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.kind).toBe("Network");
  });

  it("propagates an actual update through without changes", async () => {
    mockCheck.mockResolvedValueOnce(fakeUpdate({ version: "0.3.0", currentVersion: "0.1.0" }));
    const r = await checkForUpdateQuiet();
    expect(r.isOk()).toBe(true);
    if (r.isOk() && r.value) expect(r.value.version).toBe("0.3.0");
  });
});

describe("downloadAndInstall", () => {
  it("calls update.downloadAndInstall when an update is available", async () => {
    const update = fakeUpdate();
    mockCheck.mockResolvedValueOnce(update);
    const r = await downloadAndInstall();
    expect(r.isOk()).toBe(true);
    expect(update.downloadAndInstall).toHaveBeenCalledTimes(1);
  });

  it("errors when downloadAndInstall is called with no update available", async () => {
    mockCheck.mockResolvedValueOnce(null);
    const r = await downloadAndInstall();
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error.kind).toBe("Unknown");
      expect(r.error.message).toContain("no update is available");
    }
  });
});
