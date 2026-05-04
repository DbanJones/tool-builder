# ADR-0007: Debug and repair module inside the Builder

**Status**: accepted, 2026-05-01.

## Context

`debug_repair_engine_spec.md` (May 2026) describes a standalone debug-and-repair engine for AI-generated code. Its central observations: AI tools ship a predictable distribution of security, logic, and architectural defects; pure-LLM reviewers exhibit 95-100% false-positive rates on classes like SQL injection (per Semgrep's own benchmark); LLM-only patch generators land at 24.8% full-correctness on Vul4J; the empty market quadrant is "solo-founder-friendly + repair-with-verification."

The Builder's target user is exactly that founder, and the Builder's target apps are Next.js 15 + Supabase apps generated wholesale by the orchestrator. The host (the Builder itself) is therefore in the position the source spec calls out: "the host has incentive to say 'looks good' while a third-party has incentive to find defects." We do not want to be that host.

The decision here is whether to (a) build a debug module inside the Builder, (b) integrate a third-party tool (CodeRabbit, Snyk, Apiiro), (c) ship without one.

(b) was rejected because every viable third party either targets developers (CodeRabbit, Greptile — wrong UX), targets enterprises (Apiiro, Veracode — wrong price, wrong procurement model), or runs only in CI on PRs (no PRs in the Builder's flow; the novice never opens GitHub). (c) was rejected because the source spec's incident corpus (Lovable CVE-2025-48757, Tea Firebase exposure, Base44 missing auth, Enrichlead client-side enforcement) is exactly the failure mode our novices ship into; "we built a tool that helps absolute novices ship apps" is not credible if those apps leak users' data on day one.

## Decision

Build a Debug module — `lib/debug/`, `sidecar/src/handlers/debug.ts`, `app/build/components/debug-panel.tsx`, `src-tauri/src/debug.rs` — that runs at every phase boundary and on novice click, scans the target app for the eight defect classes from the source spec, ranks findings with the PRIORITY score, auto-fixes Tier 1, proposes Tier 2 with a verify loop, explains Tier 3, and gates Deploy on critical-band findings.

### Scope cuts vs. the source spec

The source spec is a six-month, seven-person standalone product. The Builder is one feature. We scope down on five axes:

| Axis | Source spec | Builder module |
|---|---|---|
| Languages / frameworks | JS/TS + Python; React/Next/Node/FastAPI/Supabase/Vercel/Netlify | TS + Next.js 15 + Supabase + Vercel only (per `spec.md` §2 in-scope stack) |
| Personas | Founder Fiona + Developer Dan | Founder only — there is no Developer Dan persona in the Builder |
| Layer 1 detectors | ESLint, Ruff, Bandit, Semgrep OSS, gitleaks, OSV-scanner — bundled binaries | TS-only implementations of the equivalents we need (tsc API, regex secret scan, custom Drizzle/Supabase RLS rule, env-leak rule, client-side-auth rule). No bundled binaries at v1. See "Why TS-only" below. |
| Layer 2 LLM | Multi-provider fallback | Reuse the existing Claude Agent SDK in the sidecar (per ADR-0005); separate stream id from the orchestrator session via the existing `inflight` map (per Flow E AC3) |
| Layer 3 sandbox | Firecracker / Modal / e2b microVMs | Local subprocess: `pnpm install && pnpm build` against `{project}/`, plus probe runner over the existing `target_app_launch` localhost dev server (per Flow K). Same trust boundary the Builder already enforces. |

### Why TS-only at v1 (vs. bundled binaries)

`spec.md` §6 caps the installer at 25 MB per platform. gitleaks (~10 MB), osv-scanner (~25 MB), and Semgrep OSS (~150 MB unpacked) blow that budget on their own, before the Tauri shell, sidecar, and webview. Two paths are viable: download-on-first-debug-run or rewrite-in-TS. We choose TS at v1 because:

- The high-frequency vibecoding patterns (Lovable RLS, Tea Firebase exposure, Base44 missing auth) are framework-specific. None of the off-the-shelf scanners catch them out of the box; we'd be writing custom Semgrep rules anyway.
- The detectors we need (regex secret scan, tsc compile, hallucinated-import resolver, client-side-auth AST walk, RLS-on-PII rule over Supabase migrations) are individually small in TS.
- We ship without a network call gating first use — the spec's "novice content never leaves the machine except as prompts to Claude" property stays clean.

Revisit when telemetry shows what we miss. The download-on-demand path is recoverable later.

### Why defects and drift stay separate

`Flow G` (drift detected) already exists, with a banner and three resolution buttons (Revert / Change spec / Accept). The Debug module surfaces a different question — "your code is technically wrong" vs. "your code disagrees with `spec.md`" — and the resolutions are different (apply a fix vs. amend the spec). Merging the surfaces would force the novice to disambiguate before they can choose. Keep separate; revisit if usability testing shows confusion.

### Why we run the validator over our own SDK session, not the orchestrator's

The orchestrator session can be paused mid-build at the phase boundary when Debug runs. Sharing the session would couple validator turns to the build session's permission state and history. The sidecar's `inflight` map (per Flow E AC3) already supports concurrent stream ids per project; Debug opens its own.

### What this ADR does NOT decide

- The exact PRIORITY score weights at v1 (codified in `lib/debug/priority.ts` per the source spec §C; trivially tunable).
- Whether to build a fix-history table or live entirely off `actions`/`history.log`. Default: separate `defects` table because the lifecycle is different (open → fixing → fixed/dismissed), but rollback uses git branches, not row-level history.
- Slopsquat detection. Deferred to G7 — needs an npm registry call + 24h cache; useful but not load-bearing for the eight target incidents.
- Whether the Debug scan blocks or merely flags Phase F's existing approval modal at phase boundaries. Default per L AC1: scan must complete before approval modal can be confirmed; findings do not auto-block (novice can still approve a phase with non-critical findings open).

## Consequences

**Wins**:
- Closes the source spec's identified gap (independent auditor) for the Builder's user segment.
- Reuses every primitive the Builder already has: SDK sidecar (ADR-0005), drift_events surface as the design template (Flow G), audit log + history.log + costs (Phase D), `target_app_launch` (Flow K), keychain, Tauri allowlist.
- Spec-compliant: the eight-class taxonomy, PRIORITY formula, repair pyramid, and verify loop come straight from the source spec; we are adapting, not inventing.

**Losses**:
- A new ~7-task phase (Phase G) before the Builder is "done." Pushes general-availability later.
- TS-only Layer 1 means we own the detector code; bug-for-bug parity with Semgrep / gitleaks is not a goal but the precision/recall numbers in `debug_repair_engine_spec.md` §G.1 are anchored to those tools, so our v1 numbers will trail.
- Layer 2 validator usage adds Claude SDK calls per scan. Cost will be visible on the existing meter; needs caching (per source spec §D.3) to stay reasonable.

## Follow-up

- ADR-0008 if/when we revisit bundled binaries or download-on-demand for Layer 1.
- ADR-0009 if/when slopsquat detection ships and we need to document the npm registry integration.
- `docs/spec-trace.md` will need a new section once Flow L is in `spec.md`.
