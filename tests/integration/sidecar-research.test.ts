// End-to-end integration test for the sidecar's research.start handler.
// Spawns the built sidecar with BUILDER_RESEARCH_STUB_JSON set so the
// research driver runs against a deterministic stub transport (no real
// Claude calls). Asserts that findings stream as notifications, the
// proposal arrives before done, and cancellation is honoured.
//
// Covers Flow M AC2-AC4 + AC6 — the parts that don't require the UI.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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

type ResearchEvent =
  | { kind: "session"; id: string }
  | { kind: "assistant_delta"; text: string }
  | {
      kind: "finding";
      topic: string;
      body: string;
      axis: string | null;
      sources: string[];
    }
  | { kind: "proposal"; markdown: string; summaryOfChanges: string }
  | {
      kind: "done";
      cost_usd: number | null;
      input_tokens: number | null;
      output_tokens: number | null;
      cancellation_reason: "none" | "user" | "wall_clock" | "step_cap";
    }
  | { kind: "rate_limit"; message: string }
  | { kind: "error"; message: string };

interface Notification {
  notification: { stream: string; event: ResearchEvent };
}

class SidecarHarness {
  private child!: ChildProcessWithoutNullStreams;
  private buffer = "";
  private pending = new Map<string, (line: string) => void>();
  private nextId = 1;
  /** Notifications keyed by streamId, in arrival order. */
  notifications: Map<string, ResearchEvent[]> = new Map();

  async start(dbPath: string, extraEnv: Record<string, string> = {}): Promise<void> {
    const sidecarRoot = path.resolve(process.cwd(), "sidecar");
    const entry = path.join(sidecarRoot, "dist", "index.js");
    if (!fs.existsSync(entry)) {
      throw new Error(`sidecar build missing at ${entry}; run pnpm sidecar:build`);
    }
    const migrations = path.join(sidecarRoot, "migrations");
    this.child = spawn(
      "node",
      [entry, "--db-path", dbPath, "--migrations-folder", migrations],
      { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...extraEnv } },
    );
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
        const parsed = JSON.parse(line) as { id?: string; notification?: Notification["notification"] };
        if (typeof parsed.id === "string") {
          const resolver = this.pending.get(parsed.id);
          if (resolver) {
            this.pending.delete(parsed.id);
            resolver(line);
          }
          continue;
        }
        if (parsed.notification && typeof parsed.notification.stream === "string") {
          const list = this.notifications.get(parsed.notification.stream) ?? [];
          list.push(parsed.notification.event);
          this.notifications.set(parsed.notification.stream, list);
        }
      } catch {
        // malformed line; ignore
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
          reject(new Error(`sidecar timeout waiting for id=${id} method=${method}`));
        }
      }, 15000);
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

const REPO_ROOT = process.cwd();

interface ResearchStubConfig {
  findings?: Array<{
    topic: string;
    body: string;
    axis?: string | null;
    sources?: string[];
  }>;
  proposal?: { markdown: string; summaryOfChanges: string };
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  abortAfterFindings?: number;
}

interface PersistedFinding {
  id: string;
  projectId: string;
  scanId: string;
  recordedAt: number;
  topic: string;
  body: string;
  axis: string | null;
  sources: string;
}

async function startWithStub(stub: ResearchStubConfig): Promise<{
  harness: SidecarHarness;
  tempDir: string;
  projectPath: string;
  projectId: string;
}> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "builder-research-test-"));
  const dbPath = path.join(tempDir, "builder.db");
  // Make the project path live under tempDir so the project handler will
  // accept it. The path needs to exist on disk for the sidecar's create.
  const projectPath = path.join(tempDir, "demo-project");
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(projectPath, "spec.md"), "# placeholder spec\n", "utf8");

  const harness = new SidecarHarness();
  await harness.start(dbPath, { BUILDER_RESEARCH_STUB_JSON: JSON.stringify(stub) });

  const created = await harness.call<Project>("projects.create", {
    name: "research-demo",
    path: projectPath,
  });
  if (!created.ok) {
    throw new Error(`could not seed project: ${created.error.message}`);
  }
  return { harness, tempDir, projectPath, projectId: created.result.id };
}

describe("sidecar research.start (integration) — Flow M AC2/AC4/AC6", () => {
  let ctx: Awaited<ReturnType<typeof startWithStub>> | null = null;

  afterEach(async () => {
    if (ctx) {
      await ctx.harness.stop();
      fs.rmSync(ctx.tempDir, { recursive: true, force: true });
      ctx = null;
    }
  });

  it("streams findings and a final proposal in order, then a done event", async () => {
    ctx = await startWithStub({
      findings: [
        {
          topic: "competitive landscape",
          body: "Notion, Coda, and Airtable overlap on free-form databases.",
          axis: "competitive_landscape",
          sources: ["https://www.notion.so/pricing", "https://airtable.com/pricing"],
        },
        {
          topic: "data model",
          body: "tasks, projects, users — soft-delete recommended.",
          axis: "data_model",
          sources: [],
        },
      ],
      proposal: {
        markdown: "# Build Spec: Demo\n\n## 1. Problem\n…expanded…",
        summaryOfChanges: "- Added competitive landscape\n- Expanded §4 with soft-delete columns",
      },
      costUsd: 1.42,
      inputTokens: 12000,
      outputTokens: 3500,
    });

    const streamId = "test-stream-happy";
    const result = await ctx.harness.call<{ ok: true }>("research.start", {
      streamId,
      projectId: ctx.projectId,
      projectPath: ctx.projectPath,
      specMarkdown: "# placeholder spec\n",
      answersDigest: "Q1: build a task tracker.",
      filesDigest: "",
      builderRepoPath: REPO_ROOT,
    });
    expect(result.ok).toBe(true);

    const events = ctx.harness.notifications.get(streamId) ?? [];
    const findings = events.filter((e): e is Extract<ResearchEvent, { kind: "finding" }> => e.kind === "finding");
    const proposals = events.filter((e): e is Extract<ResearchEvent, { kind: "proposal" }> => e.kind === "proposal");
    const dones = events.filter((e): e is Extract<ResearchEvent, { kind: "done" }> => e.kind === "done");

    expect(findings.length).toBe(2);
    expect(findings[0]!.topic).toBe("competitive landscape");
    expect(proposals.length).toBe(1);
    expect(proposals[0]!.markdown).toContain("Build Spec: Demo");
    expect(dones.length).toBe(1);
    expect(dones[0]!.cancellation_reason).toBe("none");
    expect(dones[0]!.cost_usd).toBe(1.42);
    expect(dones[0]!.input_tokens).toBe(12000);
    expect(dones[0]!.output_tokens).toBe(3500);

    // Order check: every finding precedes the proposal which precedes done.
    const indexOfKind = (k: ResearchEvent["kind"]): number => events.findIndex((e) => e.kind === k);
    const lastIndexOfKind = (k: ResearchEvent["kind"]): number => {
      let last = -1;
      events.forEach((e, i) => {
        if (e.kind === k) last = i;
      });
      return last;
    };
    expect(lastIndexOfKind("finding")).toBeLessThan(indexOfKind("proposal"));
    expect(indexOfKind("proposal")).toBeLessThan(indexOfKind("done"));

    // Persisted in research_findings (audit trail).
    const persisted = await ctx.harness.call<PersistedFinding[]>(
      "researchFindings.listByScan",
      { scanId: streamId },
    );
    expect(persisted.ok).toBe(true);
    if (persisted.ok) {
      expect(persisted.result.length).toBe(2);
      const competitive = persisted.result.find((f) => f.topic === "competitive landscape");
      expect(competitive).toBeDefined();
      expect(competitive!.axis).toBe("competitive_landscape");
      expect(JSON.parse(competitive!.sources)).toEqual([
        "https://www.notion.so/pricing",
        "https://airtable.com/pricing",
      ]);
    }
  });

  it("handles a cancelled run mid-stream (no proposal, done.cancellation_reason='user')", async () => {
    ctx = await startWithStub({
      findings: [
        { topic: "first", body: "noted." },
        { topic: "second", body: "noted." },
        { topic: "third (never delivered)", body: "should not arrive" },
      ],
      // Stub aborts after 2 findings via abortAfterFindings; no proposal
      abortAfterFindings: 2,
    });

    const streamId = "test-stream-cancel";
    const result = await ctx.harness.call<{ ok: true }>("research.start", {
      streamId,
      projectId: ctx.projectId,
      projectPath: ctx.projectPath,
      specMarkdown: "# placeholder\n",
      answersDigest: "",
      filesDigest: "",
      builderRepoPath: REPO_ROOT,
    });
    expect(result.ok).toBe(true);

    const events = ctx.harness.notifications.get(streamId) ?? [];
    const findings = events.filter((e) => e.kind === "finding");
    const proposals = events.filter((e) => e.kind === "proposal");
    const dones = events.filter((e): e is Extract<ResearchEvent, { kind: "done" }> => e.kind === "done");

    expect(findings.length).toBe(2);
    expect(proposals.length).toBe(0);
    expect(dones.length).toBe(1);
    expect(dones[0]!.cancellation_reason).toBe("user");
  });

  it("rejects research.start with malformed params (Zod boundary check)", async () => {
    ctx = await startWithStub({
      findings: [],
      proposal: { markdown: "x".repeat(60), summaryOfChanges: "no changes really" },
    });

    const result = await ctx.harness.call<{ ok: true }>("research.start", {
      // missing required projectId, projectPath, specMarkdown
      streamId: "broken",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBeDefined();
    }
  });

  it("research.stop on an unknown streamId returns count=0", async () => {
    ctx = await startWithStub({});
    const result = await ctx.harness.call<{ cancelled: boolean; count: number }>(
      "research.stop",
      { streamId: "no-such-stream" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.count).toBe(0);
      expect(result.result.cancelled).toBe(false);
    }
  });
});
