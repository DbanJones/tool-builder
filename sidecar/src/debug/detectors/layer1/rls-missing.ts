// Lovable-class RLS detector. Replays CVE-2025-48757: a Supabase table
// holding user PII shipped without ENABLE ROW LEVEL SECURITY, which
// Supabase's anon key cheerfully read for any logged-in user. Per the
// source spec §B.1.5 this defect class drove the 322% privilege-escalation
// increase Apiiro tracked in AI-generated code.
//
// We scan `${target}/supabase/migrations/*.sql`:
//  1. Use node-sql-parser to extract CREATE TABLE statements + their
//     columns (the dialect understood: PostgreSQL, matching Supabase).
//  2. Use regex to find ALTER TABLE … ENABLE ROW LEVEL SECURITY (the
//     Postgres-specific RLS toggle which the SQL parser does not always
//     accept cleanly) and CREATE POLICY statements.
//  3. For every "PII candidate" table (one with a column whose name is
//     in the PII list) that does NOT have RLS enabled later in the same
//     migration sequence, emit a critical finding.
//  4. Separately flag tables with CREATE POLICY but no ENABLE — a
//     documented Postgres footgun where policies exist but are
//     unenforced.
//
// PRIORITY at v1: severity 9, blastRadius 2.5, confidence 0.7, difficulty
// 1.5, defect class "auth". Founder mode → score 21 → critical band
// (matches the source spec's §C.4 worked example up to the confidence
// number, which sits below 0.85 because we have no positive proof the
// column actually contains user PII; the Layer 2 validator at G4 will
// bump it).

import * as fs from "node:fs/promises";
import sqlParserModule from "node-sql-parser";

import type { Detector, RawFinding, ScanContext } from "../types.js";
import { walk } from "../walk.js";

const { Parser: SqlParser } = sqlParserModule;

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

// `ALTER TABLE [schema.]name ENABLE ROW LEVEL SECURITY`.
// Captures the unqualified table name. Ignores schema qualifier.
const ENABLE_RLS_RE =
  /\bALTER\s+TABLE\s+(?:ONLY\s+)?(?:\w+\.)?(?<table>"?\w+"?)\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY\b/gi;

// `CREATE POLICY name ON [schema.]table …`
const CREATE_POLICY_RE =
  /\bCREATE\s+POLICY\s+\w+\s+ON\s+(?:\w+\.)?(?<table>"?\w+"?)/gi;

interface CreateTableInfo {
  name: string;
  piiColumns: string[];
  /** 1-indexed line in the source file where CREATE TABLE starts. */
  line: number;
  /** Path relative to the project root. */
  file: string;
}

interface SqlAstCreateTable {
  type?: string;
  keyword?: string;
  table?: Array<{ table?: string }>;
  create_definitions?: Array<{
    resource?: string;
    column?: { column?: string | { value?: string } };
  }>;
}

export interface RlsMigrationSummary {
  tablesByName: Map<string, CreateTableInfo>;
  enabledTables: Set<string>;
  tablesWithPolicy: Set<string>;
}

export function isPiiColumn(columnName: string): boolean {
  const lower = columnName.toLowerCase();
  if (PII_COLUMN_NAMES.has(lower)) return true;
  for (const suffix of PII_COLUMN_SUFFIXES) {
    if (lower.endsWith(suffix)) return true;
  }
  return false;
}

function unquote(name: string): string {
  return name.replace(/^"|"$/g, "");
}

function readColumnName(column: unknown): string {
  if (typeof column === "string") return column;
  if (column && typeof column === "object") {
    const obj = column as { value?: unknown; expr?: { value?: unknown } };
    if (typeof obj.value === "string") return obj.value;
    if (obj.expr && typeof obj.expr.value === "string") return obj.expr.value;
  }
  return "";
}

export function parseMigration(
  source: string,
  relativePath: string
): {
  creates: CreateTableInfo[];
  enables: Set<string>;
  policies: Set<string>;
} {
  const creates: CreateTableInfo[] = [];
  const enables = new Set<string>();
  const policies = new Set<string>();

  // Strip comments once. We must run the ENABLE/POLICY regexes against
  // the stripped text or a comment like `-- ALTER TABLE x ENABLE ROW
  // LEVEL SECURITY` will be mistaken for the real thing.
  const stripped = stripSqlComments(source);

  // ALTER TABLE … ENABLE RLS — regex (Postgres-specific syntax that
  // node-sql-parser sometimes refuses to parse).
  for (const m of stripped.matchAll(ENABLE_RLS_RE)) {
    if (m.groups?.table) enables.add(unquote(m.groups.table).toLowerCase());
  }
  for (const m of stripped.matchAll(CREATE_POLICY_RE)) {
    if (m.groups?.table) policies.add(unquote(m.groups.table).toLowerCase());
  }

  // CREATE TABLE — astify per-statement so a bad ALTER doesn't sink us.
  const parser = new SqlParser();
  const statements = splitStatements(source);
  for (const stmt of statements) {
    if (!/\bCREATE\s+TABLE\b/i.test(stmt.text)) continue;
    let ast: unknown;
    try {
      ast = parser.astify(stmt.text, { database: "postgresql" });
    } catch {
      continue;
    }
    const arr = Array.isArray(ast) ? ast : [ast];
    for (const node of arr) {
      const s = node as SqlAstCreateTable;
      if (s?.type !== "create" || s.keyword !== "table") continue;
      const name = unquote(s.table?.[0]?.table ?? "").toLowerCase();
      if (!name) continue;
      const piiColumns: string[] = [];
      for (const def of s.create_definitions ?? []) {
        if (def.resource !== "column" || !def.column) continue;
        const colName = readColumnName(def.column.column);
        if (!colName) continue;
        if (isPiiColumn(colName)) piiColumns.push(colName);
      }
      creates.push({ name, piiColumns, line: stmt.line, file: relativePath });
    }
  }

  return { creates, enables, policies };
}

interface StatementSlice {
  text: string;
  line: number;
}

function stripSqlComments(source: string): string {
  return source.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

// Naive splitter: SQL statements end with ';' at depth-0. We only need
// "good enough" because each block is then handed to a real parser.
function splitStatements(source: string): StatementSlice[] {
  const out: StatementSlice[] = [];
  let depth = 0;
  let buf = "";
  let line = 1;
  let bufStartLine = 1;
  let i = 0;
  // Strip line comments and block comments before splitting; keeps depth
  // counting honest when comments contain parens or semicolons.
  const stripped = stripSqlComments(source);
  while (i < stripped.length) {
    const ch = stripped[i]!;
    if (ch === "\n") line++;
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === ";" && depth === 0) {
      const text = buf.trim();
      if (text) out.push({ text, line: bufStartLine });
      buf = "";
      bufStartLine = line;
    } else {
      if (!buf && ch !== "\n" && ch !== " " && ch !== "\t") bufStartLine = line;
      buf += ch;
    }
    i++;
  }
  const tail = buf.trim();
  if (tail) out.push({ text: tail, line: bufStartLine });
  return out;
}

export async function rlsMissingScan(
  ctx: ScanContext
): Promise<readonly RawFinding[]> {
  const summaries: RlsMigrationSummary = {
    tablesByName: new Map(),
    enabledTables: new Set(),
    tablesWithPolicy: new Set(),
  };

  for await (const entry of walk(ctx.projectPath, { includeRoots: ["supabase"] })) {
    if (!entry.relativePath.toLowerCase().endsWith(".sql")) continue;
    let source: string;
    try {
      source = await fs.readFile(entry.absolutePath, "utf-8");
    } catch {
      continue;
    }
    const { creates, enables, policies } = parseMigration(source, entry.relativePath);
    for (const c of creates) {
      // Last write wins — a later migration may redefine the table.
      summaries.tablesByName.set(c.name, c);
    }
    for (const t of enables) summaries.enabledTables.add(t);
    for (const t of policies) summaries.tablesWithPolicy.add(t);
  }

  const findings: RawFinding[] = [];
  for (const [name, info] of summaries.tablesByName) {
    if (info.piiColumns.length === 0) continue;
    const isEnabled = summaries.enabledTables.has(name);
    if (!isEnabled) {
      findings.push({
        class: "auth",
        ruleId: "rls-missing/no-rls-on-pii-table",
        severity: 9,
        blastRadius: 2.5,
        confidence: 0.7,
        difficulty: 1.5,
        file: info.file,
        lineStart: info.line,
        lineEnd: info.line,
        humanExplanation: humanExplanationNoRls(name, info.piiColumns),
        codeEvidence: `CREATE TABLE ${name} (… ${info.piiColumns.join(", ")} …)`,
      });
    }
    if (!isEnabled && summaries.tablesWithPolicy.has(name)) {
      findings.push({
        class: "auth",
        ruleId: "rls-missing/policy-without-enable",
        severity: 9,
        blastRadius: 2.5,
        confidence: 0.85,
        difficulty: 1,
        file: info.file,
        lineStart: info.line,
        lineEnd: info.line,
        humanExplanation: humanExplanationPolicyWithoutEnable(name),
        codeEvidence: `CREATE POLICY … ON ${name} (no ENABLE ROW LEVEL SECURITY)`,
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
