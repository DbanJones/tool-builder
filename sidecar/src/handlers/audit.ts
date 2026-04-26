import { desc } from "drizzle-orm";
import { ulid } from "ulid";
import { z } from "zod";

import { getDb } from "../db.js";
import { auditLog, type AuditLogEntry } from "../schema/audit-log.js";

const LogEventParamsSchema = z.object({
  eventType: z.string().min(1),
  // payload is already a JSON-stringified blob from the caller (matches the
  // shape lib/audit/index.ts has used since A3).
  payload: z.string().default("{}"),
  targetId: z.string().nullable().optional(),
  actorId: z.string().optional(),
});

export function logEvent(rawParams: unknown): { id: string } {
  const params = LogEventParamsSchema.parse(rawParams);
  const id = ulid();
  const db = getDb();
  db.insert(auditLog)
    .values({
      id,
      action: params.eventType,
      payload: params.payload,
      targetId: params.targetId ?? null,
      actorId: params.actorId ?? "novice",
      createdAt: Date.now(),
    })
    .run();
  return { id };
}

const ListEventsParamsSchema = z.object({
  limit: z.number().int().positive().max(500).default(100),
});

export function listEvents(rawParams: unknown): AuditLogEntry[] {
  const params = ListEventsParamsSchema.parse(rawParams ?? {});
  const db = getDb();
  return db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(params.limit).all();
}
