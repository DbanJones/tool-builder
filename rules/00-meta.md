# Meta

## Conflict resolution (precedence, highest wins)
1. The user's explicit instruction in the current turn.
2. `spec.md` (the project brief).
3. `CLAUDE.md` binding rules (1-12).
4. The relevant `rules/*.md` file.
5. Stack defaults named in CLAUDE.md.
6. General best practice.

If a conflict appears, STOP, output the conflict and the candidates, and ask.

## Ambiguity rule
When two interpretations of a spec are plausible, do not pick one; ask. The cost
of one clarifying question is far smaller than the cost of building the wrong thing.

## Echo-back protocol (canonical)
See CLAUDE.md Echo-back section. Apply at the start of every new feature, every
refactor touching at least 3 files, and every change to data model or auth.

## Self-check protocol (canonical)
See `rules/07-self-check.md`. Drift is measured against `spec.md`, the original
design. The agent runs the protocol at every phase boundary, before every PR
to main, and on every `/recheck`. Three drift forms are equally serious:
implementation drift, scope drift, silent assumption drift.

## Discipline protocol (canonical)
See `rules/08-discipline.md`. Governs per-edit behaviour: state assumptions
before coding, surface the simpler path, restate the task as a verifiable
goal, limit changes to what the request requires, do not "improve" adjacent
code, no speculative features or error handling. Applies to every edit.

## Self-drive protocol (canonical)
See `docs/agent-runbook.md`. The agent reads `.builder/state.json` to find the
current phase and next task, executes per the runbook, pauses only at the
checkpoints listed in section 3 of the runbook. Pure autonomy is not the goal:
self-driving with checkpoints is.

## Glossary (terms used in this repo)
- Builder: this app, the desktop tool we are building.
- Novice: the absolute beginner using the Builder to build their own app.
- Target app: the app the novice is building.
- Orchestrator: the in-process engine that drives Claude Code on the novice's behalf.
- Live tail: the human-readable stream of what Claude Code is doing right now.
- Drift: a difference between the current code and the original spec.md.
- AC: acceptance criterion, written Given/When/Then in spec.md section 3.
- Echo-back: the protocol that gates code generation behind explicit confirmation.
- Phase: a chunk of build work with its own definition of done; phases A through E for the Builder itself.
- Fast-path: the 28-question subset that produces a usable spec on its own.
