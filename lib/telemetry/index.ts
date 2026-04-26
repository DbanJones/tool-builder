// Sentry consent capture per rules/06-other.md O7 + spec.md §6 + §8 open
// question (default answer: separate one-time prompt after first successful
// build, clear "no thanks" option).
//
// E5 ships the decision persistence + a no-op `reportError` shim. The
// actual @sentry/* SDK integration lands in a follow-up (drift D-019); when
// it does, just swap the shim's body to call `Sentry.captureException` and
// gate the SDK initialisation on `getSentryDecision() === "accepted"`.

const STORAGE_KEY = "builder.sentryDecision";

export type SentryDecision = "accepted" | "declined" | "deferred";

export function getSentryDecision(
  storage: Pick<Storage, "getItem"> = typeof window !== "undefined" ? window.localStorage : null!,
): SentryDecision | null {
  if (!storage) return null;
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === "accepted" || raw === "declined" || raw === "deferred") return raw;
  return null;
}

export function setSentryDecision(
  decision: SentryDecision,
  storage: Pick<Storage, "setItem"> = typeof window !== "undefined" ? window.localStorage : null!,
): void {
  if (!storage) return;
  storage.setItem(STORAGE_KEY, decision);
}

/**
 * Report an error to telemetry. No-op until the SDK lands (drift D-019).
 * Always honours the consent decision: a missing or "declined" decision
 * means we never call into the SDK, so no PII can leak.
 */
export function reportError(
  error: unknown,
  storage: Pick<Storage, "getItem"> = typeof window !== "undefined" ? window.localStorage : null!,
): void {
  const decision = getSentryDecision(storage);
  if (decision !== "accepted") return;
  // SDK call lands here in D-019. For now: no-op.
  // Sentry.captureException(error, { extra: scrubExtra(error) });
  void error;
}

/**
 * Convenience: did the novice make any decision yet (vs. "haven't asked")?
 * Used by the dashboard to know whether to show the prompt.
 */
export function hasMadeSentryDecision(
  storage: Pick<Storage, "getItem"> = typeof window !== "undefined" ? window.localStorage : null!,
): boolean {
  return getSentryDecision(storage) !== null;
}
