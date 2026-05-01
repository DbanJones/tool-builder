import { describe, it, expect } from "vitest";

import { rebuildSpec, type RebuildAnswer } from "./rebuild-spec";

const minimal: readonly RebuildAnswer[] = [
  {
    questionId: "Q1",
    answerText: "A platform that helps small charities manage their volunteers.",
    confidence: "confident",
    source: "chat",
  },
];

const partial: readonly RebuildAnswer[] = [
  {
    questionId: "Q1",
    answerText: "A study-prep app for medical residents preparing for board exams.",
    confidence: "confident",
    source: "chat",
  },
  {
    questionId: "Q9",
    answerText: "yes",
    confidence: "confident",
    source: "chat",
    rationale: "Residents are individuals, names + emails involved.",
  },
  {
    questionId: "Q14",
    answerText: "yes",
    confidence: "confident",
    source: "chat",
  },
  {
    questionId: "Q11",
    answerText: "under-1k for v1 beta",
    confidence: "tentative",
    source: "chat",
  },
];

const full: readonly RebuildAnswer[] = [
  { questionId: "Q1", answerText: "A study-prep app for medical residents.", confidence: "confident", source: "chat" },
  { questionId: "Q2", answerText: "yes, email + magic link", confidence: "confident", source: "chat" },
  { questionId: "Q3", answerText: "yes, monthly subscription", confidence: "confident", source: "chat" },
  { questionId: "Q4", answerText: "no", confidence: "confident", source: "chat" },
  { questionId: "Q5", answerText: "yes, central feature: study-question generation and grading", confidence: "confident", source: "chat" },
  { questionId: "Q6", answerText: "yes, nightly spaced-repetition recompute jobs", confidence: "confident", source: "chat" },
  { questionId: "Q7", answerText: "no inbound webhooks", confidence: "confident", source: "chat" },
  { questionId: "Q8", answerText: "yes, users upload PDFs of past exam questions", confidence: "confident", source: "chat" },
  { questionId: "Q9", answerText: "yes", confidence: "confident", source: "chat" },
  { questionId: "Q10", answerText: "login required for all but the marketing pages", confidence: "confident", source: "chat" },
  { questionId: "Q11", answerText: "under 5k in year 1", confidence: "tentative", source: "chat" },
  { questionId: "Q12", answerText: "calm and minimal, light + dark", confidence: "confident", source: "chat" },
  { questionId: "Q13", answerText: "web + mobile (responsive web first)", confidence: "confident", source: "chat" },
  { questionId: "Q14", answerText: "yes, WCAG 2.2 AA", confidence: "confident", source: "chat" },
  {
    questionId: "Q15",
    answerText: "Sign up and choose a board\nUpload past-exam PDFs\nDaily question stack with timer\nReview wrong answers with explanations\nProgress dashboard",
    confidence: "confident",
    source: "chat",
  },
  { questionId: "Q16", answerText: "Per flow: signup completes within 2 steps; upload PDF parses without manual cleanup; daily question stack always has 20 items; reviews show explanation immediately; dashboard reflects last session within 1 minute.", confidence: "confident", source: "chat" },
  { questionId: "Q17", answerText: "Stripe, Anthropic, Postmark, Sentry", confidence: "confident", source: "chat" },
  { questionId: "Q18", answerText: "just-users", confidence: "confident", source: "chat" },
  { questionId: "Q19", answerText: "free trial + single paid tier", confidence: "confident", source: "chat" },
  { questionId: "Q20", answerText: "no hard constraints; kit defaults are fine", confidence: "confident", source: "chat" },
  { questionId: "Q21", answerText: "kit defaults", confidence: "default-applied", source: "default" },
  { questionId: "Q22", answerText: "smoke + critical paths", confidence: "confident", source: "chat" },
  { questionId: "Q23", answerText: "Sentry opt-in only after first build", confidence: "confident", source: "chat" },
  { questionId: "Q24", answerText: "5 GBP per build day", confidence: "confident", source: "chat" },
  { questionId: "Q25", answerText: "yes", confidence: "confident", source: "chat" },
  { questionId: "Q26", answerText: "no", confidence: "confident", source: "chat" },
  { questionId: "Q27", answerText: "en-GB", confidence: "default-applied", source: "default" },
  { questionId: "Q28", answerText: "delete account, delete uploaded PDFs", confidence: "confident", source: "chat" },
  { questionId: "Q29", answerText: "users, board exams, exam questions, study sessions", confidence: "confident", source: "chat" },
  { questionId: "Q30", answerText: "user: email, name, board\nexam: title, board, year\nquestion: prompt, options, correct_index, explanation\nsession: started_at, score, mistakes_count", confidence: "confident", source: "chat" },
  { questionId: "Q31", answerText: "no team accounts in v1, no proctoring/exam mode, no flashcards", confidence: "confident", source: "chat" },
  { questionId: "Q32", answerText: "A new user can sign up, choose their board, upload one PDF that parses cleanly into at least 5 questions, do a 20-question session, and see their score on a dashboard.", confidence: "confident", source: "chat" },
  { questionId: "Q33", answerText: "A responsive web app the resident opens in a browser; the home screen shows today's question stack and a Start button.", confidence: "confident", source: "chat" },
  { questionId: "Q34", answerText: "Anki: similar spaced-repetition feel, different content (board exam questions, not user-authored cards)\nUWorld: similar question-bank UX, different pricing (subscription vs one-off)", confidence: "confident", source: "chat" },
  { questionId: "Q35", answerText: "must run in a browser without install\nmust grade answers immediately with explanations\nmust persist progress across devices", confidence: "confident", source: "chat" },
];

describe("rebuildSpec", () => {
  it("produces a deterministic spec for the minimal fixture (snapshot)", () => {
    const md = rebuildSpec(minimal);
    expect(md).toMatchSnapshot();
  });

  it("produces a deterministic spec for the partial fixture (snapshot)", () => {
    const md = rebuildSpec(partial);
    expect(md).toMatchSnapshot();
  });

  it("produces a deterministic spec for the full fixture (snapshot)", () => {
    const md = rebuildSpec(full);
    expect(md).toMatchSnapshot();
  });

  it("the partial fixture activates the PII (O18 + B3) and accessibility (F12-F18) decision-table rules", () => {
    const md = rebuildSpec(partial);
    expect(md).toContain("**O18** activated by Q9");
    expect(md).toContain("**B3** activated by Q9");
    expect(md).toContain("**F12** activated by Q14");
    expect(md).toContain("**F18** activated by Q14");
  });

  it("the minimal fixture activates no decision-table rules", () => {
    const md = rebuildSpec(minimal);
    expect(md).toContain("_(no rules activated yet)_");
  });

  it("interview progress section shows exact answered/remaining counts", () => {
    expect(rebuildSpec(minimal)).toContain("Fast-path questions answered: **1 / 35**");
    expect(rebuildSpec(partial)).toContain("Fast-path questions answered: **4 / 35**");
    expect(rebuildSpec(full)).toContain("Fast-path questions answered: **35 / 35**");
    expect(rebuildSpec(full)).toContain("All fast-path questions answered.");
  });

  it("output is byte-for-byte stable across runs (no timestamps in body)", () => {
    const a = rebuildSpec(partial);
    const b = rebuildSpec(partial);
    expect(a).toBe(b);
  });

  it("throws on an unknown questionId", () => {
    expect(() =>
      rebuildSpec([
        // @ts-expect-error -- intentional bad id for the runtime check
        { questionId: "Q99", answerText: "nope" },
      ]),
    ).toThrow(/unknown questionId/);
  });
});
