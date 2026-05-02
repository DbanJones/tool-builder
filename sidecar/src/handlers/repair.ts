// `debug.applyFix` JSON-RPC handler. Per ADR-0007, Flow L AC5/AC9, and
// source spec §E.3: takes one defect, opens a fresh ai-fix-<defectId>
// branch in the target-app repo, dispatches to the matching Tier 1
// codemod, runs a TS-syntax sanity check on the modified files, then
// either squashes onto the user's working branch (success) or aborts
// (failure). Updates the defect row with status + fix branch + commit
// hash on success.
//
// The TS sanity check is a minimal Tier-1-tier verification step: it
// catches "codemod produced syntactically broken code" cleanly without
// spawning tsc (which would require the target's node_modules to be
// installed and is properly the Tier 2 verify loop's job in G5d).

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { eq } from "drizzle-orm";
import ts from "typescript";
import { ulid } from "ulid";
import { z } from "zod";

import { getDb } from "../db.js";
import { auditLog } from "../schema/audit-log.js";
import { defects } from "../schema/defects.js";
import { projects } from "../schema/projects.js";
import {
  abortBranch,
  commitAll,
  dispatchTier1,
  openBranch,
  runTier2,
  sdkPatchTransport,
  squashOntoBase,
  type PatchTransport,
  type RunGit,
} from "../debug/repair/index.js";

const ApplyFixParamsSchema = z.object({
  defectId: z.string().min(1),
});

export type FixOutcome =
  | "applied"
  | "applied_tier2"
  | "skipped_no_codemod"
  | "skipped_codemod_noop"
  | "syntax_check_failed"
  | "branch_failed"
  | "codemod_error"
  | "tier2_no_patch"
  | "tier2_verify_failed";

export interface ApplyFixResult {
  defectId: string;
  outcome: FixOutcome;
  message: string;
  /** Workspace-relative paths the codemod modified. Empty for non-applied. */
  files: readonly string[];
  /** Engine branch name (only when outcome touched git). */
  branch: string | null;
}

export async function applyFix(
  rawParams: unknown,
  // Tests inject a deterministic git stub; production lets the
  // repair/branch.ts default spawn `git -C <projectPath> …`.
  runGit?: RunGit,
  // Tier 2 patch transport. Defaults to the production SDK transport;
  // tests inject a stub.
  patchTransport: PatchTransport = sdkPatchTransport
): Promise<ApplyFixResult> {
  const params = ApplyFixParamsSchema.parse(rawParams);
  const db = getDb();

  const [defect] = db
    .select()
    .from(defects)
    .where(eq(defects.id, params.defectId))
    .all();
  if (!defect) {
    throw new Error(`debug.applyFix: defect not found '${params.defectId}'`);
  }

  const [project] = db
    .select()
    .from(projects)
    .where(eq(projects.id, defect.projectId))
    .all();
  if (!project) {
    throw new Error(`debug.applyFix: project not found for defect '${params.defectId}'`);
  }

  // Open the engine branch first. Failures here are usually "dirty
  // working tree" or "not a git repo" — surface verbatim so the
  // dashboard can tell the novice exactly what to clean up.
  let session;
  try {
    session = await openBranch({
      projectPath: project.path,
      defectId: defect.id,
      ...(runGit ? { runGit } : {}),
    });
  } catch (e) {
    return failWithAudit(db, defect.id, "branch_failed", String(e), null);
  }

  // Dispatch to Tier 1 first.
  const codemod = await dispatchTier1({
    defect,
    projectPath: project.path,
  });

  if (codemod.kind === "error") {
    await abortBranch(session, runGit);
    return failWithAudit(
      db,
      defect.id,
      "codemod_error",
      codemod.message,
      session.branch
    );
  }

  // Tier 1 didn't match this rule — fall through to Tier 2 (LLM-driven
  // patch generator with retry-once on syntax failure).
  if (codemod.kind === "skipped") {
    return await runTier2OnBranch({
      db,
      defect,
      project,
      session,
      runGit,
      patchTransport,
    });
  }

  if (codemod.files.length === 0) {
    await abortBranch(session, runGit);
    return failWithAudit(
      db,
      defect.id,
      "skipped_codemod_noop",
      "codemod produced no file changes",
      session.branch
    );
  }

  // Minimal verification: every TS/TSX/JS/JSX file the codemod touched
  // must still parse cleanly. Catches "we broke the syntax" but not
  // semantic regressions — those wait for behaviour-level test verify.
  const syntaxIssues = await checkSyntax(project.path, codemod.files);
  if (syntaxIssues.length > 0) {
    await abortBranch(session, runGit);
    return failWithAudit(
      db,
      defect.id,
      "syntax_check_failed",
      `codemod produced syntax errors in: ${syntaxIssues.join(", ")}`,
      session.branch
    );
  }

  await commitAll(session, `fix: ${codemod.message}`, runGit);
  await squashOntoBase(
    session,
    `fix: ${codemod.message} (defect ${defect.id})`,
    runGit
  );

  const resolvedAt = Date.now();
  db.update(defects)
    .set({
      status: "fixed",
      fixTier: codemod.fixTier,
      fixBranch: session.branch,
      resolvedAt,
      resolvedCommit: null, // future: capture HEAD post-squash if needed.
    })
    .where(eq(defects.id, defect.id))
    .run();

  db.insert(auditLog)
    .values({
      id: ulid(),
      action: "debug_fix_applied",
      targetId: defect.id,
      payload: JSON.stringify({
        outcome: "applied",
        ruleId: defect.ruleId,
        fixTier: codemod.fixTier,
        files: codemod.files,
        branch: session.branch,
      }),
      createdAt: resolvedAt,
    })
    .run();

  return {
    defectId: defect.id,
    outcome: "applied",
    message: codemod.message,
    files: codemod.files,
    branch: session.branch,
  };
}

interface Tier2RunArgs {
  db: ReturnType<typeof getDb>;
  defect: typeof defects.$inferSelect;
  project: typeof projects.$inferSelect;
  session: { branch: string; baseBranch: string; projectPath: string };
  runGit: RunGit | undefined;
  patchTransport: PatchTransport;
}

async function runTier2OnBranch(args: Tier2RunArgs): Promise<ApplyFixResult> {
  const { db, defect, project, session, runGit, patchTransport } = args;

  const tier2 = await runTier2({
    finding: {
      class: defect.class,
      ruleId: defect.ruleId,
      severity: defect.severity,
      blastRadius: defect.blastRadius,
      confidence: defect.confidence,
      difficulty: defect.difficulty,
      file: defect.file,
      lineStart: defect.lineStart,
      lineEnd: defect.lineEnd,
      humanExplanation: defect.humanExplanation,
      codeEvidence: defect.codeEvidence,
    },
    projectPath: project.path,
    transport: patchTransport,
  });

  if (tier2.kind === "no_patch") {
    await abortBranch(session, runGit);
    return failWithAudit(
      db,
      defect.id,
      "tier2_no_patch",
      tier2.reason,
      session.branch
    );
  }
  if (tier2.kind === "verify_failed") {
    await abortBranch(session, runGit);
    return failWithAudit(
      db,
      defect.id,
      "tier2_verify_failed",
      `Tier 2 gave up after ${tier2.attempts} attempts: ${tier2.lastErrors}`,
      session.branch
    );
  }

  // Applied. Commit + squash + mark fixed.
  await commitAll(session, `fix: ${tier2.explanation}`, runGit);
  await squashOntoBase(
    session,
    `fix: ${tier2.explanation} (defect ${defect.id})`,
    runGit
  );

  const resolvedAt = Date.now();
  db.update(defects)
    .set({
      status: "fixed",
      fixTier: 2,
      fixBranch: session.branch,
      resolvedAt,
      resolvedCommit: null,
    })
    .where(eq(defects.id, defect.id))
    .run();

  db.insert(auditLog)
    .values({
      id: ulid(),
      action: "debug_fix_applied",
      targetId: defect.id,
      payload: JSON.stringify({
        outcome: "applied_tier2",
        ruleId: defect.ruleId,
        fixTier: 2,
        files: tier2.files,
        branch: session.branch,
        attempts: tier2.attempts,
      }),
      createdAt: resolvedAt,
    })
    .run();

  return {
    defectId: defect.id,
    outcome: "applied_tier2",
    message: tier2.explanation,
    files: tier2.files,
    branch: session.branch,
  };
}

function failWithAudit(
  db: ReturnType<typeof getDb>,
  defectId: string,
  outcome: FixOutcome,
  message: string,
  branch: string | null
): ApplyFixResult {
  db.insert(auditLog)
    .values({
      id: ulid(),
      action: "debug_fix_attempted",
      targetId: defectId,
      payload: JSON.stringify({ outcome, message, branch }),
      createdAt: Date.now(),
    })
    .run();
  return { defectId, outcome, message, files: [], branch };
}

const PARSEABLE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/**
 * Read every file the codemod claims to have touched and verify it
 * parses cleanly via ts.createSourceFile. Returns the list of files
 * with syntax errors (empty for clean).
 *
 * Non-TS files (.sql, .env.example) are skipped — we can't usefully
 * validate them at the syntax level here.
 */
async function checkSyntax(
  projectPath: string,
  files: readonly string[]
): Promise<string[]> {
  const broken: string[] = [];
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (!PARSEABLE_EXTS.has(ext)) continue;
    const abs = path.join(projectPath, file);
    let source: string;
    try {
      source = await fs.readFile(abs, "utf-8");
    } catch {
      broken.push(file);
      continue;
    }
    const ast = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      scriptKindFor(ext)
    );
    // ts.SourceFile collects parse errors in `parseDiagnostics`. The
    // public typing does not surface that array, but it is part of the
    // emitted .d.ts shape; index defensively to avoid a hard cast.
    const diagnostics =
      (ast as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics ?? [];
    if (diagnostics.length > 0) broken.push(file);
  }
  return broken;
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
