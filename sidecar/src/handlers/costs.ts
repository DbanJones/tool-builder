import { eq, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { z } from "zod";

import { getDb } from "../db.js";
import { costs, type Cost } from "../schema/costs.js";

const AppendParamsSchema = z.object({
  projectId: z.string().min(1),
  model: z.string().min(1),
  // .finite() rejects NaN + Infinity; .min() alone does NOT (NaN < 0 is
  // false → passes). Without this, malformed claude usage data would
  // poison the costs table with NaN cents and silently break sums.
  inputTokens: z.number().int().finite().min(0).default(0),
  outputTokens: z.number().int().finite().min(0).default(0),
  // Float USD as reported by claude's `result.success.total_cost_usd`.
  // Converted to integer cents internally so sums stay exact.
  costUsd: z.number().finite().min(0).default(0),
  ts: z.number().int().optional(),
});

/** One row per `result.success` event observed from the build subprocess. */
export function append(rawParams: unknown): Cost {
  const params = AppendParamsSchema.parse(rawParams);
  const db = getDb();
  const id = ulid();
  const ts = params.ts ?? Date.now();
  // Belt-and-braces: even with the .finite() guard above, defend the
  // INTEGER column from a NaN landing if the schema ever loosens.
  const rawCents = params.costUsd * 100;
  const usdCents = Number.isFinite(rawCents) ? Math.round(rawCents) : 0;

  const [inserted] = db
    .insert(costs)
    .values({
      id,
      projectId: params.projectId,
      ts,
      model: params.model,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      usdCents,
    })
    .returning()
    .all();

  if (!inserted) throw new Error("insert returned no rows");
  return inserted;
}

const SumParamsSchema = z.object({ projectId: z.string().min(1) });

export interface CostSum {
  /** Total turns (rows in the costs table) for this project. */
  turns: number;
  inputTokens: number;
  outputTokens: number;
  usdCents: number;
}

/** Aggregate totals for the dashboard cost meter — one round trip. */
export function sumByProject(rawParams: unknown): CostSum {
  const params = SumParamsSchema.parse(rawParams);
  const db = getDb();
  const [row] = db
    .select({
      turns: sql<number>`count(*)`,
      inputTokens: sql<number>`coalesce(sum(${costs.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${costs.outputTokens}), 0)`,
      usdCents: sql<number>`coalesce(sum(${costs.usdCents}), 0)`,
    })
    .from(costs)
    .where(eq(costs.projectId, params.projectId))
    .all();

  return row ?? { turns: 0, inputTokens: 0, outputTokens: 0, usdCents: 0 };
}
