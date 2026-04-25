# Drift log

Per [rules/07-self-check.md](../rules/07-self-check.md) SC26: every correction or accepted drift is logged here with date, AC id or scope item, drift type, resolution, and commit hash. This is the audit trail.

## 2026-04-25

### D-001 — `eslint-plugin-neverthrow` `must-use-result` enforcement gap
- **Drift type**: silent assumption drift (against [CLAUDE.md](../CLAUDE.md) binding rule indirectly via [rules/03-code.md](../rules/03-code.md) C11).
- **Discovered at**: A2 (keychain wrapper) when wiring the rule for the first Result-returning module.
- **Cause**: the only published version of `eslint-plugin-neverthrow` is 1.1.4 (2022). It uses an old `@typescript-eslint` parserServices accessor that throws "Error while loading rule 'neverthrow/must-use-result': types not available" when paired with `@typescript-eslint@8` (the current major). No compatible release exists.
- **Resolution**: drift accepted. Plugin removed from `eslint.config.js`. Convention plus code review (and per-PR `reviewer` subagent) enforces "every Result must be consumed" until one of: (a) a compatible plugin release lands, (b) we fork-and-patch, (c) we migrate to a different result/error library with native lint support.
- **Commit**: 06df4c4 (A2 commit).
- **Follow-up**: monitor https://github.com/mdbetancourt/eslint-plugin-neverthrow for v2 / a flat-config and TS-ESLint v8 compatible release. Re-attempt at next major dep refresh.

### D-002 — shadcn/ui init + Button smoke test deferred from A1 to A3
- **Drift type**: scope drift (deferral, against the A1 plan in [docs/build-order.md](build-order.md)).
- **Discovered at**: A1 (repo scaffold).
- **Cause**: the `shadcn` CLI restructured between when build-order.md was written and now. The old `--base-color` flag is gone; the new flow is template-and-preset based and would have required guesswork under Auto mode. Tailwind 3 was wired manually; full shadcn integration moves to A3 where the Welcome screen actually needs UI primitives.
- **Resolution**: drift accepted. A3 Echo-back will include shadcn init as a step (and will revise its plan to reflect the current CLI shape).
- **Commit**: 9132e2c (A1 scaffold).
- **Follow-up**: revisit at A3 Echo-back.
