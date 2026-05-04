import { describe, it, expect } from "vitest";

import type { HistoryActionEntry } from "./index";
import { renderTurnSummary, summariseTurn } from "./turn-summary";

const action = (over: Partial<HistoryActionEntry>): HistoryActionEntry => ({
  id: "test",
  ts: 0,
  tool: "Edit",
  rawInput: "{}",
  humanLine: null,
  phase: null,
  taskId: null,
  ...over,
});

describe("summariseTurn", () => {
  it("returns zero counts on an empty action list", () => {
    expect(summariseTurn([], 0)).toEqual({
      filesEdited: [],
      filesWritten: [],
      bashCount: 0,
      testCount: 0,
      totalActions: 0,
    });
  });

  it("ignores actions older than sinceTs", () => {
    const actions: HistoryActionEntry[] = [
      action({
        ts: 100,
        tool: "Edit",
        rawInput: JSON.stringify({ file_path: "/old.ts" }),
      }),
      action({
        ts: 200,
        tool: "Edit",
        rawInput: JSON.stringify({ file_path: "/new.ts" }),
      }),
    ];
    const summary = summariseTurn(actions, 150);
    expect(summary.filesEdited).toEqual(["new.ts"]);
    expect(summary.totalActions).toBe(1);
  });

  it("de-duplicates files edited multiple times in the same turn", () => {
    const actions: HistoryActionEntry[] = [
      action({
        ts: 100,
        tool: "Edit",
        rawInput: JSON.stringify({ file_path: "/a.ts" }),
      }),
      action({
        ts: 200,
        tool: "Edit",
        rawInput: JSON.stringify({ file_path: "/a.ts" }),
      }),
      action({
        ts: 300,
        tool: "MultiEdit",
        rawInput: JSON.stringify({ file_path: "/b.ts" }),
      }),
    ];
    const summary = summariseTurn(actions, 0);
    expect(summary.filesEdited).toEqual(["a.ts", "b.ts"]);
  });

  it("separates Write from Edit", () => {
    const actions: HistoryActionEntry[] = [
      action({ ts: 1, tool: "Write", rawInput: JSON.stringify({ file_path: "/n.ts" }) }),
      action({ ts: 2, tool: "Edit", rawInput: JSON.stringify({ file_path: "/e.ts" }) }),
    ];
    const summary = summariseTurn(actions, 0);
    expect(summary.filesEdited).toEqual(["e.ts"]);
    expect(summary.filesWritten).toEqual(["n.ts"]);
  });

  it("counts Bash invocations and detects test runs", () => {
    const actions: HistoryActionEntry[] = [
      action({ ts: 1, tool: "Bash", rawInput: JSON.stringify({ command: "ls" }) }),
      action({ ts: 2, tool: "Bash", rawInput: JSON.stringify({ command: "npm test" }) }),
      action({ ts: 3, tool: "Bash", rawInput: JSON.stringify({ command: "vitest run" }) }),
      action({ ts: 4, tool: "Bash", rawInput: JSON.stringify({ command: "corepack pnpm verify" }) }),
    ];
    const summary = summariseTurn(actions, 0);
    expect(summary.bashCount).toBe(4);
    expect(summary.testCount).toBe(3);
  });

  it("shortens paths that contain /ClaudeBuilds/<project>/", () => {
    const actions: HistoryActionEntry[] = [
      action({
        ts: 1,
        tool: "Edit",
        rawInput: JSON.stringify({
          file_path: "/Users/dennis/Documents/ClaudeBuilds/echo/game/scenes/TutorialScene.ts",
        }),
      }),
    ];
    const summary = summariseTurn(actions, 0);
    expect(summary.filesEdited).toEqual(["game/scenes/TutorialScene.ts"]);
  });

  it("ignores Read / Glob / Grep actions (non-mutating)", () => {
    const actions: HistoryActionEntry[] = [
      action({ ts: 1, tool: "Read", rawInput: JSON.stringify({ file_path: "/a.ts" }) }),
      action({ ts: 2, tool: "Glob", rawInput: JSON.stringify({ pattern: "*.ts" }) }),
      action({ ts: 3, tool: "Grep", rawInput: JSON.stringify({ pattern: "TODO" }) }),
    ];
    const summary = summariseTurn(actions, 0);
    expect(summary.filesEdited).toEqual([]);
    expect(summary.filesWritten).toEqual([]);
    expect(summary.bashCount).toBe(0);
    expect(summary.totalActions).toBe(3);
  });

  it("handles malformed rawInput JSON gracefully", () => {
    const actions: HistoryActionEntry[] = [
      action({ ts: 1, tool: "Edit", rawInput: "not json" }),
      action({ ts: 2, tool: "Bash", rawInput: "still not json" }),
    ];
    const summary = summariseTurn(actions, 0);
    expect(summary.filesEdited).toEqual([]);
    expect(summary.bashCount).toBe(1);
    expect(summary.testCount).toBe(0);
  });
});

describe("renderTurnSummary", () => {
  it("returns empty string when nothing observable changed", () => {
    expect(
      renderTurnSummary(
        { filesEdited: [], filesWritten: [], bashCount: 0, testCount: 0, totalActions: 0 },
        "build",
      ),
    ).toBe("");
  });

  it("renders edited files inline up to 5", () => {
    const out = renderTurnSummary(
      {
        filesEdited: ["a.ts", "b.ts", "c.ts"],
        filesWritten: [],
        bashCount: 0,
        testCount: 0,
        totalActions: 3,
      },
      "build",
    );
    expect(out).toContain("Build turn finished");
    expect(out).toContain("Edited 3 files");
    expect(out).toContain("`a.ts`");
    expect(out).toContain("`c.ts`");
  });

  it("collapses long file lists to '+N more'", () => {
    const paths = Array.from({ length: 8 }, (_, i) => `f${i}.ts`);
    const out = renderTurnSummary(
      { filesEdited: paths, filesWritten: [], bashCount: 0, testCount: 0, totalActions: 8 },
      "build",
    );
    expect(out).toContain("+3 more");
    expect(out).toContain("`f0.ts`");
    expect(out).toContain("`f4.ts`");
    expect(out).not.toContain("`f5.ts`");
  });

  it("includes test-run note when tests fired", () => {
    const out = renderTurnSummary(
      { filesEdited: ["x.ts"], filesWritten: [], bashCount: 4, testCount: 2, totalActions: 5 },
      "build",
    );
    expect(out).toContain("Ran 4 shell commands");
    expect(out).toContain("(2 test runs)");
  });

  it("uses 'Repair finished' heading for the repair kind", () => {
    const out = renderTurnSummary(
      { filesEdited: ["x.ts"], filesWritten: [], bashCount: 0, testCount: 0, totalActions: 1 },
      "repair",
    );
    expect(out).toContain("Repair finished");
    expect(out).not.toContain("Build turn finished");
  });
});
