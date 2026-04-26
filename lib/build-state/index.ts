import { invoke } from "@tauri-apps/api/core";
import { errAsync, ResultAsync } from "neverthrow";
import { z } from "zod";

// The build dashboard reads two artefacts written by the orchestrator and
// owned by the novice's project:
//   - {project}/.builder/state.json   (target-app build state; phase + tasks)
//   - {project}/.builder/history.log  (one JSON line per tool call)
//
// Both readers route through Tauri commands that path-sandbox to the project
// folder (binding rule 5). We Zod-validate at this trust boundary; the
// dashboard renders the inferred type only.

const HistoryActionEntrySchema = z.object({
  id: z.string(),
  ts: z.number().int(),
  tool: z.string(),
  rawInput: z.string(),
  humanLine: z.string().nullable(),
  phase: z.string().nullable(),
  taskId: z.string().nullable(),
});

export type HistoryActionEntry = z.infer<typeof HistoryActionEntrySchema>;

// Forward-compatible: any field the dashboard does not render is accepted as
// `unknown` rather than rejected, so a richer state.json (e.g. produced by
// the orchestrator at a later phase) never breaks the reader.
const TargetStateSchema = z
  .object({
    schema_version: z.number().int().optional(),
    phase: z.string().nullable().optional(),
    next_task: z.string().nullable().optional(),
    current_task: z.string().nullable().optional(),
    tasks_completed_in_phase: z.number().int().optional(),
    tasks_total_in_phase: z.number().int().optional(),
    status: z.string().optional(),
    history: z
      .array(
        z.object({
          task_id: z.string(),
          completed_at: z.string().optional(),
          commit: z.string().optional(),
          notes: z.string().optional(),
        }),
      )
      .optional(),
    open_questions: z.array(z.unknown()).optional(),
  })
  .passthrough();

export type TargetState = z.infer<typeof TargetStateSchema>;

export type BuildStateError =
  | { kind: "Filesystem"; message: string }
  | { kind: "Parse"; message: string };

const fromInvokeError = (e: unknown): BuildStateError => ({
  kind: "Filesystem",
  message: e instanceof Error ? e.message : String(e),
});

/**
 * Read `{project}/.builder/state.json`. Returns `null` when the file does
 * not exist (a freshly-created project has no orchestrator state yet); the
 * dashboard renders a "(no phase yet)" placeholder for that case.
 */
export function readTargetState(
  projectPath: string,
): ResultAsync<TargetState | null, BuildStateError> {
  return ResultAsync.fromPromise(
    invoke<string | null>("read_target_state", { projectPath }),
    fromInvokeError,
  ).andThen((raw) => {
    if (raw === null) return ResultAsync.fromSafePromise(Promise.resolve(null));
    try {
      const parsed: unknown = JSON.parse(raw);
      const validated = TargetStateSchema.parse(parsed);
      return ResultAsync.fromSafePromise(Promise.resolve(validated));
    } catch (e) {
      return errAsync<TargetState | null, BuildStateError>({
        kind: "Parse",
        message: `state.json: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  });
}

/**
 * Read up to `limit` most recent JSON lines from
 * `{project}/.builder/history.log`. Lines that fail Zod validation are
 * dropped silently (log file is append-only and may have a partial last
 * line if the orchestrator crashed mid-write); a malformed line should
 * not blank the entire live tail.
 */
export function readHistoryLogTail(
  projectPath: string,
  limit: number,
): ResultAsync<HistoryActionEntry[], BuildStateError> {
  return ResultAsync.fromPromise(
    invoke<string[]>("read_history_log_tail", { projectPath, limit }),
    fromInvokeError,
  ).map((lines) => {
    const out: HistoryActionEntry[] = [];
    for (const line of lines) {
      try {
        const parsed: unknown = JSON.parse(line);
        out.push(HistoryActionEntrySchema.parse(parsed));
      } catch {
        // Skip malformed lines. The orchestrator's stderr will surface the
        // root cause separately.
      }
    }
    return out;
  });
}
