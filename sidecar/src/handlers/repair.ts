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
  headCommit,
  openBranch,
  revertCommit,
  runTier2,
  sdkPatchTransport,
  squashOntoBase,
  type PatchTransport,
  type RunGit,
} from "../debug/repair/index.js";

const ApplyFixParamsSchema = z.object({
  defectId: z.string().min(1),
  /** Optional model override for the Tier 2 patch generator. When
   *  omitted the SDK transport uses the CLI auth's default. */
  model: z.string().min(1).optional(),
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
      ...(params.model !== undefined ? { model: params.model } : {}),
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
  // G7b: capture the post-squash HEAD so the 7-day rollback can find
  // exactly which commit to revert.
  let resolvedCommit: string | null = null;
  try {
    resolvedCommit = await headCommit(project.path, runGit);
  } catch {
    resolvedCommit = null;
  }

  const resolvedAt = Date.now();
  db.update(defects)
    .set({
      status: "fixed",
      fixTier: codemod.fixTier,
      fixBranch: session.branch,
      resolvedAt,
      resolvedCommit,
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
  /** Optional model override forwarded into Tier2Input.model. */
  model?: string;
}

async function runTier2OnBranch(args: Tier2RunArgs): Promise<ApplyFixResult> {
  const { db, defect, project, session, runGit, patchTransport, model } = args;

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
    ...(model !== undefined ? { model } : {}),
  });

  if (tier2.kind === "no_patch") {
    await abortBranch(session, runGit);
    // Tier 3 hand-off: stash the model's explanation so the dashboard
    // can show "here's why we couldn't auto-fix" instead of leaving the
    // user staring at an unhelpful "no patch" message.
    db.update(defects)
      .set({
        suggestion: JSON.stringify({
          explanation: tier2.reason,
          edits: [],
          errors: "(model declined to attempt a fix)",
        }),
      })
      .where(eq(defects.id, defect.id))
      .run();
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
    // Tier 3 hand-off: keep the last attempted edits + the verification
    // errors so the user can review and apply manually. v1 surfaces
    // these in the Debug card's advanced toggle; G7-follow-up may add
    // a one-click "open in editor" affordance.
    db.update(defects)
      .set({
        suggestion: JSON.stringify({
          explanation: "Tier 2 could not produce a fix that passes syntax verification. The model's last attempt is below — review and apply manually if it looks right.",
          edits: tier2.lastEdits,
          errors: tier2.lastErrors,
        }),
      })
      .where(eq(defects.id, defect.id))
      .run();
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
  // G7b: capture the post-squash HEAD for the 7-day rollback.
  let tier2ResolvedCommit: string | null = null;
  try {
    tier2ResolvedCommit = await headCommit(project.path, runGit);
  } catch {
    tier2ResolvedCommit = null;
  }

  const resolvedAt = Date.now();
  db.update(defects)
    .set({
      status: "fixed",
      fixTier: 2,
      fixBranch: session.branch,
      resolvedAt,
      resolvedCommit: tier2ResolvedCommit,
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

// ----- G7b: 7-day rollback handler -----------------------------------

const ROLLBACK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const RollbackParamsSchema = z.object({
  defectId: z.string().min(1),
});

export type RollbackOutcome =
  | "rolled_back"
  | "expired"
  | "not_fixed"
  | "no_commit_recorded"
  | "revert_failed";

export interface RollbackResult {
  defectId: string;
  outcome: RollbackOutcome;
  message: string;
}

/**
 * `debug.rollbackFix({ defectId })` — undo a previously-applied fix
 * within the 7-day rollback window. Runs `git revert <resolvedCommit>`
 * on the user's working branch; on success flips the defect back to
 * status='open' and clears the fix metadata. On conflict (the user has
 * edited the same files since the fix landed), aborts the revert and
 * reports revert_failed.
 */
export async function rollbackFix(
  rawParams: unknown,
  runGit?: RunGit
): Promise<RollbackResult> {
  const params = RollbackParamsSchema.parse(rawParams);
  const db = getDb();

  const [defect] = db
    .select()
    .from(defects)
    .where(eq(defects.id, params.defectId))
    .all();
  if (!defect) {
    throw new Error(`debug.rollbackFix: defect not found '${params.defectId}'`);
  }

  if (defect.status !== "fixed" || defect.resolvedAt === null) {
    return {
      defectId: defect.id,
      outcome: "not_fixed",
      message: "this defect has no applied fix to roll back",
    };
  }
  if (defect.resolvedCommit === null) {
    return {
      defectId: defect.id,
      outcome: "no_commit_recorded",
      message:
        "the fix did not record a commit hash (older fix predating G7b); cannot auto-roll-back",
    };
  }
  if (Date.now() - defect.resolvedAt > ROLLBACK_WINDOW_MS) {
    return {
      defectId: defect.id,
      outcome: "expired",
      message: "rollback window of 7 days has elapsed; revert manually with git",
    };
  }

  const [project] = db
    .select()
    .from(projects)
    .where(eq(projects.id, defect.projectId))
    .all();
  if (!project) {
    throw new Error(
      `debug.rollbackFix: project not found for defect '${params.defectId}'`
    );
  }

  try {
    await revertCommit(project.path, defect.resolvedCommit, runGit);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    db.insert(auditLog)
      .values({
        id: ulid(),
        action: "debug_fix_rollback_failed",
        targetId: defect.id,
        payload: JSON.stringify({ message, resolvedCommit: defect.resolvedCommit }),
        createdAt: Date.now(),
      })
      .run();
    return {
      defectId: defect.id,
      outcome: "revert_failed",
      message,
    };
  }

  db.update(defects)
    .set({
      status: "open",
      fixTier: null,
      fixBranch: null,
      resolvedAt: null,
      resolvedCommit: null,
    })
    .where(eq(defects.id, defect.id))
    .run();

  db.insert(auditLog)
    .values({
      id: ulid(),
      action: "debug_fix_rolled_back",
      targetId: defect.id,
      payload: JSON.stringify({ revertedCommit: defect.resolvedCommit }),
      createdAt: Date.now(),
    })
    .run();

  return {
    defectId: defect.id,
    outcome: "rolled_back",
    message: `Reverted commit ${defect.resolvedCommit.slice(0, 7)} on the user's working branch`,
  };
}
