# Decisions log

This file records human-confirmed decisions the Builder design depended on, including those that match the original defaults. New entries append to the top.

## 2026-05-01

1. **Visual feedback annotation tool (D-026 + D-027 + D-028)**: Build a tool that lets the novice pause the build, mark up a screenshot of the running app inside the Builder, and post it back to the orchestrator. Shipped in slices: D-026 annotation modal over a dropped/pasted image; D-027 embedded `<iframe>` preview of the running target app inside the right rail; D-028 fixes — sandbox + permissions for canvas/WebGL games, one-click macOS region capture, auto-refresh on agent edits, maximize toggle. Source: human direction, walk-through with the psychedelic-shooter target. See [drift-log.md](drift-log.md) D-026..D-028.

2. **Concurrent builds across projects allowed (D-025)**: Original design assumed a single-build invariant inherited from the pre-SDK subprocess era. Lifted the invariant; concurrent builds now permitted; user prompted via modal to either Run alongside or Stop the others first when starting a new build with another in flight. Default-focused button is **Stop them first** (safer for novices who tab past). Source: human direction.

3. **Echo-back popup removed; auto-confirm at 35/35 (D-024)**: Original design (Flow E AC1) required an explicit "Looks right" popup before any build could start. In practice the novice answered 35 questions, hit a popup asking them to confirm a thing they'd just spent 30 minutes constructing, and clicked through without reading. Removed the popup; readiness auto-confirms once the fast-path is complete. The deliverable artifact / reference anchors / non-negotiables remain visible in the Spec tab and re-surface in the post-build verifier. Source: human direction.

4. **Interview extended to Q1-Q35 (D-023)**: Added three fast-path questions to anchor the build to a concrete artifact. Q33 (deliverable artifact: the actual file/screen the novice opens), Q34 (reference anchors: 1-3 named existing tools), Q35 (non-negotiables: features whose absence makes the novice reject the build). Driven by failure cases like a "financial model builder" producing a web view rather than an Excel file. Source: human direction.

## 2026-04-28

1. **Phase F hardening recommendations**: Implemented the eight review recommendations as a single novice-readiness pass: SDK sidecar for chat/build, reliable stop/cancel, final echo-back gating, Q1-Q32 validation, file approval, PII review blocking, approved source-material injection, and Corepack/template/docs hardening. See [build-order.md](build-order.md) Phase F and [drift-log.md](drift-log.md) D-022. Source: user direction.

2. **Claude interface architecture update**: ADR-0002 remains active only for the credential decision. The Builder still requires an authenticated `claude` CLI, but interview chat and build orchestration now use the Claude Agent SDK in the Node sidecar. See [adr/0005-claude-agent-sdk-for-orchestrator.md](adr/0005-claude-agent-sdk-for-orchestrator.md). Source: implementation hardening.

## 2026-04-25

1. **Claude interface architecture (superseded for transport on 2026-04-28)**: The Builder originally chose the Claude Code CLI (`claude`) for all Claude interactions, replacing the Anthropic Agent SDK and Vercel AI SDK. The credential portion remains: the novice authenticates the CLI separately; the Builder holds no Anthropic credential. See [adr/0002-claude-cli-as-orchestrator-interface.md](adr/0002-claude-cli-as-orchestrator-interface.md) and [adr/0005-claude-agent-sdk-for-orchestrator.md](adr/0005-claude-agent-sdk-for-orchestrator.md). Source: human direction.

2. **Sentry opt-in placement**: Rolled into the Welcome screen (not a separate prompt after the first successful build). Source: human direction. Overrides the spec.md §8 default.

3. **Cost-ceiling currency**: GBP fixed (not detected from locale, not USD). Source: human direction (UK-based). Note: per ADR-0002/ADR-0005 the Builder no longer enforces a hard daily spend cap by default; the GBP figure shown is the surfaced estimate from token usage.

4. **GitHub export default visibility**: Private. Matches the spec.md §8 default; recorded here for completeness. Source: human confirmation.
