# Backend rules

## Data model
B1. MUST give every table `id` (uuid v7 via `gen_random_uuid()` or ULID), `created_at`, `updated_at`, and a soft-delete `deleted_at timestamptz null` for any user-visible entity.
B2. MUST normalise to 3NF unless a benchmark in an ADR shows denormalisation is required.
B3. MUST add an audit table (`audit_log`) for actions that affect billing, permissions, or PII; record `actor_id`, `action`, `target_id`, `at`, `diff`.
B4. MUST use UUID v7 (RFC 9562) or ULID for primary keys, never UUID v4 on hot-write tables; v7's timestamp prefix keeps B-tree inserts sequential.

## Database choice
B5. Default per kit: Supabase Postgres. **Override for Builder (per ADR-0004)**: SQLite via better-sqlite3, owned by the Node sidecar and accessed by the webview through Tauri/sidecar RPC. The Builder is a single-user desktop app; Postgres is wrong scope.

## Migrations
B6. MUST author every schema change as a Drizzle Kit migration committed to git. No manual `psql` or sqlite3 changes against any environment that has data.
B7. MUST run migrations in CI against a fresh SQLite before merge.
B8. MUST make migrations backward compatible for one release: add column, backfill, then remove the old in a later migration.

## API design
B9. MUST use Tauri IPC commands for novice-facing actions in the Builder; use Next.js Server Actions or Route Handlers only inside the webview when the action is purely UI-local. Cross-process boundaries always go through Tauri IPC.
B10. MUST paginate any list view; default cursor pagination by `created_at, id` with a default limit of 50.
B11. MUST treat every mutation that can be retried as idempotent. The orchestrator's retries around Claude Agent SDK sessions MUST use a stable idempotency key (typically the task id from `build-order.md`). See ADR-0005.
B12. MUST return typed errors. Define a `Result<T, AppError>` boundary using neverthrow at module edges; throw only for truly unrecoverable bugs.

## Auth
B13. **Override for Builder (revised per ADR-0002/ADR-0005)**: there is no user account and no Anthropic credential held by the Builder. The `claude` CLI handles its own auth (subscription or API key configured inside the CLI), while Builder chat/build transport uses the Claude Agent SDK in the sidecar. The OS keychain holds the Vercel access token used at E1. Tauri IPC commands MUST verify the calling window is the Builder's main window before executing privileged actions.
B14. **Override for Builder**: RLS does not apply (single-user desktop app). Equivalent control: the SQLite file lives in the user's home directory under OS-level permissions; only the trusted Node sidecar opens it.
B15. (RLS performance) does not apply.
B16. (RLS index) does not apply.
B17. (RBAC vs ABAC) does not apply.
B18. **Override for Builder (revised per ADR-0004/ADR-0005)**: the equivalent of "service-role key" is the Tauri IPC plus sidecar RPC bridge. The webview MUST NOT have direct file system, network, or process-spawning access. Claude SDK sessions and any other privileged operations are started through allow-listed Tauri/sidecar commands.

## Validation
B19. MUST validate every Tauri IPC command input and every file the ingestor reads with Zod, at the first line of the handler. The inferred type is the only handler input type.

## Error handling
B20. MUST log structured JSON: `{ level, message, traceId, errorCode, ...context }`. No `console.log` in committed code outside `scripts/`. The Builder logs to `.builder/builder.log` with daily rotation.
B21. MUST include a stable `errorCode` enum so dashboards (and the novice-facing error UI) can group errors.

## Background jobs
B22. **Override for Builder**: the job runner is the orchestrator, a local actor in the Node sidecar with Tauri acting as the webview bridge. Same idempotency, retry, and dead-letter principles as Inngest, but local. Inngest, QStash, Trigger.dev are NOT used.
B23. MUST make every orchestrator step idempotent on a stable input key (typically the task id from `build-order.md`).
B24. MUST configure retries with exponential backoff (default 3 retries, 30s base) and a "give up and ask" destination (the escalate flow) for permanent failures.
B25. MUST verify the signature of any external job-triggering payload. Not currently applicable to the Builder; reserved for future remote control features.

## File storage
B26. **Override for Builder**: file storage is the local file system. The novice's project folder is treated as untrusted from the Builder's perspective.
B27. (Signed URLs) does not apply.
B28. MUST set per-file-type size limits in the ingestor: 25 MB for documents, 10 MB for images, 5 MB for schemas, 100 MB for data samples (with sampling, not full load).

## Secrets and config
B29. MUST follow twelve-factor: every config value is an environment variable; defaults live in `.env.example`. The Vercel access token is NOT in `.env`; it lives in the OS keychain. The Builder holds no Anthropic credential (per ADR-0002).
B30. MUST validate `process.env` once at startup with a Zod schema in `lib/env.ts`. Fail fast if invalid.

## Backup and recovery
B31. **Override for Builder**: SQLite Point-in-Time Recovery is not available; instead, the Builder MUST snapshot `.builder/builder.db` to `.builder/snapshots/{ts}.db` before any destructive operation (project delete, schema migration on existing data).
B32. MUST implement a project delete flow: the novice can delete a project, which removes the project folder, project-scoped rows, and keychain entries. Locally stored interview answers and approved file summaries must be deleted with the project.
