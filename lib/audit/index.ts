import { invoke } from "@tauri-apps/api/core";

// Once-per-process dedupe set so events flagged `once: true` (e.g. app_first_run)
// don't get logged repeatedly across re-renders or HMR cycles.
const loggedOnceEvents = new Set<string>();

export interface LogAuditOptions {
  /** Skip the call if an event of this type has already been logged in this process. */
  once?: boolean;
}

/**
 * Append a structured audit event. Routes through a Tauri command which logs to
 * `tauri-plugin-log`. A Drizzle `audit_log` table arrives at A4 when the DB layer
 * lands; this writer is the migration target.
 *
 * Audit logging is best effort: failures do not surface to the caller, because
 * the calling UX should not stall waiting on log infrastructure. Per spec.md Flow A AC5
 * and rules/02-backend.md B20.
 */
export async function logAuditEvent(
  eventType: string,
  payload: Record<string, unknown> = {},
  options: LogAuditOptions = {},
): Promise<void> {
  if (options.once && loggedOnceEvents.has(eventType)) return;
  if (options.once) loggedOnceEvents.add(eventType);

  try {
    await invoke("audit_log_event", {
      eventType,
      payload: JSON.stringify(payload),
    });
  } catch {
    // Audit logging is best-effort; intentionally not surfacing failures.
  }
}

/** Test-only: clear the once-per-process dedupe set. */
export function _resetAuditOnceCache(): void {
  loggedOnceEvents.clear();
}
