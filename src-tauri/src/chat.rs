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

use crate::sidecar::project_root_from_cwd;

const INTERVIEW_SYSTEM_PROMPT: &str = "You are the Builder's recursive interviewer. Your job is to populate the project's spec.md by asking the novice the kit's fast-path questions (28 baseline, plus high-stakes follow-ups when activated, plus any extra questions the project genuinely needs — you are NOT capped at 28).

THE PIPELINE (read this carefully — it changes how you should behave):
- The Builder UI shows the novice ONE question at a time, but you generate them in BATCHES of up to 10 per turn. You call the `queue_questions` tool ONCE per turn with the next batch; the UI displays the head of the queue, the novice answers, the UI displays the next, and so on. While the novice is clicking through the queue you are not running — the latency they feel is just the click-to-render time, not a Claude round-trip.
- When the queue empties, the UI sends you all the buffered answers in a single follow-up turn. You must:
  1. Call `record_answer` ONCE per question they answered (one tool call per buffered answer, all in this same turn).
  2. Then call `queue_questions` ONCE with the next batch.
  3. Write a brief one-sentence acknowledgement to the chat so the novice sees the batch landed.
- Do NOT put the question text in your assistant message instead of (or in addition to) `queue_questions`. The UI only renders questions from the queue; text-only questions are invisible to the click-to-pick path.

The first turn is special:
- The novice's first message describes their project. The Builder UI shows a 'Preparing question bank' indicator while you generate your reply.
- In your first reply: briefly (one sentence) reflect what you understood, then state 'Question bank ready: ~28 fast-path questions to work through.', then call `queue_questions` with the FIRST batch of up to 10 questions. Do NOT call record_answer for the freeform first message; the novice's pitch is context, not an answer to a numbered question.

How to write each queued question:
- Plain language. No jargon unless you have just defined it. Each `text` field is what the novice will see verbatim.
- For closed questions (yes/no, single-select), supply EXACTLY 3 candidate `options`. The UI appends a 4th 'Enter my own response' button automatically — do not include a 'something else' option in your 3. Examples: 'Will this app take payments?' (yes / no / not sure); 'Pick a design direction' (clean and minimal / expressive and bold / professional).
- For open-ended questions (the pitch, top 5 flows, freeform descriptions), omit `options` so the novice gets a freeform input only.
- The `id` field is the kit question id (Q1, Q15, etc.) and is what `record_answer` will reference when the novice's answer comes back.

When you receive the buffered answers back:
- The novice's reply will be a numbered list ('1) red 2) yes 3) email...'). Parse it; call `record_answer` for each, with the kit `question_id`, the novice's answer (in their own words or your faithful summary), a confidence ('confident' for direct, 'tentative' for inferred or partial, 'default-applied' when the kit default was used), and a short rationale if confidence is not 'confident'.
- When the novice defers ('you choose'), apply the kit default and record confidence='default-applied'.
- When an answer is vague or covers a high-stakes topic (auth, payments, data model, deploy target), include a sharper follow-up in the NEXT batch's queue_questions call. There is no depth limit on follow-ups; close the branch when the novice answers clearly or says 'you choose'. You may exceed the 28-question fast-path if the project demands it.

Do not invent answers. If an answer is unclear after one follow-up, mark it tentative and move on; the spec preview shows outstanding items.";

/// Generate the MCP config JSON that claude consumes via `--mcp-config`.
/// Per ADR-0004 the MCP server is a separate Node entry point that opens
/// its own better-sqlite3 connection against the SAME DB file the main
/// sidecar uses (so answers + audit rows land in one place and the spec
/// preview's `answers.list` query sees them).
///
/// All sidecar paths (script, migrations, DB) are anchored at the Builder
/// project root, NOT cwd (which is src-tauri/ in dev) and NOT the novice's
/// project root (which only owns the per-turn mcp-config.json file).
fn build_mcp_config(project_id: &str, novice_project_root: &PathBuf) -> Result<PathBuf, String> {
  let builder_root = project_root_from_cwd()?;
  let mcp_server_script = builder_root.join("sidecar").join("dist").join("mcp-server.js");
  let migrations_folder = builder_root.join("sidecar").join("migrations");
  let db_path = builder_root.join(".builder").join("builder.db");

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

  // The mcp-config.json itself lives under the novice's project .builder/
  // — it's per-turn ephemeral state for that project, not a Builder asset.
  let config_dir = novice_project_root.join(".builder");
  fs::create_dir_all(&config_dir).map_err(|e| format!("create .builder/: {e}"))?;
  let config_path = config_dir.join("mcp-config.json");
  fs::write(
    &config_path,
    serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?,
  )
  .map_err(|e| format!("write mcp config: {e}"))?;
  Ok(config_path)
}

/// One queued question in a `queue_questions` MCP call. The UI shows them
/// one at a time from the head of the local queue.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct QueuedQuestion {
  pub id: String,
  pub text: String,
  /// 3 click-to-pick options, or empty for an open-ended question.
  pub options: Vec<String>,
  pub allow_freeform: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChatChunk {
  /// Emitted once per turn, immediately after claude's `system.init` event.
  Session { id: String },
  /// A piece of assistant text. Multiple of these arrive per turn; concatenate
  /// in order to render the full message as it streams.
  AssistantDelta { text: String },
  /// Emitted when claude calls the `queue_questions` MCP tool. The UI
  /// accumulates the items into a local queue and shows them one at a time;
  /// answers are buffered locally and sent back to claude as a single
  /// follow-up turn when the queue empties (so 1 round trip per N answers).
  QuestionsQueued { items: Vec<QueuedQuestion> },
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
            //
            // claude prefixes MCP tool names: a tool named `queue_questions`
            // exposed by an MCP server registered as `builder-record-answer`
            // arrives in stream-json as `mcp__builder-record-answer__queue_questions`.
            // Match either the bare name or the prefixed form.
            let tool_name = block.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let is_queue_questions = tool_name == "queue_questions"
              || tool_name.ends_with("__queue_questions");
            if is_queue_questions {
              if let Some(input) = block.get("input") {
                let items: Vec<QueuedQuestion> = input
                  .get("items")
                  .and_then(|v| v.as_array())
                  .map(|arr| {
                    arr
                      .iter()
                      .filter_map(|item| {
                        let obj = item.as_object()?;
                        let id = obj.get("id")?.as_str()?.to_string();
                        let text = obj.get("text")?.as_str()?.to_string();
                        let options = obj
                          .get("options")
                          .and_then(|v| v.as_array())
                          .map(|arr| {
                            arr
                              .iter()
                              .filter_map(|o| o.as_str().map(|s| s.to_string()))
                              .collect()
                          })
                          .unwrap_or_default();
                        let allow_freeform = obj
                          .get("allow_freeform")
                          .and_then(|v| v.as_bool())
                          .unwrap_or(true);
                        Some(QueuedQuestion { id, text, options, allow_freeform })
                      })
                      .collect()
                  })
                  .unwrap_or_default();
                if !items.is_empty() {
                  chunks.push(ChatChunk::QuestionsQueued { items });
                }
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
  //
  // In `-p` mode claude requires explicit `--allowed-tools` for any MCP tool
  // it should be able to call without prompting. Tool names take the form
  // `mcp__<server-key>__<tool-name>`; our server is `builder-record-answer`.
  if let (Some(pid), Some(ppath)) = (&project_id, &project_path) {
    let project_root = PathBuf::from(ppath);
    match build_mcp_config(pid, &project_root) {
      Ok(config_path) => {
        command.arg("--mcp-config").arg(&config_path);
        command
          .arg("--allowed-tools")
          .arg("mcp__builder-record-answer__record_answer,mcp__builder-record-answer__queue_questions");
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
  fn parses_queue_questions_tool_use_into_questions_queued_chunk() {
    let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"x","name":"queue_questions","input":{"items":[{"id":"Q1","text":"Will this app take payments?","options":["yes","no","not sure"],"allow_freeform":true}]}}]}}"#;
    match first(line) {
      ChatChunk::QuestionsQueued { items } => {
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "Q1");
        assert_eq!(items[0].text, "Will this app take payments?");
        assert_eq!(items[0].options, vec!["yes", "no", "not sure"]);
        assert!(items[0].allow_freeform);
      }
      _ => panic!("wrong variant"),
    }
  }

  #[test]
  fn parses_mcp_prefixed_queue_questions_tool_use() {
    // claude prefixes MCP tools as `mcp__<server-key>__<tool-name>`. The
    // parser must recognise both the bare and prefixed forms.
    let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"x","name":"mcp__builder-record-answer__queue_questions","input":{"items":[{"id":"Q1","text":"q","options":["a","b","c"]}]}}]}}"#;
    match first(line) {
      ChatChunk::QuestionsQueued { items } => {
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].options, vec!["a", "b", "c"]);
      }
      _ => panic!("wrong variant"),
    }
  }

  #[test]
  fn parses_multi_item_queue_questions_into_ordered_items() {
    let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"x","name":"queue_questions","input":{"items":[{"id":"Q1","text":"first"},{"id":"Q2","text":"second","options":["a","b","c"]},{"id":"Q3","text":"third"}]}}]}}"#;
    match first(line) {
      ChatChunk::QuestionsQueued { items } => {
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].id, "Q1");
        assert!(items[0].options.is_empty()); // open-ended
        assert_eq!(items[1].id, "Q2");
        assert_eq!(items[1].options.len(), 3);
        assert_eq!(items[2].id, "Q3");
      }
      _ => panic!("wrong variant"),
    }
  }

  #[test]
  fn ignores_other_mcp_prefixed_tool_calls() {
    // record_answer (and any future MCP tool we expose) must NOT emit a
    // chunk; UI-facing chunks come only from queue_questions.
    let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"x","name":"mcp__builder-record-answer__record_answer","input":{"question_id":"Q1","answer":"hi"}}]}}"#;
    assert!(parse_stream_line(line).is_empty());
  }

  #[test]
  fn assistant_with_text_and_queue_questions_returns_text_first_then_queue() {
    let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Topic 5 of 28."},{"type":"tool_use","id":"x","name":"queue_questions","input":{"items":[{"id":"Q5","text":"Pick a design","options":["clean","bold","pro"]}]}}]}}"#;
    let chunks = parse_stream_line(line);
    assert_eq!(chunks.len(), 2);
    match &chunks[0] {
      ChatChunk::AssistantDelta { text } => assert_eq!(text, "Topic 5 of 28."),
      _ => panic!("wrong first variant"),
    }
    match &chunks[1] {
      ChatChunk::QuestionsQueued { items } => {
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].options, vec!["clean", "bold", "pro"]);
      }
      _ => panic!("wrong second variant"),
    }
  }

  #[test]
  fn queue_questions_defaults_allow_freeform_true_when_missing() {
    let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"x","name":"queue_questions","input":{"items":[{"id":"Q1","text":"q"}]}}]}}"#;
    match first(line) {
      ChatChunk::QuestionsQueued { items } => assert!(items[0].allow_freeform),
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
