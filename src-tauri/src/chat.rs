// Chat streaming via the `claude` CLI. See ADR-0002 for the architecture
// (Builder uses claude CLI for all Claude interactions, not the Anthropic SDK).
//
// `chat_send` spawns `claude -p --output-format stream-json` (with optional
// `--resume <session_id>` for multi-turn continuity), parses the streaming
// JSON output line by line, and pushes typed `ChatChunk` events to the
// webview via a Tauri 2 `Channel<T>`.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::process::Stdio;
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

const INTERVIEW_SYSTEM_PROMPT: &str = "You are interviewing the user to populate spec.md. Ask one question at a time. After each answer, write a brief summary to the chat.";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChatChunk {
  /// Emitted once per turn, immediately after claude's `system.init` event.
  Session { id: String },
  /// A piece of assistant text. Multiple of these arrive per turn; concatenate
  /// in order to render the full message as it streams.
  AssistantDelta { text: String },
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
/// return the corresponding chunk to forward, or None to skip (uninteresting
/// event types like `user`-message echoes).
pub fn parse_stream_line(line: &str) -> Option<ChatChunk> {
  let value: Value = serde_json::from_str(line.trim()).ok()?;
  let event_type = value.get("type")?.as_str()?;
  match event_type {
    "system" => {
      if value.get("subtype")?.as_str()? != "init" {
        return None;
      }
      let id = value.get("session_id")?.as_str()?.to_string();
      Some(ChatChunk::Session { id })
    }
    "assistant" => {
      let content = value
        .get("message")?
        .get("content")?
        .as_array()?;
      let mut text = String::new();
      for block in content {
        if block.get("type")?.as_str()? == "text" {
          if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
            text.push_str(t);
          }
        }
      }
      if text.is_empty() {
        None
      } else {
        Some(ChatChunk::AssistantDelta { text })
      }
    }
    "result" => {
      let subtype = value.get("subtype")?.as_str()?;
      if subtype != "success" {
        return None;
      }
      Some(ChatChunk::Done {
        cost_usd: value.get("total_cost_usd").and_then(|v| v.as_f64()),
        input_tokens: value
          .get("usage")
          .and_then(|u| u.get("input_tokens"))
          .and_then(|v| v.as_u64()),
        output_tokens: value
          .get("usage")
          .and_then(|u| u.get("output_tokens"))
          .and_then(|v| v.as_u64()),
      })
    }
    _ => None,
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
  on_chunk: Channel<ChatChunk>,
) -> Result<(), String> {
  let mut command = Command::new("claude");
  command
    .arg("-p")
    .arg("--output-format")
    .arg("stream-json")
    .arg("--verbose"); // claude requires --verbose to stream; otherwise it batches

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
    if let Some(chunk) = parse_stream_line(&line) {
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

  #[test]
  fn parses_system_init_into_session() {
    let line = r#"{"type":"system","subtype":"init","session_id":"abc-123","model":"sonnet"}"#;
    let chunk = parse_stream_line(line).expect("should parse");
    match chunk {
      ChatChunk::Session { id } => assert_eq!(id, "abc-123"),
      _ => panic!("wrong variant"),
    }
  }

  #[test]
  fn ignores_system_subtypes_other_than_init() {
    let line = r#"{"type":"system","subtype":"compact","details":{}}"#;
    assert!(parse_stream_line(line).is_none());
  }

  #[test]
  fn parses_assistant_text_block() {
    let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}]}}"#;
    let chunk = parse_stream_line(line).expect("should parse");
    match chunk {
      ChatChunk::AssistantDelta { text } => assert_eq!(text, "Hello"),
      _ => panic!("wrong variant"),
    }
  }

  #[test]
  fn concatenates_multiple_text_blocks_in_one_assistant_message() {
    let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello "},{"type":"text","text":"world"}]}}"#;
    let chunk = parse_stream_line(line).expect("should parse");
    match chunk {
      ChatChunk::AssistantDelta { text } => assert_eq!(text, "Hello world"),
      _ => panic!("wrong variant"),
    }
  }

  #[test]
  fn skips_assistant_messages_with_no_text_blocks() {
    let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"x","name":"y","input":{}}]}}"#;
    assert!(parse_stream_line(line).is_none());
  }

  #[test]
  fn ignores_user_message_echoes() {
    let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#;
    assert!(parse_stream_line(line).is_none());
  }

  #[test]
  fn parses_result_success_with_usage_and_cost() {
    let line = r#"{"type":"result","subtype":"success","total_cost_usd":0.0123,"usage":{"input_tokens":42,"output_tokens":7}}"#;
    let chunk = parse_stream_line(line).expect("should parse");
    match chunk {
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
    assert!(parse_stream_line(line).is_none());
  }

  #[test]
  fn returns_none_for_malformed_json() {
    assert!(parse_stream_line("not json at all").is_none());
    assert!(parse_stream_line("").is_none());
    assert!(parse_stream_line("{").is_none());
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
