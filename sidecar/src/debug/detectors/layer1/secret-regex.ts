// Hardcoded-secret detector. Patterns cover the highest-frequency vendor
// keys observed in vibecoded apps (per debug_repair_engine_spec.md §B.1.3
// row 3: 60%+ of Q1-2026 vibe-coded apps exposed keys). Each pattern has
// a vendor-specific prefix that gives high precision; generic high-entropy
// catch-alls are deferred to G7 because their FP rate is higher than the
// hit rate at v1.
//
// Confidence is split: prefix-bearing matches sit at 0.9 (basically
// deterministic — there is no reason for a real ghp_ token to appear in
// committed source). Generic ENV-shaped matches sit at 0.6.

import * as fs from "node:fs/promises";

import type { Detector, RawFinding, ScanContext } from "../types.js";
import { walk } from "../walk.js";

interface SecretPattern {
  id: string;
  description: string;
  /** Must match across one line only — `m` flag set at compile time. */
  pattern: RegExp;
  confidence: number;
}

const PATTERNS: readonly SecretPattern[] = [
  {
    id: "aws-access-key",
    description: "AWS access key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    confidence: 0.9,
  },
  {
    id: "github-pat",
    description: "GitHub personal access token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,251}\b/g,
    confidence: 0.9,
  },
  {
    id: "stripe-live-secret",
    description: "Stripe live secret key",
    pattern: /\bsk_live_[A-Za-z0-9]{20,99}\b/g,
    confidence: 0.9,
  },
  {
    id: "stripe-live-publishable",
    description: "Stripe live publishable key",
    pattern: /\bpk_live_[A-Za-z0-9]{20,99}\b/g,
    confidence: 0.9,
  },
  {
    id: "anthropic-api-key",
    description: "Anthropic API key",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{30,}\b/g,
    confidence: 0.9,
  },
  {
    id: "openai-api-key",
    description: "OpenAI API key",
    pattern: /\bsk-[A-Za-z0-9]{48}\b/g,
    confidence: 0.85,
  },
  {
    id: "google-api-key",
    description: "Google API key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    confidence: 0.85,
  },
  {
    id: "slack-bot-token",
    description: "Slack bot or user token",
    pattern: /\bxox[bporsa]-[0-9A-Za-z-]{10,}\b/g,
    confidence: 0.9,
  },
];

const READABLE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".env",
  ".md",
  ".html",
  ".sql",
]);

const MAX_FILE_BYTES = 1_048_576; // 1 MB

// Lines containing one of these tokens are likely placeholders ("YOUR_KEY",
// "EXAMPLE_TOKEN", schema/docstring snippets). We still flag them but at
// half confidence so they sort below real findings.
const PLACEHOLDER_RE =
  /\b(EXAMPLE|YOUR[_-]?KEY|YOUR[_-]?TOKEN|REPLACE[_-]?ME|PLACEHOLDER|FAKE|DUMMY)\b/i;

export const secretRegexDetector: Detector = {
  id: "secret-regex",
  run(ctx: ScanContext): Promise<readonly RawFinding[]> {
    return scan(ctx);
  },
};

async function scan(ctx: ScanContext): Promise<readonly RawFinding[]> {
  const findings: RawFinding[] = [];
  for await (const entry of walk(ctx.projectPath)) {
    const ext = extOf(entry.relativePath);
    if (!READABLE_EXTS.has(ext)) continue;

    const stat = await fs.stat(entry.absolutePath).catch(() => null);
    if (!stat || stat.size > MAX_FILE_BYTES) continue;

    let content: string;
    try {
      content = await fs.readFile(entry.absolutePath, "utf-8");
    } catch {
      continue;
    }

    findings.push(...scanContent(entry.relativePath, content));
  }
  return findings;
}

function scanContent(relativePath: string, content: string): RawFinding[] {
  const found: RawFinding[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (const pat of PATTERNS) {
      pat.pattern.lastIndex = 0;
      const match = pat.pattern.exec(line);
      if (!match) continue;
      const isPlaceholder = PLACEHOLDER_RE.test(line);
      found.push({
        class: "security",
        ruleId: `secret-regex/${pat.id}`,
        severity: 9,
        blastRadius: 2.5,
        confidence: isPlaceholder ? pat.confidence / 2 : pat.confidence,
        difficulty: 1,
        file: relativePath,
        lineStart: i + 1,
        lineEnd: i + 1,
        humanExplanation: humanExplanation(pat.description, relativePath),
        codeEvidence: redact(line, match[0]),
      });
    }
  }
  return found;
}

function humanExplanation(vendor: string, relativePath: string): string {
  return (
    `A ${vendor} appears to be hardcoded in ${relativePath}. ` +
    `Anyone with access to this file — including future contributors and ` +
    `automated scrapers — can use this credential. Move it to an environment ` +
    `variable and rotate the key.`
  );
}

// Show the first 4 + last 4 chars of the secret so the developer can find
// it without us echoing the credential to logs/UI verbatim.
function redact(line: string, secret: string): string {
  if (secret.length < 12) return line.replace(secret, "***");
  const head = secret.slice(0, 4);
  const tail = secret.slice(-4);
  return line.replace(secret, `${head}***${tail}`);
}

function extOf(relativePath: string): string {
  const dot = relativePath.lastIndexOf(".");
  if (dot < 0) return "";
  return relativePath.slice(dot).toLowerCase();
}

// Direct async surface for callers/tests that want to skip the
// ResultAsync wrapper. The Detector adapter above forwards to this.
export const secretRegexScan = scan;
