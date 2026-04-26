// Integration test for the sidecar's actions handler — the live tail backing
// store per spec.md §4 data model. Spawns the built sidecar against a temp DB,
// exercises actions.append + actions.list (cursor pagination + ordering).

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface SuccessResponse<T> {
  id: string;
  ok: true;
  result: T;
}

interface FailureResponse {
  id: string;
  ok: false;
  error: { code: string; message: string };
}

type Response<T> = SuccessResponse<T> | FailureResponse;

interface Project {
  id: string;
  name: string;
  path: string;
}

interface Action {
  id: string;
  projectId: string;
  ts: number;
  tool: string;
  rawInput: string;
  humanLine: string | null;
  phase: string | null;
  taskId: string | null;
}

class SidecarHarness {
  private child!: ChildProcessWithoutNullStreams;
  private buffer = "";
  private pending = new Map<string, (line: string) => void>();
  private nextId = 1;

  async start(dbPath: string): Promise<void> {
    const sidecarRoot = path.resolve(process.cwd(), "sidecar");
    const entry = path.join(sidecarRoot, "dist", "index.js");
    if (!fs.existsSync(entry)) {
      throw new Error(`sidecar build missing at ${entry}; run pnpm sidecar:build`);
    }
    const migrations = path.join(sidecarRoot, "migrations");
    this.child = spawn("node", [entry, "--db-path", dbPath, "--migrations-folder", migrations], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onChunk(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", () => undefined);
    await new Promise((r) => setTimeout(r, 200));
  }

  private onChunk(chunk: string): void {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length === 0) continue;
      try {
        const parsed = JSON.parse(line) as { id: string };
        const resolver = this.pending.get(parsed.id);
        if (resolver) {
          this.pending.delete(parsed.id);
          resolver(line);
        }
      } catch {
        // ignore malformed lines
      }
    }
  }

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<Response<T>> {
    const id = String(this.nextId++);
    const request = JSON.stringify({ id, method, params });
    const responsePromise = new Promise<string>((resolve, reject) => {
      this.pending.set(id, resolve);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`sidecar timeout waiting for response to id=${id}`));
        }
      }, 5000);
    });
    this.child.stdin.write(request + "\n");
    const line = await responsePromise;
    return JSON.parse(line) as Response<T>;
  }

  async stop(): Promise<void> {
    this.child.stdin.end();
    await new Promise((r) => this.child.on("exit", r));
  }
}

describe("sidecar actions pipeline (integration)", () => {
  let tempDir: string;
  let dbPath: string;
  let harness: SidecarHarness;
  let projectId: string;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "builder-actions-test-"));
    dbPath = path.join(tempDir, "builder.db");
    harness = new SidecarHarness();
    await harness.start(dbPath);

    const created = await harness.call<Project>("projects.create", {
      name: "actions-test",
      path: "/tmp/actions-test",
    });
    if (!created.ok) throw new Error(`could not seed project: ${created.error.message}`);
    projectId = created.result.id;
  });

  afterAll(async () => {
    await harness.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("appends a tool-call row and returns it with an assigned ULID + timestamp", async () => {
    const r = await harness.call<Action>("actions.append", {
      projectId,
      tool: "Edit",
      rawInput: JSON.stringify({ file_path: "app/page.tsx", old_string: "x", new_string: "y" }),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.id).toMatch(/^[0-9A-Z]{26}$/);
    expect(r.result.tool).toBe("Edit");
    expect(r.result.projectId).toBe(projectId);
    expect(r.result.ts).toBeGreaterThan(0);
    expect(r.result.humanLine).toBeNull();
    expect(r.result.phase).toBeNull();
    expect(r.result.taskId).toBeNull();
  });

  it("preserves the rawInput verbatim (no re-encoding)", async () => {
    const raw = JSON.stringify({ command: "pnpm verify", description: "merge gate" });
    const r = await harness.call<Action>("actions.append", {
      projectId,
      tool: "Bash",
      rawInput: raw,
      humanLine: "Running pnpm verify",
      phase: "phase-1",
      taskId: "A1",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.rawInput).toBe(raw);
    expect(r.result.humanLine).toBe("Running pnpm verify");
    expect(r.result.phase).toBe("phase-1");
    expect(r.result.taskId).toBe("A1");
  });

  it("lists actions in oldest-first order by default", async () => {
    const r = await harness.call<Action[]>("actions.list", { projectId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < r.result.length; i++) {
      const prev = r.result[i - 1];
      const cur = r.result[i];
      expect(prev).toBeDefined();
      expect(cur).toBeDefined();
      if (!prev || !cur) continue;
      expect(cur.ts).toBeGreaterThanOrEqual(prev.ts);
    }
  });

  it("paginates with sinceTs (returns only rows strictly newer than the cursor)", async () => {
    const all = await harness.call<Action[]>("actions.list", { projectId });
    if (!all.ok) throw new Error("could not list");
    const cursor = all.result[0]?.ts;
    expect(cursor).toBeDefined();
    if (cursor === undefined) return;
    const rest = await harness.call<Action[]>("actions.list", { projectId, sinceTs: cursor });
    if (!rest.ok) throw new Error("could not list after cursor");
    for (const row of rest.result) {
      expect(row.ts).toBeGreaterThan(cursor);
    }
  });

  it("supports newest-first ordering for the dashboard's 'recent' view", async () => {
    const r = await harness.call<Action[]>("actions.list", { projectId, order: "desc" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (let i = 1; i < r.result.length; i++) {
      const prev = r.result[i - 1];
      const cur = r.result[i];
      if (!prev || !cur) continue;
      expect(cur.ts).toBeLessThanOrEqual(prev.ts);
    }
  });

  it("rejects an empty projectId (Zod boundary validation)", async () => {
    const r = await harness.call("actions.append", { projectId: "", tool: "Bash", rawInput: "{}" });
    expect(r.ok).toBe(false);
  });

  it("rejects an empty tool name", async () => {
    const r = await harness.call("actions.append", { projectId, tool: "", rawInput: "{}" });
    expect(r.ok).toBe(false);
  });

  it("mirrors the row to {historyLogPath} as a JSON line when the path is provided (binding rule 7)", async () => {
    const logPath = path.join(tempDir, "test-history.log");
    const r = await harness.call<Action>("actions.append", {
      projectId,
      tool: "Read",
      rawInput: JSON.stringify({ file_path: "spec.md" }),
      humanLine: "Reading spec.md",
      historyLogPath: logPath,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(fs.existsSync(logPath)).toBe(true);
    const content = fs.readFileSync(logPath, "utf8");
    const lines = content.trim().split("\n");
    const last = lines[lines.length - 1];
    expect(last).toBeDefined();
    if (!last) return;
    const parsed = JSON.parse(last) as { tool: string; humanLine: string; id: string };
    expect(parsed.tool).toBe("Read");
    expect(parsed.humanLine).toBe("Reading spec.md");
    expect(parsed.id).toBe(r.result.id);
  });

  it("creates the parent directory of historyLogPath if it does not exist", async () => {
    const logPath = path.join(tempDir, "deep", "nested", "history.log");
    const r = await harness.call<Action>("actions.append", {
      projectId,
      tool: "Bash",
      rawInput: JSON.stringify({ command: "ls" }),
      historyLogPath: logPath,
    });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(logPath)).toBe(true);
  });

  it("survives a write failure on history.log (DB row still inserted)", async () => {
    // Pointing the log at a path that traverses through a regular file forces
    // mkdir to fail — mirrors real-world cases like a permissions glitch on
    // the novice's machine. The DB insert must still succeed.
    const sentinelFile = path.join(tempDir, "blocking-file");
    fs.writeFileSync(sentinelFile, "x");
    const logPath = path.join(sentinelFile, "child", "history.log");
    const r = await harness.call<Action>("actions.append", {
      projectId,
      tool: "Edit",
      rawInput: JSON.stringify({ file_path: "x" }),
      historyLogPath: logPath,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.tool).toBe("Edit");
    expect(fs.existsSync(logPath)).toBe(false);
  });
});
