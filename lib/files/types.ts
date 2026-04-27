// File ingestion types per spec.md §4 data model and build-order.md C1-C8.
//
// At C1 these live in component state only; C2 onwards adds real extraction
// and persistence to the sidecar (a `files` table FK'd to `projects`).

export type IngestedFileStatus = "pending" | "processing" | "done" | "error";

export type IngestedFileKind =
  | "document" // .pdf, .docx, .md, .txt
  | "image" // .png, .jpg, .jpeg, .webp
  | "schema" // .sql, .json (json-schema), .yaml (openapi)
  | "data" // .csv, .json (data sample), .sql (dump)
  | "spreadsheet" // .xlsx, .xls, .ods — parsed client-side via lib/spreadsheet
  | "url" // a URL pasted/dropped instead of a file
  | "unknown";

export interface IngestedFile {
  /** Stable per-session id; replaced by the DB ULID once persisted at C2+. */
  id: string;
  name: string;
  /** Best-guess kind from the extension or MIME type. */
  kind: IngestedFileKind;
  /** Bytes; -1 for URLs and unknowns. */
  size: number;
  status: IngestedFileStatus;
  /** Human-readable status detail (e.g. "Reading PDF...", "Parsed 12 rows"). */
  statusMessage?: string;
  /** Filled by C2-C7 once extraction completes. */
  summary?: string;
  /** Filled by C7 if the PII guard finds anything sensitive. */
  hasPiiWarning?: boolean;
  droppedAt: number;
}

const DOCUMENT_EXTENSIONS = new Set(["pdf", "docx", "md", "txt"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
const SCHEMA_EXTENSIONS = new Set(["sql", "yaml", "yml"]);
const DATA_EXTENSIONS = new Set(["csv", "tsv"]);
const SPREADSHEET_EXTENSIONS = new Set(["xlsx", "xls", "ods"]);

/**
 * Best-guess kind from filename. JSON is overloaded (schema vs data sample)
 * and falls into "schema" by default; the C4/C5 ingestion pipeline can
 * inspect content and reclassify.
 */
export function classifyByName(name: string): IngestedFileKind {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (DOCUMENT_EXTENSIONS.has(ext)) return "document";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (SCHEMA_EXTENSIONS.has(ext)) return "schema";
  if (DATA_EXTENSIONS.has(ext)) return "data";
  if (SPREADSHEET_EXTENSIONS.has(ext)) return "spreadsheet";
  if (ext === "json") return "schema";
  return "unknown";
}
