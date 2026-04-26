import { check, type Update } from "@tauri-apps/plugin-updater";
import { errAsync, ResultAsync } from "neverthrow";

// Tauri updater wrapper per spec.md Flow J + build-order.md E3.
// Phase E0 (signing/updater procurement) is deferred per human direction
// 2026-04-25; until E0 lands, the placeholder pubkey in tauri.conf.json
// will cause `check()` to fail with a verification error. The wrapper
// distinguishes that case from "no update available" so the launch flow
// stays quiet rather than nagging the novice.

export interface AvailableUpdate {
  version: string;
  currentVersion: string;
  body?: string;
}

export type UpdaterError =
  | { kind: "Network"; message: string }
  | { kind: "NotConfigured"; message: string }
  | { kind: "Unknown"; message: string };

const PLACEHOLDER_PUBKEY_HINT = "REPLACE_WITH_TAURI_SIGNER_PUBKEY";

const fromCheckError = (e: unknown): UpdaterError => {
  const message = e instanceof Error ? e.message : String(e);
  if (message.includes(PLACEHOLDER_PUBKEY_HINT) || message.toLowerCase().includes("public key")) {
    return {
      kind: "NotConfigured",
      message: "Updater is not provisioned yet (Phase E0 deferred). See drift D-017.",
    };
  }
  if (message.toLowerCase().includes("network") || message.toLowerCase().includes("failed to fetch")) {
    return { kind: "Network", message };
  }
  return { kind: "Unknown", message };
};

/**
 * Probe the configured updater feed. Returns Ok(null) when the app is on
 * the latest version, Ok(AvailableUpdate) when there's something newer,
 * Err(UpdaterError) on transport / config / signature problems.
 */
export function checkForUpdate(): ResultAsync<AvailableUpdate | null, UpdaterError> {
  return ResultAsync.fromPromise(check(), fromCheckError).map((update) => {
    if (!update) return null;
    const out: AvailableUpdate = {
      version: update.version,
      currentVersion: update.currentVersion,
    };
    // exactOptionalPropertyTypes forbids `body: undefined`; only include
    // when present.
    if (update.body) out.body = update.body;
    return out;
  });
}

/**
 * Two-step install per Flow J AC3:
 *   1. download() pulls the signed artifact and verifies the signature
 *      against the pubkey in tauri.conf.json.
 *   2. install() unpacks + restarts the app.
 *
 * The plugin exposes `downloadAndInstall()` as one call; we use it.
 * Resolves never returns on success — the app process restarts.
 */
export function downloadAndInstall(): ResultAsync<void, UpdaterError> {
  return ResultAsync.fromPromise(
    (async () => {
      const update = await check();
      if (!update) {
        throw new Error("downloadAndInstall called but no update is available");
      }
      await update.downloadAndInstall();
    })(),
    fromCheckError,
  );
}

/** Re-export for tests / advanced callers that want to compose differently. */
export type { Update };

/** Helper for the launch flow: check, but swallow NotConfigured silently
 *  so the app doesn't show a banner when E0 hasn't shipped yet. */
export function checkForUpdateQuiet(): ResultAsync<AvailableUpdate | null, UpdaterError> {
  return checkForUpdate().orElse((err) => {
    if (err.kind === "NotConfigured") {
      return ResultAsync.fromSafePromise(Promise.resolve(null));
    }
    return errAsync(err);
  });
}
