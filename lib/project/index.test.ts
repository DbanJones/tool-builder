import { describe, it, expect, vi, beforeEach } from "vitest";
import { okAsync, errAsync } from "neverthrow";

import { invoke } from "@tauri-apps/api/core";
import { sidecarCall } from "@/lib/sidecar/client";
import { createProject, sanitiseProjectName, validateProjectName } from "./index";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/sidecar/client", () => ({ sidecarCall: vi.fn() }));

const mockInvoke = vi.mocked(invoke);
const mockSidecarCall = vi.mocked(sidecarCall);

beforeEach(() => {
  mockInvoke.mockReset();
  mockSidecarCall.mockReset();
});

describe("sanitiseProjectName", () => {
  it.each([
    ["preppilot", "preppilot"],
    ["PrepPilot", "preppilot"],
    ["My App", "my-app"],
    ["My  Cool   App", "my-cool-app"],
    ["my-app", "my-app"],
    ["my_app", "my_app"],
    ["my.app", "my.app"],
    ["app1", "app1"],
    ["Cafe au Lait", "cafe-au-lait"],
    ["a", "a"],
    [".hidden", "hidden"],
    ["_private", "private"],
    ["...trim...", "trim"],
    ["has/slash", "hasslash"],
    ["has\\backslash", "hasbackslash"],
    ["with-emoji-🎉-here", "with-emoji-here"],
    ["é-acute", "acute"],
    ["dash-dash--dash", "dash-dash-dash"],
  ])("sanitises %s -> %s", (input, expected) => {
    expect(sanitiseProjectName(input)).toBe(expected);
  });

  it.each([["", null], ["   ", null], ["...", null], ["🎉", null], ["é", null]])(
    "returns null for unusable %s",
    (input, expected) => {
      expect(sanitiseProjectName(input)).toBe(expected);
    },
  );

  it("caps at 100 chars and trims trailing punctuation", () => {
    const long = "a".repeat(99) + "-bb";
    const result = sanitiseProjectName(long);
    expect(result).not.toBeNull();
    expect((result ?? "").length).toBeLessThanOrEqual(100);
    expect((result ?? "").endsWith("-")).toBe(false);
  });
});

describe("validateProjectName", () => {
  it.each([
    ["preppilot", true],
    ["PrepPilot", true],
    ["My App", true],
    ["my-app", true],
    ["my_app", true],
    ["a", true],
    ["app1", true],
    ["Café au Lait", true],
  ])("accepts %s", (name, expected) => {
    expect(validateProjectName(name) === null).toBe(expected);
  });

  it.each([
    ["", "required"],
    ["   ", "required"],
    ["🎉", "needs"],
    ["...", "needs"],
  ])("rejects %s with InvalidName", (name, expectedHint) => {
    const r = validateProjectName(name);
    expect(r).not.toBeNull();
    if (r) {
      expect(r.kind).toBe("InvalidName");
      expect(r.message.toLowerCase()).toContain(expectedHint);
    }
  });

  it("rejects names over 200 chars", () => {
    const tooLong = "a".repeat(201);
    expect(validateProjectName(tooLong)?.kind).toBe("InvalidName");
  });
});

describe("createProject", () => {
  it("returns InvalidName before any side effect when the name is unusable", async () => {
    const r = await createProject("🎉", "/tmp/builds");
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

  it("forwards the raw name (display) to the Tauri command and the sidecar", async () => {
    mockInvoke.mockResolvedValueOnce("/Users/x/ClaudeBuilds/my-cool-app");
    mockSidecarCall.mockReturnValueOnce(
      okAsync({
        id: "01T",
        name: "My Cool App",
        path: "/Users/x/ClaudeBuilds/my-cool-app",
        status: "interviewing" as const,
        currentPhase: null,
        createdAt: 1,
        updatedAt: 1,
        lastOpenedAt: 1,
        deletedAt: null,
      }),
    );
    await createProject("My Cool App", "~/Documents/ClaudeBuilds");
    // Tauri receives the raw name; it does the sanitisation internally.
    expect(mockInvoke).toHaveBeenCalledWith("project_create_folder", {
      name: "My Cool App",
      folder: "~/Documents/ClaudeBuilds",
    });
    // Sidecar receives the raw name as the projects.name display value.
    expect(mockSidecarCall).toHaveBeenCalledWith("projects.create", {
      name: "My Cool App",
      path: "/Users/x/ClaudeBuilds/my-cool-app",
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
