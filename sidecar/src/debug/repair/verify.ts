// Tier 2 verification primitives.
//
//  applyEdits  — string-replace the LLM's `{file, oldText, newText}[]`
//                edits onto disk. Each edit's oldText must occur exactly
//                once in the file (the engine does not fuzzy-match);
//                ambiguous matches abort the edit so we never blindly
//                replace the wrong site.
//  syntaxCheck — re-read every modified TS/TSX/JS/JSX file and verify
//                ts.createSourceFile finds zero parse diagnostics.
//                Already used by handlers/repair.ts for Tier 1; lifted
//                here so Tier 2 reuses the same gate.
//  formatVerifyErrors — turn a list of files+messages into the prompt
//                feedback string the patch driver consumes on retry.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import ts from "typescript";

import type { PatchEdit } from "./patch-driver.js";

export interface ApplyEditError {
  edit: PatchEdit;
  reason: "file_missing" | "old_text_not_found" | "old_text_ambiguous" | "io_error";
  detail: string;
}

export interface ApplyEditsResult {
  /** Workspace-relative paths that were successfully written. */
  modifiedFiles: string[];
  /** Edits that could not be applied; engine aborts the patch attempt on any failure. */
  errors: ApplyEditError[];
}

/**
 * Apply each edit in order. Atomic per-file: we read once, replace,
 * write once. If any edit fails we surface the error; the caller is
 * responsible for reverting (typically by aborting the engine branch).
 */
export async function applyEdits(
  projectPath: string,
  edits: readonly PatchEdit[]
): Promise<ApplyEditsResult> {
  const modifiedFiles: string[] = [];
  const errors: ApplyEditError[] = [];
  // Group edits by file so we can apply multiple edits to one file
  // against the in-memory contents (otherwise the second edit's
  // oldText might already be gone).
  const byFile = new Map<string, PatchEdit[]>();
  for (const e of edits) {
    const list = byFile.get(e.file) ?? [];
    list.push(e);
    byFile.set(e.file, list);
  }

  for (const [file, fileEdits] of byFile) {
    const abs = path.join(projectPath, file);
    let source: string;
    try {
      source = await fs.readFile(abs, "utf-8");
    } catch (e) {
      errors.push({
        edit: fileEdits[0]!,
        reason: "file_missing",
        detail: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    let mutated = source;
    let allOk = true;
    for (const edit of fileEdits) {
      const idx = mutated.indexOf(edit.oldText);
      if (idx < 0) {
        errors.push({
          edit,
          reason: "old_text_not_found",
          detail: `oldText not present in ${file}`,
        });
        allOk = false;
        break;
      }
      const second = mutated.indexOf(edit.oldText, idx + edit.oldText.length);
      if (second >= 0) {
        errors.push({
          edit,
          reason: "old_text_ambiguous",
          detail: `oldText matches at multiple positions in ${file}; refusing to guess`,
        });
        allOk = false;
        break;
      }
      mutated = mutated.slice(0, idx) + edit.newText + mutated.slice(idx + edit.oldText.length);
    }
    if (!allOk) continue;
    try {
      await fs.writeFile(abs, mutated, "utf-8");
      modifiedFiles.push(file);
    } catch (e) {
      errors.push({
        edit: fileEdits[0]!,
        reason: "io_error",
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { modifiedFiles, errors };
}

const PARSEABLE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

export interface SyntaxIssue {
  file: string;
  diagnostics: number;
}

/**
 * Re-read every modified TS/JS/TSX/JSX file and check for parse
 * diagnostics. Non-parseable files (.sql, .env.example, …) are skipped.
 */
export async function syntaxCheck(
  projectPath: string,
  files: readonly string[]
): Promise<SyntaxIssue[]> {
  const issues: SyntaxIssue[] = [];
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (!PARSEABLE_EXTS.has(ext)) continue;
    const abs = path.join(projectPath, file);
    let source: string;
    try {
      source = await fs.readFile(abs, "utf-8");
    } catch {
      issues.push({ file, diagnostics: -1 });
      continue;
    }
    const ast = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      scriptKindFor(ext)
    );
    const diags =
      (ast as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics ?? [];
    if (diags.length > 0) issues.push({ file, diagnostics: diags.length });
  }
  return issues;
}

function scriptKindFor(ext: string): ts.ScriptKind {
  switch (ext) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

/** Format the apply + syntax errors as a string the patch driver feeds back on retry. */
export function formatVerifyErrors(
  applyErrors: readonly ApplyEditError[],
  syntaxIssues: readonly SyntaxIssue[]
): string {
  const parts: string[] = [];
  for (const e of applyErrors) {
    parts.push(`apply ${e.reason}: ${e.detail}`);
  }
  for (const i of syntaxIssues) {
    parts.push(
      i.diagnostics < 0
        ? `${i.file}: file unreadable after patch`
        : `${i.file}: ${i.diagnostics} parse error(s)`
    );
  }
  return parts.join("; ");
}
