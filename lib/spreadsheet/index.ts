// Port (per L3) over the SheetJS `xlsx` package. Keeps the rest of the
// codebase off direct SheetJS imports so we can swap to exceljs or
// read-excel-file later without a touch-everywhere change.

import { read, utils, type WorkSheet } from "xlsx";

export interface SpreadsheetSheet {
  name: string;
  rowCount: number;
  columnCount: number;
  /** First-row values used as column headers. May be empty strings if a cell is blank. */
  columns: readonly string[];
  /** Up to N rows from the top of the sheet (header excluded), each row trimmed
   *  to the column count. Used by the summary + the PII guard. */
  sampleRows: readonly (readonly string[])[];
}

export interface SpreadsheetParse {
  sheetCount: number;
  sheets: readonly SpreadsheetSheet[];
}

const SAMPLE_ROW_LIMIT = 10;

/**
 * Parse a spreadsheet's bytes into a structural summary. Doesn't touch the
 * filesystem; the caller has already read the bytes from the dropped File.
 *
 * Header row is taken from the first non-empty row of each sheet. Returns an
 * empty `columns` array if the sheet has no rows.
 */
export function parseSpreadsheet(buffer: ArrayBuffer): SpreadsheetParse {
  const workbook = read(new Uint8Array(buffer), { type: "array", cellDates: true });
  const sheets: SpreadsheetSheet[] = workbook.SheetNames.map((name) => {
    const ws = workbook.Sheets[name];
    if (!ws) {
      return { name, rowCount: 0, columnCount: 0, columns: [], sampleRows: [] };
    }
    return summariseSheet(name, ws);
  });
  return { sheetCount: sheets.length, sheets };
}

// Exported for unit tests so we can build WorkSheet objects via utils.aoa_to_sheet
// and exercise the summariser without round-tripping through write() + read()
// (which has produced flaky in-memory results).
export function summariseSheet(name: string, ws: WorkSheet): SpreadsheetSheet {
  // header:1 returns an array of arrays; defval:"" so missing cells become
  // empty strings rather than undefined (saves a downstream null check).
  const rows = utils.sheet_to_json<readonly unknown[]>(ws, { header: 1, defval: "" });
  if (rows.length === 0) {
    return { name, rowCount: 0, columnCount: 0, columns: [], sampleRows: [] };
  }
  const header = rows[0] ?? [];
  const columns = header.map((c) => stringifyCell(c));
  const columnCount = columns.length;
  // Data rows = everything after the header. Trim each to columnCount so a
  // straggler cell past the header doesn't unbalance the summary.
  const dataRows = rows.slice(1);
  const sampleRows = dataRows
    .slice(0, SAMPLE_ROW_LIMIT)
    .map((row) => row.slice(0, columnCount).map((c) => stringifyCell(c)));
  return {
    name,
    rowCount: dataRows.length,
    columnCount,
    columns,
    sampleRows,
  };
}

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * Format a SpreadsheetParse as a markdown summary suitable for display + for
 * writing alongside the saved file as `<name>.summary.md` (so Claude can read
 * the structure via its Read tool when the build runs).
 */
export function formatSummary(parse: SpreadsheetParse, sourceName: string): string {
  const lines: string[] = [
    `# Spreadsheet summary — ${sourceName}`,
    "",
    `Sheets: ${parse.sheetCount}`,
    "",
  ];
  for (const sheet of parse.sheets) {
    lines.push(`## ${sheet.name}`);
    lines.push(`Rows: ${sheet.rowCount} · Columns: ${sheet.columnCount}`);
    if (sheet.columns.length > 0) {
      lines.push(`Columns: ${sheet.columns.map((c) => `\`${c}\``).join(", ")}`);
    }
    if (sheet.sampleRows.length > 0) {
      lines.push("");
      lines.push("Sample rows:");
      lines.push("");
      lines.push(`| ${sheet.columns.join(" | ")} |`);
      lines.push(`| ${sheet.columns.map(() => "---").join(" | ")} |`);
      for (const row of sheet.sampleRows) {
        lines.push(`| ${row.map((c) => c.replaceAll("|", "\\|")).join(" | ")} |`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Plain-text version of the summary, used as the input to the PII guard.
 * Newline-separated so the guard's regexes line up with normal text.
 */
export function piiGuardText(parse: SpreadsheetParse): string {
  const parts: string[] = [];
  for (const sheet of parse.sheets) {
    parts.push(sheet.columns.join("\t"));
    for (const row of sheet.sampleRows) {
      parts.push(row.join("\t"));
    }
  }
  return parts.join("\n");
}
