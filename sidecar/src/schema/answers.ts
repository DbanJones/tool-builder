import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

import { projects } from "./projects.js";

// Per spec.md §4 data model.
// `confidence`:
//   - confident: novice answered directly and clearly.
//   - tentative: extracted from a file (PII/Vision/parser pipeline).
//   - default-applied: novice did not answer; the kit's default kicked in.
// `source`:
//   - chat: written by Claude via the record_answer MCP tool.
//   - file: extracted from an uploaded file (later phase).
//   - default: filled in by the kit's decision-table defaults.
export const answers = sqliteTable("answers", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  questionId: text("question_id").notNull(),
  answerText: text("answer_text").notNull(),
  confidence: text("confidence", { enum: ["confident", "tentative", "default-applied"] })
    .notNull()
    .default("tentative"),
  source: text("source", { enum: ["chat", "file", "default"] }).notNull().default("chat"),
  rationale: text("rationale"),
  createdAt: integer("created_at").notNull(),
});

export type Answer = typeof answers.$inferSelect;
export type NewAnswer = typeof answers.$inferInsert;
