import { and, asc, eq, isNull } from "drizzle-orm";
import { ulid } from "ulid";
import { z } from "zod";

import { getDb } from "../db.js";
import { driftEvents, type DriftEvent } from "../schema/drift-events.js";

const AppendParamsSchema = z.object({
  projectId: z.string().min(1),
  phase: z.string().min(1),
  kind: z.enum(["implementation", "scope", "silent_assumption", "nfr"]),
  description: z.string().min(1),
  occurredAt: z.number().int().optional(),
});

/**
 * Record a drift event observed during the build (typically by the
 * orchestrator running /recheck). Resolution is null until the novice
 * picks one on the dashboard banner.
 */
export function append(rawParams: unknown): DriftEvent {
  const params = AppendParamsSchema.parse(rawParams);
  const db = getDb();
  const id = ulid();
  const occurredAt = params.occurredAt ?? Date.now();

  const [inserted] = db
    .insert(driftEvents)
    .values({
      id,
      projectId: params.projectId,
      phase: params.phase,
      kind: params.kind,
      description: params.description,
      occurredAt,
    })
    .returning()
    .all();

  if (!inserted) throw new Error("insert returned no rows");
  return inserted;
}

const ResolveParamsSchema = z.object({
  id: z.string().min(1),
  resolution: z.enum(["revert", "amend_spec", "accept"]),
  commitHash: z.string().optional(),
});

/** Set the resolution + commit_hash + resolved_at. Idempotent on repeats. */
export function resolve(rawParams: unknown): DriftEvent {
  const params = ResolveParamsSchema.parse(rawParams);
  const db = getDb();
  const [updated] = db
    .update(driftEvents)
    .set({
      resolution: params.resolution,
      commitHash: params.commitHash ?? null,
      resolvedAt: Date.now(),
    })
    .where(eq(driftEvents.id, params.id))
    .returning()
    .all();

  if (!updated) throw new Error(`drift.resolve: no event with id '${params.id}'`);
  return updated;
}

const ListOpenParamsSchema = z.object({ projectId: z.string().min(1) });

/** All unresolved drifts for a project, oldest-first (banner shows the head). */
export function listOpen(rawParams: unknown): DriftEvent[] {
  const params = ListOpenParamsSchema.parse(rawParams);
  const db = getDb();
  return db
    .select()
    .from(driftEvents)
    .where(and(eq(driftEvents.projectId, params.projectId), isNull(driftEvents.resolution)))
    .orderBy(asc(driftEvents.occurredAt))
    .all();
}
