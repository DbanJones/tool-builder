// Tier 2 LLM-driven repair pipeline. Composes:
//   1. extractSlice — already in validator/slice.ts
//   2. renderPatchPrompt + transport.generate + parsePatchResponse
//   3. applyEdits + syntaxCheck
//   4. retry-once with the prior errors fed back into the prompt
//
// Per source spec §E.4. v1 caps verification at syntax + parse only —
// "patch produces clean syntax" is the gate. Behaviour-level verify
// (test-driven repair) waits for sandbox build infra.
//
// On success: return the modified files + explanation; the caller
// (G5d handler integration) commits + squashes the engine branch.
// On failure: return a Tier-3 hand-off so the user sees the proposed
// edits as a suggestion to apply manually.

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { RawFinding } from "../detectors/types.js";
import { buildGraph } from "../graph/index.js";
import { extractSlice } from "../validator/slice.js";

import {
  parsePatchResponse,
  renderPatchPrompt,
  type PatchEdit,
  type PatchTransport,
} from "./patch-driver.js";
import {
  applyEdits,
  formatVerifyErrors,
  syntaxCheck,
  type ApplyEditError,
  type SyntaxIssue,
} from "./verify.js";

// Per spec.md Flow L AC6: "test-then-patch verify loop capped at 3 attempts".
// Source spec §E.4 specifies the same. The earlier v1 cut at 2 was a
// scope-narrowing decision walked back during the Phase G boundary recheck
// (NB-G-1); G7 follow-up restores parity with the spec.
export const MAX_TIER2_ATTEMPTS = 3;

export type Tier2Outcome =
  | {
      kind: "applied";
      files: string[];
      explanation: string;
      edits: readonly PatchEdit[];
      attempts: number;
    }
  | {
      kind: "no_patch";
      reason: string;
      attempts: number;
    }
  | {
      kind: "verify_failed";
      lastErrors: string;
      lastEdits: readonly PatchEdit[];
      attempts: number;
    };

export interface Tier2Input {
  finding: RawFinding;
  projectPath: string;
  transport: PatchTransport;
  /** Optional model override threaded into the SDK transport. */
  model?: string;
}

/**
 * Run the Tier 2 pipeline against a finding. Caps at MAX_TIER2_ATTEMPTS;
 * each attempt's errors are fed forward into the next prompt so the
 * model can correct itself.
 *
 * IMPORTANT: this function writes to disk. The caller MUST already be
 * on a fresh engine branch — failed attempts leave partial edits on the
 * branch and the caller is expected to abort the branch on outcome
 * !== "applied".
 */
export async function runTier2(input: Tier2Input): Promise<Tier2Outcome> {
  const graph = await buildGraph(input.projectPath);
  const slice = await extractSlice(input.finding, graph, input.projectPath);

  let previousAttempt: { explanation: string; errors: string } | null = null;
  let lastEdits: readonly PatchEdit[] = [];

  for (let attempt = 1; attempt <= MAX_TIER2_ATTEMPTS; attempt++) {
    const prompt = renderPatchPrompt(slice, previousAttempt);
    let raw = "";
    try {
      raw = await input.transport.generate(prompt, input.model);
    } catch (e) {
      raw = `transport_error: ${e instanceof Error ? e.message : String(e)}`;
    }
    const parsed = parsePatchResponse(raw);
    if (parsed.kind === "no_patch") {
      // Patch driver couldn't even parse the response. Retry with a
      // synthetic feedback message so the next attempt at least sees
      // what went wrong.
      const priorExplanation: string =
        previousAttempt === null ? "(no prior explanation)" : previousAttempt.explanation;
      previousAttempt = {
        explanation: priorExplanation,
        errors: `Could not parse the previous response as the required JSON shape: ${parsed.reason}`,
      };
      continue;
    }
    const edits = parsed.response.edits;
    lastEdits = edits;
    if (edits.length === 0) {
      // The model said "I cannot fix this safely". Honour it — return
      // no_patch with the model's explanation rather than retrying.
      return {
        kind: "no_patch",
        reason: parsed.response.explanation,
        attempts: attempt,
      };
    }

    const beforeContents = await snapshotFiles(input.projectPath, edits);

    const apply = await applyEdits(input.projectPath, edits);
    if (apply.errors.length > 0) {
      // Restore any partially-modified files before the next attempt.
      await restoreFiles(input.projectPath, beforeContents);
      previousAttempt = {
        explanation: parsed.response.explanation,
        errors: formatVerifyErrors(apply.errors, []),
      };
      continue;
    }
    const issues = await syntaxCheck(input.projectPath, apply.modifiedFiles);
    if (issues.length > 0) {
      await restoreFiles(input.projectPath, beforeContents);
      previousAttempt = {
        explanation: parsed.response.explanation,
        errors: formatVerifyErrors([], issues),
      };
      continue;
    }
    return {
      kind: "applied",
      files: apply.modifiedFiles,
      explanation: parsed.response.explanation,
      edits,
      attempts: attempt,
    };
  }

  return {
    kind: "verify_failed",
    lastErrors: previousAttempt?.errors ?? "(unknown)",
    lastEdits,
    attempts: MAX_TIER2_ATTEMPTS,
  };
}

interface FileSnapshot {
  file: string;
  contents: string | null;
}

async function snapshotFiles(
  projectPath: string,
  edits: readonly PatchEdit[]
): Promise<FileSnapshot[]> {
  const seen = new Set<string>();
  const out: FileSnapshot[] = [];
  for (const e of edits) {
    if (seen.has(e.file)) continue;
    seen.add(e.file);
    try {
      const contents = await fs.readFile(path.join(projectPath, e.file), "utf-8");
      out.push({ file: e.file, contents });
    } catch {
      out.push({ file: e.file, contents: null });
    }
  }
  return out;
}

async function restoreFiles(
  projectPath: string,
  snapshots: readonly FileSnapshot[]
): Promise<void> {
  for (const s of snapshots) {
    if (s.contents === null) continue; // file did not exist; leave alone
    try {
      await fs.writeFile(path.join(projectPath, s.file), s.contents, "utf-8");
    } catch {
      // best-effort restore; the engine branch is the real safety net
    }
  }
}

// Re-export for callers that want fine-grained access in tests.
export type { ApplyEditError, SyntaxIssue };
