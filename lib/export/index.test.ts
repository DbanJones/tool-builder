import { beforeEach, describe, expect, it, vi } from "vitest";

import { invoke } from "@tauri-apps/api/core";
import { errAsync, okAsync } from "neverthrow";

import { sidecarCall } from "@/lib/sidecar/client";

import { exportToGithub, isGhInstalled, sanitiseRepoName } from "./index";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/sidecar/client", () => ({ sidecarCall: vi.fn() }));

const mockInvoke = vi.mocked(invoke);
const mockSidecar = vi.mocked(sidecarCall);

beforeEach(() => {
  mockInvoke.mockReset();
  mockSidecar.mockReset();
});

describe("sanitiseRepoName", () => {
  it("lowercases and replaces whitespace with hyphens", () => {
    expect(sanitiseRepoName("My App")).toBe("my-app");
  });

  it("strips invalid chars but keeps . _ -", () => {
    expect(sanitiseRepoName("foo.bar_baz-qux!@#")).toBe("foo.bar_baz-qux");
  });

  it("trims leading/trailing punctuation", () => {
    expect(sanitiseRepoName("--my-app--")).toBe("my-app");
  });

  it("returns an empty string when nothing usable remains", () => {
    expect(sanitiseRepoName("!@#$%")).toBe("");
  });

  it("clamps length to 100", () => {
    expect(sanitiseRepoName("x".repeat(150)).length).toBe(100);
  });
});

describe("isGhInstalled", () => {
  it("returns Ok(true) when probe succeeds", async () => {
    mockInvoke.mockResolvedValueOnce(true);
    const r = await isGhInstalled();
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith("gh_is_installed");
  });

  it("returns NotInstalled error when invoke rejects", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("which: command not found"));
    const r = await isGhInstalled();
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.kind).toBe("NotInstalled");
  });
});

describe("exportToGithub", () => {
  it("returns InvalidName when the sanitised repo name is empty", async () => {
    const r = await exportToGithub({
      projectPath: "/tmp/x",
      projectId: "01PROJ",
      repoName: "!!!",
    });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.kind).toBe("InvalidName");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("forwards sanitised repoName to gh_export and returns the URL", async () => {
    mockInvoke.mockResolvedValueOnce({ repoUrl: "https://github.com/me/preppilot" });
    mockSidecar.mockReturnValueOnce(okAsync({ id: "01EVT" }));
    const r = await exportToGithub({
      projectPath: "/tmp/x",
      projectId: "01PROJ",
      repoName: "PrepPilot!",
    });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value.repoUrl).toBe("https://github.com/me/preppilot");
    const args = mockInvoke.mock.calls[0]?.[1] as { projectPath: string; repoName: string };
    expect(args.projectPath).toBe("/tmp/x");
    expect(args.repoName).toBe("preppilot");
  });

  it("writes a pushed_to_github audit row with the URL in the payload", async () => {
    mockInvoke.mockResolvedValueOnce({ repoUrl: "https://github.com/me/preppilot" });
    mockSidecar.mockReturnValueOnce(okAsync({ id: "01EVT" }));
    await exportToGithub({ projectPath: "/tmp/x", projectId: "01PROJ", repoName: "preppilot" });
    expect(mockSidecar).toHaveBeenCalledWith("audit.logEvent", {
      action: "pushed_to_github",
      targetId: "01PROJ",
      payload: JSON.stringify({ repoUrl: "https://github.com/me/preppilot" }),
    });
  });

  it("does not fail the export when the audit insert fails", async () => {
    mockInvoke.mockResolvedValueOnce({ repoUrl: "https://github.com/me/preppilot" });
    mockSidecar.mockReturnValueOnce(errAsync({ kind: "Transport", message: "ipc closed" }));
    const r = await exportToGithub({
      projectPath: "/tmp/x",
      projectId: "01PROJ",
      repoName: "preppilot",
    });
    expect(r.isOk()).toBe(true);
  });

  it("propagates a Github error when the CLI exits non-zero", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("gh repo create failed: not logged in"));
    const r = await exportToGithub({
      projectPath: "/tmp/x",
      projectId: "01PROJ",
      repoName: "preppilot",
    });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error.kind).toBe("Github");
      expect(r.error.message).toContain("not logged in");
    }
  });
});
