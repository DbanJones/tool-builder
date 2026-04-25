import { invoke } from "@tauri-apps/api/core";
import { okAsync, ResultAsync } from "neverthrow";

export type CliState = "missing" | "unauthenticated" | "ready";

export type DetectionError = { kind: "Backend"; message: string };

const fromInvokeError = (e: unknown): DetectionError => ({
  kind: "Backend",
  message: e instanceof Error ? e.message : String(e),
});

const isInstalled = (): ResultAsync<boolean, DetectionError> =>
  ResultAsync.fromPromise(invoke<boolean>("cli_is_installed"), fromInvokeError);

const isAuthenticated = (): ResultAsync<boolean, DetectionError> =>
  ResultAsync.fromPromise(invoke<boolean>("cli_is_authenticated"), fromInvokeError);

/**
 * Probes whether the `claude` CLI is installed and authenticated.
 * Per ADR-0002 the Builder holds no credential of its own; this detection
 * is the gate that decides whether the Welcome screen can advance.
 */
export const detectCli = (): ResultAsync<CliState, DetectionError> =>
  isInstalled().andThen((installed) => {
    if (!installed) return okAsync<CliState, DetectionError>("missing");
    return isAuthenticated().map<CliState>((authed) =>
      authed ? "ready" : "unauthenticated",
    );
  });
