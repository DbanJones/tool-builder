// Shared types for the repair engine. Codemods (Tier 1), the Tier 2
// verify loop, and the Tier 3 explainer all return one of the three
// CodemodResult variants below. The dispatcher sums them into a
// RepairOutcome that the handler turns into defect-row updates.

export type CodemodResult =
  | {
      kind: "applied";
      /** Workspace-relative paths the codemod wrote to. */
      files: readonly string[];
      message: string;
      /** Tier classification per source spec §E.2. */
      fixTier: 1 | 2 | 3;
    }
  | { kind: "skipped"; message: string }
  | { kind: "error"; message: string };
