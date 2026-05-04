// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import {
  __resetBridgeForTests,
  formatBridgeEventForLiveTail,
  getBridgeListener,
  type BridgeSnapshot,
} from "./index";

afterEach(() => {
  __resetBridgeForTests();
});

function postBridgeMessage(payload: Record<string, unknown>): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { __builderBridge: true, version: 1, ...payload },
      source: window,
    }),
  );
}

describe("BridgeListener", () => {
  it("ignores messages without the __builderBridge marker", () => {
    const snaps: BridgeSnapshot[] = [];
    getBridgeListener().subscribe((s) => snaps.push(s));
    window.dispatchEvent(new MessageEvent("message", { data: { type: "console" } }));
    // Only the initial snapshot from subscribe; no event was buffered.
    expect(snaps.at(-1)?.events).toHaveLength(0);
  });

  it("buffers a console event and notifies subscribers", () => {
    const snaps: BridgeSnapshot[] = [];
    getBridgeListener().subscribe((s) => snaps.push(s));
    postBridgeMessage({
      type: "console",
      level: "error",
      args: ["boom"],
      ts: 1000,
    });
    const last = snaps.at(-1)!;
    expect(last.events).toHaveLength(1);
    expect(last.events[0]).toMatchObject({ kind: "console", level: "error", args: ["boom"] });
  });

  it("counts only error-class events in errorCount", () => {
    const snaps: BridgeSnapshot[] = [];
    getBridgeListener().subscribe((s) => snaps.push(s));
    postBridgeMessage({ type: "console", level: "log", args: ["chatty"], ts: 1 });
    postBridgeMessage({ type: "error", message: "oops", ts: 2 });
    postBridgeMessage({
      type: "unhandledrejection",
      message: "promise rejected",
      ts: 3,
    });
    expect(snaps.at(-1)!.errorCount).toBe(2);
  });

  it("flips status to connected on a hello event", () => {
    const snaps: BridgeSnapshot[] = [];
    getBridgeListener().subscribe((s) => snaps.push(s));
    expect(snaps.at(-1)!.status).toBe("absent");
    postBridgeMessage({ type: "hello", url: "http://localhost:3000/", ts: 1 });
    expect(snaps.at(-1)!.status).toBe("connected");
  });

  it("ring-buffers at 200 entries", () => {
    const listener = getBridgeListener();
    for (let i = 0; i < 250; i++) {
      postBridgeMessage({ type: "console", level: "log", args: [String(i)], ts: i });
    }
    const snap = listener.snapshot();
    expect(snap.events).toHaveLength(200);
    // The first 50 should have been dropped; last entry is the most recent.
    expect(snap.events[0]).toMatchObject({ args: ["50"] });
    expect(snap.events.at(-1)).toMatchObject({ args: ["249"] });
  });

  it("reset() clears events and status", () => {
    const listener = getBridgeListener();
    postBridgeMessage({ type: "hello", url: "http://x/", ts: 1 });
    postBridgeMessage({ type: "error", message: "x", ts: 2 });
    expect(listener.snapshot().events).toHaveLength(2);
    listener.reset();
    expect(listener.snapshot().events).toHaveLength(0);
    expect(listener.snapshot().status).toBe("absent");
  });

  it("filters by iframe source when bound", () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const listener = getBridgeListener();
    listener.bindIframe(iframe);
    // Source is `window`, not the iframe's contentWindow — should be ignored.
    postBridgeMessage({ type: "error", message: "wrong source", ts: 1 });
    expect(listener.snapshot().events).toHaveLength(0);
  });

  it("rejects payloads with a wrong-type level field by defaulting to log", () => {
    const listener = getBridgeListener();
    postBridgeMessage({ type: "console", level: 99, args: ["weird"], ts: 1 });
    expect(listener.snapshot().events[0]).toMatchObject({ kind: "console", level: "log" });
  });

  it("buffers network events", () => {
    const listener = getBridgeListener();
    postBridgeMessage({
      type: "network",
      method: "GET",
      url: "/api/users",
      status: 401,
      ok: false,
      durationMs: 42,
      responseSample: "{\"error\":\"unauth\"}",
      ts: 1,
    });
    const ev = listener.snapshot().events[0]!;
    expect(ev.kind).toBe("network");
    if (ev.kind === "network") {
      expect(ev.method).toBe("GET");
      expect(ev.status).toBe(401);
      expect(ev.ok).toBe(false);
      expect(ev.responseSample).toContain("unauth");
    }
  });

  it("counts non-2xx network events as errors in errorCount", () => {
    const listener = getBridgeListener();
    postBridgeMessage({
      type: "network",
      method: "POST",
      url: "/api/save",
      status: 500,
      ok: false,
      durationMs: 10,
      ts: 1,
    });
    postBridgeMessage({
      type: "network",
      method: "GET",
      url: "/api/healthy",
      status: 200,
      ok: true,
      durationMs: 5,
      ts: 2,
    });
    expect(listener.snapshot().errorCount).toBe(1);
  });

  it("pushServerEvent injects a server event into the ring", () => {
    const listener = getBridgeListener();
    listener.pushServerEvent({
      kind: "server",
      source: "stderr",
      severity: "error",
      message: "Module not found: 'foo'",
      ts: 100,
    });
    const ev = listener.snapshot().events[0]!;
    expect(ev.kind).toBe("server");
    if (ev.kind === "server") {
      expect(ev.severity).toBe("error");
      expect(ev.message).toContain("Module not found");
    }
    expect(listener.snapshot().errorCount).toBe(1);
  });
});

describe("formatBridgeEventForLiveTail", () => {
  it("formats errors with file/line", () => {
    const line = formatBridgeEventForLiveTail({
      kind: "error",
      message: "x is undefined",
      filename: "app/page.tsx",
      line: 42,
      column: 7,
      stack: null,
      ts: 0,
    });
    expect(line).toBe("[target browser] error: x is undefined at app/page.tsx:42");
  });

  it("formats unhandled rejections", () => {
    const line = formatBridgeEventForLiveTail({
      kind: "unhandledrejection",
      message: "fetch failed",
      stack: null,
      ts: 0,
    });
    expect(line).toBe("[target browser] unhandled rejection: fetch failed");
  });

  it("returns null for chatty console.log", () => {
    expect(
      formatBridgeEventForLiveTail({
        kind: "console",
        level: "log",
        args: ["x"],
        ts: 0,
      }),
    ).toBeNull();
  });

  it("surfaces console.error and console.warn", () => {
    expect(
      formatBridgeEventForLiveTail({
        kind: "console",
        level: "warn",
        args: ["deprecated"],
        ts: 0,
      }),
    ).toBe("[target browser] warn: deprecated");
  });

  it("drops the hello event from the live tail", () => {
    expect(
      formatBridgeEventForLiveTail({ kind: "hello", url: "x", ts: 0 }),
    ).toBeNull();
  });

  it("formats failed network requests with status + duration", () => {
    expect(
      formatBridgeEventForLiveTail({
        kind: "network",
        method: "GET",
        url: "/api/users",
        status: 500,
        ok: false,
        durationMs: 84,
        responseSample: null,
        error: null,
        ts: 0,
      }),
    ).toBe("[target network] GET /api/users — 500 (84ms)");
  });

  it("formats network transport errors", () => {
    expect(
      formatBridgeEventForLiveTail({
        kind: "network",
        method: "POST",
        url: "/api/save",
        status: 0,
        ok: false,
        durationMs: 0,
        responseSample: null,
        error: "Failed to fetch",
        ts: 0,
      }),
    ).toBe("[target network] POST /api/save — failed: Failed to fetch");
  });

  it("hides healthy 2xx network requests from the live tail", () => {
    expect(
      formatBridgeEventForLiveTail({
        kind: "network",
        method: "GET",
        url: "/api/users",
        status: 200,
        ok: true,
        durationMs: 12,
        responseSample: null,
        error: null,
        ts: 0,
      }),
    ).toBeNull();
  });

  it("formats error-severity server events", () => {
    expect(
      formatBridgeEventForLiveTail({
        kind: "server",
        source: "stderr",
        severity: "error",
        message: "Module not found",
        ts: 0,
      }),
    ).toBe("[target server] Module not found");
  });

  it("hides warn-severity server events from the live tail", () => {
    expect(
      formatBridgeEventForLiveTail({
        kind: "server",
        source: "stderr",
        severity: "warn",
        message: "deprecated",
        ts: 0,
      }),
    ).toBeNull();
  });
});
