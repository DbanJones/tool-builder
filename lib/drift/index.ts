import { invoke } from "@tauri-apps/api/core";
import { errAsync, ResultAsync } from "neverthrow";

import { sidecarCall, type SidecarError } from "@/lib/sidecar/client";

// Mirrors sidecar/src/schema/drift-events.ts. The dashboard banner reads
// these and dispatches a resolution back through both the sidecar (DB
// update) and a Tauri command (markdown line in the novice's drift-log).
export type DriftKind = "implementation" | "scope" | "silent_assumption" | "nfr";
export type DriftResolution = "revert" | "amend_spec" | "accept";

export interface DriftEvent {
  id: string;
  projectId: string;
  phase: string;
  kind: DriftKind;
  description: string;
  resolution: DriftResolution | null;
  commitHash: string | null;
  occurredAt: number;
  resolvedAt: number | null;
}

export type DriftError =
  | { kind: "Sidecar"; message: string }
  | { kind: "Filesystem"; message: string };

const fromSidecarError = (e: SidecarError): DriftError => ({
  kind: "Sidecar",
  message: e.kind === "Sidecar" ? `${e.code}: ${e.message}` : e.message,
});

const fromInvokeError = (e: unknown): DriftError => ({
  kind: "Filesystem",
  message: e instanceof Error ? e.message : String(e),
});

export function listOpenDrifts(projectId: string): ResultAsync<DriftEvent[], DriftError> {
  return sidecarCall<DriftEvent[]>("drift.listOpen", { projectId }).mapErr(fromSidecarError);
}

export function appendDrift(params: {
  projectId: string;
  phase: string;
  kind: DriftKind;
  description: string;
}): ResultAsync<DriftEvent, DriftError> {
  return sidecarCall<DriftEvent>("drift.append", params).mapErr(fromSidecarError);
}

/**
 * Apply a novice-chosen resolution. Two side effects:
 *   1. Update the drift_events row (resolution + commit_hash + resolved_at).
 *   2. Append a markdown block to {project}/docs/drift-log.md so the audit
 *      trail lives outside the SQLite file too (per rules/07-self-check.md
 *      SC26).
 *
 * If (2) fails, (1) still landed; the log file is reconstructable from the
 * DB but not vice versa, so we prefer the DB update going through.
 */
export function resolveDrift(params: {
  event: DriftEvent;
  resolution: DriftResolution;
  commitHash?: string;
  projectPath: string;
}): ResultAsync<DriftEvent, DriftError> {
  return sidecarCall<DriftEvent>("drift.resolve", {
    id: params.event.id,
    resolution: params.resolution,
    commitHash: params.commitHash,
  })
    .mapErr(fromSidecarError)
    .andThen((updated) =>
      ResultAsync.fromPromise(
        invoke<string>("append_drift_log_line", {
          projectPath: params.projectPath,
          driftId: updated.id,
          kind: updated.kind,
          description: updated.description,
          resolution: params.resolution,
          commitHash: params.commitHash ?? null,
        }),
        fromInvokeError,
      )
        .map(() => updated)
        .orElse((e) => {
          // The DB update succeeded; surface the file-write failure as a
          // soft error the banner can show (the user can retry the file
          // write later; the resolution itself is recorded).
          return errAsync<DriftEvent, DriftError>(e);
        }),
    );
}
