import { invoke } from "@tauri-apps/api/core";
import { errAsync, ResultAsync } from "neverthrow";

import { sidecarCall, type SidecarError } from "@/lib/sidecar/client";

import { keychainGet, keychainSet, type KeychainError } from "@/lib/keychain";

// Vercel deploy flow per spec.md Flow I AC1-AC6 + build-order.md E1.
// The Vercel access token lives in the OS keychain (per ADR-0003) under
// service `com.airtec.builder.vercel`, account `default`.

const VERCEL_KEYCHAIN_NAMESPACE = "vercel";
const VERCEL_KEYCHAIN_ACCOUNT = "default";

export interface DeployResult {
  previewUrl: string;
}

export type DeployError =
  | { kind: "NotInstalled"; message: string }
  | { kind: "MissingToken"; message: string }
  | { kind: "Keychain"; message: string }
  | { kind: "Audit"; message: string }
  | { kind: "Vercel"; message: string };

const fromInvokeError =
  (kind: "NotInstalled" | "Vercel") =>
  (e: unknown): DeployError => ({
    kind,
    message: e instanceof Error ? e.message : String(e),
  });

const fromKeychainError = (e: KeychainError): DeployError => ({
  kind: "Keychain",
  message: e.kind === "Backend" ? `${e.service}/${e.account}: ${e.message}` : e.message,
});

const fromSidecarError = (e: SidecarError): DeployError => ({
  kind: "Audit",
  message: e.kind === "Sidecar" ? `${e.code}: ${e.message}` : e.message,
});

/** Probe `vercel --version`. Returns Ok(false) when not on PATH. */
export function isVercelInstalled(): ResultAsync<boolean, DeployError> {
  return ResultAsync.fromPromise(
    invoke<boolean>("vercel_is_installed"),
    fromInvokeError("NotInstalled"),
  );
}

/** Read the Vercel token from the OS keychain. Returns Ok(null) when absent. */
export function getVercelToken(): ResultAsync<string | null, DeployError> {
  return keychainGet(VERCEL_KEYCHAIN_NAMESPACE, VERCEL_KEYCHAIN_ACCOUNT).mapErr(fromKeychainError);
}

/** Persist the Vercel token to the OS keychain. */
export function setVercelToken(token: string): ResultAsync<void, DeployError> {
  return keychainSet(VERCEL_KEYCHAIN_NAMESPACE, VERCEL_KEYCHAIN_ACCOUNT, token).mapErr(
    fromKeychainError,
  );
}

interface DeployOptions {
  projectPath: string;
  projectId: string;
}

/**
 * Run the full deploy flow:
 *   1. Read Vercel token from keychain. Caller must call setVercelToken
 *      first if absent (Flow I AC1's modal handles this).
 *   2. Spawn `vercel deploy --yes` in the project folder.
 *   3. Capture the preview URL and write a `deployed_preview` audit row.
 *
 * Returns the preview URL on success. Caller is responsible for the
 * clipboard write + display (Flow I AC5) since clipboard access lives
 * in the webview API surface.
 */
export function deployToVercel(options: DeployOptions): ResultAsync<DeployResult, DeployError> {
  return getVercelToken().andThen((token) => {
    if (!token) {
      return errAsync<DeployResult, DeployError>({
        kind: "MissingToken",
        message: "No Vercel token in the keychain. Set one before deploying.",
      });
    }
    return ResultAsync.fromPromise(
      invoke<DeployResult>("vercel_deploy", {
        projectPath: options.projectPath,
        vercelToken: token,
      }),
      fromInvokeError("Vercel"),
    ).andThen((result) =>
      // Audit per Flow I AC6. We don't fail the deploy if the audit insert
      // fails — the URL is the load-bearing thing; missing one audit row is
      // recoverable.
      sidecarCall("audit.logEvent", {
        action: "deployed_preview",
        targetId: options.projectId,
        payload: JSON.stringify({ previewUrl: result.previewUrl }),
      })
        .map(() => result)
        .mapErr(fromSidecarError)
        .orElse(() => ResultAsync.fromSafePromise(Promise.resolve(result))),
    );
  });
}
