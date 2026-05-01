import { invoke } from "@tauri-apps/api/core";
import { ResultAsync } from "neverthrow";

// Webview wrapper for the Rust target-app launcher (CLAUDE.md O33). The
// Rust side spawns `npm run dev` in the project folder, watches stdout
// for the first localhost URL, opens it in the user's browser, and keeps
// the process alive until target_app_stop is called.

export interface LaunchInfo {
  /** The localhost URL the dev server printed first (e.g. http://localhost:3000). */
  url: string;
  /** OS process id, useful for the live tail / debug surfaces. */
  pid: number;
}

export type LaunchError = { kind: "Transport"; message: string };

const fromInvokeError = (e: unknown): LaunchError => ({
  kind: "Transport",
  message: e instanceof Error ? e.message : String(e),
});

export function targetAppLaunch(projectPath: string): ResultAsync<LaunchInfo, LaunchError> {
  return ResultAsync.fromPromise(
    invoke<LaunchInfo>("target_app_launch", { projectPath }),
    fromInvokeError,
  );
}

export function targetAppStop(): ResultAsync<void, LaunchError> {
  return ResultAsync.fromPromise(
    invoke<void>("target_app_stop"),
    fromInvokeError,
  );
}

export function targetAppWriteLaunchScripts(
  projectPath: string,
): ResultAsync<readonly string[], LaunchError> {
  return ResultAsync.fromPromise(
    invoke<string[]>("target_app_write_launch_scripts", { projectPath }),
    fromInvokeError,
  );
}
