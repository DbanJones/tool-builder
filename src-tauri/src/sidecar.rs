// Sidecar process lifecycle and RPC. See ADR-0004 + ADR-0005.
//
// Two protocols share one stdout pipe:
//   1. Request/response: webview → Tauri → sidecar; one response per id.
//   2. Notifications: sidecar → Tauri → webview Channel; many per stream.
//
// A single background reader thread owns sidecar stdout. Each line it
// reads is dispatched by shape:
//   - { id }                                → wake the pending request
//   - { notification: { stream, event } }   → forward event onto the
//                                              registered Channel
// Both pending requests AND notification channels live in `SidecarState`.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel as mpsc_channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

pub struct SidecarHandle {
  pub stdin: Mutex<ChildStdin>,
  // Held to keep the child process alive for the lifetime of the app.
  // Dropped on app exit; OS reaps the process via SIGPIPE on stdin close.
  #[allow(dead_code)]
  pub child: Child,
}

/// One in-flight request awaiting its response.
type PendingMap = Arc<Mutex<HashMap<String, Sender<Value>>>>;
/// One stream id → the webview Channel that wants the events. Notifications
/// are serialised as JSON Values; the Channel<Value> trips Tauri's serde
/// pipe to forward them to the webview.
type ChannelMap = Arc<Mutex<HashMap<String, Channel<Value>>>>;

pub struct SidecarState {
  pub handle: Mutex<Option<SidecarHandle>>,
  pub next_id: AtomicU64,
  pub pending: PendingMap,
  pub channels: ChannelMap,
}

impl SidecarState {
  pub fn new() -> Self {
    Self {
      handle: Mutex::new(None),
      next_id: AtomicU64::new(1),
      pending: Arc::new(Mutex::new(HashMap::new())),
      channels: Arc::new(Mutex::new(HashMap::new())),
    }
  }
}

/// Resolve the project root for dev. Tauri runs cargo from `src-tauri/`, so
/// cwd ends in `src-tauri`; everywhere else cwd IS the project root.
pub fn project_root_from_cwd() -> Result<PathBuf, String> {
  let cwd = std::env::current_dir().map_err(|e| format!("cwd: {e}"))?;
  // A packaged macOS .app launched from Finder has cwd="/"; that is
  // NOT a meaningful "Builder source folder" — treat it as not-in-dev
  // so callers can skip dev-only checks (e.g. the
  // build_capability_check "inside Builder source" guard).
  if cwd == PathBuf::from("/") {
    return Err("not running from a dev tree (cwd is filesystem root)".to_string());
  }
  if cwd.file_name().and_then(|n| n.to_str()) == Some("src-tauri") {
    cwd
      .parent()
      .map(|p| p.to_path_buf())
      .ok_or_else(|| "src-tauri has no parent".to_string())
  } else {
    Ok(cwd)
  }
}

/// Resolve where the sidecar lives at runtime. Two strategies in order:
///
/// 1. **Dev tree**: cwd points at the repo (or src-tauri/), `sidecar/dist`
///    exists relative to it. Use that path so dev iterations don't require
///    re-running `package-sidecar.mjs`.
/// 2. **Packaged .app / .msi**: Tauri's bundle.resources lands the
///    `sidecar-bundle/` directory under Resources/. Resolve via
///    `app.path().resource_dir()`. This is what makes the .app actually
///    work end-to-end.
fn resolve_sidecar_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf, PathBuf), String> {
  // Try dev tree first.
  if let Ok(project_root) = project_root_from_cwd() {
    let dev_script = project_root.join("sidecar").join("dist").join("index.js");
    let dev_migrations = project_root.join("sidecar").join("migrations");
    let dev_db = project_root.join(".builder").join("builder.db");
    if dev_script.exists() && dev_migrations.exists() {
      return Ok((dev_script, dev_migrations, dev_db));
    }
  }
  // Fall back to bundled resources (packaged .app / .msi).
  let resource_dir = app
    .path()
    .resource_dir()
    .map_err(|e| format!("resource_dir unavailable: {e}"))?;
  let bundle = resource_dir.join("sidecar-bundle");
  let bundled_script = bundle.join("dist").join("index.js");
  let bundled_migrations = bundle.join("migrations");
  if !bundled_script.exists() {
    return Err(format!(
      "sidecar script not found in bundle at {} (and no dev tree available)",
      bundled_script.display()
    ));
  }
  if !bundled_migrations.exists() {
    return Err(format!(
      "sidecar migrations folder not found in bundle at {}",
      bundled_migrations.display()
    ));
  }
  // The packaged .app cannot write to its own Resources/. Drop the DB
  // (and the rest of `.builder/`) into the user's app-data folder
  // instead. Tauri's `app_data_dir()` resolves to the platform-correct
  // location (~/Library/Application Support/<bundleId>/ on macOS,
  // %APPDATA%\<bundleId>\ on Windows, ~/.local/share/<bundleId>/ on
  // Linux).
  let app_data = app
    .path()
    .app_data_dir()
    .map_err(|e| format!("app_data_dir unavailable: {e}"))?;
  let builder_state_dir = app_data.join(".builder");
  std::fs::create_dir_all(&builder_state_dir)
    .map_err(|e| format!("create app_data .builder dir: {e}"))?;
  let bundled_db = builder_state_dir.join("builder.db");
  Ok((bundled_script, bundled_migrations, bundled_db))
}

/// Spawn the Node sidecar process + start the background reader thread that
/// dispatches responses + notifications. Returns the handle (stdin only —
/// stdout is owned by the reader thread).
pub fn spawn_sidecar(
  app: &AppHandle,
  pending: PendingMap,
  channels: ChannelMap,
) -> Result<SidecarHandle, String> {
  let (sidecar_script, migrations_folder, db_path) = resolve_sidecar_paths(app)?;
  log::info!(
    "sidecar: script={} migrations={} db={}",
    sidecar_script.display(),
    migrations_folder.display(),
    db_path.display()
  );

  let mut child = Command::new("node")
    .arg(&sidecar_script)
    .arg("--db-path")
    .arg(&db_path)
    .arg("--migrations-folder")
    .arg(&migrations_folder)
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::inherit())
    .spawn()
    .map_err(|e| format!("failed to spawn sidecar via 'node': {e}"))?;

  let stdin = child
    .stdin
    .take()
    .ok_or_else(|| "failed to capture sidecar stdin".to_string())?;
  let stdout = child
    .stdout
    .take()
    .ok_or_else(|| "failed to capture sidecar stdout".to_string())?;

  // Background reader. Loops until stdout EOF (sidecar exit).
  thread::spawn(move || {
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    loop {
      line.clear();
      match reader.read_line(&mut line) {
        Ok(0) => {
          log::warn!("sidecar stdout EOF; reader thread exiting");
          break;
        }
        Ok(_) => dispatch_line(&line, &pending, &channels),
        Err(e) => {
          log::warn!("sidecar stdout read error: {e}; reader thread exiting");
          break;
        }
      }
    }
  });

  Ok(SidecarHandle {
    stdin: Mutex::new(stdin),
    child,
  })
}

fn dispatch_line(line: &str, pending: &PendingMap, channels: &ChannelMap) {
  let trimmed = line.trim();
  if trimmed.is_empty() {
    return;
  }
  let value: Value = match serde_json::from_str(trimmed) {
    Ok(v) => v,
    Err(_) => {
      log::warn!("sidecar emitted non-JSON line: {trimmed}");
      return;
    }
  };

  // Notification path.
  if let Some(notif) = value.get("notification") {
    let stream = notif.get("stream").and_then(|v| v.as_str()).unwrap_or("");
    let event = notif.get("event").cloned().unwrap_or(Value::Null);
    let map = match channels.lock() {
      Ok(g) => g,
      Err(_) => return,
    };
    if let Some(ch) = map.get(stream) {
      if let Err(e) = ch.send(event) {
        log::warn!("sidecar notification send failed for stream {stream}: {e}");
      }
    } else {
      log::warn!("no channel registered for stream {stream}; dropping notification");
    }
    return;
  }

  // Response path.
  let id = match value.get("id").and_then(|v| v.as_str()) {
    Some(id) => id.to_string(),
    None => {
      log::warn!("sidecar line has no id and no notification: {trimmed}");
      return;
    }
  };
  let mut map = match pending.lock() {
    Ok(g) => g,
    Err(_) => return,
  };
  if let Some(tx) = map.remove(&id) {
    let _ = tx.send(value);
  } else {
    log::warn!("sidecar response for unknown id {id}; dropping");
  }
}

/// Internal: send a request and wait for a response with an optional
/// timeout. `None` waits forever — required by streaming methods
/// (orch.start / chat.start / research.start) whose final response
/// only lands when the SDK session ends, which can be hours later.
fn sidecar_rpc_inner(
  state: &State<'_, SidecarState>,
  method: String,
  params: Value,
  timeout: Option<std::time::Duration>,
) -> Result<Value, String> {
  let id = state.next_id.fetch_add(1, Ordering::Relaxed).to_string();
  let (tx, rx) = mpsc_channel();
  state
    .pending
    .lock()
    .map_err(|e| format!("pending lock: {e}"))?
    .insert(id.clone(), tx);

  let request = serde_json::json!({ "id": id, "method": method, "params": params });
  let request_str = serde_json::to_string(&request).map_err(|e| format!("serialise: {e}"))?;
  write_to_sidecar(state, &request_str)?;

  let result = match timeout {
    Some(d) => rx.recv_timeout(d).map_err(|_| {
      format!("sidecar response timed out after {}s for method={method}", d.as_secs())
    }),
    None => rx.recv().map_err(|e| format!("sidecar response channel closed: {e}")),
  };
  if result.is_err() {
    // Best-effort cleanup so a later, successful response doesn't try
    // to write into a dropped sender.
    if let Ok(mut map) = state.pending.lock() {
      map.remove(&id);
    }
  }
  result
}

/// Send a JSON-RPC request to the sidecar and return its response.
/// Default 30s timeout — generous enough for any non-streaming call
/// (DB read, file ingest, debug.scan in Layer 1 mode) on a real
/// machine. Streaming calls go through sidecar_rpc_stream which is
/// unbounded.
#[tauri::command]
pub fn sidecar_rpc(
  state: State<'_, SidecarState>,
  method: String,
  params: Value,
) -> Result<Value, String> {
  sidecar_rpc_inner(&state, method, params, Some(std::time::Duration::from_secs(30)))
}

/// Streaming variant: same request shape, but the webview supplies a
/// Channel<Value> for the per-stream events. Caller is responsible for
/// putting the streamId into `params` so the sidecar's notifications
/// route correctly. Returns the final response.
#[tauri::command]
pub fn sidecar_rpc_stream(
  state: State<'_, SidecarState>,
  method: String,
  params: Value,
  stream_id: String,
  on_event: Channel<Value>,
) -> Result<Value, String> {
  // Register the channel before we send the request so we don't miss the
  // first notification if the sidecar replies fast.
  state
    .channels
    .lock()
    .map_err(|e| format!("channels lock: {e}"))?
    .insert(stream_id.clone(), on_event);

  // Streaming calls (orch.start / chat.start / research.start) only
  // resolve when the SDK session ends — minutes for a chat turn, hours
  // for a build. Pass `None` so the rx.recv waits indefinitely; the
  // webview's per-call cancellation (chat.stop / orch.stop / research
  // .stop) is what unblocks it.
  let result = sidecar_rpc_inner(&state, method, params, None);

  // Always unregister.
  if let Ok(mut map) = state.channels.lock() {
    map.remove(&stream_id);
  }
  result
}

fn write_to_sidecar(state: &State<'_, SidecarState>, request_str: &str) -> Result<(), String> {
  let mut handle_guard = state
    .handle
    .lock()
    .map_err(|e| format!("sidecar handle lock: {e}"))?;
  let handle = handle_guard
    .as_mut()
    .ok_or_else(|| "sidecar not started; check setup logs".to_string())?;
  let mut stdin = handle
    .stdin
    .lock()
    .map_err(|e| format!("sidecar stdin lock: {e}"))?;
  writeln!(stdin, "{request_str}").map_err(|e| format!("write to sidecar stdin: {e}"))?;
  stdin
    .flush()
    .map_err(|e| format!("flush sidecar stdin: {e}"))?;
  Ok(())
}

// Backwards-compat: send a notification request from a side-rust caller
// that doesn't have access to `State` (used by tests / future callers).
// Currently unused but kept to mirror the JS-side `writeNotification`.
#[allow(dead_code)]
#[derive(Serialize)]
struct NotificationFrame<'a> {
  notification: NotificationBody<'a>,
}
#[allow(dead_code)]
#[derive(Serialize)]
struct NotificationBody<'a> {
  stream: &'a str,
  event: Value,
}
