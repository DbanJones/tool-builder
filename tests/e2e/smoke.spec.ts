// Webview-only smoke spec. Proves the Playwright harness is wired up
// (config valid, dev server starts, page renders HTML). Real Flow
// coverage waits for the tauri-driver profile per the D-004 follow-up.
//
// We hit Next.js's built-in 404 page rather than `/` because the
// welcome route at `/` calls `invoke('cli_detect')` at mount; without
// a Tauri runtime that throws, leaving the page in an error state.
// The 404 route always renders cleanly regardless of context.

import { expect, test } from "@playwright/test";

test("dev server boots and serves Next's 404 for unknown routes", async ({ page }) => {
  const response = await page.goto("/this-route-does-not-exist", {
    waitUntil: "domcontentloaded",
  });
  expect(response?.status()).toBe(404);
  // Next.js 14+ default 404 page has the text "404"; we don't pin the
  // exact wording in case the project ships a custom not-found.tsx
  // later, just that the body has SOMETHING.
  const bodyText = await page.locator("body").textContent();
  expect(bodyText?.length ?? 0).toBeGreaterThan(0);
});

test("the Next bundle includes the expected stylesheet", async ({ page }) => {
  // Sanity check that the Tailwind / globals.css pipeline is wired.
  // If this regresses, the build script broke before we got to any
  // real spec. Cheap canary for the harness.
  await page.goto("/this-route-does-not-exist", {
    waitUntil: "domcontentloaded",
  });
  const stylesheetCount = await page.locator('link[rel="stylesheet"]').count();
  expect(stylesheetCount).toBeGreaterThan(0);
});

// -----------------------------------------------------------------
// Tauri-context specs go below this line; tag them @tauri-context so
// the webview-only run skips them. The future tauri-driver profile
// in playwright.config.ts will filter to this tag and pick them up.
// -----------------------------------------------------------------

test.describe("@tauri-context", () => {
  test.skip(
    "Flow A AC1-AC5: welcome screen runs CLI detection",
    () => undefined
  );
  test.skip(
    "Flow C AC1-AC6: novice can answer the first interview question",
    () => undefined
  );
  test.skip(
    "Flow L AC2-AC5: novice clicks Debug now, sees a finding, applies a Tier 1 fix",
    () => undefined
  );
});
