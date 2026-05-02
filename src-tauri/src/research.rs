// Deep-research Tauri command (Flow M / ADR-0017). Pass-through to the
// sidecar's research.start over the streaming bridge. The driver lives
// in sidecar/src/research-driver.ts; this file is just the webview-side
// entry point that allocates a streamId and binds the Channel.
//
// The deep-research system prompt is embedded into the binary at compile
// time via include_str! and shipped to the sidecar inside the params
// payload. This is the same pattern lib.rs uses for the project
// scaffolding templates (TEMPLATE_CLAUDE_MD etc.) — keeps the prompt
// file as the source of truth (rule L20) without requiring the sidecar
// to resolve a runtime file path. Works identically in dev and in a
// shipped Tauri build because the bytes are already inside the binary.

use serde_json::Value;
use tauri::ipc::Channel;
use tauri::State;
use uuid::Uuid;

use crate::sidecar::{sidecar_rpc, sidecar_rpc_stream, SidecarState};

// v2 (ADR-0017 follow-up): tool-aware prompt with WebSearch / WebFetch /
// Read instructions and the `_(via deep research)_` marker convention so
// the spec view can highlight new content.
const DEEP_RESEARCH_SYSTEM_PROMPT: &str =
  include_str!("../../lib/llm/prompts/deep-research.v2.md");

#[tauri::command]
pub async fn research_start(
  state: State<'_, SidecarState>,
  project_id: String,
  project_path: String,
  spec_markdown: String,
  answers_digest: String,
  files_digest: String,
  model: Option<String>,
  on_event: Channel<Value>,
) -> Result<String, String> {
  let stream_id = Uuid::new_v4().to_string();
  let mut params = serde_json::json!({
    "streamId": stream_id,
    "projectId": project_id,
    "projectPath": project_path,
    "specMarkdown": spec_markdown,
    "answersDigest": answers_digest,
    "filesDigest": files_digest,
    "systemPrompt": DEEP_RESEARCH_SYSTEM_PROMPT,
  });
  if let Some(m) = model {
    params["model"] = serde_json::Value::String(m);
  }
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
