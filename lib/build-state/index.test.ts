import { describe, expect, it, vi, beforeEach } from "vitest";

import { invoke } from "@tauri-apps/api/core";

import {
  extractLatestPlan,
  readHistoryLogTail,
  readTargetState,
  type HistoryActionEntry,
} from "./index";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  mockInvoke.mockReset();
});

describe("readTargetState", () => {
  it("returns null when the Tauri side reports no file", async () => {
    mockInvoke.mockResolvedValueOnce(null);
    const r = await readTargetState("/tmp/x");
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value).toBeNull();
  });

  it("parses + validates the minimal placeholder shape (A4c template)", async () => {
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        schema_version: 1,
        phase: null,
        next_task: null,
        tasks_completed_in_phase: 0,
        history: [],
        open_questions: [],
      }),
    );
    const r = await readTargetState("/tmp/x");
    expect(r.isOk()).toBe(true);
    if (r.isOk() && r.value) {
      expect(r.value.schema_version).toBe(1);
      expect(r.value.phase).toBeNull();
      expect(r.value.history).toEqual([]);
    }
  });

  it("parses a richer in-progress shape (orchestrator-written)", async () => {
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        schema_version: 1,
        phase: "phase-1",
        current_task: "A1",
        next_task: "A2",
        tasks_completed_in_phase: 2,
        tasks_total_in_phase: 5,
        status: "building",
        history: [
          { task_id: "A1", completed_at: "2026-04-26T12:00:00Z", commit: "abc1234" },
        ],
      }),
    );
    const r = await readTargetState("/tmp/x");
    expect(r.isOk()).toBe(true);
    if (r.isOk() && r.value) {
      expect(r.value.phase).toBe("phase-1");
      expect(r.value.tasks_completed_in_phase).toBe(2);
      expect(r.value.history?.[0]?.task_id).toBe("A1");
    }
  });

  it("forwards passthrough fields without rejecting them", async () => {
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({ phase: "phase-1", new_field: 42, another: "value" }),
    );
    const r = await readTargetState("/tmp/x");
    expect(r.isOk()).toBe(true);
    if (r.isOk() && r.value) {
      const ext = r.value as TargetStateExt;
      expect(ext.new_field).toBe(42);
      expect(ext.another).toBe("value");
    }
  });

  it("returns Parse error on malformed JSON", async () => {
    mockInvoke.mockResolvedValueOnce("{not json");
    const r = await readTargetState("/tmp/x");
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.kind).toBe("Parse");
  });

  it("returns Filesystem error when the Tauri command rejects", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("permission denied"));
    const r = await readTargetState("/tmp/x");
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error.kind).toBe("Filesystem");
      expect(r.error.message).toBe("permission denied");
    }
  });
});

interface TargetStateExt {
  new_field?: number;
  another?: string;
}

describe("readHistoryLogTail", () => {
  it("returns parsed entries in arrival order", async () => {
    mockInvoke.mockResolvedValueOnce([
      JSON.stringify({
        id: "01ABC",
        ts: 1,
        tool: "Read",
        rawInput: "{}",
        humanLine: "Reading CLAUDE.md",
        phase: null,
        taskId: null,
      }),
      JSON.stringify({
        id: "01DEF",
        ts: 2,
        tool: "Edit",
        rawInput: "{}",
        humanLine: "Editing page.tsx",
        phase: null,
        taskId: null,
      }),
    ]);
    const r = await readHistoryLogTail("/tmp/x", 50);
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      expect(r.value).toHaveLength(2);
      expect(r.value[0]?.tool).toBe("Read");
      expect(r.value[1]?.tool).toBe("Edit");
    }
  });

  it("silently drops malformed lines but keeps the well-formed ones", async () => {
    mockInvoke.mockResolvedValueOnce([
      JSON.stringify({
        id: "01ABC",
        ts: 1,
        tool: "Read",
        rawInput: "{}",
        humanLine: null,
        phase: null,
        taskId: null,
      }),
      "{not json — partial line from a crashed write",
      JSON.stringify({
        // missing required `tool` field — Zod rejects, line skipped
        id: "01XYZ",
        ts: 2,
      }),
      JSON.stringify({
        id: "01DEF",
        ts: 3,
        tool: "Bash",
        rawInput: "{}",
        humanLine: "Running ls",
        phase: null,
        taskId: null,
      }),
    ]);
    const r = await readHistoryLogTail("/tmp/x", 50);
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      expect(r.value).toHaveLength(2);
      expect(r.value[0]?.tool).toBe("Read");
      expect(r.value[1]?.tool).toBe("Bash");
    }
  });

  it("returns Filesystem error when the Tauri command rejects (file too large, etc.)", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("history.log exceeds 16777216 byte cap"));
    const r = await readHistoryLogTail("/tmp/x", 50);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error.kind).toBe("Filesystem");
      expect(r.error.message).toMatch(/cap/);
    }
  });

  it("returns an empty list when the log doesn't exist (Rust returned [])", async () => {
    mockInvoke.mockResolvedValueOnce([]);
    const r = await readHistoryLogTail("/tmp/x", 50);
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value).toEqual([]);
  });
});

describe("extractLatestPlan", () => {
  const mkAction = (
    over: Partial<HistoryActionEntry> & { ts: number; tool: string; rawInput: string },
  ): HistoryActionEntry => ({
    id: `a-${over.ts}`,
    humanLine: null,
    phase: null,
    taskId: null,
    ...over,
  });

  it("returns [] when no actions are provided", () => {
    expect(extractLatestPlan([])).toEqual([]);
  });

  it("returns [] when no TodoWrite calls exist in the tail", () => {
    const actions = [
      mkAction({ ts: 1, tool: "Read", rawInput: '{"file_path":"/x"}' }),
      mkAction({ ts: 2, tool: "Bash", rawInput: '{"command":"ls"}' }),
    ];
    expect(extractLatestPlan(actions)).toEqual([]);
  });

  it("returns the todos array from the only TodoWrite present", () => {
    const todos = [
      { content: "Set up the database", status: "completed", activeForm: "Setting up the database" },
      { content: "Wire the homepage", status: "in_progress", activeForm: "Wiring the homepage" },
    ];
    const actions = [
      mkAction({ ts: 1, tool: "TodoWrite", rawInput: JSON.stringify({ todos }) }),
    ];
    expect(extractLatestPlan(actions)).toEqual(todos);
  });

  it("returns the LATEST TodoWrite when several appear (older ones discarded)", () => {
    const earlier = [
      { content: "Plan v1", status: "pending" as const, activeForm: "Planning v1" },
    ];
    const latest = [
      { content: "Plan v2 step 1", status: "completed" as const, activeForm: "Doing step 1" },
      { content: "Plan v2 step 2", status: "in_progress" as const, activeForm: "Doing step 2" },
      { content: "Plan v2 step 3", status: "pending" as const, activeForm: "Doing step 3" },
    ];
    const actions = [
      mkAction({ ts: 1, tool: "TodoWrite", rawInput: JSON.stringify({ todos: earlier }) }),
      mkAction({ ts: 2, tool: "Bash", rawInput: '{"command":"ls"}' }),
      mkAction({ ts: 3, tool: "TodoWrite", rawInput: JSON.stringify({ todos: latest }) }),
      mkAction({ ts: 4, tool: "Read", rawInput: '{"file_path":"/x"}' }),
    ];
    expect(extractLatestPlan(actions)).toEqual(latest);
  });

  it("falls back to the next-older TodoWrite when the latest has malformed JSON in rawInput", () => {
    const usable = [
      { content: "First plan", status: "pending" as const, activeForm: "Working on first" },
    ];
    const actions = [
      mkAction({ ts: 1, tool: "TodoWrite", rawInput: JSON.stringify({ todos: usable }) }),
      mkAction({ ts: 2, tool: "TodoWrite", rawInput: "{not valid json" }),
    ];
    expect(extractLatestPlan(actions)).toEqual(usable);
  });

  it("drops individual todos that fail schema validation but keeps the well-formed ones", () => {
    const good = { content: "good", status: "pending" as const, activeForm: "Working on good" };
    const actions = [
      mkAction({
        ts: 1,
        tool: "TodoWrite",
        rawInput: JSON.stringify({
          todos: [
            good,
            { content: "missing status field" },
            { status: "in_progress", activeForm: "missing content" },
            "not even an object",
          ],
        }),
      }),
    ];
    expect(extractLatestPlan(actions)).toEqual([good]);
  });

  it("returns [] when the latest TodoWrite has todos: null / wrong type", () => {
    const actions = [
      mkAction({ ts: 1, tool: "TodoWrite", rawInput: JSON.stringify({ todos: null }) }),
    ];
    expect(extractLatestPlan(actions)).toEqual([]);
  });
});
