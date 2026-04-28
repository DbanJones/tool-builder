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
O9. MUST run an in-app health check that verifies: keychain accessible, Claude Code auth/session reachable, project folder writable. Surface failures as a banner.
O10. MUST instrument key flows with Sentry transactions; trace interview -> sidecar orchestrator -> Claude SDK session.

## Security (OWASP Top 10 2021, enforceable items)
O11. MUST set a Content Security Policy in the Tauri webview: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'`. The sidecar owns Claude/third-party network calls unless an ADR explicitly allows a webview endpoint. No `'unsafe-inline'` for scripts.
O12. MUST set Tauri allowlist deny-by-default; explicitly allow file system reads/writes only within the project folder and `.builder/`.
O13. MUST surface Claude rate-limit backpressure to the UI. Any spend cap is novice-opt-in; when exceeded, it must stop new AI work and leave the current project resumable.
O14. MUST sanitise and validate every input with Zod (covers OWASP A03 Injection by removing string concat into queries; OWASP A04 Insecure Design via explicit schemas).
O15. MUST use parameterised queries via Drizzle exclusively (A03).
O16. MUST scrub PII from Sentry events with `beforeSend`. The novice's project paths and chat content MUST NOT reach Sentry.
O17. MUST encrypt secrets at rest via the OS keychain; rotate Vercel and future third-party keys when the novice clicks "Disconnect" in settings. The Builder does not hold Anthropic credentials.

## Privacy / GDPR
O18. MUST minimise data: collect only fields with a documented purpose in `docs/data-inventory.md`. The Builder may store interview answers and approved file summaries locally in `.builder/builder.db`; novice content must not leave the machine except as prompts sent to Claude.
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
O26. MUST show the novice's token/cost estimate in real time. External Claude billing alerts are managed by the novice's Claude account.
O27. MUST implement a global AI stop/cancel path readable by every AI call site. If a novice-opt-in spend cap is exceeded, new AI work must be blocked until the novice changes the cap or resumes deliberately.

## Licensing
O28. Default: MIT for OSS components. The Builder shell itself: TBD by maintainers; likely AGPL or commercial.
O29. MUST run `license-checker` in CI; fail on GPL/AGPL in distributable bundles unless approved.

## Beginner safety rails (irreversible-action double-confirm)
O30. MUST stop and require an explicit "yes, delete" from the user before: deleting a project folder, overwriting a non-empty target folder, force-pushing to a GitHub repo the Builder created, removing keychain entries.
O31. MUST run destructive operations behind a `lib/danger.ts` wrapper that prints the action, requires the typed confirmation phrase ("delete <project-name>"), and snapshots the DB first.

## Handoff
O32. MUST ship `docs/getting-started.md` (install, first project in 15 minutes), `.env.example`, `scripts/dev`, `scripts/setup`, `scripts/verify`, and `docs/troubleshooting.md` (top 10 issues novices hit).

## Quick-launch opener (target app must be one-click runnable)
O33. MUST give the novice a one-click way to launch the target app once Phase 1 is built. The Builder dashboard MUST show a "Launch app" button that starts the target app's dev/start command and opens the resulting local URL in the novice's default browser; the live tail captures the spawned server's stdout/stderr until the user clicks Stop.
O34. MUST also write a platform-native quick-launch script into the project folder so the novice can open the app outside the Builder: `launch.command` on macOS, `launch.bat` on Windows, `launch.sh` on Linux. Each script MUST install dependencies if missing, start the dev/start command, and print the URL. Mark them executable on Unix.
O35. MUST NOT require the novice to open a terminal, run `cd`, or remember a `pnpm dev` / `npm run dev` command to launch the app they just built. The novice never set up Node by hand; the Builder owns the runtime expectation end-to-end.
O36. MUST detect when launch fails (port busy, missing build artefacts, dependency install error) and surface a clear actionable message in the dashboard ("Port 3000 in use — choose another port?") rather than a raw stack trace.
O37. MUST verify the quick-launch path works as the final step of every build, before the build is declared done. The end-of-build review (`.builder/review.md`) MUST list "Quick-launch verified" as a present/missing item alongside the spec coverage.
