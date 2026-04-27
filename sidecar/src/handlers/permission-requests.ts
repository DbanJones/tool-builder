import { and, asc, eq } from "drizzle-orm";
import { ulid } from "ulid";
import { z } from "zod";

import { getDb } from "../db.js";
import {
  permissionRequests,
  type PermissionRequest,
} from "../schema/permission-requests.js";

const AppendParamsSchema = z.object({
  projectId: z.string().min(1),
  toolName: z.string().min(1),
  inputSummary: z.string(),
});

/** MCP-server-side: insert a pending permission row, return the id. */
export function append(rawParams: unknown): PermissionRequest {
  const params = AppendParamsSchema.parse(rawParams);
  const db = getDb();
  const id = ulid();
  const [inserted] = db
    .insert(permissionRequests)
    .values({
      id,
      projectId: params.projectId,
      toolName: params.toolName,
      inputSummary: params.inputSummary,
      status: "pending",
      requestedAt: Date.now(),
    })
    .returning()
    .all();
  if (!inserted) throw new Error("insert returned no rows");
  return inserted;
}

const PollParamsSchema = z.object({ id: z.string().min(1) });

/** MCP-server-side: read the row by id (returns null if missing). */
export function poll(rawParams: unknown): PermissionRequest | null {
  const params = PollParamsSchema.parse(rawParams);
  const db = getDb();
  const [row] = db
    .select()
    .from(permissionRequests)
    .where(eq(permissionRequests.id, params.id))
    .all();
  return row ?? null;
}

const ResolveParamsSchema = z.object({
  id: z.string().min(1),
  decision: z.enum(["allowed", "denied", "expired"]),
  decisionMessage: z.string().nullable().optional(),
});

/** Dashboard-side: novice clicked Allow / Deny. Idempotent on repeats. */
export function resolve(rawParams: unknown): PermissionRequest {
  const params = ResolveParamsSchema.parse(rawParams);
  const db = getDb();
  const [updated] = db
    .update(permissionRequests)
    .set({
      status: params.decision,
      decisionMessage: params.decisionMessage ?? null,
      resolvedAt: Date.now(),
    })
    .where(eq(permissionRequests.id, params.id))
    .returning()
    .all();
  if (!updated) {
    // Defensive (per drift-banner D-019 lesson): silent no-op rather than
    // throwing, in case of double-click or already-expired row.
    return {
      id: params.id,
      projectId: "",
      toolName: "",
      inputSummary: "",
      status: params.decision,
      decisionMessage: params.decisionMessage ?? null,
      requestedAt: 0,
      resolvedAt: Date.now(),
    };
  }
  return updated;
}

const ListOpenParamsSchema = z.object({ projectId: z.string().min(1) });

/** Dashboard-side: poll for pending rows the banner should render. */
export function listOpen(rawParams: unknown): PermissionRequest[] {
  const params = ListOpenParamsSchema.parse(rawParams);
  const db = getDb();
  return db
    .select()
    .from(permissionRequests)
    .where(
      and(
        eq(permissionRequests.projectId, params.projectId),
        eq(permissionRequests.status, "pending"),
      ),
    )
    .orderBy(asc(permissionRequests.requestedAt))
    .all();
}
