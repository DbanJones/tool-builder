# ADR-0014: Preview bridge via a Builder-owned HTTP proxy

**Status**: accepted, 2026-05-01.
**Spec sections triggered**: `spec.md` §3 Flow K AC4 (annotation save), AC9 (Preview toolbar), AC11 (region capture). Per SC17.

## Context

The Preview tab embeds the target app in an iframe pointed at the dev
server's URL (e.g. `http://localhost:3000`). The Builder webview itself runs
at the Tauri scheme or the `next dev` port — a different origin in every
case. With cross-origin isolation in force, the parent webview cannot:

- read `iframe.contentDocument` to resolve clicks to DOM elements,
- patch the iframe's `console` from the outside,
- subscribe to `window.error` / `unhandledrejection` from inside.

Without a workaround, all visual feedback the user gives is opaque: a region
screenshot through `screencapture -i` (ADR-implicit, see [src-tauri/src/lib.rs](../../src-tauri/src/lib.rs)
and the D-028 changelog) is a bitmap with no semantic context. The agent
cannot tell whether the marked button is a `<button class="cta-primary">` or
a `<div role="button">`; cannot read the URL the user was on; cannot see the
console error that fired three seconds before they clicked Capture.

The user's request (2026-05-01): make Capture & annotate send richer context
— DOM coordinates, the iframe's URL/viewport, and recent console messages —
and stream runtime errors into the Builder live tail in real time.

## Options considered

**A. Agent-edits the target app's `app/layout.tsx`** to include a
`<script src="/__builder-bridge.js">` tag in dev mode.

- Cheap to implement — one file edit at scaffold time.
- Stack-coupled: assumes Next 15 App Router. We do not yet pin a target
  framework template; SvelteKit / Vite / Astro all fail.
- Fragile: the Claude agent owns `layout.tsx` and may revert or refactor
  the script tag during normal build work, with no way for the Builder
  to detect breakage other than absence of the bridge "hello" event.
- Mixes Builder-owned and project-owned source. Drift waiting to happen.

**B. Vite/Next plugin written into the project's config** that injects the
bridge in dev.

- Slightly more durable than (A) — config files change less often.
- Still stack-specific (need a separate plugin per dev server).
- Forces config-file ownership conflicts: the agent edits `next.config.ts`
  for legitimate reasons too.

**C. Builder-owned HTTP proxy in front of the dev server** that injects the
bridge at the HTTP layer.

- Framework-agnostic — operates on bytes, knows nothing about React/Next/Vite.
- Self-contained inside Tauri; no project files touched.
- Cost: ~250 LOC of Rust (`tokio::net` + manual HTTP/1.1 parsing) plus a
  small bridge JS.
- Needs WebSocket forwarding for HMR — `tokio::io::copy_bidirectional`
  handles it once we detect the upgrade.

**D. CDP (Chrome DevTools Protocol) connection to the webview process.**

- Theoretically cleaner — speaks browser semantics directly.
- Heterogeneous across platforms (WebKitGTK, WebKit, WebView2). Tauri does
  not expose a stable CDP endpoint; would require platform-specific
  bridging code we do not want to own.
- Rejected as too invasive.

## Decision

Option C. Implement a minimal HTTP/1.1 forwarding proxy in
[src-tauri/src/preview_proxy.rs](../../src-tauri/src/preview_proxy.rs).
On every preview launch:

1. The proxy binds `127.0.0.1:0` (OS-assigned port).
2. Each connection: parse the request head, forward to the dev server,
   stream the response back. For `text/html` responses, buffer the body and
   inject `<script src="/__builder-bridge.js"></script>` immediately before
   `</body>` (or at the end if no `</body>` tag is present).
3. Serve the bridge script itself at the well-known path
   `/__builder-bridge.js` from `src-tauri/assets/builder-bridge.js`
   (embedded via `include_str!`).
4. Detect WebSocket upgrade requests (`Upgrade: websocket` +
   `Connection: upgrade`) and tunnel bidirectionally — Next/Vite HMR keeps
   working unmodified.
5. The iframe URL the Builder reports is the proxy URL, not the upstream;
   the upstream URL is also returned in `LaunchInfo.upstreamUrl` for
   diagnostics and the "Open in browser" gesture.

The bridge script itself
([src-tauri/assets/builder-bridge.js](../../src-tauri/assets/builder-bridge.js))
hooks `console.{log,warn,error,info,debug}`, `window.error`, and
`unhandledrejection`, and relays each event to `window.parent` via
`postMessage`. It also installs a request/response channel for the Phase 2
annotation enrichment (snapshot, elementFromPoint resolution).

The parent-side listener
([lib/preview-bridge/index.ts](../../lib/preview-bridge/index.ts)) is a
singleton ring buffer (200 events). The right-rail badge subscribes to it
for the error count; the live-status panel merges browser events into the
existing action timeline, sorted by timestamp.

## Trade-offs and why hyper was not used

A previous draft of this work used `hyper` for the proxy. That added
~140 transitive crates and roughly tripled cold-build time. The proxy's
contract is genuinely small:

- read until `\r\n\r\n` (request head),
- forward bytes,
- find `</body>` once on HTML responses,
- bidirectionally copy bytes for WebSocket connections.

These do not need a full HTTP implementation; they need a parser for the
header block and `tokio::net`. The current implementation is ~340 lines
including extensive header rewriting and dechunking. Adding hyper would not
change observable behaviour and would worsen build time, so we rejected it.

The hand-rolled proxy intentionally limits itself:

- HTTP/1.1 only (HTTP/2 dev servers are not in our supported matrix).
- Forces `Accept-Encoding: identity` upstream so we never have to gzip-
  decompress in order to inject. Asset payloads stay identity-encoded over
  localhost — no measurable cost.
- Closes connections after each non-WS exchange (`Connection: close` both
  ways). Loses keep-alive perf, gains code simplicity. Dev-time only.
- 8 MB cap on HTML buffer for injection; pages bigger than that stream
  through unchanged and the bridge silently does not load on them.

## Failure modes and degradation

The bridge is **dev-time instrumentation, not a hard dependency**. Every
failure mode degrades gracefully:

- Proxy fails to bind → fall back to upstream URL, bridge does not load.
- Bridge fails to load (CSP, network) → parent's listener stays
  `status: "absent"`. The annotation modal proceeds with PNG-only
  feedback, the same path that existed before this ADR.
- HTML buffer cap exceeded → page streams through, bridge does not load on
  that page.

In all cases the user experience falls back cleanly to the
PR-1-pre behaviour.

## Consequences

- New module in Rust shell; no new heavy deps. Build time unaffected.
- Iframe URL changes from upstream to proxy. Anyone copying the URL out of
  the workspace gets the proxied URL — this is the desired behaviour
  because external browser tabs also benefit from the bridge.
- Slight added latency per iframe request (single localhost hop). Not
  measurable in dev.
- A second commit (PR-2, deferred) builds on this to add DOM resolution,
  iframe-aware annotation context, and a `.builder/feedback/<ts>.json`
  sidecar attached to agent prompts.

## Drift status

Logged as drift D-031 on 2026-05-01 — extends D-028 (visual feedback)
beyond its original scope of OS-level region capture. Both the agent
runbook and `spec.md` section 7 reference the visual-feedback initiative
without specifying the iframe-bridge mechanism, so this is an
implementation choice rather than a spec amendment.
