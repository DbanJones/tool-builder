# ADR-0005: Use the Claude Agent SDK for chat and build orchestration

**Status**: accepted, 2026-04-27.
**Supersedes**: ADR-0002 for the orchestrator and, as of the Phase F hardening pass, the interview chat path too. The Claude Code CLI remains the auth prerequisite, but both long-running Builder interactions now go through the Claude Agent SDK in the Node sidecar.

## Context

ADR-0002 chose to spawn the `claude` CLI as a subprocess and parse its `stream-json` stdout. That decision was right for keeping the novice's auth (Pro/Max subscription via `claude` login) intact and avoiding an Anthropic API key in the Builder. It worked well for the interview chat (one short turn at a time, no destructive actions).

It has failed for the build orchestrator. Claude Code's permission system is designed for an interactive human pressing Allow / Deny in the CLI's own UI. In our headless `-p` mode we have no such UI; every layered guard (`--permission-mode`, `--dangerously-skip-permissions`, `--add-dir`, project-local `.claude/settings.local.json`, user-level `~/.claude/settings.json`, "workspace trust", inline `--settings` overrides) bites in a different way. After ~10 patch attempts on 2026-04-27 the spawned claude was still reporting "session is locked to src-tauri" — no combination of flags reliably gives the spawned subprocess full write access to the novice's project folder.

The user asked for a structural rethink. We considered:
- **A. Switch the orchestrator to the Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`).
- **B. Drop to the raw Anthropic API and write our own agent loop.**
- **C. Stop using AI for file ops; deterministic templates only.**

A wins because it keeps ADR-0002's auth choice (the SDK shares the CLI's auth — no API key required, the novice's Pro/Max subscription continues to cover usage), gives us a real `canUseTool` callback the dashboard's permission UI can route through, and replaces the spawn-and-parse dance with a typed `AsyncGenerator<SDKMessage>` stream we control end-to-end.

B was rejected because it forces the novice to obtain + pay for an Anthropic API key separately from any subscription they already pay for — a real cost shift that breaks the "no Builder credentials" property of ADR-0002. C was rejected because it constrains the Builder to one stack and undermines the "Claude builds your app" pitch.

## Decision

Use `@anthropic-ai/claude-agent-sdk` (v0.2.x) inside the Node sidecar to drive both the recursive interview chat and the build-phase orchestrator. The SDK runs in the sidecar process (which already has Node, Drizzle, and persistence infra). The Tauri Rust shell becomes a thin streaming bridge: webview → Tauri → sidecar (JSON-RPC notifications) → SDK `query()` → callbacks back through the same wire.

### Concretely

- **New dep**: `@anthropic-ai/claude-agent-sdk` in `sidecar/package.json`.
- **Sidecar modules**: `sidecar/src/orchestrator-driver.ts` for build sessions and `sidecar/src/chat-driver.ts` for interview turns. Both call `query()` from the SDK, iterate the `AsyncGenerator<SDKMessage>`, and push typed events through the sidecar notification bridge.
- **`canUseTool` wiring**: the callback inserts a row into `permission_requests` (already exists per Commit B), polls until the dashboard `PermissionPromptBanner` resolves it (already exists), returns `{behavior: "allow"|"deny"}` to the SDK. The dead code from Commit B becomes live.
- **Streaming wire**: extend the sidecar's JSON-RPC protocol with notification messages (`{notification: {channel, payload}}` — no `id`, no response). Tauri's `sidecar.rs` parses notifications and forwards to per-stream Tauri `Channel<T>` instances the webview registered when calling `orchestrator_start`.
- **Tauri Rust commands**: `orchestrator_start` and `orchestrator_stop` keep the same TS-side signatures but their bodies become thin pass-throughs.
- **Interview chat**: `chat_send` and `chat_stop` now use the same streaming sidecar bridge (`chat.start` / `chat.stop`). The sidecar hosts SDK MCP tools for `record_answer` and `queue_questions`, and validates question ids against the known Q1-Q35 set (originally Q1-Q32; extended per D-023).

### Out of scope for this ADR

- Eliminating the `claude` CLI dependency entirely. The SDK still requires the CLI to be installed (it's the auth backend); we keep the A3 detection.

## Consequences

**Wins**:
- A real `canUseTool` callback the dashboard's existing PermissionPromptBanner UI can drive — "every single time the builder has an issue with writing to a directory" disappears.
- Typed `SDKMessage` events instead of stream-json string parsing — fewer bugs at the edge.
- Sessions, subagents, MCP, ETA hooks all expressed through the SDK's API instead of CLI flags.
- The dead code from Commit B (permission_requests table + handlers + banner + mcp-orchestrator.ts) becomes live with minor adapter changes.

**Losses**:
- Sidecar gets a non-trivial new dependency. `@anthropic-ai/claude-agent-sdk` v0.2.x is well-maintained by Anthropic but new (v0 still). Pin exactly per L4.
- Streaming over the sidecar JSON-RPC wire is a new pattern in the codebase. Documented in this ADR + a code comment.
- The sidecar is now load-bearing for both chat and build streaming, so packaging must bundle the sidecar runtime rather than relying on a system `node`.

## Follow-up

- Package the sidecar runtime for production installers so novices do not need Node installed.
- ADR-0002 has been narrowed to the credential/auth decision; keep it that way unless the auth model changes.
