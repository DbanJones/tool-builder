// Sidecar process lifecycle and RPC. See ADR-0004.

use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, State};

pub struct SidecarHandle {
  pub stdin: ChildStdin,
  pub stdout: BufReader<ChildStdout>,
  // Held to keep the child process alive for the lifetime of the app.
  // Dropped on app exit; OS reaps the process via SIGPIPE on stdin close.
  #[allow(dead_code)]
  pub child: Child,
}

pub struct SidecarState {
  pub handle: Mutex<Option<SidecarHandle>>,
  pub next_id: AtomicU64,
}

impl SidecarState {
  pub fn new() -> Self {
    Self {
      handle: Mutex::new(None),
      next_id: AtomicU64::new(1),
    }
  }
}

/// Spawn the Node sidecar process. Returns a handle holding stdin/stdout.
///
/// For dev: looks for `sidecar/dist/index.js` relative to the current working
/// directory, which is the project root when launched via `pnpm tauri dev`.
/// For production: a single-executable bundle is a Phase E task; this function
/// will be revised to point at the bundled binary.
pub fn spawn_sidecar(_app: &AppHandle) -> Result<SidecarHandle, String> {
  let cwd = std::env::current_dir().map_err(|e| format!("cwd: {e}"))?;
  let sidecar_script: PathBuf = cwd.join("sidecar").join("dist").join("index.js");

  if !sidecar_script.exists() {
    return Err(format!(
      "sidecar script not found at {}; run `pnpm sidecar:build` first",
      sidecar_script.display()
    ));
  }

  let mut child = Command::new("node")
    .arg(&sidecar_script)
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

  Ok(SidecarHandle {
    stdin,
    stdout: BufReader::new(stdout),
    child,
  })
}

/// Send a JSON-RPC request to the sidecar and return its response.
///
/// Synchronous: serialised by the `Mutex` on `SidecarState`. While
/// the Builder is single-window single-user this is fine; if we ever need
/// parallel queries we will switch to a worker-thread + request-id matching
/// design.
#[tauri::command]
pub fn sidecar_rpc(
  state: State<'_, SidecarState>,
  method: String,
  params: Value,
) -> Result<Value, String> {
  let mut guard = state
    .handle
    .lock()
    .map_err(|e| format!("sidecar lock poisoned: {e}"))?;
  let handle = guard
    .as_mut()
    .ok_or_else(|| "sidecar not started; check setup logs".to_string())?;

  let id = state.next_id.fetch_add(1, Ordering::Relaxed);
  let request = serde_json::json!({
    "id": id.to_string(),
    "method": method,
    "params": params,
  });

  let request_str =
    serde_json::to_string(&request).map_err(|e| format!("serialise request: {e}"))?;

  writeln!(handle.stdin, "{request_str}").map_err(|e| format!("write to sidecar stdin: {e}"))?;
  handle
    .stdin
    .flush()
    .map_err(|e| format!("flush sidecar stdin: {e}"))?;

  let mut response_line = String::new();
  handle
    .stdout
    .read_line(&mut response_line)
    .map_err(|e| format!("read from sidecar stdout: {e}"))?;

  if response_line.is_empty() {
    return Err("sidecar closed stdout (process likely died)".to_string());
  }

  serde_json::from_str(response_line.trim())
    .map_err(|e| format!("parse sidecar response: {e}; raw: {response_line}"))
}
