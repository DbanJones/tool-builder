// Ready-to-build gating per build-order.md B6 (kit section 14.3.5).
//
// A project is ready to start its build when:
//   1. Every fast-path question (Q1-Q35) has at least one recorded answer.
//   2. Every high-stakes follow-up that was activated has an answer.
//      (Activation is a future concept; for the placeholder library, the
//      35 fast-path set is the universe. A `library` override lets us pass
//      the activated set from elsewhere when that lands.)
//   3. The novice has clicked through the final echo-back gate ("Here is
//      what I will build, anything wrong?"). Tracked in the UI; passed in
//      via options.echoBackConfirmed.

import { FAST_PATH_QUESTIONS, type Question, type QuestionId } from "./library";
import type { RebuildAnswer } from "./rebuild-spec";

export interface ReadinessResult {
  ready: boolean;
  fastPathAnswered: number;
  fastPathTotal: number;
  missingFastPath: readonly QuestionId[];
  /** True once the novice has clicked through the final echo-back gate. */
  echoBackConfirmed: boolean;
  reason: string;
}

export interface ReadinessOptions {
  /** Set true once the UI has shown and gotten confirmation on the final echo-back. */
  echoBackConfirmed?: boolean;
  /** Override the question set; defaults to the canonical fast-path set. */
  library?: readonly Question[];
}

export function checkReadiness(
  answers: readonly RebuildAnswer[],
  options: ReadinessOptions = {},
): ReadinessResult {
  const library = options.library ?? FAST_PATH_QUESTIONS;
  const fastPath = library.filter((q) => q.fastPath);
  const answeredIds = new Set(answers.map((a) => a.questionId));
  const missing = fastPath.filter((q) => !answeredIds.has(q.id)).map((q) => q.id);
  const echoBackConfirmed = options.echoBackConfirmed ?? false;
  const fastPathAnswered = fastPath.length - missing.length;
  const fastPathTotal = fastPath.length;

  if (missing.length > 0) {
    const word = missing.length === 1 ? "question" : "questions";
    return {
      ready: false,
      fastPathAnswered,
      fastPathTotal,
      missingFastPath: missing,
      echoBackConfirmed,
      reason: `${missing.length} fast-path ${word} still to answer.`,
    };
  }

  if (!echoBackConfirmed) {
    return {
      ready: false,
      fastPathAnswered,
      fastPathTotal,
      missingFastPath: [],
      echoBackConfirmed: false,
      reason:
        "All fast-path questions answered. Confirm the echo-back to start the build.",
    };
  }

  return {
    ready: true,
    fastPathAnswered,
    fastPathTotal,
    missingFastPath: [],
    echoBackConfirmed: true,
    reason: "Ready to build.",
  };
}
