# Spec trace report — Phase G entry point

Per [rules/07-self-check.md](../rules/07-self-check.md) SC10 — overwrite each `/recheck` run.

- **Generated**: 2026-05-01 (Phase G entry; spec amended with Flow L, defects table, debug NFRs, Phase G).
- **Summary**: PASS — drift detected (0 blockers, 19 known non-blockers). The spec amendment introduced new forward-declared scope (Flow L, Phase G, `defects` table, debug NFRs); Phase G is by design unimplemented. No new blocker drift introduced by the amendment. ADR-0007 cites the spec sections it triggered (§2 in-scope, §3 Flow L, §4 defects, §6 debug NFRs, §7 Phase G).
- **Drift counts**: 0 blockers; 19 open non-blockers carried over (D-001, D-002, D-004…D-020 — D-003 is closed). Recent slices D-022…D-037 are scope-amendments with Echo-back+ADR coverage and not counted as drift.
- **Verification**: per `.builder/state.json`, last `corepack pnpm verify` run is green at 350 tests (246 unit + 60 integration + 44 Rust). Re-run this session against the amended spec: 391 unit + 63 integration green; Rust untouched (no Rust changes in G1).

---

## Level 1: Spec coverage

### §2 In-scope items
| Item | Status | Pointer |
|---|---|---|
| Tauri 2 desktop app + signed installers | present/partial | `src-tauri/`; signing artefacts gated on E0 (D-017) |
| First-run flow (welcome, CLI detect/auth, project create) | present | `app/(welcome)/page.tsx`, `app/(welcome)/new-project/page.tsx` |
| Recursive chat interview populates spec.md | present | `sidecar/src/chat-driver.ts`, `lib/interview/`, `lib/interview/library.ts` (Q1–Q35 per D-023) |
| File ingestion pipeline | present | `lib/files/ingest.ts`, `sidecar/src/handlers/files.ts` |
| Build dashboard with phase bar / live tail / ETA / cost / drift | present | `app/project/page.tsx`, `components/features/project-workspace/`, `lib/eta/`, `lib/orchestrator/translate.ts` |
| Approval gates for phase transitions and drift events | present (drift) / partial (phase boundary) | `components/features/project-workspace/drift-banner.tsx`; phase-boundary modal still deferred (D-015) |
| Pause / resume / stop / crash recovery | present | `src-tauri/src/orchestrator.rs`, `sidecar/src/orchestrator-driver.ts`, `app/project/page.tsx` |
| Deploy preview to Vercel + export to GitHub | present | `lib/deploy/`, `lib/export/`, `src-tauri/src/deploy.rs`, `src-tauri/src/export.rs` |
| Auto-update via Tauri updater | wired/partial | `lib/updater/index.ts`; placeholder pubkey gates real release (D-017) |
| Debug & repair module (NEW per ADR-0007) | n/a not yet built | Phase G unstarted; only `sidecar/src/schema/defects.ts` + migration `0009_glossy_reavers.sql` exist as forward declarations |

### §3 Flows
| Flow | Status | Pointer |
|---|---|---|
| Flow A AC1–AC5 (first run + CLI detection + audit) | present | `app/(welcome)/page.tsx`, `lib/cli-detection/`, `lib/audit/` |
| Flow B AC1–AC4 (project creation + git init + templates + audit) | present | `src-tauri/src/lib.rs:805+` (project_create), `src-tauri/templates/`, `sidecar/src/handlers/projects.ts` |
| Flow C AC1–AC6 (recursive interview, record_answer, spec rebuild, topic counter, audit) | present | `sidecar/src/chat-driver.ts`, `sidecar/src/handlers/answers.ts:24` (Flow C AC6 cited), `lib/interview/rebuild-spec.ts` |
| Flow D AC1–AC6 (classify, PII guard, summary review/block, approval, spec §0 injection, copy to inputs/) | present | `lib/files/ingest.ts`, `sidecar/src/handlers/files.ts`, `sidecar/src/handlers/pii.ts` |
| Flow E AC1 (auto-confirm at fast-path complete; popup removed per D-024) | present | `app/project/page.tsx` `refreshSpec` |
| Flow E AC2 (Start build enables; switches to dashboard) | present | `app/project/page.tsx` `startBuild` |
| Flow E AC3 (concurrent-build modal — Run alongside / Stop them first / Cancel — per D-025) | present | `app/project/page.tsx` `ConcurrentBuildPromptDialog` |
| Flow E AC4 (sidecar SDK session in project folder) | present | `sidecar/src/orchestrator-driver.ts` |
| Flow E AC5 (dashboard streaming) | present | `lib/orchestrator/`, `app/project/page.tsx` |
| Flow F AC1–AC4 (parse tool call, human line, history.log, live tail <200ms, ETA, cost meter) | present (AC2 latency unverified — D-016) | `lib/orchestrator/translate.ts`, `sidecar/src/handlers/actions.ts`, `lib/eta/`, `sidecar/src/handlers/costs.ts` |
| Flow F AC5 (phase complete marker pauses + approval modal) | partial | `report_drift` / `phase_complete` MCP tools deferred (D-015); banner exists for drift only |
| Flow G AC1–AC5 (drift pause/banner/resolve/log/resume) | present | `components/features/project-workspace/drift-banner.tsx:14`, `lib/drift/`, `sidecar/src/handlers/drift.ts` |
| Flow H AC1–AC5 (pause/resume, crash recovery, stop) | present | `src-tauri/src/orchestrator.rs`, `app/project/page.tsx`, `sidecar/src/schema/projects.ts:13` |
| Flow I AC1–AC8 (Vercel deploy + smoke + clipboard + GitHub export) | present (smoke E2E deferred — D-004) | `lib/deploy/index.ts:8,71,76,94`, `lib/export/index.ts:6,61`, `components/features/project-workspace/deploy-modal.tsx:10` |
| Flow J AC1–AC3 (updater check / prompt / install) | wired/partial | `app/(welcome)/page.tsx:64`, `app/components/update-prompt.tsx:10`, `lib/updater/index.ts:58` (E0 gated, D-017) |
| Flow K AC1–AC12 (annotate, paste/drop, save PNG, resume, Preview iframe + maximise + capture + auto-refresh) | present | `components/features/annotation/`, `lib/annotation/`, `components/features/project-workspace/right-rail.tsx` (PreviewPanel), `src-tauri/src/lib.rs` (`feedback_image_save`, `capture_region_to_png`, `target_snapshot_save`), `lib/preview-bridge/` |
| **Flow L AC1–AC10 (debug scan, Debug-now, defects rail, plain-English first, Tier 1/2/3, deploy gate, 7-day rollback, separate validator stream)** | **n/a not yet built** | Phase G unstarted by design; only `defects` schema exists |

### §4 Data model tables
| Table | Status | Pointer |
|---|---|---|
| `projects` | present | `sidecar/src/schema/projects.ts` |
| `answers` | present | `sidecar/src/schema/answers.ts` |
| `files` | present | `sidecar/src/schema/files.ts` |
| `actions` | present | `sidecar/src/schema/actions.ts` |
| `drift_events` | present | `sidecar/src/schema/drift-events.ts` |
| `costs` | present | `sidecar/src/schema/costs.ts` |
| **`defects`** (NEW) | **present** (schema + migration only) | `sidecar/src/schema/defects.ts:7–26`, `sidecar/migrations/0009_glossy_reavers.sql` |
| `keychain_meta` (descriptive — non-DB) | n/a — keychain entries handled via OS keyring | `lib/keychain/`, `src-tauri/src/lib.rs` keychain_get/set/delete |

### §5 Integrations
| Integration | Status | Pointer |
|---|---|---|
| Claude Code CLI (auth backend) | present | `lib/cli-detection/`, ADR-0002 |
| Claude Agent SDK (chat + build, per ADR-0005) | present | `sidecar/src/chat-driver.ts`, `sidecar/src/orchestrator-driver.ts` |
| Vercel CLI | present | `src-tauri/src/deploy.rs`, `lib/deploy/` |
| GitHub CLI (gh) | present | `src-tauri/src/export.rs`, `lib/export/` |
| OS keychain (Vercel token) | present | `lib/keychain/`, `src-tauri/src/lib.rs` |
| Tauri updater | wired/partial | `lib/updater/`, `src-tauri/tauri.conf.json` (placeholder pubkey, D-017) |

### §6 NFRs
| NFR | Status | Notes |
|---|---|---|
| Launch <1.5s to Welcome | unverified | no automated harness yet |
| Chat round-trip <2s med / <5s p95 | unverified | no harness |
| Spec rebuild <500ms | met by design | `rebuildSpec` is pure + synchronous |
| Live tail <200ms | unverified — D-016 | optimistic render path is correct |
| Installer <25 MB / platform | unverified | gated on E0 + sidecar bundling |
| Memory <200 MB idle | unverified | no harness |
| Crash recovery 100% | present | `state.json` + `history.log` + `current_session_id` (D6) |
| WCAG 2.2 AA + axe zero | partial | Base UI gives most; PlanAckModal axe pass deferred (D-035) |
| Privacy: no Anthropic credential held; project content stays local | present | ADR-0002, ADR-0005 |
| Sentry opt-in | partial | consent shim shipped (E5); SDK install deferred (D-019) |
| Cost transparency, rate-limit pause | present | `lib/eta/`, `lib/cost-ceiling/`, rate-limit branch in orchestrator |
| **Debug scan latency: L1 ≤5s; phase-boundary scan ≤90s; Debug-now cancellable** (NEW) | n/a not yet built | Phase G |
| **Debug regression rate ≤15%; auto-downgrade Tier 2 on a project >25%** (NEW) | n/a not yet built | Phase G |

### §7 Phases
| Phase | Status | Pointer |
|---|---|---|
| A (shell + chat) | done | `state.json` `phase_a_completed_at` |
| B (interview + library) | done | `state.json` `phase_b_completed_at` |
| C (file ingestion) | done | `state.json` `phase_c_completed_at` |
| D (build dashboard) | done | `state.json` `phase_d_completed_at` |
| E (deploy/export/auto-update + marketing) | done with deferrals | `state.json` `phase_e_completed_at`; D-017/D-018/D-019/D-020 carry the gaps |
| F (novice-readiness hardening) | done (D-022) | `docs/drift-log.md` D-022 entry |
| **G (debug & repair)** | **n/a not yet built (entry slice G1 in flight)** | ADR-0007, schema, migration only |

---

## Level 2: AC → test traceability

The repo's convention is comment-based citation (`// covers: Flow X ACn`) rather than test-name suffixes. Coverage by inspection:

| AC group | Cited test(s) / source pointer | Verdict |
|---|---|---|
| Flow A AC1–AC5 | `lib/cli-detection/index.test.ts`, `lib/audit/index.test.ts` (audit cites Flow A AC5) | covered (mocked); real Tauri-context E2E deferred — D-004 |
| Flow B AC1–AC4 | `lib/project/index.test.ts`, `tests/integration/sidecar-projects.test.ts`, `tests/integration/sidecar-audit.test.ts` | covered |
| Flow C AC1–AC6 | `lib/interview/library.test.ts`, `lib/interview/rebuild-spec.test.ts`, `lib/interview/readiness.test.ts`, `sidecar/src/handlers/answers.ts:24` (Flow C AC6 cited) | covered |
| Flow D AC1–AC6 | `tests/integration/sidecar-files-extract.test.ts`, `…-parse-data.test.ts`, `…-parse-schema.test.ts`, `…-pii-guard.test.ts`, `lib/files/types.test.ts`, `…-fetch-url.test.ts` | covered (DOCX/PDF binary fixtures deferred — D-009) |
| Flow E AC1–AC5 | `lib/interview/readiness.test.ts`; concurrent-build modal (E AC3) is UI logic — no unit test cites it directly | covered (AC3 needs a regression test — see D-029 follow-up) |
| Flow F AC1–AC4 | `lib/orchestrator/translate.test.ts`, `tests/integration/sidecar-actions.test.ts`, `lib/eta/index.test.ts`, `tests/integration/sidecar-costs.test.ts` | covered (live-tail latency unverified — D-016) |
| Flow F AC5 (phase boundary) | none | partial — D-015 |
| Flow G AC1–AC5 | `lib/drift/index.test.ts`, `tests/integration/sidecar-drift.test.ts` (cites Flow G) | covered |
| Flow H AC1–AC5 | `lib/orchestrator/index.test.ts`, `sidecar/src/schema/projects.ts:13` (cites Flow H AC1/AC3) | covered (kill-mid-task integration test still deferred — D-004) |
| Flow I AC1–AC8 | `lib/deploy/index.test.ts`, `lib/export/index.test.ts`, Rust unit tests in `deploy.rs`/`export.rs` | covered (smoke E2E against URL deferred — D-004) |
| Flow J AC1–AC3 | `lib/updater/index.test.ts` | covered (real signed feed E0-gated — D-017) |
| Flow K AC1–AC12 | `lib/annotation/index.test.ts`, `lib/preview-bridge/index.test.ts`, `lib/preview-bridge/feedback-sidecar.test.ts`, `lib/preview-bridge/request.test.ts`, Rust tests in `launch.rs` | covered |
| **Flow L AC1–AC10** | **none — Phase G not started** | **expected gap** |

**Tests not mapped to ACs**: `tests/unit/sanity.test.ts`, `tests/integration/sanity.test.ts` (canary), and `lib/spreadsheet/index.test.ts`, `lib/demo/index.test.ts`, `tests/unit/david-easter-egg-template.test.ts`, `tests/integration/sidecar-easter-egg.test.ts` belong to scope-additions D-036/D-037 and the easter-egg/spreadsheet primitives. Do not delete; flag for SC14 disposition (see Scope drift candidates).

---

## Level 3: Scope drift candidates

| Item | Spec reference | Disposition |
|---|---|---|
| Routes under `app/` | spec.md §2 + §3 |  |
| `app/(welcome)/page.tsx` + `new-project/` | Flow A, Flow B | in-scope |
| `app/project/page.tsx` | Flows C–K | in-scope |
| `app/admin/page.tsx` (NEW per D-037) | not in spec.md | scope drift accepted — distribution control gate, logged D-037 |
| Tables in `sidecar/src/schema/` | spec.md §4 |  |
| projects/answers/files/actions/drift_events/costs | §4 | in-scope |
| `defects` (NEW) | §4 (newly added) | in-scope (forward declaration for Phase G) |
| `chat_messages`, `permission_requests` | not explicit in §4 | process artefact — internal infra surfaced through ADR-0005's permission bridge / chat persistence; consider adding §4 line in next amendment or escalate |
| `lib/` integrations | §5 |  |
| cli-detection, deploy, export, keychain, sidecar, updater, audit, orchestrator, eta, files, interview, drift, build-state, telemetry, chat, chat-intent, project, cost-ceiling, annotation, launch, preview-bridge | §3 + §5 traceable | in-scope |
| `lib/demo/` (NEW per D-037) | not in spec.md | scope drift accepted — D-037 |
| `lib/easter-egg/`, `lib/spreadsheet/` | not in spec.md | process artefact — deliberate easter-egg / spreadsheet primitives surfaced into target-app templates; spec amendment or formal accept candidate |
| `lib/open-tabs/` | not in spec.md | scope drift candidate — multi-tab UX support (D-024 trail); recommend adding §3/§5 line on next amendment |
| Tauri commands in `src-tauri/src/` (29 commands across deploy/export/launch/orchestrator/sidecar/lib/chat) | §5 + flow ACs | mostly in-scope |
| `target_snapshot_save`, `feedback_sidecar_save`, `capture_region_to_png`, `feedback_image_save` | Flow K (AC4/AC11) + D-031..D-034 | in-scope (some predate Flow K AC11/AC12 — already amended) |
| Orchestrator steps | spec.md Flow F + Phase build-order | in-scope; phase-marker tools (`report_drift`, `phase_complete`) still deferred per D-015 |

**Aggregate verdict**: scope additions in `app/admin/`, `lib/demo/` are explicit accepted drift (D-037). `lib/open-tabs/`, `lib/easter-egg/`, `lib/spreadsheet/`, `chat_messages`, `permission_requests` are process artefacts not formally referenced; recommend a small spec amendment or explicit drift-log accept.

---

## Level 4: Silent assumption candidates

### ADR-to-spec citation audit (SC17)
| ADR | Cites spec section | Verdict |
|---|---|---|
| 0002 (CLI as auth prerequisite) | CLAUDE.md stack, rules/04-libraries.md L17, spec.md §5 | cited |
| 0003 (keyring-rs vs keytar) | rules/04-libraries.md L9c, build-order A2 | cited (rules-derived) |
| 0004 (Node sidecar for SQLite) | CLAUDE.md stack pin | cited |
| 0005 (Claude Agent SDK) | ADR-0002 (which cites spec §5) | cited transitively |
| 0007 (Debug module) | spec.md §2, §3 (Flow L), §4 (defects), §6 NFRs, §7 Phase G | cited explicitly |
| 0014 (Preview bridge proxy) | Flow K (per D-031), spec.md not directly | partial — cite Flow K §3 explicitly in next minor edit |

### Default-catalogue checks (SC18)
| Default | In repo | Verdict |
|---|---|---|
| Pagination (cursor, B10) | actions list uses cursor (`tests/integration/sidecar-actions.test.ts`); answers list ordered by created_at | conformant |
| Job runner (in-process orchestrator, B22) | `sidecar/src/orchestrator-driver.ts` runs in sidecar | conformant |
| ORM (Drizzle, L9) | Drizzle + better-sqlite3 throughout `sidecar/src/schema/` | conformant |
| Auth (OS keychain + Claude CLI prerequisite, B13) | `lib/keychain/`, `lib/cli-detection/`, ADR-0002 | conformant |
| LLM transport (Claude Agent SDK in sidecar, L17 override) | `sidecar/src/chat-driver.ts`, `sidecar/src/orchestrator-driver.ts`, ADR-0005 | conformant |

No new silent assumptions introduced by the spec amendment — ADR-0007 explicitly covers all five Phase G axes (TS-only Layer 1, Founder persona, separate validator stream, local subprocess Layer 3, defects-vs-drift split) with cited spec sections.

---

## Level 5: NFR check (no fresh runs)

- **`corepack pnpm verify`**: green this session (391 unit + 63 integration); no Rust changes, so the 44 Rust unit tests are still green from prior commit.
- **Tauri allowlist deny-by-default**: `src-tauri/capabilities/default.json` lists `core:default`, `updater:default`, `dialog:default`, `dialog:allow-open` only — deny-by-default with explicit allows. Conformant (O12). Most file system + process work goes through bespoke Tauri commands defined in Rust; webview cannot bypass them.
- **Smoke E2E referencing Flow A**: `tests/e2e/` directory does not exist. Welcome E2E + chat smoke E2E remain deferred per long-standing D-004. Existing coverage is via `lib/cli-detection/index.test.ts` (3 Welcome states with mocked invoke) and integration tests; this is the same gap that has been open since A3/A5 and is logged. SC22 conformance status: gap is known, accepted, and re-flagged here as a non-blocker.
- **Debug NFRs (NEW)**: not yet measurable — Phase G unstarted. Spec budgets (≤5s L1, ≤90s phase scan, ≤15% regression) become live the moment Phase G ships its first detector.

---

## Recommended next actions (smallest first)

1. **Cite Flow K in ADR-0014** — one-line edit at the top of `docs/adr/0014-preview-bridge-proxy.md` linking spec.md §3 Flow K AC4/AC9/AC11 to satisfy SC17 cleanly.
2. **Accept-or-reference the four process-artefact scope items** in a single drift-log entry: `lib/open-tabs/`, `lib/easter-egg/`, `lib/spreadsheet/`, plus `chat_messages` + `permission_requests` tables. Decide per item: (a) add a one-liner to spec.md §4/§5, (b) park with `// drift-accepted` + ADR ref, (c) revert. Most are likely (a) — they are intentional Phase F extensions.
3. **Begin Phase G G2** — Layer 1 detectors + PRIORITY scoring + sidecar handler. ADR-0007 + spec amendment + `defects` schema landed; Echo-back gate next.
4. **Pick up the long-deferred D-004 Tauri-context E2E harness** before Phase G ships its first `corepack pnpm e2e -- --grep debug` AC (G7). `tauri-driver` setup unblocks five existing AC gaps simultaneously.
5. **Verify D-016 live-tail <200ms** with the perf harness already designed in the drift entry. Cheap to write; closes one open NFR gap before Phase G adds two more (debug scan latency, regression rate).

---

**Proceed with corrections in this order? (yes / re-order / skip n)**
