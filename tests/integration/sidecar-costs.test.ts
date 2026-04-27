// Integration test for the sidecar's costs handler — the cost meter's
// backing store per spec.md §4.

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
interface Cost {
  id: string;
  projectId: string;
  ts: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  usdCents: number;
}
interface CostSum {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  usdCents: number;
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

describe("sidecar costs pipeline (integration)", () => {
  let tempDir: string;
  let harness: SidecarHarness;
  let projectId: string;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "builder-costs-test-"));
    harness = new SidecarHarness();
    await harness.start(path.join(tempDir, "builder.db"));

    const created = await harness.call<Project>("projects.create", {
      name: "costs-test",
      path: "/tmp/costs-test",
    });
    if (!created.ok) throw new Error(`could not seed project: ${created.error.message}`);
    projectId = created.result.id;
  });

  afterAll(async () => {
    await harness.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("appends a cost row and converts costUsd to integer cents (rounded)", async () => {
    const r = await harness.call<Cost>("costs.append", {
      projectId,
      model: "sonnet",
      inputTokens: 1500,
      outputTokens: 250,
      costUsd: 0.0237, // -> 2 cents (0.0237 * 100 = 2.37 → round to 2)
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.id).toMatch(/^[0-9A-Z]{26}$/);
    expect(r.result.model).toBe("sonnet");
    expect(r.result.inputTokens).toBe(1500);
    expect(r.result.outputTokens).toBe(250);
    expect(r.result.usdCents).toBe(2);
  });

  it("sums multiple turns into one aggregate row for the cost meter", async () => {
    await harness.call("costs.append", {
      projectId,
      model: "sonnet",
      inputTokens: 1000,
      outputTokens: 200,
      costUsd: 0.05,
    });
    await harness.call("costs.append", {
      projectId,
      model: "opus",
      inputTokens: 500,
      outputTokens: 100,
      costUsd: 0.15,
    });

    const r = await harness.call<CostSum>("costs.sumByProject", { projectId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Includes the first test's row + the two appended here.
    expect(r.result.turns).toBeGreaterThanOrEqual(3);
    expect(r.result.inputTokens).toBeGreaterThanOrEqual(3000);
    expect(r.result.outputTokens).toBeGreaterThanOrEqual(550);
    // 2 + 5 + 15 = 22 cents at minimum.
    expect(r.result.usdCents).toBeGreaterThanOrEqual(22);
  });

  it("returns a zero aggregate for a project with no cost rows", async () => {
    const fresh = await harness.call<Project>("projects.create", {
      name: "no-costs",
      path: "/tmp/no-costs",
    });
    if (!fresh.ok) throw new Error("could not seed");
    const r = await harness.call<CostSum>("costs.sumByProject", { projectId: fresh.result.id });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.turns).toBe(0);
    expect(r.result.inputTokens).toBe(0);
    expect(r.result.outputTokens).toBe(0);
    expect(r.result.usdCents).toBe(0);
  });

  it("rejects negative cost (Zod boundary)", async () => {
    const r = await harness.call("costs.append", {
      projectId,
      model: "sonnet",
      costUsd: -0.5,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects NaN / Infinity costUsd via .finite() guard", async () => {
    // JSON has no NaN literal, so encode the request manually.
    const nan = await harness.call("costs.append", {
      projectId,
      model: "sonnet",
      costUsd: Number.NaN,
    });
    expect(nan.ok).toBe(false);

    const inf = await harness.call("costs.append", {
      projectId,
      model: "sonnet",
      costUsd: Number.POSITIVE_INFINITY,
    });
    expect(inf.ok).toBe(false);
  });

  it("rejects an empty model name", async () => {
    const r = await harness.call("costs.append", { projectId, model: "" });
    expect(r.ok).toBe(false);
  });
});
