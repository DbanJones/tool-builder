import { invoke } from "@tauri-apps/api/core";
import { ResultAsync } from "neverthrow";

// Namespaced service prefix so all Builder secrets share a top-level identifier
// in the OS keychain. Per ADR-0003.
const SERVICE_PREFIX = "com.airtec.builder";

const buildService = (namespace: string): string => `${SERVICE_PREFIX}.${namespace}`;

export type KeychainError =
  | { kind: "Backend"; service: string; account: string; message: string }
  | { kind: "Unknown"; message: string };

const fromInvokeError = (
  e: unknown,
  ctx: { service: string; account: string },
): KeychainError => {
  const message = e instanceof Error ? e.message : String(e);
  return { kind: "Backend", service: ctx.service, account: ctx.account, message };
};

/**
 * Read a secret. Resolves to ok(secret) if present, ok(null) if not present,
 * err(KeychainError) on backend failure.
 */
export const keychainGet = (
  namespace: string,
  account: string,
): ResultAsync<string | null, KeychainError> => {
  const service = buildService(namespace);
  return ResultAsync.fromPromise(
    invoke<string | null>("keychain_get", { service, account }),
    (e) => fromInvokeError(e, { service, account }),
  );
};

/**
 * Write or overwrite a secret.
 */
export const keychainSet = (
  namespace: string,
  account: string,
  secret: string,
): ResultAsync<void, KeychainError> => {
  const service = buildService(namespace);
  return ResultAsync.fromPromise(
    invoke<void>("keychain_set", { service, account, secret }),
    (e) => fromInvokeError(e, { service, account }),
  );
};

/**
 * Delete a secret. Idempotent: succeeds even if the entry was already absent.
 */
export const keychainDelete = (
  namespace: string,
  account: string,
): ResultAsync<void, KeychainError> => {
  const service = buildService(namespace);
  return ResultAsync.fromPromise(
    invoke<void>("keychain_delete", { service, account }),
    (e) => fromInvokeError(e, { service, account }),
  );
};
