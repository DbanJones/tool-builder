# Decisions log

This file records human-confirmed decisions the Builder design depended on, including those that match the original defaults. New entries append to the top.

## 2026-04-25

1. **Claude interface architecture**: The Builder uses the Claude Code CLI (`claude`) for all Claude interactions, replacing the Anthropic Agent SDK and Vercel AI SDK. The novice authenticates the CLI separately; the Builder holds no Anthropic credential. See [adr/0002-claude-cli-as-orchestrator-interface.md](adr/0002-claude-cli-as-orchestrator-interface.md). Source: human direction.

2. **Sentry opt-in placement**: Rolled into the Welcome screen (not a separate prompt after the first successful build). Source: human direction. Overrides the spec.md §8 default.

3. **Cost-ceiling currency**: GBP fixed (not detected from locale, not USD). Source: human direction (UK-based). Note: per ADR-0002 the Builder no longer enforces a hard daily spend cap; the GBP figure shown is the surfaced estimate from token usage.

4. **GitHub export default visibility**: Private. Matches the spec.md §8 default; recorded here for completeness. Source: human confirmation.
