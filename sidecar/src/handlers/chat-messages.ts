import { asc, eq } from "drizzle-orm";
import { ulid } from "ulid";
import { z } from "zod";

import { getDb } from "../db.js";
import { chatMessages, type ChatMessage } from "../schema/chat-messages.js";

const AppendParamsSchema = z.object({
  projectId: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  text: z.string().min(1),
  createdAt: z.number().int().optional(),
});

/** Append one chat-message row. The interview page calls this on send and
 *  on each turn-end (with the concatenated assistant deltas). */
export function append(rawParams: unknown): ChatMessage {
  const params = AppendParamsSchema.parse(rawParams);
  const db = getDb();
  const id = ulid();
  const createdAt = params.createdAt ?? Date.now();

  const [inserted] = db
    .insert(chatMessages)
    .values({ id, projectId: params.projectId, role: params.role, text: params.text, createdAt })
    .returning()
    .all();

  if (!inserted) throw new Error("insert returned no rows");
  return inserted;
}

const ListParamsSchema = z.object({ projectId: z.string().min(1) });

/** All messages for a project, oldest-first (chronological for replay). */
export function list(rawParams: unknown): ChatMessage[] {
  const params = ListParamsSchema.parse(rawParams);
  const db = getDb();
  return db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.projectId, params.projectId))
    .orderBy(asc(chatMessages.createdAt))
    .all();
}
