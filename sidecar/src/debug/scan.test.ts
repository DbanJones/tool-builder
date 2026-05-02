import { describe, expect, it } from "vitest";

import type { Detector, RawFinding, ScanContext } from "./detectors/types.js";
import { runScan, score } from "./scan.js";

const CTX: ScanContext = {
  projectPath: "/tmp/proj",
  scanId: "scan-1",
  startedAt: 0,
};

function fakeDetector(id: string, findings: RawFinding[]): Detector {
  return { id, run: async () => findings };
}

function brokenDetector(id: string, message: string): Detector {
  return {
    id,
    run: async () => {
      throw new Error(message);
    },
  };
}

const sampleFinding = (overrides: Partial<RawFinding> = {}): RawFinding => ({
  class: "auth",
  ruleId: "test/rule",
  severity: 9,
  blastRadius: 2.5,
  confidence: 0.7,
  difficulty: 1.5,
  file: "app/page.tsx",
  lineStart: 1,
  lineEnd: 1,
  humanExplanation: "explanation",
  codeEvidence: "code",
  ...overrides,
});

describe("score", () => {
  it("matches the source spec's worked example for the Lovable RLS bug", () => {
    const result = score(sampleFinding(), "founder");
    // (9 × 2.5 × 0.7 × 2.0) / 1.5 = 21
    expect(result.score).toBeCloseTo(21, 1);
    expect(result.band).toBe("critical");
    expect(result.userMultiplier).toBe(2.0);
  });

  it("falls back to class default severity if the detector emitted 0", () => {
    const result = score(sampleFinding({ severity: 0 }), "founder");
    // auth class default is 9 → same score as above.
    expect(result.score).toBeCloseTo(21, 1);
  });

  it("uses team-mode multipliers when requested", () => {
    const result = score(sampleFinding(), "team");
    // (9 × 2.5 × 0.7 × 1.5) / 1.5 = 15.75
    expect(result.userMultiplier).toBe(1.5);
    expect(result.band).toBe("high");
  });
});

describe("runScan", () => {
  it("collects findings from every detector and scores them", async () => {
    const a = fakeDetector("a", [sampleFinding({ ruleId: "a/1" })]);
    const b = fakeDetector("b", [
      sampleFinding({ ruleId: "b/1" }),
      sampleFinding({ ruleId: "b/2", class: "security", severity: 8 }),
    ]);
    const outcome = await runScan([a, b], CTX, "founder");
    expect(outcome.findings).toHaveLength(3);
    expect(outcome.failures).toEqual([]);
    expect(outcome.findings.map((f) => f.raw.ruleId).sort()).toEqual([
      "a/1",
      "b/1",
      "b/2",
    ]);
  });

  it("isolates a broken detector — other detectors still produce findings", async () => {
    const ok = fakeDetector("ok", [sampleFinding()]);
    const broken = brokenDetector("broken", "kaboom");
    const outcome = await runScan([ok, broken], CTX, "founder");
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.failures).toEqual([
      { detectorId: "broken", message: "kaboom" },
    ]);
  });

  it("returns empty findings + empty failures for an empty detector list", async () => {
    const outcome = await runScan([], CTX, "founder");
    expect(outcome.findings).toEqual([]);
    expect(outcome.failures).toEqual([]);
  });

  it("scores each finding using the requested user mode", async () => {
    const a = fakeDetector("a", [sampleFinding()]);
    const founder = await runScan([a], CTX, "founder");
    const team = await runScan([a], CTX, "team");
    expect(founder.findings[0]!.userMultiplier).toBe(2.0);
    expect(team.findings[0]!.userMultiplier).toBe(1.5);
    expect(founder.findings[0]!.score).toBeGreaterThan(team.findings[0]!.score);
  });

  it("preserves the raw finding so the handler can read file/line later", async () => {
    const a = fakeDetector("a", [
      sampleFinding({ file: "supabase/migrations/0001.sql", lineStart: 7, lineEnd: 7 }),
    ]);
    const outcome = await runScan([a], CTX, "founder");
    expect(outcome.findings[0]!.raw.file).toBe("supabase/migrations/0001.sql");
    expect(outcome.findings[0]!.raw.lineStart).toBe(7);
  });

  it("handles a detector that throws a non-Error value", async () => {
    const weird: Detector = {
      id: "weird",
      run: async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw "not-an-error";
      },
    };
    const outcome = await runScan([weird], CTX, "founder");
    expect(outcome.failures).toEqual([
      { detectorId: "weird", message: "not-an-error" },
    ]);
  });
});
