// Integration test for files.parseDataSample (CSV + JSON data array).
// SQL-dump support is deferred — drift D-011.

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

interface ColumnSummary {
  name: string;
  inferredType: "integer" | "number" | "boolean" | "date" | "text" | "unknown";
  nonNullCount: number;
  nullCount: number;
  examples: string[];
}

interface ParseDataSampleResult {
  kind: string;
  format: "csv" | "json-data";
  totalRowsObserved: number;
  sampledRows: number;
  columns: ColumnSummary[];
  candidateDrizzleSchema: string;
  summary: string;
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

describe("sidecar files.parseDataSample (integration)", () => {
  let tempDir: string;
  let harness: SidecarHarness;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "builder-parse-data-test-"));
    const dbPath = path.join(tempDir, "builder.db");
    const migrationsFolder = path.resolve(process.cwd(), "sidecar", "migrations");
    harness = new SidecarHarness();
    await harness.start(dbPath, migrationsFolder);
  });

  afterAll(async () => {
    await harness.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("parses a CSV fixture, infers types, and emits a candidate Drizzle schema", async () => {
    const fixture = path.resolve(process.cwd(), "tests", "fixtures", "sample-data.csv");
    const r = await harness.call<ParseDataSampleResult>("files.parseDataSample", { path: fixture });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.format).toBe("csv");
    expect(r.result.totalRowsObserved).toBe(5);
    expect(r.result.sampledRows).toBe(5);

    const byName = new Map(r.result.columns.map((c) => [c.name, c]));
    expect(byName.get("id")?.inferredType).toBe("text");
    expect(byName.get("email")?.inferredType).toBe("text");
    expect(byName.get("signed_up_at")?.inferredType).toBe("date");
    expect(byName.get("credits")?.inferredType).toBe("integer");
    expect(byName.get("is_admin")?.inferredType).toBe("boolean");
    // display_name has one empty value; should still be text on the rest.
    expect(byName.get("display_name")?.inferredType).toBe("text");
    expect(byName.get("display_name")?.nullCount).toBe(1);

    expect(r.result.candidateDrizzleSchema).toContain("sqliteTable(\"sample_data\"");
    expect(r.result.candidateDrizzleSchema).toContain("credits: integer(\"credits\")");
    expect(r.result.candidateDrizzleSchema).toContain("is_admin: integer({ mode: \"boolean\" })(\"is_admin\")");
    expect(r.result.summary).toMatch(/CSV: 5 rows observed/);
  });

  it("parses a JSON-data fixture (array of objects) and infers per-key types", async () => {
    const fixture = path.resolve(process.cwd(), "tests", "fixtures", "sample-data.json");
    const r = await harness.call<ParseDataSampleResult>("files.parseDataSample", { path: fixture });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.format).toBe("json-data");
    expect(r.result.totalRowsObserved).toBe(3);
    const byName = new Map(r.result.columns.map((c) => [c.name, c]));
    expect(byName.get("id")?.inferredType).toBe("text");
    expect(byName.get("title")?.inferredType).toBe("text");
    expect(byName.get("minutes")?.inferredType).toBe("integer");
    expect(byName.get("free")?.inferredType).toBe("boolean");
    // tags is JSON array stringified -> text.
    expect(byName.get("tags")?.inferredType).toBe("text");
    expect(r.result.summary).toMatch(/JSON data: 3 objects observed/);
  });

  it("rejects an unsupported extension with a useful message pointing at parseSchema for SQL dumps", async () => {
    const weird = path.join(tempDir, "what.xyz");
    fs.writeFileSync(weird, "nope");
    const r = await harness.call("files.parseDataSample", { path: weird });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("HANDLER_ERROR");
      expect(r.error.message).toMatch(/unsupported extension/);
      expect(r.error.message).toMatch(/D-011/);
    }
  });

  it("rejects a JSON file that is not an array of objects", async () => {
    const notArray = path.join(tempDir, "obj.json");
    fs.writeFileSync(notArray, JSON.stringify({ name: "scalar" }));
    const r = await harness.call("files.parseDataSample", { path: notArray });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toMatch(/not an array/);
    }
  });
});
