// Shared types for Layer 1 detectors. A detector is an async function from
// a `ScanContext` (the target-app folder + a scan id + a wall-clock) to a
// list of `RawFinding` objects. The sidecar's `debug.scan` handler converts
// each `RawFinding` into a fully-priced row via the PRIORITY components in
// priority.ts and inserts it into the `defects` table.
//
// Sidecar convention is throw-on-error (matching files.ts and friends);
// the JSON-RPC layer translates thrown errors into `{ ok: false, error }`
// responses. Detectors should let unexpected exceptions propagate; the
// scan handler decides whether to surface them or silently degrade.

import type { DefectClass } from "../taxonomy.js";

export interface ScanContext {
  /** Absolute path to the target-app folder (already path-sandboxed). */
  projectPath: string;
  /** Stable id for this scan run; every finding inherits it. */
  scanId: string;
  /** Wall-clock at scan start; used for `detectedAt`. */
  startedAt: number;
}

// A detector emits these. The sidecar handler is the only thing that
// computes PRIORITY (it owns the user-mode lookup) and writes the row.
export interface RawFinding {
  class: DefectClass;
  ruleId: string;
  /** Severity 1..10 — detector picks per finding; defaults from CLASS_META. */
  severity: number;
  /** Blast radius 1..3 — how much breaks if this fires. */
  blastRadius: number;
  /** Confidence 0..1 — pure pattern matches sit at ~0.6, hybrid at ~0.85. */
  confidence: number;
  /** Difficulty 1..3 — codemod=1, refactor=1.5, cross-file=2, arch=3. */
  difficulty: number;
  /** Workspace-relative file path with POSIX separators. */
  file: string;
  lineStart: number;
  lineEnd: number;
  /** Plain-English impact for the founder-mode card; max ~280 chars. */
  humanExplanation: string;
  /** Raw evidence (the offending code line, the failing import, …). */
  codeEvidence: string;
}

export interface Detector {
  /** Stable identifier — referenced in tests, traces, and `defects.rule_id`. */
  id: string;
  /** Run the detector against the target folder. Throws on unexpected I/O. */
  run(ctx: ScanContext): Promise<readonly RawFinding[]>;
}
