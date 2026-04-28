# ADR-0003: keyring-rs in the Tauri Rust shell over keytar via Node sidecar

## Status
Accepted, 2026-04-25.

## Context
The build-order task A2 originally said:
> Use `keytar` on macOS and Windows; Secret Service via `secret-tool` on Linux.

[rules/04-libraries.md](../../rules/04-libraries.md) L9c is broader:
> MUST use Tauri's `secure-storage` plugin (or `keytar` via Node sidecar) for the Vercel access token (E1) and any future third-party credential; do not implement custom encryption.

When implementing A2 the question of which path to take became concrete: do we (a) ship a Node sidecar that owns `keytar` and bridge through the sidecar, or (b) use a Rust crate inside the Tauri shell and bridge through Tauri IPC commands?

## Decision
The Builder uses the [`keyring` Rust crate](https://crates.io/crates/keyring) inside `src-tauri/src/lib.rs`. Three Tauri commands (`keychain_get`, `keychain_set`, `keychain_delete`) are registered in the invoke handler. The webview-side TypeScript wrapper at `lib/keychain/index.ts` calls these via `@tauri-apps/api/core` `invoke()` and returns `Result<T, KeychainError>` per [rules/03-code.md](../../rules/03-code.md) C10.

`keyring-rs` covers all three target platforms via the same OS facilities the original plan named:
- macOS Keychain
- Windows Credential Manager
- Linux Secret Service

At A2, no Node sidecar was bundled. ADR-0004 later introduced a Node sidecar for SQLite/Drizzle, and ADR-0005 made it load-bearing for Claude SDK streaming. This ADR still stands for keychain access: secrets remain in the Rust/Tauri keyring layer rather than moving to Node `keytar`.

## Consequences

**Positive**
- Tauri's idiomatic shape (Rust commands + IPC) is preserved end to end. No additional process model.
- One Rust crate covers all three platforms; no per-platform branching in Builder code.
- Keychain access does not add another sidecar dependency or `keytar` native module to ship.
- The webview never sees the secret in transit unless it explicitly asks for it, and the IPC surface is allow-listed per [rules/02-backend.md](../../rules/02-backend.md) B18.

**Negative**
- Departs from build-order.md A2's literal wording. Resolved by updating A2 to point at this ADR.
- Adds a Rust dep (`keyring`) that pulls native crates per platform: `security-framework` on macOS, `windows-sys` on Windows, `dbus` on Linux. Lengthens cold `cargo build` by roughly 30s for the transitive set. Acceptable.
- Linux CI without a running Secret Service daemon (gnome-keyring + dbus) cannot exercise the real round-trip. Mitigation: A2 ships unit tests with a mocked `invoke()`; a real-keychain integration test is deferred to a Phase-D follow-up that adds macOS + Windows CI runners.

## Affected files
- [src-tauri/Cargo.toml](../../src-tauri/Cargo.toml) adds `keyring = "3"`.
- [src-tauri/src/lib.rs](../../src-tauri/src/lib.rs) adds three `#[tauri::command]` functions and registers them in the invoke handler.
- [lib/keychain/index.ts](../../lib/keychain/index.ts) is the new TS wrapper, returning `Result<T, KeychainError>`.
- [docs/build-order.md](../build-order.md) A2 has revised wording pointing at this ADR.
