import { and, asc, desc, eq, gt } from "drizzle-orm";
import { ulid } from "ulid";
import { z } from "zod";

import { getDb } from "../db.js";
import { actions, type Action } from "../schema/actions.js";

const AppendParamsSchema = z.object({
  projectId: z.string().min(1),
  tool: z.string().min(1),
  // The orchestrator passes through claude's tool input as already-stringified
  // JSON (the parser sees it as text on the way in). Keeping this as a string
  // avoids round-tripping through `JSON.stringify` here and lets the caller
  // preserve key order if it matters for diffs.
  rawInput: z.string(),
  humanLine: z.string().nullable().optional(),
  phase: z.string().nullable().optional(),
  taskId: z.string().nullable().optional(),
  ts: z.number().int().optional(),
});

/**
 * Append a single tool-call observation to the live tail backing store.
 * One row per tool call. The orchestrator calls this for every tool_use
 * event it parses out of `claude --output-format stream-json`.
 *
 * Returns the inserted row so the caller can read back the assigned id and
 * timestamp without a follow-up SELECT.
 */
export function append(rawParams: unknown): Action {
  const params = AppendParamsSchema.parse(rawParams);
  const db = getDb();
  const id = ulid();
  const ts = params.ts ?? Date.now();

  const [inserted] = db
    .insert(actions)
    .values({
      id,
      projectId: params.projectId,
      ts,
      tool: params.tool,
      rawInput: params.rawInput,
      humanLine: params.humanLine ?? null,
      phase: params.phase ?? null,
      taskId: params.taskId ?? null,
    })
    .returning()
    .all();

  if (!inserted) {
    throw new Error("insert returned no rows");
  }
  return inserted;
}

const ListParamsSchema = z.object({
  projectId: z.string().min(1),
  // Cursor pagination: pass the `ts` of the last row you saw to get the
  // next page (rows STRICTLY newer than `sinceTs`). Default order is
  // oldest-first when paging forward; pass `order: "desc"` for "newest first"
  // (used by the dashboard when opening a paused project).
  sinceTs: z.number().int().optional(),
  limit: z.number().int().min(1).max(500).default(50),
  order: z.enum(["asc", "desc"]).default("asc"),
});

/**
 * List actions for a project. Cursor pagination by `ts`; default page size 50
 * per rules/02-backend.md B10.
 */
export function list(rawParams: unknown): Action[] {
  const params = ListParamsSchema.parse(rawParams);
  const db = getDb();
  const where = params.sinceTs !== undefined
    ? and(eq(actions.projectId, params.projectId), gt(actions.ts, params.sinceTs))
    : eq(actions.projectId, params.projectId);
  return db
    .select()
    .from(actions)
    .where(where)
    .orderBy(params.order === "asc" ? asc(actions.ts) : desc(actions.ts))
    .limit(params.limit)
    .all();
}
