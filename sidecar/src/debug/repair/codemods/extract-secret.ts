// extract-secret codemod. Replaces a hardcoded credential at the
// finding's location with a `process.env.X` reference + appends an
// example entry to `.env.example`. Per source spec §E.3 row 2: this
// is one of the highest-value Tier 1 fixes — the secret-regex
// detector emits >0.9 confidence findings at critical-band priority,
// and the fix is mechanical.
//
// Approach:
//  1. Read the source file at the finding's line.
//  2. Re-run the same regex the secret-regex detector uses (mapped per
//     ruleId) to locate the literal — the detector redacted it in
//     `codeEvidence`, so we have to look it up again.
//  3. Replace the literal with `process.env.<NAME>` where NAME is the
//     vendor-canonical env var name for that rule.
//  4. Append `<NAME>=` to `.env.example` (creating it if needed),
//     deduping if the var is already declared.
//
// Limits at v1:
//  - We only operate on the first match in the line. Multiple secrets
//    on one line are unusual and the next scan would catch the rest.
//  - We do not parse JS — string-replace is safe enough for the
//    regex-shaped vendor patterns.

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { Defect } from "../../../schema/defects.js";

import type { CodemodResult } from "../types.js";

interface VendorRule {
  /** Used for the regex match. Mirror of the detector's pattern. */
  pattern: RegExp;
  /** Conventional .env var name for this credential. */
  envVar: string;
  /** Human-readable vendor name for the comment. */
  vendor: string;
}

const VENDOR_RULES: Readonly<Record<string, VendorRule>> = {
  "secret-regex/aws-access-key": {
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    envVar: "AWS_ACCESS_KEY_ID",
    vendor: "AWS access key",
  },
  "secret-regex/github-pat": {
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,251}\b/g,
    envVar: "GITHUB_TOKEN",
    vendor: "GitHub personal access token",
  },
  "secret-regex/stripe-live-secret": {
    pattern: /\bsk_live_[A-Za-z0-9]{20,99}\b/g,
    envVar: "STRIPE_SECRET_KEY",
    vendor: "Stripe live secret key",
  },
  "secret-regex/stripe-live-publishable": {
    pattern: /\bpk_live_[A-Za-z0-9]{20,99}\b/g,
    envVar: "STRIPE_PUBLISHABLE_KEY",
    vendor: "Stripe live publishable key",
  },
  "secret-regex/anthropic-api-key": {
    pattern: /\bsk-ant-[A-Za-z0-9_-]{30,}\b/g,
    envVar: "ANTHROPIC_API_KEY",
    vendor: "Anthropic API key",
  },
  "secret-regex/openai-api-key": {
    pattern: /\bsk-[A-Za-z0-9]{48}\b/g,
    envVar: "OPENAI_API_KEY",
    vendor: "OpenAI API key",
  },
  "secret-regex/google-api-key": {
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    envVar: "GOOGLE_API_KEY",
    vendor: "Google API key",
  },
  "secret-regex/slack-bot-token": {
    pattern: /\bxox[bporsa]-[0-9A-Za-z-]{10,}\b/g,
    envVar: "SLACK_BOT_TOKEN",
    vendor: "Slack token",
  },
};

export interface ExtractSecretInput {
  defect: Pick<Defect, "ruleId" | "file" | "lineStart" | "lineEnd">;
  projectPath: string;
}

/**
 * Apply the extract-secret codemod for a defect. Writes the changes
 * to disk; the caller (dispatcher) is responsible for committing on
 * the engine branch.
 */
export async function applyExtractSecret(
  input: ExtractSecretInput
): Promise<CodemodResult> {
  const rule = VENDOR_RULES[input.defect.ruleId];
  if (!rule) {
    return {
      kind: "skipped",
      message: `extract-secret: no vendor rule for ${input.defect.ruleId}`,
    };
  }

  const sourceAbs = path.join(input.projectPath, input.defect.file);
  let source: string;
  try {
    source = await fs.readFile(sourceAbs, "utf-8");
  } catch (e) {
    return {
      kind: "error",
      message: `extract-secret: could not read ${input.defect.file}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }

  const lines = source.split(/\r?\n/);
  const targetLineIdx = input.defect.lineStart - 1;
  if (targetLineIdx < 0 || targetLineIdx >= lines.length) {
    return {
      kind: "error",
      message: `extract-secret: line ${input.defect.lineStart} is out of range for ${input.defect.file}`,
    };
  }

  const originalLine = lines[targetLineIdx]!;
  rule.pattern.lastIndex = 0;
  const match = rule.pattern.exec(originalLine);
  if (!match) {
    // The line changed since the scan — bail rather than guess.
    return {
      kind: "skipped",
      message: `extract-secret: no ${rule.vendor} literal on ${input.defect.file}:${input.defect.lineStart} any more (file may have changed since the scan)`,
    };
  }
  const literal = match[0];
  // Strip the surrounding string quote if present — replacing "secret"
  // with process.env.X must drop the quotes too, otherwise we ship
  // `"process.env.X!"` which is just a string literal of that text.
  const literalIdx = match.index ?? originalLine.indexOf(literal);
  const before = originalLine[literalIdx - 1] ?? "";
  const after = originalLine[literalIdx + literal.length] ?? "";
  const isQuoted =
    (before === '"' && after === '"') ||
    (before === "'" && after === "'") ||
    (before === "`" && after === "`");
  const newLine = isQuoted
    ? originalLine.slice(0, literalIdx - 1) +
      `process.env.${rule.envVar}!` +
      originalLine.slice(literalIdx + literal.length + 1)
    : originalLine.replace(literal, `process.env.${rule.envVar}!`);
  lines[targetLineIdx] = newLine;
  const newSource = lines.join("\n");
  if (newSource === source) {
    return { kind: "skipped", message: "extract-secret: replacement was a no-op" };
  }

  await fs.writeFile(sourceAbs, newSource, "utf-8");

  const envExamplePath = path.join(input.projectPath, ".env.example");
  await ensureEnvExampleEntry(envExamplePath, rule.envVar, rule.vendor);

  return {
    kind: "applied",
    files: [input.defect.file, ".env.example"],
    message: `Replaced hardcoded ${rule.vendor} with process.env.${rule.envVar} and added the var to .env.example. Set its value in your local .env.local before running the app.`,
    fixTier: 1,
  };
}

async function ensureEnvExampleEntry(
  filePath: string,
  envVar: string,
  vendor: string
): Promise<void> {
  let existing = "";
  try {
    existing = await fs.readFile(filePath, "utf-8");
  } catch {
    // Missing file is fine — we create it below.
  }
  // Already declared? Don't duplicate.
  if (new RegExp(`^${envVar}=`, "m").test(existing)) return;

  const trailingNewline = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  const block = `${trailingNewline}# ${vendor}\n${envVar}=\n`;
  await fs.writeFile(filePath, existing + block, "utf-8");
}

/** Lookup helper used by the dispatcher to decide which rules this codemod handles. */
export function handlesRuleId(ruleId: string): boolean {
  return ruleId in VENDOR_RULES;
}
