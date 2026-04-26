import { invoke } from "@tauri-apps/api/core";
import { errAsync, ResultAsync } from "neverthrow";

import { sidecarCall, type SidecarError } from "@/lib/sidecar/client";

export interface Project {
  id: string;
  name: string;
  path: string;
  status: "interviewing" | "ready" | "building" | "paused" | "done";
  currentPhase: "A" | "B" | "C" | "D" | "E" | null;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
  deletedAt: number | null;
}

export type ProjectError =
  | { kind: "InvalidName"; message: string }
  | { kind: "InvalidFolder"; message: string }
  | { kind: "Filesystem"; message: string }
  | { kind: "Db"; message: string };

// Mirrors the Rust validator at src-tauri/src/lib.rs is_valid_project_name.
// Pre-flight here so we can render an inline error before the round-trip.
export const PROJECT_NAME_REGEX = /^[a-z0-9][a-z0-9._-]{0,213}$/;

export function validateProjectName(name: string): ProjectError | null {
  if (!name) {
    return { kind: "InvalidName", message: "Project name is required" };
  }
  if (name.length > 214) {
    return { kind: "InvalidName", message: "Project name must be 214 characters or fewer" };
  }
  if (!PROJECT_NAME_REGEX.test(name)) {
    return {
      kind: "InvalidName",
      message:
        "Project name must start with a lowercase letter or digit and contain only lowercase letters, digits, dots, hyphens, and underscores",
    };
  }
  return null;
}

const fromInvokeError = (e: unknown): ProjectError => ({
  kind: "Filesystem",
  message: e instanceof Error ? e.message : String(e),
});

const fromSidecarError = (e: SidecarError): ProjectError => ({
  kind: "Db",
  message: e.kind === "Sidecar" ? `${e.code}: ${e.message}` : e.message,
});

/**
 * Two-stage project creation. The Tauri shell does the file-system work
 * (mkdir + git init + write placeholder templates); the sidecar inserts the
 * `projects` row plus a `project_created` audit row in one transaction.
 *
 * Partial failure window: if the FS step succeeds but the DB step fails, the
 * folder exists on disk without a matching DB row. For the A4c MVP this is
 * surfaced to the caller and not rolled back; manual cleanup is required.
 * A future task can wrap both halves in a Tauri command that calls the sidecar
 * internally and rolls back the FS work on DB failure.
 */
export function createProject(name: string, folder: string): ResultAsync<Project, ProjectError> {
  const validationError = validateProjectName(name);
  if (validationError) {
    return errAsync(validationError);
  }
  if (!folder || folder.trim().length === 0) {
    return errAsync<Project, ProjectError>({
      kind: "InvalidFolder",
      message: "Folder is required",
    });
  }

  const fsResult = ResultAsync.fromPromise(
    invoke<string>("project_create_folder", { name, folder }),
    fromInvokeError,
  );

  return fsResult.andThen((fullPath) =>
    sidecarCall<Project>("projects.create", { name, path: fullPath }).mapErr(fromSidecarError),
  );
}
