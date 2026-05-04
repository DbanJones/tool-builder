// PRIORITY scoring per debug_repair_engine_spec.md §C.2:
//
//   PRIORITY = (S × B × C × U) / D
//
// where
//   S = severity (1..10)
//   B = blast radius multiplier (1.0..3.0)
//   C = confidence (0.0..1.0)
//   U = user-context multiplier — founder mode boosts security/blockers,
//       downranks perf/maintain (source spec §C.3.4)
//   D = detection-to-fix difficulty (1.0..3.0); higher pushes the score
//       down so the easy wins surface first
//
// Pure: no time, no I/O. The caller passes every component explicitly.

import { type Band, bandOf, type DefectClass } from "./taxonomy.js";

export type UserMode = "founder" | "team";

export interface PriorityInputs {
  /** Severity 1..10. Detectors typically use the class default; see taxonomy.ts. */
  severity: number;
  /** Blast radius 1.0..3.0 — how much of the system breaks if this fires. */
  blastRadius: number;
  /** Confidence 0.0..1.0 — how sure the detector is that the finding is real. */
  confidence: number;
  /** Difficulty 1.0..3.0 — higher means harder to fix. Pushes score down. */
  difficulty: number;
  /** Defect class — drives the user-mode multiplier `U`. */
  defectClass: DefectClass;
  /** Founder mode (default) downranks perf/maintain; team mode is flatter. */
  userMode: UserMode;
}

export interface PriorityResult {
  score: number;
  band: Band;
  /** The U multiplier that was applied; useful for debugging in tests. */
  userMultiplier: number;
}

// Founder mode (source spec §C.3.4): security and ship-blockers carry the
// dashboard; perf/maintain are deliberately downranked because optimisation
// is premature for a prototype. Team mode keeps the same priorities but
// flatter — performance and maintainability re-enter the conversation when
// the app graduates from prototype to product.
const U_TABLE: Readonly<Record<UserMode, Readonly<Record<DefectClass, number>>>> = {
  founder: {
    auth: 2.0,
    security: 2.0,
    build: 2.0,
    runtime: 2.0,
    deploy: 1.5,
    api: 1.5,
    perf: 0.7,
    maintain: 0.5,
  },
  team: {
    auth: 1.5,
    security: 1.5,
    build: 1.5,
    runtime: 1.5,
    deploy: 1.2,
    api: 1.2,
    perf: 1.2,
    maintain: 1.0,
  },
};

/**
 * Compute the PRIORITY score and its band for a finding.
 *
 * Components are clamped to their documented ranges so a buggy detector
 * cannot produce a negative or absurd score; a mis-calibrated detector
 * will simply land at a band boundary instead of skewing the dashboard.
 */
export function priority(inputs: PriorityInputs): PriorityResult {
  const s = clamp(inputs.severity, 1, 10);
  const b = clamp(inputs.blastRadius, 1, 3);
  const c = clamp(inputs.confidence, 0, 1);
  const d = clamp(inputs.difficulty, 1, 3);
  const u = U_TABLE[inputs.userMode][inputs.defectClass];

  const score = (s * b * c * u) / d;
  return { score, band: bandOf(score), userMultiplier: u };
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
