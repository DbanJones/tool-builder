# E2E test harness

Playwright specs for the Builder's webview, run via `corepack pnpm e2e`.

## Two contexts, one harness

The Builder's webview talks to the Tauri shell via `invoke()` and to the
Node sidecar via `sidecar_rpc`. Most Builder flows (Flow A welcome
detection, Flow B project create, Flow F live tail, Flow L Debug scan)
need both. The full E2E harness against the **built Tauri binary** uses
`tauri-driver` per `rules/05-testing.md` T8 — it is tracked as the
long-running drift item **D-004**.

This file's harness today only covers the **Next.js webview against
`pnpm dev`** path. That is enough to:

- Smoke-test that the route bundle compiles + ships HTML
- Assert on layout / 404 / error states that don't depend on `invoke()`
- Run lightweight regression specs for static-route surfaces

It is **not** enough to cover Flow A, Flow C, Flow F, Flow K, or Flow L
end-to-end — every call to `invoke()` throws in a non-Tauri context, so
specs that rely on CLI detection, project create, the live tail, the
Preview iframe, or the Debug panel's data flow are tagged
`@tauri-context` and skipped here. Wiring them into `tauri-driver`
closes both this gap and Phase G G7's `pnpm e2e -- --grep debug` AC.

## Specs in this directory

| File | Covers | Context |
|---|---|---|
| `smoke.spec.ts` | The harness itself: webview boots, Next.js renders 404 | webview-only |

Add new specs alongside `smoke.spec.ts`. Tag any spec that touches
Tauri / sidecar APIs with `test.describe('@tauri-context', …)` so the
webview-only run skips them automatically (and the future
`tauri-driver` profile picks them up).

## How to add the Tauri-context profile

`tauri-driver` is the standard Tauri-team driver shim. The flow is:

1. `cargo install tauri-driver`
2. Build the Tauri binary: `corepack pnpm tauri:build`
3. Add a second Playwright project to `playwright.config.ts` that uses
   the WebDriver protocol against `tauri-driver`'s default port
   (`http://localhost:4444`). Pass `webdriverIO` config including
   `automationName: "TauriDriver"`.
4. Drop the `webServer` field for that project — `tauri-driver` spawns
   the binary itself.
5. Filter to `@tauri-context` specs.

Until D-004 lands, this `README.md` is the canonical pointer.
