# Builder

## What this is
A desktop app, built with Tauri and Next.js, that lets an absolute novice build a
production-grade web app by chatting with Claude. The Builder runs offline on
the novice's machine, conducts a recursive interview to populate spec.md, ingests
uploaded files (PRDs, screenshots, schemas, transcripts), then orchestrates
Claude Code via the `claude` CLI to build the novice's app (see ADR-0002). Primary user:
non-technical founders and operators. Success metric: a novice can ship a
deployed Phase 1 app in under 90 minutes from first launch, on their own.

## Stack (pinned, do not deviate without an ADR)
- Tauri 2 shell (Rust), bundled Node 22, pnpm 9, git, and Claude Code CLI
- Next.js 15 App Router (UI), React 19, TypeScript strict
- shadcn/ui + Tailwind for all UI; Radix primitives where shadcn falls short
- Claude Code CLI (`claude`) for all the orchestrator's Claude interactions: interview chat, ingestion, drift checks, and build-phase subprocesses (see ADR-0002). Headless invocations use `claude -p --output-format stream-json`; tool use is wired via a local MCP server.
- Drizzle ORM with better-sqlite3 for local state in `.builder/builder.db`
- Vitest (unit + integration), Playwright (E2E against the running Tauri app)
- Tauri updater (signed) for auto-updates
- Sentry for error reporting, opt-in only; no analytics by default

## Binding rules (these override everything else)
1. MUST run `pnpm verify` (typecheck + lint + unit + integration) before declaring any task done.
2. MUST NOT use `any`, `as any`, or `// @ts-ignore`. Use `unknown` and narrow.
3. MUST validate every novice input and every file ingested with Zod at the trust boundary.
4. MUST NOT manage Anthropic credentials. The `claude` CLI handles its own auth (see ADR-0002). The OS keychain (via `keytar` or Tauri's secure store) is reserved for the Vercel access token at E1 and any future third-party credential; never on disk in plain text, never in git.
5. MUST treat the novice's project folder (`~/Documents/ClaudeBuilds/{name}`) as untrusted from the Builder's perspective; sanitise every path read, never execute arbitrary code outside the sandboxed Claude Code subprocess.
6. MUST NOT commit secrets. `.env.example` lists every variable; real values live in OS keychain or `.env.local`.
7. MUST log every Claude Code tool call to `.builder/history.log` as JSON lines; the live tail reads from this file.
8. MUST stop and ask before any irreversible action (deleting a project, overwriting a non-empty folder, force-pushing). See `rules/06-other.md`.
9. MUST work in feature-sized slices. PRs/commits stay under 400 changed lines.
10. MUST follow the Echo-back Protocol below before any new feature.
11. MUST run the self-check protocol from `rules/07-self-check.md` at every phase boundary, before every PR to main, and on every `/recheck` request. Drift is measured against `spec.md` (the original design), not against conversation history.
12. MUST self-drive: at the start of each session, read `.builder/state.json` to find the current phase and next task; at the end of each session, update it. Pause for human input only at the checkpoints listed in `docs/agent-runbook.md`.

## Codebase map
- `src-tauri/` Rust shell: window management, keychain access, file system bridge, updater
- `app/` Next.js App Router (the UI inside the Tauri webview)
  - `app/(welcome)/` first-run flow: Claude Code CLI detection, project creation
  - `app/(interview)/` chat + spec preview + file panel
  - `app/(build)/` dashboard + live tail + approval modals
- `components/ui/` shadcn primitives, `components/features/{feature}/` feature components
- `lib/orchestrator/` the engine that drives Claude Code: spawns CLI, parses tool calls, manages phases
- `lib/interview/` recursive chat: prompt construction, `record_answer` tool wiring, spec rebuilding
- `lib/ingest/` file ingestion pipeline: text extract, image vision, schema parse, PII guard
- `lib/db/` Drizzle schema and queries against `.builder/builder.db`
- `lib/eta/` time and cost estimator: per-phase budgets, online updates
- `lib/keychain/` cross-platform secret storage wrapper
- `tests/unit/`, `tests/integration/`, `tests/e2e/` Playwright against the built Tauri app
- `docs/adr/` architecture decision records, `docs/agent-runbook.md` self-drive instructions
- `.claude/agents/`, `.claude/commands/` slash commands and subagent definitions
- `.builder/` runtime state: `state.json`, `answers.json`, `history.log`, `builder.db`

## Verification commands (run these, do not guess)
- `pnpm dev` start Next.js dev server
- `pnpm tauri dev` start Tauri shell pointing at the dev server
- `pnpm verify` typecheck + lint + unit + integration (the merge gate)
- `pnpm e2e` Playwright against a built Tauri binary
- `pnpm tauri build` produce signed installers for Mac, Windows, Linux
- `pnpm db:migrate` apply Drizzle migrations to `.builder/builder.db`

## Echo-back Protocol (gate before any new feature)
Before writing code for any feature, you MUST output:
1. **Goal restatement**: one sentence in your own words.
2. **Affected files**: a list, with one-line "what changes" each.
3. **Acceptance criteria**: copied verbatim from `spec.md`, with Given/When/Then.
4. **Risks and unknowns**: anything you would ask a senior engineer.
5. **Plan**: numbered steps, each at most one hour of work.
Then STOP and wait for the user to say "go" or correct you. Do not write code in this turn.

## Self-drive protocol (how to operate without me)
At the start of every session:
1. Read `.builder/state.json`. Identify the current phase and the next incomplete task.
2. Read `docs/build-order.md` for that phase's tasks and acceptance criteria.
3. Read `docs/agent-runbook.md` for what to do when stuck.
4. Run `/recheck lite` to confirm no drift has accumulated.
5. Output a one-paragraph "where we are" summary, then start the next task using the Echo-back Protocol.

You may proceed through tasks autonomously. You MUST pause and ask the human at:
- Any checkpoint listed in `docs/agent-runbook.md` section 3.
- Any blocker drift detected by `/recheck`.
- Any irreversible action.
- Any decision the spec does not cover and no default applies.

When you pause, write a clear question and wait. Do not assume.

## Domain rule files (load on demand)
- @rules/00-meta.md conflict resolution, glossary, protocol pointers
- @rules/01-frontend.md components, design, accessibility, forms
- @rules/02-backend.md data model, API, auth, jobs, storage; this file's
  back-end is the orchestrator and local SQLite, not Supabase
- @rules/03-code.md TypeScript, errors, performance, git
- @rules/04-libraries.md selection, pinning, framework conventions
- @rules/05-testing.md trophy, coverage, factories, CI gating
- @rules/06-other.md deploy, observability, security, privacy, beginner safety
- @rules/07-self-check.md drift detection vs spec.md

## Where to find specifics
- The build target is in `spec.md`.
- ADRs are in `docs/adr/NNNN-title.md`. Add one whenever you deviate from a default.
- Failure modes and which rule prevents each are in `docs/failure-modes.md`.
- Self-drive instructions are in `docs/agent-runbook.md`.

## Glossary
- Builder: this app, the desktop tool we are building.
- Novice: the absolute beginner using the Builder to build their own app.
- Target app: the app the novice is building (eg PrepPilot).
- Orchestrator: the in-process engine that drives Claude Code on the novice's behalf.
- Live tail: the human-readable stream of what Claude Code is doing right now.
- Drift: a difference between the current code and the original spec.md.
