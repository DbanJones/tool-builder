// Webview-facing surface of the Debug module per ADR-0007.
//
// The detector machinery (taxonomy, priority scoring, walk, layer 1
// detectors, scan handler) lives in `sidecar/src/debug/` because it
// reads the target-app filesystem and spawns subprocesses — both
// privileges the webview does not have. The webview reads pre-scored
// rows out of the `defects` table and renders them.
//
// What lives here is the minimum surface the dashboard needs:
// - the `Band` and `DefectClass` string-literal unions, kept in sync
//   with the sidecar's taxonomy by hand (a class added there must be
//   added here too — there are eight, they change rarely),
// - per-band display treatment text used by the Debug card,
// - a thin `runDebugScan` wrapper around the sidecar RPC.

export type DefectClass =
  | "build"
  | "runtime"
  | "security"
  | "api"
  | "auth"
  | "deploy"
  | "perf"
  | "maintain";

export type Band = "critical" | "high" | "medium" | "low" | "info";

export interface BandTreatment {
  /** Tailwind colour token used by the Debug card. */
  tone: "destructive" | "warning" | "default" | "muted";
  /** Whether this band blocks Deploy until resolved (Flow L AC8). */
  blocksDeploy: boolean;
  /** One-line dashboard label. */
  label: string;
}

export const BAND_TREATMENT: Readonly<Record<Band, BandTreatment>> = {
  critical: {
    tone: "destructive",
    blocksDeploy: true,
    label: "Critical — fix before sharing",
  },
  high: { tone: "warning", blocksDeploy: false, label: "High priority" },
  medium: { tone: "default", blocksDeploy: false, label: "Medium" },
  low: { tone: "muted", blocksDeploy: false, label: "Low" },
  info: { tone: "muted", blocksDeploy: false, label: "Info" },
};

export {
  applyDebugFix,
  listDefects,
  rollbackDebugFix,
  runDebugGraph,
  runDebugScan,
  type ApplyFixResult,
  type AuthCheck,
  type Defect,
  type DebugError,
  type DebugScanResult,
  type FixOutcome,
  type HttpMethod,
  type RollbackOutcome,
  type RollbackResult,
  type RouteAuthInfo,
  type RouteInfo,
  type SchemaColumn,
  type SchemaPolicy,
  type SchemaTable,
  type SoftwareGraph,
  type ValidatorVerdict,
} from "./sidecar";
