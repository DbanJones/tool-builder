// Chat streaming via the `claude` CLI. See ADR-0002 for the architecture
// (Builder uses claude CLI for all Claude interactions, not the Anthropic SDK).
//
// `chat_send` spawns `claude -p --output-format stream-json` (with optional
// `--resume <session_id>` for multi-turn continuity), parses the streaming
// JSON output line by line, and pushes typed `ChatChunk` events to the
// webview via a Tauri 2 `Channel<T>`.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::process::Stdio;
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

const INTERVIEW_SYSTEM_PROMPT: &str = "You are the Builder's recursive interviewer. Your job is to populate the project's spec.md by asking the novice one question at a time from the kit's question library (Q1-Q28 fast-path, plus high-stakes follow-ups when activated).

How to ask:
- One question per turn. Plain language. No jargon unless you have just defined it.
- For closed questions (yes/no, single-select from a known list, multi-select from a known list), call the `offer_options` tool ALONGSIDE your question. Provide the candidate options and set allow_freeform=true so the novice can also type their own answer. The UI renders the options as click-to-pick buttons. Use offer_options for things like 'Will this app take payments? (yes / no / not sure)' or 'Pick a design direction: clean & minimal / expressive & bold / professional / you choose'.
- For open-ended questions (the elevator pitch, the list of top 5 flows), do not offer options; the novice will write a paragraph.
- When the answer is vague, contradictory with an earlier answer, or covers a high-stakes topic (auth, payments, data model, deploy target), follow up with a sharper question. There is no depth limit on follow-ups; close the branch only when the novice answers clearly or says 'you choose' / 'I do not mind'.
- When the novice defers ('you choose'), apply the kit default and record confidence='default-applied'.
- Surface a topic counter at the start of each turn in the form 'Topic N of 28'. Increment it only when you have moved on from a topic, not for follow-ups within one.

How to record:
- After every clear answer (or applied default), call the `record_answer` tool with the kit question id (e.g. Q1, Q15), the novice's answer (or your faithful summary of it in their own words), a confidence ('confident' for direct, 'tentative' for inferred or partial, 'default-applied' when the kit default was used), and a short rationale if the confidence is not 'confident'.
- Write a one-sentence acknowledgement to the chat after recording so the novice sees their answer landed.

Do not invent answers. If the novice's answer is unclear after one follow-up, mark it tentative and move on; the spec preview will show it as outstanding.";

/// Generate the MCP config JSON that claude consumes via `--mcp-config`.
/// Per ADR-0004 the MCP server is a separate Node entry point that opens its
/// own better-sqlite3 connection on the same DB file the main sidecar uses.
fn build_mcp_config(project_id: &str, project_root: &PathBuf) -> Result<PathBuf, String> {
  let cwd = std::env::current_dir().map_err(|e| format!("cwd: {e}"))?;
  let mcp_server_script = cwd.join("sidecar").join("dist").join("mcp-server.js");
  let migrations_folder = cwd.join("sidecar").join("migrations");
  let db_path = project_root.join(".builder").join("builder.db");

  if !mcp_server_script.exists() {
    return Err(format!(
      "mcp-server build missing at {}; run pnpm sidecar:build",
      mcp_server_script.display()
    ));
  }

  let config = serde_json::json!({
    "mcpServers": {
      "builder-record-answer": {
        "command": "node",
        "args": [
          mcp_server_script.to_string_lossy(),
          "--db-path", db_path.to_string_lossy(),
          "--migrations-folder", migrations_folder.to_string_lossy(),
          "--project-id", project_id,
        ],
      },
    },
  });

  let config_dir = project_root.join(".builder");
  fs::create_dir_all(&config_dir)
    .map_err(|e| format!("create .builder/: {e}"))?;
  let config_path = config_dir.join("mcp-config.json");
  fs::write(&config_path, serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?)
    .map_err(|e| format!("write mcp config: {e}"))?;
  Ok(config_path)
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChatChunk {
  /// Emitted once per turn, immediately after claude's `system.init` event.
  Session { id: String },
  /// A piece of assistant text. Multiple of these arrive per turn; concatenate
  /// in order to render the full message as it streams.
  AssistantDelta { text: String },
  /// Emitted when claude calls the `offer_options` MCP tool. The UI should
  /// render the options as click-to-pick buttons next to the input.
  OptionsOffered {
    question: String,
    options: Vec<String>,
    allow_freeform: bool,
  },
  /// Emitted once at the end of a successful turn.
  Done {
    cost_usd: Option<f64>,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
  },
  /// Subprocess exited non-zero AND stderr looked like a rate-limit error.
  RateLimit { message: String },
  /// Subprocess exited non-zero with no specific signal we recognise.
  Error { message: String },
}

/// Inspect a single line of `claude --output-format stream-json` output and
/// return the corresponding chunks to forward. Returns an empty vec for
/// uninteresting event types (e.g. `user`-message echoes). One stream line
/// can yield multiple chunks: an assistant message can carry both text and
/// a tool_use call to `offer_options`; both surface to the UI.
pub fn parse_stream_line(line: &str) -> Vec<ChatChunk> {
  let value: Value = match serde_json::from_str(line.trim()) {
    Ok(v) => v,
    Err(_) => return vec![],
  };
  let Some(event_type) = value.get("type").and_then(|v| v.as_str()) else {
    return vec![];
  };
  match event_type {
    "system" => {
      if value.get("subtype").and_then(|v| v.as_str()) != Some("init") {
        return vec![];
      }
      let Some(id) = value.get("session_id").and_then(|v| v.as_str()) else {
        return vec![];
      };
      vec![ChatChunk::Session { id: id.to_string() }]
    }
    "assistant" => {
      let Some(content) = value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
      else {
        return vec![];
      };
      let mut chunks: Vec<ChatChunk> = vec![];
      let mut text = String::new();
      for block in content {
        let Some(block_type) = block.get("type").and_then(|v| v.as_str()) else {
          continue;
        };
        match block_type {
          "text" => {
            if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
              text.push_str(t);
            }
          }
          "tool_use" => {
            // We only forward calls to our own UI-facing tool. record_answer
            // and any other MCP tool calls run silently.
            if block.get("name").and_then(|v| v.as_str()) == Some("offer_options") {
              if let Some(input) = block.get("input") {
                let question = input
                  .get("question")
                  .and_then(|v| v.as_str())
                  .unwrap_or("")
                  .to_string();
                let options = input
                  .get("options")
                  .and_then(|v| v.as_array())
                  .map(|arr| {
                    arr
                      .iter()
                      .filter_map(|o| o.as_str().map(|s| s.to_string()))
                      .collect()
                  })
                  .unwrap_or_default();
                let allow_freeform = input
                  .get("allow_freeform")
                  .and_then(|v| v.as_bool())
                  .unwrap_or(true);
                chunks.push(ChatChunk::OptionsOffered {
                  question,
                  options,
                  allow_freeform,
                });
              }
            }
          }
          _ => {}
        }
      }
      if !text.is_empty() {
        chunks.insert(0, ChatChunk::AssistantDelta { text });
      }
      chunks
    }
    "result" => {
      if value.get("subtype").and_then(|v| v.as_str()) != Some("success") {
        return vec![];
      }
      vec![ChatChunk::Done {
        cost_usd: value.get("total_cost_usd").and_then(|v| v.as_f64()),
        input_tokens: value
          .get("usage")
          .and_then(|u| u.get("input_tokens"))
          .and_then(|v| v.as_u64()),
        output_tokens: value
          .get("usage")
          .and_then(|u| u.get("output_tokens"))
          .and_then(|v| v.as_u64()),
      }]
    }
    _ => vec![],
  }
}

pub fn detect_rate_limit(stderr: &str) -> bool {
  let lower = stderr.to_lowercase();
  lower.contains("rate limit")
    || lower.contains("rate_limit")
    || lower.contains("rate-limit")
    || lower.contains("too many requests")
}

#[tauri::command]
pub async fn chat_send(
  prompt: String,
  session_id: Option<String>,
  project_id: Option<String>,
  project_path: Option<String>,
  on_chunk: Channel<ChatChunk>,
) -> Result<(), String> {
  let mut command = Command::new("claude");
  command
    .arg("-p")
    .arg("--output-format")
    .arg("stream-json")
    .arg("--verbose"); // claude requires --verbose to stream; otherwise it batches

  // Per the human's 2026-04-26 direction: Opus on the first turn (high-quality
  // first impression, sets the tone), Sonnet on subsequent turns (faster,
  // cheaper; Sonnet handles its own adaptive thinking).
  if session_id.is_none() {
    command.arg("--model").arg("opus");
  } else {
    command.arg("--model").arg("sonnet");
  }

  // Wire the record_answer + offer_options MCP server when we have a project
  // context. Per build-order.md B2 + ADR-0004. If either project_id or
  // project_path is missing, fall back to plain chat (preserves the A5
  // minimum chat path).
  if let (Some(pid), Some(ppath)) = (&project_id, &project_path) {
    let project_root = PathBuf::from(ppath);
    match build_mcp_config(pid, &project_root) {
      Ok(config_path) => {
        command.arg("--mcp-config").arg(&config_path);
      }
      Err(e) => {
        log::warn!("MCP config build failed; chat falls back to no-tools: {e}");
      }
    }
  }

  if let Some(sid) = &session_id {
    command.arg("--resume").arg(sid);
  } else {
    command
      .arg("--append-system-prompt")
      .arg(INTERVIEW_SYSTEM_PROMPT);
  }

  command
    .arg(&prompt)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());

  let mut child = command.spawn().map_err(|e| format!("spawn claude: {e}"))?;

  let stdout = child
    .stdout
    .take()
    .ok_or_else(|| "claude stdout missing".to_string())?;
  let mut stderr = child
    .stderr
    .take()
    .ok_or_else(|| "claude stderr missing".to_string())?;

  let mut reader = BufReader::new(stdout).lines();
  while let Some(line) = reader
    .next_line()
    .await
    .map_err(|e| format!("read stdout: {e}"))?
  {
    for chunk in parse_stream_line(&line) {
      on_chunk
        .send(chunk)
        .map_err(|e| format!("channel send: {e}"))?;
    }
  }

  let mut stderr_text = String::new();
  let _ = tokio::io::AsyncReadExt::read_to_string(&mut stderr, &mut stderr_text).await;
  let status = child.wait().await.map_err(|e| format!("wait: {e}"))?;

  if !status.success() {
    if detect_rate_limit(&stderr_text) {
      let _ = on_chunk.send(ChatChunk::RateLimit {
        message: "Claude is rate-limited. Try again in a few minutes.".to_string(),
      });
    } else {
      let message = if stderr_text.trim().is_empty() {
        format!("claude exited with status {status}")
      } else {
        stderr_text.trim().to_string()
      };
      let _ = on_chunk.send(ChatChunk::Error { message });
    }
  }

  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn first(line: &str) -> ChatChunk {
    parse_stream_line(line).into_iter().next().expect("expected at least one chunk")
  }

  #[test]
  fn parses_system_init_into_session() {
    let line = r#"{"type":"system","subtype":"init","session_id":"abc-123","model":"sonnet"}"#;
    match first(line) {
      ChatChunk::Session { id } => assert_eq!(id, "abc-123"),
      _ => panic!("wrong variant"),
    }
  }

  #[test]
  fn ignores_system_subtypes_other_than_init() {
    let line = r#"{"type":"system","subtype":"compact","details":{}}"#;
    assert!(parse_stream_line(line).is_empty());
  }

  #[test]
  fn parses_assistant_text_block() {
    let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}]}}"#;
    match first(line) {
      ChatChunk::AssistantDelta { text } => assert_eq!(text, "Hello"),
      _ => panic!("wrong variant"),
    }
  }

  #[test]
  fn concatenates_multiple_text_blocks_in_one_assistant_message() {
    let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello "},{"type":"text","text":"world"}]}}"#;
    match first(line) {
      ChatChunk::AssistantDelta { text } => assert_eq!(text, "Hello world"),
      _ => panic!("wrong variant"),
    }
  }

  #[test]
  fn assistant_with_only_unknown_tool_use_returns_no_chunks() {
    // Unknown tools (e.g. record_answer) execute silently; we don't surface them.
    let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"x","name":"record_answer","input":{}}]}}"#;
    assert!(parse_stream_line(line).is_empty());
  }

  #[test]
  fn parses_offer_options_tool_use_into_options_offered_chunk() {
    let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"x","name":"offer_options","input":{"question":"Will this app take payments?","options":["yes","no","not sure"],"allow_freeform":true}}]}}"#;
    match first(line) {
      ChatChunk::OptionsOffered { question, options, allow_freeform } => {
        assert_eq!(question, "Will this app take payments?");
        assert_eq!(options, vec!["yes".to_string(), "no".to_string(), "not sure".to_string()]);
        assert!(allow_freeform);
      }
      _ => panic!("wrong variant"),
    }
  }

  #[test]
  fn assistant_with_text_and_offer_options_returns_text_first_then_options() {
    let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Topic 5 of 28. Pick one:"},{"type":"tool_use","id":"x","name":"offer_options","input":{"question":"Pick a design direction","options":["clean","bold"],"allow_freeform":true}}]}}"#;
    let chunks = parse_stream_line(line);
    assert_eq!(chunks.len(), 2);
    match &chunks[0] {
      ChatChunk::AssistantDelta { text } => assert_eq!(text, "Topic 5 of 28. Pick one:"),
      _ => panic!("wrong first variant"),
    }
    match &chunks[1] {
      ChatChunk::OptionsOffered { options, .. } => {
        assert_eq!(options, &vec!["clean".to_string(), "bold".to_string()]);
      }
      _ => panic!("wrong second variant"),
    }
  }

  #[test]
  fn offer_options_defaults_allow_freeform_true_when_missing() {
    let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"x","name":"offer_options","input":{"question":"q","options":["a","b"]}}]}}"#;
    match first(line) {
      ChatChunk::OptionsOffered { allow_freeform, .. } => assert!(allow_freeform),
      _ => panic!("wrong variant"),
    }
  }

  #[test]
  fn ignores_user_message_echoes() {
    let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#;
    assert!(parse_stream_line(line).is_empty());
  }

  #[test]
  fn parses_result_success_with_usage_and_cost() {
    let line = r#"{"type":"result","subtype":"success","total_cost_usd":0.0123,"usage":{"input_tokens":42,"output_tokens":7}}"#;
    match first(line) {
      ChatChunk::Done {
        cost_usd,
        input_tokens,
        output_tokens,
      } => {
        assert!((cost_usd.unwrap() - 0.0123).abs() < 1e-9);
        assert_eq!(input_tokens, Some(42));
        assert_eq!(output_tokens, Some(7));
      }
      _ => panic!("wrong variant"),
    }
  }

  #[test]
  fn ignores_result_error_subtypes() {
    let line = r#"{"type":"result","subtype":"error_during_execution","error":"boom"}"#;
    assert!(parse_stream_line(line).is_empty());
  }

  #[test]
  fn returns_empty_for_malformed_json() {
    assert!(parse_stream_line("not json at all").is_empty());
    assert!(parse_stream_line("").is_empty());
    assert!(parse_stream_line("{").is_empty());
  }

  #[test]
  fn detects_common_rate_limit_phrasings() {
    assert!(detect_rate_limit("Error: Rate limit exceeded. Try again later."));
    assert!(detect_rate_limit("HTTP 429: rate_limit_error"));
    assert!(detect_rate_limit("Too Many Requests"));
    assert!(detect_rate_limit("RATE-LIMIT reached"));
  }

  #[test]
  fn does_not_flag_unrelated_errors_as_rate_limit() {
    assert!(!detect_rate_limit("Authentication failed"));
    assert!(!detect_rate_limit("Network unreachable"));
    assert!(!detect_rate_limit(""));
  }
}
