# ADR-0018 — Single Ready-to-build screen replaces the pre-build modal chain

## Context

Pre-D-040 the build-start path forced a novice through up to two stacked modals after clicking Build it:

1. A **concurrent-build conflict modal** (Flow E AC3, per D-025) surfacing any other project currently `building` with three actions (Run alongside / Stop them first / Cancel).
2. A **Plan-ack modal** (Flow M AC1) opened unconditionally on the first Build it click, hosting the *Research first* opt-in alongside Go / Cancel.

D-024 had previously removed the readiness echo-back popup for the same reason a screen-spanning replacement is needed now: novices clicked through it without reading, so it was friction without protection. The Plan-ack modal re-introduced the same anti-pattern at the next threshold. Live-session feedback on 2026-05-03 ("echo back is fine, but it should be one screen, not repeated prompts telling the model to build something") triggered D-040, which logged the drift and offered three resolutions; the user picked the spec-amendment route to formalize a single confirmation screen rather than zero or two.

## Decision

A single **Ready-to-build screen** owns every pre-build confirmation step. The screen surfaces:

- Spec summary (deliverable / anchors / non-negotiables) — was previously implicit in the Spec tab.
- Concurrent-build conflicts inline (the same three choices, same semantics as Flow E AC3) — replaces the standalone conflict modal.
- Optional *Research first* card with the Flow M trade-off explainer — replaces the Plan-ack modal as the entry point for deep research.
- A **Build it** primary CTA that calls `performBuild()` directly with no further dialogs.

No modal or popup is permitted between this screen and the start of the build. The screen is a full-route view, not a dialog: it has no Esc-to-dismiss, the only forward path is **Build it**, and the only backward path is an explicit **Back to workspace** affordance.

## Consequences

**Positive.**

- Single point of confirmation matches novice mental model ("I clicked the build button, the build started").
- Spec summary becomes load-bearing — the novice sees what they're about to build instead of trusting that the Spec tab was right.
- Concurrent-build conflicts and *Research first* are discoverable from one place; today's flow hid both behind separate modals.
- Removes the D-024 anti-pattern (modal that gets dismissed without reading) at the build threshold without removing the confirmation entirely.

**Negative / risks.**

- A full-screen takeover is a heavier UI than a modal. Mitigation: the screen is data the novice already has (spec summary, conflicts), not new content to absorb.
- Tests that assert the Plan-ack modal opens on Build it click will fail; the implementation slice will need to update them.
- Concurrent-build conflict UI moves from a focused modal to a card on a busier screen. Mitigation: surface the conflict prominently above the Build it CTA so it cannot be missed.
- D-024's underlying concern (skipped echo-backs) applies. Mitigation: full-screen takeover with a single forward CTA is harder to skip than a dismissable modal — the novice cannot Esc past it, and they must actively choose Build it to proceed.

## Spec sections triggered

- `spec.md` Flow E (lines 81-89): trigger ("Ready to build" replaces "Start build"), AC1 (single-screen contract), AC3 (inline conflict surfacing).
- `spec.md` Flow M (lines 175-186): trigger ("Research first on the Ready-to-build screen" replaces "opens the Plan-ack modal"), AC1 (inline research card), AC6 (return path is the Ready-to-build screen).

## Supersedes

- D-024's modal-chain implication for the build-start path. The data-model and rate-limit commitments from D-024 / D-025 are unchanged.
- The Plan-ack modal as a generic pre-build wall. The modal's research-opt-in content moves to the inline card on the Ready-to-build screen.

## Status

Accepted, 2026-05-03. Implementation slice pending separate Echo-back per CLAUDE.md.
