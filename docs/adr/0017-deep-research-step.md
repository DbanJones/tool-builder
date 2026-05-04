# ADR-0017: Optional deep-research step between interview and build

**Status**: accepted, 2026-05-02.

## Context

The recursive interview (`Flow C`) reaches readiness once the 35 fast-path questions are answered and the novice confirms echo-back. From that point, `performBuild()` writes `spec.md` from the answer table and the orchestrator session begins. Spec quality is therefore bounded by what the novice typed in 28-35 short-form answers, with no opportunity for a longer "think hard about the gaps" pass before code is written.

In practice, novice-authored specs frequently miss:

- Competitive landscape and obvious feature parity gaps.
- Data-model edge cases (soft deletes, audit trails, multi-tenant boundaries).
- UX flows the novice has not lived through yet (empty/loading/error states by feature, not just by component).
- Non-functional requirements implied by the use case but never stated (rate limits, retention, exportability).

These omissions cascade into mid-build drift events and end-of-build review gaps that the novice has to triage manually. The Debug module (Flow L) catches code-level defects but cannot retroactively expand the spec.

The decision here is whether to (a) add an optional deep-research step that runs before the build, (b) automate the spec expansion silently as part of `performBuild`, (c) ship without one.

(b) is rejected: silent rewriting violates the binding rule "the Builder will not 'fix' novice answers" (`spec.md` §2 explicit non-goals). (c) is rejected because the cascade above is observable in real beta sessions.

## Decision

Add **Flow M: Optional deep research before build** as an opt-in tertiary action inside the Plan-ack modal. Implementation: a sidecar driver (`sidecar/src/research-driver.ts`) modelled on the existing chat driver (ADR-0005), opening a Claude Agent SDK session distinct from the orchestrator session via the `inflight` map. Output flows back via two MCP tools: `record_finding({ topic, body })` for streaming progress into the live tail, and `propose_spec_revision({ markdown, summaryOfChanges })` as the closing action. The proposed spec is held in sidecar memory until the novice opens a side-by-side diff modal and chooses **Use new spec** / **Keep original** / **Discard**.

Cited spec sections: §2 in-scope (added line: optional deep-research expansion), §3 Flow M AC1-AC7.

### Why opt-in only, not auto-launch on readiness

The interview's last action (`record_answer` for Q35 non-negotiables) is a natural transition point, and an automatic deep-research kick-off would feel "smart". We rejected it for three reasons:

1. **Cost surprise.** A 2-5 min Sonnet thinking session sits in the $1-3 range. Forcing every novice to pay that on every project violates the cost-transparency NFR (`spec.md` §6) even with full disclosure.
2. **Reversibility.** Once `spec.md` is overwritten the original is gone unless we backed it up. Opt-in plus an explicit "Keep original" path keeps the novice in control.
3. **Ambiguity rule.** `rules/00-meta.md` says "when two interpretations are plausible, do not pick one; ask." Some novices want the expansion; others typed exactly what they meant and would resent it.

The Plan-ack modal already exists as the "you're about to start something expensive" gate (it's the same modal that shows the spec preview before the build), so the insertion point is free.

### Why a separate SDK session, not a `runFollowUpTurn` on the chat session

Mirrors ADR-0007 §"Why we run the validator over our own SDK session". The interview session's `record_answer` and `queue_questions` tools are inappropriate for a research-and-rewrite turn; the orchestrator session is for build, not pre-build. The sidecar's `inflight` map already supports per-stream concurrency (Flow E AC3). Research opens its own.

### Why the proposed spec is held in sidecar memory, not written to disk first

Two reasons. (1) Avoids a "what if the novice closes the diff modal" race where `spec.md` has been overwritten but the novice never confirmed. (2) Keeps the back-up-original step (`backup_target_spec`) atomic with the overwrite — the original `spec.md` is the backup source, so we cannot overwrite before backing up.

### Why a hard cap of 5 min wall-clock and `maxSteps: 8`

Aligns with rule L19 (default `maxSteps: 8`). The 5-min wall-clock is a defensive cap so a runaway thinking loop cannot block the novice indefinitely. If the cap trips, partial findings are returned and the diff modal labels the proposal "ran out of budget — review with caution".

### Why no per-action cost cap

Decided in the Echo-back phase: the global cost ceiling (`lib/cost-ceiling/`) already disables the entry button at the "stop" state and warns at "warn". Adding a per-action knob complicates the modal without a known-failure mode it would prevent. Revisit if telemetry shows novices repeatedly tripping the global ceiling specifically on research runs.

## Consequences

- **`spec.md` source-of-truth is unchanged.** The interview-derived `spec.md` remains the deterministic baseline (rebuilt every `performBuild` from answers); the deep-research output is a one-time replacement on adoption, with the original preserved at `.builder/spec.pre-research.md`.
- **First use of `lib/llm/prompts/`.** Rule L20 mandates `lib/llm/prompts/{name}.v{n}.md` for all prompts. The interview and orchestrator prompts remain inline strings (pre-existing rule violation, flagged separately as drift D-NNN; not fixed in this ADR's scope).
- **No schema changes.** The target-app `.builder/state.json` is read with `.passthrough()` (`lib/build-state/index.ts`), so `deep_research_completed_at` and `deep_research_token_cost_usd` keys land without a migration. The `costs` table already accepts arbitrary `category` strings.
- **New audit rows.** `deep_research_started`, `deep_research_completed`, `deep_research_cancelled` join the existing audit taxonomy.
- **A new Tauri command.** `backup_target_spec(project_path)` joins `write_target_spec` behind the same path-sandbox guard. Idempotent: only writes if `.builder/spec.pre-research.md` is absent.
- **Cancellable everywhere.** Per C14 + C15. The driver follows the existing `inflight` + `AbortController` pattern (orchestrator-driver.ts).
- **Prompt-injection surface.** Approved file summaries flow into the research prompt. Mitigation: the diff modal forces the novice to review before adoption (the `propose_spec_revision` tool returns to the webview, not directly to disk). The prompt instructs "expand and clarify, do not contradict explicit answers" but does not run an adversarial validator — overkill for a step gated behind explicit human review.

## What this ADR does NOT decide

- The exact wording of the system prompt — that lives in `lib/llm/prompts/deep-research.v1.md` and is bumped to `.v2` etc. without re-opening this ADR.
- Whether to expand to a "deep research between phase boundaries" mode. Out of scope; revisit in a follow-up ADR if the v1 step shows return-on-spend.
- Telemetry to compare adoption-vs-discard rates. Tracked under D-040 (the broader observability slice that also covers Debug regression-rate).
