import { eq, isNull } from "drizzle-orm";
import { ulid } from "ulid";
import { z } from "zod";

import { getDb } from "../db.js";
import { auditLog } from "../schema/audit-log.js";
import { projects, type Project } from "../schema/projects.js";

const CreateParamsSchema = z.object({
  name: z.string().min(1).max(214),
  path: z.string().min(1),
});

/**
 * Insert a new project row plus a `project_created` audit row in one
 * transaction. Returns the inserted project.
 */
export function create(rawParams: unknown): Project {
  const params = CreateParamsSchema.parse(rawParams);
  const db = getDb();
  const id = ulid();
  const now = Date.now();

  return db.transaction((tx) => {
    const [inserted] = tx
      .insert(projects)
      .values({
        id,
        name: params.name,
        path: params.path,
        status: "interviewing",
        currentPhase: null,
        createdAt: now,
        updatedAt: now,
        lastOpenedAt: now,
      })
      .returning()
      .all();

    tx.insert(auditLog)
      .values({
        id: ulid(),
        action: "project_created",
        targetId: id,
        payload: JSON.stringify({ name: params.name, path: params.path }),
        createdAt: now,
      })
      .run();

    if (!inserted) {
      throw new Error("insert returned no rows");
    }
    return inserted;
  });
}

const ListParamsSchema = z.object({
  includeDeleted: z.boolean().default(false),
});

export function list(rawParams: unknown): Project[] {
  const params = ListParamsSchema.parse(rawParams ?? {});
  const db = getDb();
  const query = db.select().from(projects);
  if (params.includeDeleted) {
    return query.all();
  }
  return query.where(isNull(projects.deletedAt)).all();
}

const GetParamsSchema = z.object({
  id: z.string(),
});

export function get(rawParams: unknown): Project | null {
  const params = GetParamsSchema.parse(rawParams);
  const db = getDb();
  const [row] = db.select().from(projects).where(eq(projects.id, params.id)).all();
  return row ?? null;
}

const SetStatusParamsSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["interviewing", "ready", "building", "paused", "done"]),
  // Optional: only mutated when the caller passes them (so a "pause"
  // call after the turn finishes can carry the latest session id, but a
  // pure status flip doesn't blank a previous one by accident).
  currentSessionId: z.string().nullable().optional(),
  currentPhase: z.enum(["A", "B", "C", "D", "E"]).nullable().optional(),
});

/**
 * Mutate the project's lifecycle state. Used by Flow H (pause/resume/stop)
 * and by the orchestrator to record the claude session id between turns
 * so resume works (--resume <id>).
 */
export function setStatus(rawParams: unknown): Project {
  const params = SetStatusParamsSchema.parse(rawParams);
  const db = getDb();
  const now = Date.now();

  const patch: Partial<typeof projects.$inferInsert> = {
    status: params.status,
    updatedAt: now,
  };
  if (params.currentSessionId !== undefined) {
    patch.currentSessionId = params.currentSessionId;
  }
  if (params.currentPhase !== undefined) {
    patch.currentPhase = params.currentPhase;
  }

  const [updated] = db
    .update(projects)
    .set(patch)
    .where(eq(projects.id, params.id))
    .returning()
    .all();

  if (!updated) throw new Error(`projects.setStatus: no project with id '${params.id}'`);
  return updated;
}
