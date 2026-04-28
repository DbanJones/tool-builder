// File ingestion orchestrator. Per build-order.md C8 (kit section 14.4.2):
// after a file lands in the file panel, save it to {project}/inputs/, route
// to the right sidecar handler by kind, run the PII guard on text outputs,
// and surface the summary back to the file panel.
//
// What this function deliberately does NOT do (drift D-013):
// - Post a chat message to the interview ("I see you uploaded X. Should I
//   proceed on that basis?") — the message-injection flow + answer-merging
//   side effects come in a follow-up.
// - Pause-and-ask on PII hits — the result includes the PII guard verdict
//   so the UI can decide. C8 surfaces the guard output but does not yet
//   render the confirm modal.

import { invoke } from "@tauri-apps/api/core";
import { errAsync, ResultAsync } from "neverthrow";

import { classifyByName, type IngestedFile, type IngestedFileKind } from "@/lib/files/types";
import { sidecarCall, type SidecarError } from "@/lib/sidecar/client";
import {
  formatSummary as formatSpreadsheetSummary,
  parseSpreadsheet,
  piiGuardText as spreadsheetPiiText,
} from "@/lib/spreadsheet";

export type IngestError =
  | { kind: "Filesystem"; message: string }
  | { kind: "Sidecar"; message: string };

interface ExtractTextResult {
  kind: string;
  text: string;
  summary: string;
  pages: number | null;
  sizeBytes: number;
}

interface SummariseImageResult {
  kind: string;
  summary: string;
  via: string;
  sizeBytes: number;
}

interface ParseSchemaResult {
  format: string;
  summary: string;
  sizeBytes: number;
}

interface ParseDataSampleResult {
  format: string;
  summary: string;
  sizeBytes: number;
  candidateDrizzleSchema: string;
}

interface PiiGuardResult {
  hasPii: boolean;
  hits: Array<{ kind: string; masked: string }>;
  redactedText: string;
}

export interface IngestResult {
  /** What the chat / file row should display. */
  summary: string;
  /** True when the PII guard found anything sensitive in the extracted text. */
  hasPiiWarning: boolean;
  /** Absolute path of the saved file. */
  storedPath: string;
}

const fromInvokeError = (e: unknown): IngestError => ({
  kind: "Filesystem",
  message: e instanceof Error ? e.message : String(e),
});

const fromSidecarError = (e: SidecarError): IngestError => ({
  kind: "Sidecar",
  message: e.kind === "Sidecar" ? `${e.code}: ${e.message}` : e.message,
});

async function readFileAsBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  // Avoid spreading a giant Uint8Array into String.fromCharCode (call-stack
  // overflow for large files); chunk it.
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 8 * 1024;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(bin);
}

function callExtractor(
  kind: IngestedFileKind,
  path: string,
): ResultAsync<{ summary: string; textForPiiGuard: string | null }, IngestError> {
  switch (kind) {
    case "document":
      return sidecarCall<ExtractTextResult>("files.extractText", { path })
        .mapErr(fromSidecarError)
        .map((r) => ({ summary: r.summary, textForPiiGuard: r.text }));
    case "image":
      return sidecarCall<SummariseImageResult>("files.summariseImage", { path })
        .mapErr(fromSidecarError)
        .map((r) => ({ summary: `${r.summary} (via ${r.via})`, textForPiiGuard: r.summary }));
    case "schema":
      return sidecarCall<ParseSchemaResult>("files.parseSchema", { path })
        .mapErr(fromSidecarError)
        .map((r) => ({ summary: r.summary, textForPiiGuard: null }));
    case "data":
      return sidecarCall<ParseDataSampleResult>("files.parseDataSample", { path })
        .mapErr(fromSidecarError)
        .map((r) => ({
          summary: `${r.summary} Candidate Drizzle:\n${r.candidateDrizzleSchema}`,
          // Candidate schema only — the sample row data could leak PII so we
          // do scan the whole schema string to be safe.
          textForPiiGuard: r.candidateDrizzleSchema,
        }));
    case "spreadsheet":
      // Spreadsheets are parsed client-side via lib/spreadsheet so we don't
      // need a sidecar handler / extra binary dep on the Node side. The
      // raw-bytes path goes through ingestSpreadsheet, not callExtractor.
      return errAsync<{ summary: string; textForPiiGuard: string | null }, IngestError>({
        kind: "Sidecar",
        message: "ingest: 'spreadsheet' is parsed client-side; should not reach callExtractor.",
      });
    case "url":
    case "unknown":
      return errAsync<{ summary: string; textForPiiGuard: string | null }, IngestError>({
        kind: "Sidecar",
        message: `ingest: kind '${kind}' is not handled here. URLs are pasted, not dropped; unknown files need a manual classify.`,
      });
  }
}

// Webview-side spreadsheet pipeline: parse with SheetJS, save the original
// xlsx + a sibling .summary.md so Claude can read the structure during the
// build via its filesystem tools.
function ingestSpreadsheet(
  file: File,
  projectPath: string,
): ResultAsync<IngestResult, IngestError> {
  return ResultAsync.fromPromise(file.arrayBuffer(), fromInvokeError).andThen((buf) => {
    let parse;
    try {
      parse = parseSpreadsheet(buf);
    } catch (e) {
      return errAsync<IngestResult, IngestError>({
        kind: "Filesystem",
        message: `Couldn't parse spreadsheet: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    const summaryMd = formatSpreadsheetSummary(parse, file.name);
    const piiText = spreadsheetPiiText(parse);

    return ResultAsync.fromPromise(readFileAsBase64(file), fromInvokeError)
      .andThen((xlsxB64) =>
        ResultAsync.fromPromise(
          invoke<string>("file_save_uploaded", {
            projectPath,
            name: file.name,
            contentBase64: xlsxB64,
          }),
          fromInvokeError,
        ),
      )
      .andThen((storedPath) =>
        ResultAsync.fromPromise(
          invoke<string>("file_save_uploaded", {
            projectPath,
            name: `${file.name}.summary.md`,
            contentBase64: encodeUtf8Base64(summaryMd),
          }),
          fromInvokeError,
        ).andThen(() =>
          sidecarCall<PiiGuardResult>("files.guardPii", {
            text: piiText,
            source: file.name,
          })
            .mapErr(fromSidecarError)
            .map<IngestResult>((g) => ({
              summary: g.hasPii
                ? `${compactSummary(g.redactedText, 900)}\n\n_PII detected (${g.hits.length} hit${g.hits.length === 1 ? "" : "s"}); redacted summary shown for review._`
                : summaryMd,
              hasPiiWarning: g.hasPii,
              storedPath,
            })),
        ),
      );
  });
}

function encodeUtf8Base64(s: string): string {
  // btoa rejects code points > 0xFF, so go through TextEncoder first.
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  const chunk = 8 * 1024;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(bin);
}

function compactSummary(text: string, max = 500): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 3) + "...";
}

/**
 * Orchestrate the C2-C7 pipeline for a single dropped file. Saves to disk,
 * dispatches by kind, and runs the PII guard on text outputs. Returns a
 * summary the UI can show in the file row.
 */
export function ingestFile(
  file: File,
  projectPath: string,
): ResultAsync<IngestResult, IngestError> {
  const kind = classifyByName(file.name);
  if (kind === "spreadsheet") return ingestSpreadsheet(file, projectPath);

  return ResultAsync.fromPromise(readFileAsBase64(file), fromInvokeError)
    .andThen((b64) =>
      ResultAsync.fromPromise(
        invoke<string>("file_save_uploaded", {
          projectPath,
          name: file.name,
          contentBase64: b64,
        }),
        fromInvokeError,
      ),
    )
    .andThen((storedPath) =>
      callExtractor(kind, storedPath).andThen(({ summary, textForPiiGuard }) => {
        if (textForPiiGuard === null) {
          return ResultAsync.fromSafePromise(
            Promise.resolve<IngestResult>({ summary, hasPiiWarning: false, storedPath }),
          );
        }
        return sidecarCall<PiiGuardResult>("files.guardPii", {
          text: textForPiiGuard,
          source: file.name,
        })
          .mapErr(fromSidecarError)
          .map<IngestResult>((g) => ({
            summary: g.hasPii
              ? `${compactSummary(g.redactedText)}\nPII detected (${g.hits.length} hit${g.hits.length === 1 ? "" : "s"}); redacted summary shown for review.`
              : summary,
            hasPiiWarning: g.hasPii,
            storedPath,
          }));
      }),
    );
}

/** Small helper for the UI to know which IngestedFile statuses still need work. */
export function isPending(file: IngestedFile): boolean {
  return file.status === "pending";
}
