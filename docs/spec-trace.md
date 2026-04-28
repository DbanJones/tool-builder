# Spec trace report — Phase F hardening

Per [rules/07-self-check.md](../rules/07-self-check.md) SC10 — overwrite each `/recheck` run.

- **Generated**: 2026-04-28 (Phase F hardening check).
- **Summary**: PASS — zero blocker drift introduced by the hardening pass. Phase F closes or narrows several accepted non-blockers around novice readiness, file review, stop/cancel, and stale architecture docs.
- **Drift counts**: 0 blockers. Accepted non-blockers remain tracked in [docs/drift-log.md](drift-log.md); D-022 records this hardening pass.
- **Verification**: `corepack pnpm verify` green: 288 unit tests + 59 integration tests passing. `cd src-tauri && cargo check` green.

---

## Level 1: Current Coverage

| Spec item | Status | Pointer |
|---|---|---|
| Flow A CLI detection/auth | present | `app/(welcome)/page.tsx`, `lib/cli-detection/` |
| Flow B project creation | present | `app/(welcome)/new-project/page.tsx`, `src-tauri/src/project.rs` |
| Flow C recursive interview | present | `app/project/page.tsx`, `sidecar/src/chat-driver.ts`, `sidecar/src/handlers/answers.ts` |
| Flow C Q1-Q32 id validation | present | `sidecar/src/interview-question-ids.ts` |
| Flow D file ingestion | present | `lib/files/ingest.ts`, sidecar file handlers |
| Flow D file approval + PII review | present | `app/project/page.tsx`, `lib/files/ingest.ts` |
| Flow E readiness + final echo-back | present | `app/project/page.tsx`, `lib/interview/readiness.ts` |
| Flow F build streaming | present | `sidecar/src/orchestrator-driver.ts`, `lib/orchestrator/` |
| Flow H stop/cancel | present | `sidecar/src/orchestrator-driver.ts`, `src-tauri/src/orchestrator.rs` |
| Flow I deploy/export | present/partial | deploy/export code present; real smoke E2E still deferred per D-004/E0 dependencies |
| Flow J updater | wired/partial | updater wiring present; real signed feed gated on E0 |

## Level 2: Phase F Changes

| Recommendation | Status | Evidence |
|---|---|---|
| Unify chat/build architecture | done | ADR-0005, `sidecar/src/chat-driver.ts`, `sidecar/src/orchestrator-driver.ts` |
| Reliable stop/cancel | done | `orchestratorStop({ projectId })`, sidecar cancellation registry |
| Enforce echo-back before build | done | readiness gate and persisted local confirmation |
| Constrain question ids | done | Q1-Q32 enum validation in sidecar tools |
| Require file approval | done | pending/approved file state in workspace |
| Block on PII review | done | PII warning blocks chat/build until reviewed or skipped |
| Include approved source materials | done | generated `spec.md` prepends section 0 source summaries |
| Harden templates/scripts/docs | done | concrete `rules-README.md`, Corepack commands, docs refreshed |

## Level 3: Remaining Accepted Gaps

- **E0 signing artefacts**: Apple Developer ID, Windows signing cert, and Tauri updater keypair still require human procurement.
- **Production sidecar runtime bundling**: the SDK sidecar is now load-bearing; installers must bundle the runtime before novice distribution.
- **Persistent file approval state**: approval/review state is currently UI state. Move it into SQLite before relying on reopening a half-reviewed project.
- **Authoritative kit library**: question wording and decision table remain inferred placeholders until the real kit content is sourced.
- **Tauri E2E harness**: smoke E2E against real Tauri/CLI boundaries remains deferred per D-004.
- **Sentry SDK integration**: consent shim exists; SDK install and `beforeSend` scrubbing remain deferred per D-019.

## Level 4: NFR Check

- **Verification**: `corepack pnpm verify` green.
- **Rust shell**: `cargo check` green.
- **Privacy**: no Anthropic API key is collected; Claude Code CLI auth remains external. PII summaries use redacted text when flagged.
- **Novice safety**: Start build now requires readiness plus explicit echo-back; uploaded files require approval; Stop targets the active run.
- **Packaging risk**: sidecar runtime bundling is now the most important release-track follow-up.

## Recommended Next Actions

1. Persist file approval/review state in `.builder/builder.db`.
2. Bundle the sidecar runtime for signed installers.
3. Source the authoritative Build Spec Kit question library and decision table.
4. Add Tauri E2E coverage for Welcome, chat, build stop, file approval, deploy smoke, and updater.
