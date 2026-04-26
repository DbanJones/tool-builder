// Integration test for the sidecar's audit pipeline.
// Spawns the built sidecar against a temp DB, sends JSON-RPC over stdin,
// reads responses from stdout, and asserts the round-trip.
//
// Requires sidecar/dist/index.js to exist. Use the `pretest:integration` script
// (which calls `pnpm sidecar:build`) to ensure that.

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

    this.child = spawn(
      "node",
      [entry, "--db-path", dbPath, "--migrations-folder", migrations],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onChunk(chunk));

    // Drain stderr; surface only on test failure context.
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", () => {
      // intentionally noop; stderr is sidecar's structured log channel
    });

    // Wait a tick for the sidecar to print its "ready" log to stderr.
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
        // Ignore malformed lines; pending request will time out.
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

describe("sidecar audit pipeline (integration)", () => {
  let tempDir: string;
  let dbPath: string;
  let harness: SidecarHarness;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "builder-audit-test-"));
    dbPath = path.join(tempDir, "builder.db");
    harness = new SidecarHarness();
    await harness.start(dbPath);
  });

  afterAll(async () => {
    await harness.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("ping responds with pong", async () => {
    const response = await harness.call<{ pong: boolean; version: string }>("ping");
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result.pong).toBe(true);
      expect(response.result.version).toBe("0.1.0");
    }
  });

  it("audit.logEvent inserts a row, audit.listEvents reads it back", async () => {
    const eventType = "test_event_" + String(Date.now());

    const log = await harness.call<{ id: string }>("audit.logEvent", {
      eventType,
      payload: JSON.stringify({ trace: "abc" }),
    });
    expect(log.ok).toBe(true);
    if (!log.ok) return;
    expect(log.result.id).toMatch(/^[0-9A-Z]{26}$/);

    interface Entry {
      id: string;
      action: string;
      payload: string;
      actorId: string;
      targetId: string | null;
      createdAt: number;
    }
    const list = await harness.call<Entry[]>("audit.listEvents", { limit: 10 });
    expect(list.ok).toBe(true);
    if (!list.ok) return;

    const entry = list.result.find((e) => e.action === eventType);
    expect(entry).toBeDefined();
    if (!entry) return;
    expect(entry.id).toBe(log.result.id);
    expect(entry.actorId).toBe("novice");
    expect(entry.targetId).toBeNull();
    expect(JSON.parse(entry.payload) as { trace: string }).toEqual({ trace: "abc" });
    expect(typeof entry.createdAt).toBe("number");
  });

  it("audit.logEvent rejects an empty eventType", async () => {
    const r = await harness.call("audit.logEvent", { eventType: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("HANDLER_ERROR");
    }
  });

  it("unknown method returns UNKNOWN_METHOD error", async () => {
    const r = await harness.call("does.not.exist");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("UNKNOWN_METHOD");
    }
  });
});
