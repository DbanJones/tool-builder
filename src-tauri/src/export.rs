// GitHub export per build-order.md E2 + spec.md Flow I AC8.
//
// Wraps the `gh` CLI rather than the GitHub HTTP API: gh handles its own
// auth (`gh auth login`), respects the user's existing config, and is the
// documented happy path. We never see or store a GitHub token.

use std::path::PathBuf;
use std::process::Command;

#[tauri::command]
pub fn gh_is_installed() -> Result<bool, String> {
  let which_or_where = if cfg!(target_os = "windows") {
    "where"
  } else {
    "which"
  };
  let on_path = Command::new(which_or_where)
    .arg("gh")
    .output()
    .map_err(|e| format!("failed to run {which_or_where}: {e}"))?;
  if !on_path.status.success() {
    return Ok(false);
  }
  let version = Command::new("gh").arg("--version").output();
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

/// Pure parser for the URL `gh repo create` prints. The CLI prints the
/// new repo URL on its own line in stdout (or stderr in some versions);
/// we look for the first https://github.com/<owner>/<name> token.
pub fn parse_repo_url(output: &str) -> Option<String> {
  for token in output.split_whitespace() {
    if token.starts_with("https://github.com/") {
      let cleaned: String = token
        .trim_end_matches(|c: char| !c.is_ascii_alphanumeric() && c != '/' && c != '-' && c != '_')
        .to_string();
      // Reject the bare `https://github.com/` if it has no owner/name.
      let after_host = cleaned.strip_prefix("https://github.com/").unwrap_or("");
      if after_host.contains('/') && !cleaned.is_empty() {
        return Some(cleaned);
      }
    }
  }
  None
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
  pub repo_url: String,
}

/// `gh repo create <name> --private --source=. --remote=origin --push`
/// from the project folder. Requires the user to have run `gh auth login`
/// first; we surface a clear error pointing at that command if not.
#[tauri::command]
pub async fn gh_export(
  project_path: String,
  repo_name: String,
) -> Result<ExportResult, String> {
  let cwd = expand_tilde(&project_path);
  if !cwd.exists() {
    return Err(format!(
      "gh_export: project folder not found: {}",
      cwd.display()
    ));
  }
  let trimmed = repo_name.trim();
  if trimmed.is_empty() {
    return Err("gh_export: repo name is required".to_string());
  }
  // Repo names: GitHub requires [A-Za-z0-9_.-], 1–100 chars.
  if !trimmed
    .chars()
    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
    || trimmed.len() > 100
  {
    return Err(format!(
      "gh_export: invalid repo name '{trimmed}' (allowed chars: A-Z, a-z, 0-9, '.', '_', '-'; max 100)"
    ));
  }

  let output = Command::new("gh")
    .arg("repo")
    .arg("create")
    .arg(trimmed)
    .arg("--private")
    .arg("--source=.")
    .arg("--remote=origin")
    .arg("--push")
    .current_dir(&cwd)
    .output()
    .map_err(|e| format!("spawn gh: {e}"))?;

  let stdout = String::from_utf8_lossy(&output.stdout);
  let stderr = String::from_utf8_lossy(&output.stderr);

  if !output.status.success() {
    let trimmed_err = stderr.trim();
    let message = if trimmed_err.is_empty() {
      stdout.trim().to_string()
    } else {
      trimmed_err.to_string()
    };
    let hint = if message.to_lowercase().contains("not logged in")
      || message.to_lowercase().contains("authentication")
    {
      "\n\nRun `gh auth login` in a terminal to authenticate first."
    } else {
      ""
    };
    return Err(format!("gh repo create failed: {message}{hint}"));
  }

  let combined = format!("{stdout}\n{stderr}");
  match parse_repo_url(&combined) {
    Some(url) => Ok(ExportResult { repo_url: url }),
    None => Err(format!(
      "gh repo create succeeded but no repo URL was found in output: {}",
      combined.trim()
    )),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parses_simple_repo_url() {
    let output = "Created repository org-name/preppilot on GitHub.\nhttps://github.com/org-name/preppilot\n";
    assert_eq!(
      parse_repo_url(output),
      Some("https://github.com/org-name/preppilot".to_string())
    );
  }

  #[test]
  fn rejects_bare_github_host_with_no_path() {
    let output = "Visit https://github.com/ to sign in";
    assert_eq!(parse_repo_url(output), None);
  }

  #[test]
  fn returns_first_real_repo_url_when_others_appear_later() {
    let output = "Created https://github.com/me/first\nClone https://github.com/me/second";
    assert_eq!(parse_repo_url(output), Some("https://github.com/me/first".to_string()));
  }

  #[test]
  fn handles_url_with_trailing_punctuation() {
    let output = "Done: https://github.com/me/preppilot.";
    assert_eq!(
      parse_repo_url(output),
      Some("https://github.com/me/preppilot".to_string())
    );
  }

  #[test]
  fn returns_none_when_no_url_present() {
    assert_eq!(parse_repo_url("Repo created."), None);
    assert_eq!(parse_repo_url(""), None);
  }

  #[test]
  fn handles_repo_with_hyphens_underscores_and_digits() {
    let output = "https://github.com/my_org/my-app_v2";
    assert_eq!(
      parse_repo_url(output),
      Some("https://github.com/my_org/my-app_v2".to_string())
    );
  }
}
