// Branch isolation primitives for the repair engine. Per source spec
// §E.7 and Flow L AC5/AC9: every applied fix lands on a fresh
// `ai-fix-<defect-id>` branch in the target-app repo; only on green
// verification is the branch squashed onto the user's working branch.
// On failure, the branch is aborted (deleted) and the user's working
// tree is restored to its pre-fix state.
//
// All git work happens via `git -C <projectPath> …` subprocess spawn
// (the same pattern as lib/deploy/lib/export/lib/launch). The sidecar
// owns the spawn — the webview never invokes git directly.
//
// v1 limitations:
//  - The user's working branch must be clean (no uncommitted changes)
//    when we start. Dirty working trees error out with a clear message.
//  - We do not stash; we only operate on clean working trees. Adding
//    stash support is a small follow-up if real-user telemetry shows
//    they hit this often.
//  - Squash uses `git merge --squash` against the working branch, then
//    a single commit; we do not try to rebase or interactive-fixup.

import { spawn } from "node:child_process";

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type RunGit = (args: readonly string[], cwd: string) => Promise<RunResult>;

export interface BranchSession {
  /** Workspace-relative branch name we created. */
  branch: string;
  /** The branch the user was on when we started — restored on abort. */
  baseBranch: string;
  /** Project path the session operates against. */
  projectPath: string;
}

const defaultRunGit: RunGit = (args, cwd) =>
  new Promise((resolve) => {
    const child = spawn("git", [...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (err) => {
      resolve({ stdout, stderr: stderr + String(err), exitCode: -1 });
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
  });

export interface BranchOpenOptions {
  projectPath: string;
  defectId: string;
  /** Override for tests. */
  runGit?: RunGit;
}

/**
 * Open a fresh branch named `ai-fix-<defectId>` from the user's
 * current branch. Throws when the working tree is dirty so we never
 * silently include the user's in-progress changes in our commit.
 */
export async function openBranch(opts: BranchOpenOptions): Promise<BranchSession> {
  const run = opts.runGit ?? defaultRunGit;
  const { projectPath, defectId } = opts;

  await assertGitRepo(run, projectPath);
  await assertCleanWorkingTree(run, projectPath);

  const baseBranch = await currentBranch(run, projectPath);
  const branch = `ai-fix-${defectId}`;

  // If a previous attempt left the branch around, delete it before
  // re-creating. The branch is the engine's, not the user's.
  await run(["branch", "-D", branch], projectPath);

  const create = await run(["checkout", "-b", branch], projectPath);
  if (create.exitCode !== 0) {
    throw new Error(
      `git checkout -b ${branch} failed: ${create.stderr.trim() || create.stdout.trim()}`
    );
  }
  return { branch, baseBranch, projectPath };
}

/** Stage every change in the working tree; commit with the given message. */
export async function commitAll(
  session: BranchSession,
  message: string,
  runGit?: RunGit
): Promise<void> {
  const run = runGit ?? defaultRunGit;
  const add = await run(["add", "-A"], session.projectPath);
  if (add.exitCode !== 0) {
    throw new Error(`git add -A failed: ${add.stderr.trim()}`);
  }
  // Commit may produce nothing-to-commit; treat exit 1 with that text
  // as a no-op success rather than an error.
  const commit = await run(
    ["commit", "-m", message, "--no-verify"],
    session.projectPath
  );
  if (commit.exitCode !== 0 && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
    throw new Error(`git commit failed: ${commit.stderr.trim() || commit.stdout.trim()}`);
  }
}

/**
 * Squash the branch into a single commit on the user's working branch.
 * Used only on a green verification.
 */
export async function squashOntoBase(
  session: BranchSession,
  message: string,
  runGit?: RunGit
): Promise<void> {
  const run = runGit ?? defaultRunGit;
  const co = await run(["checkout", session.baseBranch], session.projectPath);
  if (co.exitCode !== 0) {
    throw new Error(
      `git checkout ${session.baseBranch} failed: ${co.stderr.trim()}`
    );
  }
  const merge = await run(
    ["merge", "--squash", session.branch],
    session.projectPath
  );
  if (merge.exitCode !== 0) {
    // Best-effort: try to abort and leave the user on their base branch.
    await run(["merge", "--abort"], session.projectPath);
    throw new Error(`git merge --squash failed: ${merge.stderr.trim()}`);
  }
  const commit = await run(
    ["commit", "-m", message, "--no-verify"],
    session.projectPath
  );
  if (commit.exitCode !== 0 && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
    throw new Error(`git commit (squash) failed: ${commit.stderr.trim()}`);
  }
  // Tidy up the engine branch.
  await run(["branch", "-D", session.branch], session.projectPath);
}

/**
 * Discard the branch without merging. Used on verification failure.
 * Always restores the user to their base branch.
 */
export async function abortBranch(
  session: BranchSession,
  runGit?: RunGit
): Promise<void> {
  const run = runGit ?? defaultRunGit;
  // Move off the engine branch first so we can delete it.
  await run(["checkout", session.baseBranch], session.projectPath);
  await run(["branch", "-D", session.branch], session.projectPath);
}

async function assertGitRepo(run: RunGit, cwd: string): Promise<void> {
  const r = await run(["rev-parse", "--is-inside-work-tree"], cwd);
  if (r.exitCode !== 0 || !r.stdout.trim().startsWith("true")) {
    throw new Error(`not a git repository: ${cwd}`);
  }
}

async function assertCleanWorkingTree(run: RunGit, cwd: string): Promise<void> {
  const r = await run(["status", "--porcelain"], cwd);
  if (r.exitCode !== 0) {
    throw new Error(`git status failed: ${r.stderr.trim()}`);
  }
  if (r.stdout.trim().length > 0) {
    throw new Error(
      "working tree is not clean — commit or discard pending changes before applying a repair"
    );
  }
}

async function currentBranch(run: RunGit, cwd: string): Promise<string> {
  // `--show-current` prints the branch name (or empty in detached HEAD).
  const r = await run(["branch", "--show-current"], cwd);
  if (r.exitCode !== 0) {
    throw new Error(`git branch --show-current failed: ${r.stderr.trim()}`);
  }
  const name = r.stdout.trim();
  if (!name) {
    throw new Error("HEAD is detached — repair requires a real branch as the base");
  }
  return name;
}

/**
 * Read the current HEAD commit. Used by the repair handler to capture
 * the post-squash commit hash for the 7-day rollback feature (G7b).
 */
export async function headCommit(
  projectPath: string,
  runGit?: RunGit
): Promise<string> {
  const run = runGit ?? defaultRunGit;
  const r = await run(["rev-parse", "HEAD"], projectPath);
  if (r.exitCode !== 0) {
    throw new Error(`git rev-parse HEAD failed: ${r.stderr.trim()}`);
  }
  const hash = r.stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(hash)) {
    throw new Error(`git rev-parse HEAD returned unexpected output: "${hash}"`);
  }
  return hash;
}

/**
 * Revert a previously-squashed fix commit. Creates a new commit on
 * the current branch that undoes the named commit's changes. Throws
 * with a clear message if there's a conflict (typically caused by the
 * user editing the same files since the fix landed).
 */
export async function revertCommit(
  projectPath: string,
  commit: string,
  runGit?: RunGit
): Promise<void> {
  const run = runGit ?? defaultRunGit;
  const r = await run(
    ["revert", "--no-edit", commit],
    projectPath
  );
  if (r.exitCode !== 0) {
    // Best-effort: try to abort any in-progress revert so the user
    // doesn't end up in a half-resolved state.
    await run(["revert", "--abort"], projectPath);
    throw new Error(
      `git revert ${commit} failed (the user may have edited the same files): ${r.stderr.trim() || r.stdout.trim()}`
    );
  }
}
