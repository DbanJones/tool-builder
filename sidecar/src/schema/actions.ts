import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

import { projects } from "./projects.js";

// Per spec.md §4 data model — the live tail backing store. One row per tool
// call the orchestrator observes from the build subprocess.
//
// `tool` is the bare tool name as emitted by claude's stream-json (Bash, Read,
// Edit, Write, Glob, Grep, MCP tools as `mcp__<server>__<tool>`, etc.).
// `rawInput` is the full JSON-encoded tool input as observed (stored as TEXT
// rather than blob so SQLite indexing + greps work).
// `humanLine` is the translated novice-facing description ("Editing
// app/page.tsx"); nullable until D2 wires `lib/orchestrator/translate.ts`.
// `phase` and `taskId` refer to the TARGET-APP build phase + task id (e.g.
// "phase-1", "A3") that the orchestrator was on when this call landed; both
// nullable until the orchestrator's phase tracker (D5/D6) fills them in.
export const actions = sqliteTable("actions", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  ts: integer("ts").notNull(),
  tool: text("tool").notNull(),
  rawInput: text("raw_input").notNull(),
  humanLine: text("human_line"),
  phase: text("phase"),
  taskId: text("task_id"),
});

export type Action = typeof actions.$inferSelect;
export type NewAction = typeof actions.$inferInsert;
