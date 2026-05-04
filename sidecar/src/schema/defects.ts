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
  // Layer 2 validator output (Phase G G4). Null when the scan ran with
  // validate=false (Layer 1 only) or when the validator has not yet
  // adjudicated this row. The validator can up- or down-grade
  // confidence — when it does, priority and band are recomputed on the
  // same row in place. `validatedAt` is the wall-clock at adjudication;
  // `validatorNotes` packs exploitPath + fixStrategy as a single JSON
  // blob so we don't need a fourth migration just to split them.
  validatorVerdict: text("validator_verdict", {
    enum: ["real", "false_positive", "uncertain"],
  }),
  validatorNotes: text("validator_notes"),
  validatedAt: integer("validated_at"),
  // Tier 3 suggested fix (Phase G G7). Populated when Tier 2 fails to
  // apply a clean patch — we keep the model's last attempted edits and
  // explanation so the dashboard can surface "here's what we suggest
  // you try" rather than silently aborting. JSON-encoded shape:
  //   { explanation: string, edits: PatchEdit[], errors: string }
  // Null when no Tier 3 suggestion exists for this row.
  suggestion: text("suggestion"),
});

export type Defect = typeof defects.$inferSelect;
export type NewDefect = typeof defects.$inferInsert;
