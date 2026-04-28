# Code rules

## Organisation
C1. MUST organise code by feature first (`components/features/{feature}/`, `lib/{feature}/`), by layer second.
C2. MUST NOT create a barrel file (`index.ts` re-exporting everything) inside a feature; export from the feature root only.
C3. MUST keep functions <= 50 lines and modules <= 300 lines; if longer, extract.

## Naming
C4. MUST name booleans with `is/has/can/should` prefix; functions with verbs; types and components in PascalCase.

## Type safety
C5. MUST set `"strict": true`, `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true` in `tsconfig.json`.
C6. MUST NOT use `any`, `as any`, or `// @ts-ignore`; use `unknown` and narrow.
C7. MUST make switch statements over discriminated unions exhaustive using `assertNever(x: never)`.
C8. MUST use branded types for ids that should not be interchanged (`type ProjectId = string & { __brand: 'ProjectId' }`).

## Error handling
C9. MUST fail fast on programmer errors (invariant violations) using `invariant()`; do not try/catch them.
C10. MUST return `Result<T, E>` from boundary functions (DB queries, third-party calls, IPC commands). Convert thrown exceptions at the boundary using `Result.fromThrowable`.
C11. MUST handle every Result. The `eslint-plugin-neverthrow` `must-use-result` rule is currently deferred per drift D-001 until it supports the repo's TypeScript/ESLint versions, so reviews and tests must enforce consumption.

## Performance
C12. MUST measure before optimising. Add a Sentry transaction or `performance.mark` and capture a number in the PR description.
C13. MUST NOT introduce a memo/cache without a measured win.

## Concurrency
C14. MUST pass an `AbortSignal` to every `fetch` and propagate it from request scope. The orchestrator MUST cancel in-flight Claude SDK work on Pause or Stop.
C15. MUST set explicit timeouts on outbound calls; default 30s, override per integration. Claude streaming calls have no timeout but MUST be cancellable via AbortSignal.
C16. MUST use `Promise.all` (or `allSettled`) when independent calls can be parallelised; never await sequentially without a reason.

## Comments
C17. MUST comment WHY, not WHAT. If the code needs a comment to explain WHAT, rename or refactor.
C18. MUST link any non-obvious decision to an ADR id (`// see ADR-0007`).

## Git
C19. MUST follow Conventional Commits (`feat:`, `fix:`, `chore:`, etc.).
C20. MUST keep PRs under 400 changed lines. For larger work, use stacked PRs.
C21. MUST link every PR to a task id from `docs/build-order.md`.

## Dead code and TODOs
C22. MUST delete unused code rather than commenting it out. Git is the archive.
C23. MUST tag every TODO with an owner and a tracker id (`// TODO(@alice, ISSUE-123): ...`); a PR fails CI if a TODO has no owner.
