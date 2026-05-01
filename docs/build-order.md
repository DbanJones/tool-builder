# Build order

This file decomposes the spec.md section 7 phased plan into agent-executable tasks. The agent reads it at the start of every session and executes the next incomplete task. Each task lists its acceptance criteria, the tests that prove it, and the kit rules it must satisfy.

## Current implementation note

The base Phase A-E plan has shipped. The Phase F hardening pass supersedes several earlier transport and novice-safety details:
- Interview chat and build orchestration both use the Claude Agent SDK in the Node sidecar; the `claude` CLI remains the auth prerequisite only.
- Runtime interview answers live in the SQLite `answers` table. `.builder/answers.json` is a legacy seed/reference file.
- Readiness requires all 35 fast-path questions plus final echo-back confirmation. (Q33-Q35 added in D-023 to anchor the build to a concrete deliverable artifact, named reference tools, and explicit non-negotiables.)
- File ingestion requires novice approval, blocks on PII review, and injects approved summaries into `spec.md` section 0 as source material.
- Stop/cancel targets the active stream/project, with an all-streams fallback.
- Commands should use `corepack pnpm ...` so nested scripts work in Corepack-only shells.

## Convention
- Tasks are atomic: one logical change, under 400 lines of diff, all tests passing at the end.
- Every task is gated by Echo-back before code is written.
- Every phase is gated by the rules/07-self-check.md protocol before declaring complete.
- Every approved task updates `.builder/state.json`.

## Phase 0: Pre-flight (human-driven, not in the self-drive loop)

Phase 0 sits outside the agent's per-task loop. The human completes these before the agent begins A1, because they unblock the session-start protocol in CLAUDE.md binding rule 12 and the long-lead procurement that gates Phase E.

### 0.1: Pack laid out on disk
- The `.claude/commands/`, `.claude/agents/`, and `.builder/` directories from the design pack live in the project root.
- AC: `ls .builder/state.json .claude/commands/recheck.md .claude/agents/researcher.md` returns all three with no errors.

### 0.2: Machine prerequisites
- Node 22.x with Corepack enabled; pnpm 9.x is run through `corepack pnpm`.
- Rust stable toolchain installed via `rustup`.
- Xcode Command Line Tools installed (macOS).
- `gh` CLI installed and authenticated against the human's GitHub account.
- Claude Code CLI (`claude`) installed and authenticated (Pro / Max subscription or API key configured inside the CLI). See ADR-0002.
- AC: `node -v`, `corepack pnpm --version`, `rustc --version`, `gh auth status`, `claude --version` all succeed.

### 0.3: Open questions resolved
- The three open questions in `.builder/state.json` have explicit answers, recorded in `docs/decisions.md` even when the answer matches the default.
- AC: `state.json` `open_questions` array is empty; `docs/decisions.md` exists with one entry per resolved question.

### 0.4: git initialised
- `git init` run in the project root.
- `.gitignore` includes `node_modules/`, `.builder/builder.db`, `.builder/snapshots/`, `.builder/history.log`, `.next/`, `target/`, `dist/`, `.env.local`.
- AC: `git log` shows at least one commit on the design pack baseline.

### Phase 0 definition of done
- All four tasks above passing.
- The agent can start a session, read `state.json`, and begin A1's Echo-back without errors.

## Phase A: Tauri shell and minimum viable chat

### A1: Repo scaffold and CI
- Initialise the repo with Next.js 15 + TypeScript strict + Tailwind + shadcn/ui.
- Add Tauri 2 with `corepack pnpm tauri init`.
- Add `verify` script (typecheck + lint + unit + integration), run through `corepack pnpm verify`.
- Add GitHub Actions workflow with required checks.
- AC: `corepack pnpm verify` is green on a clean clone; `corepack pnpm tauri dev` opens an empty window with the Next.js dev server.

### A2: OS keychain wrapper (Vercel and future credentials only, per ADR-0002 and ADR-0003)
- Implement `lib/keychain/index.ts` with `get`, `set`, `delete` for namespaced secrets, returning `Result<T, KeychainError>` per C10.
- Backend: the `keyring` Rust crate inside the Tauri shell (`src-tauri/src/lib.rs`), exposed to the webview via three Tauri IPC commands (`keychain_get/set/delete`). See ADR-0003 for the choice of `keyring-rs` over `keytar` plus Node sidecar.
- Tests: unit tests with a mocked `invoke()`; real-keychain round-trip (touching macOS Keychain / Windows Credential Manager / Linux Secret Service) is deferred to a Phase-D follow-up that adds macOS + Windows CI runners.
- AC: a test harness can set, retrieve, and delete a secret without writing it to disk anywhere (proven by unit tests for the wrapper contract, plus `cargo check` for the Rust commands).
- Note: the Builder does not store Anthropic credentials. The wrapper is reserved for the Vercel access token at E1 and any future third-party credential.

### A3: Welcome screen and Claude Code detection (per ADR-0002)
- Build `app/(welcome)/page.tsx` with three states: CLI missing, CLI not authenticated, CLI ready.
- Detect via Tauri shell command: `which claude && claude --version`.
- Detect auth via a one-shot probe: `claude -p "ping" --output-format json` and read the response or error.
- On "missing": show "Install Claude Code" with link to the canonical install URL and instructions; user cannot advance.
- On "not authenticated": show "Sign in to Claude Code" with link and instructions; user cannot advance.
- On "ready": route to project creation.
- AC: Flow A passes end to end across all three states; the Builder stores no Anthropic credential.
- E2E: `tests/e2e/welcome.spec.ts` covers all three states using a stubbed `claude` binary on PATH.

### A4: Project creation (split per ADR-0004 + decision 2026-04-25 to ship placeholder templates)

A4 is split across three sub-tasks because the Node-sidecar architecture chosen at A4 entry adds enough machinery that it deserves its own commit before the project-creation flow is built on top.

#### A4a: Sidecar foundation
- New `sidecar/` package: `package.json`, `tsconfig.json`, JSON-RPC loop with one `ping` method.
- `src-tauri/src/sidecar.rs`: process lifecycle (spawn on Tauri setup, kill on drop), `sidecar_rpc(method, params)` Tauri command synchronised by a `Mutex<SidecarHandle>`.
- `lib/sidecar/client.ts`: typed RPC wrapper returning `ResultAsync<T, SidecarError>`.
- Build orchestration: `tauri.conf.json` `beforeDevCommand` builds the sidecar before `next dev` starts.
- AC: `corepack pnpm verify` and `cargo check` both green; `corepack pnpm tauri dev` opens the Tauri window and `client.ping()` returns `{ pong: true }`.

#### A4b: DB schemas + handlers + audit migration
- `sidecar/src/db.ts`: better-sqlite3 + Drizzle setup against `.builder/builder.db`.
- `sidecar/src/schema/{projects,audit-log}.ts`: per spec.md §4 data model.
- `sidecar/drizzle.config.ts` + first migration in `sidecar/migrations/`.
- Sidecar handlers for `audit.logEvent`, `projects.create`, `projects.list`, `projects.get`, `projects.delete`.
- Migrate `audit_log_event` Tauri command to call the sidecar's `audit.logEvent` instead of `tauri-plugin-log` (closes drift D-003).
- AC: integration test loads the sidecar, runs the migration against a temp DB, inserts and reads back, asserts schema; `corepack pnpm verify` green.

#### A4c: Project creation flow
- `app/(welcome)/new-project/page.tsx`: react-hook-form + zodResolver per F21, name + folder fields.
- Validate name against npm naming rules (`validate-npm-package-name`).
- `project_create` Tauri command: validates input, mkdir `{folder}/{name}/`, runs `git init`, copies placeholder templates from `src-tauri/templates/`, calls sidecar `projects.create` and `audit.logEvent("project_created", ...)`.
- Placeholder templates in `src-tauri/templates/` (per human direction 2026-04-25 to defer real template content; placeholder files clearly state they are placeholders and must be replaced before novice use).
- AC: Flow B AC1-AC4 pass end to end.
- Integration: `tests/integration/project-create.test.ts` exercises the full flow against a temp directory and a fresh sidecar against a temp DB.

### A5: Minimum chat (per ADR-0002)
- Build `app/(interview)/page.tsx` with chat panel, input, send button.
- Wire to the sidecar chat stream. The current implementation uses the Claude Agent SDK per ADR-0005; the historical CLI stream-json path is superseded.
- Stream assistant events as they arrive; render assistant tokens as they stream.
- No `record_answer` tool yet; spec.md is not yet rebuilt from answers.
- Implement basic rate-limit handling: if the SDK/CLI auth backend returns a rate-limit error, show "Claude is rate-limited; try again at HH:MM" and disable the send button until then.
- AC: novice can chat with Claude inside the Builder window; the rate-limit message renders correctly when Claude returns a rate-limit error.
- E2E: `tests/e2e/chat-smoke.spec.ts` exercises the happy path; an integration test exercises the rate-limit path with a stubbed `claude` returning the rate-limit error.

### Phase A definition of done
- Flows A and B fully pass.
- Tester can chat freely with Claude in the Builder.
- Signed installers exist for Mac, Windows, Linux.
- `corepack pnpm verify` and `corepack pnpm e2e` both green.
- `/recheck` reports zero blocker drift.

## Phase B: Recursive interview, question library, decision table

### B1: Bring the question library into the repo
- Copy the kit's question library and decision table into `lib/interview/library.ts` as typed data.
- AC: a unit test loads the library and asserts question count, fast-path subset, and that every decision-table entry references a real rule id.

### B2: The `record_answer` tool via sidecar SDK tools (per ADR-0005)
- Define the tool per kit section 14.3.1.
- Host the tool in the Node sidecar's chat driver, validating `question_id` against Q1-Q35.
- On tool call, the handler appends to the `answers` table; `.builder/answers.json` is not a runtime mirror.
- AC: when Claude calls `record_answer` mid-conversation, the DB updates and the chat continues without the novice seeing the tool call.
- Integration: assert tool call is delivered through the sidecar SDK driver, parsed, validated, and persisted.

### B3: Spec rebuild from answers
- Build `lib/interview/rebuild-spec.ts` that takes answer rows and produces `spec.md` using the kit's spec template and decision table.
- AC: given a fixture answer set representing a worked example, the rebuilt `spec.md` matches the expected output byte-for-byte.
- Unit: snapshot test on three fixture answer sets.

### B4: Live spec preview panel
- Add the right-hand panel that re-renders `spec.md` after each `record_answer`.
- Use a Markdown renderer that highlights diffs between renders.
- AC: spec preview updates within 500ms of an answer being recorded; diff highlighting visible for 3 seconds.

### B5: Recursive prompt construction
- Replace the Phase A hardcoded prompt with the kit section 14.3.1 system prompt: instruct Claude to follow up on vague, contradictory, or high-stakes answers with no depth limit; close branches when the novice says "you choose"; surface a topic counter.
- AC: the three example dialogues in kit section 14.3.2 (vague, contradiction, high-stakes) can be reproduced in a manual test.
- Eval: a Promptfoo suite with 12 fixture conversations asserts on follow-up presence and "you choose" handling.

### B6: Ready-to-build gating
- Implement the kit section 14.3.5 readiness check: 35 fast-path questions answered, all activated high-stakes questions answered, final echo-back confirmed.
- The Start build button is disabled until ready; tooltip explains what is needed.
- AC: button is correctly enabled and disabled across the test cases in `tests/integration/readiness.test.ts`.

### Phase B definition of done
- Flow C fully passes.
- Tester can produce a fast-path-complete spec by chatting alone.
- `/recheck` reports zero blocker drift.

## Phase C: File ingestion

### C1: File panel UI
- Drag-and-drop strip at the bottom of the interview screen.
- Lists uploaded files with name, type, status, summary.

### C2: Text extraction (DOCX, PDF, MD, TXT)
- Use `mammoth` for DOCX, `pdf-parse` for PDF text, native for MD and TXT.
- AC: round-trip a fixture PRD; extracted text contains expected paragraphs.

### C3: Image vision (PNG, JPG, PDF-as-image)
- Send to Claude Sonnet vision; ask for a structured summary of UI elements, layout, copy.
- AC: round-trip a fixture wireframe; summary mentions the visible elements.

### C4: Schema parse (SQL, JSON Schema, OpenAPI)
- Use `pg-query-emscripten` for SQL DDL, `ajv` for JSON Schema, `swagger-parser` for OpenAPI.
- Output a normalised schema description.

### C5: Data sample (CSV, JSON, SQL dump)
- Validate; sample first 100 rows; infer column types.
- AC: a sample CSV produces a candidate Drizzle schema.

### C6: Reference URL fetch
- Headless browser via Playwright; capture homepage screenshot and one inner page.
- Pass to image vision pipeline.
- AC: a fixture URL produces a screenshot pair and a summary.

### C7: PII guard
- Implement kit section 14.4.4: regex-detect emails, phone numbers, addresses; if matched, halt and ask the novice; replace values with synthetic equivalents before any Claude call.
- AC: a fixture file with synthetic PII triggers the guard; the novice's "OK" allows shape-only processing.

### C8: Ingestion contract UI
- After extraction, show the kit section 14.4.2 three-step flow in chat: acknowledge, summarise, confirm.
- If PII is detected, block the next chat/build action until the novice reviews or skips the file; use redacted summary text for any onward prompt.
- On confirm, mark the file summary as approved source material with `confidence: tentative` and include it in generated `spec.md` section 0. Do not silently create interview answers.

### Phase C definition of done
- Flow D fully passes for all six file types.
- Uploaded files appear in `{project}/inputs/` and in `spec.md` section 0.
- `/recheck` reports zero blocker drift.

## Phase D: Build dashboard

### D1: Starting Claude Code through the SDK sidecar
- Use the Claude Agent SDK in the Node sidecar to start Claude Code in the project folder.
- Capture SDK messages, stderr diagnostics, and tool-call events.
- AC: Claude Code starts, reads CLAUDE.md, and emits a Plan block within 30 seconds.

### D2: Tool-call parsing and human translation
- Parse every tool call event into a `(tool, raw_input, human_line)` triple.
- Translation table per kit section 14.5.2 lives in `lib/orchestrator/translate.ts`.
- Append to `actions` table and `history.log`.

### D3: Dashboard layout
- Build the kit section 14.5.1 layout: header, phase bar, task lanes, live tail, status footer.
- Wire to live state from the orchestrator.
- AC: opening a paused project shows the dashboard with all regions populated from `state.json` and `history.log`.

### D4: ETA and cost meter
- Implement the kit section 14.5.3 estimator with median, P90, online updates, and the past-P90 honesty fallback.
- Cost meter sums the `costs` table and shows in novice's local currency.

### D5: Approval gates
- Phase boundary modal per kit section 14.5.4 step 1.
- Drift banner per kit section 14.5.4 step 2, hooked to `/recheck` results.
- AC: a forced drift event triggers the banner; novice's choice writes to `drift-log.md` and resumes correctly.

### D6: Pause, resume, stop, crash recovery
- Implement Flow H: pause finishes current tool call then halts; resume reads state and continues; stop cancels the active SDK stream by stream/project id; crash recovery reads `state.json` on app open.
- Tests: integration test that kills the orchestrator mid-task and asserts recovery on next launch.

### Phase D definition of done
- Flows F, G, H fully pass.
- A tester can run a full Phase 1 build of a target app from inside the Builder.
- ETA stays within P90 in 8 of 10 reference builds.
- `/recheck` reports zero blocker drift.

## Phase E: Deploy, export, polish, ship

### E1: Vercel deploy
- Capture Vercel access token via the same secure modal pattern as other third-party credentials.
- Run `vercel deploy` from the project folder; stream output to the live tail.
- Run smoke E2E against the preview URL.
- Copy URL to clipboard.
- AC: Flow I passes for the worked example.

### E2: GitHub export
- Use the bundled `gh` CLI: create a private repo, push, return URL.
- AC: a project folder is pushed to a private GitHub repo with intact history.

### E3: Auto-update
- Configure Tauri updater with a signed feed.
- AC: a test feed with a higher version triggers the update flow on app launch.

### E4: Cost ceiling
- Implement the optional per-project spend cap from spec.md section 6 NFR: soft warn at 50 percent, hard stop at 100 percent when the novice sets a cap.

### E5: Sentry opt-in
- One-time prompt after first successful build.

### E6: Marketing site
- A one-page Next.js site at `apps/marketing/` with download links and a 90-second screen recording.

### Phase E definition of done
- Flows A through J fully pass.
- Signed installers downloadable from the marketing site.
- Three external testers complete a build without intervention.
- `/recheck` reports zero blocker drift; `drift-log.md` is reviewed and clean.

## Phase F: Novice-ready hardening

Phase F is the post-review hardening pass for the eight recommendations surfaced in the codebase review. It focuses on structure, novice safety, and making the generated end product easier to reach without developer intervention.

### F1: Unify chat and build on the SDK sidecar
- Move interview chat and build orchestration to the Claude Agent SDK in the Node sidecar.
- Keep `claude` CLI detection/auth as the first-run prerequisite.
- AC: chat and build both stream through sidecar JSON-RPC notifications; ADR-0005 reflects the architecture.

### F2: Make Stop reliable
- Track active runs by stream id and project id.
- `orchestrator.stop` accepts stream id, project id, or cancels all as a fallback.
- AC: the Build dashboard Stop button cancels the active project run.

### F3: Add final readiness and echo-back gating
- Persist the novice's "Looks right" confirmation per project.
- Disable Start build until all required questions are answered and the final echo-back is confirmed.
- AC: direct Start build and chat-intent build requests both respect the readiness result.

### F4: Validate interview question ids
- Define the allowed Q1-Q35 id set in one sidecar module.
- Validate `record_answer.question_id` and `queue_questions.items[].id` against that set.
- AC: invalid ids are rejected before they can pollute the answers table.

### F5: Require file approval and PII review
- Add approved/pending file state in the workspace.
- Block chat/build when a PII warning is pending review.
- AC: the novice must approve, skip, or review flagged files before the file content informs the spec.

### F6: Carry approved source materials into the spec
- Prepend approved file summaries to generated `spec.md` section 0.
- Use redacted PII summaries when PII was detected.
- AC: approved uploads appear as source material in the spec preview and saved spec.

### F7: Harden novice project templates and package scripts
- Replace placeholder target-app rules with concrete build rules.
- Use `corepack pnpm` in scripts that spawn nested pnpm commands.
- AC: `corepack pnpm verify` works in a Corepack-only shell.

### F8: Refresh docs and traceability
- Update README, CLAUDE.md, spec.md, ADRs, build-order, drift log, runbook, and generated target-app template docs.
- AC: Markdown no longer describes the old API-key, stream-json, answers.json, or unreviewed-file behaviours as current.

## Phase E0: Signing and updater procurement (deferred)

E0 runs in parallel with Phases A through D and must complete before E3 (auto-update) can ship. **Currently deferred per human direction on 2026-04-25.** When the human is ready to proceed, the agent flips these tasks to `status: pending` and the human executes them; the agent does no work for E0 itself.

### E0.1: Apple Developer ID
- Enrol in the Apple Developer Programme (~99 USD per year, 24 to 48 hours for approval).
- Generate a Developer ID Application certificate; install in macOS Keychain.
- Generate an App Store Connect API key for `notarytool`; store as GitHub Actions secrets `APPLE_API_KEY_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.
- AC: `codesign -dv` against a test binary signed with the cert succeeds; `notarytool` submission succeeds.

### E0.2: Windows code-signing certificate
- Procure either an EV certificate (recommended; days to weeks; required to skip SmartScreen warnings on day one) or an OV certificate (hours; SmartScreen warns until reputation builds).
- Store as GitHub Actions secret `WINDOWS_CERT_PFX_BASE64` with password `WINDOWS_CERT_PASSWORD`.
- AC: `signtool sign` against a test binary succeeds; `signtool verify` reports trusted.

### E0.3: Tauri updater keypair
- Run `corepack pnpm tauri signer generate` once Tauri is scaffolded by A1.
- Public key committed in `src-tauri/tauri.conf.json`; private key stored in OS keychain and as GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY`.
- AC: `corepack pnpm tauri build` produces a signed update artifact; the public key in `tauri.conf.json` matches the keypair used for signing.

### Phase E0 definition of done
- All three artefacts (Apple cert, Windows cert, Tauri keypair) are provisioned and stored as documented.
- A test build of the Builder is signed and notarised on macOS, signed on Windows, and produces a valid Tauri updater signature.

## Phase G: Debug and repair module

Per ADR-0007 and `debug_repair_engine_spec.md`. The module detects the eight defect classes in target apps, ranks by PRIORITY, applies Tier 1 codemods, runs the Tier 2 verify loop, explains Tier 3 architectural changes, and gates Deploy on critical findings. Scope-cut to TS + Next.js 15 + Supabase + Vercel only.

### G1: Spec amendment, ADR, defects schema (in flight as the entry into Phase G)
- ADR-0007 written; `spec.md` amended (§2 in-scope, Flow L in §3, `defects` table in §4, debug NFRs in §6, Phase G in §7); this Phase G section added; `defects` migration generated via `corepack pnpm --dir sidecar drizzle-kit generate`.
- AC: `corepack pnpm verify` is green; `/recheck` shows zero new blocker drift; the ADR cites the spec sections that triggered it (per SC17).

### G2: Layer 1 detectors (TS-only) + PRIORITY scoring + sidecar handler
- `lib/debug/taxonomy.ts`: the eight-class enum with severity defaults (per source spec §B.1 and §C.3.1).
- `lib/debug/priority.ts`: pure `priority({S, B, C, U, D}) => {score, band}` with the founder-mode `U` table per source spec §C.3.4.
- `lib/debug/detectors/layer1/`: tsc-noemit wrapper, hallucinated-import resolver, secret regex, Drizzle/Supabase RLS-on-PII rule, client-side-auth rule (`if (user.role === 'admin')` in a `.tsx` file gated only to render), client-bundle env-leak rule (env var without `NEXT_PUBLIC_` prefix referenced in client component).
- Sidecar handler `debug.scan({projectId})` runs Layer 1 and inserts findings into `defects`.
- AC: unit tests per detector; one integration test runs the scan against a fixture target app reproducing the Lovable-class RLS bug and asserts the finding lands in `defects` at band `critical`.

### G3: Software graph (route inventory, schema graph, auth model)
- `lib/debug/graph/`: tree-sitter walk of `{project}/app` and `{project}/lib`; Next.js App Router + Pages Router route inventory with handlers, methods, middleware chain; Drizzle schema parse + Supabase migration parse → tables + RLS policies; auth-model trace identifying authentication points (`getServerSession`, `supabase.auth.getUser`) and authorisation checks.
- AC: unit tests on a fixture; full graph for the kit's default target-app structure.

### G4: Layer 2 hybrid validator over Claude Agent SDK
- `lib/debug/detectors/layer2/validator.ts`: candidate finding + ±50 lines + relevant subgraph slice → structured `{is_real, confidence, exploit_path, suggested_fix_strategy}`.
- Reuses ADR-0005 sidecar SDK bridge with a separate stream id in the sidecar's `inflight` map.
- Cache validations on the `defects` row; re-validate only when the candidate location or its callers change (per source spec §D.3).
- Prompt-injection guard: validator inputs are structured; the system prompt instructs it to treat code/comments as data and refuse meta instructions in them.
- AC: offline eval suite of 10 known-defect / 10 known-clean fixtures; ≥85% precision on the critical-band slice (matches source spec §G.1 v1 target).

### G5: Repair pyramid — Tier 1 codemods + Tier 2 verify loop, branch-per-fix
- `lib/debug/repair/tier1-codemods/`: jscodeshift codemods for extract-secret-to-env, add-zod-validation, add-cookie-flags (HttpOnly + Secure), replace-jwt-decode-with-verify.
- `lib/debug/repair/tier2-loop.ts`: failing-test → patch → verify → regression-check, capped at 3 attempts; integrates the Layer 3 sandbox build (`pnpm install && pnpm build` in subprocess against `{project}/`).
- Branch-per-fix: every fix lands on a fresh `ai-fix-<defect-id>` branch via the existing `gh`/git wiring; only on green is the patch squashed onto the novice's working branch.
- AC: E2E runs on a fixture target app, observes the fix branch + verifier green + squash; one regression test where a deliberately bad LLM patch causes the loop to back off after 3 attempts.

### G6: Right-rail Debug panel + Deploy gate modal
- `app/build/components/debug-panel.tsx`: right-rail tab (sibling of Preview from Flow K AC7), card-per-finding sorted by PRIORITY band, founder-mode plain-English first.
- `app/build/components/debug-card.tsx`: plain-English impact, advanced toggle for CWE + code evidence, **Fix this** action wired to the appropriate tier.
- `app/build/components/deploy-gate-modal.tsx`: typed-confirmation modal hooked into Flow I; lists critical-band findings and requires the typed phrase "deploy anyway" to proceed.
- AC: Playwright covering Flow L AC3 / AC4 / AC5 / AC8.

### G7: Tier 3 explainer + 7-day rollback + slopsquat + prompt-injection hardening
- `lib/debug/repair/tier3-explainer.ts`: plain-English explanation, proposed diff, migration plan; never auto-applies.
- 7-day rollback: `lib/debug/history.ts` records every applied fix with branch + commit; rollback restores the pre-fix state regardless of subsequent git activity.
- Slopsquat detection (deferred from G2): for every dependency in `package.json`, query the npm registry; reject if publish date < 60 days, downloads < 10K, or no verified publisher; cache results in the sidecar DB for 24 hours.
- Hardening pass: prompt-injection adversarial test suite for the Layer 2 validator (in-repo comments and strings instructing the model to ignore findings).
- End-of-phase `/recheck` against amended `spec.md`; expect zero new blocker drift.
- AC: full `corepack pnpm verify` + `corepack pnpm e2e -- --grep debug` green; phase-G `/recheck` clean.

### Phase G definition of done
- Flow L fully passes.
- A target app reproducing the Lovable-class RLS bug is detected, fixed on a branch, and verified before merge.
- ≥85% precision on the critical band of the v1 regression set; ≤15% fix-introduces-new-bug rate over the last 50 applied fixes.
- `/recheck` reports zero blocker drift.
