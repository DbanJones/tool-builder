import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { extractText as unpdfExtract } from "unpdf";
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
