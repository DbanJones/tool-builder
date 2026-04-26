# Spec trace report

Per [rules/07-self-check.md](../rules/07-self-check.md) SC10 — overwrite each `/recheck` run.

- **Generated**: 2026-04-26T19:10:00Z (Phase D boundary check).
- **Summary**: PASS — zero blocker drift. Three small follow-ups (one fixed inline; two carry into Phase E).
- **Drift counts**: 0 blockers, 14 non-blockers (D-001, D-002, D-004, D-005, D-006, D-007, D-008, D-009, D-010, D-011, D-012, D-013, D-014, D-015 new). Closed: D-003.
- **Tests**: 179 TS unit + 60 TS integration + 31 Rust unit = 270 passing, 0 failing.

---

## Level 1: Spec coverage (Phase D Flows + new data model + new NFRs)

| Spec item | Status | Pointer |
|---|---|---|
| §3 Flow E AC1 (final echo-back) | n/a | Build dashboard ships without an echo-back gate at present; deferred to Phase E (logged D-015) |
| §3 Flow E AC2 (transition to Build screen) | present | Interview-page link → `/build?project=<id>` (D3) |
| §3 Flow E AC3 (orchestrator spawns with CLAUDE.md + rules/) | present | `orchestrator_start` runs `claude` in expanded project_path; kickoff prompt explicitly reads CLAUDE.md (D1) |
| §3 Flow E AC4 (dashboard begins streaming) | present | OrchestratorEvent stream via Channel<T> appends to live tail (D1+D3) |
| §3 Flow F AC1 (tool call → human line → history.log) | present | translate.ts (19 unit) + actions.append + history.log mirror (10 integration); D2 |
| §3 Flow F AC2 (live-tail latency < 200ms) | partial | Optimistic append + parallel sidecar write achieves the budget by design; no measurement test (logged D-016 below) |
| §3 Flow F AC3 (ETA recomputed) | present | lib/eta + dashboard wiring (D4); per-turn observation (D-014) until D5b wires phase markers |
| §3 Flow F AC4 (cost meter from usage data) | present | costs.append on `done` event + costs.sumByProject in footer (D4) |
| §3 Flow F AC5 (phase-complete marker pauses + shows approval) | n/a | Orchestrator-side `phase_complete` MCP tool deferred to Phase E (logged in D-015) |
| §3 Flow G AC1 (orchestrator pauses on drift) | partial | Banner surfaces drift; "hard pause" deferred to D5b (logged in D-015) |
| §3 Flow G AC2 (banner with 3 buttons) | present | DriftBanner component (D5) |
| §3 Flow G AC3 (resolution writes to drift_events + drift-log.md) | present | drift.resolve + append_drift_log_line; 9 unit + 6 integration (D5) |
| §3 Flow H AC1 (Pause finishes turn, persists state, stops) | present | claude `-p` is turn-bounded; orchestrator_stop + projects.setStatus(paused) preserves session id (D6) |
| §3 Flow H AC2 (UI reflects "Paused, click Resume") | present | Button label flips to "Resume build" when sessionIdRef is set (D6) |
| §3 Flow H AC3 (crash recovery resumes from next incomplete task) | partial | On mount, status==='building' triggers paused + recovered banner; "next incomplete task" depends on F-AC5 phase markers (logged in D-015). No mid-task kill integration test (D-004) |
| §3 Flow H AC4 (banner: "Recovered from crash") | present | Banner shown; "task N" suffix needs F-AC5 (D-015) |
| §4 Data model `actions` | present | sidecar/src/schema/actions.ts; migration 0003 |
| §4 Data model `costs` | present | sidecar/src/schema/costs.ts; migration 0004 |
| §4 Data model `drift_events` | present | sidecar/src/schema/drift-events.ts; migration 0005 |
| §4 Data model `keychain_meta` | n/a | Phase E (Vercel token at E1) |
| §4 Data model — `current_session_id` column on projects | present | Migration 0006 (D6) |
| §6 NFR cost transparency (real-time tokens + GBP/USD estimate) | partial | Tokens + USD live; GBP detection + currency choice deferred (open question §8) |
| §6 NFR rate-limit handling (graceful pause) | present | Inherited from chat.rs; orchestrator surfaces RateLimit event |
| §6 NFR live-tail latency < 200ms | partial | Design satisfied by optimistic rendering; no measurement test (D-016 below) |

No SC11 blocker (no `partial` is older than one phase).

---

## Level 2: AC → tests (Phase D additions)

### Mapped
- **F-AC1 (translate + persist)**: 19 translate unit + 10 actions integration (history.log mirror + parent-dir auto-create + write-failure resilience).
- **F-AC3 (ETA estimator)**: 14 eta unit (percentile maths, mode transitions, formatter, in-progress-not-folded-into-sample).
- **F-AC4 (cost meter)**: 5 costs integration (cents conversion, sum aggregation, zero-aggregate, Zod boundary).
- **G-AC2/AC3 (drift banner + resolve)**: 9 drift unit (dispatcher ordering, DB-first guarantee, partial-success error path) + 6 drift integration (append/listOpen/resolve/idempotency/Zod).
- **H-AC1/AC2 (pause + setStatus)**: 2 orchestratorStop unit + 3 projects.setStatus integration (lifecycle round-trip; sessionId preservation; unknown-id rejection; invalid enum).
- **E-AC3 / Flow F intro (orchestrator)**: 15 Rust unit (parser variants, missing fields, multi-tool, rate-limit detection) + 6 lib/orchestrator unit (Channel wrapper, error propagation).

### Implicit only (no AC-citing test)
- E-AC2 (route exists; manual verification deferred per D-004).
- E-AC4 (streaming surface; covered via parser tests but no end-to-end live-tail assertion).
- F-AC5 (n/a — feature deferred).
- G-AC1 hard pause (n/a — deferred).
- H-AC3 mid-task crash recovery integration (deferred per D-004).
- H-AC4 "task N" rendering (deferred per D-015 — depends on F-AC5).

No AC at the current phase boundary has zero coverage; deferred ACs are explicitly logged.

---

## Level 3: Scope drift candidates

Walked every Phase D addition. **Zero scope drift.**

- **Routes**: `app/build/page.tsx` → Flow E/F dashboard; `app/build/components/drift-banner.tsx` → Flow G AC2.
- **Tauri commands** added in Phase D: `read_target_state`, `read_history_log_tail`, `append_drift_log_line`, `orchestrator_start`, `orchestrator_stop` — all map to E/F/G/H.
- **Sidecar JSON-RPC methods** added in Phase D: `actions.{append,list}`, `costs.{append,sumByProject}`, `drift.{append,resolve,listOpen}`, `projects.setStatus` — all map to spec §3 / §4.
- **DB tables**: `actions`, `costs`, `drift_events` — all in §4 data model. `current_session_id` column — implied by Flow H resume semantics.
- **lib modules**: `lib/orchestrator/`, `lib/eta/`, `lib/drift/`, `lib/build-state/` — all map to E/F/G/H.

---

## Level 4: Silent assumption candidates

### ADR audit
ADR-0002 (Claude CLI), ADR-0003 (keyring-rs), ADR-0004 (Node sidecar) — all unchanged from Phase C boundary, all cite triggering spec sections.

### Non-default choices
- **Orchestrator hardcodes `--model sonnet`**: a defensible default (Sonnet 4.6 is the rate-limit-friendly long-build model) but not user-configurable yet. Logged as drift D-015 (Phase E ticket adds a model picker + ADR if Sonnet remains the default).
- **Dev "Inject drift" button** was visible in production; **fixed inline** during this audit by guarding with `process.env.NODE_ENV !== "production"`.
- **Orchestrator-side `report_drift` + `phase_complete` MCP tools** deferred — logged as part of D-015.
- **Per-turn ETA observation source** (vs per-task) — logged as D-014 (accepted; D5b will swap source without changing the estimator).

---

## Level 5: NFR check

- **pnpm verify**: GREEN (270/270 passing).
- **Tauri capabilities**: `core:default` only, plus the explicit `invoke_handler!` enumeration. No new plugin surface added in Phase D. CSP unchanged.
- **Smoke E2E**: still deferred per D-004; the new Phase D flows compound the deferral but don't change its shape.
- **Live-tail latency budget**: design achieves it via optimistic rendering + parallel sidecar write; no automated measurement (logged D-016).
- **Cost transparency**: live tokens + USD; GBP/locale-detect open question still open.
- **Memory + installer size + accessibility**: unchanged from Phase C boundary; deferred to Phase E.

---

## Drifts logged this boundary

### D-015 — D5/D6 follow-ups: orchestrator-side report_drift + phase_complete MCP tools, echo-back modal, "task N" recovery suffix
- **Drift type**: scope drift (deferral).
- **Resolution**: drift accepted as Phase E follow-ups. The dev "Inject drift" button gives us the AC coverage manually until automation lands.

### D-016 — Live-tail latency budget unverified
- **Drift type**: nfr drift (verification gap).
- **Resolution**: drift accepted. Add a Vitest performance harness in Phase E that asserts orchestrator-event → state-update is < 200ms p95.

(Both will get full entries in `docs/drift-log.md` at the next commit.)

---

## Recommended next actions (smallest first)

1. **Open Phase E**. Bump state.json to `phase: "E"`, set `phase_d_completed_at`. Bookkeeping only.
2. (Phase E) E1 Vercel deploy — first task per build-order.
3. (Phase E ticket) Resolve §8 open question: cost-display currency (GBP/USD/locale). Confirm with user before E1.
4. (Phase E ticket) Wire orchestrator-side `report_drift` + `phase_complete` MCP tools, replace the dev "Inject drift" button, surface "task N" in the recovered banner (D-015 closes).
5. (Phase E ticket) Latency measurement test for the live tail (D-016 closes).
6. (Phase E infrastructure) `tauri-driver` setup + smoke E2E (D-004 closes).
7. (Phase E ticket) Model picker on the dashboard or ADR justifying Sonnet-only default.

No blocker drift at this boundary. D-015 + D-016 carry forward as accepted Phase E follow-ups.
