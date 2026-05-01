// Rebuild a `spec.md` from a set of recorded answers + the kit's question
// library and decision table. Pure function: same inputs always produce the
// same output, byte-for-byte (snapshot-friendly).
//
// IMPORTANT (per drift D-005, extended at B3): the section structure and
// phrasing here mirrors the Builder's own spec.md as a stand-in for the
// authoritative kit spec template. When the real kit is sourced, replace
// the section emitters; the function shape and snapshot harness should
// keep working.

import {
  DECISION_TABLE,
  FAST_PATH_QUESTIONS,
  getQuestionById,
  type DecisionTableEntry,
  type Question,
  type QuestionId,
} from "./library";

export interface RebuildAnswer {
  questionId: QuestionId;
  answerText: string;
  confidence?: "confident" | "tentative" | "default-applied";
  source?: "chat" | "file" | "default";
  rationale?: string | null;
}

const SECTION_DIVIDER = "\n\n";

function findAnswer(
  answers: readonly RebuildAnswer[],
  id: QuestionId,
): RebuildAnswer | undefined {
  return answers.find((a) => a.questionId === id);
}

function answerOrPlaceholder(
  answers: readonly RebuildAnswer[],
  id: QuestionId,
  placeholder = "_(not yet answered)_",
): string {
  return findAnswer(answers, id)?.answerText.trim() ?? placeholder;
}

function renderProblemSection(answers: readonly RebuildAnswer[]): string {
  const pitch = answerOrPlaceholder(answers, "Q1");
  const scale = answerOrPlaceholder(answers, "Q11");
  return [
    "## 1. Problem and users",
    `- **Pitch**: ${pitch}`,
    `- **Expected scale (year 1)**: ${scale}`,
  ].join("\n");
}

function renderScopeSection(answers: readonly RebuildAnswer[]): string {
  const flows = findAnswer(answers, "Q15");
  const lines = ["## 2. Scope", "", "**Top user flows (in priority order):**"];
  if (flows) {
    const items = flows.answerText
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (items.length === 0) {
      lines.push("- _(no flows captured)_");
    } else {
      for (const item of items) {
        lines.push(`- ${item.replace(/^[-*]\s*/, "")}`);
      }
    }
  } else {
    lines.push("- _(not yet answered)_");
  }

  const references = findAnswer(answers, "Q34");
  lines.push("", "**Looks and feels like (reference anchors):**");
  if (references) {
    const items = references.answerText
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (items.length === 0) {
      lines.push("- _(no reference anchors captured)_");
    } else {
      for (const item of items) {
        lines.push(`- ${item.replace(/^[-*]\s*/, "")}`);
      }
    }
  } else {
    lines.push("- _(not yet answered)_");
  }

  const outOfScope = findAnswer(answers, "Q31");
  lines.push("", "**Explicitly out of scope for v1:**");
  if (outOfScope) {
    const items = outOfScope.answerText
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (items.length === 0) {
      lines.push("- _(no out-of-scope items captured)_");
    } else {
      for (const item of items) {
        lines.push(`- ${item.replace(/^[-*]\s*/, "")}`);
      }
    }
  } else {
    lines.push("- _(not yet answered)_");
  }

  return lines.join("\n");
}

function renderFlowsSection(answers: readonly RebuildAnswer[]): string {
  const lines = [
    "## 3. Core flows + definition of done",
    "",
    "**Deliverable artifact (what the end user opens):**",
    "",
    answerOrPlaceholder(answers, "Q33", "_(not yet captured — the build will not have a concrete output target)_"),
    "",
    "**Non-negotiables (must not be missing):**",
  ];

  const nonNegotiables = findAnswer(answers, "Q35");
  if (nonNegotiables) {
    const items = nonNegotiables.answerText
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (items.length === 0) {
      lines.push("", "- _(no non-negotiables captured)_");
    } else {
      lines.push("");
      for (const item of items) {
        lines.push(`- ${item.replace(/^[-*]\s*/, "")}`);
      }
    }
  } else {
    lines.push("", "- _(not yet answered)_");
  }

  lines.push(
    "",
    "**Top flow's acceptance criteria:**",
    "",
    answerOrPlaceholder(answers, "Q16", "_(no acceptance criteria captured yet)_"),
    "",
    "**Definition of done (v1):**",
    "",
    answerOrPlaceholder(answers, "Q32", "_(not yet captured)_"),
  );

  return lines.join("\n");
}

function renderDataModelSection(answers: readonly RebuildAnswer[]): string {
  const entities = findAnswer(answers, "Q29");
  const fields = findAnswer(answers, "Q30");
  const lines = ["## 4. Data model", ""];

  lines.push("**Entities the app tracks:**");
  if (entities) {
    const items = entities.answerText
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (items.length === 0) {
      lines.push("- _(no entities captured)_");
    } else {
      for (const item of items) {
        lines.push(`- ${item.replace(/^[-*]\s*/, "")}`);
      }
    }
  } else {
    lines.push("- _(not yet answered)_");
  }

  lines.push("", "**Key fields per entity:**", "");
  if (fields) {
    // Preserve newlines so each entity-field line stands on its own.
    const block = fields.answerText
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => `- ${s.replace(/^[-*]\s*/, "")}`)
      .join("\n");
    lines.push(block.length > 0 ? block : "- _(no fields captured)_");
  } else {
    lines.push("- _(not yet answered)_");
  }

  return lines.join("\n");
}

function renderIntegrationsSection(answers: readonly RebuildAnswer[]): string {
  const lines = ["## 5. Integrations"];
  const integrations = findAnswer(answers, "Q17");
  if (!integrations) {
    lines.push("- _(not yet answered)_");
    return lines.join("\n");
  }
  const items = integrations.answerText
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (items.length === 0) {
    lines.push("- _(no integrations listed)_");
  } else {
    for (const item of items) {
      lines.push(`- ${item.replace(/^[-*]\s*/, "")}`);
    }
  }
  return lines.join("\n");
}

function renderNfrSection(answers: readonly RebuildAnswer[]): string {
  return [
    "## 6. Non-functional requirements",
    `- **Accessibility**: ${answerOrPlaceholder(answers, "Q14")}`,
    `- **Performance targets**: ${answerOrPlaceholder(answers, "Q21")}`,
    `- **Test strategy**: ${answerOrPlaceholder(answers, "Q22")}`,
    `- **Telemetry / privacy**: ${answerOrPlaceholder(answers, "Q23")}`,
    `- **Cost ceiling**: ${answerOrPlaceholder(answers, "Q24")}`,
    `- **i18n / locales**: ${answerOrPlaceholder(answers, "Q26")} (${answerOrPlaceholder(answers, "Q27", "default locale")})`,
  ].join("\n");
}

interface ActivatedRule {
  ruleId: string;
  source: { questionId: QuestionId; answerText: string };
}

function applyDecisionTable(answers: readonly RebuildAnswer[]): readonly ActivatedRule[] {
  const activated: ActivatedRule[] = [];
  for (const entry of DECISION_TABLE) {
    const answer = findAnswer(answers, entry.questionId);
    if (!answer) continue;
    if (!matchesPattern(entry, answer.answerText)) continue;
    for (const ruleId of entry.appliesRules) {
      activated.push({
        ruleId,
        source: { questionId: entry.questionId, answerText: answer.answerText },
      });
    }
  }
  return activated.sort((a, b) =>
    a.ruleId === b.ruleId ? a.source.questionId.localeCompare(b.source.questionId) : a.ruleId.localeCompare(b.ruleId),
  );
}

function matchesPattern(entry: DecisionTableEntry, answerText: string): boolean {
  const lowered = answerText.trim().toLowerCase();
  switch (entry.answerPattern) {
    case "any":
      return true;
    case "yes":
      return /\byes\b/.test(lowered);
    case "no":
      return /\bno\b/.test(lowered) && !/\byes\b/.test(lowered);
  }
}

function renderRulesSection(answers: readonly RebuildAnswer[]): string {
  const activated = applyDecisionTable(answers);
  const lines = ["## 7. Active kit rules (from decision table)"];
  if (activated.length === 0) {
    lines.push("- _(no rules activated yet)_");
    return lines.join("\n");
  }
  for (const a of activated) {
    lines.push(`- **${a.ruleId}** activated by ${a.source.questionId}: "${a.source.answerText.trim()}"`);
  }
  return lines.join("\n");
}

function renderInterviewProgressSection(
  answers: readonly RebuildAnswer[],
  library: readonly Question[],
): string {
  const totalFastPath = library.filter((q) => q.fastPath).length;
  const answered = library.filter((q) => q.fastPath && findAnswer(answers, q.id) !== undefined).length;
  const remaining: string[] = [];
  for (const q of library) {
    if (!q.fastPath) continue;
    if (findAnswer(answers, q.id)) continue;
    remaining.push(`  - ${q.id} (${q.topic})`);
  }
  const lines = [
    "## 8. Interview progress",
    `- Fast-path questions answered: **${answered} / ${totalFastPath}**`,
  ];
  if (remaining.length > 0) {
    lines.push("- Outstanding fast-path questions:");
    for (const r of remaining) lines.push(r);
  } else {
    lines.push("- All fast-path questions answered. Ready to start build (subject to Echo-back).");
  }
  return lines.join("\n");
}

export interface RebuildOptions {
  library?: readonly Question[];
}

/**
 * Build a deterministic `spec.md` markdown string from the recorded answers
 * and the kit's question library + decision table. Output contains no
 * timestamps in the body (so snapshot tests are stable across runs); a single
 * generation marker is included at the foot.
 */
export function rebuildSpec(
  answers: readonly RebuildAnswer[],
  options: RebuildOptions = {},
): string {
  const library = options.library ?? FAST_PATH_QUESTIONS;
  // Validate every supplied questionId is in the library to catch typos.
  for (const a of answers) {
    if (getQuestionById(a.questionId) === undefined) {
      throw new Error(`unknown questionId: ${a.questionId}`);
    }
  }

  return [
    "# Build Spec",
    "",
    "_Generated by the Builder from interview answers._",
    "",
    renderProblemSection(answers),
    renderScopeSection(answers),
    renderFlowsSection(answers),
    renderDataModelSection(answers),
    renderIntegrationsSection(answers),
    renderNfrSection(answers),
    renderRulesSection(answers),
    renderInterviewProgressSection(answers, library),
    "",
    "---",
    `_${answers.length} answers recorded._`,
    "",
  ].join(SECTION_DIVIDER).replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
