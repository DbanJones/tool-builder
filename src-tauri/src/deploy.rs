// Vercel deploy flow per build-order.md E1 + spec.md Flow I AC1-AC6.
//
// We invoke the user's local `vercel` CLI rather than the Vercel HTTP API
// directly: the CLI handles auth (env var VERCEL_TOKEN), reuses the user's
// existing project linkage if present, and is the documented happy path
// for novices ("vercel deploy" from a folder Just Works).
//
// `vercel_deploy` returns the preview URL. `vercel_is_installed` mirrors
// `cli_is_installed` for the claude CLI (lets the dashboard surface a
// clear "install vercel" call-to-action when missing).

use std::path::PathBuf;
use std::process::Command;

/// Returns true when `vercel` is on PATH and `--version` exits cleanly.
#[tauri::command]
pub fn vercel_is_installed() -> Result<bool, String> {
  let which_or_where = if cfg!(target_os = "windows") {
    "where"
  } else {
    "which"
  };
  let on_path = Command::new(which_or_where)
    .arg("vercel")
    .output()
    .map_err(|e| format!("failed to run {which_or_where}: {e}"))?;
  if !on_path.status.success() {
    return Ok(false);
  }
  let version = Command::new("vercel").arg("--version").output();
  match version {
    Ok(v) => Ok(v.status.success()),
    Err(_) => Ok(false),
  }
}

fn expand_tilde(path: &str) -> PathBuf {
  if let Some(rest) = path.strip_prefix("~/") {
    if let Some(home) = std::env::var_os("HOME") {
      return PathBuf::from(home).join(rest);
    }
  }
  PathBuf::from(path)
}

/// Pure parser for the URL `vercel deploy` prints. The CLI's preview-URL
/// line shape varies by version; we look for the LAST `https://*.vercel.app`
/// substring in either stdout or stderr (vercel uses stderr for progress
/// in v32+ and stdout for the final URL line in older versions).
pub fn parse_preview_url(output: &str) -> Option<String> {
  let mut last: Option<String> = None;
  for token in output.split_whitespace() {
    if token.starts_with("https://") && token.contains(".vercel.app") {
      // Strip trailing punctuation (commas, parens) the CLI sometimes adds.
      let cleaned: String = token
        .trim_end_matches(|c: char| !c.is_ascii_alphanumeric() && c != '/')
        .to_string();
      if !cleaned.is_empty() {
        last = Some(cleaned);
      }
    }
  }
  last
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeployResult {
  pub preview_url: String,
}

/// Spawn `vercel deploy --yes` in the project folder with VERCEL_TOKEN set
/// from the keychain. `vercel_token` is passed by the webview rather than
/// read here so the keychain access lives in the tested `lib/keychain`
/// wrapper rather than duplicated in Rust.
#[tauri::command]
pub async fn vercel_deploy(
  project_path: String,
  vercel_token: String,
) -> Result<DeployResult, String> {
  let cwd = expand_tilde(&project_path);
  if !cwd.exists() {
    return Err(format!(
      "vercel_deploy: project folder not found: {}",
      cwd.display()
    ));
  }
  if vercel_token.trim().is_empty() {
    return Err("vercel_deploy: empty token".to_string());
  }

  // tokio::process::Command (async) would be nicer but for E1 a simple
  // blocking spawn-and-wait is fine — the dashboard already shows a
  // pending state during the call. Switch to streaming output via a
  // Channel<DeployEvent> if the live tail needs incremental progress.
  let output = Command::new("vercel")
    .arg("deploy")
    .arg("--yes")
    .current_dir(&cwd)
    .env("VERCEL_TOKEN", &vercel_token)
    .output()
    .map_err(|e| format!("spawn vercel: {e}"))?;

  let stdout = String::from_utf8_lossy(&output.stdout);
  let stderr = String::from_utf8_lossy(&output.stderr);

  if !output.status.success() {
    let trimmed = stderr.trim();
    let message = if trimmed.is_empty() {
      stdout.trim().to_string()
    } else {
      trimmed.to_string()
    };
    return Err(format!("vercel deploy failed: {message}"));
  }

  let combined = format!("{stdout}\n{stderr}");
  match parse_preview_url(&combined) {
    Some(url) => Ok(DeployResult { preview_url: url }),
    None => Err(format!(
      "vercel deploy succeeded but no preview URL was found in output: {}",
      combined.trim()
    )),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parses_simple_preview_url_from_stdout() {
    let output = "Deploying...\nhttps://my-app-abc123.vercel.app\nDone";
    assert_eq!(
      parse_preview_url(output),
      Some("https://my-app-abc123.vercel.app".to_string())
    );
  }

  #[test]
  fn parses_url_with_trailing_punctuation() {
    let output = "URL: https://my-app.vercel.app, deployed.";
    assert_eq!(
      parse_preview_url(output),
      Some("https://my-app.vercel.app".to_string())
    );
  }

  #[test]
  fn picks_the_last_url_when_multiple_appear() {
    let output =
      "Old: https://old-deploy.vercel.app\nNew: https://new-deploy.vercel.app\nDone";
    assert_eq!(
      parse_preview_url(output),
      Some("https://new-deploy.vercel.app".to_string())
    );
  }

  #[test]
  fn returns_none_when_no_url_present() {
    assert_eq!(parse_preview_url("Deploying...\nFailed: timeout"), None);
    assert_eq!(parse_preview_url(""), None);
  }

  #[test]
  fn ignores_non_vercel_https_links() {
    let output = "Docs: https://example.com — Preview: https://x.vercel.app";
    assert_eq!(
      parse_preview_url(output),
      Some("https://x.vercel.app".to_string())
    );
  }

  #[test]
  fn handles_url_split_across_lines_in_progress_output() {
    let output = "Building...\n\n>  https://my-build.vercel.app  <\n\nDone";
    assert_eq!(
      parse_preview_url(output),
      Some("https://my-build.vercel.app".to_string())
    );
  }

  #[test]
  fn handles_subdomain_with_hyphens_and_digits() {
    let output = "https://preppilot-git-main-org-abc12345.vercel.app";
    assert_eq!(
      parse_preview_url(output),
      Some("https://preppilot-git-main-org-abc12345.vercel.app".to_string())
    );
  }
}
