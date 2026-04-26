// Integration test for the MCP record_answer tool.
// Spawns the built MCP server pointed at a temp DB, drives it through the
// MCP protocol via the official SDK's stdio client, calls record_answer,
// then verifies the answer landed in the DB by spawning the main sidecar
// and calling answers.list.
//
// Requires sidecar/dist/mcp-server.js + sidecar/dist/index.js (the
// pretest:integration script handles both).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
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

interface AnswerRow {
  id: string;
  projectId: string;
  questionId: string;
  answerText: string;
  confidence: string;
  source: string;
  rationale: string | null;
  createdAt: number;
}

class MainSidecarHarness {
  private child!: ChildProcessWithoutNullStreams;
  private buffer = "";
  private pending = new Map<string, (line: string) => void>();
  private nextId = 1;

  async start(dbPath: string, migrationsFolder: string): Promise<void> {
    const sidecarRoot = path.resolve(process.cwd(), "sidecar");
    const entry = path.join(sidecarRoot, "dist", "index.js");
    this.child = spawn("node", [entry, "--db-path", dbPath, "--migrations-folder", migrationsFolder], {
      stdio: ["pipe", "pipe", "pipe"],
    });
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
      }, 5000);
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

describe("MCP record_answer tool (integration)", () => {
  let tempDir: string;
  let dbPath: string;
  let migrationsFolder: string;
  let mainSidecar: MainSidecarHarness;
  let project: Project;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "builder-mcp-test-"));
    dbPath = path.join(tempDir, "builder.db");
    migrationsFolder = path.resolve(process.cwd(), "sidecar", "migrations");

    // Bootstrap: main sidecar applies migrations and creates a project so the
    // FK on answers.project_id has a real target.
    mainSidecar = new MainSidecarHarness();
    await mainSidecar.start(dbPath, migrationsFolder);
    const created = await mainSidecar.call<Project>("projects.create", {
      name: "preppilot",
      path: path.join(tempDir, "preppilot"),
    });
    if (!created.ok) throw new Error("projects.create failed in setup");
    project = created.result;
  });

  afterAll(async () => {
    await mainSidecar.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("MCP server exposes record_answer in tools/list and the tool persists to the answers table", async () => {
    const mcpScript = path.resolve(process.cwd(), "sidecar", "dist", "mcp-server.js");
    expect(fs.existsSync(mcpScript)).toBe(true);

    const transport = new StdioClientTransport({
      command: "node",
      args: [
        mcpScript,
        "--db-path",
        dbPath,
        "--migrations-folder",
        migrationsFolder,
        "--project-id",
        project.id,
      ],
    });
    const client = new Client({ name: "builder-test", version: "0.0.1" });
    await client.connect(transport);

    const listResponse = await client.listTools();
    const recordTool = listResponse.tools.find((t: { name: string }) => t.name === "record_answer");
    expect(recordTool).toBeDefined();
    expect(recordTool?.inputSchema).toMatchObject({
      type: "object",
      required: expect.arrayContaining(["question_id", "answer"]) as string[],
    });

    const callResult = await client.callTool({
      name: "record_answer",
      arguments: {
        question_id: "Q1",
        answer: "A desktop app for absolute novices to build production web apps by chatting with Claude.",
        confidence: "confident",
        rationale: "Direct quote from the novice's first message.",
      },
    });
    expect(callResult.isError).toBeFalsy();
    const content = callResult.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toMatch(/Recorded answer/);

    await client.close();

    // Verify via the main sidecar that the row landed.
    const list = await mainSidecar.call<AnswerRow[]>("answers.list", {
      projectId: project.id,
    });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const row = list.result.find((r) => r.questionId === "Q1");
    expect(row).toBeDefined();
    if (!row) return;
    expect(row.projectId).toBe(project.id);
    expect(row.confidence).toBe("confident");
    expect(row.source).toBe("chat");
    expect(row.rationale).toBe("Direct quote from the novice's first message.");
    expect(row.answerText).toMatch(/desktop app/);
  });

  it("MCP server rejects an unknown tool name", async () => {
    const mcpScript = path.resolve(process.cwd(), "sidecar", "dist", "mcp-server.js");
    const transport = new StdioClientTransport({
      command: "node",
      args: [
        mcpScript,
        "--db-path",
        dbPath,
        "--migrations-folder",
        migrationsFolder,
        "--project-id",
        project.id,
      ],
    });
    const client = new Client({ name: "builder-test", version: "0.0.1" });
    await client.connect(transport);

    await expect(
      client.callTool({ name: "does_not_exist", arguments: {} }),
    ).rejects.toThrow(/unknown tool/i);

    await client.close();
  });
});
