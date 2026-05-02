// Preview proxy (ADR-0014). Sits in front of the target app's dev server and
// injects `<script src="/__builder-bridge.js">` into HTML responses so the
// Builder webview can talk to the iframe over postMessage. Framework-agnostic
// because it operates at the HTTP layer; no Next/Vite plugin required.
//
// Why a hand-rolled proxy and not hyper: see ADR-0014 §"Trade-offs". The
// proxy's contract is small (forward bytes, find `</body>` once, tunnel
// websockets) and pulling in hyper roughly tripled cold-build time without
// changing observable behaviour.

use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, Mutex as AsyncMutex};
use tokio::task::JoinHandle;

const BRIDGE_PATH: &str = "/__builder-bridge.js";
const BRIDGE_JS: &str = include_str!("../assets/builder-bridge.js");

const MAX_HEADER_BYTES: usize = 32 * 1024;
const MAX_HTML_BUFFER_BYTES: usize = 8 * 1024 * 1024; // 8 MB cap on injected pages
const STREAM_CHUNK: usize = 16 * 1024;

pub struct PreviewProxyHandle {
  /// Bound port the iframe should connect to.
  pub port: u16,
  shutdown: Option<oneshot::Sender<()>>,
  task: Option<JoinHandle<()>>,
}

impl PreviewProxyHandle {
  pub async fn shutdown(mut self) {
    if let Some(tx) = self.shutdown.take() {
      let _ = tx.send(());
    }
    if let Some(handle) = self.task.take() {
      let _ = handle.await;
    }
  }
}

pub struct PreviewProxyState {
  inner: AsyncMutex<Option<PreviewProxyHandle>>,
}

impl PreviewProxyState {
  pub fn new() -> Self {
    Self {
      inner: AsyncMutex::new(None),
    }
  }

  pub async fn install(&self, handle: PreviewProxyHandle) {
    let mut guard = self.inner.lock().await;
    if let Some(prev) = guard.take() {
      prev.shutdown().await;
    }
    *guard = Some(handle);
  }

  pub async fn shutdown(&self) {
    let mut guard = self.inner.lock().await;
    if let Some(prev) = guard.take() {
      prev.shutdown().await;
    }
  }
}

/// Bind on 127.0.0.1:0 and start forwarding to upstream_port. Returns the
/// proxy port. Spawns a tokio task; shutdown via the returned handle.
pub async fn start(upstream_port: u16) -> Result<PreviewProxyHandle, String> {
  let listener = TcpListener::bind("127.0.0.1:0")
    .await
    .map_err(|e| format!("preview_proxy: bind: {e}"))?;
  let port = listener
    .local_addr()
    .map_err(|e| format!("preview_proxy: local_addr: {e}"))?
    .port();
  let (tx, mut rx) = oneshot::channel::<()>();
  let upstream = Arc::new(format!("127.0.0.1:{upstream_port}"));

  let task = tokio::spawn(async move {
    log::info!("preview_proxy listening on 127.0.0.1:{port} -> {}", upstream);
    loop {
      tokio::select! {
        _ = &mut rx => {
          log::info!("preview_proxy shutdown requested");
          break;
        }
        accepted = listener.accept() => {
          match accepted {
            Ok((client, _peer)) => {
              let upstream_addr = upstream.clone();
              tokio::spawn(async move {
                if let Err(e) = handle_connection(client, &upstream_addr).await {
                  log::warn!("preview_proxy connection error: {e}");
                }
              });
            }
            Err(e) => {
              log::warn!("preview_proxy accept error: {e}");
            }
          }
        }
      }
    }
  });

  Ok(PreviewProxyHandle {
    port,
    shutdown: Some(tx),
    task: Some(task),
  })
}

async fn handle_connection(mut client: TcpStream, upstream_addr: &str) -> Result<(), String> {
  let (head, leftover) = read_request_head(&mut client).await?;
  let request_line = head.lines().next().unwrap_or_default().to_string();

  // Serve the bridge JS ourselves. The path is unique enough that it won't
  // collide with the target app, but if it does, ours wins.
  if request_starts_with_path(&request_line, BRIDGE_PATH) {
    return serve_bridge_js(&mut client).await;
  }

  let mut upstream = TcpStream::connect(upstream_addr)
    .await
    .map_err(|e| format!("connect upstream: {e}"))?;

  // Rewrite headers so upstream returns identity-encoded bodies (so we can
  // inject) and so neither side keeps the connection alive (we close after
  // one exchange unless we upgrade to a websocket). Also rewrites Host +
  // strips Origin/Referer so Next 15.5+ does not reject the proxied request
  // as cross-origin.
  let rewritten = rewrite_request_headers(&head, upstream_addr);
  let is_ws = is_websocket_upgrade(&head);
  upstream
    .write_all(rewritten.as_bytes())
    .await
    .map_err(|e| format!("write upstream head: {e}"))?;
  if !leftover.is_empty() {
    upstream
      .write_all(&leftover)
      .await
      .map_err(|e| format!("write upstream leftover: {e}"))?;
  }
  upstream.flush().await.ok();

  if is_ws {
    return tunnel_bidirectional(client, upstream).await;
  }

  forward_response(&mut upstream, &mut client).await
}

async fn read_request_head(stream: &mut TcpStream) -> Result<(String, Vec<u8>), String> {
  let mut buf = Vec::with_capacity(2048);
  let mut tmp = [0u8; STREAM_CHUNK];
  loop {
    if buf.len() > MAX_HEADER_BYTES {
      return Err("request header too large".into());
    }
    let n = stream
      .read(&mut tmp)
      .await
      .map_err(|e| format!("read client head: {e}"))?;
    if n == 0 {
      return Err("client closed before headers complete".into());
    }
    buf.extend_from_slice(&tmp[..n]);
    if let Some(end) = find_double_crlf(&buf) {
      let head = String::from_utf8_lossy(&buf[..end]).to_string();
      let leftover = buf[end..].to_vec();
      return Ok((head, leftover));
    }
  }
}

fn find_double_crlf(buf: &[u8]) -> Option<usize> {
  buf.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4)
}

fn request_starts_with_path(request_line: &str, path: &str) -> bool {
  // Format: "METHOD /url HTTP/1.1"
  let mut parts = request_line.split_whitespace();
  parts.next(); // method
  match parts.next() {
    Some(target) => target == path || target.starts_with(&format!("{path}?")),
    None => false,
  }
}

fn is_websocket_upgrade(head: &str) -> bool {
  let mut has_upgrade_ws = false;
  let mut has_connection_upgrade = false;
  for line in head.lines().skip(1) {
    let lower = line.to_ascii_lowercase();
    if let Some((k, v)) = lower.split_once(':') {
      let k = k.trim();
      let v = v.trim();
      if k == "upgrade" && v.contains("websocket") {
        has_upgrade_ws = true;
      } else if k == "connection" && v.contains("upgrade") {
        has_connection_upgrade = true;
      }
    }
  }
  has_upgrade_ws && has_connection_upgrade
}

fn rewrite_request_headers(head: &str, upstream_addr: &str) -> String {
  let mut out = String::with_capacity(head.len() + 64);
  let mut saw_accept_encoding = false;
  let mut saw_host = false;
  for (idx, line) in head.lines().enumerate() {
    if idx == 0 {
      out.push_str(line);
      out.push_str("\r\n");
      continue;
    }
    // Skip the trailing blank line from `\r\n\r\n` — `read_request_head`
    // returns the buffer up to and including the double-crlf, so
    // `head.lines()` ends with one empty entry. Letting that through
    // here would inject an end-of-headers signal mid-block, which
    // upstream (Next.js 15.5+) rejects with 400 because the trailing
    // Connection: close looks like a malformed second request.
    if line.is_empty() {
      continue;
    }
    let lower = line.to_ascii_lowercase();
    let key = lower.split(':').next().unwrap_or("").trim();
    // Drop hop-by-hop headers; we set Connection: close ourselves below.
    // Keep Upgrade/Connection if it's a websocket — handled by the WS path.
    if matches!(
      key,
      "connection" | "proxy-connection" | "keep-alive" | "transfer-encoding"
    ) {
      continue;
    }
    if key == "accept-encoding" {
      out.push_str("Accept-Encoding: identity\r\n");
      saw_accept_encoding = true;
      continue;
    }
    // Rewrite Host to match upstream so Next 15.5+ does not 400 the
    // request as cross-origin (its dev server compares the Host header
    // against the address it bound to).
    if key == "host" {
      out.push_str(&format!("Host: {upstream_addr}\r\n"));
      saw_host = true;
      continue;
    }
    // Drop Origin / Referer / Sec-Fetch-* — these advertise the iframe's
    // parent context (e.g. Origin: tauri://localhost) which Next 15.5+
    // treats as a cross-site request and rejects with 400 unless
    // allowedDevOrigins is configured. The proxy is a same-host relay
    // from upstream's perspective; it should look that way.
    if matches!(
      key,
      "origin" | "referer" | "sec-fetch-site" | "sec-fetch-mode" | "sec-fetch-dest"
    ) {
      continue;
    }
    out.push_str(line);
    out.push_str("\r\n");
  }
  if !saw_accept_encoding {
    out.push_str("Accept-Encoding: identity\r\n");
  }
  if !saw_host {
    out.push_str(&format!("Host: {upstream_addr}\r\n"));
  }
  out.push_str("Connection: close\r\n");
  out.push_str("\r\n");
  out
}

async fn serve_bridge_js(client: &mut TcpStream) -> Result<(), String> {
  let body = BRIDGE_JS.as_bytes();
  let head = format!(
    "HTTP/1.1 200 OK\r\nContent-Type: application/javascript; charset=utf-8\r\n\
     Content-Length: {len}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
    len = body.len(),
  );
  client
    .write_all(head.as_bytes())
    .await
    .map_err(|e| format!("write bridge head: {e}"))?;
  client
    .write_all(body)
    .await
    .map_err(|e| format!("write bridge body: {e}"))?;
  client.shutdown().await.ok();
  Ok(())
}

async fn forward_response(upstream: &mut TcpStream, client: &mut TcpStream) -> Result<(), String> {
  let (head, leftover) = read_response_head(upstream).await?;
  let content_type = header_value(&head, "content-type").unwrap_or_default();
  let is_html = content_type.to_ascii_lowercase().contains("text/html");

  if !is_html {
    // Stream-forward unchanged. We already stripped Accept-Encoding so this
    // is identity-encoded but may still be chunked — that's fine, we don't
    // touch it.
    client
      .write_all(head.as_bytes())
      .await
      .map_err(|e| format!("write client head: {e}"))?;
    if !leftover.is_empty() {
      client
        .write_all(&leftover)
        .await
        .map_err(|e| format!("write client leftover: {e}"))?;
    }
    return stream_until_eof(upstream, client).await;
  }

  // HTML path: buffer the body so we can inject before </body> and recompute
  // Content-Length. Cap at MAX_HTML_BUFFER_BYTES; if the page is bigger, we
  // give up on injection and stream as-is.
  let mut body = leftover;
  let mut tmp = vec![0u8; STREAM_CHUNK];
  loop {
    if body.len() > MAX_HTML_BUFFER_BYTES {
      // Too big — give up on injection. Send what we have plus the rest as a
      // stream. Honest degradation: bridge won't load on this page, parent
      // will mark "console context unavailable".
      client
        .write_all(head.as_bytes())
        .await
        .map_err(|e| format!("write client head (oversize): {e}"))?;
      client
        .write_all(&body)
        .await
        .map_err(|e| format!("write client body (oversize): {e}"))?;
      return stream_until_eof(upstream, client).await;
    }
    let n = upstream
      .read(&mut tmp)
      .await
      .map_err(|e| format!("read upstream body: {e}"))?;
    if n == 0 {
      break;
    }
    body.extend_from_slice(&tmp[..n]);
  }

  // De-chunk if needed; Next dev usually sends Content-Length but Vite uses
  // chunked. dechunk_if_needed returns the body either way.
  let transfer_encoding = header_value(&head, "transfer-encoding").unwrap_or_default();
  let body = if transfer_encoding.to_ascii_lowercase().contains("chunked") {
    dechunk(&body)?
  } else {
    body
  };

  let injected = inject_bridge_script(&body);
  let new_head = rewrite_response_headers(&head, injected.len());
  client
    .write_all(new_head.as_bytes())
    .await
    .map_err(|e| format!("write client head (html): {e}"))?;
  client
    .write_all(&injected)
    .await
    .map_err(|e| format!("write client body (html): {e}"))?;
  Ok(())
}

async fn read_response_head(stream: &mut TcpStream) -> Result<(String, Vec<u8>), String> {
  let mut buf = Vec::with_capacity(2048);
  let mut tmp = [0u8; STREAM_CHUNK];
  loop {
    if buf.len() > MAX_HEADER_BYTES {
      return Err("response header too large".into());
    }
    let n = stream
      .read(&mut tmp)
      .await
      .map_err(|e| format!("read upstream head: {e}"))?;
    if n == 0 {
      return Err("upstream closed before headers complete".into());
    }
    buf.extend_from_slice(&tmp[..n]);
    if let Some(end) = find_double_crlf(&buf) {
      let head = String::from_utf8_lossy(&buf[..end]).to_string();
      let leftover = buf[end..].to_vec();
      return Ok((head, leftover));
    }
  }
}

fn header_value(head: &str, key_lower: &str) -> Option<String> {
  for line in head.lines().skip(1) {
    if let Some((k, v)) = line.split_once(':') {
      if k.trim().eq_ignore_ascii_case(key_lower) {
        return Some(v.trim().to_string());
      }
    }
  }
  None
}

fn rewrite_response_headers(head: &str, new_content_length: usize) -> String {
  let mut out = String::with_capacity(head.len() + 64);
  for (idx, line) in head.lines().enumerate() {
    if idx == 0 {
      out.push_str(line);
      out.push_str("\r\n");
      continue;
    }
    // Skip the trailing blank line — same reason as rewrite_request_headers.
    if line.is_empty() {
      continue;
    }
    let lower = line.to_ascii_lowercase();
    let key = lower.split(':').next().unwrap_or("").trim();
    if matches!(
      key,
      "content-length" | "transfer-encoding" | "connection" | "keep-alive" | "content-encoding"
    ) {
      continue;
    }
    out.push_str(line);
    out.push_str("\r\n");
  }
  out.push_str(&format!("Content-Length: {new_content_length}\r\n"));
  out.push_str("Connection: close\r\n");
  out.push_str("\r\n");
  out
}

/// Inject `<script src="/__builder-bridge.js"></script>` immediately before
/// the closing `</body>`. If `</body>` is missing (e.g. a fragment response),
/// append the script at the end — still loads in the browser.
pub fn inject_bridge_script(body: &[u8]) -> Vec<u8> {
  const SCRIPT: &[u8] = b"<script src=\"/__builder-bridge.js\"></script>";
  // Case-insensitive search for `</body>`. Body is small enough to do this
  // naively; we don't need a full HTML parser.
  let needle = b"</body>";
  let lower: Vec<u8> = body.iter().map(|b| b.to_ascii_lowercase()).collect();
  if let Some(pos) = find_subsequence(&lower, needle) {
    let mut out = Vec::with_capacity(body.len() + SCRIPT.len());
    out.extend_from_slice(&body[..pos]);
    out.extend_from_slice(SCRIPT);
    out.extend_from_slice(&body[pos..]);
    out
  } else {
    let mut out = Vec::with_capacity(body.len() + SCRIPT.len());
    out.extend_from_slice(body);
    out.extend_from_slice(SCRIPT);
    out
  }
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
  haystack
    .windows(needle.len())
    .position(|w| w == needle)
}

/// Dechunk an HTTP/1.1 chunked-transfer body. Trailers are dropped (we don't
/// forward them — the proxy speaks Content-Length downstream).
fn dechunk(body: &[u8]) -> Result<Vec<u8>, String> {
  let mut out = Vec::with_capacity(body.len());
  let mut i = 0;
  while i < body.len() {
    let line_end = match body[i..].windows(2).position(|w| w == b"\r\n") {
      Some(p) => i + p,
      None => return Err("dechunk: missing CRLF after size".into()),
    };
    let size_line = std::str::from_utf8(&body[i..line_end])
      .map_err(|_| "dechunk: non-utf8 size line".to_string())?;
    let size_hex = size_line.split(';').next().unwrap_or("").trim();
    let size = usize::from_str_radix(size_hex, 16)
      .map_err(|_| format!("dechunk: bad size {size_hex:?}"))?;
    i = line_end + 2;
    if size == 0 {
      // Last-chunk; everything after is trailers. Done.
      break;
    }
    if i + size > body.len() {
      return Err("dechunk: chunk size overruns body".into());
    }
    out.extend_from_slice(&body[i..i + size]);
    i += size;
    // Trailing CRLF after each chunk.
    if i + 2 <= body.len() && &body[i..i + 2] == b"\r\n" {
      i += 2;
    }
  }
  Ok(out)
}

async fn stream_until_eof(from: &mut TcpStream, to: &mut TcpStream) -> Result<(), String> {
  let mut buf = vec![0u8; STREAM_CHUNK];
  loop {
    let n = from
      .read(&mut buf)
      .await
      .map_err(|e| format!("stream read: {e}"))?;
    if n == 0 {
      break;
    }
    to.write_all(&buf[..n])
      .await
      .map_err(|e| format!("stream write: {e}"))?;
  }
  to.shutdown().await.ok();
  Ok(())
}

async fn tunnel_bidirectional(mut a: TcpStream, mut b: TcpStream) -> Result<(), String> {
  // Bidirectional bytecopy. tokio::io::copy_bidirectional handles half-closes
  // correctly, which matters because WebSocket close frames may arrive on
  // one side while the other still has data to send.
  let _ = tokio::io::copy_bidirectional(&mut a, &mut b)
    .await
    .map_err(|e| format!("ws tunnel: {e}"))?;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn injects_before_body_close() {
    let html = b"<html><body>hello</body></html>";
    let out = inject_bridge_script(html);
    let s = String::from_utf8(out).unwrap();
    assert!(s.contains("<script src=\"/__builder-bridge.js\"></script></body>"));
    assert!(s.starts_with("<html><body>hello"));
  }

  #[test]
  fn injects_case_insensitive_body() {
    let html = b"<html><BODY>x</BODY></html>";
    let out = inject_bridge_script(html);
    assert!(String::from_utf8_lossy(&out).contains("<script"));
  }

  #[test]
  fn injects_at_end_when_no_body_tag() {
    let html = b"<div>fragment</div>";
    let out = inject_bridge_script(html);
    let s = String::from_utf8(out).unwrap();
    assert!(s.ends_with("<script src=\"/__builder-bridge.js\"></script>"));
  }

  #[test]
  fn dechunk_basic() {
    let chunked = b"5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n";
    assert_eq!(dechunk(chunked).unwrap(), b"hello world".to_vec());
  }

  #[test]
  fn dechunk_with_extension_after_semicolon() {
    let chunked = b"5;ext=1\r\nhello\r\n0\r\n\r\n";
    assert_eq!(dechunk(chunked).unwrap(), b"hello".to_vec());
  }

  #[test]
  fn detects_websocket_upgrade() {
    let head = "GET /_next/webpack-hmr HTTP/1.1\r\n\
                Host: localhost:3000\r\n\
                Upgrade: websocket\r\n\
                Connection: Upgrade\r\n";
    assert!(is_websocket_upgrade(head));
  }

  #[test]
  fn rejects_non_ws_request_with_only_upgrade() {
    let head = "GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n";
    assert!(!is_websocket_upgrade(head));
  }

  #[test]
  fn rewrite_strips_accept_encoding() {
    let head = "GET / HTTP/1.1\r\nHost: x\r\nAccept-Encoding: gzip, deflate\r\n";
    let out = rewrite_request_headers(head, "127.0.0.1:3000");
    assert!(out.contains("Accept-Encoding: identity"));
    assert!(!out.contains("gzip"));
    assert!(out.contains("Connection: close"));
  }

  #[test]
  fn rewrite_overwrites_host_with_upstream() {
    // Without this Next.js 15.5+ rejects the request as cross-origin
    // because the iframe's Host points at the proxy port, not upstream.
    let head = "GET / HTTP/1.1\r\nHost: localhost:50994\r\n";
    let out = rewrite_request_headers(head, "127.0.0.1:3002");
    assert!(out.contains("Host: 127.0.0.1:3002\r\n"));
    assert!(!out.contains("Host: localhost:50994"));
  }

  #[test]
  fn rewrite_strips_origin_referer_and_sec_fetch() {
    // The iframe inside Tauri sends Origin: tauri://localhost which
    // Next 15.5 treats as a cross-site request and rejects with 400
    // unless allowedDevOrigins is configured. We strip the lot so
    // upstream sees a plain same-origin GET.
    let head = "GET / HTTP/1.1\r\nHost: x\r\nOrigin: http://tauri.localhost\r\nReferer: http://tauri.localhost/\r\nSec-Fetch-Site: cross-site\r\nSec-Fetch-Mode: navigate\r\nSec-Fetch-Dest: iframe\r\n";
    let out = rewrite_request_headers(head, "127.0.0.1:3000");
    assert!(!out.to_ascii_lowercase().contains("origin:"));
    assert!(!out.to_ascii_lowercase().contains("referer:"));
    assert!(!out.to_ascii_lowercase().contains("sec-fetch"));
  }

  #[test]
  fn rewrite_adds_host_when_missing() {
    let head = "GET / HTTP/1.1\r\nAccept: */*\r\n";
    let out = rewrite_request_headers(head, "127.0.0.1:3000");
    assert!(out.contains("Host: 127.0.0.1:3000"));
  }

  #[test]
  fn rewrite_skips_trailing_blank_line_from_double_crlf() {
    // read_request_head returns the buffer up to AND INCLUDING the
    // double-crlf, so head ends with `\r\n\r\n`. .lines() turns that
    // into a trailing empty entry. If the rewrite loop writes that
    // empty line, the rebuilt request has end-of-headers in the middle
    // and the upstream rejects the trailing Connection: close as a
    // malformed second request — Next.js 15.5+ specifically returns
    // 400 Bad Request to this exact shape.
    let head = "GET / HTTP/1.1\r\nHost: x\r\nAccept: */*\r\n\r\n";
    let out = rewrite_request_headers(head, "127.0.0.1:3000");
    // The rebuilt request must contain exactly one CRLF-CRLF (the
    // end-of-headers terminator), at the very end.
    let crlf_crlf_count = out.matches("\r\n\r\n").count();
    assert_eq!(
      crlf_crlf_count, 1,
      "expected exactly one \\r\\n\\r\\n; got {crlf_crlf_count} in:\n{out}"
    );
    assert!(
      out.ends_with("\r\n\r\n"),
      "rewrite output must end with \\r\\n\\r\\n; got:\n{out}"
    );
  }

  #[test]
  fn response_rewrite_skips_trailing_blank_line() {
    // Same bug class on the response side. Without the skip, the body
    // injection writes Content-Length AFTER an empty-line-induced
    // end-of-headers, so the client (Tauri webview) sees a body that
    // starts with Content-Length: ... and a malformed page.
    let head =
      "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nTransfer-Encoding: chunked\r\n\r\n";
    let out = rewrite_response_headers(head, 1024);
    let crlf_crlf_count = out.matches("\r\n\r\n").count();
    assert_eq!(crlf_crlf_count, 1, "got:\n{out}");
    assert!(out.ends_with("\r\n\r\n"));
    assert!(out.contains("Content-Length: 1024"));
    assert!(!out.contains("Transfer-Encoding"));
  }

  #[test]
  fn request_path_match_handles_querystring() {
    assert!(request_starts_with_path(
      "GET /__builder-bridge.js?v=1 HTTP/1.1",
      BRIDGE_PATH,
    ));
    assert!(request_starts_with_path(
      "GET /__builder-bridge.js HTTP/1.1",
      BRIDGE_PATH,
    ));
    assert!(!request_starts_with_path("GET /other HTTP/1.1", BRIDGE_PATH));
  }

  // ---- end-to-end proxy tests ---------------------------------------------
  // We stand up a tiny upstream HTTP server on a random port, point the proxy
  // at it, then make requests through the proxy via TcpStream and assert on
  // the raw bytes coming back. No hyper / reqwest here on purpose — the test
  // exercises exactly the bytes the iframe will see.

  use std::time::Duration;
  use tokio::net::TcpListener as TokioTcpListener;

  async fn spawn_upstream(response: &'static [u8]) -> u16 {
    let listener = TokioTcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
      loop {
        let (mut sock, _) = listener.accept().await.unwrap();
        // Drain the request head so the client sees our writes flush.
        let mut buf = [0u8; 4096];
        let _ = tokio::time::timeout(Duration::from_millis(500), sock.read(&mut buf)).await;
        let _ = sock.write_all(response).await;
        let _ = sock.shutdown().await;
      }
    });
    port
  }

  async fn http_get_through(proxy_port: u16, path: &str) -> Vec<u8> {
    let mut client = TcpStream::connect(("127.0.0.1", proxy_port)).await.unwrap();
    let req = format!(
      "GET {path} HTTP/1.1\r\nHost: localhost\r\nAccept-Encoding: gzip\r\n\r\n",
    );
    client.write_all(req.as_bytes()).await.unwrap();
    let mut out = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(2), client.read_to_end(&mut out)).await;
    out
  }

  #[tokio::test]
  async fn proxies_html_and_injects_bridge_script() {
    let response = b"HTTP/1.1 200 OK\r\n\
                     Content-Type: text/html\r\n\
                     Content-Length: 32\r\n\
                     Connection: close\r\n\r\n\
                     <html><body>hello</body></html>" as &[u8];
    let upstream = spawn_upstream(response).await;
    let proxy = start(upstream).await.unwrap();
    let body = http_get_through(proxy.port, "/").await;
    let s = String::from_utf8_lossy(&body);
    assert!(s.contains("Content-Type: text/html"), "missing CT: {s}");
    assert!(
      s.contains("<script src=\"/__builder-bridge.js\"></script></body>"),
      "missing injection: {s}",
    );
    // Content-Length should reflect the injected payload, not the original 32.
    let new_len_line = s.lines().find(|l| l.to_ascii_lowercase().starts_with("content-length:"));
    assert!(new_len_line.is_some(), "no content-length header: {s}");
    let len: usize = new_len_line
      .unwrap()
      .split(':')
      .nth(1)
      .unwrap()
      .trim()
      .parse()
      .unwrap();
    assert_eq!(len, "<html><body>hello".len() + "<script src=\"/__builder-bridge.js\"></script>".len() + "</body></html>".len());
    proxy.shutdown().await;
  }

  #[tokio::test]
  async fn serves_bridge_js_on_well_known_path() {
    // Upstream is a black hole; the proxy should never connect to it for
    // the bridge JS path.
    let upstream = spawn_upstream(b"HTTP/1.1 500 ERR\r\nContent-Length: 0\r\n\r\n").await;
    let proxy = start(upstream).await.unwrap();
    let body = http_get_through(proxy.port, "/__builder-bridge.js").await;
    let s = String::from_utf8_lossy(&body);
    assert!(s.contains("Content-Type: application/javascript"));
    assert!(s.contains("__builderBridgeLoaded"), "bridge script body missing");
    proxy.shutdown().await;
  }

  #[tokio::test]
  async fn forwards_non_html_unchanged() {
    let response = b"HTTP/1.1 200 OK\r\n\
                     Content-Type: application/javascript\r\n\
                     Content-Length: 13\r\n\
                     Connection: close\r\n\r\n\
                     console.log(1)" as &[u8];
    let upstream = spawn_upstream(response).await;
    let proxy = start(upstream).await.unwrap();
    let body = http_get_through(proxy.port, "/app.js").await;
    let s = String::from_utf8_lossy(&body);
    assert!(s.contains("console.log(1)"));
    assert!(!s.contains("__builder-bridge.js"));
    proxy.shutdown().await;
  }

  #[test]
  fn rewrite_response_replaces_length_and_drops_encoding() {
    let head = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\
                Content-Length: 99\r\nTransfer-Encoding: chunked\r\n\
                Content-Encoding: gzip\r\nConnection: keep-alive\r\n";
    let out = rewrite_response_headers(head, 42);
    assert!(out.contains("Content-Length: 42"));
    assert!(!out.contains("Content-Length: 99"));
    assert!(!out.contains("Transfer-Encoding"));
    assert!(!out.contains("Content-Encoding"));
    assert!(out.contains("Content-Type: text/html"));
    assert!(out.contains("Connection: close"));
  }
}
