// Builder preview bridge (ADR-0014). Injected into the target app's HTML by
// the Builder's preview proxy. Hooks console + uncaught errors and relays
// them to the parent window via postMessage. Also responds to `snapshot` and
// `resolve` requests from the parent (used by the annotation modal in PR-2).
//
// Cross-origin: parent is the Tauri webview, iframe is the target app on a
// different origin, so we can only talk via postMessage. We target "*" because
// the parent's exact origin varies by Tauri build target; the parent filters
// by `event.source === iframe.contentWindow` instead.
//
// Idempotent: if loaded twice (HMR, soft nav), the second copy is a no-op.

(function () {
  if (window.__builderBridgeLoaded) return;
  window.__builderBridgeLoaded = true;

  var BRIDGE_VERSION = 2;
  var MAX_ARG_LENGTH = 2000; // truncate per-arg to keep messages bounded
  var MAX_NETWORK_BODY_SAMPLE = 500; // clip response body samples

  function safeStringify(value) {
    if (value === undefined) return "undefined";
    if (value === null) return "null";
    var t = typeof value;
    if (t === "string") return clip(value);
    if (t === "number" || t === "boolean") return String(value);
    if (t === "function") return "[Function" + (value.name ? " " + value.name : "") + "]";
    if (value instanceof Error) {
      return clip(value.name + ": " + value.message + (value.stack ? "\n" + value.stack : ""));
    }
    try {
      var seen = new WeakSet();
      return clip(
        JSON.stringify(value, function (_, v) {
          if (typeof v === "object" && v !== null) {
            if (seen.has(v)) return "[Circular]";
            seen.add(v);
          }
          if (v instanceof HTMLElement) return "<" + v.tagName.toLowerCase() + ">";
          return v;
        }),
      );
    } catch (e) {
      return "[Unserialisable: " + (e && e.message) + "]";
    }
  }

  function clip(s) {
    return s.length > MAX_ARG_LENGTH ? s.slice(0, MAX_ARG_LENGTH) + "…[truncated]" : s;
  }

  function send(message) {
    try {
      window.parent.postMessage(
        Object.assign({ __builderBridge: true, version: BRIDGE_VERSION }, message),
        "*",
      );
    } catch {
      // Parent may be gone (preview tab closed). Drop silently.
    }
  }

  // ---- console hooks -----------------------------------------------------
  ["log", "warn", "error", "info", "debug"].forEach(function (level) {
    var original = console[level] ? console[level].bind(console) : function () {};
    console[level] = function () {
      var args = Array.prototype.slice.call(arguments).map(safeStringify);
      send({ type: "console", level: level, args: args, ts: Date.now() });
      return original.apply(null, arguments);
    };
  });

  // ---- runtime error hooks ----------------------------------------------
  window.addEventListener("error", function (e) {
    send({
      type: "error",
      message: e.message || "Uncaught error",
      filename: e.filename || null,
      line: e.lineno || null,
      column: e.colno || null,
      stack: e.error && e.error.stack ? clip(e.error.stack) : null,
      ts: Date.now(),
    });
  });

  window.addEventListener("unhandledrejection", function (e) {
    var reason = e.reason;
    send({
      type: "unhandledrejection",
      message: reason instanceof Error ? reason.message : safeStringify(reason),
      stack: reason instanceof Error && reason.stack ? clip(reason.stack) : null,
      ts: Date.now(),
    });
  });

  // ---- network hooks (bridge v2) ---------------------------------------
  // Wraps window.fetch and XMLHttpRequest so the parent gets URL, method,
  // status, duration, and a clipped response sample for every request the
  // iframe makes. Useful when the agent's task is "why does this API call
  // fail" — the agent sees the request the iframe actually issued, not just
  // a bitmap of "the page is broken-looking".

  function clipBody(body) {
    if (typeof body !== "string") return null;
    return body.length > MAX_NETWORK_BODY_SAMPLE
      ? body.slice(0, MAX_NETWORK_BODY_SAMPLE) + "…[truncated]"
      : body;
  }

  if (typeof window.fetch === "function") {
    var originalFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var startedAt = Date.now();
      var method = (init && init.method) || (input && input.method) || "GET";
      var url =
        typeof input === "string"
          ? input
          : input && input.url
            ? input.url
            : String(input);
      return originalFetch(input, init).then(
        function (response) {
          var clone;
          try {
            clone = response.clone();
          } catch {
            clone = null;
          }
          var emit = function (sample) {
            send({
              type: "network",
              method: method.toUpperCase(),
              url: url,
              status: response.status,
              ok: response.ok,
              durationMs: Date.now() - startedAt,
              responseSample: sample,
              ts: Date.now(),
            });
          };
          // Best-effort: only sample text-ish responses so we don't ship
          // binary chunks. If reading the clone throws (already consumed,
          // streaming-only), emit without a sample.
          if (clone) {
            var ct = (response.headers.get("content-type") || "").toLowerCase();
            var sniffable = /(json|text|xml|html|javascript|form-urlencoded)/.test(ct);
            if (sniffable) {
              clone
                .text()
                .then(function (txt) {
                  emit(clipBody(txt));
                })
                .catch(function () {
                  emit(null);
                });
            } else {
              emit(null);
            }
          } else {
            emit(null);
          }
          return response;
        },
        function (err) {
          send({
            type: "network",
            method: method.toUpperCase(),
            url: url,
            status: 0,
            ok: false,
            durationMs: Date.now() - startedAt,
            error: err instanceof Error ? err.message : String(err),
            ts: Date.now(),
          });
          throw err;
        },
      );
    };
  }

  if (typeof window.XMLHttpRequest === "function") {
    var OriginalXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = function PatchedXHR() {
      var xhr = new OriginalXHR();
      var meta = { method: "GET", url: "", startedAt: 0 };
      var origOpen = xhr.open;
      xhr.open = function (method, url) {
        meta.method = String(method || "GET").toUpperCase();
        meta.url = String(url || "");
        return origOpen.apply(xhr, arguments);
      };
      var origSend = xhr.send;
      xhr.send = function () {
        meta.startedAt = Date.now();
        xhr.addEventListener("loadend", function () {
          var sample = null;
          try {
            if (typeof xhr.responseText === "string") {
              sample = clipBody(xhr.responseText);
            }
          } catch {
            sample = null;
          }
          send({
            type: "network",
            method: meta.method,
            url: meta.url,
            status: xhr.status || 0,
            ok: xhr.status >= 200 && xhr.status < 300,
            durationMs: Date.now() - meta.startedAt,
            responseSample: sample,
            ts: Date.now(),
          });
        });
        return origSend.apply(xhr, arguments);
      };
      return xhr;
    };
    // Preserve static fields (readyState constants, etc.)
    for (var key in OriginalXHR) {
      try {
        window.XMLHttpRequest[key] = OriginalXHR[key];
      } catch {
        // Read-only; skip.
      }
    }
    window.XMLHttpRequest.prototype = OriginalXHR.prototype;
  }

  // ---- request/response channel (PR-2 uses these; harmless to install now)
  window.addEventListener("message", function (e) {
    var data = e.data;
    if (!data || data.__builderBridge !== true || !data.requestId) return;
    if (data.type === "snapshot") {
      send({
        type: "snapshotResult",
        requestId: data.requestId,
        url: location.href,
        viewport: { w: window.innerWidth, h: window.innerHeight },
        scroll: { x: window.scrollX, y: window.scrollY },
        ts: Date.now(),
      });
    } else if (data.type === "screenshot") {
      // Render the iframe DOM to a PNG via the SVG <foreignObject> trick.
      // Limitations (worth knowing): cross-origin images become broken,
      // webfonts that aren't already loaded may render in a fallback,
      // CSS that uses url(...) referencing other origins won't resolve.
      // For the typical novice app — local CSS, system fonts, local
      // images — output is faithful. We accept these limits to avoid
      // bundling html2canvas (~50KB) into the bridge.
      var vw = window.innerWidth;
      var vh = window.innerHeight;
      var clone = document.documentElement.cloneNode(true);
      // Inline scrollX/Y by translating the clone so the visible viewport
      // ends up at (0,0) of the rendered image.
      clone.style.transform =
        "translate(" + -window.scrollX + "px, " + -window.scrollY + "px)";
      var serialised = new XMLSerializer().serializeToString(clone);
      var svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="' +
        vw +
        '" height="' +
        vh +
        '">' +
        '<foreignObject width="100%" height="100%">' +
        serialised +
        "</foreignObject></svg>";
      var blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        try {
          var canvas = document.createElement("canvas");
          canvas.width = vw;
          canvas.height = vh;
          var ctx = canvas.getContext("2d");
          if (!ctx) {
            URL.revokeObjectURL(url);
            send({
              type: "screenshotResult",
              requestId: data.requestId,
              ok: false,
              error: "no 2d context",
              ts: Date.now(),
            });
            return;
          }
          ctx.fillStyle = "white";
          ctx.fillRect(0, 0, vw, vh);
          ctx.drawImage(img, 0, 0);
          var dataUrl = canvas.toDataURL("image/png");
          URL.revokeObjectURL(url);
          // Strip the "data:image/png;base64," prefix so the parent gets
          // pure base64 it can hand to feedback_image_save unmodified.
          var prefix = "data:image/png;base64,";
          var b64 = dataUrl.indexOf(prefix) === 0 ? dataUrl.slice(prefix.length) : dataUrl;
          send({
            type: "screenshotResult",
            requestId: data.requestId,
            ok: true,
            pngBase64: b64,
            viewport: { w: vw, h: vh },
            scroll: { x: window.scrollX, y: window.scrollY },
            ts: Date.now(),
          });
        } catch (e) {
          URL.revokeObjectURL(url);
          send({
            type: "screenshotResult",
            requestId: data.requestId,
            ok: false,
            error: e instanceof Error ? e.message : String(e),
            ts: Date.now(),
          });
        }
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        send({
          type: "screenshotResult",
          requestId: data.requestId,
          ok: false,
          error: "image load failed (likely cross-origin asset in DOM)",
          ts: Date.now(),
        });
      };
      img.src = url;
    } else if (data.type === "resolve" && Array.isArray(data.points)) {
      var resolved = data.points.map(function (p) {
        var el = document.elementFromPoint(p.x, p.y);
        if (!el) return null;
        return {
          tag: el.tagName ? el.tagName.toLowerCase() : null,
          id: el.id || null,
          classes: el.className && typeof el.className === "string" ? el.className : null,
          role: el.getAttribute ? el.getAttribute("role") : null,
          text: el.textContent ? clip(el.textContent.trim().slice(0, 200)) : null,
          outerHTML: el.outerHTML ? clip(el.outerHTML.slice(0, 1000)) : null,
        };
      });
      send({ type: "resolveResult", requestId: data.requestId, elements: resolved, ts: Date.now() });
    }
  });

  // Announce we're alive. Parent uses this to drop the "console context
  // unavailable" warning.
  send({ type: "hello", url: location.href, ts: Date.now() });
})();
