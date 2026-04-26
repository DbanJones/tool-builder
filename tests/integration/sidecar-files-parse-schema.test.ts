// Integration test for the sidecar files.parseSchema handler.
// Exercises the SQL, JSON Schema, and OpenAPI (YAML) paths against
// fixture files in tests/fixtures/.

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

interface ParseSchemaResult {
  kind: string;
  format: "sql" | "json-schema" | "openapi";
  summary: string;
  tables?: Array<{ name: string; columns: Array<{ name: string; type: string; nullable: boolean; primaryKey: boolean }> }>;
  jsonShape?: { topLevelType: string; topLevelProperties: string[] };
  openapi?: { title: string; version: string; paths: Array<{ path: string; methods: string[] }> };
  sizeBytes: number;
}

class SidecarHarness {
  private child!: ChildProcessWithoutNullStreams;
  private buffer = "";
  private pending = new Map<string, (line: string) => void>();
  private nextId = 1;

  async start(dbPath: string, migrationsFolder: string): Promise<void> {
    const sidecarRoot = path.resolve(process.cwd(), "sidecar");
    const entry = path.join(sidecarRoot, "dist", "index.js");
    this.child = spawn(
      "node",
      [entry, "--db-path", dbPath, "--migrations-folder", migrationsFolder],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onChunk(chunk));
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
        const r = this.pending.get(parsed.id);
        if (r) {
          this.pending.delete(parsed.id);
          r(line);
        }
      } catch {
        // ignore
      }
    }
  }

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<Response<T>> {
    const id = String(this.nextId++);
    const promise = new Promise<string>((resolve, reject) => {
      this.pending.set(id, resolve);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout id=${id}`));
        }
      }, 10000);
    });
    this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    const line = await promise;
    return JSON.parse(line) as Response<T>;
  }

  async stop(): Promise<void> {
    this.child.stdin.end();
    await new Promise((r) => this.child.on("exit", r));
  }
}

describe("sidecar files.parseSchema (integration)", () => {
  let tempDir: string;
  let harness: SidecarHarness;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "builder-parse-schema-test-"));
    const dbPath = path.join(tempDir, "builder.db");
    const migrationsFolder = path.resolve(process.cwd(), "sidecar", "migrations");
    harness = new SidecarHarness();
    await harness.start(dbPath, migrationsFolder);
  });

  afterAll(async () => {
    await harness.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("parses CREATE TABLE statements out of a SQL fixture", async () => {
    const fixture = path.resolve(process.cwd(), "tests", "fixtures", "sample.sql");
    const r = await harness.call<ParseSchemaResult>("files.parseSchema", { path: fixture });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.format).toBe("sql");
    expect(r.result.tables).toBeDefined();
    const tableNames = (r.result.tables ?? []).map((t) => t.name).sort();
    expect(tableNames).toEqual(["sessions", "users"]);
    const users = (r.result.tables ?? []).find((t) => t.name === "users");
    expect(users?.columns.map((c) => c.name).sort()).toEqual([
      "created_at",
      "display_name",
      "email",
      "id",
    ]);
    const idCol = users?.columns.find((c) => c.name === "id");
    expect(idCol?.primaryKey).toBe(true);
    const emailCol = users?.columns.find((c) => c.name === "email");
    expect(emailCol?.nullable).toBe(false);
    expect(r.result.summary).toMatch(/2 tables/);
  });

  it("parses a JSON Schema fixture and lists top-level properties", async () => {
    const fixture = path.resolve(process.cwd(), "tests", "fixtures", "sample-schema.json");
    const r = await harness.call<ParseSchemaResult>("files.parseSchema", { path: fixture });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.format).toBe("json-schema");
    expect(r.result.jsonShape?.topLevelType).toBe("object");
    expect(r.result.jsonShape?.topLevelProperties.sort()).toEqual([
      "duration_minutes",
      "id",
      "instructor",
      "tags",
      "title",
    ]);
    expect(r.result.summary).toMatch(/5 top-level fields/);
  });

  it("parses an OpenAPI YAML fixture and enumerates paths/methods", async () => {
    const fixture = path.resolve(process.cwd(), "tests", "fixtures", "sample-openapi.yaml");
    const r = await harness.call<ParseSchemaResult>("files.parseSchema", { path: fixture });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.format).toBe("openapi");
    expect(r.result.openapi?.title).toBe("Sample API");
    expect(r.result.openapi?.version).toBe("1.2.3");
    const paths = r.result.openapi?.paths ?? [];
    const pathNames = paths.map((p) => p.path).sort();
    expect(pathNames).toEqual(["/users", "/users/{id}"]);
    const usersPath = paths.find((p) => p.path === "/users");
    expect(usersPath?.methods.sort()).toEqual(["GET", "POST"]);
    expect(r.result.summary).toMatch(/Sample API v1\.2\.3/);
    expect(r.result.summary).toMatch(/2 paths/);
  });

  it("rejects an unsupported extension", async () => {
    const weird = path.join(tempDir, "what.xyz");
    fs.writeFileSync(weird, "nope");
    const r = await harness.call("files.parseSchema", { path: weird });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("HANDLER_ERROR");
      expect(r.error.message).toMatch(/unsupported extension/);
    }
  });

  it("rejects a YAML file that is not OpenAPI", async () => {
    const notOpenApi = path.join(tempDir, "config.yaml");
    fs.writeFileSync(notOpenApi, "version: 1\nname: nope\n");
    const r = await harness.call("files.parseSchema", { path: notOpenApi });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toMatch(/openapi.*swagger/i);
    }
  });
});
