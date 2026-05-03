# Drift log

Per [rules/07-self-check.md](../rules/07-self-check.md) SC26: every correction or accepted drift is logged here with date, AC id or scope item, drift type, resolution, and commit hash. This is the audit trail.

## 2026-05-03

### D-040 — "Build it" forces a Plan-ack modal that isn't required by the spec
- **Drift type**: implementation drift against Flow E AC1 spirit + Flow M AC1 entry-point semantics.
- **Discovered at**: novice user feedback during a live session — "I've clicked build it several times… echo back is fine, but it should be one screen, not repeated prompts telling the model to build something." A stale `status='building'` row on a prior project ("Echo") was also triggering the concurrent-build conflict prompt on every click; that row was reset to `'ready'` (DB-only fix, no code change) and is not part of this drift.
- **Cause**: [app/project/page.tsx:1634-1637](../app/project/page.tsx#L1634-L1637) opens `PlanAckModal` unconditionally on the first Build it click. Per `spec.md` Flow M AC1 the Plan-ack modal is the entry point for the *Research first* opt-in ("the novice opens the Plan-ack modal and clicks Research first") — it is not specified as a generic pre-build confirmation. Per Flow E AC1, "Readiness auto-confirms once the fast-path is complete (no separate 'Looks right' popup)"; D-024 deliberately removed novice-facing confirmation friction at the build threshold because novices skipped past it without reading. The current code re-introduces the same anti-pattern at the next threshold.
- **Impact**: novices click Build it, see an unexpected modal, dismiss it, and report that the Builder is stuck in interview. Status never flips from `interviewing` → `building`. Erodes the spec.md success metric (deployed Phase 1 app in under 90 minutes, novice unaided).
- **Resolutions** (per SC24 — needs user pick):
  - **(a) Revert code to match spec**: `startBuild()` calls `performBuild()` directly. *Research first* stays a separate top-level action (already present in the Build / Actions dropdown as `id: "research"`). The Plan-ack modal becomes the body of *Research first*, not a wall before Build.
  - **(b) Amend spec via ADR**: keep the modal as a deliberate pre-build pause; rewrite Flow M AC1 to make the modal mandatory rather than a research opt-in. Adds an ADR. Goes against user's stated preference and D-024 precedent.
  - **(c) Park as accepted drift**: leave behaviour as-is, add `// drift-accepted: see ADR-NNNN` + tracker issue. Not recommended — direct user evidence shows the current path harms the success metric.
- **User decision (ratified via Echo-back, 2026-05-03)**: option (b') — amend the spec to mandate a **single Ready-to-build screen** that owns all pre-build confirmation, replacing both the concurrent-build modal and the Plan-ack modal. Not (a) zero confirmation, not (b) formalize the current chain.
- **Resolution**: spec amended at Flow E (trigger + AC1 + AC3) and Flow M (trigger + AC1 + AC6). New [ADR-0018](adr/0018-single-screen-build-confirm.md) records the decision and supersedes the modal-chain implication of D-024 / D-025 + the Plan-ack modal as a generic pre-build wall.
- **Status**: spec amended; ADR-0018 written. Implementation slice pending separate Echo-back per CLAUDE.md.
- **Files changed (this slice)**: `spec.md`, `docs/adr/0018-single-screen-build-confirm.md` (new), `docs/drift-log.md`.
- **Follow-up (implementation slice — separate Echo-back)**: replace the early `setPlanAckOpen(true); return;` branch + the standalone `concurrentBuildPrompt` modal with a Ready-to-build route. The existing `PlanAckModal` contents migrate to the new screen's research card; the existing `setConcurrentBuildPrompt` discriminated state becomes inline UI on the same route. Update unit/integration tests that assert plan-ack-on-build-click; add an E2E asserting a single Build it click on the Ready-to-build screen flips status to `building` with no intermediate dialog.

## 2026-05-02

### D-039 — Phase G EXIT recheck: five-correction batch + boundary approval
- **Drift type**: corrections + drift closures + non-blocker tracking. The Phase G exit `/recheck` ran cleanly (0 blockers, 21 non-blockers carried forward) and recommended five next-actions; this entry records executing all five plus the Phase G boundary approval.
- **Discovered at**: `/recheck` against the post-G7c codebase (commit `f99eed1`). Report at [docs/spec-trace.md](spec-trace.md).
- **Resolutions**:
  - **`82ca9cf`** (#1) — Restored `MAX_TIER2_ATTEMPTS` from 2 to 3 in `sidecar/src/debug/repair/tier2.ts` to match Flow L AC6 verbatim and source spec §E.4. **Closes NB-G-1.**
  - **(no commit; verified)** (#2) — ADR-0014 already cites Flow K AC4/AC9/AC11 from D-038's housekeeping pass.
  - **`1b683c4`** (#3) — Stood up Playwright E2E harness: `playwright.config.ts` + `tests/e2e/smoke.spec.ts` (Next 404 smoke + canary stylesheet check) + `tests/e2e/README.md` documenting the webview-only-vs-tauri-driver split. Three `@tauri-context`-tagged `test.skip` placeholders for Flow A / Flow C / Flow L AC2-AC5 await the `tauri-driver` profile. **Partially closes D-004**; full closure requires `tauri-driver` install + a built signed/stub binary.
  - **`f3a86b9`** (#4) — Added the Flow L AC1 phase-boundary auto-trigger half: a fresh `useEffect` in `app/project/page.tsx` watches `reviewMarkdown !== null` and fires `runDebugScanNow()` exactly once per session. **Closes NB-G-3** (the auto-trigger half). The approval-modal gating half remains under D-015 alongside the `phase_complete` MCP tool.
  - **`a0cd3cb`** (#5) — Tightened `tests/integration/sidecar-debug.test.ts` duration assertions to the §6 NFRs: Layer 1 ≤ 5s, validate=true ≤ 30s (with stub validator). Renamed the existing test for clarity. **Partially closes NB-G-2**; the third NFR (regression rate ≤ 15%) needs runtime telemetry not synthesisable in CI.
- **Boundary approval**: Phase G EXIT self-check PASSED at 12:20:00Z. `.builder/state.json` updated to `phase: "G"` with `phase_g_completed_at: "2026-05-02T12:25:00Z"`, `phase_f_completed_at: "2026-04-29T18:00:00Z"` (back-filled), tests bumped to 945 (824 unit + 77 integration + 44 Rust), drift count 20 non-blockers. `next_task: "WAITING_ON_E0_AND_TAURI_DRIVER_AND_TESTERS"`.
- **Files changed**: `sidecar/src/debug/repair/tier2.ts`, `playwright.config.ts` (new), `tests/e2e/{README.md,smoke.spec.ts}` (new), `app/project/page.tsx`, `tests/integration/sidecar-debug.test.ts`, `.builder/state.json`, `docs/drift-log.md`.
- **Commits**: `82ca9cf`, `1b683c4`, `f3a86b9`, `a0cd3cb`, plus this state-update commit.
- **Follow-up** (now the canonical residual list at the Phase G boundary):
  1. **D-004 full closure** — install `tauri-driver`, add the Tauri-context Playwright profile, lift the `@tauri-context` skips into real specs (Flow A, Flow C, Flow L). Unblocks the spec.md §7 Phase G G7 `pnpm e2e -- --grep debug` AC.
  2. **D-015 full closure** — define + register the `phase_complete` MCP tool; add the approval-modal UI; gate phase advancement on novice review of debug findings. Closes Flow L AC1's gating half + Flow F AC5's phase-boundary modal.
  3. **NB-G-2 third bullet** — wire runtime telemetry for the 50-fix-rolling-window regression-rate NFR. Pre-launch this is a no-op; post-launch the Builder needs an opt-in metric pipeline.
  4. **D-001/D-002/D-016/D-017/D-018/D-019** — long-standing non-blockers carried since Phase D/E. None block any flow today; revisit on next cadence.

## 2026-05-01

### D-038 — Phase G entry: Debug module spec amendment + process-artefact reconciliation
- **Drift type**: scope amendment (Phase G — Debug & repair) plus retroactive scope-drift acceptance for five process artefacts not previously referenced in `spec.md`.
- **Discovered at**: human direction — feed `debug_repair_engine_spec.md` (May 2026) into the planner, decide whether to ship a debug module inside the Builder, and what scope to amend. Companion `/recheck` then surfaced the five long-standing process artefacts as unreferenced scope.
- **Cause (Phase G)**: AI-generated target apps reliably ship a predictable distribution of security, logic, and architectural defects (Veracode 45%, CodeRabbit 1.7×, Apiiro 10×, Lovable / Tea / Base44 / Enrichlead day-of-launch incidents). The Builder is a vibecoding host by the source spec's definition; without a debug module, novices ship the same defects on day one. The market quadrant (founder-friendly + repair-with-verification) is empty per the source spec §H.
- **Cause (process artefacts)**: five items shipped during Phase F and post-F slices without explicit `spec.md` lines: `lib/open-tabs/`, `lib/spreadsheet/`, `lib/easter-egg/`, `chat_messages` table, `permission_requests` table. None are scope creep — they are intentional Phase F infrastructure — but SC15-SC16 flagged them as scope-drift candidates because nothing in `spec.md` referenced them.
- **Resolution**:
  - **ADR-0007** (`docs/adr/0007-debug-module.md`): decision record for the debug module; cites every spec section it triggered (§2 in-scope item, §3 Flow L, §4 `defects` table, §6 debug NFRs, §7 Phase G). Documents the five scope cuts vs. the source spec (TS-only Layer 1, Founder persona only, separate validator stream id, local subprocess Layer 3, defects-vs-drift split).
  - **`spec.md`** amended in five places: §2 in-scope item; new Flow L AC1-AC10 in §3; `defects` + `chat_messages` + `permission_requests` tables in §4; debug scan latency + regression-rate NFRs in §6; Phase G entry in §7. Three additional integration entries in §5 for `lib/open-tabs/`, `lib/spreadsheet/`, `lib/easter-egg/`.
  - **`docs/build-order.md`**: new Phase G section with G1-G7 task definitions, ACs, and definition-of-done.
  - **Schema**: `sidecar/src/schema/defects.ts` (eight-class enum, score components, lifecycle, fix-branch pointers); index.ts re-export; migration `sidecar/migrations/0009_glossy_reavers.sql` generated by drizzle-kit.
  - **ADR-0014** (`docs/adr/0014-preview-bridge-proxy.md`): added the missing "Spec sections triggered" line per SC17 — Flow K AC4, AC9, AC11.
  - **`docs/spec-trace.md`** rewritten: PASS, 0 blockers, 19 known non-blockers carried over.
- **Files changed**: `spec.md`, `docs/adr/0007-debug-module.md` (new), `docs/adr/0014-preview-bridge-proxy.md`, `docs/build-order.md`, `docs/spec-trace.md`, `docs/drift-log.md`, `sidecar/src/schema/defects.ts` (new), `sidecar/src/schema/index.ts`, `sidecar/migrations/0009_glossy_reavers.sql` (new).
- **Commit**: TBD.
- **Follow-up**:
  1. Phase G G2 — Layer 1 detectors + PRIORITY scoring + sidecar `debug.scan` handler. Echo-back required before code.
  2. Tauri-context E2E harness (D-004) is now blocking G7's `--grep debug` AC. Worth pulling forward.
  3. D-016 live-tail <200ms perf harness — close before Phase G adds two more debug-related NFRs.

### D-037 — Demo build: lockout date + admin page + DEMO branding
- **Drift type**: scope drift (new feature outside `spec.md` — soft demo gate for distribution).
- **Discovered at**: human direction — "make an admin page with a logon password. This should be done in conjunction with making this a demo version which locks down on the 31st May and will require a password to unlock. Make sure the file shows as a demo version".
- **Cause**: distribution control. The Builder is being shared as a demo build before the production release; we need a soft expiry plus a way for the maintainer to unlock specific machines without rebuilding.
- **Resolution**:
  - **`lib/demo/`** (new module): `config.ts` holds `DEMO_MODE`, `LOCKOUT_DATE = "2026-05-31"`, `PASSWORD_SHA256` (default password `D4v1dJ0n3s`). `index.ts` provides pure helpers — `isDemoExpired`, `daysUntilLockout`, `lockoutEndOfDay`, `verifyPassword` (Web Crypto SHA-256 with constant-time hex compare), localStorage unlock-token round-trip (`readUnlockToken` / `writeUnlockToken` / `clearUnlockToken`), `isUnlocked` (compares stored token to current hash so a password rotation auto-invalidates every machine), and `shouldShowLock` (combines all of the above).
  - **`DemoGuard`** (`app/components/demo-guard.tsx`): wraps the root layout, hides children behind the lock screen on/after the cutoff. Re-evaluates once an hour while the app is open. SSR-safe (defers the localStorage read to the mount effect).
  - **`DemoLockScreen`** (`app/components/demo-lock-screen.tsx`): full-screen overlay with password prompt; on success persists the unlock token so subsequent launches start unlocked.
  - **Admin route** (`app/admin/page.tsx` + `components/admin-login.tsx` + `admin-dashboard.tsx`): password-gated dashboard at `/admin` showing lockout status, days remaining, demo-expired flag, unlock-token state, plus "Mark unlocked" / "Re-lock" buttons. Same password as the demo-unlock prompt. `authed` is session-only — sign-out clears it but leaves the persisted unlock token alone, so admins re-authenticate per session even on an unlocked machine.
  - **DEMO branding**: window title (`Dave-Builder (Demo)` in Tauri + Next metadata), amber DEMO pill in the tab-bar header, `package.json` name → `dave-builder` and version → `0.1.0-demo`. Visibly distinguishes demo builds from production at a glance.
  - **Password rotation utility**: `scripts/hash-password.mjs` takes a password as an argument and prints the SHA-256 hex digest to paste into config. `.mjs` (not `.ts`) so it runs without a transpiler step.
  - **Trust-model honesty**: documented inline in `lib/demo/config.ts` and on the admin dashboard footnote — soft gate, bypassable by anyone with the source/binary, intended as a speed bump for casual demo users.
- **Files changed**: `lib/demo/config.ts` (new), `lib/demo/index.ts` (new), `lib/demo/index.test.ts` (new, 19 tests), `app/components/demo-guard.tsx` (new), `app/components/demo-lock-screen.tsx` (new), `app/admin/page.tsx` (new), `app/admin/components/admin-login.tsx` (new), `app/admin/components/admin-dashboard.tsx` (new), `scripts/hash-password.mjs` (new), `app/layout.tsx` (DemoGuard wrap, demo-aware title), `src-tauri/tauri.conf.json` (productName + window title), `components/features/tab-bar/tab-bar.tsx` (DEMO pill), `package.json` (name + version + description).
- **Commit**: TBD.
- **Follow-up**:
  1. **Rotate the default password** (`D4v1dJ0n3s`) before sharing the demo more widely — it's intentionally shipped for the initial build but printed in the source so anyone with the repo can read it.
  2. **System clock manipulation** is the obvious bypass. If a hard expiry matters, pair this with a small server-side check (e.g. ping a /demo-status endpoint at startup that returns the canonical lockout state). Out of scope for this slice.
  3. Logic in the bridge of `app/components/demo-guard.tsx` runs on every render of the layout. If the layout re-renders during navigation (it shouldn't in App Router but worth watching), the hourly interval would be re-set on each remount. Cheap regardless; flag if memo profile shows churn.

### D-036 — User-visible rebrand: Builder → Dave-Builder, Claude → Dave on displays
- **Drift type**: scope drift (UI rebrand, no spec change).
- **Discovered at**: human direction — "update the splash screen to call it Dave-Builder. Replace all instances of 'claude' with 'Dave' on the displays and the 'claude is thinking'".
- **Cause**: branding decision for distribution. Internal docs and code identifiers are unchanged; only user-visible strings.
- **Resolution**: replaced "Builder" → "Dave-Builder" in window title (`tauri.conf.json` `productName` + `title`), browser tab metadata (`app/layout.tsx`), tab-bar header link (`components/features/tab-bar/tab-bar.tsx`), and assorted body copy in welcome / sentry-prompt / right-rail empty-state / install card / auth card. Replaced "Claude" → "Dave" in user-visible anthropomorphic mentions: chat-panel "Dave is thinking…", right-rail plan-and-status copy (×4), plan-ack modal copy (×3), permission-prompt banner ("Dave wants to run …"), drag-and-drop hint, concurrent-build prompt, sentry-prompt body. Deliberately KEPT as "Claude" / `claude`: the literal `claude` terminal command in the auth-state instructions, the npm package `@anthropic-ai/claude-code`, the URL `docs.claude.com/claude-code`, "Claude Code" product name where the user must install/sign-in, "your Claude account" — all of these would mislead the novice or break the auth flow if changed.
- **Files changed**: `src-tauri/tauri.conf.json`, `app/layout.tsx`, `app/components/sentry-prompt.tsx`, `app/(welcome)/components/install-state.tsx`, `app/(welcome)/components/auth-state.tsx`, `app/project/page.tsx` (2 user-visible spots), `components/features/tab-bar/tab-bar.tsx`, `components/features/project-workspace/chat-panel.tsx`, `components/features/project-workspace/right-rail.tsx`, `components/features/project-workspace/plan-ack-modal.tsx`, `components/features/project-workspace/permission-prompt-banner.tsx`.
- **Commit**: TBD.
- **Follow-up**:
  1. Internal CLAUDE.md / spec.md / rules/* still reference "Builder" — these are agent-facing instructions and the consistent internal term has remained "Builder". Keep as is unless the rebrand becomes more comprehensive.
  2. Comments in code (e.g. `// Claude ended the turn` in page.tsx) reference Claude qua the LLM; not user-visible, intentionally kept.

### D-035 — Pre-build plan ack + redacted diff snippets in live tail (PR-5 of D-031)
- **Drift type**: scope drift (independent of D-031..D-034 — surfaces existing data more legibly to the novice).
- **Discovered at**: D-031 follow-up review on the recommendation list. Two complementary UX gaps:
  1. The Echo-back Protocol (CLAUDE.md binding rule 10) makes the agent confirm understanding before code; novices have no symmetric checkpoint. They click "Build it" and the agent immediately starts a 60+ minute run with no chance to read the spec one last time.
  2. The live tail tells the novice "Editing app/page.tsx" but not what's being put in app/page.tsx. Trust suffers when changes are invisible until they're committed and the dev server reloads.
- **Cause**: pure UX. No new data, no new infrastructure — the data that should drive both surfaces is already in `spec` state and `HistoryActionEntry.rawInput` respectively.
- **Resolution**:
  - **`PlanAckModal`** (`components/features/project-workspace/plan-ack-modal.tsx`): scrollable spec-preview modal with line count + approved-source-file count + Refine/Go buttons. `startBuild` now opens the modal on the FIRST build of a session (`hasStarted === false`); subsequent rebuilds skip it because they're correction-mode and the gate would be friction. Empty spec disables the Go button.
  - **`extractDiffSnippet`** (`lib/orchestrator/translate.ts`): pure helper that pulls the new content out of Edit/Write/MultiEdit/NotebookEdit `rawInput`, clipped to 10 lines / 400 chars. Returns null for non-mutating tools or empty content.
  - **Right-rail**: each action row now includes a folded `<details>show what changed</details>` block when `extractDiffSnippet` returns content. Computed at render time from existing `rawInput`; no schema change required.
- **Files changed**: `components/features/project-workspace/plan-ack-modal.tsx` (new, ~80 lines), `lib/orchestrator/translate.ts` (`extractDiffSnippet`), `lib/orchestrator/translate.test.ts` (8 new tests covering Edit/Write/MultiEdit/NotebookEdit paths, length clipping, empty-content + malformed-JSON degradation), `app/project/page.tsx` (planAckOpen state, modal render, startBuild gate), `components/features/project-workspace/right-rail.tsx` (`diffSnippet` field on `LiveStatusRow["action"]`, render the folded block).
- **Commit**: TBD.
- **Follow-up**:
  1. **Plan ack on FIRST build only** is a deliberate choice — re-running through the modal on every "I corrected the spec, build again" would be friction. If a real walkthrough surfaces "I want to be reminded of the spec on EVERY build before clicking Go", lift the `!hasStarted` guard or make it a per-project setting.
  2. **Diff snippet is "new content", not "diff"**: showing `+10/-3 lines` for non-coders without context is less useful than showing the actual lines they're getting. If a novice ever asks "but what was there before?", we'd switch to a real diff view (smaller font, +/- gutters). Defer until asked.
  3. **No accessibility test on PlanAckModal yet** — CLAUDE.md F16 / T14 require axe-core gates. The Base UI Dialog primitives we used handle most of it; worth a follow-up axe pass when the next a11y sweep happens.

### D-034 — Iframe-aware capture + per-mark element resolution + auto-snapshots (PR-4 of D-031)
- **Drift type**: scope drift (extends D-031..D-033 — replaces the OS-level capture path with a bridge-rendered DOM capture and adds passive visual progress audit).
- **Discovered at**: D-032 documented the bitmap-coord limitation as a follow-up. PR-4 fulfils that and adds auto-snapshots as a natural continuation.
- **Cause**: D-032 marks lived in screenshot-bitmap pixel space because `screencapture -i` returns a region with no on-screen origin. Per-mark `elementFromPoint` resolution was structurally impossible. Separately, the agent had no visual-progress audit trail — no way to see whether its last edit had the visual effect it expected without asking the novice.
- **Resolution**:
  - **Bridge JS**: protocol v2 gains a `screenshot` request handler. Renders the iframe DOM via the SVG `<foreignObject>` trick (clones `documentElement`, translates to account for scroll, serialises to SVG, draws to canvas, returns base64 PNG). Avoids bundling html2canvas (~50KB) at the cost of a real limitation: cross-origin images and uninlined webfonts may render as fallback. Faithful for typical novice apps (local CSS, system fonts, local images).
  - **Parent helper**: `requestScreenshot(iframe)` with a 5s timeout (DOM rendering is slower than snapshot/resolve roundtrips). Returns null on timeout, ok:false, or render failure — caller falls back to OS region capture.
  - **`captureRegionAndAnnotate`**: two-phase. Phase 1 attempts `requestScreenshot` if the bridge is connected; phase 2 falls back to `screencapture -i`. The capture source is tracked in `annotationCaptureSource` state and threaded through `sendBuildFeedback` so element resolution only runs when marks are in iframe-CSS coords.
  - **Per-mark element resolution**: when `captureSource === "iframe"`, each mark's centre point is computed (`shapeCenter` helper handles box / arrow / text / freedraw centroids) and passed to `resolveElements` over the bridge. The agent receives `<button class="cta">Submit</button>`-style outerHTML for each mark, attached to the sidecar as `resolvedElements[i]` aligned with `marks[i]`.
  - **Auto-snapshot per edit**: `target_snapshot_save` Tauri command writes PNGs to `.builder/snapshots/<ts>-<tool>.png` (50 most-recent kept, prune-on-write). The orchestrator's `tool_use` handler triggers a snapshot 1.5s after each `Edit/Write/MultiEdit/NotebookEdit` (delay lets HMR repaint first). Best-effort: silent skip when bridge isn't ready.
  - **Framed prompt**: now references both `resolvedElements` and `.builder/snapshots/` so the agent knows where to look for visual context.
- **Files changed**: `src-tauri/assets/builder-bridge.js` (foreignObject SVG screenshot handler), `src-tauri/src/lib.rs` (`target_snapshot_save` + `prune_snapshots` + registered), `lib/preview-bridge/request.ts` (`requestScreenshot` + `IframeScreenshot` type + `timeoutMs` parameterised), `lib/preview-bridge/index.ts` (re-exports), `lib/preview-bridge/feedback-sidecar.ts` (`captureSource` + `resolvedElements` fields), `app/project/page.tsx` (two-phase capture, `shapeCenter` helper, `resolveElements` wiring, auto-snapshot in `buildEventHandler`, framed-prompt copy), tests (3 new for `requestScreenshot`, 2 new for sidecar back-compat).
- **Commit**: TBD.
- **Follow-up**:
  1. **Webfont support**: foreignObject doesn't load webfonts that aren't already injected at iframe load time. If a target app uses `@font-face` with an external URL, the rendered PNG falls back to system fonts. Could be addressed by inlining all `<style>` rules + dataURI-encoding `@font-face` URLs before serialisation, but that's substantial. Defer until a real complaint.
  2. **Cross-origin images**: same constraint — `<img src="https://other.example/x.png">` becomes broken in the rendered SVG. Fix is the same proxy idea (route image fetches through the Builder proxy) but expensive. Defer.
  3. **Snapshot at end-of-build**: currently snapshots fire after each `Edit/Write/MultiEdit/NotebookEdit`. We don't take a final snapshot when the build completes (`done` event). Worth a one-line addition so the chronological PNG trail always ends at the post-build state.
  4. **UI surface**: the `.builder/snapshots/` folder is invisible to the novice. A "Visual progress" panel that shows the chronological PNGs would be a small follow-up that turns invisible audit data into novice-visible build storytelling.

### D-033 — Network requests + dev-server stderr now flow into the bridge (PR-3 of D-031)
- **Drift type**: scope drift (extends D-031 / D-032 — adds network + server-side observability to the same bridge channel).
- **Discovered at**: post-D-032 reflection — "the agent has no visibility into why an API call fails". Server-side compilation errors today only land in the Rust log; the agent never sees them.
- **Cause**: PR-1 + PR-2 covered browser-side console + runtime errors and a per-Send sidecar. Two important signals were still missing: the requests the iframe makes (fetch / XHR with status / duration / response sample) and the dev server's own stderr (Module-not-found, EADDRINUSE, TypeError on the server). Both are routinely the root cause when a novice says "this is broken" but the screenshot alone doesn't say why.
- **Resolution**:
  - **Bridge JS**: protocol bumped to v2. Added `network` event with method/url/status/ok/durationMs/responseSample/error fields. Patches `window.fetch` and `XMLHttpRequest`; idempotent (the existing `__builderBridgeLoaded` guard protects against double-patch on HMR).
  - **Parent listener**: parses `network` events, partitions them in errorCount when status is non-2xx or transport-failed; live-tail formatter surfaces failed requests, hides healthy 2xx.
  - **`launch.rs`**: drain task now classifies each line via a small heuristic (error markers: `error:`, `failed to`, `panic`, `module not found`, `EADDRINUSE`, etc; warn markers: `warning`, `deprecat`); error/warn lines are emitted via `app.emit("target-server-event", ...)`. Routine progress lines stay in the log only.
  - **Page wiring**: a useEffect subscribes to `target-server-event` once and pushes incoming events into the bridge listener via the new `pushServerEvent` method, so server events merge into the same live-tail timeline as browser events.
  - **Sidecar schema**: added `network` (cap 30) and `serverErrors` (cap 20) slices. Framed prompt to the agent now references both: "A non-2xx response in the network slice or an 'Error:' in serverErrors is usually the proximate cause."
- **Files changed**: `src-tauri/assets/builder-bridge.js` (network hooks, version bump), `src-tauri/src/launch.rs` (`classify_server_line`, server-event emission, AppHandle threading), `lib/preview-bridge/index.ts` (BridgeNetworkEvent + BridgeServerEvent types, parser branches, errorCount logic, pushServerEvent, formatter branches), `lib/preview-bridge/feedback-sidecar.ts` (network/serverErrors slices), `components/features/project-workspace/right-rail.tsx` (severity classification covers network + server kinds), `app/project/page.tsx` (Tauri event listener, framed-prompt copy), tests (8 new across `index.test.ts`, `feedback-sidecar.test.ts`, `launch.rs`).
- **Commit**: TBD.
- **Follow-up**:
  1. The classifier is a pattern-match heuristic, not a parser. Future regression: if Next or Vite renames its error format, lines may stop classifying. Easy to extend; worth a small periodic check.
  2. Network event payloads include a 500-byte response sample. For binary or streaming responses we deliberately don't sniff. If a target app uses Server-Sent Events or WebSocket-flavoured fetch responses, the sample will be null but the rest of the metadata still flows.
  3. The bridge protocol version bump (v1 → v2) is backward-compatible with the parent listener, but if a future bridge ships v3 the listener should explicitly check `version` before parsing fields that didn't exist in earlier versions. Currently the parser is permissive and would silently ignore fields it doesn't understand.

### D-032 — Annotation Send now ships a structured context sidecar (PR-2 of D-031)
- **Drift type**: scope drift (extends D-031 / D-028 — the agent now receives a JSON sidecar in addition to the rasterised PNG).
- **Discovered at**: same novice walkthrough as D-031 — "the markup should send coordinate information as well as the image".
- **Cause**: D-031 stood up the preview bridge so console + runtime errors flow into the parent. PR-2 finishes the loop by writing `.builder/feedback/<ts>.json` next to the screenshot, giving the agent: iframe URL/viewport/scroll at send time, raw mark coordinates (in screenshot bitmap pixels), recent console buffer, recent error buffer, and a `bridgeConnected` flag so the agent can tell "no errors observed" apart from "we couldn't observe".
- **Resolution**: added `feedback_sidecar_save` Tauri command (1 MB cap, JSON validation, path-sandbox to project root); `lib/preview-bridge/request.ts` (`requestSnapshot`, `resolveElements` helpers over postMessage with 2s timeout returning null on miss); `lib/preview-bridge/feedback-sidecar.ts` (pure assembly fn, 50 console / 20 error rolling caps); annotation modal's `onSend` now emits `marks: Shape[]` alongside `description` and `imageBytes`; `sendBuildFeedback` builds the sidecar via the bridge listener (`getBoundIframe()` + `requestSnapshot()` + ring-buffer events), saves it, and references its path in the framed prompt to the agent. Sidecar save is best-effort — if it fails, the original image-only feedback path runs unchanged.
- **Constraint deliberately accepted**: marks live in screenshot bitmap pixel space, not iframe-DOM CSS pixel space. `screencapture -i` returns a PNG of the dragged region but no information about where on screen the region was, so back-translation to DOM coords is structurally impossible from this capture path. Per-mark `elementFromPoint` resolution (the `resolveElements` helper) is plumbed through and works end-to-end against the bridge — but it is not called from the annotation modal until the capture path moves inside the iframe (xcap or html2canvas-via-bridge in a future slice). The bridge JS already responds to `resolve` requests so that future slice is purely on the parent side.
- **Files changed**: `src-tauri/src/lib.rs` (+`feedback_sidecar_save`, registered), `lib/preview-bridge/request.ts` (new), `lib/preview-bridge/feedback-sidecar.ts` (new), `lib/preview-bridge/request.test.ts` (new, 7 tests), `lib/preview-bridge/feedback-sidecar.test.ts` (new, 5 tests), `lib/preview-bridge/index.ts` (re-exports + `getBoundIframe()`), `components/features/annotation/annotation-modal.tsx` (`onSend` payload now includes `marks`), `app/project/page.tsx` (`sendBuildFeedback` accepts `marks`, builds sidecar, includes path in framed prompt; AnnotationModal callsite forwards marks).
- **Commit**: TBD.
- **Follow-up**:
  1. Iframe-aware capture: replace OS-level region capture with capture-from-iframe (Rust `xcap` crate, or `html2canvas` injected via the bridge). Once shapes land in iframe-CSS coord space, wire `resolveElements` into the modal's Send path so each mark gets a serialised `<button class="cta">`-style annotation. Bridge-side handler is already implemented (PR-1).
  2. Consider a soft "bridge unavailable for >5s after launch" hint in the right rail. Currently the user has no way to know the bridge isn't connected (e.g. CSP blocking the script) other than the absence of the error badge. D-031 noted this; PR-2 doesn't change the situation but inherits it.
  3. The sidecar is text-heavy. Watch its size in real builds — if console event payloads regularly bump against the 1 MB Tauri cap we may need to compress or per-arg-truncate more aggressively (the bridge JS already clips per-arg at 2 KB).

### D-031 — Preview iframe gains an HTTP-layer bridge for richer feedback (PR-1 of 2)
- **Drift type**: scope drift (extension of D-028 / D-030 — adds a Builder-owned proxy in the launch path that didn't exist before).
- **Discovered at**: novice walkthrough — "the markup should send coordinate information as well as the image; it's running in a preview pane, the debug should be able to send richer context. It should also be able to send the console messages."
- **Cause**: today the annotation flow rasterises marks into a PNG and sends pixels + a free-text description. Cross-origin barriers between the Builder webview and the iframe block direct DOM access, console patching, and `window.error` listening from the parent. There is no mechanism for browser-side context (URL, viewport, console output, runtime errors) to reach the agent at the moment the user marks a screenshot — so the agent acts on bitmaps alone, which is much less precise than the iframe makes possible.
- **Resolution**: introduced a Builder-owned HTTP/1.1 proxy (`src-tauri/src/preview_proxy.rs`) that sits in front of the dev server. It injects `<script src="/__builder-bridge.js"></script>` into HTML responses and serves the bridge JS from `src-tauri/assets/builder-bridge.js`. The bridge hooks `console.{log,warn,error,info,debug}`, `window.error`, `unhandledrejection`, and relays each event to `window.parent` via `postMessage`. A parent-side singleton (`lib/preview-bridge/index.ts`) ring-buffers the last 200 events; the right-rail badge subscribes for the error count, and the live-status panel merges browser events into the existing action timeline sorted by timestamp. WebSocket upgrades (Next/Vite HMR) tunnel through unmodified. Failure modes degrade gracefully: if the proxy can't bind we fall back to the upstream URL with no bridge; if the bridge can't load the parent stays `status: "absent"` and the annotation modal works exactly as before. See [docs/adr/0014-preview-bridge-proxy.md](adr/0014-preview-bridge-proxy.md) for the architectural choice (proxy over template-injection / Vite plugin / CDP).
- **Files changed**: `src-tauri/src/preview_proxy.rs` (new), `src-tauri/assets/builder-bridge.js` (new), `src-tauri/src/launch.rs` (proxy lifecycle), `src-tauri/src/lib.rs` (state registration), `src-tauri/Cargo.toml` (tokio feature flags only — no new crate), `lib/launch/index.ts` (`upstreamUrl` field), `lib/preview-bridge/index.ts` (new), `lib/preview-bridge/index.test.ts` (new), `components/features/project-workspace/right-rail.tsx` (iframe ref + badge + merged live status), `docs/adr/0014-preview-bridge-proxy.md` (new).
- **Commit**: TBD.
- **Follow-up**:
  1. PR-2 of 2: DOM resolution (`elementFromPoint` over postMessage), iframe snapshot (URL + viewport + scroll), `.builder/feedback/<ts>.json` sidecar attached to agent prompts, annotation-modal wiring. Builds on this PR's bridge infrastructure.
  2. CSP detection: if a target app sets a strict CSP that blocks the injected script, the bridge silently fails and the parent stays `absent`. Worth surfacing a one-line "console context unavailable" hint in the right rail when `bridge.status === "absent"` but `launchStatus.kind === "running"` for >5 seconds.
  3. The proxy speaks HTTP/1.1 only and forces `Accept-Encoding: identity` upstream. If a future target template uses a dev server that only speaks HTTP/2 or insists on gzip, the proxy will need a small upgrade. Not in scope for current Next/Vite templates.

### D-030 — Preview tab Start button popped browser instead of rendering iframe
- **Drift type**: implementation drift (against Flow K AC8 — "the Preview panel renders an `<iframe>`").
- **Discovered at**: novice walkthrough — "the live preview button still launches the tool in the browser rather than the preview".
- **Cause**: `PreviewPanel`'s `onStart` was wired to the existing `launchApp` callback in `app/project/page.tsx`. `launchApp` is the header **Launch app** button's handler and has a deliberate "give me the link" side effect: when called while `launchStatus.kind === "running"`, it opens the captured URL in the OS default browser. That's correct behaviour for the header button (the user's gesture there is "I want to look at it"), but wrong for the Preview tab (the user's gesture there is "render it inside the Builder"). With both paths sharing one callback, any user who'd ever clicked the header Launch app button before clicking Start preview saw a browser window open instead of the iframe materialising.
- **Resolution**: introduced a separate `startPreviewServer` callback at `app/project/page.tsx` — idempotent (no-op when running or starting), spawns the dev server when idle, never opens externally. Preview tab's `onStartPreview` now wires to this. Header **Launch app** button's `launchApp` callback unchanged.
- **Files changed**: `app/project/page.tsx`.
- **Commit**: TBD.
- **Follow-up**:
  1. Several stacked dev-server processes can accumulate across sessions (each Start preview spawns a fresh one if `launchStatus` was reset to idle by a reload — Next.js bumps to the next free port). `target_app_stop` only kills the currently-tracked process. Worth a "kill orphaned target servers on cold open" pass.
  2. Iframe-doesn't-function bug (separate from this) is iframe-specific behaviour: even with D-028's pointer-lock + Permissions Policy, a canvas/WebGL game waits for user interaction *inside the iframe* before initialising audio + pointer lock. Click directly on the iframe to give it focus — most "shows opening screen but doesn't progress" symptoms resolve with a click into the iframe area.

### D-029 — Process drift: D-023..D-028 bundled into one commit, violating binding rule 9
- **Drift type**: process drift (against CLAUDE.md binding rule 9 — "PRs/commits stay under 400 changed lines").
- **Discovered at**: pre-push reviewer agent run flagged the diff at 2028 insertions / 493 deletions across 33 files (≈5× the 400-line cap).
- **Cause**: the work was *logically* sliced — six discrete drift entries (D-023..D-028) each independently designed via Echo-back, executed, and gated through `corepack pnpm verify` — but the slices were never committed individually as we went. By the time the user asked for a push, `app/project/page.tsx` (854-line diff) had interleaved hunks for D-024 through D-028 that would have been genuinely error-prone to split via `git add -p` after the fact.
- **Resolution**: drift accepted with explicit acknowledgement. Bundled commit lands with a detailed message breaking down each D-NNN; the audit trail in this drift-log already documents per-slice rationale, files, and risks. Future similar work commits at each D-NNN boundary as it's completed.
- **Commit**: TBD (this commit).
- **Follow-up**:
  1. **Process change**: at the end of every slice (after `corepack pnpm verify` passes and a drift-log entry is written), commit immediately rather than continuing to the next slice. This is what binding rule 9 actually wants.
  2. The deferred reviewer suggestion (regression test for `currentSessionId` preservation in stopBuild / openAnnotation / onStopOthersFirst — exactly the silent-revert risk that bites you in three months) is worth a short follow-up commit once this lands. T24 territory.

### D-028 — Preview tab UX hardening: working sandbox, one-click capture, auto-refresh
- **Drift type**: implementation correction (D-027 shipped a preview tab that was technically correct but practically unusable for the stated goal — non-coders testing their built apps).
- **Discovered at**: novice walkthrough on the psychedelic-shooter target app — "It opens the game in my browser. I see a small fragment of the loading screen in the preview pane but it doesn't do anything! I also tried the cmd shift 4 and it creates a screenshot but i cant do anything with it to ingest it back into the tool".
- **Cause**: three independent gaps all biting the same scenario.
  1. **Sandbox too narrow.** D-027's iframe sandbox was `allow-scripts allow-same-origin allow-forms allow-popups allow-modals` — missing `allow-pointer-lock` and the `allow` attribute (Permissions Policy). A shooter that calls `requestPointerLock()` on first click loaded but never initialized; it appeared as a frozen loading screen.
  2. **Capture flow had no obvious next step.** Clicking **Capture & annotate** opened an empty modal expecting drag-drop or paste. Cmd-Shift-4 (the natural OS gesture novices reach for) writes a PNG file to Desktop — there was no path from "screenshot file on Desktop" to "image in modal" without manual file-drag or a copy-as-image trick novices wouldn't know.
  3. **Stale preview.** The agent edits source files but the iframe doesn't reload — relies on the dev server's HMR which can flake inside cross-origin iframes. Novice clicks Refresh manually after every edit, or sees stale state and assumes the agent did nothing.
- **Resolution**:
  - **A. Sandbox + permissions** (`right-rail.tsx` `PreviewPanel` iframe): added `allow-pointer-lock allow-downloads allow-orientation-lock allow-presentation` to the sandbox token list, plus the `allow` attribute with `fullscreen; pointer-lock; autoplay; gamepad; clipboard-read; clipboard-write`. Canvas/WebGL games and media-playback apps now function inside the preview.
  - **B. One-click capture** (`src-tauri/src/lib.rs` new `capture_region_to_png` command + `app/project/page.tsx` new `captureRegionAndAnnotate` callback): wires `screencapture -i -t png <tempfile>` on macOS, reads the PNG bytes, returns base64 to the webview, decodes into a Blob, opens the AnnotationModal with the image already loaded as `initialImage`. ESC-cancellation is silent (no error toast); other failures surface in chat. macOS-only for slice 2.5; cross-platform via `xcap` is a follow-up.
  - **C. Auto-refresh on agent edit** (`app/project/page.tsx` buildEventHandler + new `previewRefreshTrigger` state): on every `tool_use` for `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, increment a counter passed into the iframe's `key`. The iframe re-mounts on each agent file mutation; the user watches changes appear without touching the Refresh button.
  - The Capture button now also pauses any in-flight build (same logic as `openAnnotation` from D-026), so the agent isn't generating against state the novice has just decided is wrong.
- **Files changed**: `src-tauri/src/lib.rs` (+1 command, registered), `app/project/page.tsx` (new `captureRegionAndAnnotate` + `previewRefreshTrigger`, buildEventHandler refresh-trigger branch), `components/features/project-workspace/right-rail.tsx` (sandbox + allow + `externalRefreshTrigger` prop), `spec.md` (Flow K AC10-AC12).
- **Commit**: TBD.
- **Risks acknowledged**:
  1. **macOS-only capture**: Linux/Windows users still get the empty modal flow. They can paste from clipboard or drag a file, but it's not the one-click experience macOS gets. Tracked as Slice 2.6.
  2. **CSP `clipboard-read` / `clipboard-write` permissions** in the iframe `allow` attribute: gives the framed app clipboard access. Acceptable for a single-user desktop app where the novice trusts the apps they're building; not acceptable for a hosted multi-tenant tool.
  3. **Auto-refresh thrash**: an agent that emits 50 Edit calls in a burst will re-key the iframe 50 times. No debounce. If this turns out to be jittery, add a 500ms debounce — for now, the natural pace of Claude's tool calls makes this a non-issue.
  4. **Sandbox `allow-downloads` + `allow-presentation`**: minor expansion of attack surface. Same trust model as #2.
- **Resolved in same slice (post-AC12)**: **Maximize preview** toggle. New button in the PreviewPanel toolbar (`Maximize2` / `Minimize2` Lucide icons) flips the workspace layout from `lg:grid-cols-[minmax(0,1fr)_400px]` (chat 1fr + 400px rail) to `grid-cols-1` (rail full-width, chat hidden). Auto-restores when the user switches off the preview tab (in `onTabChange`) and on ESC (window keydown listener attached only while maximized). Picked over a drag-resize handle because the use case is binary — "I'm testing, get out of the way" vs. "I'm chatting, give me the chat" — and a discrete toggle reads more clearly to a non-coder than a fiddly drag handle.

### D-027 — In-Builder live preview (D-026 Slice 2: iframe of running target app)
- **Drift type**: scope addition (the Slice 2 follow-up of D-026, deferred at the time and shipped now per user direction "can you continue building the in builder slice 2").
- **Discovered at**: post-D-026 review — the user was looking at the Psychedelic Shooter target app and asked how to use the live preview feature, learning Slice 2 wasn't built yet. Spec.md Flow K only covered annotation on dropped/pasted images.
- **Cause**: D-026 Slice 1 left the user still having to OS-screenshot the running app from outside the Builder (Launch app button → external browser → Cmd-Shift-4) and then paste back into the annotation modal. The "preview inside the Builder" half of the original feature design — embedded iframe of `http://localhost:{port}` reusing the existing `lib/launch/` infrastructure — was deferred for CSP + dev-server-lifecycle wrinkles. None of those wrinkles were as bad as feared once tackled.
- **Resolution**:
  - **CSP**: extended `app.security.csp` in `src-tauri/tauri.conf.json` with `frame-src 'self' http://localhost:* http://127.0.0.1:*`. Scoped to localhost ports the user spawned (not `*`), so the attack surface widens minimally — only locally-bound dev servers can render in-frame.
  - **PreviewPanel**: new component in `components/features/project-workspace/right-rail.tsx`. Reads the existing `launchStatus` state machine (idle / starting / running / error). Renders an `<iframe>` with `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"` when running. Refresh works by re-keying the iframe (cheapest forced reload inside Tauri's webview). Toolbar buttons: Refresh, Open externally, Stop preview, Capture & annotate.
  - **RightRail**: added `"preview"` to the `RightTab` union; Preview tab is visible whenever `hasStarted`. Receives `launchStatus`, `onStartPreview` (= existing `launchApp` in page.tsx), `onStopPreview` (= `stopLaunchedApp`), `onCaptureAndAnnotate` (= `openAnnotation` from D-026).
  - No new Rust commands or deps. Reuses `target_app_launch` / `target_app_stop` from `src-tauri/src/launch.rs` (which were already shipped for the header Launch app button per binding rule 13 + O33-O37).
  - `spec.md` Flow K extended with AC7-AC9; original AC1-AC6 unchanged.
- **Files changed**: `src-tauri/tauri.conf.json`, `components/features/project-workspace/right-rail.tsx`, `app/project/page.tsx`, `spec.md`.
- **Commit**: TBD.
- **Risks acknowledged**:
  1. **X-Frame-Options DENY**: target apps that explicitly set `X-Frame-Options: DENY` (or strict CSP `frame-ancestors`) refuse to render inside the iframe. Most dev defaults (Next.js, Vite) don't set these; if a target ever does, the user falls back to the **Open externally** button and the existing OS-screenshot flow. Symptoms: blank iframe + console error. Could detect server-side response headers in a future iteration.
  2. **Auto-capture deferred (Slice 2.5)**: the "Capture & annotate" button just opens the empty AnnotationModal — the user still does Cmd-Shift-4 → Cmd-V. Delivering true one-click capture from the iframe rect needs either Tauri webview screenshot (`WebviewWindow::screenshot()` if it exists in Tauri 2 stable) or a Rust crate like `xcap`. Worth a separate slice; the iframe-in-Builder is the bigger ergonomic win on its own.
  3. **CSP relaxation**: `http://localhost:* http://127.0.0.1:*` widens `frame-src` from `'self'` only. Threat model: a malicious local process bound to a localhost port could render in the Builder if the user navigates to it. Acceptable for a single-user desktop app; not acceptable for a hosted multi-user web app.
- **Follow-up**:
  1. **Slice 2.5**: auto-capture from the iframe via Tauri screenshot, cropping to the iframe's `getBoundingClientRect()` (devicePixelRatio-aware). Skips the Cmd-Shift-4 step entirely.
  2. **HMR awareness**: detect when the dev server reloads (via the iframe's load event or the dev-server stdout) and surface a small "reloaded" toast so the novice knows the agent's edit landed.
  3. **Per-port allowlist**: instead of `http://localhost:*`, narrow CSP `frame-src` to the exact port `target_app_launch` reports back. Requires CSP to be settable at runtime (Tauri 2 supports this via `tauri::WebviewWindow::set_csp` or similar) — not free, but tightens the threat model.

## 2026-04-29

### D-026 — Visual-feedback annotation tool (Slice 1: drop/paste image, draw, send)
- **Drift type**: scope addition (new in-scope flow per user direction; spec.md gains Flow K).
- **Discovered at**: post-D-025 walkthrough — user asked "you need to build in a tool that allows me to preview what has been built" and then refined: "I can pause the tool and feed back into the tool builder the screen and location of where any errors are. For example if a menu bar is missing, I should be able to circle it in the tool and feed that straight back into the builder".
- **Cause**: existing feedback channel was text-only via the BuildPreviewVerifier (D-023). Text loses spatial information — "the menu bar is missing" doesn't tell the agent *where* the menu bar should be. Visual annotations carry that information natively, and Claude has vision so it can act on them directly.
- **Resolution (Slice 1 of two)**:
  - **Slice 1 (this entry)**: annotation tool over a drag-dropped or clipboard-pasted screenshot. The novice OS-screenshots first (e.g. macOS Cmd+Shift+5), drops/pastes into the Builder's annotation modal, marks up with box/arrow/free-draw/text label, types a description, sends.
  - **Slice 2 (deferred)**: in-Builder live preview of the running target app (iframe or Tauri child webview) plus an in-place capture button that feeds the iframe screenshot directly into Slice 1's annotation modal. Defers because of CSP relaxations (`frame-src http://localhost:*`), dev-server lifecycle management (port detection, spawn/stop), and webview-screenshot dependency choice (`tauri-plugin-screenshots` vs. `xcap` crate).
- **Files added/changed for Slice 1**:
  - `src-tauri/src/lib.rs`: `feedback_image_save(project_path, content_base64)` Tauri command. Path-sandboxed to `{project}/.builder/feedback/`, 10 MB cap, PNG magic-bytes check, double canonicalisation guard against symlink escapes. Filename `fb-<unix-secs>-<nanos>.png` for sortable uniqueness.
  - `lib/annotation/index.ts`: pure shape/draw/flatten primitives — `Shape` discriminated union (box | arrow | freedraw | text), `startShape` / `extendShape` / `isShapeCommittable` helpers, `drawShape(ctx, shape)` canvas renderer, `flattenAnnotations(image, shapes)` returning PNG `Uint8Array`, `bytesToBase64` for IPC encoding.
  - `lib/annotation/index.test.ts`: 14 Vitest cases covering shape construction, in-progress extension, the >=4px / >=6px / >=2-points minimums for committable shapes, and immutability of the freedraw point list.
  - `components/features/annotation/annotation-modal.tsx`: native `<dialog>`-based modal (no new dep). Toolbar with the four tools + undo + clear, single-canvas rendering with pointer capture, drag-drop + clipboard-paste source loading, inline error states for >10 MB images and decode failures, description textarea, Send/Cancel.
  - `app/project/page.tsx`: `openAnnotation` callback (per-project orchestrator stop + status `paused` if mid-stream, then `setAnnotationOpen(true)`); **Pause & annotate** button in the workspace header (visible whenever `hasStarted`); `sendBuildFeedback` extended to accept `imageBytes?: Uint8Array` (writes via `feedback_image_save`, prepends path to the chat-visible message, embeds the path in the framed prompt for the agent).
  - `sidecar/src/orchestrator-driver.ts`: one paragraph added to `ORCHESTRATOR_KICKOFF_PROMPT` instructing the agent to Read any `.builder/feedback/*.png` referenced in a turn and treat the annotations as authoritative.
  - `spec.md`: new Flow K with six ACs.
- **Commit**: TBD.
- **Risks acknowledged**:
  1. The agent may fail to look at the referenced PNG even with the system-prompt nudge. Worth a smoke test with a real annotated image before adding more polish; if it ignores the file, escalate the prompt language or include `"Read .builder/feedback/<file>"` as the literal first sentence.
  2. `.builder/feedback/` accumulates PNGs; no auto-clean. The novice can wipe by deleting the folder. Add to project `.gitignore` template if not already in a follow-up.
  3. Workspace-level drag-drop of images currently routes to the file-ingest pipeline (existing behaviour). Slice 1's expectation is the user opens the modal first; smarter routing (drag image → open annotation modal) is a UX-polish follow-up.
  4. Canvas drawing isn't keyboard-accessible (per F12 we'd want shape selection by Tab + arrow-key drawing). Documented gap; not blocking.
- **Follow-up**:
  1. **Slice 2** (in-Builder live preview + in-place capture).
  2. Auto-route workspace image drag-drop → annotation modal when a build has started.
  3. Multi-color palette + line-width control if novices ask for them.
  4. Periodic prune of `.builder/feedback/` (keep last N or last 30 days).
  5. Smoke test the agent's response to a real annotated PNG; iterate the system-prompt paragraph if needed.

### D-025 — Concurrent builds across projects allowed; preempt becomes opt-in via modal
- **Drift type**: spec amendment (with user approval); supersedes D-024's silent-preempt behaviour.
- **Discovered at**: post-D-024 walkthrough — user asked "why can't the tool have two separate builds going at once?" and then "I want it to allow for multiple builds! but ask before launching a new build if there is one already going".
- **Cause**: D-024 silently stopped the in-flight build on Project A when the user clicked Build on Project B. That preserved a process-global single-build invariant that the SDK refactor (ADR-0005) had already obsolesced — the sidecar's orchestrator-driver keys `inflight` runs by stream id, supports per-project / per-stream / cancel-all stop modes, and the Tauri shell mints a fresh UUID per `orchestrator_start` (no shared subprocess state). Treating concurrent builds as forbidden was a stale assumption; treating preempt as automatic discarded in-flight work the user might have wanted to keep.
- **Resolution**:
  - `app/project/page.tsx`: split `startBuild` into a pre-check phase and `performBuild`. When `projects.list` shows ≥1 other project with `status === "building"`, set `concurrentBuildPrompt` state and render `ConcurrentBuildPromptDialog` (a native `<dialog>`-element modal — no new dep, browser-built focus trap + ESC + backdrop). Three actions: **Run alongside** → `setConcurrentBuildPrompt(null)` + `performBuild()`; **Stop them first** → for each conflict await `orchestratorStop({ projectId })` + `projects.setStatus → paused`, then `performBuild()`; **Cancel** → close modal. Default-focused button is **Stop them first** (safer for novices who tab past).
  - `components/features/tab-bar/tab-bar.tsx`: stale "Singleton orchestrator" comment replaced with an accurate description of the per-stream-id inflight model. The "Stop all" button is unchanged in behaviour — `orchestratorStop()` with no args already calls `cancelAllOrchestrators()` on the sidecar (verified at `sidecar/src/index.ts:191`).
  - `spec.md` Flow E: AC3 added describing the modal; old AC3 + AC4 renumbered to AC4 + AC5.
  - The orchestrator path required no refactoring — it was N-safe end-to-end already (sidecar `inflight: Map<streamId, InflightRun>`, `OrchestratorState` Rust marker is empty, fresh UUID per `orchestrator_start`).
- **Files changed**: `app/project/page.tsx`, `components/features/tab-bar/tab-bar.tsx`, `spec.md`.
- **Commit**: TBD.
- **Follow-up** (deferred from this slice; design noted these as polish):
  1. **Aggregate spend badge** in TabBar when ≥2 builds running — sum of per-project `costUsd` so the novice sees doubled burn rate at a glance.
  2. **Rate-limit broadcast**: when one project's build hits a `rate_limit` event, post a one-line note into other in-progress builds' chat scrollback ("Claude rate limit hit — both this and your other build will pause and resume together").
  3. **Race check**: per-project stop-then-start happens in close succession; verify the SDK's session teardown completes before the new `query()` spawns. If a flake appears, await `projects.list` flipping the conflict's status off `"building"` before calling `performBuild`.

### D-024 — Final-check echo-back popup removed; concurrent builds preempt instead of block
- **Drift type**: spec amendment (with user approval).
- **Discovered at**: post-D-023 walkthrough — the user said "I don't need the final check popup, just go through to build" and "if we build a project, it needs to stop the builds on the other projects".
- **Cause**: Flow E AC1 mandated a "Looks right" confirmation popup before any build could start. In practice the novice answered 35 questions, saw a banner that asked them to confirm a thing they'd just spent ~30 minutes constructing, and clicked through without reading. The friction step bought no anti-drift signal that wasn't already covered by the always-visible Spec tab and the post-build "verify against your spec" panel added in D-023. Separately, the cross-project block on concurrent builds forced the novice to navigate back to the other project's tab, find Stop, wait, then re-navigate — when the natural mental model is "I clicked Build on this one, run it now."
- **Resolution**:
  - Echo-back popup deleted from `app/project/page.tsx` (`finalEchoBackOpen` derivation, the alert block, and the dead `EchoBackPreviewBlock` component all removed). `echoBackConfirmed` now auto-flips to `true` inside `refreshSpec` the moment fast-path coverage is complete; readiness UX otherwise unchanged.
  - `startBuild` no longer early-returns on a cross-project conflict. It calls `orchestratorStop({ projectId: conflict.id })`, marks the other project paused, posts an assistant message ("Stopped the in-flight build on X so this one can start. Resume that project from its tab when you're ready."), and proceeds. The dead `otherBuildBlock` state and its banner UI were removed.
  - `skipEchoBackGate` parameter on `startBuild` removed — the merged "Build now" callsite was the only consumer.
  - TabBar's bare `+` icon for new project replaced with a labelled `+ New project` tab item so the navigation is discoverable.
- **Files changed**: `app/project/page.tsx`, `components/features/tab-bar/tab-bar.tsx`, `spec.md` (Flow E AC1 + AC2 reworded).
- **Commit**: TBD.
- **Follow-up**:
  1. Persist `echoBackConfirmed` writes to localStorage are now redundant (always derived) — could remove the localStorage roundtrip in a later cleanup.
  2. The "stopped build on X" notification is text-only via `appendAssistantMessage`. Consider promoting to a transient toast if novices miss it in the chat scrollback.
  3. Per-project stop uses the per-project signal but the orchestrator subprocess is process-global; verify that quick succession (stop → start) doesn't race the SDK session teardown. If it does, add a small await loop on the projects.list status flipping away from "building".

### D-023 — Interview extended to Q1-Q35 to anchor builds to a concrete artifact
- **Drift type**: spec amendment (with user approval). spec.md Flow C AC3 + Flow E "Given" both said Q1-Q32 / 32 fast-path; library and runtime now ship 35.
- **Discovered at**: novice reported the generated tool wasn't matching their request (e.g., a "financial model builder" that didn't produce an Excel file). Root cause: the interview captured features and flows but never pinned down the concrete deliverable (Excel? web view? PDF?), the prior art it should resemble, or the features whose absence would mean reject-the-build.
- **Cause**: Q15 (flows), Q16 (top-flow AC), and Q32 (definition of done) were all action- or feature-shaped, leaving the agent free to pick the *form* of the output. Without a deliverable artifact answer, "financial model builder" was as likely to come back as a web dashboard as an .xlsx.
- **Resolution**: added three fast-path questions:
  - **Q33 (deliverable artifact)**: the concrete thing the end user opens (e.g., ".xlsx with assumptions/P&L/sensitivity tabs"). Renders at the top of spec.md §3.
  - **Q34 (reference anchors)**: 1-3 named existing tools the build should resemble, with similarities and differences. Renders in spec.md §2 between flows and out-of-scope.
  - **Q35 (non-negotiables)**: features whose absence makes the novice reject the build outright (user-supplied idea). Renders in spec.md §3 between deliverable and AC.
- **Files changed**: `lib/interview/library.ts`, `sidecar/src/interview-question-ids.ts`, `lib/interview/rebuild-spec.ts`, `lib/interview/readiness.ts` (comment), `sidecar/src/chat-driver.ts` (system prompt now flags Q33-Q35 as load-bearing). Tests and snapshot updated. Doc updates in spec.md, build-order.md, spec-trace.md, ADR-0005 to match.
- **Commit**: TBD.
- **Follow-up**:
  1. Surface Q33/Q34/Q35 explicitly in the final echo-back UI so the novice signs off on the concrete artifact and non-negotiables, not just an undifferentiated spec scroll.
  2. Add a mid-build preview: at end-of-build, compare what was built against Q33/Q35 and require the novice to confirm "this matches what I pictured" before declaring done. Capture freeform feedback on no.
  3. Eventually feed Q35 (non-negotiables) into the orchestrator's review.md as explicit "must check" items rather than relying on free-form coverage.

## 2026-04-28

### D-022 — Phase F novice-readiness hardening closes several accepted gaps
- **Drift type**: implementation alignment (hardening pass against the codebase review recommendations and prior accepted drift).
- **Discovered at**: review of novice buildability and tool structure after Phase E.
- **Cause**: the product was functionally broad but still carried rough edges that would trip a novice: stop/cancel was stream-id-only, final echo-back was documented but not enforced, file summaries could influence the spec before explicit approval, PII review was too passive, question ids were unconstrained, scripts assumed a global `pnpm`, target-app template rules were placeholders, and several docs still described the pre-SDK CLI/stream-json architecture.
- **Resolution**: implemented in Phase F:
  - `orchestrator.stop` now cancels by stream id, project id, or all active runs as a fallback.
  - Readiness now requires all fast-path answers plus explicit "Looks right" echo-back confirmation before build can start.
  - `record_answer` and `queue_questions` validate ids against Q1-Q32.
  - Uploaded files require approval; PII warnings block the next chat/build action until reviewed or skipped.
  - Approved file summaries are included in `spec.md` section 0 as source materials; PII summaries use redacted text.
  - Target-app template rules are concrete, and nested pnpm calls use `corepack pnpm`.
  - ADR/build/spec/runbook docs now describe the SDK sidecar and current novice gates.
- **Commit**: TBD (Phase F hardening commit).
- **Follow-up**:
  1. Persist file approval/review state in SQLite instead of UI memory.
  2. Replace the remaining placeholder question wording/decision table once the authoritative kit is sourced.
  3. Bundle the sidecar runtime in production installers so novices do not need Node installed.

## 2026-04-25

### D-021 — `--permission-prompt-tool` is SDK-only; reverted Commit B's permission-routing flag wiring
- **Drift type**: implementation drift (against the design in commit 09929ed which assumed `--permission-prompt-tool` was a CLI flag).
- **Discovered at**: 2026-04-27 live test — clicking Start build returned `Orchestrator error: Input must be provided either through stdin or as a prompt argument when using --print`.
- **Cause**: the `--permission-prompt-tool` flag I added to the orchestrator's claude spawn does not exist in the claude CLI surface (it's only available via the Anthropic Agent SDK's `permission_prompt_tool_name` parameter). claude's CLI parser treated it as unknown, but because `--allowed-tools` is variadic (`<tools...>`) the unrecognized flag's value AND the kickoff prompt were both consumed by the variadic, leaving no positional. Spawn failed.
- **Resolution**: drift accepted. Reverted the spawn args to the previous state (`--permission-mode bypassPermissions` + `--add-dir <cwd>`, no `--mcp-config` / `--permission-prompt-tool` / `--allowed-tools` for the orchestrator). The `permission_requests` table, sidecar handlers, dashboard `PermissionPromptBanner`, and `mcp-orchestrator.ts` MCP server all REMAIN in the codebase as dead code (marked `#[allow(dead_code)]` on the Rust helper) so the hooks-based rewire can re-enable them without re-implementing the wiring.
- **Commit**: TBD (revert commit).
- **Follow-up**: implement the permission flow via Claude Code's `PreToolUse` hook system instead of `--permission-prompt-tool`. The hook script (a small shell command) talks to the sidecar's `permissionRequests.append` + `poll` over stdio; on novice click the hook returns `{decision: "block"|"allow"}` to claude. All the existing dashboard UI + DB plumbing stays; only the Rust spawn args + a new hook script change.
- **2026-04-28 update**: ADR-0005 superseded the hook/CLI-spawn path for build orchestration. The build driver now uses the Claude Agent SDK in the Node sidecar, and stop/cancel is wired by project/stream id.

### D-020 — E6 marketing site ships with placeholder downloads + no demo recording
- **Drift type**: scope drift (deferral, against [docs/build-order.md](build-order.md) E6: "one-page Next.js site at apps/marketing/ with download links and a 90-second screen recording").
- **Discovered at**: E6.
- **Cause**: real download links require Phase E0 (signed installer artefacts) and a release pipeline that publishes to a CDN/GitHub Releases — both deferred. The 90-second screen recording can only be made after a real end-to-end build runs in `corepack pnpm tauri dev` (which depends on the user's claude CLI auth + a real test project).
- **Resolution**: drift accepted. E6 ships:
  - `apps/marketing/` — minimal Next.js 15 + React 19 + Tailwind sibling project (NOT a pnpm workspace member; runs via `corepack pnpm install && corepack pnpm dev` from inside the dir; serves on port 3001 to avoid clashing with the root Builder dev server).
  - `apps/marketing/app/page.tsx` — hero + 90s-demo placeholder block + three download cards (macOS/Windows/Linux) gated on a `DOWNLOAD_LINKS_PENDING` flag (currently true). When E0 ships, flip the flag and set the URLs.
  - Root `tsconfig.json` excludes `apps/marketing` so the Builder's strict typecheck doesn't trip on the marketing site's looser settings; ESLint config does the same.
- **Commit**: 08cce5a (E6 commit).
- **Follow-up**:
  1. After E0: replace the placeholder download URLs with real signed-installer URLs and flip `DOWNLOAD_LINKS_PENDING = false`.
  2. After a real build run: capture a 90s screen recording (Loom / OBS), put `demo.mp4` in `apps/marketing/public/`, and set `SCREEN_RECORDING_URL = "/demo.mp4"`.
  3. Configure deploy of the marketing site (Vercel) — separate from the Builder app; uses the same E1 deploy flow.

### D-019 — Sentry SDK integration deferred from E5 (consent capture only)
- **Drift type**: scope drift (deferral, against [rules/06-other.md](../rules/06-other.md) O7 "MUST install Sentry for errors").
- **Discovered at**: E5.
- **Cause**: O7 wants Sentry installed AND opt-in. The opt-in mechanism is the load-bearing novice-facing piece (per spec §8 open question's default answer); the SDK integration itself is a separate Initiative (pick `@sentry/nextjs` vs `@sentry/react` + Sentry's webview-shim, configure DSN, sourcemap upload in CI, beforeSend PII scrubbing per O16, etc.). Bundling both into a single E5 slice would push it past the 400-line ceiling per binding rule 9.
- **Resolution**: drift accepted. E5 ships:
  - `lib/telemetry/index.ts`: `getSentryDecision`/`setSentryDecision` (localStorage), `hasMadeSentryDecision`, and a `reportError(error)` no-op shim that always honours the consent decision (so we cannot accidentally leak PII before consent). 16 unit tests cover the persistence + the privacy guarantee (a Proxy-trapped error payload is not even read when consent is missing).
  - `<SentryPrompt>` Alert with Yes / No / Later buttons + a brief disclaimer naming what we will and will not send (per O16: never chat content, never project paths, never uploaded files).
  - Dashboard triggers the prompt once after the first `done` event, gated on `hasMadeSentryDecision()` being false.
- **Commit**: 85beb46 (E5 commit).
- **Follow-up**: Phase F-style polish ticket adds the SDK:
  1. `corepack pnpm add @sentry/react` (or @sentry/nextjs if the Tauri webview shim works for Next App Router).
  2. Initialise in `app/layout.tsx` gated on `getSentryDecision() === "accepted"`.
  3. Replace the `reportError` body with `Sentry.captureException(error, { extra: scrubExtra(error) })`.
  4. Add `beforeSend` PII scrub per O16.
  5. Configure CI to upload sourcemaps on every signed build (E0-dependent).

### D-018 — E4 ships an OPTIONAL spend cap (not "daily"), reconciling spec §6 vs build-order E4
- **Drift type**: implementation drift (against [docs/build-order.md](build-order.md) E4 wording "daily cap... soft warn at 50%, hard stop at 100%").
- **Discovered at**: E4.
- **Cause**: build-order E4 says "implement the daily cap from spec.md §6 NFR" but [spec.md §6](../spec.md) explicitly says "No hard daily spend cap is enforced by the Builder (deferred to a later phase if required)" and rules/04-libraries.md L23 confirms the same override (per ADR-0002, the claude CLI's underlying account governs throttling). Per rules/00-meta.md precedence the spec wins. Two further sub-decisions:
  1. "daily" → "lifetime" — the existing `costs.sumByProject` returns the per-project total, not today's. A roll-by-day query is a one-line addition but doesn't change the user-visible behaviour at the cap thresholds; it only matters if the novice expects the cap to reset at midnight. Documented here for the day a real use case appears.
  2. localStorage instead of a DB column — the cap is optional and informational; persisting per-project in localStorage avoids a migration for a feature the spec says is opt-in. Move to a project column if the cap ever becomes load-bearing.
- **Resolution**: drift accepted. E4 ships:
  - `lib/cost-ceiling/index.ts`: pure `evaluate(spent, cap) → {state: off|ok|warn|stop, percent, message}`. Default state is "off" (matches spec §6). Soft warn at ≥50%, hard stop at ≥100%. 22 unit tests cover thresholds + storage helpers.
  - Dashboard footer: small `<input type="number">` for the cap (USD); persisted via the localStorage helpers.
  - Above-tail Alert renders when state is "warn" (default variant) or "stop" (destructive variant).
  - Start build button disabled when state is "stop" — the only enforcement, novice-opt-in only.
- **Commit**: 51af9f3 (E4 commit).
- **Follow-up**: when a real use case appears for a day-rolled cap, add `costs.sumByProjectSince(projectId, sinceTs)` and pass the start of the local day; no other code changes needed.

### D-017 — E3 ships updater wiring with placeholder pubkey + endpoint (Phase E0 deferred)
- **Drift type**: scope drift (deferral, against [docs/build-order.md](build-order.md) E3 + [spec.md](../spec.md) Flow J).
- **Discovered at**: E3.
- **Cause**: Phase E0 (Apple Developer ID + Windows code-signing cert + Tauri updater keypair) is deferred per human direction 2026-04-25 — the actual signing artefacts haven't been provisioned, so we have no real `pubkey` to put in `tauri.conf.json` and no signed feed to point `endpoints` at. Building the updater UI + wiring without those is the right move (so when E0 lands the user just swaps two strings in `tauri.conf.json` rather than re-architecting).
- **Resolution**: drift accepted. E3 ships:
  - `tauri-plugin-updater = "2"` Cargo dep + matching `@tauri-apps/plugin-updater` 2.9.0 npm dep.
  - Plugin registered in `lib.rs` setup; `updater:default` capability added.
  - `lib/updater/index.ts` wraps `check()` + `downloadAndInstall()` with neverthrow; recognises the placeholder-pubkey error and translates it into a `NotConfigured` error variant; `checkForUpdateQuiet()` swallows that variant so the launch flow doesn't nag the novice until the real keypair lands.
  - `<UpdatePrompt>` component renders the prompt per Flow J AC2; runs on Welcome page mount.
  - `tauri.conf.json` plugins.updater config has placeholder pubkey `REPLACE_WITH_TAURI_SIGNER_PUBKEY_FROM_PHASE_E0` and endpoint `https://updates.airtec.example/builder/...`.
- **Commit**: bc2ed73 (E3 commit).
- **Follow-up**: when Phase E0 ships:
  1. Run `corepack pnpm tauri signer generate` to produce a keypair.
  2. Replace the `pubkey` in `tauri.conf.json` with the public half.
  3. Replace the `endpoints` URL with the real GitHub Releases / S3 / etc. feed.
  4. Add the private key to GitHub Actions secrets as `TAURI_SIGNING_PRIVATE_KEY` (per E0.3 in build-order).
  No code changes required.

### D-016 — Live-tail latency budget (Flow F AC2 < 200ms) is unverified
- **Drift type**: nfr drift (verification gap, against [spec.md](../spec.md) §6 + Flow F AC2).
- **Discovered at**: Phase D boundary self-check.
- **Cause**: the dashboard achieves sub-200ms perceived latency via optimistic rendering (the live-tail row appears immediately on the orchestrator's `tool_use` event; the sidecar's `actions.append` write happens in parallel and is not awaited). No Vitest performance harness asserts this.
- **Resolution**: drift accepted. The design path is correct (the slow part — file write — is off the critical path) but the budget is unverified.
- **Commit**: de3b0eb (Phase D boundary commit).
- **Follow-up**: Phase E ticket adds a Vitest perf harness that fires N synthetic orchestrator events and asserts the time from event arrival to `actions.length` increment is < 200ms p95.

### D-015 — D5/D6 follow-ups: orchestrator-side report_drift + phase_complete tools, echo-back modal, "task N" recovery suffix
- **Drift type**: scope drift (deferrals, against [docs/build-order.md](build-order.md) D5 second bullet + spec.md Flows E AC1 / F AC5 / H AC4).
- **Discovered at**: Phase D boundary self-check.
- **Cause**: D5 originally scoped to ship the drift banner UI + the drift_events table + drift-log writer (the load-bearing AC) as a single < 400-line slice (binding rule 9). The orchestrator-side automation (report_drift MCP tool + phase_complete marker) was deferred so the slice fit. Same shape applies to Flow E AC1's echo-back modal (deferred under "phase boundary modal" wording) and Flow H AC4's "task N" suffix (depends on F AC5's phase markers, so can't ship before them).
- **Resolution**: drift accepted. The dev "Inject drift" button (now NODE_ENV-guarded as of this audit) gives us manual AC coverage. Phase E follow-up wires:
  - Sidecar SDK tools/callbacks exposing `report_drift({phase, kind, description})` and `phase_complete({phase, summary})` semantics.
  - The orchestrator registers those tools/callbacks through the Claude Agent SDK session.
  - The kickoff prompt instructs claude to call `phase_complete` at phase boundaries and `report_drift` whenever its `/recheck` finds blocker drift.
  - The dashboard shows the echo-back modal on `phase_complete`; the recovered-from-crash banner gains the "resumed at task N" suffix using the latest `phase` from state.json.
- **Commit**: de3b0eb (Phase D boundary commit).
- **Follow-up**: Phase E ticket per the above.
- **2026-04-28 update**: the final echo-back/readiness portion is closed in Phase F. Orchestrator-side `report_drift`, `phase_complete`, and richer recovered-at-task markers remain follow-ups.

### D-014 — D4 ETA observed at TURN granularity, not per-task
- **Drift type**: implementation drift (against [docs/build-order.md](build-order.md) D4: "kit section 14.5.3 estimator with median, P90, online updates").
- **Discovered at**: D4.
- **Cause**: the kit's estimator wants per-task-id observations so the dashboard can say "remaining tasks × per-task estimate". The orchestrator does not yet emit phase/task markers in the SDK stream (D5/Future phase-marker work wires those). Building a per-task estimator now would have nothing to estimate against; building a per-turn estimator now gives the novice live feedback ("a turn takes ~2 min on this build") and is the correct primitive for the per-task estimator on top.
- **Resolution**: drift accepted. D4 ships `lib/eta` as a pure (observations[], elapsedMs) → {median, p90, mode} estimator with full mode transitions (estimating → normal → past_p90) and the honesty fallback. The dashboard records one observation per claude `result.success` event (= one per turn) and labels the footer as "ETA per turn". When D5 wires phase markers, change the observation source from `done` events to `phase_complete` markers; the estimator function does not change.
- **Commit**: 340bd7a (D4 commit).
- **Follow-up**: D5 swaps the observation source. No schema change needed (per-turn durations are kept in component state; the persisted `actions` rows already carry the timestamps for any future per-task derivation).

### D-013 — Chat-message + answer-merging side effects + PII confirm modal deferred from C8
- **Drift type**: scope drift (deferral, against the C8 plan in [docs/build-order.md](build-order.md) section 14.4.2: "after a file lands, ingest it... post a chat message confirming what we extracted; pause-and-ask if PII detected").
- **Discovered at**: C8.
- **Cause**: build-order's C8 covers four loosely-coupled responsibilities: (1) save the file to `{project}/inputs/`, (2) dispatch to the right sidecar handler by kind and run the PII guard, (3) inject a synthetic chat message ("I see you uploaded X — should I proceed on that basis?") that the orchestrator can answer-merge into the spec, (4) render a PII confirmation modal blocking next-send when the guard flags content. Items (3) and (4) each require new wiring: (3) needs a "system message injection" path through `chat_send` plus a way for the interview's `record_answer` flow to consume the file's summary as if the novice had typed it; (4) needs a Radix Dialog with focus trap + masked-hits preview + "send anyway / replace" actions. Both add real surface area beyond the C2-C7 pipeline already shipped.
- **Resolution**: drift accepted. C8 ships items (1) and (2): `lib/files/ingest.ts::ingestFile` saves via the new `file_save_uploaded` Tauri command, dispatches by `IngestedFileKind`, runs `files.guardPii` on extracted text, and returns `{ summary, hasPiiWarning, storedPath }` to the file panel. The summary + PII warning render inline in the file row (status icon flips to a yellow `AlertTriangle` when `hasPiiWarning === true`). The file panel surfaces what was extracted; the chat-message injection and modal-confirm flows land later.
- **Commit**: a0c1c27 (C8 commit).
- **Follow-up**: Phase D ticket adds (a) a `chat.injectSystemMessage` path that posts a "I see you uploaded {name}: {summary}. Proceed on that basis?" message into the interview turn list, route the novice's yes/no through `record_answer` so the file's content lands in the spec; (b) a `<PiiConfirmDialog>` Radix Dialog gated on `files.some(f => f.hasPiiWarning)` that blocks the next chat send until the novice confirms, with a "redact and send" path that swaps in the synthetic-redacted text returned by `files.guardPii`.
- **2026-04-28 update**: Phase F closes the novice-approval and PII-blocking parts. The approved summary is injected into `spec.md` section 0 instead of auto-merging extracted answers. Persistent DB-backed approval state remains a follow-up.

### D-001 — `eslint-plugin-neverthrow` `must-use-result` enforcement gap
- **Drift type**: silent assumption drift (against [CLAUDE.md](../CLAUDE.md) binding rule indirectly via [rules/03-code.md](../rules/03-code.md) C11).
- **Discovered at**: A2 (keychain wrapper) when wiring the rule for the first Result-returning module.
- **Cause**: the only published version of `eslint-plugin-neverthrow` is 1.1.4 (2022). It uses an old `@typescript-eslint` parserServices accessor that throws "Error while loading rule 'neverthrow/must-use-result': types not available" when paired with `@typescript-eslint@8` (the current major). No compatible release exists.
- **Resolution**: drift accepted. Plugin removed from `eslint.config.js`. Convention plus code review (and per-PR `reviewer` subagent) enforces "every Result must be consumed" until one of: (a) a compatible plugin release lands, (b) we fork-and-patch, (c) we migrate to a different result/error library with native lint support.
- **Commit**: 06df4c4 (A2 commit).
- **Follow-up**: monitor https://github.com/mdbetancourt/eslint-plugin-neverthrow for v2 / a flat-config and TS-ESLint v8 compatible release. Re-attempt at next major dep refresh.

### D-002 — shadcn/ui CLI flow not viable in this shell environment; primitives written manually
- **Drift type**: scope drift (resolved differently than originally planned).
- **Discovered at**: A1 (deferred), retried and resolved at A3.
- **Cause**: the `shadcn@latest init` and `shadcn add` commands internally `spawn('pnpm', ...)` for dep installation. In this Claude Code shell environment, that spawned subprocess does not inherit a working PATH to pnpm (which lives at `~/Library/pnpm/pnpm`, not on the system PATH), so shadcn fails with `ENOENT`. PATH propagation worked for the outer invocation but not the nested spawn. Even with `-y -d -f` and various PATH gymnastics it could not be coaxed into completing.
- **Resolution**: shadcn deps were installed manually (`clsx`, `tailwind-merge`, `class-variance-authority`, `lucide-react`, `tw-animate-css`, `@base-ui/react`). The three primitives needed at A3 (`Button`, `Card`, `Alert`) and `lib/utils.ts` (`cn` helper) were hand-written using the canonical shadcn patterns and CSS variable tokens (neutral base color). `tailwind.config.ts` and `app/globals.css` were updated by hand. Output is identical to what shadcn would have produced; only the path differs.
- **Commit**: 81bbc66 (A3 commit).
- **Follow-up**: when adding any further shadcn primitive (Dialog, Form, etc. for A4 onwards), keep writing them by hand from the same patterns. Revisit the CLI in a future session if Claude Code's shell environment changes or pnpm becomes available on the system PATH.

### D-003 — AC5 audit destination is `tauri-plugin-log` rather than `.builder/builder.log` [RESOLVED at A4b]
- **Drift type**: implementation drift (against [rules/06-other.md](../rules/06-other.md) O8 and indirectly Flow A AC5).
- **Discovered at**: A3.
- **Cause**: the audit mechanism needed to land at A3 to satisfy Flow A AC5 (`audit log records app_first_run`). The Drizzle `audit_log` table did not exist yet (no DB layer until A4), and `.builder/builder.log` rotation required file-system glue we had not written. To unblock A3, `audit_log_event` was implemented as a Tauri command that called `log::info!` via the existing `tauri-plugin-log`. Events were logged; the destination was the OS log directory rather than `.builder/builder.log`.
- **Original resolution**: drift accepted as a temporary destination. Migration target: A4b.
- **A3 commit**: 81bbc66.
- **Closure (A4b)**: the Drizzle `audit_log` table now exists in `.builder/builder.db` (per ADR-0004's Node sidecar architecture). `lib/audit/index.ts` calls `sidecarCall("audit.logEvent", ...)` directly; the sidecar handler at `sidecar/src/handlers/audit.ts` inserts a row with a ULID id, default `actor_id = 'novice'`, and a JSON `payload`. The legacy `audit_log_event` Tauri command in `src-tauri/src/lib.rs` is deleted. An integration test (`tests/integration/sidecar-audit.test.ts`) spawns the sidecar against a temp DB and asserts the round-trip.
- **Closure commit**: cbb8128 (A4b commit).
- **Note**: O8 also asks for `.builder/builder.log` daily rotation. The audit destination is now the DB; the application log file (Tauri's `tauri-plugin-log` output) is a separate concern and remains at the OS log dir for now. Tracked separately if/when needed.

### D-010 — Image vision integration tests deferred from C3 (mock-server infra needed)
- **Drift type**: scope drift (deferral, against the C3 plan in [docs/build-order.md](build-order.md): "round-trip a fixture wireframe; summary mentions the visible elements").
- **Discovered at**: C3.
- **Cause**: the `summariseImage` handler is a three-tier fallback (claude CLI -> Anthropic Messages API -> DeepSeek API per the human's 2026-04-26 direction). Testing the CLI tier in isolation needs a fixture `claude` binary on a per-test PATH that returns a controllable JSON response; testing the API tiers cleanly without spending real money or leaking keys needs a local HTTP mock server that pretends to be `api.anthropic.com` and `api.deepseek.com`. Both are doable but each is its own initiative — out of scope for C3 alongside writing the handler itself.
- **Resolution**: drift accepted. C3 ships:
  - `summariseImage` handler with all three tiers implemented and registered in the sidecar (`files.summariseImage`).
  - Clear error path when all tiers fail, telling the user which env vars to set.
  - Manual verification by the user: drop an image into the file panel (once C8 wires the upload flow), check that a summary comes back via whichever tier their machine has.
- **Commit**: 85fbb25 (C3 commit).
- **Follow-up**: Phase D ticket adds (a) a fixture `claude` binary that returns a fixed JSON response, used by Vitest with PATH override; (b) a Vitest setup that intercepts `fetch` to api.anthropic.com / api.deepseek.com and returns canned responses; then 3 tests covering each tier's success path plus the all-fail error message.

### D-012 — Playwright screenshot path for fetchUrl deferred from C6
- **Drift type**: scope drift (deferral, against the C6 plan in [docs/build-order.md](build-order.md): "Headless browser via Playwright; capture homepage screenshot and one inner page. Pass to image vision pipeline.").
- **Discovered at**: C6.
- **Cause**: spinning a headless Chromium in the sidecar adds 250+MB of browser binaries, ~2s of cold-boot per page, and a meaningful packaging burden for production installers (Phase E concern). For the common case of "novice drops a reference URL into the file panel", the textual extraction (title, meta description, h1/h2 outline, body snippet) is enough to seed the chat with context.
- **Resolution**: drift accepted. C6 ships `files.fetchUrl({url})` with HTML fetch + node-html-parser extraction. Returns title, og:description (preferred) or meta description (fallback), up to 10 h1/h2 headings, and a 600-char body snippet (script/style/svg stripped). No screenshot, no JS rendering. The image-vision pipeline at C3 stays available for the screenshot path if/when we wire it.
- **Commit**: 470da84 (C6 commit).
- **Follow-up**: Phase D / E task to add Playwright with `browser-fetch` + screenshot output; route through `files.summariseImage` (C3) for the visual half. Likely valuable when the kit's question library starts asking for "design references" or similar.

### D-011 — SQL-dump data extraction deferred from C5
- **Drift type**: scope drift (deferral, against the C5 plan in [docs/build-order.md](build-order.md): "Data sample (CSV, JSON, SQL dump)").
- **Discovered at**: C5.
- **Cause**: SQL dumps mix CREATE TABLE statements (already handled by `files.parseSchema` at C4) with INSERT row data. Extracting inserted values requires either a full SQL parser pass over potentially large dumps or a streaming `INSERT` regex with column-order tracking; both add real complexity without a clear novice use case for v1.
- **Resolution**: drift accepted. C5 ships CSV (and TSV) + JSON-array-of-objects via `files.parseDataSample`. SQL dumps continue to route to `files.parseSchema` for the schema half; the row data half is deferred. The error message in `parseDataSample` for unsupported extensions explicitly points at this drift entry.
- **Commit**: eb1572f (C5 commit).
- **Follow-up**: when the kit's question library starts asking for sample data shape, reassess. Likely a Phase D / E task once a real novice use case appears.

### D-009 — DOCX + PDF extraction integration tests deferred from C2 (binary fixtures missing)
- **Drift type**: scope drift (deferral, against the C2 plan in [docs/build-order.md](build-order.md): "round-trip a fixture PRD; extracted text contains expected paragraphs").
- **Discovered at**: C2.
- **Cause**: the extractor handler at `sidecar/src/handlers/files.ts` implements all four formats (PDF via unpdf, DOCX via mammoth, MD + TXT via direct read), but there are no real PDF or DOCX fixtures in the repo. Generating minimal valid PDFs/DOCX inline in tests is fiddly (PDFs are byte-precise; DOCX is a multi-file ZIP); checking in real binary fixtures bloats the repo without a clear governance for what they should contain.
- **Resolution**: drift accepted. C2 ships:
  - DOCX + PDF extractors implemented and ready to use.
  - MD + TXT round-trip integration tests against `tests/fixtures/sample.md` and `sample.txt` (5 tests including unsupported-extension + missing-path + summary-bounded behaviour).
  - DOCX + PDF round-trip integration tests deferred until binary fixtures are sourced (e.g. a 1-page sample PDF + 1-page DOCX checked into `tests/fixtures/`).
- **Commit**: 3c7aa4e (C2 commit).
- **Follow-up**: source small (~5 KB each) sample.pdf + sample.docx fixtures, add 2-3 tests asserting expected paragraph content. Could be done at C8 (ingestion contract UI) when real files start landing in `{project}/inputs/` end-to-end.

### D-008 — Promptfoo eval suite for the interview prompt deferred from B5
- **Drift type**: scope drift (deferral, against the B5 plan in [docs/build-order.md](build-order.md)).
- **Discovered at**: B5.
- **Cause**: build-order's B5 says "Eval: a Promptfoo suite with 12 fixture conversations asserts on follow-up presence and 'you choose' handling." Promptfoo is its own infra setup (config, fixtures, CI hookup) and the assertions need a fixed model + reproducible fixtures. Combined with the current absence of the kit's authoritative question phrasing (D-005), an eval suite written today would lock in placeholder behaviour.
- **Resolution**: drift accepted. B5 ships the upgraded interview system prompt directly in `src-tauri/src/chat.rs::INTERVIEW_SYSTEM_PROMPT` covering the four behaviours called out in build-order (one-question-per-turn, follow-ups on vague/contradictory/high-stakes, 'you choose' default-application, topic counter). The Promptfoo suite lands in a Phase D quality task once D-005 is closed (real question phrasing in place) and we've picked a fixed eval model.
- **Commit**: fdfc445 (B5+B6 commit).
- **Follow-up**: Phase D task to add `evals/` with the 12 fixture conversations + `corepack pnpm eval` script.
- **2026-04-28 update**: the live interview prompt/tool path now lives in `sidecar/src/chat-driver.ts` per ADR-0005. The Promptfoo-style eval suite is still deferred.

### D-007 — Spec-preview diff highlighting deferred from B4
- **Drift type**: scope drift (deferral, against the B4 plan in [docs/build-order.md](build-order.md)).
- **Discovered at**: B4.
- **Cause**: build-order's B4 says "Use a Markdown renderer that highlights diffs between renders." Two non-trivial pieces: pick + integrate a Markdown renderer (react-markdown + sanitiser, or remark/rehype pipeline), and compute + render diffs (diff-match-patch or similar, scoped per section). Either alone is fine; both at once for B4 stretches the task. Both are presentation polish, not behaviour.
- **Resolution**: drift accepted. B4 ships the spec preview as monospaced `<pre>`-rendered raw markdown that updates after every chat turn (which is the load-bearing part: "preview reflects current spec"). Markdown rendering and diff highlighting land in a Phase D polish task.
- **Commit**: d61c66f (B4 commit).
- **Follow-up**: Phase D ticket adds react-markdown + a small section-level diff that flashes changed sections for ~3s, per the spec's UX intent.

### D-006 — `.builder/answers.json` legacy file mirror skipped
- **Drift type**: implementation drift (against [docs/build-order.md](build-order.md) B2 wording: "On tool call, the MCP handler writes to `.builder/answers.json` and appends to the answers table.").
- **Discovered at**: B2.
- **Cause**: the build-order calls for double-writing answers to both `.builder/answers.json` and the SQLite `answers` table. The JSON file is a legacy format from the original design pack (used as a portable record). With the sidecar + Drizzle + ULID architecture per ADR-0004, the DB row is the source of truth: it has FK to projects, ordered timestamps, and confidence/source enums. A JSON-file mirror would need careful concurrency handling (two processes writing to the same file) and adds a second source of truth that can drift from the DB.
- **Resolution**: drift accepted. Source of truth is the DB. If a portable JSON export is needed later (e.g. for a "show me my answers" view, or for spec-rebuild input), expose an `answers.exportJson` sidecar method that derives it from the table on demand.
- **Commit**: 163677d (B2 commit).
- **Follow-up**: add the `answers.exportJson` derivation in B3 if the spec-rebuild step needs the JSON shape.

### D-005 — Question library + decision table + spec template seeded as inferred placeholders (extended at B3)
- **Drift type**: scope drift (placeholder content, against the B1 plan in [docs/build-order.md](build-order.md)).
- **Discovered at**: B1, extended at B3.
- **Cause**: the build-order's B1 reads "Copy the kit's question library and decision table into `lib/interview/library.ts` as typed data". B3 extends the same gap: "rebuilds spec.md ... using the kit's spec template" — that template is also missing. The original Build Spec Kit's authoritative content has not been sourced into this repo. Same pattern as the placeholder templates at A4c (per human direction 2026-04-25 to defer real content).
- **Resolution**: drift accepted. `lib/interview/library.ts` ships 32 fast-path questions whose **ids and topics** are taken from `.builder/answers.json` plus the Phase F added app-shape questions (Q29-Q32), but whose **exact prompt strings** are inferred placeholder phrasing. Decision table is a thin starter set covering the most obvious mappings (PII, accessibility, webhooks, jobs, i18n). At B3, `lib/interview/rebuild-spec.ts` ships a section emitter set that mirrors the Builder's own spec.md as a stand-in for the kit's authoritative spec template; the function is pure, deterministic, and snapshot-tested against three fixture answer sets (minimal, partial, full). When the kit is sourced, replace prompt strings + extend decision table + swap section emitters; tests should pass without schema changes.
- **Commits**: a534bd5 (B1), 163677d-ish (B3 extends).
- **Follow-up**: when the kit is sourced, replace `prompt` strings and extend the decision table; tests should still pass without schema changes.

### D-004 — Tauri-context E2E + integration tests deferred to Phase D (extended at A5)
- **Drift type**: scope drift (deferral, against the A3 + A5 plans in [docs/build-order.md](build-order.md)).
- **Discovered at**: A3, extended at A5.
- **Cause**: tests that exercise the real Tauri webview (Welcome E2E from A3, chat smoke E2E from A5, rate-limit integration test from A5) all need `tauri-driver` (a separate setup) or full webview/IPC mocking, both of which are larger than fit inside the originating tasks. The "stubbed `claude` binary on PATH" part is straightforward (a small shell script); the harness around it is the work.
- **Resolution**: drift accepted across both tasks. The logical surface is covered by smaller-scope tests with mocked boundaries:
  - A3: 7 unit tests in `lib/cli-detection/index.test.ts` cover all three Welcome states with `invoke` mocked.
  - A5: historical Rust parser tests in `src-tauri/src/chat.rs` covered the earlier stream-json path; current live chat coverage should target `sidecar/src/chat-driver.ts` and the Channel-based wrapper.
  Real-binary E2E and rate-limit integration land in Phase D when `tauri-driver` is set up.
- **Commits**: 81bbc66 (A3 origin); A5 extends scope (this commit).
- **Follow-up**: Phase D ticket to install `tauri-driver` + fixture `claude` binary, write:
  - `tests/e2e/welcome.spec.ts` covering all three Welcome states.
  - `tests/e2e/chat-smoke.spec.ts` for the happy chat path.
  - `tests/integration/chat-rate-limit.test.ts` for the rate-limit path with a stubbed `claude` returning the rate-limit error.
