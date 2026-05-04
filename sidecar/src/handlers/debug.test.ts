import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initDb, getDb } from "../db.js";
import { create as createProject } from "./projects.js";
import { listEvents } from "./audit.js";
import { defects } from "../schema/defects.js";
import type { Detector, RawFinding } from "../debug/detectors/types.js";
import { stubTransport } from "../debug/validator/index.js";
import { graph, scan, list } from "./debug.js";

let tmpDir: string;
let dbPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "debug-handler-"));
  dbPath = path.join(tmpDir, "test.db");
  // The unit test runs from the repo root; sidecar migrations live at
  // sidecar/migrations.
  const migrations = path.resolve(process.cwd(), "sidecar", "migrations");
  initDb({ dbPath, migrationsFolder: migrations });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const fakeDetector = (id: string, findings: RawFinding[]): Detector => ({
  id,
  run: async () => findings,
});

const sampleFinding = (overrides: Partial<RawFinding> = {}): RawFinding => ({
  class: "auth",
  ruleId: "test/rule",
  severity: 9,
  blastRadius: 2.5,
  confidence: 0.7,
  difficulty: 1.5,
  file: "supabase/migrations/0001.sql",
  lineStart: 1,
  lineEnd: 1,
  humanExplanation: "explanation",
  codeEvidence: "code",
  ...overrides,
});

async function newProject(): Promise<string> {
  const projectPath = path.join(tmpDir, "project");
  await fs.mkdir(projectPath, { recursive: true });
  const project = createProject({ name: "test-proj", path: projectPath });
  return project.id;
}

describe("debug.scan handler", () => {
  it("inserts a defects row per finding with the computed PRIORITY + band", async () => {
    const projectId = await newProject();
    const detector = fakeDetector("fake", [sampleFinding()]);

    const result = await scan({ projectId }, [detector]);

    expect(result.findingCount).toBe(1);
    expect(result.failures).toEqual([]);
    expect(result.scanId).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/i); // ULID

    const rows = list({ projectId });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.class).toBe("auth");
    expect(row.ruleId).toBe("test/rule");
    expect(row.band).toBe("critical");
    // Founder-mode score: (9 × 2.5 × 0.7 × 2.0) / 1.5 = 21
    expect(row.priority).toBeCloseTo(21, 1);
    expect(row.scanId).toBe(result.scanId);
    expect(row.status).toBe("open");
  });

  it("emits debug_scan_started + debug_scan_completed audit events", async () => {
    const projectId = await newProject();
    await scan({ projectId }, [fakeDetector("fake", [sampleFinding()])]);

    const events = listEvents({ limit: 50 });
    const debugEvents = events.filter((e) => e.action.startsWith("debug_scan"));
    expect(debugEvents.map((e) => e.action).sort()).toEqual([
      "debug_scan_completed",
      "debug_scan_started",
    ]);
    const completedPayload = JSON.parse(
      debugEvents.find((e) => e.action === "debug_scan_completed")!.payload
    );
    expect(completedPayload.findingCount).toBe(1);
    expect(completedPayload.durationMs).toBeGreaterThanOrEqual(0);
    expect(completedPayload.failures).toEqual([]);
  });

  it("isolates a broken detector — successful findings still persist", async () => {
    const projectId = await newProject();
    const ok = fakeDetector("ok", [sampleFinding({ ruleId: "ok/finding" })]);
    const broken: Detector = {
      id: "broken",
      run: async () => {
        throw new Error("oops");
      },
    };

    const result = await scan({ projectId }, [ok, broken]);

    expect(result.findingCount).toBe(1);
    expect(result.failures).toEqual([{ detectorId: "broken", message: "oops" }]);
    expect(list({ projectId })).toHaveLength(1);
  });

  it("returns 0 findings + zero rows when no detector fires", async () => {
    const projectId = await newProject();
    const result = await scan({ projectId }, [fakeDetector("empty", [])]);
    expect(result.findingCount).toBe(0);
    expect(list({ projectId })).toEqual([]);
  });

  it("rejects an unknown projectId", async () => {
    await expect(scan({ projectId: "does-not-exist" }, [])).rejects.toThrow(
      /project not found/i
    );
  });

  it("supports team mode via the userMode parameter", async () => {
    const projectId = await newProject();
    const result = await scan(
      { projectId, userMode: "team" },
      [fakeDetector("fake", [sampleFinding()])]
    );
    expect(result.findingCount).toBe(1);
    const row = list({ projectId })[0]!;
    // Team U=1.5: (9 × 2.5 × 0.7 × 1.5) / 1.5 = 15.75 → high band.
    expect(row.priority).toBeCloseTo(15.75, 1);
    expect(row.band).toBe("high");
  });

  it("groups findings under one scan id even from multiple detectors", async () => {
    const projectId = await newProject();
    const a = fakeDetector("a", [sampleFinding({ ruleId: "a/1" })]);
    const b = fakeDetector("b", [sampleFinding({ ruleId: "b/1" })]);

    const result = await scan({ projectId }, [a, b]);

    const rows = list({ projectId });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.scanId === result.scanId)).toBe(true);
  });

  it("debug.list filters to a single scan run when scanId is provided", async () => {
    const projectId = await newProject();
    const r1 = await scan(
      { projectId },
      [fakeDetector("a", [sampleFinding({ ruleId: "a/1" })])]
    );
    await scan(
      { projectId },
      [fakeDetector("b", [sampleFinding({ ruleId: "b/1" })])]
    );

    expect(list({ projectId })).toHaveLength(2);
    expect(list({ projectId, scanId: r1.scanId })).toHaveLength(1);
    expect(list({ projectId, scanId: r1.scanId })[0]!.ruleId).toBe("a/1");
  });
});

describe("debug.scan with validate=true", () => {
  it("does not invoke the validator when validate=false (default)", async () => {
    let calls = 0;
    const transport = {
      async validate() {
        calls++;
        return JSON.stringify({
          verdict: "real",
          confidence: 0.9,
          exploitPath: "x",
          fixStrategy: "y",
          fixTier: 1,
        });
      },
    };
    const projectId = await newProject();
    await scan(
      { projectId },
      [fakeDetector("fake", [sampleFinding()])],
      transport
    );
    expect(calls).toBe(0);
    const row = list({ projectId })[0]!;
    expect(row.validatorVerdict).toBeNull();
    expect(row.validatedAt).toBeNull();
  });

  it("calls the validator once per finding when validate=true", async () => {
    let calls = 0;
    const transport = {
      async validate() {
        calls++;
        return JSON.stringify({
          verdict: "real",
          confidence: 0.9,
          exploitPath: "exploit",
          fixStrategy: "fix",
          fixTier: 1,
        });
      },
    };
    const projectId = await newProject();
    await scan(
      { projectId, validate: true },
      [
        fakeDetector("a", [sampleFinding({ ruleId: "a/1" })]),
        fakeDetector("b", [sampleFinding({ ruleId: "b/1" })]),
      ],
      transport
    );
    expect(calls).toBe(2);
  });

  it("real verdict raises confidence and recomputes priority + band", async () => {
    const projectId = await newProject();
    const result = await scan(
      { projectId, validate: true },
      [fakeDetector("fake", [sampleFinding()])],
      stubTransport({
        "test/rule": JSON.stringify({
          verdict: "real",
          confidence: 0.95,
          exploitPath: "validator-confirmed exploit",
          fixStrategy: "validator-suggested fix",
          fixTier: 1,
        }),
      })
    );
    expect(result.findingCount).toBe(1);
    expect(result.validatorDismissed).toBe(0);

    const row = list({ projectId })[0]!;
    expect(row.validatorVerdict).toBe("real");
    expect(row.confidence).toBeCloseTo(0.95, 5);
    // Founder mode: (9 × 2.5 × 0.95 × 2.0) / 1.5 = 28.5 → critical (and
    // higher than the Layer-1-only score of 21).
    expect(row.priority).toBeCloseTo(28.5, 1);
    expect(row.band).toBe("critical");
    expect(row.fixTier).toBe(1);
    expect(row.status).toBe("open");
    expect(row.validatorNotes).toContain("validator-confirmed exploit");
    expect(row.validatedAt).not.toBeNull();
  });

  it("false_positive verdict marks the row dismissed and counts in validatorDismissed", async () => {
    const projectId = await newProject();
    const result = await scan(
      { projectId, validate: true },
      [fakeDetector("fake", [sampleFinding()])],
      stubTransport({
        "test/rule": JSON.stringify({
          verdict: "false_positive",
          confidence: 0.9,
          exploitPath: "",
          fixStrategy: "",
          fixTier: null,
        }),
      })
    );
    expect(result.validatorDismissed).toBe(1);

    const row = list({ projectId })[0]!;
    expect(row.validatorVerdict).toBe("false_positive");
    expect(row.status).toBe("dismissed");
  });

  it("uncertain verdict leaves confidence unchanged but records the verdict", async () => {
    const projectId = await newProject();
    await scan(
      { projectId, validate: true },
      [fakeDetector("fake", [sampleFinding()])],
      stubTransport({
        "test/rule": JSON.stringify({
          verdict: "uncertain",
          confidence: 0.5,
          exploitPath: "",
          fixStrategy: "",
          fixTier: null,
        }),
      })
    );
    const row = list({ projectId })[0]!;
    expect(row.validatorVerdict).toBe("uncertain");
    expect(row.confidence).toBeCloseTo(0.7, 5); // unchanged from Layer-1
    expect(row.status).toBe("open");
  });

  it("audit log captures validatorDismissed in the completed payload", async () => {
    const projectId = await newProject();
    await scan(
      { projectId, validate: true },
      [
        fakeDetector("a", [sampleFinding({ ruleId: "a/1" })]),
        fakeDetector("b", [sampleFinding({ ruleId: "b/1" })]),
      ],
      stubTransport({
        "a/1": JSON.stringify({
          verdict: "false_positive",
          confidence: 0.9,
          exploitPath: "",
          fixStrategy: "",
          fixTier: null,
        }),
      })
    );
    const events = listEvents({ limit: 50 });
    const completed = events.find((e) => e.action === "debug_scan_completed")!;
    const payload = JSON.parse(completed.payload);
    expect(payload.validatorDismissed).toBe(1);
  });
});

describe("debug.graph handler", () => {
  it("returns an empty graph for a freshly-created project with no files", async () => {
    const projectId = await newProject();
    const g = await graph({ projectId });
    expect(g.routes).toEqual([]);
    expect(g.schema).toEqual([]);
    expect(g.auth).toEqual([]);
    expect(g.warnings).toEqual([]);
  });

  it("rejects an unknown projectId", async () => {
    await expect(graph({ projectId: "does-not-exist" })).rejects.toThrow(
      /project not found/i
    );
  });

  it("composes routes + schema + auth when files exist on disk", async () => {
    const projectPath = path.join(tmpDir, "graph-project");
    await fs.mkdir(projectPath, { recursive: true });
    await fs.mkdir(path.join(projectPath, "app", "api", "users"), { recursive: true });
    await fs.writeFile(
      path.join(projectPath, "app", "page.tsx"),
      `export default function Home() { return null; }`
    );
    await fs.writeFile(
      path.join(projectPath, "app", "api", "users", "route.ts"),
      `import { getServerSession } from "next-auth";
       export async function GET() {
         await getServerSession();
         return new Response();
       }`
    );
    await fs.mkdir(path.join(projectPath, "supabase", "migrations"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(projectPath, "supabase", "migrations", "0001.sql"),
      `CREATE TABLE users (id uuid PRIMARY KEY, email text NOT NULL);
       ALTER TABLE users ENABLE ROW LEVEL SECURITY;`
    );
    const project = createProject({ name: "graph-test", path: projectPath });

    const g = await graph({ projectId: project.id });

    expect(g.routes.map((r) => r.pathPattern).sort()).toEqual([
      "/",
      "/api/users",
    ]);
    expect(g.schema).toHaveLength(1);
    expect(g.schema[0]!.rlsEnabled).toBe(true);
    const apiAuth = g.auth.find((a) => a.route.pathPattern === "/api/users");
    expect(apiAuth?.authentication?.identifier).toBe("getServerSession");
  });
});

describe("getDb sanity (handler-test smoke)", () => {
  it("opened the test DB at the expected path", () => {
    const db = getDb();
    // A trivial select against the defects table proves the migration ran.
    const rows = db.select().from(defects).all();
    expect(rows).toEqual([]);
  });
});
