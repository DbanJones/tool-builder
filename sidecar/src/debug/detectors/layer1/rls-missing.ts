// Lovable-class RLS detector. Replays CVE-2025-48757: a Supabase table
// holding user PII shipped without ENABLE ROW LEVEL SECURITY. Per
// debug_repair_engine_spec.md §B.1.5 this defect class drove the 322%
// privilege-escalation increase Apiiro tracked in AI-generated code.
//
// The SQL parsing + schema graph construction live in
// `../../graph/schema.ts` so future schema-aware detectors and the G4
// validator share one shape. This file owns only the PII-column
// heuristic and the band/severity decisions.

import { buildSchemaGraph, type SchemaTable } from "../../graph/schema.js";
import type { Detector, RawFinding, ScanContext } from "../types.js";

const PII_COLUMN_NAMES: ReadonlySet<string> = new Set([
  "email",
  "phone",
  "address",
  "ssn",
  "dob",
  "date_of_birth",
  "password",
  "password_hash",
  "token",
  "access_token",
  "refresh_token",
  "api_key",
  "secret",
  "credit_card",
  "card_number",
  "tax_id",
  "national_id",
]);

const PII_COLUMN_SUFFIXES: readonly string[] = [
  "_email",
  "_phone",
  "_address",
  "_token",
  "_password",
];

export function isPiiColumn(columnName: string): boolean {
  const lower = columnName.toLowerCase();
  if (PII_COLUMN_NAMES.has(lower)) return true;
  for (const suffix of PII_COLUMN_SUFFIXES) {
    if (lower.endsWith(suffix)) return true;
  }
  return false;
}

function piiColumnsOf(table: SchemaTable): string[] {
  return table.columns.map((c) => c.name).filter(isPiiColumn);
}

export async function rlsMissingScan(
  ctx: ScanContext
): Promise<readonly RawFinding[]> {
  const graph = await buildSchemaGraph(ctx.projectPath);
  const findings: RawFinding[] = [];

  for (const table of graph) {
    const piiCols = piiColumnsOf(table);
    if (piiCols.length === 0) continue;

    if (!table.rlsEnabled) {
      findings.push({
        class: "auth",
        ruleId: "rls-missing/no-rls-on-pii-table",
        severity: 9,
        blastRadius: 2.5,
        confidence: 0.7,
        difficulty: 1.5,
        file: table.source.file,
        lineStart: table.source.line,
        lineEnd: table.source.line,
        humanExplanation: humanExplanationNoRls(table.name, piiCols),
        codeEvidence: `CREATE TABLE ${table.name} (… ${piiCols.join(", ")} …)`,
      });
    }

    if (!table.rlsEnabled && table.policies.length > 0) {
      findings.push({
        class: "auth",
        ruleId: "rls-missing/policy-without-enable",
        severity: 9,
        blastRadius: 2.5,
        confidence: 0.85,
        difficulty: 1,
        file: table.source.file,
        lineStart: table.source.line,
        lineEnd: table.source.line,
        humanExplanation: humanExplanationPolicyWithoutEnable(table.name),
        codeEvidence: `CREATE POLICY … ON ${table.name} (no ENABLE ROW LEVEL SECURITY)`,
      });
    }
  }
  return findings;
}

function humanExplanationNoRls(name: string, piiColumns: string[]): string {
  const cols = piiColumns.slice(0, 3).join(", ");
  return (
    `The Supabase table "${name}" looks like it stores user data ` +
    `(columns: ${cols}) but row-level security is not enabled. ` +
    `Anyone with your project's anon key — including any visitor — can read ` +
    `every row in this table. Add ALTER TABLE ${name} ENABLE ROW LEVEL ` +
    `SECURITY plus a CREATE POLICY that restricts reads to the row's owner.`
  );
}

function humanExplanationPolicyWithoutEnable(name: string): string {
  return (
    `Table "${name}" has a row-level security policy defined but RLS is ` +
    `not enabled — Postgres ignores policies on tables where RLS is off. ` +
    `Add ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY to activate the ` +
    `existing policy.`
  );
}

export const rlsMissingDetector: Detector = {
  id: "rls-missing",
  run(ctx: ScanContext): Promise<readonly RawFinding[]> {
    return rlsMissingScan(ctx);
  },
};
