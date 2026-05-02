import { and, asc, eq } from "drizzle-orm";
import { ulid } from "ulid";
import { z } from "zod";

import { getDb } from "../db.js";
import { researchFindings, type ResearchFinding } from "../schema/research-findings.js";

// Per ADR-0017 follow-up. One row per record_finding call during a
// deep-research run. The MCP tool handler in research-driver.ts invokes
// `append` directly (not via RPC) so the persistence is synchronous
// with the SDK tool callback — if the DB write fails, the tool's
// content message reflects that and Claude can decide to retry.

const AXIS_ENUM = [
  "problem_users",
  "competitive_landscape",
  "scope_expansion",
  "out_of_scope",
  "flows",
  "data_model",
  "integrations",
  "nfr",
  "open_questions",
] as const;

const AppendParamsSchema = z.object({
  projectId: z.string().min(1),
  scanId: z.string().min(1),
  topic: z.string().min(1).max(200),
  body: z.string().min(1).max(4000),
  axis: z.enum(AXIS_ENUM).nullable().optional(),
  /** URLs / file paths cited via WebFetch / Read. Persisted as JSON. */
  sources: z.array(z.string().min(1).max(500)).max(20).optional(),
  recordedAt: z.number().int().optional(),
});

export function append(rawParams: unknown): ResearchFinding {
  const params = AppendParamsSchema.parse(rawParams);
  const db = getDb();
  const id = ulid();
  const recordedAt = params.recordedAt ?? Date.now();
  const sourcesJson = JSON.stringify(params.sources ?? []);

  const [inserted] = db
    .insert(researchFindings)
    .values({
      id,
      projectId: params.projectId,
      scanId: params.scanId,
      recordedAt,
      topic: params.topic,
      body: params.body,
      axis: params.axis ?? null,
      sources: sourcesJson,
    })
    .returning()
    .all();

  if (!inserted) {
    throw new Error("research-findings insert returned no rows");
  }
  return inserted;
}

const ListByScanParamsSchema = z.object({
  scanId: z.string().min(1),
});

/** Read every finding from one research run, oldest first (so the
 *  audit trail reads chronologically). */
export function listByScan(rawParams: unknown): ResearchFinding[] {
  const params = ListByScanParamsSchema.parse(rawParams);
  const db = getDb();
  return db
    .select()
    .from(researchFindings)
    .where(eq(researchFindings.scanId, params.scanId))
    .orderBy(asc(researchFindings.recordedAt))
    .all();
}

const ListByProjectParamsSchema = z.object({
  projectId: z.string().min(1),
  limit: z.number().int().min(1).max(500).default(50),
});

/** Read recent findings across every research run on this project
 *  (newest first). Used by the audit panel to surface "everything
 *  Dave researched on this project, ever". */
export function listByProject(rawParams: unknown): ResearchFinding[] {
  const params = ListByProjectParamsSchema.parse(rawParams);
  const db = getDb();
  return db
    .select()
    .from(researchFindings)
    .where(eq(researchFindings.projectId, params.projectId))
    .orderBy(asc(researchFindings.recordedAt))
    .limit(params.limit)
    .all();
}

/** Direct (non-RPC) append helper for the in-process MCP tool. The
 *  research driver calls this from inside the SDK MCP `record_finding`
 *  handler so persistence runs in the same tick as the live-tail
 *  emit — no notification round-trip. */
export function appendDirect(args: {
  projectId: string;
  scanId: string;
  topic: string;
  body: string;
  axis: string | null;
  sources: ReadonlyArray<string>;
}): ResearchFinding {
  return append({
    projectId: args.projectId,
    scanId: args.scanId,
    topic: args.topic,
    body: args.body,
    axis: args.axis,
    sources: [...args.sources],
  });
}

/** Helper for callers that already hold a ResearchFinding row and want
 *  the JSON-encoded `sources` field as a real array. */
export function parseSources(row: ResearchFinding): string[] {
  try {
    const parsed = JSON.parse(row.sources) as unknown;
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

export const __test = { AXIS_ENUM };
