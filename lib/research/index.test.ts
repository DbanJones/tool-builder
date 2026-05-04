import { describe, expect, it } from "vitest";

import { buildAnswersDigest, buildFilesDigest } from "./index";

describe("buildAnswersDigest", () => {
  it("returns empty string when no answers are recorded", () => {
    expect(buildAnswersDigest([])).toBe("");
  });

  it("formats one line per answer with question id and confidence", () => {
    const result = buildAnswersDigest([
      { questionId: "Q1", answerText: "A task tracker.", confidence: "confident" },
      { questionId: "Q33", answerText: "  An .xlsx file. ", confidence: "tentative" },
    ]);
    expect(result).toBe(
      "Q1 (confident): A task tracker.\nQ33 (tentative): An .xlsx file.",
    );
  });

  it("collapses whitespace and trims so multi-line answers stay on one line", () => {
    const result = buildAnswersDigest([
      { questionId: "Q5", answerText: "line one\n    line two\t\ttabbed", confidence: "confident" },
    ]);
    expect(result).toBe("Q5 (confident): line one line two tabbed");
  });
});

describe("buildFilesDigest", () => {
  it("returns empty string when no files have summaries", () => {
    expect(buildFilesDigest([])).toBe("");
    expect(buildFilesDigest([{ name: "x.pdf", summary: null }])).toBe("");
    expect(buildFilesDigest([{ name: "x.pdf", summary: undefined }])).toBe("");
    expect(buildFilesDigest([{ name: "x.pdf", summary: "   " }])).toBe("");
  });

  it("renders one block per approved file with markdown heading", () => {
    const result = buildFilesDigest([
      { name: "prd.pdf", summary: "Product requirements." },
      { name: "schema.sql", summary: "Two tables: users, tasks." },
    ]);
    expect(result).toBe(
      "## prd.pdf\nProduct requirements.\n\n## schema.sql\nTwo tables: users, tasks.",
    );
  });

  it("filters out files without a meaningful summary", () => {
    const result = buildFilesDigest([
      { name: "good.pdf", summary: "real summary" },
      { name: "skip.pdf", summary: null },
      { name: "skip2.pdf", summary: "" },
    ]);
    expect(result).toBe("## good.pdf\nreal summary");
  });
});
