# Spec trace report — Phase G EXIT boundary

Per [rules/07-self-check.md](../rules/07-self-check.md) SC10 — overwrite each `/recheck` run.

- **Generated**: 2026-05-02 (Phase G exit; G1 → G7c shipped across 23 commits since `38d730f`; recheck corrections applied at `82ca9cf`, `1b683c4`, `f3a86b9`, `a0cd3cb`, `ea4e2c9`).
- **Summary**: PASS — drift detected (0 blockers, 20 known non-blockers). All Phase G recheck corrections applied: NB-G-1 (Tier 2 cap) **closed** by `82ca9cf` restoring `MAX_TIER2_ATTEMPTS = 3`; NB-G-2 (debug-NFR perf assertions) **closed** by `a0cd3cb` tightening the integration-test budgets to spec NFRs; NB-G-3 (phase-boundary auto-trigger) **closed** by `f3a86b9`. The remaining escalation is the long-standing `tests/e2e/` gap (D-004 partial scaffold landed in `1b683c4`). Phase G is **boundary-approved** and committed; state.json + drift-log updated in `ea4e2c9`.
- **Drift counts**: 0 blockers; 20 open non-blockers. Carry-forward: D-001, D-002, D-004 (now Playwright harness scaffolded; tauri-driver still deferred), D-005…D-020 (19). NB-G-1/NB-G-2/NB-G-3 closed this session. D-022 closed Phase F; D-023…D-038 are all scope amendments with Echo-back + ADR coverage and not counted as drift.
- **Verification**: `corepack pnpm verify` green this session — 824 unit + 77 integration.

---

## Level 1: Spec coverage

### §2 In-scope items
| Item | Status | Pointer |
|---|---|---|
| Tauri 2 desktop app + signed installers | present/partial | `src-tauri/`; signing artefacts gated on E0 (D-017) |
| First-run flow (welcome, CLI detect/auth, project create) | present | `app/(welcome)/page.tsx`, `app/(welcome)/new-project/page.tsx` |
| Recursive chat interview populates spec.md | present | `sidecar/src/chat-driver.ts`, `lib/interview/library.ts` (Q1–Q35 per D-023) |
| File ingestion pipeline | present | `lib/files/ingest.ts`, `sidecar/src/handlers/files.ts` |
| Build dashboard with phase bar / live tail / ETA / cost / drift | present | `app/project/page.tsx`, `components/features/project-workspace/`, `lib/eta/`, `lib/orchestrator/translate.ts` |
| Approval gates for phase transitions and drift events | present (drift) / partial (phase boundary) | `components/features/project-workspace/drift-banner.tsx`; phase-boundary modal still deferred (D-015) |
| Pause / resume / stop / crash recovery | present | `src-tauri/src/orchestrator.rs`, `sidecar/src/orchestrator-driver.ts`, `app/project/page.tsx` |
| Deploy preview to Vercel + export to GitHub | present | `lib/deploy/`, `lib/export/`, `src-tauri/src/deploy.rs`, `src-tauri/src/export.rs` |
| Auto-update via Tauri updater | wired/partial | `lib/updater/index.ts`; placeholder pubkey gates real release (D-017) |
| **Debug & repair module (per ADR-0007)** | **present** | `sidecar/src/debug/**`, `sidecar/src/handlers/debug.ts`, `sidecar/src/handlers/repair.ts`, `lib/debug/`, `components/features/project-workspace/debug-{panel,card,gate-modal}.tsx` |

### §3 Flows
| Flow | Status | Pointer |
|---|---|---|
| Flow A AC1–AC5 | present | `app/(welcome)/page.tsx`, `lib/cli-detection/`, `lib/audit/` |
| Flow B AC1–AC4 | present | `src-tauri/src/lib.rs` (project_create), `src-tauri/templates/`, `sidecar/src/handlers/projects.ts` |
| Flow C AC1–AC6 | present | `sidecar/src/chat-driver.ts`, `sidecar/src/handlers/answers.ts:24` (Flow C AC6 cited), `lib/interview/rebuild-spec.ts` |
| Flow D AC1–AC6 | present | `lib/files/ingest.ts`, `sidecar/src/handlers/files.ts`, `sidecar/src/handlers/pii.ts` |
| Flow E AC1–AC5 | present | `app/project/page.tsx` (`startBuild`, `ConcurrentBuildPromptDialog`), `sidecar/src/orchestrator-driver.ts` |
| Flow F AC1–AC4 | present (AC2 latency unverified — D-016) | `lib/orchestrator/translate.ts`, `sidecar/src/handlers/actions.ts`, `lib/eta/`, `sidecar/src/handlers/costs.ts` |
| Flow F AC5 (phase complete marker) | partial | `report_drift` / `phase_complete` MCP tools deferred (D-015) |
| Flow G AC1–AC5 | present | `components/features/project-workspace/drift-banner.tsx`, `lib/drift/`, `sidecar/src/handlers/drift.ts` |
| Flow H AC1–AC5 | present | `src-tauri/src/orchestrator.rs`, `app/project/page.tsx`, `sidecar/src/schema/projects.ts:13` |
| Flow I AC1–AC8 | present (smoke E2E deferred — D-004) | `lib/deploy/index.ts`, `lib/export/index.ts`, `components/features/project-workspace/deploy-modal.tsx` |
| Flow J AC1–AC3 | wired/partial | `app/(welcome)/page.tsx`, `app/components/update-prompt.tsx`, `lib/updater/index.ts` (E0-gated, D-017) |
| Flow K AC1–AC12 | present | `components/features/annotation/`, `lib/annotation/`, `components/features/project-workspace/right-rail.tsx` (PreviewPanel), `src-tauri/src/lib.rs` (`feedback_image_save`, `capture_region_to_png`, `target_snapshot_save`), `lib/preview-bridge/` |
| **Flow L AC1** (phase-boundary scan covers 8 classes, kit stack only) | present | `sidecar/src/handlers/debug.ts:38` (DEFAULT_DETECTORS — 6 of 8 classes covered by L1), `sidecar/src/debug/scan.ts`. Phase-boundary auto-trigger wired at `f3a86b9` (NB-G-3 closed); slopsquat + dependency-version detectors remain opt-in per ADR-0007. |
| **Flow L AC2** (Debug now button, audit rows) | present | `app/project/page.tsx:282–312` (on-demand debug.scan), `sidecar/src/handlers/debug.ts:103,160` (audit emits) |
| **Flow L AC3** (defects table + Debug rail + PRIORITY ranking + founder mode) | present | `sidecar/src/schema/defects.ts`, `sidecar/src/debug/priority.ts`, `components/features/project-workspace/debug-panel.tsx:12` |
| **Flow L AC4** (plain-English first; CWE in advanced toggle) | present | `components/features/project-workspace/debug-card.tsx`, `lib/debug/index.ts` (BAND_TREATMENT) |
| **Flow L AC5** (Tier 1 codemod on `ai-fix-<id>` branch + verifier + squash) | present | `sidecar/src/debug/repair/branch.ts:2`, `sidecar/src/debug/repair/dispatcher.ts`, `sidecar/src/debug/repair/codemods/{extract-secret,add-rls-migration}.ts`, `sidecar/src/handlers/repair.ts` |
| **Flow L AC6** (Tier 2 verify loop, capped at 3 attempts) | present | `sidecar/src/debug/repair/tier2.ts:41` — `MAX_TIER2_ATTEMPTS = 3` (restored to spec value at `82ca9cf`; NB-G-1 closed). |
| **Flow L AC7** (Tier 3 explainer; never auto-applies) | present | `sidecar/src/debug/repair/tier2.ts` Tier-3 hand-off path; `defects.suggestion` column (migration `0011_rich_shaman.sql`) |
| **Flow L AC8** (deploy gate modal with typed "deploy anyway") | present | `components/features/project-workspace/deploy-gate-modal.tsx:10`, `app/project/page.tsx:379,1579` |
| **Flow L AC9** (7-day rollback restores pre-fix state) | present | `sidecar/src/handlers/repair.ts:446` (`rollbackFix`), `defects` row `fix_branch` + `resolved_commit` |
| **Flow L AC10** (separate validator stream id; prompt-injection guard) | present | `sidecar/src/debug/validator/{driver,prompt,adversarial.test}.ts`, `sidecar/src/handlers/debug.ts:31` (`sdkTransport`); validator opens its own SDK session distinct from build orchestrator |

### §4 Data model tables
| Table | Status | Pointer |
|---|---|---|
| `projects` | present | `sidecar/src/schema/projects.ts` |
| `answers` | present | `sidecar/src/schema/answers.ts` |
| `files` | present | `sidecar/src/schema/files.ts` |
| `actions` | present | `sidecar/src/schema/actions.ts` |
| `drift_events` | present | `sidecar/src/schema/drift-events.ts` |
| `costs` | present | `sidecar/src/schema/costs.ts` |
| `defects` (with validator + suggestion cols) | present | `sidecar/src/schema/defects.ts`; migrations `0009_glossy_reavers.sql` (base), `0010_real_chronomancer.sql` (validator), `0011_rich_shaman.sql` (suggestion) |
| `chat_messages` | present | `sidecar/src/schema/chat-messages.ts` (now in spec.md §4 line 197) |
| `permission_requests` | present | `sidecar/src/schema/permission-requests.ts` (now in spec.md §4 line 198) |
| `keychain_meta` (descriptive) | n/a — OS keyring | `lib/keychain/`, `src-tauri/src/lib.rs` keychain commands |

### §5 Integrations
| Integration | Status | Pointer |
|---|---|---|
| Claude Code CLI (auth backend) | present | `lib/cli-detection/`, ADR-0002 |
| Claude Agent SDK (chat + build + validator) | present | `sidecar/src/chat-driver.ts`, `sidecar/src/orchestrator-driver.ts`, `sidecar/src/debug/validator/driver.ts` |
| Vercel CLI | present | `src-tauri/src/deploy.rs`, `lib/deploy/` |
| GitHub CLI (gh) | present | `src-tauri/src/export.rs`, `lib/export/` |
| OS keychain | present | `lib/keychain/`, `src-tauri/src/lib.rs` |
| Tauri updater | wired/partial | `lib/updater/`, `src-tauri/tauri.conf.json` (placeholder pubkey, D-017) |
| `lib/open-tabs/` | present | spec.md §5 line 209 |
| `lib/spreadsheet/` | present | spec.md §5 line 210 |
| `lib/easter-egg/` | present | spec.md §5 line 211 |

### §6 NFRs
| NFR | Status | Notes |
|---|---|---|
| Launch <1.5s to Welcome | unverified | no automated harness yet |
| Chat round-trip <2s med / <5s p95 | unverified | no harness |
| Spec rebuild <500ms | met by design | `rebuildSpec` is pure + synchronous |
| Live tail <200ms | unverified — D-016 | optimistic render path is correct |
| Installer <25 MB / platform | unverified | gated on E0 + sidecar bundling |
| Memory <200 MB idle | unverified | no harness |
| Crash recovery 100% | present | `state.json` + `history.log` + `current_session_id` |
| WCAG 2.2 AA + axe zero | partial | Base UI gives most; PlanAckModal axe pass deferred (D-035); new debug-panel/debug-card/deploy-gate-modal also need an axe pass (carried under D-035). |
| Privacy: no Anthropic credential held | present | ADR-0002, ADR-0005 |
| Sentry opt-in | partial | consent shim shipped; SDK install deferred (D-019) |
| Cost transparency, rate-limit pause | present | `lib/eta/`, `lib/cost-ceiling/` |
| **Debug scan latency: L1 ≤5s, phase-boundary ≤90s, Debug-now cancellable** | present (perf assertions) / partial (cancellable UI) | `tests/integration/sidecar-debug.test.ts` asserts both budgets at `a0cd3cb`; Debug-now cancellation indicator deferred — tracked under D-040. |
| **Debug regression rate ≤15% (auto-downgrade Tier 2 at >25%)** | unverified — D-040 | Telemetry to track applied-fix outcomes not yet implemented; numerator/denominator is undefined until the first 50 applied fixes accumulate per project. Re-tracked under D-040 (post-Phase G observability slice). |

### §7 Phases
| Phase | Status | Pointer |
|---|---|---|
| A (shell + chat) | done | `state.json` `phase_a_completed_at` |
| B (interview + library) | done | `state.json` `phase_b_completed_at` |
| C (file ingestion) | done | `state.json` `phase_c_completed_at` |
| D (build dashboard) | done | `state.json` `phase_d_completed_at` |
| E (deploy/export/auto-update + marketing) | done with deferrals | D-017/D-018/D-019/D-020 |
| F (novice-readiness hardening) | done (D-022) | `docs/drift-log.md` D-022 |
| **G (debug & repair)** | **done — Phase G boundary approved** | G1–G7c shipped across 23 commits since `38d730f`; Flow L AC1–AC10 covered; recheck corrections applied (`82ca9cf`, `1b683c4`, `f3a86b9`, `a0cd3cb`, `ea4e2c9`) |

---

## Level 2: AC → test traceability

Convention: comment-citation (`// covers: Flow X ACn`) plus test-file proximity. Phase G adds 30 new test files in `sidecar/src/debug/**`, `lib/debug/`, plus extended integration tests in `sidecar/src/handlers/debug.test.ts` and `repair.test.ts`.

| AC group | Cited test(s) / source pointer | Verdict |
|---|---|---|
| Flow A AC1–AC5 | `lib/cli-detection/index.test.ts`, `lib/audit/index.test.ts` | covered (real Tauri E2E deferred — D-004) |
| Flow B AC1–AC4 | `lib/project/index.test.ts`, `tests/integration/sidecar-projects.test.ts`, `tests/integration/sidecar-audit.test.ts` | covered |
| Flow C AC1–AC6 | `lib/interview/library.test.ts`, `…/rebuild-spec.test.ts`, `…/readiness.test.ts`, `sidecar/src/handlers/answers.ts:24` | covered |
| Flow D AC1–AC6 | `tests/integration/sidecar-files-{extract,parse-data,parse-schema,pii-guard}.test.ts`, `lib/files/types.test.ts` | covered (DOCX/PDF binary fixtures deferred — D-009) |
| Flow E AC1–AC5 | `lib/interview/readiness.test.ts`; AC3 modal (no direct unit test) | covered |
| Flow F AC1–AC4 | `lib/orchestrator/translate.test.ts`, `tests/integration/sidecar-{actions,costs}.test.ts`, `lib/eta/index.test.ts` | covered (live-tail latency unverified — D-016) |
| Flow F AC5 | none | partial — D-015 |
| Flow G AC1–AC5 | `lib/drift/index.test.ts`, `tests/integration/sidecar-drift.test.ts` | covered |
| Flow H AC1–AC5 | `lib/orchestrator/index.test.ts`, `sidecar/src/schema/projects.ts:13` | covered (kill-mid-task E2E deferred — D-004) |
| Flow I AC1–AC8 | `lib/deploy/index.test.ts`, `lib/export/index.test.ts`, Rust tests in `deploy.rs`/`export.rs` | covered (smoke E2E deferred — D-004) |
| Flow J AC1–AC3 | `lib/updater/index.test.ts` | covered (real signed feed E0-gated — D-017) |
| Flow K AC1–AC12 | `lib/annotation/index.test.ts`, `lib/preview-bridge/{index,feedback-sidecar,request}.test.ts`, Rust tests in `launch.rs` | covered |
| **Flow L AC1** (8 classes covered by detector suite) | `sidecar/src/debug/detectors/layer1/{secret-regex,tsc,hallucinated-import,rls-missing,client-side-auth,env-leak,slopsquat}.test.ts`, `sidecar/src/debug/scan.test.ts` | covered — phase-boundary auto-trigger landed at `f3a86b9`; detector suite in place |
| **Flow L AC2** (Debug now + audit) | `sidecar/src/handlers/debug.test.ts`, `lib/debug/sidecar.test.ts` | covered |
| **Flow L AC3** (defects ranking + founder mode) | `sidecar/src/debug/priority.test.ts`, `sidecar/src/debug/taxonomy.test.ts`, `lib/debug/selectors.test.ts` | covered |
| **Flow L AC4** (plain-English first) | `lib/debug/selectors.test.ts` (BAND_TREATMENT) | covered |
| **Flow L AC5** (Tier 1 + branch + verify + squash) | `sidecar/src/debug/repair/{branch,dispatcher,verify,patch-driver,codemods/extract-secret,codemods/add-rls-migration}.test.ts`, `sidecar/src/handlers/repair.test.ts` | covered |
| **Flow L AC6** (Tier 2 loop) | `sidecar/src/debug/repair/tier2.test.ts`, `sidecar/src/debug/repair/adversarial-patch.test.ts` | covered (cap = 3 per spec; NB-G-1 closed at `82ca9cf`) |
| **Flow L AC7** (Tier 3 explainer) | `sidecar/src/debug/repair/tier2.test.ts` (hand-off branch) | covered |
| **Flow L AC8** (deploy gate) | `app/project/page.tsx` Deploy gate (manual; UI test infra deferred — D-004) | partial — covered by inspection; needs an axe + interaction test |
| **Flow L AC9** (7-day rollback) | `sidecar/src/handlers/repair.test.ts` (`rollbackFix` paths) | covered |
| **Flow L AC10** (separate validator stream + prompt-injection) | `sidecar/src/debug/validator/{driver,prompt,slice,adversarial}.test.ts` | covered |

**Tests not mapped to ACs**: canary `tests/unit/sanity.test.ts`, `tests/integration/sanity.test.ts`; `lib/spreadsheet/`, `lib/demo/`, `tests/unit/david-easter-egg-template.test.ts`, `tests/integration/sidecar-easter-egg.test.ts` (all process artefacts — kept; spec.md §5 now references them or D-037 explicitly accepts them).

---

## Level 3: Scope drift candidates

| Item | Spec reference | Disposition |
|---|---|---|
| `app/(welcome)/`, `app/project/`, `app/admin/` | Flow A/B (welcome+new-project), Flows C–L (project), D-037 (admin) | in-scope (admin = accepted scope drift D-037) |
| `sidecar/src/schema/{projects,answers,files,actions,drift_events,costs,defects,chat_messages,permission_requests}` | spec.md §4 | in-scope — `chat_messages` and `permission_requests` now formally listed in §4 (lines 197–198 per D-038) |
| `sidecar/src/debug/**` | spec.md §3 Flow L, §7 Phase G, ADR-0007 | in-scope |
| `sidecar/src/handlers/{debug,repair}.ts` | spec.md §3 Flow L | in-scope |
| `lib/debug/` | spec.md §3 Flow L (UI-side wrapper) | in-scope |
| `components/features/project-workspace/{debug-panel,debug-card,deploy-gate-modal}.tsx` | spec.md §3 Flow L AC3/AC4/AC8 | in-scope |
| `tests/fixtures/target-apps/{lovable-rls,clean}/` | build-order G2/G7 reference fixtures | in-scope (test infra) |
| Tauri commands in `src-tauri/src/` | spec.md §5 + flow ACs | mostly in-scope; `target_snapshot_save`, `feedback_sidecar_save`, `capture_region_to_png`, `feedback_image_save` cited by Flow K AC4/AC11 (D-031..D-034) |
| Orchestrator steps (Phase F + G additions) | spec.md Flow F + Flow L | in-scope; phase-marker tools (`report_drift`, `phase_complete`) still deferred per D-015 |
| Migrations `0009/0010/0011` | spec.md §4 `defects` (with validator + suggestion cols) | in-scope (D-038 + Phase G evolution) |
| `lib/open-tabs/`, `lib/spreadsheet/`, `lib/easter-egg/` | spec.md §5 (lines 209–211 per D-038) | in-scope |
| `app/admin/`, `lib/demo/` | not in spec.md; D-037 explicit accept | scope drift accepted (D-037) |

**Aggregate verdict**: zero unreferenced scope items at Phase G exit. Every Phase G addition traces to Flow L or to an explicit ADR-0007 cut. Process artefacts that the Phase G entry recheck flagged are now formally referenced in spec.md §4/§5.

---

## Level 4: Silent assumption candidates

### ADR-to-spec citation audit (SC17)
| ADR | Cites spec section | Verdict |
|---|---|---|
| 0002 (CLI as auth prerequisite) | CLAUDE.md stack, rules/04-libraries.md L17, spec.md §5 | cited |
| 0003 (keyring-rs vs keytar) | rules/04-libraries.md L9c, build-order A2 | cited (rules-derived) |
| 0004 (Node sidecar for SQLite) | CLAUDE.md stack pin | cited |
| 0005 (Claude Agent SDK) | ADR-0002 (transitive to spec §5) | cited |
| 0007 (Debug module) | spec.md §2, §3 (Flow L), §4 (defects), §6 NFRs, §7 Phase G | cited explicitly |
| 0014 (Preview bridge proxy) | Flow K (per D-038 fix) | cited |

### Default-catalogue checks (SC18)
| Default | In repo | Verdict |
|---|---|---|
| Pagination (cursor, B10) | actions list uses cursor; defects list ordered by priority desc | conformant (defects ordering explicitly per Flow L AC3) |
| Job runner (in-process orchestrator, B22) | sidecar drivers + Phase G handlers | conformant |
| ORM (Drizzle, L9) | Drizzle + better-sqlite3 throughout | conformant |
| Auth (OS keychain + Claude CLI prerequisite, B13) | unchanged | conformant |
| LLM transport (Claude Agent SDK in sidecar, L17 override) | chat-driver + orchestrator-driver + validator/driver | conformant |

### Phase G non-default choices — all covered by ADR-0007
| Choice | ADR coverage | Verdict |
|---|---|---|
| TS-only Layer 1 detectors (no bundled binaries) | ADR-0007 "Why TS-only at v1" | documented |
| Founder-only persona (no Developer Dan) | ADR-0007 §"Personas" | documented |
| Separate SDK stream id for validator (vs reuse build session) | ADR-0007 §"Why we run the validator over our own SDK session" | documented |
| Local subprocess Layer 3 (vs microVM sandbox) | ADR-0007 scope-cut table | documented |
| `defects` table separate from `drift_events` | ADR-0007 §"Why defects and drift stay separate" | documented |
| Slopsquat opt-in (not in DEFAULT_DETECTORS) | ADR-0007 "What this ADR does NOT decide" — slopsquat deferred to G7 | documented behaviour, not drift |
| Tier 2 cap restored to 3 attempts | matches spec Flow L AC6 verbatim (closed at `82ca9cf`) | no longer drift |

No silent-assumption drift outstanding for Phase G.

---

## Level 5: NFR check

- **`corepack pnpm verify`**: green this session — 824 unit + 77 integration.
- **Tauri allowlist deny-by-default** (`src-tauri/capabilities/default.json`): permissions = `core:default`, `updater:default`, `dialog:default`, `dialog:allow-open` — deny-by-default with explicit allows. **Conformant** (O12). Phase G's privileged work (filesystem walk, subprocess spawn, git ops) all goes through bespoke Tauri commands or sidecar JSON-RPC; webview cannot bypass.
- **Smoke E2E** (`tests/e2e/`): Playwright harness scaffolded at `1b683c4` (D-004 partial); tauri-driver wiring still deferred. Once wired, `pnpm e2e -- --grep debug` G7 AC and the welcome/chat-smoke specs unblock together.
- **Debug NFRs (per spec.md §6)**:
  - L1 ≤5s on ≤200 files: **enforced** in `tests/integration/sidecar-debug.test.ts` (a0cd3cb).
  - Phase-boundary scan ≤90s before approval modal becomes confirmable: **enforced** in same suite (a0cd3cb); auto-trigger landed at `f3a86b9`.
  - Debug-now cancellable progress indicator: still synchronous — tracked under **D-040** (post-Phase G observability slice).
  - Regression rate ≤15% / auto-downgrade at >25%: telemetry not yet wired — tracked under **D-040**.

---

## Open non-blockers status

- **NB-G-1** — **CLOSED** at `82ca9cf` (Tier 2 cap restored to 3 to match Flow L AC6).
- **NB-G-2** — **CLOSED** at `a0cd3cb` (debug-scan duration budgets tightened to spec NFRs); residual telemetry/UI items re-tracked under D-040.
- **NB-G-3** — **CLOSED** at `f3a86b9` (phase-boundary `debug.scan` auto-trigger wired before approval modal).

---

## Recommended next actions (smallest first)

1. **Cite Flow K AC4/AC9/AC11 explicitly in the head of `docs/adr/0014-preview-bridge-proxy.md`** if the citation is still implicit — verify and edit one line. (Carry-over from Phase G entry recommendation.)
2. **Stand up tauri-driver in the Playwright harness** so `pnpm e2e -- --grep debug` runs against the built Tauri binary. The harness scaffold exists (`1b683c4`); tauri-driver setup is the missing piece. Closes D-004 fully.
3. **D-040 observability slice**: Debug-now progress indicator + cancellation + applied-fix regression-rate telemetry. Tee-up post-Phase H.
4. **Fold `phase_complete` orchestrator marker** into the same approval-gate flow as the debug-scan auto-trigger (`f3a86b9`) so Flow F AC5 closes alongside D-015.

---

**Proceed with corrections in this order? (yes / re-order / skip n)**
