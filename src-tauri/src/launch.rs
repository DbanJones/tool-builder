// One-click target-app launcher (CLAUDE.md O33-O36). The novice should
// never need a terminal: press "Launch app" in the workspace, the Rust
// shell spawns `npm run dev` in their project folder, watches stdout for
// the first localhost URL, opens it in the default browser, and keeps the
// process running until they press Stop.
//
// State is global to the Builder process — only one target app at a time
// to keep the live-tail and the "running" indicator coherent.
//
// On success, also start the preview proxy (ADR-0014) in front of the dev
// server. The iframe URL we report is the proxy's, so the bridge script gets
// injected into HTML responses. The "Open in browser" gesture still uses the
// proxy URL — same effect as the raw dev URL but with the bridge active.

use std::path::Path;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::oneshot;
use tokio::time::timeout;

use crate::preview_proxy::{self, PreviewProxyState};

const TARGET_SERVER_EVENT: &str = "target-server-event";

const URL_DETECTION_TIMEOUT_SECS: u64 = 45;

pub struct LaunchState {
  child: Mutex<Option<Child>>,
}

impl LaunchState {
  pub fn new() -> Self {
    Self {
      child: Mutex::new(None),
    }
  }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchInfo {
  /// URL the iframe should load. This is the proxy URL when the proxy is up,
  /// or the upstream dev URL as a fallback. Either way, novice-facing.
  url: String,
  /// Raw dev server URL, before the proxy. Useful for diagnostics and for
  /// the "Open in your default browser" gesture if the user prefers the
  /// un-instrumented page.
  upstream_url: String,
  pid: u32,
}

/// Start the target app's dev server and open its URL in the user's default
/// browser. Returns once a localhost URL has been detected on stdout (or the
/// detection times out). The process keeps running; use target_app_stop to
/// kill it.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TargetServerEvent {
  source: &'static str,
  severity: &'static str,
  message: String,
  ts: u128,
}

#[tauri::command]
pub async fn target_app_launch(
  app: AppHandle,
  state: State<'_, LaunchState>,
  proxy_state: State<'_, PreviewProxyState>,
  project_path: String,
  open_browser: Option<bool>,
) -> Result<LaunchInfo, String> {
  // Refuse to start a second instance — only one tail and one URL banner.
  {
    let guard = state
      .child
      .lock()
      .map_err(|e| format!("launch state lock: {e}"))?;
    if guard.is_some() {
      return Err("Target app is already running. Stop it first.".into());
    }
  }

  let cwd = Path::new(&project_path);
  if !cwd.exists() {
    return Err(format!(
      "Project folder doesn't exist: {}",
      cwd.display()
    ));
  }
  if !cwd.join("package.json").exists() {
    return Err(
      "No package.json in the project folder. The build hasn't produced a \
       runnable app yet — run a build first."
        .into(),
    );
  }

  // Use the platform's npm. We don't pin a package manager in Builder
  // templates (the agent picks per-project) so npm is the lowest common
  // denominator that respects whatever scripts/lockfile is there.
  let npm = if cfg!(windows) { "npm.cmd" } else { "npm" };
  let mut child = Command::new(npm)
    .args(["run", "dev"])
    .current_dir(cwd)
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .stdin(Stdio::null())
    .kill_on_drop(true)
    .spawn()
    .map_err(|e| format!("Failed to start dev server: {e}. Is Node installed?"))?;

  let pid = child
    .id()
    .ok_or_else(|| "Spawned process had no PID".to_string())?;
  let stdout = child
    .stdout
    .take()
    .ok_or_else(|| "Dev server stdout pipe missing".to_string())?;
  let stderr = child
    .stderr
    .take()
    .ok_or_else(|| "Dev server stderr pipe missing".to_string())?;

  // Watch both pipes; whichever surfaces a URL first wins. After the URL
  // is sent, both tasks keep running so the kernel pipe buffers don't
  // fill (which would otherwise block the dev server).
  let (url_tx, url_rx) = oneshot::channel::<String>();
  let url_tx_shared = std::sync::Arc::new(Mutex::new(Some(url_tx)));

  spawn_drain_task(stdout, "stdout", url_tx_shared.clone(), app.clone());
  spawn_drain_task(stderr, "stderr", url_tx_shared, app.clone());

  // Stash the child so target_app_stop can kill it.
  {
    let mut guard = state
      .child
      .lock()
      .map_err(|e| format!("launch state lock: {e}"))?;
    *guard = Some(child);
  }

  let upstream_url = match timeout(
    Duration::from_secs(URL_DETECTION_TIMEOUT_SECS),
    url_rx,
  )
  .await
  {
    Ok(Ok(u)) => u,
    Ok(Err(_)) => {
      // Sender dropped without sending — both pipes closed before printing
      // a URL, which means the process exited.
      reap_child(&state).await.ok();
      return Err(
        "Dev server exited before printing a URL. Check the project's \
         dev script (npm run dev) starts a long-running server."
          .into(),
      );
    }
    Err(_) => {
      reap_child(&state).await.ok();
      return Err(format!(
        "Timed out after {URL_DETECTION_TIMEOUT_SECS}s waiting for the dev server \
         to print a localhost URL. Try running `npm run dev` manually to see what \
         happened."
      ));
    }
  };

  // Stand up the preview proxy in front of the dev server (ADR-0014). The
  // proxy is best-effort: if it fails to bind, we degrade to the raw upstream
  // URL and the bridge simply doesn't load. The bridge is dev-time
  // instrumentation, not a hard dependency.
  let upstream_port = match parse_port(&upstream_url) {
    Some(p) => Some(p),
    None => {
      log::warn!(
        "Couldn't parse port from {upstream_url}; preview proxy disabled (bridge will not load)"
      );
      None
    }
  };

  let proxy_url = if let Some(port) = upstream_port {
    match preview_proxy::start(port).await {
      Ok(handle) => {
        let proxy_url = format!("http://localhost:{}", handle.port);
        proxy_state.install(handle).await;
        Some(proxy_url)
      }
      Err(e) => {
        log::warn!("preview proxy failed to start ({e}); falling back to upstream URL");
        None
      }
    }
  } else {
    None
  };

  let serving_url = proxy_url.clone().unwrap_or_else(|| upstream_url.clone());

  // Best-effort: open in default browser. If it fails we still return the
  // URL so the user can copy it from the dashboard. The Preview tab passes
  // open_browser=false because its iframe IS the preview surface.
  if open_browser.unwrap_or(true) {
    if let Err(e) = open_in_browser(&serving_url) {
      log::warn!("Failed to open browser at {serving_url}: {e}");
    }
  }

  Ok(LaunchInfo {
    url: serving_url,
    upstream_url,
    pid,
  })
}

/// Kill the running target app, if any. Idempotent — safe to call when
/// nothing is running. Also tears down the preview proxy so the next launch
/// gets a fresh bind on a clean port.
#[tauri::command]
pub async fn target_app_stop(
  state: State<'_, LaunchState>,
  proxy_state: State<'_, PreviewProxyState>,
) -> Result<(), String> {
  proxy_state.shutdown().await;
  reap_child(&state).await
}

/// Write platform-native launch scripts (launch.command / launch.bat /
/// launch.sh) into the project folder so the novice can launch the app
/// outside the Builder. CLAUDE.md O34. Idempotent — overwrites if present.
#[tauri::command]
pub fn target_app_write_launch_scripts(project_path: String) -> Result<Vec<String>, String> {
  let cwd = Path::new(&project_path);
  if !cwd.exists() {
    return Err(format!("Project folder doesn't exist: {}", cwd.display()));
  }

  let mut written: Vec<String> = vec![];

  let mac_path = cwd.join("launch.command");
  std::fs::write(&mac_path, MAC_LAUNCH_SCRIPT)
    .map_err(|e| format!("write launch.command: {e}"))?;
  set_executable(&mac_path).ok();
  written.push(mac_path.display().to_string());

  let linux_path = cwd.join("launch.sh");
  std::fs::write(&linux_path, LINUX_LAUNCH_SCRIPT)
    .map_err(|e| format!("write launch.sh: {e}"))?;
  set_executable(&linux_path).ok();
  written.push(linux_path.display().to_string());

  let win_path = cwd.join("launch.bat");
  std::fs::write(&win_path, WIN_LAUNCH_SCRIPT)
    .map_err(|e| format!("write launch.bat: {e}"))?;
  written.push(win_path.display().to_string());

  Ok(written)
}

// ---- helpers ---------------------------------------------------------------

fn spawn_drain_task<R: tokio::io::AsyncRead + Unpin + Send + 'static>(
  pipe: R,
  source: &'static str,
  url_tx: std::sync::Arc<Mutex<Option<oneshot::Sender<String>>>>,
  app: AppHandle,
) {
  tokio::spawn(async move {
    let mut reader = BufReader::new(pipe).lines();
    while let Ok(Some(line)) = reader.next_line().await {
      log::info!("[target {source}] {line}");
      if let Some(url) = extract_localhost_url(&line) {
        if let Ok(mut guard) = url_tx.lock() {
          if let Some(tx) = guard.take() {
            let _ = tx.send(url);
          }
        }
      }
      if let Some(severity) = classify_server_line(&line) {
        let now = SystemTime::now()
          .duration_since(UNIX_EPOCH)
          .map(|d| d.as_millis())
          .unwrap_or_default();
        let event = TargetServerEvent {
          source,
          severity,
          message: line.clone(),
          ts: now,
        };
        if let Err(e) = app.emit(TARGET_SERVER_EVENT, event) {
          log::debug!("emit target server event failed: {e}");
        }
      }
    }
  });
}

/// Classify a dev-server output line by severity, or return None to skip.
/// Most lines from `next dev` / `vite` are routine progress reports we don't
/// want flooding the live tail; only the actionable ones get forwarded.
pub fn classify_server_line(line: &str) -> Option<&'static str> {
  let lower = line.to_ascii_lowercase();
  // Order matters: error wins over warn. Whole-word matches where reasonable
  // so "error.handler" doesn't trip the error branch.
  let error_markers = [
    "error:",
    "error ",
    "failed to",
    "panic:",
    "panicked",
    "module not found",
    "cannot find module",
    "syntaxerror",
    "typeerror",
    "referenceerror",
    "uncaught",
    "eaddrinuse",
    "eacces",
    "enoent",
    "fatal",
  ];
  if error_markers.iter().any(|m| lower.contains(m)) {
    return Some("error");
  }
  let warn_markers = ["warning:", "warn:", "deprecat"];
  if warn_markers.iter().any(|m| lower.contains(m)) {
    return Some("warn");
  }
  None
}

/// Parse the port from a `http(s)://localhost:PORT[/path]` URL.
fn parse_port(url: &str) -> Option<u16> {
  for prefix in ["https://localhost:", "http://localhost:"] {
    if let Some(rest) = url.strip_prefix(prefix) {
      let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
      if let Ok(p) = digits.parse::<u16>() {
        return Some(p);
      }
    }
  }
  None
}

fn extract_localhost_url(line: &str) -> Option<String> {
  for prefix in ["https://localhost:", "http://localhost:"] {
    if let Some(start) = line.find(prefix) {
      let port_start = start + prefix.len();
      let digits: String = line[port_start..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
      if !digits.is_empty() {
        return Some(format!("{prefix}{digits}"));
      }
    }
  }
  None
}

async fn reap_child(state: &State<'_, LaunchState>) -> Result<(), String> {
  let mut child = {
    let mut guard = state
      .child
      .lock()
      .map_err(|e| format!("launch state lock: {e}"))?;
    guard.take()
  };
  if let Some(c) = child.as_mut() {
    let _ = c.kill().await;
    let _ = c.wait().await;
  }
  Ok(())
}

fn open_in_browser(url: &str) -> Result<(), String> {
  let result = if cfg!(target_os = "macos") {
    std::process::Command::new("open").arg(url).spawn()
  } else if cfg!(target_os = "windows") {
    std::process::Command::new("cmd")
      .args(["/C", "start", "", url])
      .spawn()
  } else {
    std::process::Command::new("xdg-open").arg(url).spawn()
  };
  result.map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(unix)]
fn set_executable(path: &Path) -> std::io::Result<()> {
  use std::os::unix::fs::PermissionsExt;
  let mut perms = std::fs::metadata(path)?.permissions();
  perms.set_mode(0o755);
  std::fs::set_permissions(path, perms)
}

#[cfg(not(unix))]
fn set_executable(_path: &Path) -> std::io::Result<()> {
  Ok(())
}

const MAC_LAUNCH_SCRIPT: &str = r#"#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then
  echo "Installing dependencies (one-time)..."
  npm install
fi
echo "Starting dev server. The URL will appear below."
echo "Press Ctrl-C to stop."
npm run dev
"#;

const LINUX_LAUNCH_SCRIPT: &str = r#"#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then
  echo "Installing dependencies (one-time)..."
  npm install
fi
echo "Starting dev server. The URL will appear below."
echo "Press Ctrl-C to stop."
npm run dev
"#;

const WIN_LAUNCH_SCRIPT: &str = "@echo off\r\n\
cd /d \"%~dp0\"\r\n\
if not exist node_modules (\r\n\
  echo Installing dependencies (one-time)...\r\n\
  call npm install\r\n\
  if errorlevel 1 exit /b %errorlevel%\r\n\
)\r\n\
echo Starting dev server. The URL will appear below.\r\n\
echo Press Ctrl-C to stop.\r\n\
call npm run dev\r\n";

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn extracts_url_from_next_dev_line() {
    let line = "   - Local:        http://localhost:3000";
    assert_eq!(
      extract_localhost_url(line),
      Some("http://localhost:3000".to_string())
    );
  }

  #[test]
  fn extracts_url_with_https() {
    let line = "ready - started server on https://localhost:8443, url is...";
    assert_eq!(
      extract_localhost_url(line),
      Some("https://localhost:8443".to_string())
    );
  }

  #[test]
  fn returns_none_when_no_localhost() {
    assert_eq!(extract_localhost_url("compiling..."), None);
    assert_eq!(extract_localhost_url("error: missing module"), None);
  }

  #[test]
  fn returns_none_when_localhost_no_port() {
    assert_eq!(extract_localhost_url("http://localhost: hello"), None);
  }

  #[test]
  fn mac_script_starts_with_shebang_and_cd() {
    assert!(MAC_LAUNCH_SCRIPT.starts_with("#!/usr/bin/env bash"));
    assert!(MAC_LAUNCH_SCRIPT.contains("cd \"$(dirname \"$0\")\""));
    assert!(MAC_LAUNCH_SCRIPT.contains("npm run dev"));
  }

  #[test]
  fn win_script_uses_crlf() {
    assert!(WIN_LAUNCH_SCRIPT.contains("\r\n"));
    assert!(WIN_LAUNCH_SCRIPT.contains("npm run dev"));
  }

  #[test]
  fn parses_port_from_localhost_url() {
    assert_eq!(parse_port("http://localhost:3000"), Some(3000));
    assert_eq!(parse_port("https://localhost:8443/path"), Some(8443));
    assert_eq!(parse_port("http://localhost:65535"), Some(65535));
  }

  #[test]
  fn parse_port_rejects_non_localhost_or_missing_port() {
    assert_eq!(parse_port("http://example.com:3000"), None);
    assert_eq!(parse_port("http://localhost/path"), None);
    assert_eq!(parse_port(""), None);
  }

  #[test]
  fn classify_server_line_flags_errors() {
    assert_eq!(classify_server_line("Error: cannot find module 'foo'"), Some("error"));
    assert_eq!(classify_server_line("TypeError: x is undefined"), Some("error"));
    assert_eq!(classify_server_line("EADDRINUSE: address already in use"), Some("error"));
    assert_eq!(classify_server_line("Failed to compile"), Some("error"));
  }

  #[test]
  fn classify_server_line_flags_warnings() {
    assert_eq!(classify_server_line("Warning: foo is deprecated"), Some("warn"));
    assert_eq!(classify_server_line("warn: bar"), Some("warn"));
  }

  #[test]
  fn classify_server_line_skips_routine_output() {
    assert_eq!(classify_server_line(" - Local: http://localhost:3000"), None);
    assert_eq!(classify_server_line("✓ Compiled in 234ms"), None);
    assert_eq!(classify_server_line("ready - started server on..."), None);
  }
}
