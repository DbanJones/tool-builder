// Integration test for the sidecar files.extractText handler.
//
// MD and TXT extraction are exercised against real fixture files in
// tests/fixtures/. PDF and DOCX extractors are implemented in
// sidecar/src/handlers/files.ts but are tested manually for now: real
// binary fixtures are tracked under drift D-009.

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

interface ExtractResult {
  kind: string;
  text: string;
  summary: string;
  pages: number | null;
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

describe("sidecar files.extractText (integration)", () => {
  let tempDir: string;
  let harness: SidecarHarness;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "builder-extract-test-"));
    const dbPath = path.join(tempDir, "builder.db");
    const migrationsFolder = path.resolve(process.cwd(), "sidecar", "migrations");
    harness = new SidecarHarness();
    await harness.start(dbPath, migrationsFolder);
  });

  afterAll(async () => {
    await harness.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("extracts a markdown fixture and preserves its paragraphs", async () => {
    const fixturePath = path.resolve(process.cwd(), "tests", "fixtures", "sample.md");
    const r = await harness.call<ExtractResult>("files.extractText", { path: fixturePath });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.kind).toBe("document");
    expect(r.result.text).toContain("# Sample PRD");
    expect(r.result.text).toContain("Goals");
    expect(r.result.text).toContain("Non-goals");
    expect(r.result.pages).toBeNull();
    expect(r.result.sizeBytes).toBeGreaterThan(0);
    expect(r.result.summary.length).toBeLessThanOrEqual(500);
    expect(r.result.summary).toContain("Sample PRD");
  });

  it("extracts a plain-text fixture", async () => {
    const fixturePath = path.resolve(process.cwd(), "tests", "fixtures", "sample.txt");
    const r = await harness.call<ExtractResult>("files.extractText", { path: fixturePath });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.kind).toBe("document");
    expect(r.result.text).toContain("Plain text fixture.");
    expect(r.result.text).toContain("Two paragraphs");
    expect(r.result.pages).toBeNull();
  });

  it("rejects an unsupported extension with a useful message", async () => {
    // Create a temp file with an unsupported extension.
    const weird = path.join(tempDir, "what.xyz");
    fs.writeFileSync(weird, "nope");
    const r = await harness.call("files.extractText", { path: weird });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("HANDLER_ERROR");
      expect(r.error.message).toMatch(/unsupported extension/);
    }
  });

  it("rejects a missing path", async () => {
    const r = await harness.call("files.extractText", {
      path: path.join(tempDir, "does-not-exist.md"),
    });
    expect(r.ok).toBe(false);
  });

  it("summary collapses whitespace and is bounded at 500 chars", async () => {
    const big = path.join(tempDir, "big.md");
    fs.writeFileSync(big, "hello\nworld\n\n" + "x".repeat(2000));
    const r = await harness.call<ExtractResult>("files.extractText", { path: big });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.summary.length).toBeLessThanOrEqual(500);
    expect(r.result.summary).not.toContain("\n");
  });
});
