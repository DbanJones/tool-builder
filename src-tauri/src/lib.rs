mod sidecar;

use keyring::Entry;
use std::process::Command;
use tauri::Manager;

use sidecar::{sidecar_rpc, spawn_sidecar, SidecarState};

// Builder-local keychain commands. See ADR-0003.
//
// `service` is the namespaced service identifier (e.g. "com.airtec.builder.vercel").
// `account` is the per-credential discriminator (e.g. "default").
// Errors are returned to the webview as plain strings; the TypeScript wrapper
// at `lib/keychain/index.ts` re-wraps them into a discriminated `KeychainError`.

#[tauri::command]
fn keychain_get(service: String, account: String) -> Result<Option<String>, String> {
  let entry = Entry::new(&service, &account).map_err(|e| e.to_string())?;
  match entry.get_password() {
    Ok(secret) => Ok(Some(secret)),
    Err(keyring::Error::NoEntry) => Ok(None),
    Err(e) => Err(e.to_string()),
  }
}

#[tauri::command]
fn keychain_set(service: String, account: String, secret: String) -> Result<(), String> {
  let entry = Entry::new(&service, &account).map_err(|e| e.to_string())?;
  entry.set_password(&secret).map_err(|e| e.to_string())
}

#[tauri::command]
fn keychain_delete(service: String, account: String) -> Result<(), String> {
  let entry = Entry::new(&service, &account).map_err(|e| e.to_string())?;
  match entry.delete_credential() {
    Ok(()) => Ok(()),
    Err(keyring::Error::NoEntry) => Ok(()),
    Err(e) => Err(e.to_string()),
  }
}

// Claude Code CLI detection per ADR-0002 and build-order.md A3.
//
// `cli_is_installed` returns true if `which claude` (or `where` on Windows)
// resolves AND `claude --version` exits successfully. The version probe
// guards against PATH lying about a non-functional binary.
//
// `cli_is_authenticated` runs `claude -p "ping" --output-format json` and
// returns true on success. Cost is small (single ping prompt) but real;
// cache hints can be added in a later phase.

#[tauri::command]
fn cli_is_installed() -> Result<bool, String> {
  let which_or_where = if cfg!(target_os = "windows") {
    "where"
  } else {
    "which"
  };
  let on_path = Command::new(which_or_where)
    .arg("claude")
    .output()
    .map_err(|e| format!("failed to run {which_or_where}: {e}"))?;
  if !on_path.status.success() {
    return Ok(false);
  }
  let version = Command::new("claude").arg("--version").output();
  match version {
    Ok(v) => Ok(v.status.success()),
    Err(_) => Ok(false),
  }
}

#[tauri::command]
fn cli_is_authenticated() -> Result<bool, String> {
  let output = Command::new("claude")
    .arg("-p")
    .arg("ping")
    .arg("--output-format")
    .arg("json")
    .output()
    .map_err(|e| format!("failed to spawn claude: {e}"))?;
  Ok(output.status.success())
}

// Audit logger per spec.md Flow A AC5 and rules/02-backend.md B20.
// Currently routes to tauri-plugin-log; a Drizzle audit_log table arrives
// at A4b (see drift D-003).

#[tauri::command]
fn audit_log_event(event_type: String, payload: String) -> Result<(), String> {
  log::info!(target: "builder.audit", "event={event_type} payload={payload}");
  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      let state = SidecarState::new();

      // Best-effort spawn. If it fails (e.g. sidecar not built), log and continue;
      // sidecar_rpc will return a clear error for any subsequent calls.
      match spawn_sidecar(&app.handle()) {
        Ok(handle) => {
          if let Ok(mut guard) = state.handle.lock() {
            *guard = Some(handle);
            log::info!("sidecar spawned");
          }
        }
        Err(e) => {
          log::warn!("sidecar spawn failed: {e}; sidecar_rpc will return errors");
        }
      }

      app.manage(state);

      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      keychain_get,
      keychain_set,
      keychain_delete,
      cli_is_installed,
      cli_is_authenticated,
      audit_log_event,
      sidecar_rpc
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
