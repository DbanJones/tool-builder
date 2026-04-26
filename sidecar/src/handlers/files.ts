import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { parse as parseCsv } from "csv-parse/sync";
import * as yaml from "js-yaml";
import { parse as parseHtml } from "node-html-parser";
import sqlParserModule from "node-sql-parser";
import { extractText as unpdfExtract } from "unpdf";
import { z } from "zod";

import type { IngestedFileKindLite } from "./types-shim.js";

// node-sql-parser is published as CommonJS; under ESM we have to import the
// default and destructure. Named import would throw at runtime even though
// TS would let it through.
const { Parser: SqlParser } = sqlParserModule;

// Extension -> kind mirror of lib/files/types.ts classifyByName, kept here so
// the sidecar doesn't import from the main app. Keep these two in sync.
const DOCUMENT_EXTS = new Set(["pdf", "docx", "md", "txt"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

function classifyByPath(p: string): IngestedFileKindLite {
  const lower = p.toLowerCase();
  const ext = lower.split(".").pop() ?? "";
  if (DOCUMENT_EXTS.has(ext)) return "document";
  if (IMAGE_EXTS.has(ext)) return "image";
  return "unknown";
}

const ExtractParamsSchema = z.object({
  path: z.string().min(1),
});

export interface ExtractTextResult {
  kind: IngestedFileKindLite;
  /** Plain text content. May be very long; the caller is expected to summarise/truncate. */
  text: string;
  /** First ~500 chars as a quick summary for the chat UI. */
  summary: string;
  /** Page count for PDFs; null otherwise. */
  pages: number | null;
  /** Raw byte size of the file we read. */
  sizeBytes: number;
}

const SUMMARY_LEN = 500;

function makeSummary(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= SUMMARY_LEN) return collapsed;
  return collapsed.slice(0, SUMMARY_LEN - 3) + "...";
}

/**
 * Extract plain text from a document file. Per build-order.md C2.
 *
 * Supported:
 * - .pdf via unpdf (Mozilla pdf.js underneath, no native deps)
 * - .docx via mammoth (`extractRawText`)
 * - .md and .txt via direct UTF-8 read
 *
 * Other extensions throw with a clear message; the caller (UI) decides
 * whether to surface that to the novice or queue a different handler
 * (image vision at C3, schema parse at C4, etc.).
 */
export async function extractText(rawParams: unknown): Promise<ExtractTextResult> {
  const { path } = ExtractParamsSchema.parse(rawParams);
  const ext = path.toLowerCase().split(".").pop() ?? "";
  const kind = classifyByPath(path);
  const stat = await fs.stat(path);
  const sizeBytes = stat.size;

  if (ext === "md" || ext === "txt") {
    const text = await fs.readFile(path, "utf8");
    return { kind, text, summary: makeSummary(text), pages: null, sizeBytes };
  }

  if (ext === "pdf") {
    const buffer = await fs.readFile(path);
    const result = await unpdfExtract(new Uint8Array(buffer));
    const text = Array.isArray(result.text) ? result.text.join("\n\n") : result.text;
    return {
      kind,
      text,
      summary: makeSummary(text),
      pages: result.totalPages ?? null,
      sizeBytes,
    };
  }

  if (ext === "docx") {
    // Lazy import keeps mammoth out of the cold-start path for non-DOCX runs.
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ path });
    return {
      kind,
      text: result.value,
      summary: makeSummary(result.value),
      pages: null,
      sizeBytes,
    };
  }

  throw new Error(
    `extractText: unsupported extension '.${ext}' (supported: pdf, docx, md, txt). ` +
      "Other kinds will route through C3 (image vision) or C4-C5 (schema/data) pipelines.",
  );
}

// ---------- Image vision (C3) ----------
//
// summariseImage is a tiered handler. Per the human's 2026-04-26 direction:
//   Tier 1: try the `claude` CLI with the image attached via @path syntax.
//   Tier 2: fall back to Anthropic Messages API if ANTHROPIC_API_KEY is set.
//   Tier 3: fall back to DeepSeek API if DEEPSEEK_API_KEY is set.
//   If all tiers unavailable, throw a clear error pointing the user at the
//   env vars they could set.
//
// The CLI path is preferred because it inherits the user's existing claude
// auth (subscription or API key). The API tiers only kick in if the CLI
// errors or if the user has explicitly opted into a direct-API path with an
// env var.

const SummariseImageParamsSchema = z.object({
  path: z.string().min(1),
});

export interface SummariseImageResult {
  kind: IngestedFileKindLite;
  /** Human-readable description of the image content. */
  summary: string;
  /** Which tier produced the answer: "claude_cli" | "anthropic_api" | "deepseek_api". */
  via: "claude_cli" | "anthropic_api" | "deepseek_api";
  /** Bytes of the image read off disk. */
  sizeBytes: number;
}

const VISION_PROMPT =
  "Describe this image in 2-3 sentences. Focus on UI elements, layout, and any visible copy or labels. Be concrete; avoid hedging language.";

const VISION_MODEL_ANTHROPIC = "claude-sonnet-4-6";
const VISION_MODEL_DEEPSEEK = "deepseek-vl";
const VISION_MAX_TOKENS = 400;
const VISION_TIMEOUT_MS = 60_000;

function mediaTypeForExt(ext: string): string {
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "application/octet-stream";
}

async function tryClaudeCliVision(imagePath: string): Promise<string> {
  // Use claude CLI with the image attached via the @path syntax. -p mode,
  // JSON output for deterministic parsing.
  return new Promise((resolve, reject) => {
    const child = spawn(
      "claude",
      ["-p", `${VISION_PROMPT}\n\n@${imagePath}`, "--output-format", "json"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`claude CLI timed out after ${VISION_TIMEOUT_MS}ms`));
    }, VISION_TIMEOUT_MS);
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude CLI exited ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        const parsed: unknown = JSON.parse(stdout);
        const result = (parsed as { result?: unknown }).result;
        if (typeof result === "string" && result.trim().length > 0) {
          resolve(result.trim());
          return;
        }
        reject(new Error(`claude CLI returned no text result: ${stdout.slice(0, 200)}`));
      } catch (e) {
        reject(new Error(`failed to parse claude CLI output: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
  });
}

async function tryAnthropicVisionApi(imagePath: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("ANTHROPIC_API_KEY not set");
  }
  const ext = imagePath.toLowerCase().split(".").pop() ?? "";
  const buffer = await fs.readFile(imagePath);
  const base64 = buffer.toString("base64");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: VISION_MODEL_ANTHROPIC,
      max_tokens: VISION_MAX_TOKENS,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaTypeForExt(ext), data: base64 },
            },
            { type: "text", text: VISION_PROMPT },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic API ${response.status}: ${body.slice(0, 300)}`);
  }
  const data = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const textBlock = data.content?.find((b) => b.type === "text");
  if (textBlock?.text === undefined || textBlock.text.length === 0) {
    throw new Error("Anthropic API returned no text content");
  }
  return textBlock.text.trim();
}

async function tryDeepseekVisionApi(imagePath: string): Promise<string> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("DEEPSEEK_API_KEY not set");
  }
  const ext = imagePath.toLowerCase().split(".").pop() ?? "";
  const buffer = await fs.readFile(imagePath);
  const dataUri = `data:${mediaTypeForExt(ext)};base64,${buffer.toString("base64")}`;

  // DeepSeek's chat-completions endpoint accepts OpenAI-compatible image_url
  // content blocks (data: URIs supported).
  const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: VISION_MODEL_DEEPSEEK,
      max_tokens: VISION_MAX_TOKENS,
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: dataUri } },
            { type: "text", text: VISION_PROMPT },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`DeepSeek API ${response.status}: ${body.slice(0, 300)}`);
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data.choices?.[0]?.message?.content;
  if (text === undefined || text.trim().length === 0) {
    throw new Error("DeepSeek API returned no content");
  }
  return text.trim();
}

/**
 * Summarise an image using vision models, falling back through tiers.
 * Per build-order.md C3 + ADR-0002 + the human's 2026-04-26 fallback direction.
 */
export async function summariseImage(rawParams: unknown): Promise<SummariseImageResult> {
  const { path } = SummariseImageParamsSchema.parse(rawParams);
  const ext = path.toLowerCase().split(".").pop() ?? "";
  if (!IMAGE_EXTS.has(ext)) {
    throw new Error(
      `summariseImage: '${path}' is not a supported image (png/jpg/jpeg/webp/gif).`,
    );
  }
  const stat = await fs.stat(path);
  const sizeBytes = stat.size;

  const errors: string[] = [];

  // Tier 1: claude CLI.
  try {
    const summary = await tryClaudeCliVision(path);
    return { kind: "image", summary, via: "claude_cli", sizeBytes };
  } catch (e) {
    errors.push(`claude CLI: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Tier 2: Anthropic API (if env var set).
  if (process.env.ANTHROPIC_API_KEY !== undefined && process.env.ANTHROPIC_API_KEY.length > 0) {
    try {
      const summary = await tryAnthropicVisionApi(path);
      return { kind: "image", summary, via: "anthropic_api", sizeBytes };
    } catch (e) {
      errors.push(`Anthropic API: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Tier 3: DeepSeek API (if env var set).
  if (process.env.DEEPSEEK_API_KEY !== undefined && process.env.DEEPSEEK_API_KEY.length > 0) {
    try {
      const summary = await tryDeepseekVisionApi(path);
      return { kind: "image", summary, via: "deepseek_api", sizeBytes };
    } catch (e) {
      errors.push(`DeepSeek API: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  throw new Error(
    `summariseImage: all vision tiers failed. Set ANTHROPIC_API_KEY or DEEPSEEK_API_KEY for an API fallback if claude CLI does not support images on this version. Tier errors:\n${errors.join("\n")}`,
  );
}

// ---------- Schema parsing (C4) ----------
//
// parseSchema dispatches by file extension:
//   .sql  -> node-sql-parser; walks the AST to extract CREATE TABLE info.
//   .json -> JSON.parse; treats top-level `properties` as a JSON-Schema-style
//            description. Reclassifies as OpenAPI if it contains an `openapi`
//            or `swagger` field.
//   .yaml/.yml -> js-yaml.load; treated as OpenAPI if `openapi`/`swagger` field
//            present, else unsupported.
//   OpenAPI documents (JSON or YAML) are dereferenced via @apidevtools/swagger-parser
//   for accurate path/method enumeration.
//
// Returns a normalised description that the chat UI can show as a one-line
// summary plus a structured `details` blob for downstream use.

const ParseSchemaParamsSchema = z.object({
  path: z.string().min(1),
});

export type SchemaFormat = "sql" | "json-schema" | "openapi";

export interface SchemaTable {
  name: string;
  columns: Array<{ name: string; type: string; nullable: boolean; primaryKey: boolean }>;
}

export interface SchemaJsonShape {
  topLevelType: "object" | "array" | "string" | "number" | "boolean" | "unknown";
  topLevelProperties: string[];
}

export interface SchemaOpenApiPath {
  path: string;
  methods: string[];
}

export interface ParseSchemaResult {
  kind: IngestedFileKindLite;
  format: SchemaFormat;
  summary: string;
  /** Filled when format = "sql". */
  tables?: SchemaTable[];
  /** Filled when format = "json-schema". */
  jsonShape?: SchemaJsonShape;
  /** Filled when format = "openapi". */
  openapi?: { title: string; version: string; paths: SchemaOpenApiPath[] };
  sizeBytes: number;
}

const SQL_EXTS = new Set(["sql"]);
const JSON_EXTS = new Set(["json"]);
const YAML_EXTS = new Set(["yaml", "yml"]);

// node-sql-parser returns column references as either plain strings OR
// expression objects of shape { expr: { type: "default", value: "<name>" } }
// depending on the column reference style. Normalise to a string.
type SqlColumnRef = string | { expr?: { value?: string } } | { value?: string };

interface SqlAstCreateTable {
  type: "create";
  keyword: "table";
  table?: Array<{ table: string }>;
  create_definitions?: Array<{
    resource?: string;
    column?: { column: SqlColumnRef };
    definition?: { dataType?: string };
    nullable?: { type?: string; value?: string };
    primary_key?: string | null;
    unique?: string | null;
  }>;
}

function readColumnName(ref: SqlColumnRef): string {
  if (typeof ref === "string") return ref;
  if ("expr" in ref && ref.expr?.value !== undefined) return ref.expr.value;
  if ("value" in ref && ref.value !== undefined) return ref.value;
  return "(unknown)";
}

function parseSqlSchema(sql: string): SchemaTable[] {
  const parser = new SqlParser();
  // Default to postgres dialect; node-sql-parser also supports mysql/sqlite/etc.
  const ast = parser.astify(sql, { database: "postgresql" });
  const statements = Array.isArray(ast) ? ast : [ast];
  const tables: SchemaTable[] = [];
  for (const stmt of statements as Array<unknown>) {
    const s = stmt as SqlAstCreateTable;
    if (s?.type !== "create" || s.keyword !== "table") continue;
    const tableName = s.table?.[0]?.table ?? "(unknown)";
    const columns: SchemaTable["columns"] = [];
    for (const def of s.create_definitions ?? []) {
      if (def.resource !== "column" || !def.column) continue;
      const colName = readColumnName(def.column.column);
      const dataType = def.definition?.dataType ?? "unknown";
      // node-sql-parser puts NOT NULL at def.nullable.type === "not null".
      const explicitNotNull = def.nullable?.type === "not null";
      const primaryKey =
        def.primary_key === "primary key" ||
        (typeof def.primary_key === "string" && def.primary_key.toLowerCase().includes("primary"));
      // Primary key columns are implicitly NOT NULL.
      const nullable = !explicitNotNull && !primaryKey;
      columns.push({ name: colName, type: dataType, nullable, primaryKey });
    }
    tables.push({ name: tableName, columns });
  }
  return tables;
}

function parseJsonShape(value: unknown): SchemaJsonShape {
  let topLevelType: SchemaJsonShape["topLevelType"];
  if (Array.isArray(value)) topLevelType = "array";
  else if (value === null) topLevelType = "unknown";
  else if (typeof value === "object") topLevelType = "object";
  else if (typeof value === "string") topLevelType = "string";
  else if (typeof value === "number") topLevelType = "number";
  else if (typeof value === "boolean") topLevelType = "boolean";
  else topLevelType = "unknown";

  const props: string[] = [];
  if (topLevelType === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    // JSON Schema convention: `properties` holds the field names.
    const properties = obj.properties;
    if (properties && typeof properties === "object" && !Array.isArray(properties)) {
      props.push(...Object.keys(properties));
    } else {
      // Fall back to top-level keys for non-schema-shaped JSON.
      props.push(...Object.keys(obj));
    }
  }
  return { topLevelType, topLevelProperties: props };
}

interface OpenApiDoc {
  openapi?: string;
  swagger?: string;
  info?: { title?: string; version?: string };
  paths?: Record<string, Record<string, unknown>>;
}

async function parseOpenApi(
  doc: unknown,
): Promise<{ title: string; version: string; paths: SchemaOpenApiPath[] }> {
  const SwaggerParserModule = await import("@apidevtools/swagger-parser");
  const SwaggerParser = SwaggerParserModule.default;
  // bundle() resolves $refs without strict validation; the upload may be
  // a fragment so we tolerate non-strict docs. The cast to the function's
  // own parameter type sidesteps the openapi-types Document constraint when
  // the input is `unknown` (we already null-guarded above).
  const bundled = (await SwaggerParser.bundle(
    doc as Parameters<typeof SwaggerParser.bundle>[0],
  )) as OpenApiDoc;
  const paths: SchemaOpenApiPath[] = [];
  for (const [pathKey, methodMap] of Object.entries(bundled.paths ?? {})) {
    paths.push({
      path: pathKey,
      methods: Object.keys(methodMap).map((m) => m.toUpperCase()).sort(),
    });
  }
  paths.sort((a, b) => a.path.localeCompare(b.path));
  return {
    title: bundled.info?.title ?? "(untitled)",
    version: bundled.info?.version ?? "(no version)",
    paths,
  };
}

export async function parseSchema(rawParams: unknown): Promise<ParseSchemaResult> {
  const { path } = ParseSchemaParamsSchema.parse(rawParams);
  const ext = path.toLowerCase().split(".").pop() ?? "";
  const stat = await fs.stat(path);
  const sizeBytes = stat.size;

  if (SQL_EXTS.has(ext)) {
    const sql = await fs.readFile(path, "utf8");
    const tables = parseSqlSchema(sql);
    const summary =
      tables.length === 0
        ? "SQL file contained no CREATE TABLE statements."
        : `SQL: ${tables.length} table${tables.length === 1 ? "" : "s"} (${tables.map((t) => t.name).join(", ")}).`;
    return { kind: "schema", format: "sql", summary, tables, sizeBytes };
  }

  if (JSON_EXTS.has(ext)) {
    const text = await fs.readFile(path, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as { openapi?: unknown; swagger?: unknown };
      if (obj.openapi !== undefined || obj.swagger !== undefined) {
        const openapi = await parseOpenApi(parsed);
        const summary = `OpenAPI ${openapi.title} v${openapi.version}: ${openapi.paths.length} path${openapi.paths.length === 1 ? "" : "s"}.`;
        return { kind: "schema", format: "openapi", summary, openapi, sizeBytes };
      }
    }
    const jsonShape = parseJsonShape(parsed);
    const summary =
      jsonShape.topLevelProperties.length === 0
        ? `JSON Schema (${jsonShape.topLevelType}) with no top-level properties.`
        : `JSON Schema (${jsonShape.topLevelType}): ${jsonShape.topLevelProperties.length} top-level field${jsonShape.topLevelProperties.length === 1 ? "" : "s"} (${jsonShape.topLevelProperties.slice(0, 5).join(", ")}${jsonShape.topLevelProperties.length > 5 ? ", ..." : ""}).`;
    return { kind: "schema", format: "json-schema", summary, jsonShape, sizeBytes };
  }

  if (YAML_EXTS.has(ext)) {
    const text = await fs.readFile(path, "utf8");
    const parsed: unknown = yaml.load(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as { openapi?: unknown; swagger?: unknown };
      if (obj.openapi !== undefined || obj.swagger !== undefined) {
        const openapi = await parseOpenApi(parsed);
        const summary = `OpenAPI ${openapi.title} v${openapi.version}: ${openapi.paths.length} path${openapi.paths.length === 1 ? "" : "s"}.`;
        return { kind: "schema", format: "openapi", summary, openapi, sizeBytes };
      }
    }
    throw new Error(
      `parseSchema: '${path}' is YAML but does not contain an 'openapi' or 'swagger' field. Only OpenAPI YAML is supported.`,
    );
  }

  throw new Error(
    `parseSchema: unsupported extension '.${ext}' (supported: sql, json, yaml, yml).`,
  );
}

// ---------- Data sample (C5) ----------
//
// Reads the first SAMPLE_ROW_LIMIT rows of a CSV or array-of-objects JSON,
// infers a column type per field, and emits a candidate Drizzle SQLite
// schema as a TS snippet. SQL-dump support (extracting INSERT data + the
// embedded CREATE TABLE) is deferred — drift D-011 — pointing the user
// at parseSchema for the schema half in the meantime.

const ParseDataSampleParamsSchema = z.object({
  path: z.string().min(1),
});

const SAMPLE_ROW_LIMIT = 100;

export type DataInferredType =
  | "integer"
  | "number"
  | "boolean"
  | "date"
  | "text"
  | "unknown";

export interface DataColumnSummary {
  name: string;
  inferredType: DataInferredType;
  nonNullCount: number;
  nullCount: number;
  examples: string[];
}

export interface ParseDataSampleResult {
  kind: IngestedFileKindLite;
  format: "csv" | "json-data";
  totalRowsObserved: number;
  sampledRows: number;
  columns: DataColumnSummary[];
  /** A Drizzle TS snippet the chat can show to the novice. */
  candidateDrizzleSchema: string;
  summary: string;
  sizeBytes: number;
}

const INTEGER_RX = /^-?\d+$/;
const NUMBER_RX = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;
const ISO_DATE_RX = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[-+]\d{2}:?\d{2})?)?$/;

function inferOne(value: string): DataInferredType {
  if (value === "" || value.toLowerCase() === "null") return "unknown";
  if (value === "true" || value === "false") return "boolean";
  if (INTEGER_RX.test(value)) return "integer";
  if (NUMBER_RX.test(value)) return "number";
  if (ISO_DATE_RX.test(value)) return "date";
  return "text";
}

// Widen integer -> number -> text; boolean stays unless mixed; date stays
// unless mixed. unknown defers to whatever the next non-null gives us.
function widen(a: DataInferredType, b: DataInferredType): DataInferredType {
  if (a === "unknown") return b;
  if (b === "unknown") return a;
  if (a === b) return a;
  if ((a === "integer" && b === "number") || (a === "number" && b === "integer")) return "number";
  return "text";
}

function inferColumn(values: string[]): DataInferredType {
  let result: DataInferredType = "unknown";
  for (const v of values) {
    result = widen(result, inferOne(v));
  }
  return result;
}

function drizzleType(inferred: DataInferredType): string {
  switch (inferred) {
    case "integer":
      return "integer";
    case "number":
      return "real";
    case "boolean":
      return 'integer({ mode: "boolean" })';
    case "date":
      return "integer"; // unix ms; mode: 'timestamp_ms' once we know caller wants Date objects
    case "text":
    case "unknown":
      return "text";
  }
}

function safeIdentifier(raw: string): string {
  // Lowercase, snake_case-ish, non-ascii stripped. Matches the broader
  // "filesystem-safe identifier" rule we use for project names.
  const lowered = raw.toLowerCase().trim();
  const collapsed = lowered.replace(/[^a-z0-9_]+/g, "_").replace(/_+/g, "_");
  const trimmed = collapsed.replace(/^_+|_+$/g, "");
  return trimmed.length > 0 ? trimmed : "col";
}

function buildDrizzleSchema(tableName: string, columns: DataColumnSummary[]): string {
  const lines = [
    `import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";`,
    "",
    `export const ${safeIdentifier(tableName)} = sqliteTable("${safeIdentifier(tableName)}", {`,
  ];
  for (const c of columns) {
    const colId = safeIdentifier(c.name);
    const t = drizzleType(c.inferredType);
    lines.push(`  ${colId}: ${t}("${colId}"),`);
  }
  lines.push("});");
  return lines.join("\n");
}

function parseCsvSample(text: string): { rows: Record<string, string>[]; total: number } {
  // csv-parse/sync streams the whole file but we slice afterwards. For
  // very large CSVs we'd switch to the streaming API + early-stop.
  const all = parseCsv(text, { columns: true, skip_empty_lines: true }) as Record<string, string>[];
  return { rows: all.slice(0, SAMPLE_ROW_LIMIT), total: all.length };
}

function parseJsonDataSample(value: unknown): { rows: Record<string, string>[]; total: number } {
  if (!Array.isArray(value)) {
    throw new Error("parseDataSample: JSON file is not an array of objects.");
  }
  const objs = value.filter((v): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v));
  if (objs.length === 0) {
    throw new Error("parseDataSample: JSON array contains no objects.");
  }
  // Stringify field values so the type inference shares one code path.
  const rows = objs.slice(0, SAMPLE_ROW_LIMIT).map((o) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o)) {
      out[k] = v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    }
    return out;
  });
  return { rows, total: objs.length };
}

function summariseColumns(rows: Record<string, string>[]): DataColumnSummary[] {
  if (rows.length === 0) return [];
  // Use first row's keys as the column set; non-uniform CSVs are not common.
  const first = rows[0];
  if (first === undefined) return [];
  const cols: DataColumnSummary[] = [];
  for (const name of Object.keys(first)) {
    const values: string[] = [];
    let nonNullCount = 0;
    let nullCount = 0;
    for (const row of rows) {
      const v = row[name] ?? "";
      if (v === "" || v.toLowerCase() === "null") {
        nullCount++;
      } else {
        nonNullCount++;
        values.push(v);
      }
    }
    const inferredType = inferColumn(values);
    cols.push({
      name,
      inferredType,
      nonNullCount,
      nullCount,
      examples: values.slice(0, 3),
    });
  }
  return cols;
}

export async function parseDataSample(rawParams: unknown): Promise<ParseDataSampleResult> {
  const { path } = ParseDataSampleParamsSchema.parse(rawParams);
  const ext = path.toLowerCase().split(".").pop() ?? "";
  const stat = await fs.stat(path);
  const sizeBytes = stat.size;

  if (ext === "csv" || ext === "tsv") {
    const text = await fs.readFile(path, "utf8");
    const { rows, total } = parseCsvSample(text);
    const columns = summariseColumns(rows);
    const tableName = path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "data";
    const candidateDrizzleSchema = buildDrizzleSchema(tableName, columns);
    const summary = `${ext.toUpperCase()}: ${total} row${total === 1 ? "" : "s"} observed (sampled ${rows.length}); ${columns.length} columns.`;
    return {
      kind: "data",
      format: "csv",
      totalRowsObserved: total,
      sampledRows: rows.length,
      columns,
      candidateDrizzleSchema,
      summary,
      sizeBytes,
    };
  }

  if (ext === "json") {
    const text = await fs.readFile(path, "utf8");
    const parsed: unknown = JSON.parse(text);
    const { rows, total } = parseJsonDataSample(parsed);
    const columns = summariseColumns(rows);
    const tableName = path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "data";
    const candidateDrizzleSchema = buildDrizzleSchema(tableName, columns);
    const summary = `JSON data: ${total} object${total === 1 ? "" : "s"} observed (sampled ${rows.length}); ${columns.length} keys.`;
    return {
      kind: "data",
      format: "json-data",
      totalRowsObserved: total,
      sampledRows: rows.length,
      columns,
      candidateDrizzleSchema,
      summary,
      sizeBytes,
    };
  }

  throw new Error(
    `parseDataSample: unsupported extension '.${ext}' (supported: csv, tsv, json). SQL dump support is deferred — see drift D-011.`,
  );
}

// ---------- Reference URL fetch (C6) ----------
//
// fetchUrl GETs the URL, parses the HTML, and returns the title, meta
// description, h1/h2 outline, and a short body snippet. The build-order's
// fuller "headless browser via Playwright + screenshot" flow is deferred
// (drift D-012) — playwright is a 250+MB browser binary in the sidecar
// and the textual extraction here covers the common case (novice drops
// a reference URL into the file panel; chat can ask follow-up questions).

const FetchUrlParamsSchema = z.object({
  url: z.string().min(1),
});

const URL_FETCH_TIMEOUT_MS = 15_000;
const BODY_SNIPPET_LEN = 600;

export interface FetchUrlResult {
  kind: IngestedFileKindLite;
  url: string;
  finalUrl: string;
  status: number;
  title: string | null;
  description: string | null;
  headings: string[];
  bodySnippet: string;
  summary: string;
  sizeBytes: number;
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function extractMetaDescription(root: ReturnType<typeof parseHtml>): string | null {
  // Prefer og:description (richer when set), fall back to standard meta.
  const og = root.querySelector('meta[property="og:description"]');
  const ogContent = og?.getAttribute("content");
  if (ogContent !== undefined && ogContent.trim().length > 0) return ogContent.trim();
  const std = root.querySelector('meta[name="description"]');
  const stdContent = std?.getAttribute("content");
  if (stdContent !== undefined && stdContent.trim().length > 0) return stdContent.trim();
  return null;
}

export async function fetchUrl(rawParams: unknown): Promise<FetchUrlResult> {
  const { url } = FetchUrlParamsSchema.parse(rawParams);

  // Validate it's a parseable http(s) URL before spawning a fetch.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`fetchUrl: '${url}' is not a valid URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`fetchUrl: only http(s) URLs are supported (got '${parsed.protocol}').`);
  }

  const response = await fetch(parsed.toString(), {
    redirect: "follow",
    signal: AbortSignal.timeout(URL_FETCH_TIMEOUT_MS),
    headers: {
      // Identify ourselves; some sites block unknown UAs.
      "user-agent": "BuilderBot/0.1 (+https://github.com/airtec/tool-builder)",
      accept: "text/html,application/xhtml+xml,*/*;q=0.8",
    },
  });

  const html = await response.text();
  const sizeBytes = html.length;
  const root = parseHtml(html);

  const titleEl = root.querySelector("title");
  const title = titleEl ? collapseWhitespace(titleEl.text) || null : null;
  const description = extractMetaDescription(root);

  const headings: string[] = [];
  for (const tag of ["h1", "h2"] as const) {
    for (const node of root.querySelectorAll(tag)) {
      const txt = collapseWhitespace(node.text);
      if (txt.length > 0 && headings.length < 10) headings.push(txt);
    }
  }

  // Strip script/style/svg from body before snippet extraction.
  for (const tag of ["script", "style", "noscript", "svg"] as const) {
    for (const node of root.querySelectorAll(tag)) node.remove();
  }
  const bodyText = collapseWhitespace(root.querySelector("body")?.text ?? root.text);
  const bodySnippet =
    bodyText.length <= BODY_SNIPPET_LEN
      ? bodyText
      : bodyText.slice(0, BODY_SNIPPET_LEN - 3) + "...";

  const summary = [
    title ? `${title}.` : null,
    description,
    headings.length > 0 ? `Headings: ${headings.slice(0, 5).join(" / ")}.` : null,
  ]
    .filter((s): s is string => s !== null && s.length > 0)
    .join(" ")
    .trim();

  return {
    kind: "url",
    url,
    finalUrl: response.url,
    status: response.status,
    title,
    description,
    headings,
    bodySnippet,
    summary: summary.length > 0 ? summary : "(no extractable summary; see bodySnippet)",
    sizeBytes,
  };
}
