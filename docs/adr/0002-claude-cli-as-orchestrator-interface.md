# ADR-0002: Claude Code CLI as the orchestrator's Claude interface

## Status
Accepted, 2026-04-25.

## Context
The original design (CLAUDE.md stack section, [rules/04-libraries.md](../../rules/04-libraries.md) L17, [spec.md](../../spec.md) §5) had two distinct uses of Claude:
1. The orchestrator's own LLM calls (interview chat, file ingestion summaries, drift checks) via the Anthropic Agent SDK plus the Vercel AI SDK, authenticated by an API key the novice paste into the Welcome screen.
2. Spawning the `claude` CLI as a subprocess to execute build phases against the novice's target app.

The two paths required two different credentials (API key vs Claude Code login), two different cost models (pay-as-you-go vs subscription), and two different streaming/tool-call protocols. The novice paid a duplicated UX cost on Welcome to provision the API key and a separate billing cap.

## Decision
The Builder uses the Claude Code CLI for **all** Claude interactions, not only for build-phase subprocesses. The orchestrator's interview chat, file ingestion summaries, drift audits, and any other LLM call are made by spawning `claude -p --output-format stream-json` subprocesses. Where tool use is required (e.g. `record_answer`), the orchestrator hosts a local MCP server and the CLI consumes it via `--mcp-config`.

The novice's "credential" is having the Claude Code CLI installed and authenticated; the Builder does not store, inspect, or manage that credential. The Welcome screen detects CLI presence and authentication state instead of asking for an API key.

The Anthropic Agent SDK and the Vercel AI SDK are removed from the dependency list.

## Consequences

**Positive**
- One credential, one billing surface, one auth UX. The novice does not paste an API key.
- The Builder no longer touches Anthropic secrets directly. Vercel tokens at E1 remain the only thing in the OS keychain.
- The build-phase and interview Claude paths share one transport: easier to reason about, easier to test, one mock surface for unit tests.
- Subscription users (Pro / Max) get unmetered chat within their tier limits.

**Negative**
- Spawning a subprocess per chat turn adds latency vs in-process SDK calls. Mitigation: keep the CLI process warm where feasible, or accept the added cost (a few hundred ms) against the spec.md §6 5s p95 budget.
- Tool calls (`record_answer`, ingestion outputs) require an MCP server in the Builder process. Slightly more wiring than direct Agent SDK tool definitions.
- Rate-limit handling shifts from "billing cap exceeded" to "subscription tier 5-hour window exhausted". The Builder must detect the CLI's rate-limit error and surface a graceful "wait until Xm" message. Treated as basic error handling, not a heavy feature.
- Cost meter no longer trivially knows USD per call; instead it counts tokens via stream-json output and surfaces them as raw token usage with an estimated GBP figure based on the active model's published rate. Subscription users may treat the figure as informational only.

## Affected files
- [CLAUDE.md](../../CLAUDE.md) (stack section, binding rule 4)
- [spec.md](../../spec.md) (§3 Flow A, §5 Integrations, §6 NFRs)
- [rules/02-backend.md](../../rules/02-backend.md) (B13)
- [rules/04-libraries.md](../../rules/04-libraries.md) (L17)
- [docs/build-order.md](../build-order.md) (Phase 0.2, A2, A3, A5, B2)
