# Decisions log

This file records human-confirmed decisions the Builder design depended on, including those that match the original defaults. New entries append to the top.

## 2026-04-28

1. **Phase F hardening recommendations**: Implemented the eight review recommendations as a single novice-readiness pass: SDK sidecar for chat/build, reliable stop/cancel, final echo-back gating, Q1-Q32 validation, file approval, PII review blocking, approved source-material injection, and Corepack/template/docs hardening. See [build-order.md](build-order.md) Phase F and [drift-log.md](drift-log.md) D-022. Source: user direction.

2. **Claude interface architecture update**: ADR-0002 remains active only for the credential decision. The Builder still requires an authenticated `claude` CLI, but interview chat and build orchestration now use the Claude Agent SDK in the Node sidecar. See [adr/0005-claude-agent-sdk-for-orchestrator.md](adr/0005-claude-agent-sdk-for-orchestrator.md). Source: implementation hardening.

## 2026-04-25

1. **Claude interface architecture (superseded for transport on 2026-04-28)**: The Builder originally chose the Claude Code CLI (`claude`) for all Claude interactions, replacing the Anthropic Agent SDK and Vercel AI SDK. The credential portion remains: the novice authenticates the CLI separately; the Builder holds no Anthropic credential. See [adr/0002-claude-cli-as-orchestrator-interface.md](adr/0002-claude-cli-as-orchestrator-interface.md) and [adr/0005-claude-agent-sdk-for-orchestrator.md](adr/0005-claude-agent-sdk-for-orchestrator.md). Source: human direction.

2. **Sentry opt-in placement**: Rolled into the Welcome screen (not a separate prompt after the first successful build). Source: human direction. Overrides the spec.md §8 default.

3. **Cost-ceiling currency**: GBP fixed (not detected from locale, not USD). Source: human direction (UK-based). Note: per ADR-0002/ADR-0005 the Builder no longer enforces a hard daily spend cap by default; the GBP figure shown is the surfaced estimate from token usage.

4. **GitHub export default visibility**: Private. Matches the spec.md §8 default; recorded here for completeness. Source: human confirmation.
