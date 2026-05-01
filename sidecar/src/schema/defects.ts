import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

import { projects } from "./projects.js";

// Per spec.md §4 data model and Flow L (debug module). One row per detected
// defect in the novice's target app; written by the sidecar's `debug.scan`
// handler at every phase boundary (Flow L AC1) and on novice click of
// "Debug now" (Flow L AC2).
//
// `class` corresponds to the eight defect classes from
// debug_repair_engine_spec.md §B.1. `severity`, `blast_radius`, `confidence`,
// `difficulty` are the components of the PRIORITY score (per source spec
// §C.2); `priority` and `band` are denormalised so the dashboard can sort
// without recomputing — both are recomputed on any score-input change.
//
// `scan_id` groups every finding from the same scan run, so the Debug tab
// can show "12 findings from this morning's scan, 3 carried over from
// yesterday" without joining against a separate scans table.
//
// `status` lifecycle: open → fixing (when the novice clicks Fix this) →
// fixed (verifier green, patch squashed) | dismissed (novice rejected) |
// accepted_risk (novice acknowledged, will not fix). Reopened defects get
// a new row, not a status flip — preserves the audit trail.
//
// `fix_branch` and `fix_test_path` are populated when fix_tier is 1 or 2
// and the fix has been applied; rollback (Flow L AC9) reads `fix_branch`
// and `resolved_commit` to restore pre-fix state.
export const defects = sqliteTable("defects", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  scanId: text("scan_id").notNull(),
  detectedAt: integer("detected_at").notNull(),
  class: text("class", {
    enum: ["build", "runtime", "security", "api", "auth", "deploy", "perf", "maintain"],
  }).notNull(),
  severity: integer("severity").notNull(),
  blastRadius: real("blast_radius").notNull(),
  confidence: real("confidence").notNull(),
  difficulty: real("difficulty").notNull(),
  priority: real("priority").notNull(),
  band: text("band", {
    enum: ["critical", "high", "medium", "low", "info"],
  }).notNull(),
  file: text("file").notNull(),
  lineStart: integer("line_start").notNull(),
  lineEnd: integer("line_end").notNull(),
  ruleId: text("rule_id").notNull(),
  humanExplanation: text("human_explanation").notNull(),
  codeEvidence: text("code_evidence").notNull(),
  status: text("status", {
    enum: ["open", "fixing", "fixed", "dismissed", "accepted_risk"],
  })
    .notNull()
    .default("open"),
  fixTier: integer("fix_tier"),
  fixBranch: text("fix_branch"),
  fixTestPath: text("fix_test_path"),
  resolvedAt: integer("resolved_at"),
  resolvedCommit: text("resolved_commit"),
});

export type Defect = typeof defects.$inferSelect;
export type NewDefect = typeof defects.$inferInsert;
