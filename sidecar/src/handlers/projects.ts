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
