// Schema graph for the target's Supabase migrations. Walks
// `supabase/migrations/*.sql`, parses CREATE TABLE columns + foreign
// keys via node-sql-parser, and combines that with regex-detected
// ALTER TABLE … ENABLE ROW LEVEL SECURITY and CREATE POLICY statements
// into a SchemaTable per logical table.
//
// Multiple migrations referring to the same table are merged: the most
// recent CREATE TABLE wins for column shape (a real migration would
// normally use ALTER for incremental edits, but the v1 detector treats
// "last write wins" as good enough — false negatives downrank in G4),
// and the union of every ENABLE/POLICY across files is taken.
//
// node-sql-parser sometimes refuses Postgres-specific RLS syntax, so we
// run the regex extraction against the comment-stripped source rather
// than relying on the parser for those clauses.

import * as fs from "node:fs/promises";
import sqlParserModule from "node-sql-parser";

import { walk } from "../detectors/walk.js";

const { Parser: SqlParser } = sqlParserModule;

export type PolicyAction = "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "ALL";

export interface SchemaColumn {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  foreignKey: { table: string; column: string } | null;
}

export interface SchemaPolicy {
  name: string;
  for: PolicyAction;
}

export interface SchemaTable {
  name: string;
  columns: SchemaColumn[];
  rlsEnabled: boolean;
  policies: SchemaPolicy[];
  /** Workspace-relative file + line where the CREATE TABLE lives. */
  source: { file: string; line: number };
}

interface SqlAstCreateTable {
  type?: string;
  keyword?: string;
  table?: Array<{ table?: string }>;
  create_definitions?: Array<{
    resource?: string;
    column?: { column?: string | { value?: string } };
    definition?: { dataType?: string };
    nullable?: { type?: string };
    primary_key?: string | null;
    reference_definition?: {
      table?: Array<{ table?: string }>;
      definition?: Array<{ column?: string | { value?: string } }>;
    };
  }>;
}

const ENABLE_RLS_RE =
  /\bALTER\s+TABLE\s+(?:ONLY\s+)?(?:\w+\.)?(?<table>"?\w+"?)\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY\b/gi;

// CREATE POLICY name ON [schema.]table [FOR action] …
// `for` is optional; default per Postgres docs is ALL.
const CREATE_POLICY_RE =
  /\bCREATE\s+POLICY\s+(?<name>\w+)\s+ON\s+(?:\w+\.)?(?<table>"?\w+"?)(?:\s+FOR\s+(?<action>SELECT|INSERT|UPDATE|DELETE|ALL))?/gi;

export function stripSqlComments(source: string): string {
  return source.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
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

interface StatementSlice {
  text: string;
  line: number;
}

function splitStatements(source: string): StatementSlice[] {
  const out: StatementSlice[] = [];
  let depth = 0;
  let buf = "";
  let line = 1;
  let bufStartLine = 1;
  const stripped = stripSqlComments(source);
  for (let i = 0; i < stripped.length; i++) {
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
  }
  const tail = buf.trim();
  if (tail) out.push({ text: tail, line: bufStartLine });
  return out;
}

interface MigrationParseResult {
  tables: Array<{
    name: string;
    columns: SchemaColumn[];
    line: number;
    file: string;
  }>;
  enables: Set<string>;
  policies: Array<{ table: string; name: string; for: PolicyAction }>;
}

export function parseMigrationStatements(
  source: string,
  relativePath: string
): MigrationParseResult {
  const tables: MigrationParseResult["tables"] = [];
  const enables = new Set<string>();
  const policies: MigrationParseResult["policies"] = [];

  const stripped = stripSqlComments(source);

  for (const m of stripped.matchAll(ENABLE_RLS_RE)) {
    if (m.groups?.table) enables.add(unquote(m.groups.table).toLowerCase());
  }
  for (const m of stripped.matchAll(CREATE_POLICY_RE)) {
    if (!m.groups?.table || !m.groups?.name) continue;
    const action = (m.groups.action ?? "ALL").toUpperCase() as PolicyAction;
    policies.push({
      table: unquote(m.groups.table).toLowerCase(),
      name: m.groups.name,
      for: action,
    });
  }

  const parser = new SqlParser();
  for (const stmt of splitStatements(source)) {
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
      const columns: SchemaColumn[] = [];
      for (const def of s.create_definitions ?? []) {
        if (def.resource !== "column" || !def.column) continue;
        const colName = readColumnName(def.column.column);
        if (!colName) continue;
        const dataType = def.definition?.dataType ?? "unknown";
        const explicitNotNull = def.nullable?.type === "not null";
        const primaryKey =
          typeof def.primary_key === "string" &&
          def.primary_key.toLowerCase().includes("primary");
        const ref = def.reference_definition;
        const fkTable = ref?.table?.[0]?.table;
        const fkCol = readColumnName(ref?.definition?.[0]?.column);
        const foreignKey =
          fkTable && fkCol ? { table: unquote(fkTable).toLowerCase(), column: fkCol } : null;
        columns.push({
          name: colName,
          type: dataType,
          nullable: !explicitNotNull && !primaryKey,
          primaryKey,
          foreignKey,
        });
      }
      tables.push({ name, columns, line: stmt.line, file: relativePath });
    }
  }

  return { tables, enables, policies };
}

/**
 * Walk supabase/migrations/*.sql and emit one SchemaTable per logical
 * table. The schema graph is the input to (a) the rls-missing detector
 * (which checks for missing RLS on PII tables), (b) future schema-aware
 * detectors, and (c) the Layer 2 validator's subgraph slice.
 */
export async function buildSchemaGraph(projectPath: string): Promise<SchemaTable[]> {
  const tablesByName = new Map<
    string,
    { name: string; columns: SchemaColumn[]; line: number; file: string }
  >();
  const enabledTables = new Set<string>();
  const policiesByTable = new Map<string, SchemaPolicy[]>();

  for await (const entry of walk(projectPath, { includeRoots: ["supabase"] })) {
    if (!entry.relativePath.toLowerCase().endsWith(".sql")) continue;
    let source: string;
    try {
      source = await fs.readFile(entry.absolutePath, "utf-8");
    } catch {
      continue;
    }
    const parsed = parseMigrationStatements(source, entry.relativePath);
    for (const t of parsed.tables) tablesByName.set(t.name, t);
    for (const e of parsed.enables) enabledTables.add(e);
    for (const p of parsed.policies) {
      const list = policiesByTable.get(p.table) ?? [];
      list.push({ name: p.name, for: p.for });
      policiesByTable.set(p.table, list);
    }
  }

  const out: SchemaTable[] = [];
  for (const [name, info] of tablesByName) {
    out.push({
      name,
      columns: info.columns,
      rlsEnabled: enabledTables.has(name),
      policies: policiesByTable.get(name) ?? [],
      source: { file: info.file, line: info.line },
    });
  }
  return out;
}
