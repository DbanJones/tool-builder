import { describe, it, expect } from "vitest";

import {
  DECISION_TABLE,
  FAST_PATH_QUESTIONS,
  getQuestionById,
  QUESTION_LIBRARY,
  RULE_ID_PATTERN,
} from "./library";

describe("question library", () => {
  it("contains 35 fast-path questions", () => {
    expect(FAST_PATH_QUESTIONS).toHaveLength(35);
  });

  it("the 35 fast-path question ids are exactly Q1..Q35", () => {
    const ids = FAST_PATH_QUESTIONS.map((q) => q.id).sort();
    const expected = Array.from({ length: 35 }, (_, i) => `Q${i + 1}`).sort();
    expect(ids).toEqual(expected);
  });

  it("question ids in the library are unique", () => {
    const ids = QUESTION_LIBRARY.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every question has a non-empty topic and prompt", () => {
    for (const q of QUESTION_LIBRARY) {
      expect(q.topic.trim().length).toBeGreaterThan(0);
      expect(q.prompt.trim().length).toBeGreaterThan(0);
    }
  });

  it("every question lists at least one influenced spec section", () => {
    for (const q of QUESTION_LIBRARY) {
      expect(q.influencesSpecSections.length).toBeGreaterThan(0);
    }
  });

  it("getQuestionById returns the question for a known id", () => {
    const q = getQuestionById("Q1");
    expect(q).toBeDefined();
    expect(q?.topic).toBe("elevator pitch");
  });
});

describe("decision table", () => {
  it("every entry references a question that exists in the library", () => {
    for (const entry of DECISION_TABLE) {
      const q = getQuestionById(entry.questionId);
      expect(q, `entry questionId ${entry.questionId} not in library`).toBeDefined();
    }
  });

  it("every appliesRules id matches the canonical rule id pattern", () => {
    for (const entry of DECISION_TABLE) {
      for (const ruleId of entry.appliesRules) {
        expect(
          RULE_ID_PATTERN.test(ruleId),
          `rule id ${ruleId} on entry for ${entry.questionId} fails the pattern`,
        ).toBe(true);
      }
    }
  });

  it("every appliesRules array is non-empty", () => {
    for (const entry of DECISION_TABLE) {
      expect(entry.appliesRules.length).toBeGreaterThan(0);
    }
  });
});
