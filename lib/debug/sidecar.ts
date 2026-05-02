import { ResultAsync } from "neverthrow";

import { sidecarCall, type SidecarError } from "@/lib/sidecar/client";

import type { Band, DefectClass } from "./index";

// Wire shape from sidecar/src/handlers/debug.ts. Mirror — when the sidecar
// schema changes, update both ends.

export interface DebugScanResult {
  scanId: string;
  findingCount: number;
  durationMs: number;
  failures: Array<{ detectorId: string; message: string }>;
}

export interface Defect {
  id: string;
  projectId: string;
  scanId: string;
  detectedAt: number;
  class: DefectClass;
  severity: number;
  blastRadius: number;
  confidence: number;
  difficulty: number;
  priority: number;
  band: Band;
  file: string;
  lineStart: number;
  lineEnd: number;
  ruleId: string;
  humanExplanation: string;
  codeEvidence: string;
  status: "open" | "fixing" | "fixed" | "dismissed" | "accepted_risk";
  fixTier: number | null;
  fixBranch: string | null;
  fixTestPath: string | null;
  resolvedAt: number | null;
  resolvedCommit: string | null;
}

export type DebugError = { kind: "Sidecar"; message: string };

const fromSidecarError = (e: SidecarError): DebugError => ({
  kind: "Sidecar",
  message: e.kind === "Sidecar" ? `${e.code}: ${e.message}` : e.message,
});

/**
 * `debug.scan` over the sidecar — runs every Layer 1 detector against the
 * project's folder, persists scored findings to the `defects` table, and
 * returns a summary. Audit-logs `debug_scan_started` + `debug_scan_completed`.
 */
export function runDebugScan(params: {
  projectId: string;
  userMode?: "founder" | "team";
}): ResultAsync<DebugScanResult, DebugError> {
  return sidecarCall<DebugScanResult>("debug.scan", params).mapErr(fromSidecarError);
}

/**
 * Read findings for a project, optionally filtered to a single scan run
 * (the dashboard's Debug panel uses both modes — "everything open" and
 * "what just landed in this scan").
 */
export function listDefects(params: {
  projectId: string;
  scanId?: string;
}): ResultAsync<Defect[], DebugError> {
  return sidecarCall<Defect[]>("debug.list", params).mapErr(fromSidecarError);
}
