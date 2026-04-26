import { extractText as unpdfExtract } from "unpdf";
import * as fs from "node:fs/promises";
import { z } from "zod";

import type { IngestedFileKindLite } from "./types-shim.js";

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
