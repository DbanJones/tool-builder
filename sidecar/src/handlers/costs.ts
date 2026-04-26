import { eq, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { z } from "zod";

import { getDb } from "../db.js";
import { costs, type Cost } from "../schema/costs.js";

const AppendParamsSchema = z.object({
  projectId: z.string().min(1),
  model: z.string().min(1),
  inputTokens: z.number().int().min(0).default(0),
  outputTokens: z.number().int().min(0).default(0),
  // Float USD as reported by claude's `result.success.total_cost_usd`.
  // Converted to integer cents internally so sums stay exact.
  costUsd: z.number().min(0).default(0),
  ts: z.number().int().optional(),
});

/** One row per `result.success` event observed from the build subprocess. */
export function append(rawParams: unknown): Cost {
  const params = AppendParamsSchema.parse(rawParams);
  const db = getDb();
  const id = ulid();
  const ts = params.ts ?? Date.now();
  const usdCents = Math.round(params.costUsd * 100);

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
