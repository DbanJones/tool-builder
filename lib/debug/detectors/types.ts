// Shared types for Layer 1 detectors. A detector is a pure-ish function
// from a `ScanContext` (the target-app folder + a logger) to a list of
// `RawFinding` objects. The sidecar's `debug.scan` handler converts each
// `RawFinding` into a fully-priced `Finding` by composing PRIORITY inputs
// (defects/priority.ts) and inserts the result into the `defects` table.
//
// Detectors live in `detectors/layer1/`. Layer 2 (LLM validator) and
// Layer 3 (sandbox) reuse the `RawFinding` shape so the validator stage
// can up- or down-grade confidence without owning the schema.

import type { ResultAsync } from "neverthrow";

import type { DefectClass } from "../taxonomy";

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
  /** Workspace-relative file path. */
  file: string;
  lineStart: number;
  lineEnd: number;
  /** Plain-English impact for the founder-mode card; max ~280 chars. */
  humanExplanation: string;
  /** Raw evidence (the offending code line, the failing import, …). */
  codeEvidence: string;
}

export interface DetectorError {
  kind: "detector_error";
  detectorId: string;
  message: string;
}

export interface Detector {
  /** Stable identifier — referenced in tests, traces, and `defects.rule_id`. */
  id: string;
  /** Run the detector against the target folder. */
  run(ctx: ScanContext): ResultAsync<readonly RawFinding[], DetectorError>;
}
