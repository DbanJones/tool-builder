# Other rules

## Deployment
O1. **Override for Builder**: deployment is the signed installer pipeline, not Vercel. Use Tauri's GitHub Actions templates to produce signed `.dmg`, `.msi`, and `.AppImage` artifacts; publish via the Tauri updater feed.
O2. MUST configure preview installers per PR for manual testing, retained 30 days.
O3. MUST gate `main` with required checks: typecheck, lint, unit, integration, build, axe, app launch time.
O4. MUST be able to roll back via the Tauri updater feed (publish previous version as latest); document the procedure in `docs/runbook.md`.

## CI/CD
O5. MUST use GitHub Actions; secrets via OIDC where possible (no long-lived tokens). Code-signing certificates stored in GitHub secrets, accessed only by signed-installer workflows.
O6. MUST run migrations in CI against an ephemeral SQLite before deploy.

## Observability
O7. MUST install Sentry for errors with sourcemaps uploaded on every build. **Sentry is opt-in**: novice consents on first run after their first successful build.
O8. MUST log structured events to `.builder/builder.log` with daily rotation and a 7-day retention.
O9. MUST run an in-app health check that verifies: keychain accessible, Anthropic reachable, project folder writable. Surface failures as a banner.
O10. MUST instrument key flows with Sentry transactions; trace interview -> orchestrator -> Claude Code subprocess.

## Security (OWASP Top 10 2021, enforceable items)
O11. MUST set a Content Security Policy in the Tauri webview: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https://api.anthropic.com`. No `'unsafe-inline'` for scripts.
O12. MUST set Tauri allowlist deny-by-default; explicitly allow file system reads/writes only within the project folder and `.builder/`.
O13. MUST rate-limit the orchestrator's outbound Anthropic calls per the daily cap; surface backpressure to the UI.
O14. MUST sanitise and validate every input with Zod (covers OWASP A03 Injection by removing string concat into queries; OWASP A04 Insecure Design via explicit schemas).
O15. MUST use parameterised queries via Drizzle exclusively (A03).
O16. MUST scrub PII from Sentry events with `beforeSend`. The novice's project paths and chat content MUST NOT reach Sentry.
O17. MUST encrypt secrets at rest via the OS keychain; rotate Anthropic and Vercel keys when the novice clicks "Disconnect" in settings.

## Privacy / GDPR
O18. MUST minimise data: collect only fields with a documented purpose in `docs/data-inventory.md`. The Builder's database holds project paths and metadata only; no novice content.
O19. MUST implement a "Delete this project" flow that removes the project folder, the `projects` row, and any keychain entries scoped to that project. Confirm via double-confirm modal.
O20. MUST present no cookie banner; the Builder is not a web app and sets no cookies.
O21. MUST list every sub-processor (Anthropic, Sentry if opted-in, Vercel if used) in `docs/sub-processors.md`.

## i18n
O22. MUST adopt `next-intl` only when >= 2 locales are required. Currently `en-GB` only.
O23. MUST use dot-notation keys (`auth.signIn.title`); never concatenate strings to build a sentence.

## Documentation
O24. MUST keep `README.md` to a quickstart (clone, install, run, test) within 50 lines.
O25. MUST maintain `CONTRIBUTING.md` (branch, commit, PR conventions), `docs/runbook.md` (incident playbooks), `docs/adr/` (decisions).

## Cost / quota
O26. MUST set Anthropic billing alerts at 50/80/100% of monthly budget. The Builder shows the novice's spend in real time.
O27. MUST implement a global LLM kill switch readable by every AI call site. Triggered when daily cap exceeded.

## Licensing
O28. Default: MIT for OSS components. The Builder shell itself: TBD by maintainers; likely AGPL or commercial.
O29. MUST run `license-checker` in CI; fail on GPL/AGPL in distributable bundles unless approved.

## Beginner safety rails (irreversible-action double-confirm)
O30. MUST stop and require an explicit "yes, delete" from the user before: deleting a project folder, overwriting a non-empty target folder, force-pushing to a GitHub repo the Builder created, removing keychain entries.
O31. MUST run destructive operations behind a `lib/danger.ts` wrapper that prints the action, requires the typed confirmation phrase ("delete <project-name>"), and snapshots the DB first.

## Handoff
O32. MUST ship `docs/getting-started.md` (install, first project in 15 minutes), `.env.example`, `scripts/dev`, `scripts/setup`, `scripts/verify`, and `docs/troubleshooting.md` (top 10 issues novices hit).
