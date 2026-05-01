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

interface EasterEggFinding {
  check: "project" | "marker" | "text" | "shortcut";
  ok: boolean;
  message: string;
}

interface EasterEggVerifyResult {
  ok: boolean;
  findings: EasterEggFinding[];
  filesScanned: number;
  bytesScanned: number;
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

describe("sidecar D-EEGG verifier (integration)", () => {
  let tempDir: string;
  let dbPath: string;
  let harness: SidecarHarness;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "builder-easter-egg-test-"));
    dbPath = path.join(tempDir, "builder.db");
    harness = new SidecarHarness();
    await harness.start(dbPath);
  });

  afterAll(async () => {
    await harness.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("passes when source contains marker, exact text, and Alt+Shift+D handling", async () => {
    const projectId = await seedProject("complete", `
export function DavidEasterEgg() {
  window.addEventListener("keydown", (event) => {
    if (event.altKey && event.shiftKey && event.key.toLowerCase() === "d") {
      event.preventDefault();
    }
  }, { capture: true });
  return <p>made by david</p>;
}
// builder:david-easter-egg
`);

    const result = await verify(projectId);
    expect(result.ok).toBe(true);
    expect(result.findings.every((finding) => finding.ok)).toBe(true);
  });

  it("fails when the exact text is missing", async () => {
    const projectId = await seedProject("missing-text", `
export function DavidEasterEgg() {
  window.addEventListener("keydown", (event) => {
    if (event.altKey && event.shiftKey && event.key.toLowerCase() === "d") {
      event.preventDefault();
    }
  }, { capture: true });
  return <p>hello</p>;
}
// builder:david-easter-egg
`);

    const result = await verify(projectId);
    expect(result.ok).toBe(false);
    expect(result.findings.find((finding) => finding.check === "text")?.ok).toBe(false);
  });

  it("fails when Alt+Shift+D handling is missing", async () => {
    const projectId = await seedProject("missing-shortcut", `
export function DavidEasterEgg() {
  return <p>made by david</p>;
}
// builder:david-easter-egg
`);

    const result = await verify(projectId);
    expect(result.ok).toBe(false);
    expect(result.findings.find((finding) => finding.check === "shortcut")?.ok).toBe(false);
  });

  it("ignores node_modules when scanning source files", async () => {
    const projectPath = path.join(tempDir, "ignored-node-modules");
    fs.mkdirSync(path.join(projectPath, "app"), { recursive: true });
    fs.mkdirSync(path.join(projectPath, "node_modules", "fake"), { recursive: true });
    fs.writeFileSync(path.join(projectPath, "app", "page.tsx"), "export default function Page() { return null; }\n");
    fs.writeFileSync(
      path.join(projectPath, "node_modules", "fake", "David.tsx"),
      `
export function DavidEasterEgg() {
  if (event.altKey && event.shiftKey && event.key.toLowerCase() === "d") {}
  return <p>made by david</p>;
}
// builder:david-easter-egg
`,
    );

    const created = await harness.call<Project>("projects.create", {
      name: "ignored-node-modules",
      path: projectPath,
    });
    if (!created.ok) throw new Error(`could not seed project: ${created.error.message}`);

    const result = await verify(created.result.id);
    expect(result.ok).toBe(false);
    expect(result.filesScanned).toBe(1);
    expect(result.findings.find((finding) => finding.check === "marker")?.ok).toBe(false);
  });

  async function seedProject(name: string, source: string): Promise<string> {
    const projectPath = path.join(tempDir, name);
    fs.mkdirSync(path.join(projectPath, "app"), { recursive: true });
    fs.writeFileSync(path.join(projectPath, "app", "DavidEasterEgg.tsx"), source);
    const created = await harness.call<Project>("projects.create", { name, path: projectPath });
    if (!created.ok) throw new Error(`could not seed project: ${created.error.message}`);
    return created.result.id;
  }

  async function verify(projectId: string): Promise<EasterEggVerifyResult> {
    const result = await harness.call<EasterEggVerifyResult>("easterEgg.verify", { projectId });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    return result.result;
  }
});
