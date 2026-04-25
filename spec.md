# Build Spec: Builder

## 0. Source materials
- `kit-section-14.md`: the original onboarding-layer specification.
- `kit-sections-1-13.md`: the Build Spec Kit defaults this app must follow and use.

## 1. Problem and users
- Problem: absolute novices cannot use Claude Code in VS Code; the terminal, file system, git, and prompt-engineering knowledge required are insurmountable. Existing "no-code" builders trade away ownership and quality.
- Primary user: non-technical founder, operator, or domain expert who has an idea and an Anthropic API key.
- Status quo: they hire a developer, give up, or paste prompts into Claude.ai and copy code into a ZIP.
- Success in 30 days of beta: at least 60 percent of first-time users reach a deployed Phase 1 preview URL within 90 minutes; at least 30 percent return within 7 days for a second project.

## 2. Scope
In scope:
- Tauri 2 desktop app, signed installers for macOS (Apple silicon and Intel), Windows x64, Linux x64.
- First-run flow: welcome, API key paste, project creation.
- Recursive chat interview that populates `spec.md` via the kit's question library and decision table.
- File ingestion pipeline for: text docs (PDF, DOCX, MD, TXT), images (PNG, JPG, PDF-as-image), schemas (SQL, JSON, YAML, OpenAPI), data samples (CSV, JSON, SQL dump), reference URLs.
- Build dashboard with phase bar, task lanes, live tail, ETA, cost meter, drift status.
- Approval gates for phase transitions and drift events.
- Pause, resume, stop, crash recovery.
- Deploy preview to Vercel and export to GitHub.
- Auto-update via Tauri updater.

Out of scope:
- Hosting the novice's app in production. Deploy is to Vercel under the novice's account.
- Stacks other than the kit's pinned Next.js 15 + Supabase + TypeScript default.
- Voice input. Deferred per kit section 14.10.
- Templated interview presets. Deferred per kit section 14.10.
- A web-hosted version of the Builder. Desktop only.

Explicit non-goals:
- The Builder will not "fix" novice answers. It surfaces ambiguity and applies defaults; it does not silently improve.
- The Builder will not retain novice content on any server. All data stays on the novice's machine except the prompts sent to the Anthropic API.

## 3. Core flows (Given/When/Then)

### Flow A: First run
- **Given** a novice has installed the Builder and never opened it,
- **When** they launch it,
- **Then**:
  - **Flow A AC1**: The Welcome screen runs a detection probe checking whether `claude` is on PATH and whether `claude -p "ping"` returns a successful response.
  - **Flow A AC2**: If `claude` is missing, the screen shows an "Install Claude Code" link and instructions; the user cannot advance until detection passes.
  - **Flow A AC3**: If `claude` is installed but not authenticated, the screen shows a "Sign in to Claude Code" link and instructions; the user cannot advance until detection passes.
  - **Flow A AC4**: When detection passes, the Welcome screen advances to "Create your first project".
  - **Flow A AC5**: The audit log records `app_first_run`.

### Flow B: Project creation
- **Given** a novice has a working API key,
- **When** they enter a project name and pick a folder (default `~/Documents/ClaudeBuilds/`),
- **Then**:
  - **Flow B AC1**: The Builder creates `{folder}/{name}/`.
  - **Flow B AC2**: The Builder runs `git init` in the new folder.
  - **Flow B AC3**: The Builder copies in `CLAUDE.md`, the `rules/` library, an empty `spec.md`, and an empty `.builder/state.json`.
  - **Flow B AC4**: The audit log records `project_created` with the project path.

### Flow C: Recursive interview
- **Given** a project has been created,
- **When** the novice types a message in the chat,
- **Then**:
  - **Flow C AC1**: The Builder calls Claude with the interview system prompt and the running answers.
  - **Flow C AC2**: Claude responds with either a follow-up question or a `record_answer` tool call.
  - **Flow C AC3**: On `record_answer`, the orchestrator writes to `.builder/answers.json` and rebuilds `spec.md` from the kit's decision table.
  - **Flow C AC4**: The spec preview panel updates within 500ms.
  - **Flow C AC5**: The topic counter increments.
  - **Flow C AC6**: The audit log records `answer_recorded` with the question id.

### Flow D: File ingestion
- **Given** the novice drops a file into the file panel,
- **When** the file is one of the supported types,
- **Then**:
  - **Flow D AC1**: The ingestor classifies the file and extracts content (text, image, schema, data).
  - **Flow D AC2**: The PII guard runs against the extracted content.
  - **Flow D AC3**: A summary is presented in the chat as "I see you uploaded X. Here is what I read. Should I proceed on that basis?".
  - **Flow D AC4**: On novice approval, extracted answers merge into `answers.json` with `confidence: tentative`.
  - **Flow D AC5**: The spec preview reflects the merge.
  - **Flow D AC6**: The file is copied to `{project}/inputs/` and listed in `spec.md` section 0.

### Flow E: Ready to build
- **Given** all 28 fast-path questions and all activated high-stakes questions have answers,
- **When** the novice clicks Start build,
- **Then**:
  - **Flow E AC1**: The Builder runs a final echo-back ("Here is what I'll build, three things ranked. Anything wrong?").
  - **Flow E AC2**: On confirmation, the Builder transitions to the Build screen.
  - **Flow E AC3**: The orchestrator spawns Claude Code in the project folder with `CLAUDE.md` and `rules/` already present.
  - **Flow E AC4**: The dashboard begins streaming.

### Flow F: Build phase execution
- **Given** a build phase has started,
- **When** Claude Code emits a tool call,
- **Then**:
  - **Flow F AC1**: The orchestrator parses the tool call, translates it to a human line, and appends to `history.log`.
  - **Flow F AC2**: The live tail in the UI updates within 200ms.
  - **Flow F AC3**: The ETA is recomputed using the kit's online formula.
  - **Flow F AC4**: The cost meter updates from the SDK's usage data.
  - **Flow F AC5**: On phase boundary, Claude Code emits a "phase complete" marker that pauses the orchestrator and shows the approval modal.

### Flow G: Drift detected
- **Given** Claude Code has run `/recheck` at a phase boundary,
- **When** `docs/spec-trace.md` reports any blocker drift,
- **Then**:
  - **Flow G AC1**: The orchestrator pauses the build.
  - **Flow G AC2**: The dashboard shows a drift banner with the drifted item and three buttons: Revert, Change spec, Accept.
  - **Flow G AC3**: On novice choice, the Builder applies the chosen path per self-check rule SC24.
  - **Flow G AC4**: The chosen resolution is logged to `docs/drift-log.md`.
  - **Flow G AC5**: The build resumes after the choice is applied.

### Flow H: Pause, resume, crash recovery

**Scenario H.1: Pause**
- **Given** a build is in progress,
- **When** the novice clicks Pause,
- **Then**:
  - **Flow H AC1**: The orchestrator finishes the current Claude Code tool call, persists `state.json`, and stops.
  - **Flow H AC2**: The UI reflects "Paused, click Resume to continue".

**Scenario H.2: Crash recovery**
- **Given** the app process dies mid-build,
- **When** the novice reopens the project,
- **Then**:
  - **Flow H AC3**: The orchestrator reads `state.json`, replays no actions, and resumes from the next incomplete task.
  - **Flow H AC4**: The dashboard surfaces "Recovered from crash; resumed at task N".

### Flow I: Deploy and export

**Scenario I.1: Deploy preview to Vercel**
- **Given** Phase 1 of the novice's target app is green,
- **When** the novice clicks Deploy preview to Vercel,
- **Then**:
  - **Flow I AC1**: The Builder asks for a Vercel access token (with a "Where do I get this?" link).
  - **Flow I AC2**: On submission, the Builder runs `vercel deploy` from the project folder.
  - **Flow I AC3**: The Builder captures the preview URL.
  - **Flow I AC4**: The Builder runs the smoke E2E against the URL.
  - **Flow I AC5**: On success, the URL is copied to clipboard and shown.
  - **Flow I AC6**: The audit log records `deployed_preview`.

**Scenario I.2: Alternatives**
- **Flow I AC7**: The novice can click "Show me the folder" to open the project in their file manager.
- **Flow I AC8**: The novice can click "Push to GitHub" to create a private repo.

### Flow J: Update
- **Given** a new Builder version is published,
- **When** the novice opens the app,
- **Then**:
  - **Flow J AC1**: Tauri's updater checks the signed feed.
  - **Flow J AC2**: If a newer version is available, the Builder prompts the novice to install.
  - **Flow J AC3**: On confirmation, the Builder downloads, verifies signature, and restarts.

## 4. Data model (high level)
- `projects` table: id (ULID), name, path, created_at, last_opened_at, current_phase, status (interviewing | ready | building | paused | done)
- `answers` table: id, project_id, question_id, answer_text, confidence (confident | tentative | default-applied), source (chat | file | default), rationale, created_at
- `files` table: id, project_id, original_name, stored_path, type, summary, ingested_at, has_pii_warning
- `actions` table (the live tail backing store): id, project_id, ts, tool, raw_input (jsonb), human_line, phase, task_id
- `drift_events` table: id, project_id, phase, type (implementation | scope | silent_assumption | nfr), description, resolution (revert | amend_spec | accept), commit_hash, occurred_at
- `costs` table: id, project_id, ts, model, input_tokens, output_tokens, usd_cents
- `keychain_meta` (no secrets): map of `project_id` to keychain item names; the actual API and Vercel keys live in the OS keychain, not the database.

PII held: project paths only. No novice content is held in the database; chat transcripts and uploaded files live in the project folder, owned by the novice.

## 5. Integrations
- Claude Code CLI (`claude`), required, novice authenticates the CLI separately (Pro / Max subscription or API key configured inside the CLI). See ADR-0002.
- Vercel CLI, optional, used only if novice clicks Deploy.
- GitHub via `gh` CLI, optional, used only if novice clicks Push to GitHub.
- OS keychain, required, via `keytar` (Mac, Windows) and Secret Service (Linux); used for the Vercel access token only.
- Tauri updater, required, signed feed hosted on the project's distribution endpoint.

## 6. Non-functional requirements
- App launch to Welcome screen: under 1.5 seconds on a 2020 MacBook Air.
- Chat round-trip (novice message to first streamed token): under 2 seconds median, under 5 seconds p95.
- Spec rebuild after a `record_answer`: under 500ms.
- Live tail latency from Claude Code tool call to UI line: under 200ms.
- Installer size: under 25 MB per platform.
- Memory footprint at idle: under 200 MB.
- Crash recovery: 100 percent of state recoverable from `state.json` and `history.log`.
- Accessibility: WCAG 2.2 AA across all screens, axe-core zero violations.
- Security: the Builder holds no Anthropic credential (the `claude` CLI manages its own auth per ADR-0002); the Vercel access token (E1) lives in the OS keychain. Project folder writes confined to the novice's chosen path; Tauri's allowlist restricts file system access to that path.
- Privacy: no telemetry by default; Sentry opt-in with a clear explainer; novice content never leaves the machine except as prompts to Anthropic.
- Cost transparency: real-time token usage parsed from the `claude` CLI's stream-json output; honesty rule per kit section 14.5.3 (past P90, switch to "more than expected"). Spend is shown as token count plus an estimated GBP figure based on the active model's published rate; subscription users (Pro / Max) may treat the figure as informational only.
- Rate limits: the CLI's underlying account governs throttling; the Builder detects the CLI's rate-limit error and surfaces a "wait until HH:MM" message; the build pauses gracefully. No hard daily spend cap is enforced by the Builder (deferred to a later phase if required).

## 7. Phased plan
The Builder follows the kit's own phased build pattern. Five phases A to E, each shippable as a private beta to a small test group.

Phase A: Tauri shell, project create, API key flow, basic chat with Claude that writes spec.md (no recursion, no library). Demo: a tester can chat their way to a spec.

Phase B: Question library wiring, recursive follow-ups, fast-path gating, decision-table-driven spec rebuild. Demo: a tester can produce a fast-path-complete spec.

Phase C: File ingestion (text, image, schema, data, URL). Demo: a tester can upload a PRD and see it merged.

Phase D: Build dashboard, live tail, ETA, approval gates, drift surfacing. Demo: a tester can run a full Phase 1 build of a target app.

Phase E: Deploy to Vercel, export to GitHub, crash recovery, polish, signed installers, auto-update. Beta to real novices.

Each phase ends with: passing `pnpm verify`, one Playwright E2E for the new core flow, signed installers for all three platforms, and a deployed preview URL of the Builder's marketing site (a separate one-page Next.js app, not in scope here).

## 8. Open questions for the user
- Should the Sentry opt-in be a separate one-time prompt, or rolled into the Welcome screen? Default: separate, after first successful build, with a clear "no thanks" option. Confirm before Phase E.
- Should the cost ceiling default in pounds, dollars, or detect from locale? Default: detect from locale, fall back to USD. Confirm before Phase D.
- Should the export-to-GitHub flow create a public or private repo by default? Default: private. Confirm before Phase E.
