// Integration test for the sidecar's projects pipeline.
// Spawns the built sidecar against a temp DB, exercises projects.create
// (transactional insert + audit), projects.list, projects.get.

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
  status: string;
  currentPhase: string | null;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
  deletedAt: number | null;
}

interface AuditEntry {
  id: string;
  action: string;
  targetId: string | null;
  payload: string;
  actorId: string;
  createdAt: number;
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

describe("sidecar projects pipeline (integration)", () => {
  let tempDir: string;
  let dbPath: string;
  let harness: SidecarHarness;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "builder-projects-test-"));
    dbPath = path.join(tempDir, "builder.db");
    harness = new SidecarHarness();
    await harness.start(dbPath);
  });

  afterAll(async () => {
    await harness.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("projects.create inserts the project and a project_created audit row in one transaction", async () => {
    const created = await harness.call<Project>("projects.create", {
      name: "preppilot",
      path: "/tmp/preppilot",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.result.id).toMatch(/^[0-9A-Z]{26}$/);
    expect(created.result.name).toBe("preppilot");
    expect(created.result.path).toBe("/tmp/preppilot");
    expect(created.result.status).toBe("interviewing");
    expect(created.result.currentPhase).toBeNull();
    expect(created.result.deletedAt).toBeNull();

    // Audit row should exist with targetId === project id.
    const events = await harness.call<AuditEntry[]>("audit.listEvents", { limit: 50 });
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    const projectCreatedEvent = events.result.find(
      (e) => e.action === "project_created" && e.targetId === created.result.id,
    );
    expect(projectCreatedEvent).toBeDefined();
    if (!projectCreatedEvent) return;
    expect(projectCreatedEvent.actorId).toBe("novice");
    const payload = JSON.parse(projectCreatedEvent.payload) as { name: string; path: string };
    expect(payload).toEqual({ name: "preppilot", path: "/tmp/preppilot" });
  });

  it("projects.list returns inserted projects (excluding soft-deleted by default)", async () => {
    const list = await harness.call<Project[]>("projects.list");
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.result.some((p) => p.name === "preppilot")).toBe(true);
  });

  it("projects.get returns null for an unknown id", async () => {
    const r = await harness.call<Project | null>("projects.get", { id: "01NOPE" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result).toBeNull();
  });

  it("projects.create rejects a duplicate path (UNIQUE constraint)", async () => {
    const r = await harness.call("projects.create", {
      name: "preppilot2",
      path: "/tmp/preppilot",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("HANDLER_ERROR");
      expect(r.error.message).toMatch(/UNIQUE|constraint/i);
    }
  });

  it("projects.create rejects an empty name (Zod)", async () => {
    const r = await harness.call("projects.create", { name: "", path: "/tmp/x" });
    expect(r.ok).toBe(false);
  });

  it("projects.setStatus transitions interviewing → building → paused, persisting current_session_id", async () => {
    const created = await harness.call<Project>("projects.create", {
      name: "lifecycle-test",
      path: "/tmp/lifecycle",
    });
    if (!created.ok) throw new Error("seed failed");
    const id = created.result.id;
    expect(created.result.status).toBe("interviewing");

    const start = await harness.call<Project>("projects.setStatus", {
      id,
      status: "building",
      currentSessionId: "claude-session-abc",
      currentPhase: "A",
    });
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    expect(start.result.status).toBe("building");

    const paused = await harness.call<Project & { currentSessionId: string | null }>(
      "projects.setStatus",
      { id, status: "paused" },
    );
    expect(paused.ok).toBe(true);
    if (!paused.ok) return;
    expect(paused.result.status).toBe("paused");
    // currentSessionId from the building call must persist (the pause call
    // didn't touch it) so resume can use it.
    expect(paused.result.currentSessionId).toBe("claude-session-abc");
  });

  it("projects.setStatus rejects an unknown id", async () => {
    const r = await harness.call("projects.setStatus", { id: "01NONEXISTENT", status: "paused" });
    expect(r.ok).toBe(false);
  });

  it("projects.setStatus rejects an invalid status enum", async () => {
    const r = await harness.call("projects.setStatus", { id: "anything", status: "exploding" });
    expect(r.ok).toBe(false);
  });
});
