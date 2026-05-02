import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initDb, getDb } from "../db.js";
import { defects } from "../schema/defects.js";
import { create as createProject } from "./projects.js";
import { listEvents } from "./audit.js";
import {
  stubPatchTransport,
  type PatchTransport,
  type RunGit,
  type RunResult,
} from "../debug/repair/index.js";
import { applyFix, rollbackFix } from "./repair.js";
import { eq } from "drizzle-orm";

// Default Tier 2 transport for tests that exercise a Tier 1 path —
// the dispatcher falls through to Tier 2 when Tier 1 doesn't match,
// and we never want a real SDK call in the merge gate (G4 echo-back
// decision #1). An empty stub returns "uncertain"-shaped no-edits for
// any rule, which the handler turns into tier2_no_patch outcome.
const NO_PATCH_TRANSPORT: PatchTransport = stubPatchTransport({});

let tmpDir: string;
let dbPath: string;
let projectPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "repair-handler-"));
  dbPath = path.join(tmpDir, "test.db");
  projectPath = path.join(tmpDir, "project");
  await fs.mkdir(projectPath, { recursive: true });
  const migrations = path.resolve(process.cwd(), "sidecar", "migrations");
  initDb({ dbPath, migrationsFolder: migrations });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const ok = (stdout = ""): RunResult => ({ stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): RunResult => ({
  stdout: "",
  stderr,
  exitCode: 1,
});

class GitStub {
  public calls: string[][] = [];
  private queue: RunResult[] = [];
  enqueue(...rs: RunResult[]): this {
    this.queue.push(...rs);
    return this;
  }
  asRunGit(): RunGit {
    return async (args) => {
      this.calls.push([...args]);
      return this.queue.shift() ?? ok("");
    };
  }
}

async function newProjectAt(p: string): Promise<string> {
  const project = createProject({ name: "rep-test", path: p });
  return project.id;
}

async function insertDefect(projectId: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const id = `defect-${Math.random().toString(36).slice(2, 10)}`;
  getDb()
    .insert(defects)
    .values({
      id,
      projectId,
      scanId: "test-scan",
      detectedAt: Date.now(),
      class: "security",
      severity: 9,
      blastRadius: 2.5,
      confidence: 0.9,
      difficulty: 1,
      priority: 40.5,
      band: "critical",
      file: "lib/aws.ts",
      lineStart: 1,
      lineEnd: 1,
      ruleId: "secret-regex/aws-access-key",
      humanExplanation: "AWS key hardcoded",
      codeEvidence: 'const KEY = "AKIA***MPLE";',
      status: "open",
      ...overrides,
    })
    .run();
  return id;
}

describe("debug.applyFix handler", () => {
  it("applies an extract-secret codemod, syntax-checks, squashes, marks defect fixed", async () => {
    await fs.mkdir(path.join(projectPath, "lib"), { recursive: true });
    await fs.writeFile(
      path.join(projectPath, "lib", "aws.ts"),
      `const KEY = "AKIAIOSFODNN7EXAMPLE";`
    );
    const projectId = await newProjectAt(projectPath);
    const defectId = await insertDefect(projectId);
    const git = new GitStub()
      // openBranch: rev-parse, status, branch --show-current, branch -D, checkout -b
      .enqueue(ok("true\n"), ok(""), ok("main\n"), ok(""), ok(""))
      // commitAll: add -A, commit
      .enqueue(ok(""), ok(""))
      // squashOntoBase: checkout main, merge --squash, commit, branch -D
      .enqueue(ok(""), ok(""), ok(""), ok(""));

    const result = await applyFix({ defectId }, git.asRunGit(), NO_PATCH_TRANSPORT);

    expect(result.outcome).toBe("applied");
    expect(result.files).toContain("lib/aws.ts");
    expect(result.files).toContain(".env.example");
    expect(result.branch).toBe(`ai-fix-${defectId}`);

    const updated = getDb().select().from(defects).all()[0]!;
    expect(updated.status).toBe("fixed");
    expect(updated.fixTier).toBe(1);
    expect(updated.fixBranch).toBe(`ai-fix-${defectId}`);
    expect(updated.resolvedAt).not.toBeNull();
  });

  it("audit emits debug_fix_applied on success", async () => {
    await fs.mkdir(path.join(projectPath, "lib"), { recursive: true });
    await fs.writeFile(
      path.join(projectPath, "lib", "aws.ts"),
      `const KEY = "AKIAIOSFODNN7EXAMPLE";`
    );
    const projectId = await newProjectAt(projectPath);
    const defectId = await insertDefect(projectId);
    const git = new GitStub().enqueue(
      ok("true\n"), ok(""), ok("main\n"), ok(""), ok(""),
      ok(""), ok(""),
      ok(""), ok(""), ok(""), ok("")
    );

    await applyFix({ defectId }, git.asRunGit(), NO_PATCH_TRANSPORT);

    const events = listEvents({ limit: 50 });
    const fixed = events.find((e) => e.action === "debug_fix_applied");
    expect(fixed).toBeDefined();
    const payload = JSON.parse(fixed!.payload);
    expect(payload.outcome).toBe("applied");
    expect(payload.fixTier).toBe(1);
  });

  it("falls through to Tier 2 when no Tier 1 codemod matches; abandons cleanly when LLM gives up", async () => {
    const projectId = await newProjectAt(projectPath);
    const defectId = await insertDefect(projectId, {
      ruleId: "client-side-auth/no-server-hint",
      file: "app/admin/page.tsx",
      codeEvidence: "user.role === 'admin'",
    });
    const git = new GitStub()
      .enqueue(ok("true\n"), ok(""), ok("main\n"), ok(""), ok(""))
      // abortBranch: checkout main, branch -D
      .enqueue(ok(""), ok(""));

    const result = await applyFix({ defectId }, git.asRunGit(), NO_PATCH_TRANSPORT);

    // Tier 2 stub returns empty edits → tier2_no_patch outcome.
    expect(result.outcome).toBe("tier2_no_patch");
    const row = getDb().select().from(defects).all()[0]!;
    expect(row.status).toBe("open");
  });

  it("returns branch_failed when the working tree is dirty", async () => {
    const projectId = await newProjectAt(projectPath);
    const defectId = await insertDefect(projectId);
    const git = new GitStub().enqueue(ok("true\n"), ok(" M src/foo.ts\n"));

    const result = await applyFix({ defectId }, git.asRunGit(), NO_PATCH_TRANSPORT);

    expect(result.outcome).toBe("branch_failed");
    expect(result.message).toMatch(/working tree is not clean/);
  });

  it("rejects an unknown defectId", async () => {
    await expect(
      applyFix({ defectId: "does-not-exist" }, undefined, NO_PATCH_TRANSPORT)
    ).rejects.toThrow(/defect not found/);
  });

  it("Tier 2 applies a clean LLM patch and marks defect fixed with fixTier=2", async () => {
    await fs.mkdir(path.join(projectPath, "app", "admin"), { recursive: true });
    await fs.writeFile(
      path.join(projectPath, "app", "admin", "page.tsx"),
      `export default function P({ user }: any) { return user.role === 'admin' ? <div /> : null; }`
    );
    const projectId = await newProjectAt(projectPath);
    const defectId = await insertDefect(projectId, {
      ruleId: "client-side-auth/no-server-hint",
      file: "app/admin/page.tsx",
      codeEvidence: "user.role === 'admin'",
    });
    const transport = stubPatchTransport({
      "client-side-auth/no-server-hint": JSON.stringify({
        explanation: "tighten the role check with a fallback default",
        edits: [
          {
            file: "app/admin/page.tsx",
            oldText: "user.role === 'admin'",
            newText: "(user?.role ?? 'guest') === 'admin'",
          },
        ],
      }),
    });
    const git = new GitStub().enqueue(
      // openBranch
      ok("true\n"), ok(""), ok("main\n"), ok(""), ok(""),
      // commitAll
      ok(""), ok(""),
      // squashOntoBase
      ok(""), ok(""), ok(""), ok("")
    );

    const result = await applyFix({ defectId }, git.asRunGit(), transport);

    expect(result.outcome).toBe("applied_tier2");
    const updated = getDb().select().from(defects).all()[0]!;
    expect(updated.status).toBe("fixed");
    expect(updated.fixTier).toBe(2);
    expect(updated.fixBranch).toBe(`ai-fix-${defectId}`);
  });

  it("Tier 2 verify_failed after MAX_TIER2_ATTEMPTS unsuccessful tries", async () => {
    await fs.mkdir(path.join(projectPath, "app", "admin"), { recursive: true });
    await fs.writeFile(
      path.join(projectPath, "app", "admin", "page.tsx"),
      `export default function P() { return null; }`
    );
    const projectId = await newProjectAt(projectPath);
    const defectId = await insertDefect(projectId, {
      ruleId: "client-side-auth/no-server-hint",
      file: "app/admin/page.tsx",
      codeEvidence: "user.role === 'admin'",
    });
    // Both attempts fail to find oldText.
    const transport = stubPatchTransport({
      "client-side-auth/no-server-hint": JSON.stringify({
        explanation: "wrong oldText",
        edits: [
          {
            file: "app/admin/page.tsx",
            oldText: "definitely-not-in-file",
            newText: "x",
          },
        ],
      }),
    });
    const git = new GitStub().enqueue(
      ok("true\n"), ok(""), ok("main\n"), ok(""), ok(""),
      ok(""), ok("")
    );

    const result = await applyFix({ defectId }, git.asRunGit(), transport);

    expect(result.outcome).toBe("tier2_verify_failed");
    const row = getDb().select().from(defects).all()[0]!;
    expect(row.status).toBe("open");

    // G7a Tier 3 hand-off: verify_failed populates the suggestion column
    // so the dashboard can surface the model's last attempt.
    expect(row.suggestion).not.toBeNull();
    const parsed = JSON.parse(row.suggestion!);
    expect(parsed.explanation).toContain("Tier 2");
    expect(parsed.edits).toHaveLength(1);
    expect(parsed.edits[0].file).toBe("app/admin/page.tsx");
    expect(parsed.errors).toContain("old_text_not_found");
  });

  it("Tier 2 no_patch populates the defect's suggestion column for Tier 3 review", async () => {
    const projectId = await newProjectAt(projectPath);
    const defectId = await insertDefect(projectId, {
      ruleId: "client-side-auth/no-server-hint",
      file: "app/admin/page.tsx",
      codeEvidence: "user.role === 'admin'",
    });
    const transport = stubPatchTransport({
      "client-side-auth/no-server-hint": JSON.stringify({
        explanation: "Slice does not show enough context to fix safely",
        edits: [],
      }),
    });
    const git = new GitStub().enqueue(
      ok("true\n"), ok(""), ok("main\n"), ok(""), ok(""),
      ok(""), ok("")
    );

    const result = await applyFix({ defectId }, git.asRunGit(), transport);

    expect(result.outcome).toBe("tier2_no_patch");
    const row = getDb().select().from(defects).all()[0]!;
    expect(row.suggestion).not.toBeNull();
    const parsed = JSON.parse(row.suggestion!);
    expect(parsed.explanation).toContain("Slice does not show enough context");
    expect(parsed.edits).toEqual([]);
  });

  it("aborts and flags syntax_check_failed when the codemod produces broken syntax", async () => {
    // Plant a fake defect whose location is in a file the codemod will
    // rewrite — but seed the file so the secret is preceded/followed by
    // tokens that, after replacement, leave broken syntax. We simulate
    // this by manipulating the file post-codemod via a wrapper transport,
    // but the simpler path: rely on extract-secret's quote-stripping to
    // produce invalid TS by leaving an unclosed string. Easiest: file
    // with a deliberately mismatched-quote structure.
    await fs.mkdir(path.join(projectPath, "lib"), { recursive: true });
    await fs.writeFile(
      path.join(projectPath, "lib", "aws.ts"),
      // Trailing unbalanced brace will never parse cleanly; the codemod
      // does its work on the literal but the rest of the file is still
      // broken. Confirms we abort rather than ship.
      `const KEY = "AKIAIOSFODNN7EXAMPLE";\nfunction broken( {`
    );
    const projectId = await newProjectAt(projectPath);
    const defectId = await insertDefect(projectId);
    const git = new GitStub()
      .enqueue(ok("true\n"), ok(""), ok("main\n"), ok(""), ok(""))
      .enqueue(ok(""), ok(""));

    const result = await applyFix({ defectId }, git.asRunGit(), NO_PATCH_TRANSPORT);
    expect(result.outcome).toBe("syntax_check_failed");
    expect(result.message).toContain("lib/aws.ts");
  });
});

// ----- G7b: rollback handler -----------------------------------------

describe("debug.rollbackFix handler", () => {
  function seedFixedDefect(
    projectId: string,
    overrides: Record<string, unknown> = {}
  ): string {
    const id = `defect-${Math.random().toString(36).slice(2, 10)}`;
    getDb()
      .insert(defects)
      .values({
        id,
        projectId,
        scanId: "test-scan",
        detectedAt: Date.now(),
        class: "security",
        severity: 9,
        blastRadius: 2.5,
        confidence: 0.9,
        difficulty: 1,
        priority: 40.5,
        band: "critical",
        file: "lib/aws.ts",
        lineStart: 1,
        lineEnd: 1,
        ruleId: "secret-regex/aws-access-key",
        humanExplanation: "...",
        codeEvidence: "...",
        status: "fixed",
        fixTier: 1,
        fixBranch: `ai-fix-${id}`,
        resolvedAt: Date.now(),
        resolvedCommit: "abc1234567890abc1234567890abc1234567890a",
        ...overrides,
      })
      .run();
    return id;
  }

  it("rolls back a fixed defect: runs git revert + flips status back to open", async () => {
    const projectId = await newProjectAt(projectPath);
    const defectId = seedFixedDefect(projectId);
    const git = new GitStub().enqueue(ok("")); // git revert --no-edit <commit>

    const result = await rollbackFix({ defectId }, git.asRunGit());

    expect(result.outcome).toBe("rolled_back");
    expect(git.calls[0]!.slice(0, 3)).toEqual(["revert", "--no-edit", "abc1234567890abc1234567890abc1234567890a"]);

    const row = getDb().select().from(defects).all()[0]!;
    expect(row.status).toBe("open");
    expect(row.fixTier).toBeNull();
    expect(row.fixBranch).toBeNull();
    expect(row.resolvedAt).toBeNull();
    expect(row.resolvedCommit).toBeNull();
  });

  it("emits debug_fix_rolled_back audit on success", async () => {
    const projectId = await newProjectAt(projectPath);
    const defectId = seedFixedDefect(projectId);
    const git = new GitStub().enqueue(ok(""));

    await rollbackFix({ defectId }, git.asRunGit());

    const events = listEvents({ limit: 50 });
    expect(events.some((e) => e.action === "debug_fix_rolled_back")).toBe(true);
  });

  it("returns expired when the rollback window has elapsed", async () => {
    const projectId = await newProjectAt(projectPath);
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const defectId = seedFixedDefect(projectId, { resolvedAt: eightDaysAgo });

    const result = await rollbackFix({ defectId });

    expect(result.outcome).toBe("expired");
    // Row unchanged.
    const row = getDb().select().from(defects).where(eq(defects.id, defectId)).all()[0]!;
    expect(row.status).toBe("fixed");
  });

  it("returns not_fixed when the defect's status is open", async () => {
    const projectId = await newProjectAt(projectPath);
    const defectId = seedFixedDefect(projectId, {
      status: "open",
      resolvedAt: null,
      resolvedCommit: null,
      fixBranch: null,
      fixTier: null,
    });

    const result = await rollbackFix({ defectId });
    expect(result.outcome).toBe("not_fixed");
  });

  it("returns no_commit_recorded for legacy fixes that predate G7b", async () => {
    const projectId = await newProjectAt(projectPath);
    const defectId = seedFixedDefect(projectId, { resolvedCommit: null });
    const result = await rollbackFix({ defectId });
    expect(result.outcome).toBe("no_commit_recorded");
  });

  it("returns revert_failed and audits when git revert errors (e.g. conflict)", async () => {
    const projectId = await newProjectAt(projectPath);
    const defectId = seedFixedDefect(projectId);
    const git = new GitStub().enqueue(fail("conflict in lib/aws.ts"), ok(""));

    const result = await rollbackFix({ defectId }, git.asRunGit());

    expect(result.outcome).toBe("revert_failed");
    expect(result.message).toContain("conflict");
    // Row unchanged.
    const row = getDb().select().from(defects).all()[0]!;
    expect(row.status).toBe("fixed");

    const events = listEvents({ limit: 50 });
    expect(events.some((e) => e.action === "debug_fix_rollback_failed")).toBe(true);
  });

  it("rejects an unknown defectId", async () => {
    await expect(rollbackFix({ defectId: "does-not-exist" })).rejects.toThrow(
      /defect not found/
    );
  });
});
