mod chat;
mod deploy;
mod export;
mod orchestrator;
mod sidecar;

use keyring::Entry;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::Manager;

use chat::chat_send;
use deploy::{vercel_deploy, vercel_is_installed};
use export::{gh_export, gh_is_installed};
use orchestrator::{orchestrator_start, orchestrator_stop, OrchestratorState};
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

// Write the Builder-rebuilt spec into the novice's project folder so the
// spawned claude has real context to work from. Without this, claude reads
// the placeholder spec.md from project creation and goes off on tangents
// (live-tested 2026-04-26: claude started giving VS Code setup advice
// because it had no actual spec to anchor on).
//
// Path-sandboxed to {project}/spec.md (binding rule 5).
#[tauri::command]
fn write_target_spec(project_path: String, spec_text: String) -> Result<String, String> {
  let project_root = expand_tilde(&project_path);
  if !project_root.exists() {
    return Err(format!(
      "write_target_spec: project folder not found: {}",
      project_root.display()
    ));
  }
  let spec_path = project_root.join("spec.md");
  fs::write(&spec_path, spec_text).map_err(|e| format!("write_target_spec: {e}"))?;
  spec_path
    .canonicalize()
    .map(|p| p.display().to_string())
    .map_err(|e| format!("canonicalise: {e}"))
}

// Build dashboard readers (D3). Both commands read files from inside the
// novice's project folder (binding rule 5: untrusted from the Builder's
// perspective). They sanitise the requested path by joining `project_path` +
// fixed sub-path; we never accept an arbitrary path from the webview.
//
// `read_target_state` returns `{project}/.builder/state.json` as raw text;
// the webview wrapper validates with Zod. Returns Ok(None) when the file
// doesn't exist (a freshly-created project has no orchestrator state yet),
// matching the dashboard's "(no phase yet)" placeholder.
//
// `read_history_log_tail` returns the last N JSON lines from
// `{project}/.builder/history.log`. Used to populate the live tail when
// opening a paused project; new orchestrator events are appended live by D2.

const HISTORY_LOG_MAX_BYTES: u64 = 16 * 1024 * 1024;

#[tauri::command]
fn read_target_state(project_path: String) -> Result<Option<String>, String> {
  let project_root = expand_tilde(&project_path);
  if !project_root.exists() {
    return Err(format!(
      "read_target_state: project folder not found: {}",
      project_root.display()
    ));
  }
  let state_path = project_root.join(".builder").join("state.json");
  if !state_path.exists() {
    return Ok(None);
  }
  fs::read_to_string(&state_path)
    .map(Some)
    .map_err(|e| format!("read_target_state: {e}"))
}

#[tauri::command]
fn read_history_log_tail(project_path: String, limit: usize) -> Result<Vec<String>, String> {
  let project_root = expand_tilde(&project_path);
  if !project_root.exists() {
    return Err(format!(
      "read_history_log_tail: project folder not found: {}",
      project_root.display()
    ));
  }
  let log_path = project_root.join(".builder").join("history.log");
  if !log_path.exists() {
    return Ok(vec![]);
  }
  let metadata = fs::metadata(&log_path).map_err(|e| format!("stat history.log: {e}"))?;
  if metadata.len() > HISTORY_LOG_MAX_BYTES {
    return Err(format!(
      "read_history_log_tail: history.log exceeds {} byte cap (got {})",
      HISTORY_LOG_MAX_BYTES,
      metadata.len()
    ));
  }
  let text = fs::read_to_string(&log_path).map_err(|e| format!("read history.log: {e}"))?;
  let mut lines: Vec<String> = text
    .lines()
    .filter(|l| !l.trim().is_empty())
    .map(|l| l.to_string())
    .collect();
  if lines.len() > limit {
    let drop = lines.len() - limit;
    lines.drain(..drop);
  }
  Ok(lines)
}

// Drift-log writer (D5). Appends a markdown block to the novice's
// {project}/docs/drift-log.md, creating the file (with the same header the
// Builder's own drift-log uses) if it doesn't yet exist. Path-sandboxed:
// the webview supplies project_path; we always write to {project}/docs/.

const DRIFT_LOG_HEADER: &str = "# Drift log\n\nPer rules/07-self-check.md SC26: every correction or accepted drift is logged here with date, AC id or scope item, drift type, resolution, and commit hash. This is the audit trail.\n\n";

#[tauri::command]
fn append_drift_log_line(
  project_path: String,
  drift_id: String,
  kind: String,
  description: String,
  resolution: String,
  commit_hash: Option<String>,
) -> Result<String, String> {
  let project_root = expand_tilde(&project_path);
  if !project_root.exists() {
    return Err(format!(
      "append_drift_log_line: project folder not found: {}",
      project_root.display()
    ));
  }
  let docs_dir = project_root.join("docs");
  fs::create_dir_all(&docs_dir).map_err(|e| format!("create docs/: {e}"))?;
  let log_path = docs_dir.join("drift-log.md");

  // Seed the file with the same header the Builder's own drift-log uses
  // when it doesn't yet exist.
  if !log_path.exists() {
    fs::write(&log_path, DRIFT_LOG_HEADER).map_err(|e| format!("seed drift-log: {e}"))?;
  }

  let now = chrono_now_iso8601();
  let commit_line = commit_hash
    .as_deref()
    .filter(|c| !c.trim().is_empty())
    .map(|c| format!("- **Commit**: {c}\n"))
    .unwrap_or_default();
  let block = format!(
    "\n### {drift_id} — {description}\n- **Drift type**: {kind}.\n- **Resolved**: {now}.\n- **Resolution**: {resolution}.\n{commit_line}"
  );

  let mut existing = fs::read_to_string(&log_path).map_err(|e| format!("read drift-log: {e}"))?;
  existing.push_str(&block);
  fs::write(&log_path, existing).map_err(|e| format!("write drift-log: {e}"))?;

  log_path
    .canonicalize()
    .map(|p| p.display().to_string())
    .map_err(|e| format!("canonicalise: {e}"))
}

// Lightweight ISO 8601 timestamp without a chrono dep — std::time only.
fn chrono_now_iso8601() -> String {
  use std::time::{SystemTime, UNIX_EPOCH};
  let secs = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_secs())
    .unwrap_or(0);
  // Use a fixed-format date; second-precision is fine for an audit line.
  // We avoid pulling chrono just for this.
  format!("{}Z", iso8601_from_unix_secs(secs))
}

fn iso8601_from_unix_secs(secs: u64) -> String {
  // Days since 1970-01-01 (Unix epoch)
  let days = (secs / 86400) as i64;
  let rem = secs % 86400;
  let hour = rem / 3600;
  let min = (rem % 3600) / 60;
  let sec = rem % 60;
  let (year, month, day) = civil_from_days(days);
  format!(
    "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
    year, month, day, hour, min, sec
  )
}

// Howard Hinnant's date algorithm (public domain) — converts days since
// 1970-01-01 (Gregorian) to (year, month, day).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
  let z = z + 719468;
  let era = if z >= 0 { z / 146097 } else { (z - 146096) / 146097 };
  let doe = (z - era * 146097) as u64;
  let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  let y = yoe as i64 + era * 400;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
  let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
  let y = if m <= 2 { y + 1 } else { y };
  (y, m, d)
}

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
      app.manage(OrchestratorState::new());

      // Tauri auto-updater (Flow J AC1-AC3). The actual signed feed +
      // pubkey are provisioned in Phase E0 (deferred per human direction
      // 2026-04-25). The plugin is wired now so all that's needed when
      // E0 lands is to swap the placeholder pubkey + endpoint in
      // tauri.conf.json — no code change. Drift D-017 documents the gap.
      app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;

      // Native folder picker for the new-project form (UX1).
      app.handle().plugin(tauri_plugin_dialog::init())?;

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
      read_target_state,
      read_history_log_tail,
      write_target_spec,
      append_drift_log_line,
      chat_send,
      orchestrator_start,
      orchestrator_stop,
      vercel_is_installed,
      vercel_deploy,
      gh_is_installed,
      gh_export,
      sidecar_rpc
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
