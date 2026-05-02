import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  abortBranch,
  commitAll,
  openBranch,
  squashOntoBase,
  type RunGit,
  type RunResult,
} from "./branch.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "branch-test-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

// In-memory git stub — captures invocations and lets each test pre-load
// canned responses. Closer to the real sidecar pattern (lib/launch tests
// inject spawn this way) than spinning up real subprocess git.
class GitStub {
  public calls: Array<{ args: string[]; cwd: string }> = [];
  private queue: Array<RunResult | ((args: readonly string[]) => RunResult)> = [];

  enqueue(result: RunResult): this {
    this.queue.push(result);
    return this;
  }

  enqueueFn(fn: (args: readonly string[]) => RunResult): this {
    this.queue.push(fn);
    return this;
  }

  /** Default success for any args we did not anticipate. */
  defaultOk(): RunResult {
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  asRunGit(): RunGit {
    return async (args, cwd) => {
      this.calls.push({ args: [...args], cwd });
      const next = this.queue.shift();
      if (!next) return this.defaultOk();
      return typeof next === "function" ? next(args) : next;
    };
  }
}

const ok = (stdout = ""): RunResult => ({ stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string, code = 1): RunResult => ({
  stdout: "",
  stderr,
  exitCode: code,
});

describe("openBranch", () => {
  it("creates a fresh ai-fix-<defectId> branch from the current branch", async () => {
    const git = new GitStub()
      // assertGitRepo
      .enqueue(ok("true\n"))
      // assertCleanWorkingTree
      .enqueue(ok(""))
      // currentBranch
      .enqueue(ok("main\n"))
      // pre-emptive branch -D
      .enqueue(ok(""))
      // checkout -b
      .enqueue(ok(""));
    const session = await openBranch({
      projectPath: tmp,
      defectId: "01ABC",
      runGit: git.asRunGit(),
    });
    expect(session.branch).toBe("ai-fix-01ABC");
    expect(session.baseBranch).toBe("main");
    expect(git.calls.map((c) => c.args.slice(0, 2))).toContainEqual([
      "checkout",
      "-b",
    ]);
  });

  it("rejects a dirty working tree with a clear message", async () => {
    const git = new GitStub()
      .enqueue(ok("true\n"))
      .enqueue(ok(" M src/foo.ts\n"));
    await expect(
      openBranch({
        projectPath: tmp,
        defectId: "01ABC",
        runGit: git.asRunGit(),
      })
    ).rejects.toThrow(/working tree is not clean/);
  });

  it("rejects when not inside a git repo", async () => {
    const git = new GitStub().enqueue(fail("fatal: not a git repository"));
    await expect(
      openBranch({
        projectPath: tmp,
        defectId: "01ABC",
        runGit: git.asRunGit(),
      })
    ).rejects.toThrow(/not a git repository/);
  });

  it("rejects when HEAD is detached (empty branch name)", async () => {
    const git = new GitStub()
      .enqueue(ok("true\n"))
      .enqueue(ok(""))
      .enqueue(ok("\n")); // empty branch name
    await expect(
      openBranch({
        projectPath: tmp,
        defectId: "01ABC",
        runGit: git.asRunGit(),
      })
    ).rejects.toThrow(/HEAD is detached/);
  });

  it("propagates a checkout -b failure verbatim", async () => {
    const git = new GitStub()
      .enqueue(ok("true\n"))
      .enqueue(ok(""))
      .enqueue(ok("main\n"))
      .enqueue(ok(""))
      .enqueue(fail("fatal: A branch named 'ai-fix-01ABC' already exists."));
    await expect(
      openBranch({
        projectPath: tmp,
        defectId: "01ABC",
        runGit: git.asRunGit(),
      })
    ).rejects.toThrow(/checkout -b ai-fix-01ABC failed/);
  });
});

describe("commitAll", () => {
  it("runs git add -A then git commit with --no-verify", async () => {
    const git = new GitStub().enqueue(ok("")).enqueue(ok(""));
    await commitAll(
      { branch: "ai-fix-X", baseBranch: "main", projectPath: tmp },
      "fix: extract secret",
      git.asRunGit()
    );
    expect(git.calls[0]!.args).toEqual(["add", "-A"]);
    expect(git.calls[1]!.args).toContain("commit");
    expect(git.calls[1]!.args).toContain("--no-verify");
    expect(git.calls[1]!.args).toContain("fix: extract secret");
  });

  it("treats nothing-to-commit as a no-op success", async () => {
    const git = new GitStub()
      .enqueue(ok(""))
      .enqueue({
        stdout: "On branch x\nnothing to commit, working tree clean\n",
        stderr: "",
        exitCode: 1,
      });
    await expect(
      commitAll(
        { branch: "ai-fix-X", baseBranch: "main", projectPath: tmp },
        "fix",
        git.asRunGit()
      )
    ).resolves.toBeUndefined();
  });

  it("throws on a real commit failure", async () => {
    const git = new GitStub()
      .enqueue(ok(""))
      .enqueue(fail("hooks rejected"));
    await expect(
      commitAll(
        { branch: "ai-fix-X", baseBranch: "main", projectPath: tmp },
        "fix",
        git.asRunGit()
      )
    ).rejects.toThrow(/git commit failed/);
  });
});

describe("squashOntoBase", () => {
  it("checks out base, runs merge --squash, commits with message, deletes branch", async () => {
    const git = new GitStub()
      .enqueue(ok("")) // checkout base
      .enqueue(ok("")) // merge --squash
      .enqueue(ok("")) // commit
      .enqueue(ok("")); // branch -D
    await squashOntoBase(
      { branch: "ai-fix-X", baseBranch: "main", projectPath: tmp },
      "fix: rls migration",
      git.asRunGit()
    );
    expect(git.calls.map((c) => c.args[0])).toEqual([
      "checkout",
      "merge",
      "commit",
      "branch",
    ]);
    expect(git.calls[1]!.args).toContain("--squash");
  });

  it("aborts the merge if it fails and surfaces the error", async () => {
    const git = new GitStub()
      .enqueue(ok("")) // checkout base
      .enqueue(fail("merge conflict")) // merge --squash
      .enqueue(ok("")); // best-effort merge --abort
    await expect(
      squashOntoBase(
        { branch: "ai-fix-X", baseBranch: "main", projectPath: tmp },
        "fix",
        git.asRunGit()
      )
    ).rejects.toThrow(/git merge --squash failed/);
    expect(git.calls.map((c) => c.args.slice(0, 2))).toContainEqual([
      "merge",
      "--abort",
    ]);
  });

  it("treats nothing-to-commit on squash as a no-op", async () => {
    const git = new GitStub()
      .enqueue(ok(""))
      .enqueue(ok(""))
      .enqueue({
        stdout: "nothing to commit",
        stderr: "",
        exitCode: 1,
      })
      .enqueue(ok(""));
    await expect(
      squashOntoBase(
        { branch: "ai-fix-X", baseBranch: "main", projectPath: tmp },
        "fix",
        git.asRunGit()
      )
    ).resolves.toBeUndefined();
  });
});

describe("abortBranch", () => {
  it("checks out base then deletes the engine branch", async () => {
    const git = new GitStub().enqueue(ok("")).enqueue(ok(""));
    await abortBranch(
      { branch: "ai-fix-X", baseBranch: "main", projectPath: tmp },
      git.asRunGit()
    );
    expect(git.calls[0]!.args).toEqual(["checkout", "main"]);
    expect(git.calls[1]!.args).toEqual(["branch", "-D", "ai-fix-X"]);
  });

  it("does not throw even if the cleanup steps fail (best-effort)", async () => {
    const git = new GitStub().enqueue(fail("nope")).enqueue(fail("also nope"));
    await expect(
      abortBranch(
        { branch: "ai-fix-X", baseBranch: "main", projectPath: tmp },
        git.asRunGit()
      )
    ).resolves.toBeUndefined();
  });
});
