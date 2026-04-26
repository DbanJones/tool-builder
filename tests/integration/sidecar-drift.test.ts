// Integration test for the sidecar's drift_events handler — the backing
// store for the dashboard's drift banner per spec.md §4 + Flow G.

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
}
interface DriftEvent {
  id: string;
  projectId: string;
  phase: string;
  kind: "implementation" | "scope" | "silent_assumption" | "nfr";
  description: string;
  resolution: "revert" | "amend_spec" | "accept" | null;
  commitHash: string | null;
  occurredAt: number;
  resolvedAt: number | null;
}

class SidecarHarness {
  private child!: ChildProcessWithoutNullStreams;
  private buffer = "";
  private pending = new Map<string, (line: string) => void>();
  private nextId = 1;

  async start(dbPath: string): Promise<void> {
    const sidecarRoot = path.resolve(process.cwd(), "sidecar");
    const entry = path.join(sidecarRoot, "dist", "index.js");
    if (!fs.existsSync(entry)) throw new Error(`sidecar build missing at ${entry}`);
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
        /* ignore */
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
          reject(new Error(`sidecar timeout id=${id}`));
        }
      }, 5000);
    });
    this.child.stdin.write(request + "\n");
    return JSON.parse(await responsePromise) as Response<T>;
  }

  async stop(): Promise<void> {
    this.child.stdin.end();
    await new Promise((r) => this.child.on("exit", r));
  }
}

describe("sidecar drift pipeline (integration)", () => {
  let tempDir: string;
  let harness: SidecarHarness;
  let projectId: string;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "builder-drift-test-"));
    harness = new SidecarHarness();
    await harness.start(path.join(tempDir, "builder.db"));
    const created = await harness.call<Project>("projects.create", {
      name: "drift-test",
      path: "/tmp/drift-test",
    });
    if (!created.ok) throw new Error("could not seed project");
    projectId = created.result.id;
  });

  afterAll(async () => {
    await harness.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("appends a drift event with resolution=null", async () => {
    const r = await harness.call<DriftEvent>("drift.append", {
      projectId,
      phase: "phase-1",
      kind: "implementation",
      description: "Auth uses session cookies; spec says JWT",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.id).toMatch(/^[0-9A-Z]{26}$/);
    expect(r.result.kind).toBe("implementation");
    expect(r.result.resolution).toBeNull();
    expect(r.result.resolvedAt).toBeNull();
  });

  it("listOpen returns only events with resolution IS NULL, oldest first", async () => {
    await harness.call("drift.append", {
      projectId,
      phase: "phase-1",
      kind: "scope",
      description: "Added analytics route, not in spec",
    });
    const r = await harness.call<DriftEvent[]>("drift.listOpen", { projectId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < r.result.length; i++) {
      const prev = r.result[i - 1];
      const cur = r.result[i];
      if (!prev || !cur) continue;
      expect(cur.occurredAt).toBeGreaterThanOrEqual(prev.occurredAt);
      expect(cur.resolution).toBeNull();
    }
  });

  it("resolve sets resolution + resolvedAt and removes the event from listOpen", async () => {
    const created = await harness.call<DriftEvent>("drift.append", {
      projectId,
      phase: "phase-2",
      kind: "silent_assumption",
      description: "Picked Postgres without an ADR",
    });
    if (!created.ok) throw new Error("seed failed");
    const targetId = created.result.id;

    const resolved = await harness.call<DriftEvent>("drift.resolve", {
      id: targetId,
      resolution: "accept",
      commitHash: "abc1234",
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.result.resolution).toBe("accept");
    expect(resolved.result.commitHash).toBe("abc1234");
    expect(resolved.result.resolvedAt).not.toBeNull();

    const open = await harness.call<DriftEvent[]>("drift.listOpen", { projectId });
    if (!open.ok) throw new Error("list failed");
    expect(open.result.find((e) => e.id === targetId)).toBeUndefined();
  });

  it("rejects an unknown id on resolve", async () => {
    const r = await harness.call("drift.resolve", { id: "01NONEXISTENT", resolution: "accept" });
    expect(r.ok).toBe(false);
  });

  it("rejects an invalid kind enum on append (Zod boundary)", async () => {
    const r = await harness.call("drift.append", {
      projectId,
      phase: "phase-1",
      kind: "made_up_kind",
      description: "bad",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects an invalid resolution enum on resolve", async () => {
    const created = await harness.call<DriftEvent>("drift.append", {
      projectId,
      phase: "phase-1",
      kind: "nfr",
      description: "perf budget missed",
    });
    if (!created.ok) throw new Error("seed failed");
    const r = await harness.call("drift.resolve", {
      id: created.result.id,
      resolution: "ignore",
    });
    expect(r.ok).toBe(false);
  });
});
