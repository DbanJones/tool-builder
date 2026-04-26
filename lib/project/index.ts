import { invoke } from "@tauri-apps/api/core";
import { errAsync, ResultAsync } from "neverthrow";

import { sidecarCall, type SidecarError } from "@/lib/sidecar/client";

export interface Project {
  id: string;
  name: string;
  path: string;
  status: "interviewing" | "ready" | "building" | "paused" | "done";
  currentPhase: "A" | "B" | "C" | "D" | "E" | null;
  currentSessionId: string | null;
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

const MAX_NAME_LEN = 100;

/**
 * Sanitise a freeform project name into a filesystem-safe folder name.
 * Mirrors the Rust function `sanitise_project_name` in src-tauri/src/lib.rs.
 *
 * Rules (designed to be friendly to novices):
 * - Lowercase
 * - Runs of whitespace collapse to a single hyphen
 * - Strip anything that isn't [a-z0-9._-]
 * - Collapse runs of hyphens
 * - Trim leading/trailing dots, hyphens, underscores
 * - Cap at 100 chars
 *
 * Returns null if the result would be empty (e.g. caller typed only emoji
 * or punctuation).
 */
export function sanitiseProjectName(raw: string): string | null {
  let s = raw.toLowerCase();
  s = s.replace(/\s+/g, "-");
  s = s.replace(/[^a-z0-9._-]+/g, "");
  s = s.replace(/-+/g, "-");
  s = s.replace(/^[._-]+|[._-]+$/g, "");
  if (s.length > MAX_NAME_LEN) s = s.slice(0, MAX_NAME_LEN).replace(/[._-]+$/, "");
  return s.length === 0 ? null : s;
}

export function validateProjectName(name: string): ProjectError | null {
  if (!name || name.trim().length === 0) {
    return { kind: "InvalidName", message: "Project name is required" };
  }
  if (name.length > 200) {
    return {
      kind: "InvalidName",
      message: "Project name is too long (200 characters max)",
    };
  }
  if (sanitiseProjectName(name) === null) {
    return {
      kind: "InvalidName",
      message:
        "Project name needs at least one letter or digit (after stripping punctuation/emoji).",
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
 * (mkdir + git init + write placeholder templates) and uses a sanitised
 * folder name; the sidecar inserts the `projects` row + `project_created`
 * audit row in one transaction storing the **raw** name (so display in the
 * UI matches what the user typed) alongside the sanitised folder path.
 *
 * Partial failure window: if the FS step succeeds but the DB step fails, the
 * folder exists on disk without a matching DB row. For the A4c MVP this is
 * surfaced to the caller and not rolled back; manual cleanup required.
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
