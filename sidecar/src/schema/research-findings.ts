import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

import { projects } from "./projects.js";

// Per ADR-0017 follow-up (Flow M deep-research v2). One row per
// substantive observation streamed by `record_finding` during a deep-
// research run. Persisting them gives the novice an audit trail of
// *why* the spec changed even after the diff modal is closed and the
// proposal adopted.
//
// `scan_id` groups every finding from the same research run (the
// sidecar's streamId, identical to the ResearchEvent stream id the
// webview holds). One scan can produce 5-15 findings.
//
// `axis` is the prompt's 9-section taxonomy. Nullable because Claude
// may legitimately call record_finding for cross-axis observations
// that don't slot cleanly.
//
// `sources` is a JSON-encoded string array — URLs from WebFetch /
// relative paths from Read / [] for general-knowledge claims.
// JSON-in-text rather than a separate table because the cardinality
// is small (<10 sources per finding) and we never query by source.
export const researchFindings = sqliteTable(
  "research_findings",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    scanId: text("scan_id").notNull(),
    recordedAt: integer("recorded_at").notNull(),
    topic: text("topic").notNull(),
    body: text("body").notNull(),
    axis: text("axis", {
      enum: [
        "problem_users",
        "competitive_landscape",
        "scope_expansion",
        "out_of_scope",
        "flows",
        "data_model",
        "integrations",
        "nfr",
        "open_questions",
      ],
    }),
    sources: text("sources").notNull().default("[]"),
  },
  (t) => ({
    byScan: index("research_findings_by_scan").on(t.scanId),
    byProject: index("research_findings_by_project").on(t.projectId, t.recordedAt),
  }),
);

export type ResearchFinding = typeof researchFindings.$inferSelect;
export type NewResearchFinding = typeof researchFindings.$inferInsert;
