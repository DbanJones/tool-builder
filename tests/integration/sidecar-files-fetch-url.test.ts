// Integration test for files.fetchUrl. Spins up a local HTTP server in
// the test process so we don't make real network calls.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
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

interface FetchUrlResult {
  kind: string;
  url: string;
  finalUrl: string;
  status: number;
  title: string | null;
  description: string | null;
  headings: string[];
  bodySnippet: string;
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

describe("sidecar files.fetchUrl (integration)", () => {
  let tempDir: string;
  let harness: SidecarHarness;
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    // Local HTTP server with two routes so we can exercise the parser
    // against deterministic HTML.
    server = http.createServer((req, res) => {
      if (req.url === "/landing") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
<html>
  <head>
    <title>  Acme — Calm software for busy teams  </title>
    <meta name="description" content="Acme helps teams stay calm under pressure.">
    <meta property="og:description" content="Acme: the calm software platform for busy teams.">
  </head>
  <body>
    <script>console.log("should be stripped");</script>
    <h1>Acme</h1>
    <h2>Why Acme</h2>
    <h2>Features</h2>
    <p>Acme is a calm-but-mighty productivity platform.</p>
    <svg><circle cx="10" cy="10" r="5"/></svg>
  </body>
</html>`);
        return;
      }
      if (req.url === "/empty") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><head></head><body></body></html>");
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (typeof addr !== "object" || addr === null) throw new Error("server address?");
    baseUrl = `http://127.0.0.1:${String(addr.port)}`;

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "builder-fetch-url-test-"));
    const dbPath = path.join(tempDir, "builder.db");
    const migrationsFolder = path.resolve(process.cwd(), "sidecar", "migrations");
    harness = new SidecarHarness();
    await harness.start(dbPath, migrationsFolder);
  });

  afterAll(async () => {
    await harness.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("fetches a landing-page fixture and extracts title, og:description, and headings", async () => {
    const r = await harness.call<FetchUrlResult>("files.fetchUrl", {
      url: `${baseUrl}/landing`,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.kind).toBe("url");
    expect(r.result.status).toBe(200);
    // Title whitespace collapsed.
    expect(r.result.title).toBe("Acme — Calm software for busy teams");
    // og:description preferred over plain meta.
    expect(r.result.description).toBe("Acme: the calm software platform for busy teams.");
    expect(r.result.headings).toEqual(["Acme", "Why Acme", "Features"]);
    // script + svg stripped from snippet.
    expect(r.result.bodySnippet).not.toContain("console.log");
    expect(r.result.bodySnippet).toContain("Acme is a calm-but-mighty");
    expect(r.result.summary).toContain("Acme — Calm software");
    expect(r.result.summary).toContain("Acme: the calm software");
  });

  it("handles a page with empty head/body without throwing", async () => {
    const r = await harness.call<FetchUrlResult>("files.fetchUrl", {
      url: `${baseUrl}/empty`,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.title).toBeNull();
    expect(r.result.description).toBeNull();
    expect(r.result.headings).toEqual([]);
    expect(r.result.summary).toBe("(no extractable summary; see bodySnippet)");
  });

  it("rejects a non-http URL", async () => {
    const r = await harness.call("files.fetchUrl", { url: "ftp://example.com" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toMatch(/http\(s\)/);
    }
  });

  it("rejects a malformed URL", async () => {
    const r = await harness.call("files.fetchUrl", { url: "not a url at all" });
    expect(r.ok).toBe(false);
  });
});
