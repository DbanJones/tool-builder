import { invoke } from "@tauri-apps/api/core";
import { ResultAsync } from "neverthrow";

import { sidecarCall, type SidecarError } from "@/lib/sidecar/client";

// GitHub export per spec.md Flow I AC8 + build-order.md E2.
// Auth is handled entirely by the local `gh` CLI (`gh auth login` from a
// terminal); the Builder never sees or stores a GitHub token.

export interface ExportResult {
  repoUrl: string;
}

export type ExportError =
  | { kind: "NotInstalled"; message: string }
  | { kind: "InvalidName"; message: string }
  | { kind: "Audit"; message: string }
  | { kind: "Github"; message: string };

const fromInvokeError =
  (kind: "NotInstalled" | "Github") =>
  (e: unknown): ExportError => ({
    kind,
    message: e instanceof Error ? e.message : String(e),
  });

const fromSidecarError = (e: SidecarError): ExportError => ({
  kind: "Audit",
  message: e.kind === "Sidecar" ? `${e.code}: ${e.message}` : e.message,
});

/** Probe `gh --version`. Returns Ok(false) when not on PATH. */
export function isGhInstalled(): ResultAsync<boolean, ExportError> {
  return ResultAsync.fromPromise(invoke<boolean>("gh_is_installed"), fromInvokeError("NotInstalled"));
}

/**
 * Sanitise a freeform name into a GitHub-safe repo name. Mirrors the Rust
 * validation in src-tauri/src/export.rs gh_export so we fail in the
 * webview rather than after a CLI round-trip when possible.
 */
export function sanitiseRepoName(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "")
    .slice(0, 100)
    .replace(/^[._-]+|[._-]+$/g, "");
}

interface ExportOptions {
  projectPath: string;
  projectId: string;
  repoName: string;
}

/**
 * Run `gh repo create --private --source=. --remote=origin --push` in the
 * project folder. Writes a `pushed_to_github` audit row on success
 * (Flow I AC6 pattern). Audit insert failure does not fail the export.
 */
export function exportToGithub(options: ExportOptions): ResultAsync<ExportResult, ExportError> {
  const cleaned = sanitiseRepoName(options.repoName);
  if (!cleaned) {
    return ResultAsync.fromPromise(
      Promise.reject(new Error("Repo name must contain at least one letter or digit.")),
      () => ({
        kind: "InvalidName" as const,
        message: "Repo name must contain at least one letter or digit.",
      }),
    );
  }
  return ResultAsync.fromPromise(
    invoke<ExportResult>("gh_export", {
      projectPath: options.projectPath,
      repoName: cleaned,
    }),
    fromInvokeError("Github"),
  ).andThen((result) =>
    sidecarCall("audit.logEvent", {
      action: "pushed_to_github",
      targetId: options.projectId,
      payload: JSON.stringify({ repoUrl: result.repoUrl }),
    })
      .map(() => result)
      .mapErr(fromSidecarError)
      .orElse(() => ResultAsync.fromSafePromise(Promise.resolve(result))),
  );
}
