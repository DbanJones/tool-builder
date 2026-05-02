// Interview-chat Tauri command. Per ADR-0005 (extended) the chat driver
// moved to the Node sidecar (sidecar/src/chat-driver.ts). This file is
// now a thin pass-through that hands the request to the sidecar's
// chat.start over the streaming bridge.
//
// The previous CLI subprocess + stream-json parser + offer_options /
// queue_questions MCP server (mcp-server.ts) are retired by this
// migration. The MCP tools are now SDK-MCP tools defined in-process by
// chat-driver.ts using createSdkMcpServer + tool() — no separate Node
// subprocess, no per-turn mcp-config.json, no permission UI for the
// chat path (only the chat MCP tools are allowed).

use serde_json::Value;
use tauri::ipc::Channel;
use tauri::State;
use uuid::Uuid;

use crate::sidecar::{sidecar_rpc, sidecar_rpc_stream, SidecarState};

#[tauri::command]
pub async fn chat_send(
  state: State<'_, SidecarState>,
  prompt: String,
  session_id: Option<String>,
  project_id: Option<String>,
  project_path: Option<String>,
  model: Option<String>,
  on_chunk: Channel<Value>,
) -> Result<(), String> {
  // Project id + path are required for the SDK driver to thread them
  // into the answers table + cwd. Older callers might omit them on
  // pure A5-style chat probes; reject loudly so the regression is
  // visible rather than silently producing empty output.
  let project_id = project_id.ok_or_else(|| "chat_send: project_id is required".to_string())?;
  let project_path =
    project_path.ok_or_else(|| "chat_send: project_path is required".to_string())?;

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
  sidecar_rpc_stream(state, "chat.start".to_string(), params, stream_id, on_chunk).map(|_| ())
}

/// Cancel an in-flight chat turn. Mirrors orchestrator_stop's shape;
/// without a streamId it's a no-op.
#[tauri::command]
pub async fn chat_stop(
  state: State<'_, SidecarState>,
  stream_id: Option<String>,
) -> Result<(), String> {
  let Some(sid) = stream_id else {
    return Ok(());
  };
  let params = serde_json::json!({ "streamId": sid });
  sidecar_rpc(state, "chat.stop".to_string(), params).map(|_| ())
}
