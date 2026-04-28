# ADR-0004: Node sidecar for SQLite, Drizzle, and local orchestration

## Status
Accepted, 2026-04-25.

## Context
[CLAUDE.md](../../CLAUDE.md) stack pins:
> Drizzle ORM with better-sqlite3 for local state in `.builder/builder.db`.

`better-sqlite3` is a Node native module; the Tauri webview has no Node runtime, and the Tauri Rust shell is not Node. Three architectures were considered when wiring the DB at A4:

| Option | Shape | Trade-off |
|---|---|---|
| **A** | **Node sidecar**: bundle Node + better-sqlite3 + Drizzle in a sidecar process spawned by the Tauri shell. Webview talks to it via JSON-RPC over stdin/stdout, brokered by a `sidecar_rpc` Tauri command. | Highest fidelity to the original spec. Biggest packaging cost. |
| B | Rust `rusqlite` in `src-tauri` + a `db_execute` Tauri command + Drizzle's SQL-proxy driver in TS. | Mirrors the keychain pattern (ADR-0003); no extra process. |
| C | `tauri-plugin-sql` (sqlx underneath) + a community Drizzle adapter. | Smallest dep footprint; depends on a third-party adapter. |

## Decision
Option A: Node sidecar. Picked by the human at A4 entry, with eyes open about packaging cost.

2026-04-28 update: ADR-0005 expanded the sidecar's role. It now owns SQLite/Drizzle plus the Claude Agent SDK drivers for interview chat and build orchestration. The process architecture remains the same; the sidecar runtime bundling follow-up is now release-critical.

## Architecture

```
┌─────────────────────────────────┐
│  Webview (Next.js, TypeScript)  │
│                                 │
│  lib/sidecar/client.ts          │
│   └─ typed RPC wrappers         │
│      (projects.create, etc.)    │
└──────────────┬──────────────────┘
               │ Tauri invoke
               ▼
┌─────────────────────────────────┐
│  Tauri shell (Rust)             │
│                                 │
│  src-tauri/src/sidecar.rs       │
│   └─ Mutex<SidecarHandle>       │
│      sidecar_rpc command:       │
│      writes JSON line to stdin, │
│      reads JSON line from stdout│
└──────────────┬──────────────────┘
               │ stdin/stdout (JSON-RPC, line-delimited)
               ▼
┌─────────────────────────────────┐
│  Node sidecar                   │
│                                 │
│  sidecar/src/index.ts           │
│   └─ readline loop dispatches   │
│      methods to handlers        │
│   └─ better-sqlite3 + Drizzle   │
│      against .builder/builder.db│
│   └─ Claude Agent SDK drivers   │
│      for chat/build streams     │
└─────────────────────────────────┘
```

The protocol is one JSON object per stdin line, response is one JSON object per stdout line. Synchronous request/response, serialised by a `Mutex` on the Rust side (acceptable while concurrency is single-window single-user; revisit if we ever need parallel queries).

A4a (this ADR's commit) lands the sidecar with one `ping` method only. A4b adds the Drizzle schemas and real DB methods. A4c adds the project_create flow on top.

## Consequences

**Positive**
- Drizzle ORM stays canonical: queries are written in TS via Drizzle's typed API in the sidecar. The webview client is a thin RPC wrapper exposing typed methods (`projects.create`, `projects.list`); the implementation lives in the sidecar.
- One source of truth for the schema: Drizzle Kit owns migration generation directly against the same code that runs queries.
- Closest fit to the original CLAUDE.md stack line.

**Negative**
- **Production packaging is non-trivial**. Bundling Node adds ~80MB to the installer; per-platform binaries are needed. Mitigation: dev mode uses `node` from PATH; production packaging (`node-sea` / `pkg` / Bun-as-binary) is a release-track follow-up before novice distribution.
- **Extra IPC hop on every DB query**: webview → Tauri command (Rust) → sidecar stdin → better-sqlite3 → response. Local IPC adds sub-ms latency but it is non-zero.
- **Extra long-lived process to manage**: spawn on app start, kill on app exit, error handling, crash recovery.
- **Cross-platform sidecar bundling is fiddly** and is its own Phase E task.

## Affected files
- `sidecar/` is a new top-level directory with its own package.json, tsconfig.json, src/, and (later) drizzle.config.ts and schema/.
- `src-tauri/src/sidecar.rs` is new: process lifecycle and `sidecar_rpc` Tauri command.
- `src-tauri/src/lib.rs` registers the sidecar in setup and the new command in the invoke handler.
- `lib/sidecar/client.ts` is the typed RPC wrapper used by the webview.
- [CLAUDE.md](../../CLAUDE.md) stack section: clarifies sidecar role.
- [docs/build-order.md](../build-order.md) A4 splits into A4a (sidecar foundation), A4b (DB schemas + handlers + audit migration), A4c (project_create flow).
