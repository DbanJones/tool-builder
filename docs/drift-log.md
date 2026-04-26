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

### D-003 — AC5 audit destination is `tauri-plugin-log` rather than `.builder/builder.log` [RESOLVED at A4b]
- **Drift type**: implementation drift (against [rules/06-other.md](../rules/06-other.md) O8 and indirectly Flow A AC5).
- **Discovered at**: A3.
- **Cause**: the audit mechanism needed to land at A3 to satisfy Flow A AC5 (`audit log records app_first_run`). The Drizzle `audit_log` table did not exist yet (no DB layer until A4), and `.builder/builder.log` rotation required file-system glue we had not written. To unblock A3, `audit_log_event` was implemented as a Tauri command that called `log::info!` via the existing `tauri-plugin-log`. Events were logged; the destination was the OS log directory rather than `.builder/builder.log`.
- **Original resolution**: drift accepted as a temporary destination. Migration target: A4b.
- **A3 commit**: 81bbc66.
- **Closure (A4b)**: the Drizzle `audit_log` table now exists in `.builder/builder.db` (per ADR-0004's Node sidecar architecture). `lib/audit/index.ts` calls `sidecarCall("audit.logEvent", ...)` directly; the sidecar handler at `sidecar/src/handlers/audit.ts` inserts a row with a ULID id, default `actor_id = 'novice'`, and a JSON `payload`. The legacy `audit_log_event` Tauri command in `src-tauri/src/lib.rs` is deleted. An integration test (`tests/integration/sidecar-audit.test.ts`) spawns the sidecar against a temp DB and asserts the round-trip.
- **Closure commit**: cbb8128 (A4b commit).
- **Note**: O8 also asks for `.builder/builder.log` daily rotation. The audit destination is now the DB; the application log file (Tauri's `tauri-plugin-log` output) is a separate concern and remains at the OS log dir for now. Tracked separately if/when needed.

### D-006 — `.builder/answers.json` legacy file mirror skipped
- **Drift type**: implementation drift (against [docs/build-order.md](build-order.md) B2 wording: "On tool call, the MCP handler writes to `.builder/answers.json` and appends to the answers table.").
- **Discovered at**: B2.
- **Cause**: the build-order calls for double-writing answers to both `.builder/answers.json` and the SQLite `answers` table. The JSON file is a legacy format from the original design pack (used as a portable record). With the sidecar + Drizzle + ULID architecture per ADR-0004, the DB row is the source of truth: it has FK to projects, ordered timestamps, and confidence/source enums. A JSON-file mirror would need careful concurrency handling (two processes writing to the same file) and adds a second source of truth that can drift from the DB.
- **Resolution**: drift accepted. Source of truth is the DB. If a portable JSON export is needed later (e.g. for a "show me my answers" view, or for spec-rebuild input), expose an `answers.exportJson` sidecar method that derives it from the table on demand.
- **Commit**: 163677d (B2 commit).
- **Follow-up**: add the `answers.exportJson` derivation in B3 if the spec-rebuild step needs the JSON shape.

### D-005 — Question library + decision table seeded as inferred placeholders
- **Drift type**: scope drift (placeholder content, against the B1 plan in [docs/build-order.md](build-order.md)).
- **Discovered at**: B1.
- **Cause**: the build-order's B1 reads "Copy the kit's question library and decision table into `lib/interview/library.ts` as typed data". The original Build Spec Kit's authoritative library has not been sourced into this repo. Same pattern as the placeholder templates at A4c (per human direction 2026-04-25 to defer real content).
- **Resolution**: drift accepted. `lib/interview/library.ts` ships 28 fast-path questions whose **ids and topics** are taken from `.builder/answers.json` (the recorded interview that produced spec.md), but whose **exact prompt strings** are inferred placeholder phrasing. Decision table is a thin starter set covering the most obvious mappings (PII, accessibility, webhooks, jobs, i18n). The schema is canonical and matches what the real kit will plug into.
- **Commit**: a534bd5 (B1 commit).
- **Follow-up**: when the kit is sourced, replace `prompt` strings and extend the decision table; tests should still pass without schema changes.

### D-004 — Tauri-context E2E + integration tests deferred to Phase D (extended at A5)
- **Drift type**: scope drift (deferral, against the A3 + A5 plans in [docs/build-order.md](build-order.md)).
- **Discovered at**: A3, extended at A5.
- **Cause**: tests that exercise the real Tauri webview (Welcome E2E from A3, chat smoke E2E from A5, rate-limit integration test from A5) all need `tauri-driver` (a separate setup) or full webview/IPC mocking, both of which are larger than fit inside the originating tasks. The "stubbed `claude` binary on PATH" part is straightforward (a small shell script); the harness around it is the work.
- **Resolution**: drift accepted across both tasks. The logical surface is covered by smaller-scope tests with mocked boundaries:
  - A3: 7 unit tests in `lib/cli-detection/index.test.ts` cover all three Welcome states with `invoke` mocked.
  - A5: 11 Rust tests in `src-tauri/src/chat.rs` cover the stream-json parser and rate-limit detector with raw lines as fixtures; 5 unit tests in `lib/chat/client.test.ts` cover the Channel-based wrapper with `invoke` and `Channel` mocked.
  Real-binary E2E and rate-limit integration land in Phase D when `tauri-driver` is set up.
- **Commits**: 81bbc66 (A3 origin); A5 extends scope (this commit).
- **Follow-up**: Phase D ticket to install `tauri-driver` + fixture `claude` binary, write:
  - `tests/e2e/welcome.spec.ts` covering all three Welcome states.
  - `tests/e2e/chat-smoke.spec.ts` for the happy chat path.
  - `tests/integration/chat-rate-limit.test.ts` for the rate-limit path with a stubbed `claude` returning the rate-limit error.
