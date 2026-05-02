// Pure selectors over a Defect[] used by the dashboard. Lives in
// lib/debug/ rather than the component file so the unit tests can
// import it without dragging Tauri/UI alias resolution into Vitest.

import type { Defect } from "./sidecar";

/**
 * Defects that the deploy-gate modal must surface: critical-band rows
 * that are still open or in-flight (status open or fixing). Fixed,
 * dismissed, and accepted_risk all clear the gate.
 */
export function selectUnresolvedCritical(defects: readonly Defect[]): Defect[] {
  return defects.filter(
    (d) => d.band === "critical" && (d.status === "open" || d.status === "fixing")
  );
}
