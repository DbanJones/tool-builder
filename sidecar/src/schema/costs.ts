import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

import { projects } from "./projects.js";

// Per spec.md §4 data model. One row per `result.success` event observed
// from the build subprocess (i.e. one per claude turn). The dashboard's
// cost meter reads via `costs.sumByProject` which aggregates these.
//
// `usd_cents` is stored as INTEGER to avoid floating-point drift on sums;
// the orchestrator's stream-json reports `total_cost_usd` as a float, so
// the handler converts (round to nearest cent).
export const costs = sqliteTable("costs", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  ts: integer("ts").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  usdCents: integer("usd_cents").notNull().default(0),
});

export type Cost = typeof costs.$inferSelect;
export type NewCost = typeof costs.$inferInsert;
