---
description: Validate the current phase is complete, run full recheck, request human approval to proceed
allowed-tools: Read, Bash, Grep, Glob
model: claude-opus-4-7
---
You are at a phase boundary. Do not write code in this turn.

1. Read `docs/build-order.md` for the current phase from `.builder/state.json`.
2. Verify every task in the phase has `status: complete` and at least one passing test.
3. Run `/recheck` (full). Read the resulting `docs/spec-trace.md`.
4. Run `pnpm verify` and `pnpm e2e`. Report results.
5. Verify the phase's "definition of done" criteria from `build-order.md`.
6. Output a phase summary in this format:
   - Phase: {letter}, name
   - Tasks completed: {n}/{n}
   - Drift: {blocker count}, {non-blocker count}
   - Tests: passing/failing
   - DoD: which criteria met, which not
   - Recommendation: proceed | fix first
7. End with: "Approve advance to Phase {next}? (yes / fix first)"

Wait for the human's reply. On "yes", update `state.json` to advance the phase and run `/clear`. On "fix first", list the remaining items and stop.
