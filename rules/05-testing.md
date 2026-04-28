# Testing rules

## Strategy: Testing Trophy (Kent C. Dodds)
T1. MUST size the suite as the Testing Trophy: many integration tests, fewer unit tests, fewer E2E, plus static analysis as the wide base.
T2. MUST aim for >= 70% line and branch coverage on `lib/` and the orchestrator. Ignore generated files and pure config.
T3. MUST NOT test framework internals, third-party libraries, or `console.log`.

## Unit
T4. MUST follow Arrange/Act/Assert. One behaviour per test. Test name is a sentence: `it('rejects an order when the cart is empty')`.
T5. MUST keep unit tests <= 100ms each; if slower, it is integration.

## Integration
T6. MUST run integration tests against a real SQLite (via `:memory:` for speed, or a temp file when persistence matters), wrapped in a transaction that rolls back per test.
T7. MUST build test data with factories (Fishery + faker) using a seeded RNG (`faker.seed(1)`); never copy production data.

## E2E
T8. MUST write Playwright tests for the smoke flow (Welcome -> create project -> first chat exchange) before any feature is "done". Playwright runs against the built Tauri binary using `tauri-driver`.
T9. MUST locate elements with `getByRole`/`getByLabel`; fall back to `data-testid` only when no semantic locator exists.
T10. MUST adopt a Page Object Model when E2E covers >= 5 pages.
T11. MUST keep flake <= 1% per week; quarantine a flake within 24 hours, root-cause within 5 working days.

## Contract
T12. MUST snapshot the Tauri IPC command contracts; CI fails if a contract changes without a version bump in the IPC port.

## Visual regression
T13. MUST add Chromatic only for stable, design-locked components; do not visually regress in-flux pages.

## Accessibility
T14. MUST run jest-axe in unit tests for any component with interactive parts and @axe-core/playwright in E2E for every page; merge gate is zero violations.

## Performance
T15. MUST run Lighthouse CI on the embedded Next.js dev server with budgets: LCP <= 2.5s, INP <= 200ms, CLS <= 0.1, performance score >= 90 on the Welcome and Interview screens.
T16. MUST measure app launch time in CI: cold start to Welcome render <= 1.5s on the test runner; fail the build if exceeded.

## Security
T17. MUST run Snyk SAST, `corepack pnpm audit`, gitleaks, and a Tauri-specific allowlist linter in CI.

## Mocking
T18. MUST mock at the boundary only (third-party AI APIs via MSW or SDK boundary fakes, file system via temp dirs, time via Vitest fake timers); never mock the system under test.

## Manual QA
T19. MUST write a charter for every exploratory session and a SEV1-SEV4 bug taxonomy in `docs/qa.md`.

## Acceptance criteria
T20. MUST express every story's acceptance criteria as Given/When/Then. Each maps to at least one automated test.

## CI gating
T21. MUST run unit + integration on every push; they block merge.
T22. MUST run E2E on `main` and nightly; flaky failures route to the quarantine label, not a failed build.

## Test naming and organisation
T23. MUST mirror source structure (`lib/foo.ts` -> `lib/foo.test.ts` colocated, or `tests/unit/foo.test.ts`).

## Regression
T24. MUST add a test referencing the bug id (`// regression: ISSUE-123`) for every fixed bug.

## Beginner-specific (for the Builder, "beginner" is the agent itself)
T25. MUST add the smoke test first (one happy-path E2E) before any further tests; it is the canary.
T26. MUST write at least one E2E per Flow listed in `spec.md` section 3 before declaring the corresponding phase complete.
