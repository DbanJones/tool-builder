import { describe, expect, it } from "vitest";

import { priority } from "./priority.js";

describe("priority", () => {
  it("matches the source spec's worked example for the Lovable RLS bug (founder mode)", () => {
    // debug_repair_engine_spec.md §C.4: missing RLS on a Supabase table
    // containing user PII. S=9, B=2.5, C=0.85, U=2.0 (founder, security/auth),
    // D=1.5; PRIORITY = (9 × 2.5 × 0.85 × 2.0) / 1.5 = 25.5 → critical band.
    const r = priority({
      severity: 9,
      blastRadius: 2.5,
      confidence: 0.85,
      difficulty: 1.5,
      defectClass: "auth",
      userMode: "founder",
    });
    expect(r.score).toBeCloseTo(25.5, 1);
    expect(r.band).toBe("critical");
    expect(r.userMultiplier).toBe(2.0);
  });

  it("matches the source spec's worked example for a maintainability nit (founder mode)", () => {
    // Same project, naming inconsistency. S=1, B=1, C=0.95, U=0.5, D=1.0.
    // PRIORITY = (1 × 1 × 0.95 × 0.5) / 1 = 0.475 → info band.
    const r = priority({
      severity: 1,
      blastRadius: 1,
      confidence: 0.95,
      difficulty: 1,
      defectClass: "maintain",
      userMode: "founder",
    });
    expect(r.score).toBeCloseTo(0.475, 3);
    expect(r.band).toBe("info");
  });

  it("downranks perf in founder mode (U = 0.7)", () => {
    const r = priority({
      severity: 6,
      blastRadius: 2,
      confidence: 0.9,
      difficulty: 2,
      defectClass: "perf",
      userMode: "founder",
    });
    expect(r.userMultiplier).toBe(0.7);
    expect(r.score).toBeCloseTo((6 * 2 * 0.9 * 0.7) / 2, 5);
  });

  it("treats security/auth equally in founder mode (both U = 2.0)", () => {
    const inputs = {
      severity: 8,
      blastRadius: 2,
      confidence: 0.9,
      difficulty: 1.5,
      userMode: "founder" as const,
    };
    expect(priority({ ...inputs, defectClass: "security" }).score).toBeCloseTo(
      priority({ ...inputs, defectClass: "auth" }).score,
      5
    );
  });

  it("flattens U in team mode — perf still scores meaningfully", () => {
    const inputs = {
      severity: 6,
      blastRadius: 2,
      confidence: 0.9,
      difficulty: 2,
      defectClass: "perf" as const,
    };
    const founder = priority({ ...inputs, userMode: "founder" });
    const team = priority({ ...inputs, userMode: "team" });
    expect(team.score).toBeGreaterThan(founder.score);
    expect(team.userMultiplier).toBe(1.2);
  });

  it("higher difficulty pushes score down (easy wins surface first)", () => {
    const easy = priority({
      severity: 9,
      blastRadius: 2.5,
      confidence: 0.85,
      difficulty: 1, // codemod
      defectClass: "auth",
      userMode: "founder",
    });
    const hard = priority({
      severity: 9,
      blastRadius: 2.5,
      confidence: 0.85,
      difficulty: 3, // architectural
      defectClass: "auth",
      userMode: "founder",
    });
    expect(easy.score).toBeGreaterThan(hard.score);
    expect(easy.score / hard.score).toBeCloseTo(3, 5);
  });

  it("clamps severity above 10 and below 1", () => {
    const high = priority({
      severity: 99,
      blastRadius: 2,
      confidence: 1,
      difficulty: 1,
      defectClass: "security",
      userMode: "founder",
    });
    const low = priority({
      severity: -5,
      blastRadius: 2,
      confidence: 1,
      difficulty: 1,
      defectClass: "security",
      userMode: "founder",
    });
    expect(high.score).toBeCloseTo((10 * 2 * 1 * 2.0) / 1, 5);
    expect(low.score).toBeCloseTo((1 * 2 * 1 * 2.0) / 1, 5);
  });

  it("clamps blast radius and difficulty to their documented ranges", () => {
    const r = priority({
      severity: 5,
      blastRadius: 99,
      confidence: 1,
      difficulty: 0.1,
      defectClass: "security",
      userMode: "founder",
    });
    // Expect b clamped to 3, d clamped to 1 → (5 × 3 × 1 × 2.0) / 1 = 30.
    expect(r.score).toBeCloseTo(30, 5);
  });

  it("treats NaN inputs as the lower bound rather than throwing", () => {
    const r = priority({
      severity: Number.NaN,
      blastRadius: Number.NaN,
      confidence: Number.NaN,
      difficulty: Number.NaN,
      defectClass: "security",
      userMode: "founder",
    });
    // s=1, b=1, c=0, d=1, u=2.0 → 0 → info.
    expect(r.score).toBe(0);
    expect(r.band).toBe("info");
  });

  it("a confidence of 0 zeroes the score (low-confidence findings get downranked, never silently dropped)", () => {
    const r = priority({
      severity: 10,
      blastRadius: 3,
      confidence: 0,
      difficulty: 1,
      defectClass: "auth",
      userMode: "founder",
    });
    expect(r.score).toBe(0);
  });

  it("respects the source spec's 50× ratio between critical and info findings", () => {
    const critical = priority({
      severity: 9,
      blastRadius: 2.5,
      confidence: 0.85,
      difficulty: 1.5,
      defectClass: "auth",
      userMode: "founder",
    }).score;
    const info = priority({
      severity: 1,
      blastRadius: 1,
      confidence: 0.95,
      difficulty: 1,
      defectClass: "maintain",
      userMode: "founder",
    }).score;
    expect(critical / info).toBeGreaterThan(50);
  });
});
