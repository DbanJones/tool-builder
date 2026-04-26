// Build-phase orchestrator. Spawns the `claude` CLI as a long-running build
// subprocess INSIDE the novice's project folder (cwd = project_path), parses
// its `--output-format stream-json` output, and pushes typed
// `OrchestratorEvent` items to the webview via a Tauri 2 `Channel<T>`.
//
// Per ADR-0002 the Builder does not use the Anthropic SDK; everything goes
// through the `claude` CLI. Per CLAUDE.md binding rule 5 the novice's project
// folder is treated as untrusted from the Builder's perspective: we spawn
// claude into it (which is precisely the design — claude operates ON that
// folder) but the Builder itself reads back only the structured stream-json
// events, never arbitrary files.
//
// At D1 this command runs ONE kickoff turn: it asks claude to read CLAUDE.md
// and emit a `## Plan` section for the first work increment. D5/D6 add
// pause/resume/crash-recovery; D2 adds the human-translation table.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::Manager;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

const ORCHESTRATOR_KICKOFF_PROMPT: &str = "You are the Builder's build-phase agent. The novice has finished the interview and clicked 'Start build'. Your job is to drive the build of their target app from this project folder.

For this first turn:
1. Read CLAUDE.md at the root of this project to learn the binding rules and project context. Read spec.md for the build target. Read .builder/state.json if present to learn which phase you are in.
2. Output a Markdown section that begins with the literal heading '## Plan' on its own line. Under it, list the next 3 to 7 concrete steps you intend to take in this build phase, smallest first, each one estimated at no more than one hour of work.
3. Do not modify any files in this turn. Do not run shell commands beyond reading files. Wait for the novice to confirm the plan in the next turn before doing any work.

Be terse. The novice is non-technical. Use plain language. Reference file paths when relevant.";

/// One observable event from the build subprocess. Mirrors ChatChunk in
/// shape but covers the full tool-call surface (every tool, not just our
/// UI tool), since the dashboard's live tail and `actions` table need it all.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OrchestratorEvent {
  /// claude's `system.init`. Emitted once per `orchestrator_start` call.
  /// `id` is the session id usable later with `--resume <id>`.
  Session { id: String },
  /// A piece of assistant text. Concatenate in arrival order.
  AssistantDelta { text: String },
  /// claude is calling a tool. `tool` is the bare name as it arrives (Bash,
  /// Edit, Read, Glob, Grep, Write, etc., or `mcp__<server>__<name>` for MCP
  /// tools). `raw_input` is the JSON-encoded input as a string so the UI can
  /// route it through the D2 translator without double-decoding.
  ToolUse { tool: String, raw_input: String },
  /// claude's `result.success`. Emitted once at the end of a successful turn.
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
/// return the corresponding events. Returns an empty vec for uninteresting
/// event types (user-message echoes, system events other than init).
///
/// Differs from chat.rs::parse_stream_line in two ways:
///   - emits ToolUse for EVERY tool_use block (chat.rs only forwards
///     `offer_options`); the dashboard needs the full surface.
///   - does not handle our chat-only MCP tool semantics.
pub fn parse_orchestrator_line(line: &str) -> Vec<OrchestratorEvent> {
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
      vec![OrchestratorEvent::Session { id: id.to_string() }]
    }
    "assistant" => {
      let Some(content) = value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
      else {
        return vec![];
      };
      let mut events: Vec<OrchestratorEvent> = vec![];
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
            let tool = block
              .get("name")
              .and_then(|v| v.as_str())
              .unwrap_or("")
              .to_string();
            if tool.is_empty() {
              continue;
            }
            let raw_input = block
              .get("input")
              .map(|v| v.to_string())
              .unwrap_or_else(|| "{}".to_string());
            events.push(OrchestratorEvent::ToolUse { tool, raw_input });
          }
          _ => {}
        }
      }
      if !text.is_empty() {
        events.insert(0, OrchestratorEvent::AssistantDelta { text });
      }
      events
    }
    "result" => {
      if value.get("subtype").and_then(|v| v.as_str()) != Some("success") {
        return vec![];
      }
      vec![OrchestratorEvent::Done {
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

fn detect_rate_limit(stderr: &str) -> bool {
  let lower = stderr.to_lowercase();
  lower.contains("rate limit")
    || lower.contains("rate_limit")
    || lower.contains("rate-limit")
    || lower.contains("too many requests")
}

fn expand_tilde(path: &str) -> PathBuf {
  if let Some(rest) = path.strip_prefix("~/") {
    if let Some(home) = std::env::var_os("HOME") {
      return PathBuf::from(home).join(rest);
    }
  }
  PathBuf::from(path)
}

/// Per-app state holding the in-flight orchestrator child process so
/// `orchestrator_stop` can kill it. Only one build subprocess runs at a
/// time (single-novice desktop app); the Mutex<Option<Child>> shape is
/// the simplest way to express "0 or 1 alive".
pub struct OrchestratorState {
  child: Mutex<Option<Child>>,
}

impl OrchestratorState {
  pub fn new() -> Self {
    Self { child: Mutex::new(None) }
  }
}

/// Spawn the build subprocess in `project_path`, stream events, return when
/// the subprocess exits. The caller (webview) supplies a Channel; events
/// arrive in the order they were observed.
///
/// `session_id` is None on the first turn (a fresh build kickoff) and Some
/// on subsequent turns to continue the same context (used by Flow H resume).
#[tauri::command]
pub async fn orchestrator_start(
  app: tauri::AppHandle,
  project_path: String,
  prompt: Option<String>,
  session_id: Option<String>,
  on_event: Channel<OrchestratorEvent>,
) -> Result<(), String> {
  let cwd = expand_tilde(&project_path);
  if !cwd.exists() {
    return Err(format!(
      "orchestrator_start: project folder not found: {}",
      cwd.display()
    ));
  }

  let mut command = Command::new("claude");
  command
    .current_dir(&cwd)
    .arg("-p")
    .arg("--output-format")
    .arg("stream-json")
    .arg("--verbose"); // claude requires --verbose to stream

  // Per ADR-0002 the orchestrator's build subprocess uses Sonnet by default
  // (long, multi-step work; cost matters more than first-impression quality).
  // Subsequent turns reuse the same model via --resume.
  command.arg("--model").arg("sonnet");

  // Auto-accept file edits + tool calls within the project folder. Without
  // this the spawned claude prompts the user (via its own permission UI)
  // for every Edit/Write/Bash call, which is unworkable for an autonomous
  // build. cwd is already path-sandboxed to the novice's project folder
  // (the only place the build subprocess should be writing); the claude
  // CLI's own per-tool guards still apply for things outside cwd.
  command.arg("--permission-mode").arg("acceptEdits");

  if let Some(sid) = &session_id {
    command.arg("--resume").arg(sid);
  }

  let kickoff = prompt.unwrap_or_else(|| ORCHESTRATOR_KICKOFF_PROMPT.to_string());
  command
    .arg(&kickoff)
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

  // Hand the child over to the OrchestratorState so orchestrator_stop can
  // kill it. We can't keep `child` here AND in the state at the same time,
  // so we move it in and pull it back at the end via .take().
  if let Some(state) = app.try_state::<OrchestratorState>() {
    if let Ok(mut guard) = state.child.lock() {
      *guard = Some(child);
    }
  }

  let mut reader = BufReader::new(stdout).lines();
  while let Some(line) = reader
    .next_line()
    .await
    .map_err(|e| format!("read stdout: {e}"))?
  {
    for event in parse_orchestrator_line(&line) {
      on_event
        .send(event)
        .map_err(|e| format!("channel send: {e}"))?;
    }
  }

  // Take the child back out of state to read stderr + wait. If
  // orchestrator_stop already pulled it out, the process is gone — surface
  // a clean done with no rate-limit/error.
  let mut child = match app
    .try_state::<OrchestratorState>()
    .and_then(|s| s.child.lock().ok().map(|mut g| g.take()))
    .flatten()
  {
    Some(c) => c,
    None => return Ok(()),
  };

  let mut stderr_text = String::new();
  let _ = tokio::io::AsyncReadExt::read_to_string(&mut stderr, &mut stderr_text).await;
  let status = child.wait().await.map_err(|e| format!("wait: {e}"))?;

  if !status.success() {
    if detect_rate_limit(&stderr_text) {
      let _ = on_event.send(OrchestratorEvent::RateLimit {
        message: "Claude is rate-limited. Try again in a few minutes.".to_string(),
      });
    } else {
      let message = if stderr_text.trim().is_empty() {
        format!("claude exited with status {status}")
      } else {
        stderr_text.trim().to_string()
      };
      let _ = on_event.send(OrchestratorEvent::Error { message });
    }
  }

  Ok(())
}

/// Kill the in-flight build subprocess. Used by Flow H Stop and as the
/// "force-kill" half of Pause when the novice doesn't want to wait for the
/// current turn to finish naturally. No-op when no child is running.
#[tauri::command]
pub async fn orchestrator_stop(state: tauri::State<'_, OrchestratorState>) -> Result<(), String> {
  let child_opt = state.child.lock().map_err(|e| format!("lock: {e}"))?.take();
  if let Some(mut child) = child_opt {
    // start_kill is non-blocking; the read loop in orchestrator_start will
    // see EOF on stdout and tear down the rest of the pipeline naturally.
    child.start_kill().map_err(|e| format!("start_kill: {e}"))?;
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn first(line: &str) -> OrchestratorEvent {
    parse_orchestrator_line(line)
      .into_iter()
      .next()
      .expect("expected at least one event")
  }

  #[test]
  fn parses_system_init_into_session() {
    let line = r#"{"type":"system","subtype":"init","session_id":"build-xyz","model":"sonnet"}"#;
    match first(line) {
      OrchestratorEvent::Session { id } => assert_eq!(id, "build-xyz"),
      _ => panic!("wrong variant"),
    }
  }

  #[test]
  fn parses_assistant_text_block_with_plan_heading() {
    // JSON's `\n` (literal backslash-n) decodes to a newline in the text.
    // Use a regular string with double-escaped backslashes to keep the
    // raw-string syntax simple.
    let line = "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"## Plan\\n1. Read spec.md\\n2. Scaffold app/\"}]}}";
    match first(line) {
      OrchestratorEvent::AssistantDelta { text } => {
        assert!(text.contains("## Plan"));
        assert!(text.contains("Read spec.md"));
      }
      _ => panic!("wrong variant"),
    }
  }

  #[test]
  fn parses_bash_tool_use_with_raw_input_preserved() {
    let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"x","name":"Bash","input":{"command":"pnpm verify","description":"merge gate"}}]}}"#;
    match first(line) {
      OrchestratorEvent::ToolUse { tool, raw_input } => {
        assert_eq!(tool, "Bash");
        assert!(raw_input.contains("pnpm verify"));
        assert!(raw_input.contains("merge gate"));
      }
      _ => panic!("wrong variant"),
    }
  }

  #[test]
  fn parses_edit_tool_use() {
    let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"x","name":"Edit","input":{"file_path":"app/page.tsx","old_string":"x","new_string":"y"}}]}}"#;
    match first(line) {
      OrchestratorEvent::ToolUse { tool, raw_input } => {
        assert_eq!(tool, "Edit");
        assert!(raw_input.contains("app/page.tsx"));
      }
      _ => panic!("wrong variant"),
    }
  }

  #[test]
  fn assistant_with_text_and_tool_use_returns_text_first_then_tool() {
    let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Reading the spec."},{"type":"tool_use","id":"x","name":"Read","input":{"file_path":"spec.md"}}]}}"#;
    let events = parse_orchestrator_line(line);
    assert_eq!(events.len(), 2);
    match &events[0] {
      OrchestratorEvent::AssistantDelta { text } => assert_eq!(text, "Reading the spec."),
      _ => panic!("first should be text"),
    }
    match &events[1] {
      OrchestratorEvent::ToolUse { tool, .. } => assert_eq!(tool, "Read"),
      _ => panic!("second should be tool_use"),
    }
  }

  #[test]
  fn assistant_with_multiple_tool_uses_returns_all_in_order() {
    let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"a","name":"Read","input":{"file_path":"a.md"}},{"type":"tool_use","id":"b","name":"Read","input":{"file_path":"b.md"}}]}}"#;
    let events = parse_orchestrator_line(line);
    assert_eq!(events.len(), 2);
    match (&events[0], &events[1]) {
      (
        OrchestratorEvent::ToolUse { raw_input: a, .. },
        OrchestratorEvent::ToolUse { raw_input: b, .. },
      ) => {
        assert!(a.contains("a.md"));
        assert!(b.contains("b.md"));
      }
      _ => panic!("expected two ToolUse events"),
    }
  }

  #[test]
  fn tool_use_without_input_uses_empty_object_string() {
    let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"x","name":"Glob"}]}}"#;
    match first(line) {
      OrchestratorEvent::ToolUse { tool, raw_input } => {
        assert_eq!(tool, "Glob");
        assert_eq!(raw_input, "{}");
      }
      _ => panic!("wrong variant"),
    }
  }

  #[test]
  fn tool_use_without_name_is_skipped() {
    let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"x","input":{}}]}}"#;
    assert!(parse_orchestrator_line(line).is_empty());
  }

  #[test]
  fn parses_result_success_with_usage_and_cost() {
    let line = r#"{"type":"result","subtype":"success","total_cost_usd":0.12,"usage":{"input_tokens":1000,"output_tokens":500}}"#;
    match first(line) {
      OrchestratorEvent::Done {
        cost_usd,
        input_tokens,
        output_tokens,
      } => {
        assert!((cost_usd.unwrap() - 0.12).abs() < 1e-9);
        assert_eq!(input_tokens, Some(1000));
        assert_eq!(output_tokens, Some(500));
      }
      _ => panic!("wrong variant"),
    }
  }

  #[test]
  fn ignores_user_message_echoes() {
    let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"go"}]}}"#;
    assert!(parse_orchestrator_line(line).is_empty());
  }

  #[test]
  fn ignores_system_subtypes_other_than_init() {
    let line = r#"{"type":"system","subtype":"compact","details":{}}"#;
    assert!(parse_orchestrator_line(line).is_empty());
  }

  #[test]
  fn ignores_result_error_subtypes() {
    let line = r#"{"type":"result","subtype":"error_during_execution","error":"boom"}"#;
    assert!(parse_orchestrator_line(line).is_empty());
  }

  #[test]
  fn returns_empty_for_malformed_json() {
    assert!(parse_orchestrator_line("not json at all").is_empty());
    assert!(parse_orchestrator_line("").is_empty());
  }

  #[test]
  fn detects_common_rate_limit_phrasings() {
    assert!(detect_rate_limit("Error: Rate limit exceeded"));
    assert!(detect_rate_limit("HTTP 429: rate_limit_error"));
    assert!(detect_rate_limit("Too Many Requests"));
  }

  #[test]
  fn does_not_flag_unrelated_errors_as_rate_limit() {
    assert!(!detect_rate_limit("Authentication failed"));
    assert!(!detect_rate_limit(""));
  }
}
