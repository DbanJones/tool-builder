// Subgraph slice extraction. Per the G4 echo-back, this is the *only*
// thing the Layer 2 validator sees beyond the system prompt: the
// candidate finding, ±50 lines of source context, the routes whose
// handlers live in the same file, and the schema tables the file's
// queries reference. No raw filesystem access, no graph traversal in
// the prompt — that closes the prompt-injection vector (source spec
// §I.2 risk row 6).
//
// Pure within the limits of fs.readFile: the slice depends on disk
// content, but no SDK or DB calls happen here. The validator driver
// (G4b) consumes a fully-resolved SubgraphSlice.

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type {
  RouteAuthInfo,
  SchemaTable,
  SoftwareGraph,
} from "../graph/index.js";
import type { RawFinding } from "../detectors/types.js";

export const CONTEXT_LINES = 50;

export interface SubgraphSlice {
  finding: RawFinding;
  /** ±CONTEXT_LINES lines around the finding; ` > ` marker on the finding lines. */
  contextSource: string;
  /** Routes whose handler file is the finding's file. */
  relatedRoutes: RouteAuthInfo[];
  /** Schema tables whose name appears anywhere in the source file. */
  relatedTables: SchemaTable[];
  /** True when nothing in the graph mentions the finding's file. */
  isOrphan: boolean;
  /** Workspace-relative path; mirrors `finding.file`, kept for prompt convenience. */
  filePath: string;
  /** Total number of lines in the source file. Useful for the prompt header. */
  totalLines: number;
}

/**
 * Read the source file and slice ±CONTEXT_LINES around the finding's
 * location, then join graph data by file path / table name.
 */
export async function extractSlice(
  finding: RawFinding,
  graph: SoftwareGraph,
  projectPath: string
): Promise<SubgraphSlice> {
  const abs = path.join(projectPath, finding.file);
  let source = "";
  try {
    source = await fs.readFile(abs, "utf-8");
  } catch {
    // File no longer exists — emit an orphan slice with empty source.
    // The validator handles isOrphan + empty contextSource as a hard
    // "uncertain" signal.
    source = "";
  }

  const lines = source.length === 0 ? [] : source.split(/\r?\n/);
  const contextSource = renderContext(lines, finding.lineStart, finding.lineEnd);

  const relatedRoutes = graph.auth.filter((a) => a.route.filePath === finding.file);
  const relatedTables = filterRelatedTables(source, graph.schema);

  // The finding is "orphan" when no graph entry references the file.
  // Routes are joined by file path; schema is joined indirectly (we
  // don't claim a SQL migration is "related" to a TS finding here).
  const isOrphan =
    !graph.routes.some((r) => r.filePath === finding.file) &&
    !graph.schema.some((t) => t.source.file === finding.file);

  return {
    finding,
    contextSource,
    relatedRoutes,
    relatedTables,
    isOrphan,
    filePath: finding.file,
    totalLines: lines.length,
  };
}

/**
 * Build the rendered ±CONTEXT_LINES context. Lines outside [start, end]
 * get a 4-space gutter; lines inside get a `> ` marker. Lines are
 * 1-indexed, padded to 4 chars, then a colon and the original content.
 */
export function renderContext(
  lines: readonly string[],
  lineStart: number,
  lineEnd: number
): string {
  if (lines.length === 0) return "";
  const from = Math.max(1, lineStart - CONTEXT_LINES);
  const to = Math.min(lines.length, lineEnd + CONTEXT_LINES);
  const widest = String(to).length;
  const out: string[] = [];
  for (let i = from; i <= to; i++) {
    const isHit = i >= lineStart && i <= lineEnd;
    const prefix = isHit ? "> " : "  ";
    const num = String(i).padStart(widest, " ");
    out.push(`${prefix}${num}: ${lines[i - 1] ?? ""}`);
  }
  return out.join("\n");
}

/**
 * Find every schema table whose unquoted, lowercased name appears as a
 * whole word in the source. Coarse but enough at v1: false positives
 * sit alongside the slice and the validator can tell the difference;
 * false negatives are downrank-not-drop per source spec §C.3.3.
 */
export function filterRelatedTables(
  source: string,
  schema: readonly SchemaTable[]
): SchemaTable[] {
  if (source.length === 0 || schema.length === 0) return [];
  const lower = source.toLowerCase();
  return schema.filter((t) => {
    const re = new RegExp(`\\b${escapeRegex(t.name)}\\b`, "i");
    return re.test(lower);
  });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
