import { invoke } from "@tauri-apps/api/core";
import { ResultAsync } from "neverthrow";

// Webview wrapper for the Rust target-app launcher (CLAUDE.md O33). The
// Rust side spawns `npm run dev` in the project folder, watches stdout
// for the first localhost URL, opens it in the user's browser, and keeps
// the process alive until target_app_stop is called.
//
// `url` is the iframe-facing URL — typically the preview proxy (ADR-0014)
// which sits in front of the dev server and injects the bridge script.
// `upstreamUrl` is the raw dev URL; mostly for diagnostics.

export interface LaunchInfo {
  /** Iframe-facing URL. Proxy when up, raw upstream as a fallback. */
  url: string;
  /** Raw dev server URL (e.g. http://localhost:3000), pre-proxy. */
  upstreamUrl: string;
  /** OS process id, useful for the live tail / debug surfaces. */
  pid: number;
}

export type LaunchError = { kind: "Transport"; message: string };

const fromInvokeError = (e: unknown): LaunchError => ({
  kind: "Transport",
  message: e instanceof Error ? e.message : String(e),
});

export function targetAppLaunch(
  projectPath: string,
  options: { openBrowser?: boolean } = {},
): ResultAsync<LaunchInfo, LaunchError> {
  return ResultAsync.fromPromise(
    invoke<LaunchInfo>("target_app_launch", {
      projectPath,
      openBrowser: options.openBrowser ?? true,
    }),
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
