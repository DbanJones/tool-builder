import { describe, it, expect, vi, beforeEach } from "vitest";
import { okAsync, errAsync } from "neverthrow";

import { invoke } from "@tauri-apps/api/core";
import { sidecarCall } from "@/lib/sidecar/client";
import { createProject, validateProjectName } from "./index";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/sidecar/client", () => ({ sidecarCall: vi.fn() }));

const mockInvoke = vi.mocked(invoke);
const mockSidecarCall = vi.mocked(sidecarCall);

beforeEach(() => {
  mockInvoke.mockReset();
  mockSidecarCall.mockReset();
});

describe("validateProjectName", () => {
  it.each([
    ["preppilot", true],
    ["my-app", true],
    ["my_app", true],
    ["my.app", true],
    ["a", true],
    ["app1", true],
  ])("accepts %s", (name, expected) => {
    expect(validateProjectName(name) === null).toBe(expected);
  });

  it.each([
    ["", "required"],
    ["My App", "lowercase"],
    ["MyApp", "lowercase"],
    [".hidden", "lowercase"],
    ["_private", "lowercase"],
    ["has space", "lowercase"],
    ["has/slash", "lowercase"],
  ])("rejects %s", (name, _hint) => {
    expect(validateProjectName(name)).not.toBeNull();
  });

  it("rejects names over 214 chars", () => {
    const tooLong = "a".repeat(215);
    expect(validateProjectName(tooLong)?.kind).toBe("InvalidName");
  });
});

describe("createProject", () => {
  it("returns InvalidName before any side effect when the name fails validation", async () => {
    const r = await createProject("My App", "/tmp/builds");
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.kind).toBe("InvalidName");
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockSidecarCall).not.toHaveBeenCalled();
  });

  it("returns InvalidFolder when the folder is empty", async () => {
    const r = await createProject("preppilot", "");
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.kind).toBe("InvalidFolder");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("calls project_create_folder then projects.create on the happy path", async () => {
    mockInvoke.mockResolvedValueOnce("/Users/x/ClaudeBuilds/preppilot");
    const project = {
      id: "01TEST",
      name: "preppilot",
      path: "/Users/x/ClaudeBuilds/preppilot",
      status: "interviewing" as const,
      currentPhase: null,
      createdAt: 1,
      updatedAt: 1,
      lastOpenedAt: 1,
      deletedAt: null,
    };
    mockSidecarCall.mockReturnValueOnce(okAsync(project));

    const r = await createProject("preppilot", "~/Documents/ClaudeBuilds");
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value).toEqual(project);

    expect(mockInvoke).toHaveBeenCalledWith("project_create_folder", {
      name: "preppilot",
      folder: "~/Documents/ClaudeBuilds",
    });
    expect(mockSidecarCall).toHaveBeenCalledWith("projects.create", {
      name: "preppilot",
      path: "/Users/x/ClaudeBuilds/preppilot",
    });
  });

  it("returns Filesystem error when the Tauri command rejects", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("target folder already exists"));
    const r = await createProject("preppilot", "/tmp/builds");
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error.kind).toBe("Filesystem");
      expect(r.error.message).toBe("target folder already exists");
    }
    expect(mockSidecarCall).not.toHaveBeenCalled();
  });

  it("returns Db error when the sidecar call fails", async () => {
    mockInvoke.mockResolvedValueOnce("/tmp/builds/preppilot");
    mockSidecarCall.mockReturnValueOnce(
      errAsync({ kind: "Sidecar", code: "HANDLER_ERROR", message: "constraint failed" }),
    );
    const r = await createProject("preppilot", "/tmp/builds");
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error.kind).toBe("Db");
      expect(r.error.message).toBe("HANDLER_ERROR: constraint failed");
    }
  });
});
