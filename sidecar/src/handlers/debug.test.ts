import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initDb, getDb } from "../db.js";
import { create as createProject } from "./projects.js";
import { listEvents } from "./audit.js";
import { defects } from "../schema/defects.js";
import type { Detector, RawFinding } from "../debug/detectors/types.js";
import { scan, list } from "./debug.js";

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

describe("getDb sanity (handler-test smoke)", () => {
  it("opened the test DB at the expected path", () => {
    const db = getDb();
    // A trivial select against the defects table proves the migration ran.
    const rows = db.select().from(defects).all();
    expect(rows).toEqual([]);
  });
});
