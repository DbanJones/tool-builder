import { describe, it, expect } from "vitest";

import { FAST_PATH_QUESTIONS } from "./library";
import { checkReadiness } from "./readiness";
import type { RebuildAnswer } from "./rebuild-spec";

const allFastPathAnswered: readonly RebuildAnswer[] = FAST_PATH_QUESTIONS.map((q) => ({
  questionId: q.id,
  answerText: `placeholder answer for ${q.id}`,
  confidence: "confident" as const,
  source: "chat" as const,
}));

describe("checkReadiness", () => {
  it("returns not ready with all 35 missing when no answers are provided", () => {
    const r = checkReadiness([]);
    expect(r.ready).toBe(false);
    expect(r.fastPathAnswered).toBe(0);
    expect(r.fastPathTotal).toBe(35);
    expect(r.missingFastPath).toHaveLength(35);
    expect(r.reason).toMatch(/35 fast-path questions/);
  });

  it("returns not ready with N missing for a partial answer set", () => {
    const partial = allFastPathAnswered.slice(0, 5);
    const r = checkReadiness(partial);
    expect(r.ready).toBe(false);
    expect(r.fastPathAnswered).toBe(5);
    expect(r.fastPathTotal).toBe(35);
    expect(r.missingFastPath).toHaveLength(30);
    expect(r.reason).toMatch(/30 fast-path questions/);
  });

  it("uses singular 'question' when exactly one is missing", () => {
    const allButOne = allFastPathAnswered.slice(0, 34);
    const r = checkReadiness(allButOne);
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/1 fast-path question still to answer/);
  });

  it("returns not ready when all 35 answered but echo-back not confirmed", () => {
    const r = checkReadiness(allFastPathAnswered);
    expect(r.ready).toBe(false);
    expect(r.fastPathAnswered).toBe(35);
    expect(r.missingFastPath).toEqual([]);
    expect(r.echoBackConfirmed).toBe(false);
    expect(r.reason).toMatch(/Confirm the echo-back/);
  });

  it("returns ready when all 35 answered AND echo-back confirmed", () => {
    const r = checkReadiness(allFastPathAnswered, { echoBackConfirmed: true });
    expect(r.ready).toBe(true);
    expect(r.fastPathAnswered).toBe(35);
    expect(r.echoBackConfirmed).toBe(true);
    expect(r.reason).toBe("Ready to build.");
  });

  it("echo-back confirmation alone is not enough without all answers", () => {
    const partial = allFastPathAnswered.slice(0, 10);
    const r = checkReadiness(partial, { echoBackConfirmed: true });
    expect(r.ready).toBe(false);
    expect(r.fastPathAnswered).toBe(10);
    expect(r.echoBackConfirmed).toBe(true);
    expect(r.reason).toMatch(/25 fast-path questions/);
  });

  it("missingFastPath lists ids in library order, not answer-input order", () => {
    const r = checkReadiness([]);
    expect(r.missingFastPath[0]).toBe("Q1");
    expect(r.missingFastPath[34]).toBe("Q35");
  });

  it("ignores duplicate answers for the same question (latest still counts)", () => {
    const dup: readonly RebuildAnswer[] = [
      { questionId: "Q1", answerText: "first", confidence: "confident", source: "chat" },
      { questionId: "Q1", answerText: "second", confidence: "confident", source: "chat" },
    ];
    const r = checkReadiness(dup);
    expect(r.fastPathAnswered).toBe(1);
  });
});
