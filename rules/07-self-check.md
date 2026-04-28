# Self-check rules (drift detection vs original design)

The single most common AI-built-app failure mode is silent drift: the agent builds something subtly different from the original spec, the difference compounds across phases, and by the end you have a working app that solves the wrong problem.

**Drift is defined exclusively against `spec.md` (the original design)**, not against intermediate decisions, conversation history, or what feels reasonable. If `spec.md` says X and the code does Y, the code is wrong, even if Y looks better. The fix is either to bring the code back to X, or to amend `spec.md` with the user's explicit approval and an ADR. There is no third option.

## When to self-check (mandatory checkpoints)
SC1. MUST run the full self-check protocol at the end of every phase listed in `spec.md` section 7, before declaring the phase complete.
SC2. MUST run the full self-check protocol immediately before opening a PR to `main`.
SC3. MUST run a lightweight self-check (Levels 1 and 2 only) after any change to `lib/db/schema/`, `app/api/`, or `lib/orchestrator/`.
SC4. MUST run a lightweight self-check (Levels 1 and 2 only) when the user types `/recheck`.
SC5. MUST run the full self-check protocol if the user reports unexpected behaviour, before attempting a fix.

## What counts as drift (three forms, all measured against spec.md)
SC6. **Implementation drift**: code does something different from what an acceptance criterion in `spec.md` section 3 says it should do.
SC7. **Scope drift**: code implements something not described in `spec.md` (in-scope, flows, data model, integrations).
SC8. **Silent assumption drift**: code commits to a decision the spec did not specify and the user did not approve.

All three are equally serious. Scope drift is not "extra value"; it is unrequested work the user did not budget for and may not want.

## The self-check protocol (run in order, do not skip levels)

### Level 1: Spec coverage (does every spec item exist in the repo?)
SC9. MUST iterate through `spec.md` in-scope items, flows, data model, integrations, and NFRs, and for each item produce one line: `[present | partial | missing | drifted]` with a file:line pointer or "n/a not yet built".
SC10. MUST output the result as `docs/spec-trace.md` (overwrite each run); that file is the canonical drift report.
SC11. MUST flag any item marked `partial` older than one phase as a blocker.

### Level 2: AC to test traceability
SC12. MUST verify that every Given/When/Then acceptance criterion in `spec.md` maps to at least one test (unit, integration, or E2E) whose name or comment cites the AC id (e.g. `// covers: Flow A AC1`).
SC13. MUST list any AC with zero tests as a blocker for the current phase.
SC14. MUST list any test that does not map back to an AC; ask the user whether to delete the test or amend the spec.

### Level 3: Scope check (is anything in the repo not in the spec?)
SC15. MUST list every route under `app/`, every table in `lib/db/schema/`, every integration in `lib/`, every Tauri command, and every orchestrator step.
SC16. MUST flag any item from SC15 not referenced by `spec.md` as scope drift; output it under "Scope drift candidates" in `docs/spec-trace.md` with one of three resolutions: revert, add to spec via ADR, or escalate to user.

### Level 4: Silent assumptions audit
SC17. MUST list every ADR in `docs/adr/`. For each, verify it cites the spec section that triggered it.
SC18. MUST search for non-default choices the agent made without an ADR. The default catalogue lives in `rules/04-libraries.md` and `rules/02-backend.md`. Examples to check explicitly:
- Pagination style: cursor (default per B10) or offset?
- Job runner: in-process orchestrator (override per B22) or other?
- ORM: Drizzle (default per L9) or other?
- Auth: OS keychain for third-party tokens + Claude Code CLI auth prerequisite (override per B13) or other?
- LLM provider: Claude Agent SDK in the sidecar for Builder chat/build (override per L17)?
SC19. MUST flag any non-default choice without an ADR as silent assumption drift; either write the ADR now or revert.

### Level 5: Non-functional drift
SC20. MUST run `corepack pnpm verify` and the launch-time check; compare numbers against `spec.md` section 6 budgets. Any miss is drift, not a "to fix later".
SC21. MUST run a Tauri allowlist linter to assert the allowlist is deny-by-default with explicit allows only.
SC22. MUST run `corepack pnpm e2e -- --grep smoke`; smoke must be green at every checkpoint, no exceptions.

## Course correction (what to do when drift is found)
SC23. MUST stop adding new features the moment any blocker drift is found at a checkpoint. The next action is correction, not progress.
SC24. MUST present the drift report to the user with three options for each item: (a) revert code to match spec, (b) amend spec with the user's approval and an ADR, (c) park the item with an explicit `// drift-accepted: see ADR-NNNN` comment and an issue.
SC25. MUST NOT amend `spec.md` without the user's explicit "yes, change the spec". Echo-back applies: state the proposed spec change, wait for approval, then write it.
SC26. MUST log every correction in `docs/drift-log.md` with date, AC id or scope item, drift type, resolution, and commit hash. This is the audit trail.

## Drift budget per phase
SC27. MUST keep blocker drift at zero by end of each phase. Non-blocker drift (e.g. partial items expected next phase) is acceptable if logged.
SC28. MUST treat three or more silent assumption drifts in one phase as a process failure; pause, raise it with the user, and re-run the Echo-back protocol on the next chunk of work.

## Output format for `/recheck`
SC29. MUST produce, in this exact order:
1. **Summary**: pass | drift detected (n blockers, m non-blockers).
2. **Spec coverage table** (from Level 1).
3. **AC to test table** (from Level 2).
4. **Scope drift candidates** (from Level 3).
5. **Silent assumption candidates** (from Level 4).
6. **NFR check** (from Level 5).
7. **Recommended next actions**, numbered, smallest first.
SC30. MUST end the report by asking: "Proceed with corrections in this order? (yes / re-order / skip n)". Do not auto-correct without confirmation.
