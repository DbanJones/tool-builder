// Deep-research Tauri command (Flow M / ADR-0017). Pass-through to the
// sidecar's research.start over the streaming bridge. The driver lives
// in sidecar/src/research-driver.ts; this file is just the webview-side
// entry point that allocates a streamId and binds the Channel.

use serde_json::Value;
use tauri::ipc::Channel;
use tauri::State;
use uuid::Uuid;

use crate::sidecar::{sidecar_rpc, sidecar_rpc_stream, SidecarState};

#[tauri::command]
pub async fn research_start(
  state: State<'_, SidecarState>,
  project_id: String,
  project_path: String,
  spec_markdown: String,
  answers_digest: String,
  files_digest: String,
  on_event: Channel<Value>,
) -> Result<String, String> {
  let stream_id = Uuid::new_v4().to_string();
  let params = serde_json::json!({
    "streamId": stream_id,
    "projectId": project_id,
    "projectPath": project_path,
    "specMarkdown": spec_markdown,
    "answersDigest": answers_digest,
    "filesDigest": files_digest,
  });
  sidecar_rpc_stream(state, "research.start".to_string(), params, stream_id.clone(), on_event)
    .map(|_| stream_id)
}

#[tauri::command]
pub async fn research_stop(
  state: State<'_, SidecarState>,
  stream_id: Option<String>,
) -> Result<(), String> {
  let params = serde_json::json!({ "streamId": stream_id });
  sidecar_rpc(state, "research.stop".to_string(), params).map(|_| ())
}
