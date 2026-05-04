import { defineConfig } from "@playwright/test";

// Playwright harness for the Builder. Per rules/05-testing.md L24 + T8,
// the canonical E2E path is `tauri-driver` against the BUILT Tauri
// binary so Tauri IPC commands (invoke, sidecar_rpc, keychain_*) and
// the sidecar JSON-RPC bridge are exercised end-to-end. That setup
// requires platform-specific webdrivers + a signed-or-stub binary and
// is tracked as drift D-004.
//
// What this harness does today: spin up `pnpm dev` (the Next.js
// webview only), then run any spec under `tests/e2e/`. The webview
// will render but every Tauri `invoke()` call will throw (no Tauri
// runtime), so specs in this mode can only assert on:
//   - Static layout / 404 + error pages (Next's own, no Tauri calls)
//   - Marketing site routes if surfaced
//   - Any page with a non-Tauri-dependent fallback path
//
// Specs that need real CLI detection / sidecar RPC / project state
// are tagged `@tauri-context` and skipped here; D-004 follow-up wires
// them into the tauri-driver path.

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "corepack pnpm dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
