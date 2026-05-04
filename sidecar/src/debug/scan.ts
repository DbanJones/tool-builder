// Pure composition + scoring layer for the Debug module. Takes a set of
// detectors and a ScanContext, runs them all (with per-detector fault
// tolerance via Promise.allSettled — one buggy detector cannot sink the
// whole scan), folds each RawFinding through the PRIORITY score, and
// returns scored findings ready for the sidecar handler to insert.
//
// No DB I/O lives here. The handler in `handlers/debug.ts` is the only
// thing that touches `defects` rows — keeps this module purely testable
// against in-memory detector stubs.

import type { Band, DefectClass } from "./taxonomy.js";
import { CLASS_META } from "./taxonomy.js";
import { priority, type UserMode } from "./priority.js";
import type { Detector, RawFinding, ScanContext } from "./detectors/types.js";

export interface ScoredFinding {
  raw: RawFinding;
  score: number;
  band: Band;
  userMultiplier: number;
}

export interface DetectorFailure {
  detectorId: string;
  message: string;
}

export interface ScanOutcome {
  findings: readonly ScoredFinding[];
  /**
   * Detectors that threw during the run. The handler still inserts
   * the successful findings; the failures are logged separately so a
   * partial run is honest about what was scanned.
   */
  failures: readonly DetectorFailure[];
}

/**
 * Run every detector against the same context, in parallel, with
 * per-detector isolation. A detector throwing turns into a `failure`
 * row instead of failing the whole scan.
 */
export async function runScan(
  detectors: readonly Detector[],
  ctx: ScanContext,
  userMode: UserMode
): Promise<ScanOutcome> {
  const results = await Promise.allSettled(
    detectors.map((d) => d.run(ctx).then((findings) => ({ id: d.id, findings })))
  );

  const findings: ScoredFinding[] = [];
  const failures: DetectorFailure[] = [];
  for (let i = 0; i < results.length; i++) {
    const settled = results[i]!;
    if (settled.status === "fulfilled") {
      for (const raw of settled.value.findings) {
        findings.push(score(raw, userMode));
      }
    } else {
      failures.push({
        detectorId: detectors[i]?.id ?? "unknown",
        message:
          settled.reason instanceof Error
            ? settled.reason.message
            : String(settled.reason),
      });
    }
  }
  return { findings, failures };
}

/**
 * Score a single finding. Severity falls back to the class default if
 * the detector emitted zero (so a buggy detector lands at a band
 * boundary instead of zeroing the dashboard); other components clamp
 * inside `priority()`.
 */
export function score(raw: RawFinding, userMode: UserMode): ScoredFinding {
  const severity = raw.severity > 0 ? raw.severity : defaultSeverity(raw.class);
  const result = priority({
    severity,
    blastRadius: raw.blastRadius,
    confidence: raw.confidence,
    difficulty: raw.difficulty,
    defectClass: raw.class,
    userMode,
  });
  return {
    raw,
    score: result.score,
    band: result.band,
    userMultiplier: result.userMultiplier,
  };
}

function defaultSeverity(cls: DefectClass): number {
  return CLASS_META[cls].defaultSeverity;
}
