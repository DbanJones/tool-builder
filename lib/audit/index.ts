import { sidecarCall } from "@/lib/sidecar/client";

// Once-per-process dedupe set so events flagged `once: true` (e.g. app_first_run)
// don't get logged repeatedly across re-renders or HMR cycles.
const loggedOnceEvents = new Set<string>();

export interface LogAuditOptions {
  /** Skip the call if an event of this type has already been logged in this process. */
  once?: boolean;
}

/**
 * Append a structured audit event. Routes through the sidecar (per ADR-0004),
 * which inserts into the Drizzle `audit_log` table.
 *
 * Audit logging is best effort: failures do not surface to the caller, because
 * the calling UX should not stall waiting on log infrastructure. Per spec.md
 * Flow A AC5 and rules/02-backend.md B20.
 */
export async function logAuditEvent(
  eventType: string,
  payload: Record<string, unknown> = {},
  options: LogAuditOptions = {},
): Promise<void> {
  if (options.once && loggedOnceEvents.has(eventType)) return;
  if (options.once) loggedOnceEvents.add(eventType);

  const result = await sidecarCall<{ id: string }>("audit.logEvent", {
    eventType,
    payload: JSON.stringify(payload),
  });

  // Best-effort: discard both branches. We intentionally do not surface failures.
  result.match(
    () => undefined,
    () => undefined,
  );
}

/** Test-only: clear the once-per-process dedupe set. */
export function _resetAuditOnceCache(): void {
  loggedOnceEvents.clear();
}
