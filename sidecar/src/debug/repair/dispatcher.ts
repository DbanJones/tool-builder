// Repair dispatcher. Routes a defect to the appropriate Tier 1
// codemod by ruleId. Returns the codemod's CodemodResult unchanged so
// the caller (the debug.applyFix handler) can update the defects row
// in place.
//
// Tier 2 (LLM verify loop) and Tier 3 (suggest-only) integrate here
// in G5d/G7. v1 routes only the rules whose Tier 1 codemod has
// landed.

import type { Defect } from "../../schema/defects.js";

import {
  applyAddRlsMigration,
  handlesRuleId as rlsHandles,
} from "./codemods/add-rls-migration.js";
import {
  applyExtractSecret,
  handlesRuleId as secretHandles,
} from "./codemods/extract-secret.js";
import type { CodemodResult } from "./types.js";

export interface DispatchInput {
  defect: Pick<
    Defect,
    "ruleId" | "file" | "lineStart" | "lineEnd" | "codeEvidence"
  >;
  projectPath: string;
}

/**
 * Try to route the defect to a Tier 1 codemod. Returns:
 *  - applied: the codemod wrote files; caller commits + verifies.
 *  - skipped: nothing matched (Tier 2/3 territory) — the caller's
 *    handler should record this and surface a "no automatic fix
 *    available" message in the dashboard.
 *  - error: the codemod tried but hit an I/O or shape issue; the
 *    handler logs and surfaces but does not retry.
 */
export async function dispatchTier1(
  input: DispatchInput
): Promise<CodemodResult> {
  if (secretHandles(input.defect.ruleId)) {
    return applyExtractSecret({
      defect: input.defect,
      projectPath: input.projectPath,
    });
  }
  if (rlsHandles(input.defect.ruleId)) {
    return applyAddRlsMigration({
      defect: input.defect,
      projectPath: input.projectPath,
    });
  }
  return {
    kind: "skipped",
    message: `dispatcher: no Tier 1 codemod registered for ${input.defect.ruleId}`,
  };
}

/** True when a defect has a Tier 1 codemod available — used by the UI. */
export function hasTier1Codemod(ruleId: string): boolean {
  return secretHandles(ruleId) || rlsHandles(ruleId);
}
