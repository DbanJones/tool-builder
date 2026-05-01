# Build Spec: Builder

## 0. Source materials
- `kit-section-14.md`: the original onboarding-layer specification.
- `kit-sections-1-13.md`: the Build Spec Kit defaults this app must follow and use.

## 1. Problem and users
- Problem: absolute novices cannot use Claude Code in VS Code; the terminal, file system, git, and prompt-engineering knowledge required are insurmountable. Existing "no-code" builders trade away ownership and quality.
- Primary user: non-technical founder, operator, or domain expert who has an idea and an authenticated Claude Code CLI account.
- Status quo: they hire a developer, give up, or paste prompts into Claude.ai and copy code into a ZIP.
- Success in 30 days of beta: at least 60 percent of first-time users reach a deployed Phase 1 preview URL within 90 minutes; at least 30 percent return within 7 days for a second project.

## 2. Scope
In scope:
- Tauri 2 desktop app, signed installers for macOS (Apple silicon and Intel), Windows x64, Linux x64.
- First-run flow: welcome, Claude Code CLI detection/auth check, project creation.
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
- The Builder will not retain novice content on any server. All data stays on the novice's machine except prompts sent to Claude through the local Claude Code auth path.

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
- **Given** a novice has passed Claude Code CLI detection and auth,
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
  - **Flow C AC3**: On `record_answer`, the sidecar validates the question id against Q1-Q35, writes the answer to the SQLite `answers` table, and rebuilds `spec.md` from the kit's decision table.
  - **Flow C AC4**: The spec preview panel updates within 500ms.
  - **Flow C AC5**: The topic counter increments.
  - **Flow C AC6**: The audit log records `answer_recorded` with the question id.

### Flow D: File ingestion
- **Given** the novice drops a file into the file panel,
- **When** the file is one of the supported types,
- **Then**:
  - **Flow D AC1**: The ingestor classifies the file and extracts content (text, image, schema, data).
  - **Flow D AC2**: The PII guard runs against the extracted content.
  - **Flow D AC3**: A summary is presented in the workspace for novice review. If PII is detected, the next chat/build action is blocked until the novice reviews or skips the file; summaries sent onward use redacted text.
  - **Flow D AC4**: On novice approval, the file summary is marked as approved source material with `confidence: tentative`; file contents do not silently create interview answers.
  - **Flow D AC5**: The generated spec includes approved source materials in section 0 before the interview-derived sections.
  - **Flow D AC6**: The file is copied to `{project}/inputs/` and listed in `spec.md` section 0.

### Flow E: Ready to build
- **Given** all 35 fast-path questions (including Q33 deliverable artifact, Q34 reference anchors, Q35 non-negotiables) and all activated high-stakes questions have answers,
- **When** the novice clicks Start build,
- **Then**:
  - **Flow E AC1**: Readiness auto-confirms once the fast-path is complete (no separate "Looks right" popup). The deliverable artifact, reference anchors, and non-negotiables remain visible in the Spec tab and re-surface in the post-build "verify against your spec" panel; per D-024 the explicit echo-back popup was removed because it added a friction step the novice repeatedly skipped past without reading.
  - **Flow E AC2**: With readiness satisfied, the unified project workspace enables Start build and switches into the build dashboard state.
  - **Flow E AC3**: If at least one other project is currently `building`, the Builder shows a modal listing those projects with three actions: **Run alongside** (start this build in parallel — both share the Claude account's rate-limit budget), **Stop them first** (cancel each in-flight build via per-project orchestrator stop, mark each `paused`, then start this one), **Cancel** (close modal, do nothing). Concurrent builds are supported because each project's SDK session lives behind its own stream id in the sidecar's `inflight` map. Per D-025 (supersedes D-024 silent preempt).
  - **Flow E AC4**: The sidecar starts a Claude Agent SDK session in the project folder with `CLAUDE.md` and `rules/` already present, using the `claude` CLI only as the auth backend.
  - **Flow E AC5**: The dashboard begins streaming.

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

**Scenario H.3: Stop**
- **Given** a build is in progress,
- **When** the novice clicks Stop,
- **Then**:
  - **Flow H AC5**: The Builder cancels the active SDK session for the current project/stream and marks the dashboard as stopped.

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

### Flow K: Visual feedback (annotated screenshots)
- **Given** a build has started (mid-stream or finished) and the novice notices something visually wrong with the built app,
- **When** the novice clicks **Pause & annotate** (mid-stream) or **Annotate** (between turns) in the workspace toolbar,
- **Then**:
  - **Flow K AC1**: If a build is mid-stream, the orchestrator stops via per-project `orchestratorStop` and the project flips to `paused`. The annotation modal opens in empty-placeholder mode.
  - **Flow K AC2**: The novice supplies the source image by drag-drop or clipboard paste (Cmd/Ctrl+V) into the modal. Images >10 MB are rejected with an inline error.
  - **Flow K AC3**: The modal exposes four tools — box, arrow, free-draw, text label — plus undo and clear. Annotations render in red (single-color for slice 1).
  - **Flow K AC4**: On Send, the canvas (image + overlay) is flattened to a PNG, saved via the path-sandboxed `feedback_image_save` Tauri command into `{project}/.builder/feedback/fb-<unix-secs>-<nanos>.png`, and the chat receives a user message containing the novice's text description plus the relative path.
  - **Flow K AC5**: `runFollowUpTurn` resumes the build session. The orchestrator's system prompt instructs it to Read any referenced `.builder/feedback/*.png` (Read returns image content), interpret the annotations, act on them, then rewrite `.builder/review.md`.
  - **Flow K AC6**: On Cancel or ESC, no file is written and no chat message is sent. The build remains paused (the novice can resume via the normal Build button).
  - **Flow K AC7** (Slice 2 / D-027): The right rail exposes a **Preview** tab visible whenever a build has started. When the target app is not running, the panel shows a "Start preview" button that calls `target_app_launch`. While the dev server is starting it shows a spinner; on error it shows the error + a Try again button.
  - **Flow K AC8**: Once the dev server is running, the Preview panel renders an `<iframe>` of the captured URL (`http://localhost:{port}`). CSP allows `frame-src 'self' http://localhost:* http://127.0.0.1:*`. The iframe sandbox attribute permits scripts, same-origin, forms, popups, and modals so the target app functions normally inside it.
  - **Flow K AC9**: The Preview toolbar includes Refresh (re-keys the iframe), Open externally (default browser), Stop preview (calls `target_app_stop`), and Capture & annotate.
  - **Flow K AC10** (D-028): The iframe sandbox grants `allow-pointer-lock`, `allow-downloads`, `allow-orientation-lock`, `allow-presentation` in addition to the basic SPA tokens, and the `allow` attribute permits `fullscreen; pointer-lock; autoplay; gamepad; clipboard-read; clipboard-write` so canvas/WebGL games (FPS-style mouse capture, fullscreen) function inside the preview.
  - **Flow K AC11** (D-028): On macOS, **Capture & annotate** spawns the native `screencapture -i` region picker via the new `capture_region_to_png` Tauri command; the captured PNG bytes are returned base64-encoded, decoded into a Blob, and the AnnotationModal opens with the image already loaded — three clicks end-to-end (pick → mark up → send). On Linux/Windows the button still opens the empty modal; the cross-platform path is a Slice 2.6 follow-up.
  - **Flow K AC12** (D-028): When the orchestrator emits a file-mutating `tool_use` event (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`), the workspace bumps a counter that's incorporated into the iframe's `key`, forcing a hard reload so the novice sees the agent's edits land in real time without clicking Refresh.

## 4. Data model (high level)
- `projects` table: id (ULID), name, path, created_at, last_opened_at, current_phase, status (interviewing | ready | building | paused | done)
- `answers` table: id, project_id, question_id, answer_text, confidence (confident | tentative | default-applied), source (chat | file | default), rationale, created_at
- `files` table: id, project_id, original_name, stored_path, type, summary, ingested_at, has_pii_warning
- `actions` table (the live tail backing store): id, project_id, ts, tool, raw_input (jsonb), human_line, phase, task_id
- `drift_events` table: id, project_id, phase, type (implementation | scope | silent_assumption | nfr), description, resolution (revert | amend_spec | accept), commit_hash, occurred_at
- `costs` table: id, project_id, ts, model, input_tokens, output_tokens, usd_cents
- `keychain_meta` (no secrets): map of `project_id` to keychain item names; Vercel and any future third-party keys live in the OS keychain, not the database.

PII and novice content are held locally only: interview answers and approved file summaries live in `.builder/builder.db`, uploaded files live in the project folder, and no content leaves the machine except as prompts sent to Claude through the local Claude Code auth path.

## 5. Integrations
- Claude Code CLI (`claude`), required as the local auth backend. Interview chat and build orchestration use the Claude Agent SDK in the Node sidecar. See ADR-0002 and ADR-0005.
- Vercel CLI, optional, used only if novice clicks Deploy.
- GitHub via `gh` CLI, optional, used only if novice clicks Push to GitHub.
- OS keychain, required, via the Tauri/Rust keyring wrapper; used for the Vercel access token only.
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
- Privacy: no telemetry by default; Sentry opt-in with a clear explainer; novice content never leaves the machine except as prompts to Claude through the local Claude Code auth path.
- Cost transparency: real-time token usage from Claude Agent SDK events; honesty rule per kit section 14.5.3 (past P90, switch to "more than expected"). Spend is shown as token count plus an estimated GBP figure based on the active model's published rate; subscription users (Pro / Max) may treat the figure as informational only.
- Rate limits: the CLI's underlying account governs throttling; the Builder detects the CLI's rate-limit error and surfaces a "wait until HH:MM" message; the build pauses gracefully. No hard daily spend cap is enforced by the Builder (deferred to a later phase if required).

## 7. Phased plan
The Builder follows the kit's own phased build pattern. The base plan is five phases A to E, each shippable as a private beta to a small test group, followed by Phase F novice-readiness hardening.

Phase A: Tauri shell, project create, Claude Code detection/auth flow, basic chat with Claude that writes spec.md (no recursion, no library). Demo: a tester can chat their way to a spec.

Phase B: Question library wiring, recursive follow-ups, fast-path gating, decision-table-driven spec rebuild. Demo: a tester can produce a fast-path-complete spec.

Phase C: File ingestion (text, image, schema, data, URL). Demo: a tester can upload a PRD and see it merged.

Phase D: Build dashboard, live tail, ETA, approval gates, drift surfacing. Demo: a tester can run a full Phase 1 build of a target app.

Phase E: Deploy to Vercel, export to GitHub, crash recovery, polish, signed installers, auto-update. Beta to real novices.

Phase F: Hardening for novice success: SDK-sidecar chat/build, cancel/stop, echo-back gating, Q1-Q35 validation (Q33-Q35 added in D-023 to anchor the build to a concrete artifact, named reference tools, and explicit non-negotiables), file approval with PII review, approved source-material injection, concrete target-app rules, Corepack scripts, and documentation/ADR alignment.

Each phase ends with: passing `corepack pnpm verify`, one Playwright E2E for the new core flow where available, signed installers for all three platforms when signing artefacts exist, and a deployed preview URL of the Builder's marketing site (a separate one-page Next.js app, not in scope here).

## 8. Open questions for the user
- Should the Sentry opt-in be a separate one-time prompt, or rolled into the Welcome screen? Default: separate, after first successful build, with a clear "no thanks" option. Confirm before Phase E.
- Should the cost ceiling default in pounds, dollars, or detect from locale? Default: detect from locale, fall back to USD. Confirm before Phase D.
- Should the export-to-GitHub flow create a public or private repo by default? Default: private. Confirm before Phase E.
