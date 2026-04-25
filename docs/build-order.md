# Build order

This file decomposes the spec.md section 7 phased plan into agent-executable tasks. The agent reads it at the start of every session and executes the next incomplete task. Each task lists its acceptance criteria, the tests that prove it, and the kit rules it must satisfy.

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
- Node 22.x and pnpm 9.x on PATH.
- Rust stable toolchain installed via `rustup`.
- Xcode Command Line Tools installed (macOS).
- `gh` CLI installed and authenticated against the human's GitHub account.
- Claude Code CLI (`claude`) installed and authenticated (Pro / Max subscription or API key configured inside the CLI). See ADR-0002.
- AC: `node -v`, `pnpm -v`, `rustc --version`, `gh auth status`, `claude --version` all succeed.

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
- Add Tauri 2 with `pnpm tauri init`.
- Add `pnpm verify` script (typecheck + lint + unit + integration).
- Add GitHub Actions workflow with required checks.
- AC: `pnpm verify` is green on a clean clone; `pnpm tauri dev` opens an empty window with the Next.js dev server.

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

### A4: Project creation
- Build `app/(welcome)/new-project/page.tsx` with name and folder fields.
- Validate name against npm naming rules.
- On submit, create `{folder}/{name}/`, run `git init`, copy CLAUDE.md, rules, empty spec.md, empty `.builder/state.json` from a templates folder.
- Insert into `projects` table.
- AC: Flow B passes end to end.
- Integration: `tests/integration/project-create.test.ts` against a temp directory.

### A5: Minimum chat (per ADR-0002)
- Build `app/(interview)/page.tsx` with chat panel, input, send button.
- Wire to a `claude -p --output-format stream-json` subprocess with the hardcoded system prompt: "You are interviewing the user to populate spec.md. Ask one question at a time. After each answer, write a brief summary to the chat."
- Stream the JSON output as it arrives; render assistant tokens as they stream.
- No `record_answer` tool yet; spec.md is not yet rebuilt from answers.
- Implement basic rate-limit handling: if the CLI exits with a rate-limit error, show "Claude is rate-limited; try again at HH:MM" and disable the send button until then.
- AC: novice can chat with Claude inside the Builder window; the rate-limit message renders correctly when the CLI returns its rate-limit exit code.
- E2E: `tests/e2e/chat-smoke.spec.ts` exercises the happy path; an integration test exercises the rate-limit path with a stubbed `claude` returning the rate-limit error.

### Phase A definition of done
- Flows A and B fully pass.
- Tester can chat freely with Claude in the Builder.
- Signed installers exist for Mac, Windows, Linux.
- `pnpm verify` and `pnpm e2e` both green.
- `/recheck` reports zero blocker drift.

## Phase B: Recursive interview, question library, decision table

### B1: Bring the question library into the repo
- Copy the kit's question library and decision table into `lib/interview/library.ts` as typed data.
- AC: a unit test loads the library and asserts question count, fast-path subset, and that every decision-table entry references a real rule id.

### B2: The `record_answer` tool via local MCP server (per ADR-0002)
- Define the tool per kit section 14.3.1.
- Host a local MCP server inside the Builder's main process exposing `record_answer` (and any future orchestrator tools).
- Configure the `claude` subprocess to use this MCP server via `--mcp-config`.
- On tool call, the MCP handler writes to `.builder/answers.json` and appends to the `answers` table; the response is returned to Claude through MCP.
- AC: when Claude calls `record_answer` mid-conversation, the file and DB update; the chat continues without the novice seeing the tool call.
- Integration: assert tool call is delivered through MCP, parsed, and persisted.

### B3: Spec rebuild from answers
- Build `lib/interview/rebuild-spec.ts` that takes `answers.json` and produces `spec.md` using the kit's spec template and decision table.
- AC: given a fixture `answers.json` representing a worked example, the rebuilt `spec.md` matches the expected output byte-for-byte.
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
- Implement the kit section 14.3.5 readiness check: 28 fast-path questions answered, all activated high-stakes questions answered, final echo-back confirmed.
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
- On confirm, merge extracted answers as `confidence: tentative`.

### Phase C definition of done
- Flow D fully passes for all six file types.
- Uploaded files appear in `{project}/inputs/` and in `spec.md` section 0.
- `/recheck` reports zero blocker drift.

## Phase D: Build dashboard

### D1: Spawning Claude Code as a subprocess
- Use the Anthropic Agent SDK's process spawning to start Claude Code in the project folder.
- Capture stdout, stderr, tool-call events.
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
- Implement Flow H: pause finishes current tool call then halts; resume reads state and continues; stop kills the subprocess; crash recovery reads `state.json` on app open.
- Tests: integration test that kills the orchestrator mid-task and asserts recovery on next launch.

### Phase D definition of done
- Flows F, G, H fully pass.
- A tester can run a full Phase 1 build of a target app from inside the Builder.
- ETA stays within P90 in 8 of 10 reference builds.
- `/recheck` reports zero blocker drift.

## Phase E: Deploy, export, polish, ship

### E1: Vercel deploy
- Capture Vercel access token via the same modal pattern as the API key.
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
- Implement the daily cap from spec.md section 6 NFR: soft warn at 50 percent, hard stop at 100 percent.

### E5: Sentry opt-in
- One-time prompt after first successful build.

### E6: Marketing site
- A one-page Next.js site at `apps/marketing/` with download links and a 90-second screen recording.

### Phase E definition of done
- Flows A through J fully pass.
- Signed installers downloadable from the marketing site.
- Three external testers complete a build without intervention.
- `/recheck` reports zero blocker drift; `drift-log.md` is reviewed and clean.

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
- Run `pnpm tauri signer generate` once Tauri is scaffolded by A1.
- Public key committed in `src-tauri/tauri.conf.json`; private key stored in OS keychain and as GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY`.
- AC: `pnpm tauri build` produces a signed update artifact; the public key in `tauri.conf.json` matches the keypair used for signing.

### Phase E0 definition of done
- All three artefacts (Apple cert, Windows cert, Tauri keypair) are provisioned and stored as documented.
- A test build of the Builder is signed and notarised on macOS, signed on Windows, and produces a valid Tauri updater signature.
