# Drift log

Per [rules/07-self-check.md](../rules/07-self-check.md) SC26: every correction or accepted drift is logged here with date, AC id or scope item, drift type, resolution, and commit hash. This is the audit trail.

## 2026-04-28

### D-022 — Phase F novice-readiness hardening closes several accepted gaps
- **Drift type**: implementation alignment (hardening pass against the codebase review recommendations and prior accepted drift).
- **Discovered at**: review of novice buildability and tool structure after Phase E.
- **Cause**: the product was functionally broad but still carried rough edges that would trip a novice: stop/cancel was stream-id-only, final echo-back was documented but not enforced, file summaries could influence the spec before explicit approval, PII review was too passive, question ids were unconstrained, scripts assumed a global `pnpm`, target-app template rules were placeholders, and several docs still described the pre-SDK CLI/stream-json architecture.
- **Resolution**: implemented in Phase F:
  - `orchestrator.stop` now cancels by stream id, project id, or all active runs as a fallback.
  - Readiness now requires all fast-path answers plus explicit "Looks right" echo-back confirmation before build can start.
  - `record_answer` and `queue_questions` validate ids against Q1-Q32.
  - Uploaded files require approval; PII warnings block the next chat/build action until reviewed or skipped.
  - Approved file summaries are included in `spec.md` section 0 as source materials; PII summaries use redacted text.
  - Target-app template rules are concrete, and nested pnpm calls use `corepack pnpm`.
  - ADR/build/spec/runbook docs now describe the SDK sidecar and current novice gates.
- **Commit**: TBD (Phase F hardening commit).
- **Follow-up**:
  1. Persist file approval/review state in SQLite instead of UI memory.
  2. Replace the remaining placeholder question wording/decision table once the authoritative kit is sourced.
  3. Bundle the sidecar runtime in production installers so novices do not need Node installed.

## 2026-04-25

### D-021 — `--permission-prompt-tool` is SDK-only; reverted Commit B's permission-routing flag wiring
- **Drift type**: implementation drift (against the design in commit 09929ed which assumed `--permission-prompt-tool` was a CLI flag).
- **Discovered at**: 2026-04-27 live test — clicking Start build returned `Orchestrator error: Input must be provided either through stdin or as a prompt argument when using --print`.
- **Cause**: the `--permission-prompt-tool` flag I added to the orchestrator's claude spawn does not exist in the claude CLI surface (it's only available via the Anthropic Agent SDK's `permission_prompt_tool_name` parameter). claude's CLI parser treated it as unknown, but because `--allowed-tools` is variadic (`<tools...>`) the unrecognized flag's value AND the kickoff prompt were both consumed by the variadic, leaving no positional. Spawn failed.
- **Resolution**: drift accepted. Reverted the spawn args to the previous state (`--permission-mode bypassPermissions` + `--add-dir <cwd>`, no `--mcp-config` / `--permission-prompt-tool` / `--allowed-tools` for the orchestrator). The `permission_requests` table, sidecar handlers, dashboard `PermissionPromptBanner`, and `mcp-orchestrator.ts` MCP server all REMAIN in the codebase as dead code (marked `#[allow(dead_code)]` on the Rust helper) so the hooks-based rewire can re-enable them without re-implementing the wiring.
- **Commit**: TBD (revert commit).
- **Follow-up**: implement the permission flow via Claude Code's `PreToolUse` hook system instead of `--permission-prompt-tool`. The hook script (a small shell command) talks to the sidecar's `permissionRequests.append` + `poll` over stdio; on novice click the hook returns `{decision: "block"|"allow"}` to claude. All the existing dashboard UI + DB plumbing stays; only the Rust spawn args + a new hook script change.
- **2026-04-28 update**: ADR-0005 superseded the hook/CLI-spawn path for build orchestration. The build driver now uses the Claude Agent SDK in the Node sidecar, and stop/cancel is wired by project/stream id.

### D-020 — E6 marketing site ships with placeholder downloads + no demo recording
- **Drift type**: scope drift (deferral, against [docs/build-order.md](build-order.md) E6: "one-page Next.js site at apps/marketing/ with download links and a 90-second screen recording").
- **Discovered at**: E6.
- **Cause**: real download links require Phase E0 (signed installer artefacts) and a release pipeline that publishes to a CDN/GitHub Releases — both deferred. The 90-second screen recording can only be made after a real end-to-end build runs in `corepack pnpm tauri dev` (which depends on the user's claude CLI auth + a real test project).
- **Resolution**: drift accepted. E6 ships:
  - `apps/marketing/` — minimal Next.js 15 + React 19 + Tailwind sibling project (NOT a pnpm workspace member; runs via `corepack pnpm install && corepack pnpm dev` from inside the dir; serves on port 3001 to avoid clashing with the root Builder dev server).
  - `apps/marketing/app/page.tsx` — hero + 90s-demo placeholder block + three download cards (macOS/Windows/Linux) gated on a `DOWNLOAD_LINKS_PENDING` flag (currently true). When E0 ships, flip the flag and set the URLs.
  - Root `tsconfig.json` excludes `apps/marketing` so the Builder's strict typecheck doesn't trip on the marketing site's looser settings; ESLint config does the same.
- **Commit**: 08cce5a (E6 commit).
- **Follow-up**:
  1. After E0: replace the placeholder download URLs with real signed-installer URLs and flip `DOWNLOAD_LINKS_PENDING = false`.
  2. After a real build run: capture a 90s screen recording (Loom / OBS), put `demo.mp4` in `apps/marketing/public/`, and set `SCREEN_RECORDING_URL = "/demo.mp4"`.
  3. Configure deploy of the marketing site (Vercel) — separate from the Builder app; uses the same E1 deploy flow.

### D-019 — Sentry SDK integration deferred from E5 (consent capture only)
- **Drift type**: scope drift (deferral, against [rules/06-other.md](../rules/06-other.md) O7 "MUST install Sentry for errors").
- **Discovered at**: E5.
- **Cause**: O7 wants Sentry installed AND opt-in. The opt-in mechanism is the load-bearing novice-facing piece (per spec §8 open question's default answer); the SDK integration itself is a separate Initiative (pick `@sentry/nextjs` vs `@sentry/react` + Sentry's webview-shim, configure DSN, sourcemap upload in CI, beforeSend PII scrubbing per O16, etc.). Bundling both into a single E5 slice would push it past the 400-line ceiling per binding rule 9.
- **Resolution**: drift accepted. E5 ships:
  - `lib/telemetry/index.ts`: `getSentryDecision`/`setSentryDecision` (localStorage), `hasMadeSentryDecision`, and a `reportError(error)` no-op shim that always honours the consent decision (so we cannot accidentally leak PII before consent). 16 unit tests cover the persistence + the privacy guarantee (a Proxy-trapped error payload is not even read when consent is missing).
  - `<SentryPrompt>` Alert with Yes / No / Later buttons + a brief disclaimer naming what we will and will not send (per O16: never chat content, never project paths, never uploaded files).
  - Dashboard triggers the prompt once after the first `done` event, gated on `hasMadeSentryDecision()` being false.
- **Commit**: 85beb46 (E5 commit).
- **Follow-up**: Phase F-style polish ticket adds the SDK:
  1. `corepack pnpm add @sentry/react` (or @sentry/nextjs if the Tauri webview shim works for Next App Router).
  2. Initialise in `app/layout.tsx` gated on `getSentryDecision() === "accepted"`.
  3. Replace the `reportError` body with `Sentry.captureException(error, { extra: scrubExtra(error) })`.
  4. Add `beforeSend` PII scrub per O16.
  5. Configure CI to upload sourcemaps on every signed build (E0-dependent).

### D-018 — E4 ships an OPTIONAL spend cap (not "daily"), reconciling spec §6 vs build-order E4
- **Drift type**: implementation drift (against [docs/build-order.md](build-order.md) E4 wording "daily cap... soft warn at 50%, hard stop at 100%").
- **Discovered at**: E4.
- **Cause**: build-order E4 says "implement the daily cap from spec.md §6 NFR" but [spec.md §6](../spec.md) explicitly says "No hard daily spend cap is enforced by the Builder (deferred to a later phase if required)" and rules/04-libraries.md L23 confirms the same override (per ADR-0002, the claude CLI's underlying account governs throttling). Per rules/00-meta.md precedence the spec wins. Two further sub-decisions:
  1. "daily" → "lifetime" — the existing `costs.sumByProject` returns the per-project total, not today's. A roll-by-day query is a one-line addition but doesn't change the user-visible behaviour at the cap thresholds; it only matters if the novice expects the cap to reset at midnight. Documented here for the day a real use case appears.
  2. localStorage instead of a DB column — the cap is optional and informational; persisting per-project in localStorage avoids a migration for a feature the spec says is opt-in. Move to a project column if the cap ever becomes load-bearing.
- **Resolution**: drift accepted. E4 ships:
  - `lib/cost-ceiling/index.ts`: pure `evaluate(spent, cap) → {state: off|ok|warn|stop, percent, message}`. Default state is "off" (matches spec §6). Soft warn at ≥50%, hard stop at ≥100%. 22 unit tests cover thresholds + storage helpers.
  - Dashboard footer: small `<input type="number">` for the cap (USD); persisted via the localStorage helpers.
  - Above-tail Alert renders when state is "warn" (default variant) or "stop" (destructive variant).
  - Start build button disabled when state is "stop" — the only enforcement, novice-opt-in only.
- **Commit**: 51af9f3 (E4 commit).
- **Follow-up**: when a real use case appears for a day-rolled cap, add `costs.sumByProjectSince(projectId, sinceTs)` and pass the start of the local day; no other code changes needed.

### D-017 — E3 ships updater wiring with placeholder pubkey + endpoint (Phase E0 deferred)
- **Drift type**: scope drift (deferral, against [docs/build-order.md](build-order.md) E3 + [spec.md](../spec.md) Flow J).
- **Discovered at**: E3.
- **Cause**: Phase E0 (Apple Developer ID + Windows code-signing cert + Tauri updater keypair) is deferred per human direction 2026-04-25 — the actual signing artefacts haven't been provisioned, so we have no real `pubkey` to put in `tauri.conf.json` and no signed feed to point `endpoints` at. Building the updater UI + wiring without those is the right move (so when E0 lands the user just swaps two strings in `tauri.conf.json` rather than re-architecting).
- **Resolution**: drift accepted. E3 ships:
  - `tauri-plugin-updater = "2"` Cargo dep + matching `@tauri-apps/plugin-updater` 2.9.0 npm dep.
  - Plugin registered in `lib.rs` setup; `updater:default` capability added.
  - `lib/updater/index.ts` wraps `check()` + `downloadAndInstall()` with neverthrow; recognises the placeholder-pubkey error and translates it into a `NotConfigured` error variant; `checkForUpdateQuiet()` swallows that variant so the launch flow doesn't nag the novice until the real keypair lands.
  - `<UpdatePrompt>` component renders the prompt per Flow J AC2; runs on Welcome page mount.
  - `tauri.conf.json` plugins.updater config has placeholder pubkey `REPLACE_WITH_TAURI_SIGNER_PUBKEY_FROM_PHASE_E0` and endpoint `https://updates.airtec.example/builder/...`.
- **Commit**: bc2ed73 (E3 commit).
- **Follow-up**: when Phase E0 ships:
  1. Run `corepack pnpm tauri signer generate` to produce a keypair.
  2. Replace the `pubkey` in `tauri.conf.json` with the public half.
  3. Replace the `endpoints` URL with the real GitHub Releases / S3 / etc. feed.
  4. Add the private key to GitHub Actions secrets as `TAURI_SIGNING_PRIVATE_KEY` (per E0.3 in build-order).
  No code changes required.

### D-016 — Live-tail latency budget (Flow F AC2 < 200ms) is unverified
- **Drift type**: nfr drift (verification gap, against [spec.md](../spec.md) §6 + Flow F AC2).
- **Discovered at**: Phase D boundary self-check.
- **Cause**: the dashboard achieves sub-200ms perceived latency via optimistic rendering (the live-tail row appears immediately on the orchestrator's `tool_use` event; the sidecar's `actions.append` write happens in parallel and is not awaited). No Vitest performance harness asserts this.
- **Resolution**: drift accepted. The design path is correct (the slow part — file write — is off the critical path) but the budget is unverified.
- **Commit**: de3b0eb (Phase D boundary commit).
- **Follow-up**: Phase E ticket adds a Vitest perf harness that fires N synthetic orchestrator events and asserts the time from event arrival to `actions.length` increment is < 200ms p95.

### D-015 — D5/D6 follow-ups: orchestrator-side report_drift + phase_complete tools, echo-back modal, "task N" recovery suffix
- **Drift type**: scope drift (deferrals, against [docs/build-order.md](build-order.md) D5 second bullet + spec.md Flows E AC1 / F AC5 / H AC4).
- **Discovered at**: Phase D boundary self-check.
- **Cause**: D5 originally scoped to ship the drift banner UI + the drift_events table + drift-log writer (the load-bearing AC) as a single < 400-line slice (binding rule 9). The orchestrator-side automation (report_drift MCP tool + phase_complete marker) was deferred so the slice fit. Same shape applies to Flow E AC1's echo-back modal (deferred under "phase boundary modal" wording) and Flow H AC4's "task N" suffix (depends on F AC5's phase markers, so can't ship before them).
- **Resolution**: drift accepted. The dev "Inject drift" button (now NODE_ENV-guarded as of this audit) gives us manual AC coverage. Phase E follow-up wires:
  - Sidecar SDK tools/callbacks exposing `report_drift({phase, kind, description})` and `phase_complete({phase, summary})` semantics.
  - The orchestrator registers those tools/callbacks through the Claude Agent SDK session.
  - The kickoff prompt instructs claude to call `phase_complete` at phase boundaries and `report_drift` whenever its `/recheck` finds blocker drift.
  - The dashboard shows the echo-back modal on `phase_complete`; the recovered-from-crash banner gains the "resumed at task N" suffix using the latest `phase` from state.json.
- **Commit**: de3b0eb (Phase D boundary commit).
- **Follow-up**: Phase E ticket per the above.
- **2026-04-28 update**: the final echo-back/readiness portion is closed in Phase F. Orchestrator-side `report_drift`, `phase_complete`, and richer recovered-at-task markers remain follow-ups.

### D-014 — D4 ETA observed at TURN granularity, not per-task
- **Drift type**: implementation drift (against [docs/build-order.md](build-order.md) D4: "kit section 14.5.3 estimator with median, P90, online updates").
- **Discovered at**: D4.
- **Cause**: the kit's estimator wants per-task-id observations so the dashboard can say "remaining tasks × per-task estimate". The orchestrator does not yet emit phase/task markers in the SDK stream (D5/Future phase-marker work wires those). Building a per-task estimator now would have nothing to estimate against; building a per-turn estimator now gives the novice live feedback ("a turn takes ~2 min on this build") and is the correct primitive for the per-task estimator on top.
- **Resolution**: drift accepted. D4 ships `lib/eta` as a pure (observations[], elapsedMs) → {median, p90, mode} estimator with full mode transitions (estimating → normal → past_p90) and the honesty fallback. The dashboard records one observation per claude `result.success` event (= one per turn) and labels the footer as "ETA per turn". When D5 wires phase markers, change the observation source from `done` events to `phase_complete` markers; the estimator function does not change.
- **Commit**: 340bd7a (D4 commit).
- **Follow-up**: D5 swaps the observation source. No schema change needed (per-turn durations are kept in component state; the persisted `actions` rows already carry the timestamps for any future per-task derivation).

### D-013 — Chat-message + answer-merging side effects + PII confirm modal deferred from C8
- **Drift type**: scope drift (deferral, against the C8 plan in [docs/build-order.md](build-order.md) section 14.4.2: "after a file lands, ingest it... post a chat message confirming what we extracted; pause-and-ask if PII detected").
- **Discovered at**: C8.
- **Cause**: build-order's C8 covers four loosely-coupled responsibilities: (1) save the file to `{project}/inputs/`, (2) dispatch to the right sidecar handler by kind and run the PII guard, (3) inject a synthetic chat message ("I see you uploaded X — should I proceed on that basis?") that the orchestrator can answer-merge into the spec, (4) render a PII confirmation modal blocking next-send when the guard flags content. Items (3) and (4) each require new wiring: (3) needs a "system message injection" path through `chat_send` plus a way for the interview's `record_answer` flow to consume the file's summary as if the novice had typed it; (4) needs a Radix Dialog with focus trap + masked-hits preview + "send anyway / replace" actions. Both add real surface area beyond the C2-C7 pipeline already shipped.
- **Resolution**: drift accepted. C8 ships items (1) and (2): `lib/files/ingest.ts::ingestFile` saves via the new `file_save_uploaded` Tauri command, dispatches by `IngestedFileKind`, runs `files.guardPii` on extracted text, and returns `{ summary, hasPiiWarning, storedPath }` to the file panel. The summary + PII warning render inline in the file row (status icon flips to a yellow `AlertTriangle` when `hasPiiWarning === true`). The file panel surfaces what was extracted; the chat-message injection and modal-confirm flows land later.
- **Commit**: a0c1c27 (C8 commit).
- **Follow-up**: Phase D ticket adds (a) a `chat.injectSystemMessage` path that posts a "I see you uploaded {name}: {summary}. Proceed on that basis?" message into the interview turn list, route the novice's yes/no through `record_answer` so the file's content lands in the spec; (b) a `<PiiConfirmDialog>` Radix Dialog gated on `files.some(f => f.hasPiiWarning)` that blocks the next chat send until the novice confirms, with a "redact and send" path that swaps in the synthetic-redacted text returned by `files.guardPii`.
- **2026-04-28 update**: Phase F closes the novice-approval and PII-blocking parts. The approved summary is injected into `spec.md` section 0 instead of auto-merging extracted answers. Persistent DB-backed approval state remains a follow-up.

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

### D-010 — Image vision integration tests deferred from C3 (mock-server infra needed)
- **Drift type**: scope drift (deferral, against the C3 plan in [docs/build-order.md](build-order.md): "round-trip a fixture wireframe; summary mentions the visible elements").
- **Discovered at**: C3.
- **Cause**: the `summariseImage` handler is a three-tier fallback (claude CLI -> Anthropic Messages API -> DeepSeek API per the human's 2026-04-26 direction). Testing the CLI tier in isolation needs a fixture `claude` binary on a per-test PATH that returns a controllable JSON response; testing the API tiers cleanly without spending real money or leaking keys needs a local HTTP mock server that pretends to be `api.anthropic.com` and `api.deepseek.com`. Both are doable but each is its own initiative — out of scope for C3 alongside writing the handler itself.
- **Resolution**: drift accepted. C3 ships:
  - `summariseImage` handler with all three tiers implemented and registered in the sidecar (`files.summariseImage`).
  - Clear error path when all tiers fail, telling the user which env vars to set.
  - Manual verification by the user: drop an image into the file panel (once C8 wires the upload flow), check that a summary comes back via whichever tier their machine has.
- **Commit**: 85fbb25 (C3 commit).
- **Follow-up**: Phase D ticket adds (a) a fixture `claude` binary that returns a fixed JSON response, used by Vitest with PATH override; (b) a Vitest setup that intercepts `fetch` to api.anthropic.com / api.deepseek.com and returns canned responses; then 3 tests covering each tier's success path plus the all-fail error message.

### D-012 — Playwright screenshot path for fetchUrl deferred from C6
- **Drift type**: scope drift (deferral, against the C6 plan in [docs/build-order.md](build-order.md): "Headless browser via Playwright; capture homepage screenshot and one inner page. Pass to image vision pipeline.").
- **Discovered at**: C6.
- **Cause**: spinning a headless Chromium in the sidecar adds 250+MB of browser binaries, ~2s of cold-boot per page, and a meaningful packaging burden for production installers (Phase E concern). For the common case of "novice drops a reference URL into the file panel", the textual extraction (title, meta description, h1/h2 outline, body snippet) is enough to seed the chat with context.
- **Resolution**: drift accepted. C6 ships `files.fetchUrl({url})` with HTML fetch + node-html-parser extraction. Returns title, og:description (preferred) or meta description (fallback), up to 10 h1/h2 headings, and a 600-char body snippet (script/style/svg stripped). No screenshot, no JS rendering. The image-vision pipeline at C3 stays available for the screenshot path if/when we wire it.
- **Commit**: 470da84 (C6 commit).
- **Follow-up**: Phase D / E task to add Playwright with `browser-fetch` + screenshot output; route through `files.summariseImage` (C3) for the visual half. Likely valuable when the kit's question library starts asking for "design references" or similar.

### D-011 — SQL-dump data extraction deferred from C5
- **Drift type**: scope drift (deferral, against the C5 plan in [docs/build-order.md](build-order.md): "Data sample (CSV, JSON, SQL dump)").
- **Discovered at**: C5.
- **Cause**: SQL dumps mix CREATE TABLE statements (already handled by `files.parseSchema` at C4) with INSERT row data. Extracting inserted values requires either a full SQL parser pass over potentially large dumps or a streaming `INSERT` regex with column-order tracking; both add real complexity without a clear novice use case for v1.
- **Resolution**: drift accepted. C5 ships CSV (and TSV) + JSON-array-of-objects via `files.parseDataSample`. SQL dumps continue to route to `files.parseSchema` for the schema half; the row data half is deferred. The error message in `parseDataSample` for unsupported extensions explicitly points at this drift entry.
- **Commit**: eb1572f (C5 commit).
- **Follow-up**: when the kit's question library starts asking for sample data shape, reassess. Likely a Phase D / E task once a real novice use case appears.

### D-009 — DOCX + PDF extraction integration tests deferred from C2 (binary fixtures missing)
- **Drift type**: scope drift (deferral, against the C2 plan in [docs/build-order.md](build-order.md): "round-trip a fixture PRD; extracted text contains expected paragraphs").
- **Discovered at**: C2.
- **Cause**: the extractor handler at `sidecar/src/handlers/files.ts` implements all four formats (PDF via unpdf, DOCX via mammoth, MD + TXT via direct read), but there are no real PDF or DOCX fixtures in the repo. Generating minimal valid PDFs/DOCX inline in tests is fiddly (PDFs are byte-precise; DOCX is a multi-file ZIP); checking in real binary fixtures bloats the repo without a clear governance for what they should contain.
- **Resolution**: drift accepted. C2 ships:
  - DOCX + PDF extractors implemented and ready to use.
  - MD + TXT round-trip integration tests against `tests/fixtures/sample.md` and `sample.txt` (5 tests including unsupported-extension + missing-path + summary-bounded behaviour).
  - DOCX + PDF round-trip integration tests deferred until binary fixtures are sourced (e.g. a 1-page sample PDF + 1-page DOCX checked into `tests/fixtures/`).
- **Commit**: 3c7aa4e (C2 commit).
- **Follow-up**: source small (~5 KB each) sample.pdf + sample.docx fixtures, add 2-3 tests asserting expected paragraph content. Could be done at C8 (ingestion contract UI) when real files start landing in `{project}/inputs/` end-to-end.

### D-008 — Promptfoo eval suite for the interview prompt deferred from B5
- **Drift type**: scope drift (deferral, against the B5 plan in [docs/build-order.md](build-order.md)).
- **Discovered at**: B5.
- **Cause**: build-order's B5 says "Eval: a Promptfoo suite with 12 fixture conversations asserts on follow-up presence and 'you choose' handling." Promptfoo is its own infra setup (config, fixtures, CI hookup) and the assertions need a fixed model + reproducible fixtures. Combined with the current absence of the kit's authoritative question phrasing (D-005), an eval suite written today would lock in placeholder behaviour.
- **Resolution**: drift accepted. B5 ships the upgraded interview system prompt directly in `src-tauri/src/chat.rs::INTERVIEW_SYSTEM_PROMPT` covering the four behaviours called out in build-order (one-question-per-turn, follow-ups on vague/contradictory/high-stakes, 'you choose' default-application, topic counter). The Promptfoo suite lands in a Phase D quality task once D-005 is closed (real question phrasing in place) and we've picked a fixed eval model.
- **Commit**: fdfc445 (B5+B6 commit).
- **Follow-up**: Phase D task to add `evals/` with the 12 fixture conversations + `corepack pnpm eval` script.
- **2026-04-28 update**: the live interview prompt/tool path now lives in `sidecar/src/chat-driver.ts` per ADR-0005. The Promptfoo-style eval suite is still deferred.

### D-007 — Spec-preview diff highlighting deferred from B4
- **Drift type**: scope drift (deferral, against the B4 plan in [docs/build-order.md](build-order.md)).
- **Discovered at**: B4.
- **Cause**: build-order's B4 says "Use a Markdown renderer that highlights diffs between renders." Two non-trivial pieces: pick + integrate a Markdown renderer (react-markdown + sanitiser, or remark/rehype pipeline), and compute + render diffs (diff-match-patch or similar, scoped per section). Either alone is fine; both at once for B4 stretches the task. Both are presentation polish, not behaviour.
- **Resolution**: drift accepted. B4 ships the spec preview as monospaced `<pre>`-rendered raw markdown that updates after every chat turn (which is the load-bearing part: "preview reflects current spec"). Markdown rendering and diff highlighting land in a Phase D polish task.
- **Commit**: d61c66f (B4 commit).
- **Follow-up**: Phase D ticket adds react-markdown + a small section-level diff that flashes changed sections for ~3s, per the spec's UX intent.

### D-006 — `.builder/answers.json` legacy file mirror skipped
- **Drift type**: implementation drift (against [docs/build-order.md](build-order.md) B2 wording: "On tool call, the MCP handler writes to `.builder/answers.json` and appends to the answers table.").
- **Discovered at**: B2.
- **Cause**: the build-order calls for double-writing answers to both `.builder/answers.json` and the SQLite `answers` table. The JSON file is a legacy format from the original design pack (used as a portable record). With the sidecar + Drizzle + ULID architecture per ADR-0004, the DB row is the source of truth: it has FK to projects, ordered timestamps, and confidence/source enums. A JSON-file mirror would need careful concurrency handling (two processes writing to the same file) and adds a second source of truth that can drift from the DB.
- **Resolution**: drift accepted. Source of truth is the DB. If a portable JSON export is needed later (e.g. for a "show me my answers" view, or for spec-rebuild input), expose an `answers.exportJson` sidecar method that derives it from the table on demand.
- **Commit**: 163677d (B2 commit).
- **Follow-up**: add the `answers.exportJson` derivation in B3 if the spec-rebuild step needs the JSON shape.

### D-005 — Question library + decision table + spec template seeded as inferred placeholders (extended at B3)
- **Drift type**: scope drift (placeholder content, against the B1 plan in [docs/build-order.md](build-order.md)).
- **Discovered at**: B1, extended at B3.
- **Cause**: the build-order's B1 reads "Copy the kit's question library and decision table into `lib/interview/library.ts` as typed data". B3 extends the same gap: "rebuilds spec.md ... using the kit's spec template" — that template is also missing. The original Build Spec Kit's authoritative content has not been sourced into this repo. Same pattern as the placeholder templates at A4c (per human direction 2026-04-25 to defer real content).
- **Resolution**: drift accepted. `lib/interview/library.ts` ships 32 fast-path questions whose **ids and topics** are taken from `.builder/answers.json` plus the Phase F added app-shape questions (Q29-Q32), but whose **exact prompt strings** are inferred placeholder phrasing. Decision table is a thin starter set covering the most obvious mappings (PII, accessibility, webhooks, jobs, i18n). At B3, `lib/interview/rebuild-spec.ts` ships a section emitter set that mirrors the Builder's own spec.md as a stand-in for the kit's authoritative spec template; the function is pure, deterministic, and snapshot-tested against three fixture answer sets (minimal, partial, full). When the kit is sourced, replace prompt strings + extend decision table + swap section emitters; tests should pass without schema changes.
- **Commits**: a534bd5 (B1), 163677d-ish (B3 extends).
- **Follow-up**: when the kit is sourced, replace `prompt` strings and extend the decision table; tests should still pass without schema changes.

### D-004 — Tauri-context E2E + integration tests deferred to Phase D (extended at A5)
- **Drift type**: scope drift (deferral, against the A3 + A5 plans in [docs/build-order.md](build-order.md)).
- **Discovered at**: A3, extended at A5.
- **Cause**: tests that exercise the real Tauri webview (Welcome E2E from A3, chat smoke E2E from A5, rate-limit integration test from A5) all need `tauri-driver` (a separate setup) or full webview/IPC mocking, both of which are larger than fit inside the originating tasks. The "stubbed `claude` binary on PATH" part is straightforward (a small shell script); the harness around it is the work.
- **Resolution**: drift accepted across both tasks. The logical surface is covered by smaller-scope tests with mocked boundaries:
  - A3: 7 unit tests in `lib/cli-detection/index.test.ts` cover all three Welcome states with `invoke` mocked.
  - A5: historical Rust parser tests in `src-tauri/src/chat.rs` covered the earlier stream-json path; current live chat coverage should target `sidecar/src/chat-driver.ts` and the Channel-based wrapper.
  Real-binary E2E and rate-limit integration land in Phase D when `tauri-driver` is set up.
- **Commits**: 81bbc66 (A3 origin); A5 extends scope (this commit).
- **Follow-up**: Phase D ticket to install `tauri-driver` + fixture `claude` binary, write:
  - `tests/e2e/welcome.spec.ts` covering all three Welcome states.
  - `tests/e2e/chat-smoke.spec.ts` for the happy chat path.
  - `tests/integration/chat-rate-limit.test.ts` for the rate-limit path with a stubbed `claude` returning the rate-limit error.
