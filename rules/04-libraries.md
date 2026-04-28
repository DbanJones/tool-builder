# Library rules

## Selection
L1. MUST evaluate any new dependency against: weekly downloads (>50k), last commit (<=3 months), licence (MIT/Apache/BSD), bundle size (Bundlephobia), security advisories (npm audit/Snyk).
L2. MUST prefer one well-maintained dependency over three small unmaintained ones.

## Lock-in / abstraction
L3. MUST place every third-party SDK behind a thin port in `lib/{vendor}/` so the rest of the code depends on the port, not the SDK. Ports and adapters keep us swappable.

## Version pinning
L4. MUST pin exact versions in `package.json` (no `^` or `~`) and commit `pnpm-lock.yaml`.
L5. MUST run Renovate (or Dependabot) weekly with grouped minor/patch PRs and individual major PRs.

## Framework: Next.js 15
L6. MUST use App Router only; no Pages Router in new code.
L7. MUST default to Server Components; mark Client Components with `'use client'` only when needed.
L8. MUST use `next/image` for all raster images and `next/font` for all fonts. (Inside Tauri, fonts are bundled with the app, not fetched.)

## Framework: Tauri 2
L9b. MUST use Tauri 2's allowlist to restrict file system, shell, and network access. Default deny; explicitly allow only what's needed per command.
L9c. MUST use the Tauri/Rust keyring wrapper for the Vercel access token (E1) and any future third-party credential; do not implement custom encryption. The Builder does not store Anthropic credentials (see ADR-0002 and ADR-0005).
L9d. MUST use Tauri's `updater` plugin with a signed feed; do not roll a custom updater.

## ORM
L9. Default per kit: Drizzle. **Builder uses Drizzle with better-sqlite3** (not Postgres). Use Prisma only on a team that strongly prefers schema-first DSL and accepts the cold-start cost. Use Kysely for query-builder-only needs. Use raw SQL for one-off CTEs and window functions, gated behind a typed wrapper.
L10. MUST run Drizzle in `strict: true` mode so renames are not silently turned into drop+add.

## Auth library
L11. **Override for Builder (revised per ADR-0002/ADR-0005)**: no auth library. The Builder holds no Anthropic credential; the `claude` CLI handles its own auth. See B13, ADR-0002, and ADR-0005.

## Payments
L12-L16. **Not applicable to the Builder** (it is free; novices pay Anthropic directly). These rules apply when the Builder generates a target app that takes payments.

## AI / LLM
L17. Default for generated target apps: Anthropic SDK via Vercel AI SDK (`@ai-sdk/anthropic`) for streaming, tool use, and provider abstraction. **Override for the Builder itself (revised per ADR-0005)**: interview chat and target-app build orchestration use `@anthropic-ai/claude-agent-sdk` inside the Node sidecar. The `claude` CLI remains required only as the local auth backend. Tool use is registered through the SDK sidecar drivers; do not reintroduce CLI `stream-json` parsing for core Builder flows.
L18. MUST stream responses to the UI via `streamText` to keep INP healthy on long generations.
L19. MUST implement tool-use loops with explicit `maxSteps` (default 8) to bound runaway calls.
L20. MUST version every prompt as a file under `lib/llm/prompts/{name}.v{n}.md` and reference by import; bump the version on any change.
L21. MUST add a Promptfoo eval suite under `evals/` with at least one assertion per prompt; run on every PR that touches `lib/llm/`.
L22. MUST track per-request token usage and cost; expose them on the dashboard cost meter.
L23. **Override for Builder (revised per ADR-0002/ADR-0005)**: no daily LLM spend cap is enforced by default; the underlying Claude account governs throttling. The Builder MUST detect SDK/CLI rate-limit errors and surface a "wait until HH:MM" message; the build pauses gracefully. Any spend cap is novice-opt-in.

## Testing libraries
L24. MUST use Vitest for unit and integration; Playwright for E2E (against the built Tauri binary); MSW for HTTP boundary mocks; Testing Library for DOM assertions; jest-axe + @axe-core/playwright for a11y.

## Update / audit
L25. MUST run `corepack pnpm audit --audit-level=high` in CI; high or critical fails the build.
L26. MUST publish a CycloneDX SBOM on every release tag.
