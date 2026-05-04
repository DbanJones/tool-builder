// Build-phase orchestrator. Per ADR-0005 the heavy lifting moved to the
// Node sidecar (`sidecar/src/orchestrator-driver.ts`) which uses
// `@anthropic-ai/claude-agent-sdk`'s `query()` directly. This file is now
// a thin Tauri shell:
//   * `orchestrator_start` registers the webview's Channel against a fresh
//     stream id and forwards the request to the sidecar's `orch.start`.
//   * `orchestrator_stop` calls the sidecar's `orch.stop` to cancel the
//     in-flight query (via the SDK's AbortController).
//
// The old subprocess spawn / stream-json parser path was removed: it kept
// fighting Claude Code's permission system in headless mode (live test
// 2026-04-27 produced "session is locked to src-tauri/" no matter what
// flags we passed). The SDK's `canUseTool` callback gives us a real
// permission hook the dashboard can drive — that wiring lives in the
// sidecar's orchestrator-driver + the existing PermissionPromptBanner.

use serde_json::Value;
use tauri::ipc::Channel;
use tauri::State;
use uuid::Uuid;

use crate::sidecar::{sidecar_rpc, sidecar_rpc_stream, SidecarState};

/// Start a build-phase query through the SDK driver in the sidecar. Events
/// stream back via the Channel; the call resolves when the SDK's query()
/// generator ends (or aborts via orchestrator_stop).
#[tauri::command]
pub async fn orchestrator_start(
  state: State<'_, SidecarState>,
  project_id: String,
  project_path: String,
  prompt: Option<String>,
  session_id: Option<String>,
  model: Option<String>,
  on_event: Channel<Value>,
) -> Result<(), String> {
  let stream_id = Uuid::new_v4().to_string();
  let mut params = serde_json::json!({
    "streamId": stream_id,
    "projectId": project_id,
    "projectPath": project_path,
    "prompt": prompt,
    "sessionId": session_id,
  });
  if let Some(m) = model {
    params["model"] = serde_json::Value::String(m);
  }
  // Hand the stream id to the sidecar so its writeNotification(streamId, ev)
  // routes back to OUR Channel via the bridge.
  sidecar_rpc_stream(state, "orch.start".to_string(), params, stream_id, on_event)
    .map(|_| ())
}

/// Cancel an in-flight build-phase query. The sidecar's orch.stop aborts
/// the SDK's AbortController, which terminates the query() generator and
/// causes orchestrator_start to return.
#[tauri::command]
pub async fn orchestrator_stop(
  state: State<'_, SidecarState>,
  stream_id: Option<String>,
  project_id: Option<String>,
) -> Result<(), String> {
  // Prefer stream-specific cancellation when available, fall back to
  // project-scoped cancellation, and finally "cancel all" for the global
  // tab-strip Stop button.
  let params = serde_json::json!({
    "streamId": stream_id,
    "projectId": project_id,
  });
  sidecar_rpc(state, "orch.stop".to_string(), params).map(|_| ())
}

// State holder kept for API compatibility — the new architecture doesn't
// own a Child process anymore (the SDK runs in the sidecar), but lib.rs
// still calls OrchestratorState::new() at startup. Now an empty marker.
pub struct OrchestratorState;

impl OrchestratorState {
  pub fn new() -> Self {
    Self
  }
}
