mod chat;
mod deploy;
mod export;
mod launch;
mod orchestrator;
mod sidecar;

use keyring::Entry;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::Manager;

use chat::{chat_send, chat_stop};
use deploy::{vercel_deploy, vercel_is_installed};
use export::{gh_export, gh_is_installed};
use launch::{target_app_launch, target_app_stop, target_app_write_launch_scripts, LaunchState};
use orchestrator::{orchestrator_start, orchestrator_stop, OrchestratorState};
use sidecar::{sidecar_rpc, sidecar_rpc_stream, spawn_sidecar, SidecarState};

// Bundled placeholder templates copied into every newly created project per
// build-order.md A4c (placeholder content per human direction 2026-04-25).
// `include_str!` paths are relative to this source file.
const TEMPLATE_CLAUDE_MD: &str = include_str!("../templates/CLAUDE.md");
const TEMPLATE_SPEC_MD: &str = include_str!("../templates/spec.md");
const TEMPLATE_BUILDER_STATE: &str = include_str!("../templates/builder-state.json");
const TEMPLATE_RULES_README: &str = include_str!("../templates/rules-README.md");
const TEMPLATE_DAVID_EASTER_EGG: &str = include_str!("../templates/david-easter-egg.md");

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

// `read_review_md` returns `{project}/.builder/review.md` as raw text. The
// build-phase agent writes this file at the end of every build (see the
// kickoff prompt's REVIEW step) so the dashboard can render a coverage
// checklist against spec.md. Returns Ok(None) when the file doesn't exist
// yet (build hasn't reached the review step) — the dashboard renders a
// "review will appear here" placeholder for that case.
const REVIEW_MD_MAX_BYTES: u64 = 1 * 1024 * 1024;

#[tauri::command]
fn read_review_md(project_path: String) -> Result<Option<String>, String> {
  let project_root = expand_tilde(&project_path);
  if !project_root.exists() {
    return Err(format!(
      "read_review_md: project folder not found: {}",
      project_root.display()
    ));
  }
  let review_path = project_root.join(".builder").join("review.md");
  if !review_path.exists() {
    return Ok(None);
  }
  let metadata = fs::metadata(&review_path).map_err(|e| format!("stat review.md: {e}"))?;
  if metadata.len() > REVIEW_MD_MAX_BYTES {
    return Err(format!(
      "read_review_md: review.md exceeds {} byte cap (got {})",
      REVIEW_MD_MAX_BYTES,
      metadata.len()
    ));
  }
  fs::read_to_string(&review_path)
    .map(Some)
    .map_err(|e| format!("read_review_md: {e}"))
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

// Pre-flight capability check for Start build. The user reported repeated
// directory write failures; rather than make the orchestrator's first 30
// seconds fail and waste a Claude turn, probe the project folder + .builder/
// + claude CLI BEFORE spawn and surface a single clear blocking alert in
// the dashboard listing exactly what's missing or unwritable.
//
// Returns Ok({ok: true, ...}) when everything's good, Ok({ok: false, errors})
// when there are blockers. Never throws — the dashboard renders the result.

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CapabilityReport {
  ok: bool,
  errors: Vec<String>,
  checked_path: String,
}

#[tauri::command]
fn build_capability_check(project_path: String) -> Result<CapabilityReport, String> {
  let mut errors: Vec<String> = vec![];
  let cwd = expand_tilde(&project_path);
  let checked_path = cwd.display().to_string();

  // 0. Reject project paths INSIDE the Builder source tree. Live test
  //    showed that placing a project at e.g. ~/...Tool Builder/ or
  //    inside src-tauri/ caused claude to read the Builder repo's own
  //    .claude/settings.json (or src-tauri/.claude/) and lock the
  //    session to the Builder source folder. Strict rejection up front
  //    is cheaper than debugging the symptom.
  if let Ok(canon_cwd) = cwd.canonicalize() {
    if let Ok(builder_root) = sidecar::project_root_from_cwd() {
      if canon_cwd.starts_with(&builder_root) {
        errors.push(format!(
          "Project folder is inside the Builder app's own source folder ({}). \
           Choose a folder outside this repo — the recommended default is ~/Documents/ClaudeBuilds.",
          builder_root.display()
        ));
      }
    }
  }

  // 1. Project folder exists + is a directory.
  if !cwd.exists() {
    errors.push(format!("Project folder doesn't exist: {checked_path}"));
  } else if !cwd.is_dir() {
    errors.push(format!("Project path is a file, not a directory: {checked_path}"));
  } else {
    // 2. Project folder writable — write + delete a tiny probe file.
    let probe_path = cwd.join(".builder-capability-probe.tmp");
    match fs::write(&probe_path, b"probe") {
      Ok(()) => {
        let _ = fs::remove_file(&probe_path);
      }
      Err(e) => {
        errors.push(format!(
          "Project folder isn't writable ({checked_path}): {e}. Check folder permissions or move the project somewhere outside iCloud / OneDrive."
        ));
      }
    }
  }

  // 3. .builder/ subdirectory exists OR can be created.
  let builder_dir = cwd.join(".builder");
  if !builder_dir.exists() {
    if let Err(e) = fs::create_dir_all(&builder_dir) {
      errors.push(format!(
        ".builder/ subdirectory cannot be created at {}: {e}",
        builder_dir.display()
      ));
    }
  }

  // 4. claude CLI on PATH and runnable.
  let which_or_where = if cfg!(target_os = "windows") {
    "where"
  } else {
    "which"
  };
  match Command::new(which_or_where).arg("claude").output() {
    Ok(o) if o.status.success() => {
      // Probe --version too in case PATH lies about a non-functional binary.
      match Command::new("claude").arg("--version").output() {
        Ok(v) if v.status.success() => {}
        Ok(_) => errors
          .push("`claude` is on PATH but `claude --version` failed; reinstall the Claude Code CLI.".to_string()),
        Err(e) => errors.push(format!("Couldn't run `claude --version`: {e}")),
      }
    }
    _ => errors.push(
      "Claude Code CLI (`claude`) not found on PATH. Install it from https://docs.claude.com/en/docs/claude-code/setup."
        .to_string(),
    ),
  }

  Ok(CapabilityReport {
    ok: errors.is_empty(),
    errors,
    checked_path,
  })
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

// Region screen capture for the Preview tab's "Capture & annotate" button
// (D-028). Spawns macOS's native `screencapture -i <file>` which puts a
// crosshair region picker on top of every window — the novice drags a
// rectangle over the iframe (or anywhere on screen), screencapture writes
// the PNG to a temp file, we read the bytes and return them base64-encoded
// so the webview can construct a Blob and seed the AnnotationModal.
//
// macOS-only for slice 2.5. Linux/Windows fall back to the empty modal +
// drag-drop / paste flow until we add a cross-platform path (likely the
// `xcap` Rust crate, deferred to a later slice).

#[tauri::command]
fn capture_region_to_png() -> Result<String, String> {
  use base64::Engine;
  use std::process::Command;
  use std::time::{SystemTime, UNIX_EPOCH};

  if !cfg!(target_os = "macos") {
    return Err(
      "Region capture is currently macOS-only. Drop or paste a screenshot in the annotate window instead."
        .to_string(),
    );
  }

  let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
  let temp_path = std::env::temp_dir()
    .join(format!("builder-capture-{}-{:09}.png", now.as_secs(), now.subsec_nanos()));

  // -i: interactive region picker (drag to select; ESC cancels)
  // -t png: explicit PNG (default, but be defensive)
  let status = Command::new("screencapture")
    .arg("-i")
    .arg("-t")
    .arg("png")
    .arg(&temp_path)
    .status()
    .map_err(|e| format!("failed to spawn screencapture: {e}"))?;

  if !status.success() || !temp_path.exists() {
    // User pressed ESC, or the picker was dismissed without a region.
    // No file means no capture; clean up if a stub was created.
    let _ = fs::remove_file(&temp_path);
    return Err("Capture cancelled.".to_string());
  }

  let bytes = fs::read(&temp_path).map_err(|e| format!("read capture: {e}"))?;
  let _ = fs::remove_file(&temp_path);

  if bytes.is_empty() {
    return Err("Capture produced an empty file.".to_string());
  }

  Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

// Visual-feedback PNG writer (Slice 1 of the annotation tool — D-026).
// The novice pauses a build, annotates a screenshot of the built app inside
// the Builder, and clicks Send. This command writes the flattened PNG
// (image + annotation overlay, base64-encoded by the webview) into
// {project}/.builder/feedback/ and returns the relative path the chat prompt
// references so Claude's Read tool can pick it up. Path-sandboxed: the
// webview supplies project_path; we always write to {project}/.builder/feedback/.
//
// Cap: 10 MB per AC6 of the D-026 spec — annotated screenshots over that
// are vanishingly unlikely from a UI canvas; refusing them protects against
// accidental huge uploads from a paste of the wrong thing.

const MAX_FEEDBACK_IMAGE_BYTES: usize = 10 * 1024 * 1024;

#[tauri::command]
fn feedback_image_save(
  project_path: String,
  content_base64: String,
) -> Result<String, String> {
  use base64::Engine;
  use std::time::{SystemTime, UNIX_EPOCH};

  let bytes = base64::engine::general_purpose::STANDARD
    .decode(content_base64.as_bytes())
    .map_err(|e| format!("feedback_image_save: base64 decode failed: {e}"))?;
  if bytes.len() > MAX_FEEDBACK_IMAGE_BYTES {
    return Err(format!(
      "feedback_image_save: image too large ({} bytes, max {})",
      bytes.len(),
      MAX_FEEDBACK_IMAGE_BYTES
    ));
  }
  if bytes.len() < 8 || &bytes[0..8] != b"\x89PNG\r\n\x1a\n" {
    return Err("feedback_image_save: payload is not a PNG (magic bytes missing)".to_string());
  }

  let project_root = expand_tilde(&project_path);
  if !project_root.exists() {
    return Err(format!(
      "feedback_image_save: project folder not found: {}",
      project_root.display()
    ));
  }
  let canon_root = project_root
    .canonicalize()
    .map_err(|e| format!("feedback_image_save: canonicalise project root: {e}"))?;

  let feedback_dir = canon_root.join(".builder").join("feedback");
  fs::create_dir_all(&feedback_dir)
    .map_err(|e| format!("feedback_image_save: create .builder/feedback/: {e}"))?;

  let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
  let filename = format!("fb-{}-{:09}.png", now.as_secs(), now.subsec_nanos());
  let target = feedback_dir.join(&filename);

  // Defence in depth: confirm the resolved write target is still under the
  // project root after canonicalisation (catches symlink games + any future
  // filename that sneaks in `..`). The filename is generated server-side so
  // this is belt-and-braces, but cheap.
  let canon_target_parent = target
    .parent()
    .ok_or_else(|| "feedback_image_save: target has no parent".to_string())?
    .canonicalize()
    .map_err(|e| format!("feedback_image_save: canonicalise target parent: {e}"))?;
  if !canon_target_parent.starts_with(&canon_root) {
    return Err("feedback_image_save: refused — write target escaped project root".to_string());
  }

  fs::write(&target, &bytes).map_err(|e| format!("feedback_image_save: write: {e}"))?;

  // Return the path relative to the project root so the chat message reads
  // ".builder/feedback/fb-...png" (Claude's Read tool resolves it inside cwd).
  Ok(format!(".builder/feedback/{filename}"))
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

  // Reject parents inside the Builder's own source tree. Live test 2026-04-27
  // showed that picking the Builder repo as the project parent caused the
  // spawned claude to read the Builder's own .claude/ settings and lock the
  // session. Cheaper to reject up front than debug the symptom.
  if let Ok(canon_parent) = parent.canonicalize() {
    if let Ok(builder_root) = sidecar::project_root_from_cwd() {
      if canon_parent.starts_with(&builder_root) {
        return Err(format!(
          "Project folder is inside the Builder app's own source folder ({}). \
           Pick a different parent folder — the recommended default is ~/Documents/ClaudeBuilds.",
          builder_root.display()
        ));
      }
    }
  }

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
  fs::write(
    project_root.join("rules").join("david-easter-egg.md"),
    TEMPLATE_DAVID_EASTER_EGG,
  )
  .map_err(|e| format!("failed to write rules/david-easter-egg.md: {e}"))?;

  // Project-local Claude Code settings: blanket-allow EVERY tool inside
  // this folder. Without this, the spawned claude reads any user-level
  // ~/.claude/settings.json with restrictive paths and ends up "locked
  // to src-tauri/" or similar (live tested 2026-04-27). This file takes
  // precedence over user-level rules per Claude Code's settings layering.
  fs::create_dir_all(project_root.join(".claude"))
    .map_err(|e| format!("failed to create .claude/: {e}"))?;
  let claude_settings_path = project_root.join(".claude").join("settings.local.json");
  // Claude Code permission rules are tool-prefixed (Bash(*), Read(**), etc.)
  // — a bare "*" is NOT a wildcard. defaultMode: bypassPermissions is the
  // load-bearing line, allow[] is belt-and-braces.
  fs::write(
    &claude_settings_path,
    "{\n  \"permissions\": {\n    \"defaultMode\": \"bypassPermissions\",\n    \"allow\": [\n      \"Bash(*)\",\n      \"Read(**)\",\n      \"Write(**)\",\n      \"Edit(**)\",\n      \"Glob(**)\",\n      \"Grep(**)\",\n      \"Task(*)\",\n      \"WebFetch(*)\",\n      \"WebSearch(*)\",\n      \"TodoWrite(*)\",\n      \"NotebookEdit(**)\"\n    ],\n    \"deny\": []\n  }\n}\n",
  )
  .map_err(|e| format!("failed to write .claude/settings.local.json: {e}"))?;

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
      match spawn_sidecar(
        &app.handle(),
        state.pending.clone(),
        state.channels.clone(),
      ) {
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
      app.manage(LaunchState::new());

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
      feedback_image_save,
      capture_region_to_png,
      read_target_state,
      read_review_md,
      read_history_log_tail,
      write_target_spec,
      append_drift_log_line,
      build_capability_check,
      chat_send,
      chat_stop,
      orchestrator_start,
      orchestrator_stop,
      vercel_is_installed,
      vercel_deploy,
      gh_is_installed,
      gh_export,
      target_app_launch,
      target_app_stop,
      target_app_write_launch_scripts,
      sidecar_rpc,
      sidecar_rpc_stream
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
