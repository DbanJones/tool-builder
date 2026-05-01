// Eight-class defect taxonomy per debug_repair_engine_spec.md §B.1, mapped
// to the Builder's target stack (Next.js 15 + Supabase + TypeScript). Each
// class carries a default severity range; concrete detectors override per
// finding when they have evidence (e.g. an RLS-missing rule on a PII table
// is severity 9, while RLS-missing on an internal-only table is severity 6).
//
// Severity is the `S` component of the PRIORITY score (see priority.ts).
// `defaultSeverity` is the centre of the source spec's range; detectors may
// nudge ±2 with a justification.

export type DefectClass =
  | "build" // §B.1.1 — build/compile failures
  | "runtime" // §B.1.2 — runtime/logic errors
  | "security" // §B.1.3 — XSS, SQLi, secrets, command injection, …
  | "api" // §B.1.4 — API/data contract errors
  | "auth" // §B.1.5 — authentication/authorisation defects
  | "deploy" // §B.1.6 — deployment/packaging/CI errors
  | "perf" // §B.1.7 — performance and scalability
  | "maintain"; // §B.1.8 — maintainability/readability

export interface ClassMeta {
  defaultSeverity: number;
  description: string;
}

// Default severities mirror the source spec's §C.3.1 table. The Builder
// downranks `perf` and `maintain` in founder mode via the `U` multiplier
// in priority.ts; the severity itself stays calibrated to the source spec.
export const CLASS_META: Readonly<Record<DefectClass, ClassMeta>> = {
  build: { defaultSeverity: 8, description: "Build or compile blocker" },
  runtime: { defaultSeverity: 7, description: "Runtime or logic error" },
  security: { defaultSeverity: 8, description: "Security vulnerability" },
  api: { defaultSeverity: 6, description: "API or data contract error" },
  auth: { defaultSeverity: 9, description: "Authentication or authorisation defect" },
  deploy: { defaultSeverity: 7, description: "Deployment or packaging error" },
  perf: { defaultSeverity: 5, description: "Performance issue" },
  maintain: { defaultSeverity: 2, description: "Maintainability or readability" },
};

export type Band = "critical" | "high" | "medium" | "low" | "info";

// Band thresholds per source spec §C.5. The dashboard treats `critical` as
// blocking (Flow L AC8: Deploy gate) and aggregates `low` (e.g. "12
// maintainability issues") to keep the rail readable.
export interface BandRange {
  min: number;
  treatment: string;
}

export const BAND_RANGES: Readonly<Record<Band, BandRange>> = {
  critical: { min: 20, treatment: "Block deploy. Surface as modal." },
  high: { min: 10, treatment: "Surface prominently; recommend fix before ship." },
  medium: { min: 5, treatment: "Visible in dashboard; sort by score." },
  low: { min: 1, treatment: "Aggregate count." },
  info: { min: 0, treatment: "Hide unless user opts in." },
};

/** Bucket a numeric PRIORITY score into one of the five bands. */
export function bandOf(score: number): Band {
  if (score >= BAND_RANGES.critical.min) return "critical";
  if (score >= BAND_RANGES.high.min) return "high";
  if (score >= BAND_RANGES.medium.min) return "medium";
  if (score >= BAND_RANGES.low.min) return "low";
  return "info";
}
