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
  /** Number of findings the Layer 2 validator marked false_positive. */
  validatorDismissed: number;
}

export type ValidatorVerdict = "real" | "false_positive" | "uncertain";

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
  /** Layer 2 validator output (Phase G G4); null when validate=false. */
  validatorVerdict: ValidatorVerdict | null;
  /** JSON-encoded {exploitPath, fixStrategy}; null when no validator. */
  validatorNotes: string | null;
  validatedAt: number | null;
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
 *
 * `validate: true` runs the Layer 2 LLM validator against every Layer 1
 * finding before persisting; updates each row's confidence + priority +
 * band in place and dismisses false-positive verdicts. Off by default
 * because it adds an SDK round-trip per finding.
 */
export function runDebugScan(params: {
  projectId: string;
  userMode?: "founder" | "team";
  validate?: boolean;
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

// Software graph wire shapes. Mirrors sidecar/src/debug/graph/.
// Promote here only what the webview UI cares about; G4's validator
// runs in the sidecar and consumes the full structure directly.

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";

export interface RouteInfo {
  framework: "next-app";
  kind: "page" | "route" | "layout";
  pathPattern: string;
  methods: HttpMethod[];
  filePath: string;
  isDynamic: boolean;
  hasMiddleware: boolean;
}

export interface SchemaColumn {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  foreignKey: { table: string; column: string } | null;
}

export interface SchemaPolicy {
  name: string;
  for: "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "ALL";
}

export interface SchemaTable {
  name: string;
  columns: SchemaColumn[];
  rlsEnabled: boolean;
  policies: SchemaPolicy[];
  source: { file: string; line: number };
}

export interface AuthCheck {
  kind: "authentication" | "authorization";
  identifier: string;
  file: string;
  line: number;
}

export interface RouteAuthInfo {
  route: RouteInfo;
  authentication: AuthCheck | null;
  authorizations: AuthCheck[];
}

export interface SoftwareGraph {
  routes: RouteInfo[];
  schema: SchemaTable[];
  auth: RouteAuthInfo[];
  warnings: { area: "routes" | "schema" | "auth"; message: string }[];
}

/**
 * Fetch the software graph for a project (routes + schema + auth +
 * warnings). The sidecar handler walks the target folder synchronously
 * on each call; G7 may add an mtime cache.
 */
export function runDebugGraph(params: {
  projectId: string;
}): ResultAsync<SoftwareGraph, DebugError> {
  return sidecarCall<SoftwareGraph>("debug.graph", params).mapErr(fromSidecarError);
}

export type FixOutcome =
  | "applied"
  | "skipped_no_codemod"
  | "skipped_codemod_noop"
  | "syntax_check_failed"
  | "branch_failed"
  | "codemod_error";

export interface ApplyFixResult {
  defectId: string;
  outcome: FixOutcome;
  message: string;
  files: string[];
  branch: string | null;
}

/**
 * Apply the matching Tier 1 codemod to a defect. The sidecar opens a
 * fresh `ai-fix-<defectId>` branch in the target-app repo, runs the
 * codemod, syntax-checks the modified files, and squashes onto the
 * user's working branch on success — or aborts and leaves the user on
 * their working branch on failure. On `applied` the defects row is
 * updated to status='fixed' with the fixTier + branch name. On any
 * other outcome the row stays open.
 */
export function applyDebugFix(params: {
  defectId: string;
}): ResultAsync<ApplyFixResult, DebugError> {
  return sidecarCall<ApplyFixResult>("debug.applyFix", params).mapErr(fromSidecarError);
}
