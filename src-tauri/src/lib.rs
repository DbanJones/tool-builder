mod chat;
mod sidecar;

use keyring::Entry;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::Manager;

use chat::chat_send;
use sidecar::{sidecar_rpc, spawn_sidecar, SidecarState};

// Bundled placeholder templates copied into every newly created project per
// build-order.md A4c (placeholder content per human direction 2026-04-25).
// `include_str!` paths are relative to this source file.
const TEMPLATE_CLAUDE_MD: &str = include_str!("../templates/CLAUDE.md");
const TEMPLATE_SPEC_MD: &str = include_str!("../templates/spec.md");
const TEMPLATE_BUILDER_STATE: &str = include_str!("../templates/builder-state.json");
const TEMPLATE_RULES_README: &str = include_str!("../templates/rules-README.md");

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

// Audit logging is now routed through the sidecar's `audit.logEvent` handler
// (see ADR-0004 + drift D-003 closed at A4b). The previous `audit_log_event`
// Tauri command has been removed; lib/audit/index.ts calls sidecarCall directly.

// File ingestion save (C8). Decodes a base64-encoded blob from the webview
// and writes it to {project_path}/inputs/{name}, returning the absolute
// path. Per spec.md §6 size limits (B28): 25 MB documents, 10 MB images,
// 5 MB schemas, 100 MB data samples. Enforced as a single 25 MB cap here
// and refined per-kind in a later pass when the UI knows the kind.

const MAX_UPLOAD_BYTES: usize = 25 * 1024 * 1024;

#[tauri::command]
fn file_save_uploaded(
  project_path: String,
  name: String,
  content_base64: String,
) -> Result<String, String> {
  use base64::Engine;

  // Validate name: no path separators, no leading dot, no parent traversal.
  if name.contains('/') || name.contains('\\') || name.starts_with('.') || name == ".." {
    return Err(format!("file_save_uploaded: invalid file name '{name}'"));
  }
  if name.is_empty() || name.len() > 255 {
    return Err("file_save_uploaded: file name must be 1-255 characters".to_string());
  }

  let bytes = base64::engine::general_purpose::STANDARD
    .decode(content_base64.as_bytes())
    .map_err(|e| format!("file_save_uploaded: base64 decode failed: {e}"))?;
  if bytes.len() > MAX_UPLOAD_BYTES {
    return Err(format!(
      "file_save_uploaded: file too large ({} bytes, max {})",
      bytes.len(),
      MAX_UPLOAD_BYTES
    ));
  }

  let project_root = expand_tilde(&project_path);
  if !project_root.exists() {
    return Err(format!(
      "file_save_uploaded: project folder not found: {}",
      project_root.display()
    ));
  }

  let inputs_dir = project_root.join("inputs");
  fs::create_dir_all(&inputs_dir)
    .map_err(|e| format!("file_save_uploaded: create inputs/: {e}"))?;

  let target = inputs_dir.join(&name);
  // Refuse to overwrite (caller can choose to send a renamed copy if they want).
  if target.exists() {
    return Err(format!(
      "file_save_uploaded: '{}' already exists; rename the file or remove the existing copy first",
      target.display()
    ));
  }

  fs::write(&target, &bytes).map_err(|e| format!("file_save_uploaded: write: {e}"))?;

  target
    .canonicalize()
    .map(|p| p.display().to_string())
    .map_err(|e| format!("file_save_uploaded: canonicalise: {e}"))
}

// Project creation file-system work per build-order.md A4c and Flow B AC1-AC3.
// The DB insert + audit row are handled by the sidecar (`projects.create`); the
// webview orchestrates the two halves via lib/project/index.ts.
//
// The novice's typed name is preserved as the display name in the projects
// row; the folder name on disk is the sanitised form (lowercase, hyphens
// for whitespace, only [a-z0-9._-]). Mirrors lib/project/index.ts
// sanitiseProjectName.

fn sanitise_project_name(raw: &str) -> Option<String> {
  let mut s: String = raw.to_lowercase();
  // Whitespace -> hyphen
  let mut out = String::with_capacity(s.len());
  let mut prev_was_dash = false;
  for c in s.chars() {
    if c.is_whitespace() {
      if !prev_was_dash {
        out.push('-');
        prev_was_dash = true;
      }
      continue;
    }
    if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '_' {
      out.push(c);
      prev_was_dash = false;
      continue;
    }
    if c == '-' {
      if !prev_was_dash {
        out.push('-');
        prev_was_dash = true;
      }
      continue;
    }
    // Drop any other character (punctuation, emoji, accented letters, etc.).
  }
  s = out;
  // Trim leading/trailing punctuation.
  let trimmed = s.trim_matches(|c| c == '.' || c == '-' || c == '_');
  let mut s = trimmed.to_string();
  if s.len() > 100 {
    s.truncate(100);
    while s
      .chars()
      .last()
      .map(|c| c == '.' || c == '-' || c == '_')
      .unwrap_or(false)
    {
      s.pop();
    }
  }
  if s.is_empty() {
    None
  } else {
    Some(s)
  }
}

fn expand_tilde(path: &str) -> PathBuf {
  if let Some(rest) = path.strip_prefix("~/") {
    if let Some(home) = std::env::var_os("HOME") {
      return PathBuf::from(home).join(rest);
    }
  }
  PathBuf::from(path)
}

#[tauri::command]
fn project_create_folder(name: String, folder: String) -> Result<String, String> {
  let folder_name = sanitise_project_name(&name).ok_or_else(|| {
    format!(
      "project name '{name}' has no usable characters after sanitisation (need at least one letter or digit)"
    )
  })?;

  let parent = expand_tilde(&folder);
  fs::create_dir_all(&parent)
    .map_err(|e| format!("failed to create parent folder {}: {e}", parent.display()))?;

  let project_root = parent.join(&folder_name);
  if project_root.exists() {
    return Err(format!(
      "target folder already exists: {}",
      project_root.display()
    ));
  }

  fs::create_dir_all(&project_root)
    .map_err(|e| format!("failed to create project folder {}: {e}", project_root.display()))?;
  fs::create_dir_all(project_root.join(".builder"))
    .map_err(|e| format!("failed to create .builder/: {e}"))?;
  fs::create_dir_all(project_root.join("rules"))
    .map_err(|e| format!("failed to create rules/: {e}"))?;

  let claude_md_path = project_root.join("CLAUDE.md");
  fs::write(&claude_md_path, TEMPLATE_CLAUDE_MD)
    .map_err(|e| format!("failed to write CLAUDE.md: {e}"))?;
  fs::write(project_root.join("spec.md"), TEMPLATE_SPEC_MD)
    .map_err(|e| format!("failed to write spec.md: {e}"))?;
  fs::write(project_root.join(".builder").join("state.json"), TEMPLATE_BUILDER_STATE)
    .map_err(|e| format!("failed to write .builder/state.json: {e}"))?;
  fs::write(project_root.join("rules").join("README.md"), TEMPLATE_RULES_README)
    .map_err(|e| format!("failed to write rules/README.md: {e}"))?;

  let git_init = Command::new("git")
    .arg("init")
    .arg("--quiet")
    .current_dir(&project_root)
    .output()
    .map_err(|e| format!("failed to spawn git: {e}"))?;
  if !git_init.status.success() {
    return Err(format!(
      "git init failed: {}",
      String::from_utf8_lossy(&git_init.stderr)
    ));
  }

  Path::new(&project_root)
    .canonicalize()
    .map(|p| p.display().to_string())
    .map_err(|e| format!("failed to canonicalise project path: {e}"))
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
      project_create_folder,
      file_save_uploaded,
      chat_send,
      sidecar_rpc
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
