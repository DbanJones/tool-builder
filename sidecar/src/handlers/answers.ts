import { and, desc, eq } from "drizzle-orm";
import { ulid } from "ulid";
import { z } from "zod";

import { getDb } from "../db.js";
import { QUESTION_IDS } from "../interview-question-ids.js";
import { answers, type Answer } from "../schema/answers.js";
import { auditLog } from "../schema/audit-log.js";

const RecordParamsSchema = z.object({
  projectId: z.string().min(1),
  questionId: z.enum(QUESTION_IDS),
  answerText: z.string().min(1),
  confidence: z.enum(["confident", "tentative", "default-applied"]).default("tentative"),
  source: z.enum(["chat", "file", "default"]).default("chat"),
  rationale: z.string().nullable().optional(),
});

/**
 * Record an answer for a question on a project. Returns the inserted row.
 * Both the main sidecar (via JSON-RPC method `answers.record`) and the MCP
 * server (via the `record_answer` tool) call into this same function.
 *
 * Per Flow C AC6, every recorded answer also writes a paired `answer_recorded`
 * audit row in the same transaction (so the two never disagree).
 */
export function record(rawParams: unknown): Answer {
  const params = RecordParamsSchema.parse(rawParams);
  const db = getDb();
  const id = ulid();
  const now = Date.now();

  return db.transaction((tx) => {
    const [inserted] = tx
      .insert(answers)
      .values({
        id,
        projectId: params.projectId,
        questionId: params.questionId,
        answerText: params.answerText,
        confidence: params.confidence,
        source: params.source,
        rationale: params.rationale ?? null,
        createdAt: now,
      })
      .returning()
      .all();

    if (!inserted) {
      throw new Error("insert returned no rows");
    }

    tx.insert(auditLog)
      .values({
        id: ulid(),
        action: "answer_recorded",
        targetId: inserted.id,
        payload: JSON.stringify({
          projectId: inserted.projectId,
          questionId: inserted.questionId,
          confidence: inserted.confidence,
          source: inserted.source,
        }),
        createdAt: now,
      })
      .run();

    return inserted;
  });
}

const ListParamsSchema = z.object({
  projectId: z.string().min(1),
  questionId: z.string().min(1).optional(),
});

/**
 * List answers for a project, optionally filtered by question id.
 * Sorted newest-first so the "current" answer for a given question is index 0.
 */
export function list(rawParams: unknown): Answer[] {
  const params = ListParamsSchema.parse(rawParams);
  const db = getDb();
  const where = params.questionId
    ? and(eq(answers.projectId, params.projectId), eq(answers.questionId, params.questionId))
    : eq(answers.projectId, params.projectId);
  return db.select().from(answers).where(where).orderBy(desc(answers.createdAt)).all();
}
