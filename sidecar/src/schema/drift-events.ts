import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

import { projects } from "./projects.js";

// Per spec.md §4 data model. One row per drift event observed during the
// build (typically by the orchestrator running /recheck at a phase boundary).
//
// `resolution` is null until the novice clicks Revert/Amend/Accept on the
// dashboard banner; the `drift.listOpen` query filters on resolution IS NULL
// to find rows that still need attention.
//
// `kind` corresponds to the drift forms in rules/07-self-check.md SC6-SC8
// (implementation, scope, silent_assumption) plus a non-functional category.
export const driftEvents = sqliteTable("drift_events", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  phase: text("phase").notNull(),
  kind: text("kind", {
    enum: ["implementation", "scope", "silent_assumption", "nfr"],
  }).notNull(),
  description: text("description").notNull(),
  resolution: text("resolution", { enum: ["revert", "amend_spec", "accept"] }),
  commitHash: text("commit_hash"),
  occurredAt: integer("occurred_at").notNull(),
  resolvedAt: integer("resolved_at"),
});

export type DriftEvent = typeof driftEvents.$inferSelect;
export type NewDriftEvent = typeof driftEvents.$inferInsert;
