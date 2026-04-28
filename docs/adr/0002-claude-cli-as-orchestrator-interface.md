# ADR-0002: Claude Code CLI as the Builder auth prerequisite

## Status
Accepted, 2026-04-25. Superseded for Builder transport by ADR-0005 on 2026-04-27 and narrowed on 2026-04-28.

This ADR remains active for one decision only: the Builder does not collect or store an Anthropic API key. The novice authenticates Claude Code separately, and the local `claude` CLI remains the auth prerequisite checked during first run.

## Context
The original design (CLAUDE.md stack section, [rules/04-libraries.md](../../rules/04-libraries.md) L17, [spec.md](../../spec.md) §5) had two distinct uses of Claude:
1. The orchestrator's own LLM calls (interview chat, file ingestion summaries, drift checks) via the Anthropic Agent SDK plus the Vercel AI SDK, authenticated by an API key the novice pasted into the Welcome screen.
2. Spawning the `claude` CLI as a subprocess to execute build phases against the novice's target app.

The two paths required two different credentials (API key vs Claude Code login), two different cost models (pay-as-you-go vs subscription), and two different streaming/tool-call protocols. The novice paid a duplicated UX cost on Welcome to provision the API key and a separate billing cap.

ADR-0005 later changed the transport choice: interview chat and build orchestration now go through `@anthropic-ai/claude-agent-sdk` inside the Node sidecar. The SDK still relies on the local Claude Code installation/auth state, so this ADR's credential decision is retained.

## Decision
The Builder uses the Claude Code CLI as the novice's Claude authentication surface, not as the primary runtime transport for Builder flows.

The novice's "credential" is having the Claude Code CLI installed and authenticated; the Builder does not store, inspect, or manage that credential. The Welcome screen detects CLI presence and authentication state instead of asking for an API key.

Interview chat and build orchestration are implemented through the Claude Agent SDK in the Node sidecar per ADR-0005. The Vercel AI SDK remains out of the dependency list.

## Consequences

**Positive**
- One credential, one billing surface, one auth UX. The novice does not paste an API key.
- The Builder no longer touches Anthropic secrets directly. Vercel tokens at E1 remain the only thing in the OS keychain.
- The build-phase and interview Claude paths share one sidecar SDK transport: easier to reason about, easier to test, one mock surface for unit tests.
- Subscription users (Pro / Max) get unmetered chat within their tier limits.

**Negative**
- The sidecar is now load-bearing for both interview chat and build orchestration, so production installers must bundle a Node/sidecar runtime instead of assuming a novice has Node installed.
- The Claude Agent SDK is a v0 dependency and must remain pinned and covered by integration tests around the sidecar boundary.
- Rate-limit handling shifts from "billing cap exceeded" to "subscription tier 5-hour window exhausted". The Builder must detect Claude rate-limit errors and surface a graceful "wait until Xm" message. Treated as basic error handling, not a heavy feature.
- Cost meter no longer trivially knows USD per call; instead it counts tokens from SDK usage events and surfaces them as raw token usage with an estimated GBP figure based on the active model's published rate. Subscription users may treat the figure as informational only.

## Affected files
- [CLAUDE.md](../../CLAUDE.md) (stack section, binding rule 4)
- [spec.md](../../spec.md) (§3 Flow A, §5 Integrations, §6 NFRs)
- [rules/02-backend.md](../../rules/02-backend.md) (B13)
- [rules/04-libraries.md](../../rules/04-libraries.md) (L17)
- [docs/build-order.md](../build-order.md) (Phase 0.2, A2, A3, A5, B2)
