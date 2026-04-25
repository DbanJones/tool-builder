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

### D-002 — shadcn/ui CLI flow not viable in this shell environment; primitives written manually
- **Drift type**: scope drift (resolved differently than originally planned).
- **Discovered at**: A1 (deferred), retried and resolved at A3.
- **Cause**: the `shadcn@latest init` and `shadcn add` commands internally `spawn('pnpm', ...)` for dep installation. In this Claude Code shell environment, that spawned subprocess does not inherit a working PATH to pnpm (which lives at `~/Library/pnpm/pnpm`, not on the system PATH), so shadcn fails with `ENOENT`. PATH propagation worked for the outer invocation but not the nested spawn. Even with `-y -d -f` and various PATH gymnastics it could not be coaxed into completing.
- **Resolution**: shadcn deps were installed manually (`clsx`, `tailwind-merge`, `class-variance-authority`, `lucide-react`, `tw-animate-css`, `@base-ui/react`). The three primitives needed at A3 (`Button`, `Card`, `Alert`) and `lib/utils.ts` (`cn` helper) were hand-written using the canonical shadcn patterns and CSS variable tokens (neutral base color). `tailwind.config.ts` and `app/globals.css` were updated by hand. Output is identical to what shadcn would have produced; only the path differs.
- **Commit**: 81bbc66 (A3 commit).
- **Follow-up**: when adding any further shadcn primitive (Dialog, Form, etc. for A4 onwards), keep writing them by hand from the same patterns. Revisit the CLI in a future session if Claude Code's shell environment changes or pnpm becomes available on the system PATH.

### D-003 — AC5 audit destination is `tauri-plugin-log` rather than `.builder/builder.log`
- **Drift type**: implementation drift (against [rules/06-other.md](../rules/06-other.md) O8 and indirectly Flow A AC5).
- **Discovered at**: A3.
- **Cause**: the audit mechanism needed to land at A3 to satisfy Flow A AC5 (`audit log records app_first_run`). The Drizzle `audit_log` table does not exist yet (no DB layer until A4), and `.builder/builder.log` rotation requires file-system glue we have not written. To unblock A3, `audit_log_event` is implemented as a Tauri command that calls `log::info!` via the existing `tauri-plugin-log`. The events ARE logged; the destination is the OS log directory rather than `.builder/builder.log`.
- **Resolution**: drift accepted as a temporary destination. Migration target: when Drizzle lands at A4 (project creation requires the `projects` table), an `audit_log` table is added in the same migration and `audit_log_event` is rewritten to insert there.
- **Commit**: 81bbc66 (A3 commit).
- **Follow-up**: A4 task to migrate the audit destination.

### D-004 — Welcome E2E (`tests/e2e/welcome.spec.ts`) deferred from A3 to Phase D
- **Drift type**: scope drift (deferral, against the A3 plan in [docs/build-order.md](build-order.md)).
- **Discovered at**: A3.
- **Cause**: the E2E in build-order.md A3 wants Playwright driving the Welcome screen against a stubbed `claude` binary on PATH. To do that with the real Tauri webview requires `tauri-driver` (a separate setup); to do it against `pnpm dev` requires mocking Tauri `invoke` at the Playwright boundary, which is non-trivial and gives a less faithful test than the production transport. Both paths were larger than fit in A3's scope.
- **Resolution**: drift accepted. A3 ships unit-test coverage of the same logical surface: 7 unit tests in `lib/cli-detection/index.test.ts` cover all three states (`missing`, `unauthenticated`, `ready`) plus error paths, with the `invoke` boundary mocked. A real-binary E2E lands in Phase D when `tauri-driver` is set up.
- **Commit**: 81bbc66 (A3 commit).
- **Follow-up**: Phase D ticket to install `tauri-driver`, write `tests/e2e/welcome.spec.ts` with a fixture `claude` binary on a per-test PATH.
