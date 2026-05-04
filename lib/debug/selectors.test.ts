import { describe, expect, it } from "vitest";

import { selectUnresolvedCritical } from "./selectors";
import type { Defect } from "./sidecar";

const defect = (overrides: Partial<Defect> = {}): Defect => ({
  id: `d-${Math.random().toString(36).slice(2, 8)}`,
  projectId: "01PROJ",
  scanId: "01SCAN",
  detectedAt: 100,
  class: "auth",
  severity: 9,
  blastRadius: 2.5,
  confidence: 0.7,
  difficulty: 1.5,
  priority: 21,
  band: "critical",
  file: "supabase/migrations/0001.sql",
  lineStart: 1,
  lineEnd: 1,
  ruleId: "rls-missing/no-rls-on-pii-table",
  humanExplanation: "...",
  codeEvidence: "...",
  status: "open",
  fixTier: null,
  fixBranch: null,
  fixTestPath: null,
  resolvedAt: null,
  resolvedCommit: null,
  validatorVerdict: null,
  validatorNotes: null,
  validatedAt: null,
  suggestion: null,
  ...overrides,
});

describe("selectUnresolvedCritical", () => {
  it("returns critical-band defects whose status is open or fixing", () => {
    const open = defect({ status: "open" });
    const fixing = defect({ status: "fixing" });
    const result = selectUnresolvedCritical([open, fixing]);
    expect(result).toHaveLength(2);
  });

  it("excludes critical-band defects that are fixed", () => {
    expect(selectUnresolvedCritical([defect({ status: "fixed" })])).toEqual([]);
  });

  it("excludes critical-band defects that the validator dismissed", () => {
    expect(selectUnresolvedCritical([defect({ status: "dismissed" })])).toEqual([]);
  });

  it("excludes critical-band defects the user accepted as risk", () => {
    expect(selectUnresolvedCritical([defect({ status: "accepted_risk" })])).toEqual([]);
  });

  it("excludes high/medium/low/info even if status is open", () => {
    const list = [
      defect({ band: "high" }),
      defect({ band: "medium" }),
      defect({ band: "low" }),
      defect({ band: "info" }),
    ];
    expect(selectUnresolvedCritical(list)).toEqual([]);
  });

  it("returns empty for an empty list", () => {
    expect(selectUnresolvedCritical([])).toEqual([]);
  });

  it("filters mixed input correctly", () => {
    const list = [
      defect({ band: "critical", status: "open" }),
      defect({ band: "critical", status: "fixed" }),
      defect({ band: "high", status: "open" }),
      defect({ band: "critical", status: "fixing" }),
    ];
    expect(selectUnresolvedCritical(list)).toHaveLength(2);
  });
});
