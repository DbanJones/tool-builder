# Agent runbook

This file tells Claude Code how to self-drive the Builder build. Read it at the start of every session.

## 1. Session start
On every session start:
1. Read `.builder/state.json`. If absent, this is the first session; create it from `.builder/state.template.json`.
2. Identify `current_phase` and the next incomplete task in `docs/build-order.md`.
3. Run `/recheck lite`. If any blocker drift, stop and report it before doing anything else.
4. Read `docs/build-order.md` for the current phase, find the first task with `status: pending`.
5. Output a short "where we are" summary: phase, last completed task, next task, any open questions.
6. Begin the Echo-back Protocol for the next task.

## 2. Per-task loop
For each task:
1. Echo-back: state goal, files, ACs, risks, plan. Wait for "go" or correction.
2. On "go", implement the task. Use subagents for read-heavy exploration so the main context stays clean.
3. After each meaningful change, run `corepack pnpm exec tsc --noEmit && corepack pnpm exec vitest run --config vitest.unit.config.ts`. Fix failures before proceeding.
4. When the task's ACs are met, run `corepack pnpm verify`. If green, run any task-specific E2E.
5. Update `state.json`: mark task complete, record completion timestamp, append to `history`.
6. Commit using Conventional Commits, link the task id.
7. Move to the next task. Do not summarise extensively; just proceed.

## 3. Mandatory pause points (ask the human)
You MUST stop and ask the human at any of:
1. **Phase boundary**. After the last task in a phase, run `/recheck` (full), surface the report, and ask: "Phase {N} done. Drift report: ... Continue to Phase {N+1}?"
2. **Drift detected as blocker**. Surface the drift, propose options, wait.
3. **Irreversible action**. Any of: deleting files outside the project folder, force-pushing, dropping a database table in `.builder/builder.db`, modifying a signed installer, publishing to a release feed.
4. **Spec ambiguity with no default**. If the spec does not cover a decision and the kit's defaults do not apply, ask. Do not guess.
5. **Cost overrun**. If session token spend exceeds 5 USD, stop and ask before continuing.
6. **Three failed retries on the same operation**. Stop, summarise what you tried, ask for guidance.
7. **External dependency change**. If a pinned package version is unavailable, do not auto-upgrade; surface the issue.

When you pause, write a clear, single question. Do not stack questions. The human will answer one thing.

## 4. Failure recovery
If a task fails:
1. Capture the failure: error message, stack trace, last 5 actions from `history.log`.
2. Try one fix in line with the kit's rules. Do not improvise outside them.
3. If the fix fails, revert to the last green commit and stop.
4. Write a one-paragraph incident note to `docs/incidents/{YYYY-MM-DD}-{slug}.md`: what was attempted, what failed, what you reverted to, what you would try next.
5. Ask the human.

## 5. Context hygiene
- Use `/clear` between phases.
- Use `/compact` after every completed task.
- Never paste full file contents into chat; use `file:line` pointers.
- Use the `researcher` subagent for any operation that reads more than three files.
- Use the `reviewer` subagent for fresh-context review of every PR before opening it.
- Use the `test-writer` subagent for E2E authoring; main context stays focused on implementation.

## 6. Definition of "done"
A task is done when:
- Every AC has at least one test that cites the AC id.
- `corepack pnpm verify` is green.
- The relevant E2E (if any) is green.
- The diff is under 400 lines.
- The commit message follows Conventional Commits.
- `state.json` has been updated.
- The next task is identified in the runbook output.

A phase is done when:
- Every task in the phase is done.
- `/recheck` (full) reports zero blocker drift.
- The phase's "definition of done" in `build-order.md` is met.
- Signed installers (if applicable) build cleanly.
- The human has approved the phase boundary.

## 7. Communication style with the human
- Be terse. The human is busy and trusts the protocols.
- Lead with the answer or the question. Reasoning second, only if asked.
- One question at a time. Wait for the answer.
- Surface costs and ETAs proactively when they change materially.
- Never apologise for asking a clarifying question; it is cheaper than building the wrong thing.
- Use British English. No em dashes.
