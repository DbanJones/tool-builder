import { invoke } from "@tauri-apps/api/core";
import { ResultAsync } from "neverthrow";

// Wire-format types matching sidecar/src/index.ts.
//
// Every request to the sidecar produces exactly one response of one of
// these two shapes. The Rust shell parses the response and forwards it
// to us verbatim; we narrow on `ok` here to convert into Result form.

interface SidecarSuccess<T> {
  id: string;
  ok: true;
  result: T;
}

interface SidecarFailure {
  id: string;
  ok: false;
  error: { code: string; message: string };
}

type SidecarEnvelope<T> = SidecarSuccess<T> | SidecarFailure;

export type SidecarError =
  | { kind: "Transport"; message: string }
  | { kind: "Sidecar"; code: string; message: string };

const isEnvelope = (v: unknown): v is SidecarEnvelope<unknown> => {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return typeof obj.id === "string" && typeof obj.ok === "boolean";
};

const fromInvokeError = (e: unknown): SidecarError => ({
  kind: "Transport",
  message: e instanceof Error ? e.message : String(e),
});

/**
 * Call a sidecar method over JSON-RPC via the `sidecar_rpc` Tauri command.
 *
 * Returns `ResultAsync<T, SidecarError>` where the OK branch is the parsed
 * `result` and the Err branch distinguishes Transport (Tauri/IPC layer) from
 * Sidecar (the sidecar handler returned a typed error).
 *
 * Per ADR-0004. `T` is asserted by the caller; it is the sidecar handler's
 * responsibility to return the documented shape, and it is the caller's
 * responsibility to keep its expectation in sync. Once Drizzle types land at
 * A4b, this function will get typed wrappers per method.
 */
export const sidecarCall = <T>(
  method: string,
  params: Record<string, unknown> = {},
): ResultAsync<T, SidecarError> =>
  ResultAsync.fromPromise(
    invoke<unknown>("sidecar_rpc", { method, params }),
    fromInvokeError,
  ).andThen((raw) => {
    if (!isEnvelope(raw)) {
      return ResultAsync.fromSafePromise(
        Promise.resolve(raw),
      ).andThen<T, SidecarError>(() =>
        ResultAsync.fromPromise(
          Promise.reject(new Error("malformed sidecar response")),
          (e) => ({ kind: "Transport", message: (e as Error).message }) as SidecarError,
        ),
      );
    }
    if (raw.ok) {
      return ResultAsync.fromSafePromise(Promise.resolve(raw.result as T));
    }
    return ResultAsync.fromPromise(
      Promise.reject(raw.error),
      (): SidecarError => ({
        kind: "Sidecar",
        code: raw.error.code,
        message: raw.error.message,
      }),
    );
  });

// Typed convenience wrappers. A4a ships ping only; A4b adds the real ones.

export interface PingResult {
  pong: true;
  version: string;
  at: string;
}

export const ping = (): ResultAsync<PingResult, SidecarError> =>
  sidecarCall<PingResult>("ping");
