// `debug.scan` JSON-RPC handler. Composes the six Layer 1 detectors,
// scores their output via the PRIORITY pipeline, and persists rows to
// the `defects` table. Per ADR-0007 and Flow L AC1/AC2 in spec.md.
//
// Per-detector failures do NOT fail the scan — `runScan` already isolates
// them and returns the list of broken detectors as `failures`. The
// successful findings still land; the failures show up in the audit log
// as a `debug_scan_completed` event with a non-empty `failures` array
// for diagnostics.

import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { z } from "zod";

import { getDb } from "../db.js";
import { auditLog } from "../schema/audit-log.js";
import { defects, type Defect } from "../schema/defects.js";
import { projects } from "../schema/projects.js";
import { hallucinatedImportDetector } from "../debug/detectors/layer1/hallucinated-import.js";
import { secretRegexDetector } from "../debug/detectors/layer1/secret-regex.js";
import { tscDetector } from "../debug/detectors/layer1/tsc.js";
import { rlsMissingDetector } from "../debug/detectors/layer1/rls-missing.js";
import { clientSideAuthDetector } from "../debug/detectors/layer1/client-side-auth.js";
import { envLeakDetector } from "../debug/detectors/layer1/env-leak.js";
import type { Detector } from "../debug/detectors/types.js";
import { buildGraph, type SoftwareGraph } from "../debug/graph/index.js";
import { runScan, type ScoredFinding } from "../debug/scan.js";
import { priority } from "../debug/priority.js";
import {
  sdkTransport,
  validateFinding,
  type ValidatorResult,
  type ValidatorTransport,
} from "../debug/validator/index.js";

// All Layer 1 detectors at v1. G3 will add software-graph-aware detectors;
// G4 wraps these in the Layer 2 validator.
const DEFAULT_DETECTORS: readonly Detector[] = [
  secretRegexDetector,
  tscDetector,
  hallucinatedImportDetector,
  rlsMissingDetector,
  clientSideAuthDetector,
  envLeakDetector,
];

const ScanParamsSchema = z.object({
  projectId: z.string().min(1),
  userMode: z.enum(["founder", "team"]).default("founder"),
  /**
   * When true, runs the Layer 2 validator (LLM-backed) against every
   * Layer 1 finding before persisting. Updates each row's
   * confidence/priority/band in place; false-positive verdicts get
   * status="dismissed". Default off — Layer 1 alone is fast (≤ 5s NFR
   * per spec.md §6); Layer 2 adds an SDK round-trip per finding and is
   * meant for the explicit "Debug now" path or phase-boundary scans.
   */
  validate: z.boolean().default(false),
  /** Optional model override for the Layer 2 validator. When omitted,
   *  the SDK transport uses the CLI auth's default. */
  validatorModel: z.string().min(1).optional(),
});

export interface ScanResult {
  scanId: string;
  findingCount: number;
  durationMs: number;
  failures: Array<{ detectorId: string; message: string }>;
  /** Number of findings the Layer 2 validator dismissed as false positives. */
  validatorDismissed: number;
}

/**
 * `debug.scan({ projectId, userMode?, validate? })` — runs every Layer
 * 1 detector against the project's folder, scores findings, persists
 * them, optionally runs the Layer 2 validator over every finding, and
 * returns a summary. Audit emits `debug_scan_started` +
 * `debug_scan_completed`.
 *
 * `transport` defaults to the production SDK transport; the
 * handler-level tests inject a deterministic stub.
 */
export async function scan(
  rawParams: unknown,
  detectors: readonly Detector[] = DEFAULT_DETECTORS,
  transport: ValidatorTransport = sdkTransport
): Promise<ScanResult> {
  const params = ScanParamsSchema.parse(rawParams);
  const db = getDb();

  const [project] = db
    .select()
    .from(projects)
    .where(eq(projects.id, params.projectId))
    .all();
  if (!project) {
    throw new Error(`debug.scan: project not found '${params.projectId}'`);
  }

  const scanId = ulid();
  const startedAt = Date.now();

  db.insert(auditLog)
    .values({
      id: ulid(),
      action: "debug_scan_started",
      targetId: scanId,
      payload: JSON.stringify({
        projectId: params.projectId,
        userMode: params.userMode,
        validate: params.validate,
      }),
      createdAt: startedAt,
    })
    .run();

  const outcome = await runScan(
    detectors,
    {
      projectPath: project.path,
      scanId,
      startedAt,
    },
    params.userMode
  );

  // Layer 2 validation: only when explicitly requested. Reads the
  // graph once per scan (echo-back risk #4: one SDK session per scan,
  // not per finding — implemented here as the transport reuse pattern).
  let verdicts = new Map<string, ValidatorResult>();
  let validatorDismissed = 0;
  if (params.validate && outcome.findings.length > 0) {
    const graph = await buildGraph(project.path);
    for (const f of outcome.findings) {
      const result = await validateFinding(
        f.raw,
        graph,
        project.path,
        transport,
        params.validatorModel,
      );
      verdicts.set(findingKey(f), result);
      if (result.verdict === "false_positive") validatorDismissed++;
    }
  }

  if (outcome.findings.length > 0) {
    db.insert(defects)
      .values(
        outcome.findings.map((f) =>
          toRow(
            f,
            params.projectId,
            scanId,
            startedAt,
            params.userMode,
            verdicts.get(findingKey(f)) ?? null
          )
        )
      )
      .run();
  }

  const completedAt = Date.now();
  const durationMs = completedAt - startedAt;
  db.insert(auditLog)
    .values({
      id: ulid(),
      action: "debug_scan_completed",
      targetId: scanId,
      payload: JSON.stringify({
        projectId: params.projectId,
        findingCount: outcome.findings.length,
        durationMs,
        failures: outcome.failures,
        validatorDismissed,
      }),
      createdAt: completedAt,
    })
    .run();

  return {
    scanId,
    findingCount: outcome.findings.length,
    durationMs,
    failures: [...outcome.failures],
    validatorDismissed,
  };
}

function findingKey(f: ScoredFinding): string {
  return `${f.raw.ruleId}@${f.raw.file}:${f.raw.lineStart}-${f.raw.lineEnd}`;
}

function toRow(
  f: ScoredFinding,
  projectId: string,
  scanId: string,
  detectedAt: number,
  userMode: "founder" | "team",
  validator: ValidatorResult | null
): typeof defects.$inferInsert {
  // Validator merges into the score components when present:
  //  - real          → confidence ↑ to max(current, validator.confidence)
  //  - false_positive → row gets status="dismissed"; confidence stays
  //                    (so the dashboard's "show dismissed" toggle has
  //                    something honest to display).
  //  - uncertain     → no confidence change; band/priority unchanged.
  let confidence = f.raw.confidence;
  let band = f.band;
  let scorePriority = f.score;
  let status: "open" | "dismissed" = "open";
  let validatorVerdict: "real" | "false_positive" | "uncertain" | null = null;
  let validatorNotes: string | null = null;
  let validatedAt: number | null = null;
  let fixTier: number | null = null;

  if (validator) {
    validatorVerdict = validator.verdict;
    validatorNotes = JSON.stringify({
      exploitPath: validator.exploitPath,
      fixStrategy: validator.fixStrategy,
    });
    validatedAt = Date.now();
    fixTier = validator.fixTier;
    if (validator.verdict === "real") {
      confidence = Math.max(f.raw.confidence, validator.confidence);
      const reranked = priority({
        severity: f.raw.severity,
        blastRadius: f.raw.blastRadius,
        confidence,
        difficulty: f.raw.difficulty,
        defectClass: f.raw.class,
        userMode,
      });
      scorePriority = reranked.score;
      band = reranked.band;
    } else if (validator.verdict === "false_positive") {
      status = "dismissed";
    }
  }

  return {
    id: ulid(),
    projectId,
    scanId,
    detectedAt,
    class: f.raw.class,
    severity: f.raw.severity,
    blastRadius: f.raw.blastRadius,
    confidence,
    difficulty: f.raw.difficulty,
    priority: scorePriority,
    band,
    file: f.raw.file,
    lineStart: f.raw.lineStart,
    lineEnd: f.raw.lineEnd,
    ruleId: f.raw.ruleId,
    humanExplanation: f.raw.humanExplanation,
    codeEvidence: f.raw.codeEvidence,
    status,
    fixTier,
    validatorVerdict,
    validatorNotes,
    validatedAt,
  };
}

const ListParamsSchema = z.object({
  projectId: z.string().min(1),
  scanId: z.string().optional(),
});

/**
 * `debug.list({ projectId, scanId? })` — read findings for a project,
 * optionally filtered to one scan run. Used by the dashboard's Debug
 * panel (G6).
 */
export function list(rawParams: unknown): Defect[] {
  const params = ListParamsSchema.parse(rawParams);
  const db = getDb();
  const rows = db
    .select()
    .from(defects)
    .where(eq(defects.projectId, params.projectId))
    .all();
  if (params.scanId === undefined) return rows;
  return rows.filter((r) => r.scanId === params.scanId);
}

const GraphParamsSchema = z.object({ projectId: z.string().min(1) });

/**
 * `debug.graph({ projectId })` — return the software graph for the
 * project's target folder: routes, schema, auth model, plus warnings
 * for any per-area parse failures. Used by G4's validator for subgraph
 * slices and (eventually) the G6 dashboard's "what does this route
 * touch?" sidebar.
 */
export async function graph(rawParams: unknown): Promise<SoftwareGraph> {
  const params = GraphParamsSchema.parse(rawParams);
  const db = getDb();
  const [project] = db
    .select()
    .from(projects)
    .where(eq(projects.id, params.projectId))
    .all();
  if (!project) {
    throw new Error(`debug.graph: project not found '${params.projectId}'`);
  }
  return buildGraph(project.path);
}
