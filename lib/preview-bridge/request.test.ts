// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { requestScreenshot, requestSnapshot, resolveElements } from "./request";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/**
 * Build a fake iframe whose contentWindow records postMessage calls and
 * whose responses can be replayed via the parent's `window.dispatchEvent`.
 * jsdom doesn't load child documents, so we don't get a real cross-frame
 * source — we set `MessageEvent.source` to whatever the test wants.
 */
function makeFakeIframe(): {
  iframe: HTMLIFrameElement;
  postMessage: ReturnType<typeof vi.fn>;
  reply: (payload: Record<string, unknown>) => void;
} {
  const iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  const postMessage = vi.fn();
  // jsdom's iframe.contentWindow is a real Window; we shim postMessage on it.
  // The `close` no-op is for jsdom's teardown which iterates all frames and
  // calls `.close()` on each — without it we get an unhandled error after
  // the suite finishes.
  Object.defineProperty(iframe, "contentWindow", {
    value: { postMessage, close: () => {} },
    configurable: true,
  });
  function reply(payload: Record<string, unknown>): void {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { __builderBridge: true, version: 1, ...payload },
        source: iframe.contentWindow as Window,
      }),
    );
  }
  return { iframe, postMessage, reply };
}

describe("requestSnapshot", () => {
  it("returns null when iframe has no contentWindow", async () => {
    const result = await requestSnapshot(null);
    expect(result).toBeNull();
  });

  it("posts a snapshot request and resolves with the reply", async () => {
    const { iframe, postMessage, reply } = makeFakeIframe();
    const promise = requestSnapshot(iframe);
    // Inspect the posted message and use its requestId in the reply so the
    // correlation succeeds.
    expect(postMessage).toHaveBeenCalledTimes(1);
    const sent = postMessage.mock.calls[0]![0] as { requestId: string };
    reply({
      type: "snapshotResult",
      requestId: sent.requestId,
      url: "http://localhost:3000/page",
      viewport: { w: 1024, h: 768 },
      scroll: { x: 0, y: 200 },
    });
    await expect(promise).resolves.toEqual({
      url: "http://localhost:3000/page",
      viewport: { w: 1024, h: 768 },
      scroll: { x: 0, y: 200 },
    });
  });

  it("ignores replies with the wrong requestId", async () => {
    const { iframe, postMessage, reply } = makeFakeIframe();
    const promise = requestSnapshot(iframe);
    const sent = postMessage.mock.calls[0]![0] as { requestId: string };
    reply({
      type: "snapshotResult",
      requestId: "different-id",
      url: "wrong",
      viewport: { w: 0, h: 0 },
      scroll: { x: 0, y: 0 },
    });
    // Then the right one.
    reply({
      type: "snapshotResult",
      requestId: sent.requestId,
      url: "right",
      viewport: { w: 1, h: 2 },
      scroll: { x: 3, y: 4 },
    });
    await expect(promise).resolves.toMatchObject({ url: "right" });
  });

  it("returns null when the reply doesn't arrive within 2 seconds", async () => {
    const { iframe } = makeFakeIframe();
    const promise = requestSnapshot(iframe);
    vi.advanceTimersByTime(2_001);
    await expect(promise).resolves.toBeNull();
  });

  it("ignores replies whose source isn't the bound iframe", async () => {
    const { iframe, postMessage } = makeFakeIframe();
    const promise = requestSnapshot(iframe);
    const sent = postMessage.mock.calls[0]![0] as { requestId: string };
    // Send a reply with source = window (not the iframe).
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          __builderBridge: true,
          version: 1,
          type: "snapshotResult",
          requestId: sent.requestId,
          url: "wrong-source",
          viewport: { w: 0, h: 0 },
          scroll: { x: 0, y: 0 },
        },
        source: window,
      }),
    );
    vi.advanceTimersByTime(2_001);
    await expect(promise).resolves.toBeNull();
  });
});

describe("resolveElements", () => {
  it("forwards points and returns the resolved elements", async () => {
    const { iframe, postMessage, reply } = makeFakeIframe();
    const promise = resolveElements(iframe, [
      { x: 10, y: 20 },
      { x: 30, y: 40 },
    ]);
    const sent = postMessage.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.type).toBe("resolve");
    expect(sent.points).toEqual([
      { x: 10, y: 20 },
      { x: 30, y: 40 },
    ]);
    reply({
      type: "resolveResult",
      requestId: sent.requestId,
      elements: [
        { tag: "button", id: null, classes: "cta", role: null, text: "Sign up", outerHTML: null },
        null,
      ],
    });
    await expect(promise).resolves.toEqual([
      { tag: "button", id: null, classes: "cta", role: null, text: "Sign up", outerHTML: null },
      null,
    ]);
  });

  it("returns null on timeout", async () => {
    const { iframe } = makeFakeIframe();
    const promise = resolveElements(iframe, [{ x: 0, y: 0 }]);
    vi.advanceTimersByTime(2_001);
    await expect(promise).resolves.toBeNull();
  });
});

describe("requestScreenshot", () => {
  it("resolves with the PNG payload on success", async () => {
    const { iframe, postMessage, reply } = makeFakeIframe();
    const promise = requestScreenshot(iframe);
    const sent = postMessage.mock.calls[0]![0] as { requestId: string; type: string };
    expect(sent.type).toBe("screenshot");
    reply({
      type: "screenshotResult",
      requestId: sent.requestId,
      ok: true,
      pngBase64: "AAAA",
      viewport: { w: 1024, h: 768 },
      scroll: { x: 0, y: 0 },
    });
    await expect(promise).resolves.toEqual({
      pngBase64: "AAAA",
      viewport: { w: 1024, h: 768 },
      scroll: { x: 0, y: 0 },
    });
  });

  it("returns null when the iframe reports ok:false", async () => {
    const { iframe, postMessage, reply } = makeFakeIframe();
    const promise = requestScreenshot(iframe);
    const sent = postMessage.mock.calls[0]![0] as { requestId: string };
    reply({
      type: "screenshotResult",
      requestId: sent.requestId,
      ok: false,
      error: "image load failed",
    });
    await expect(promise).resolves.toBeNull();
  });

  it("uses a longer (5s) timeout than snapshot/resolve", async () => {
    const { iframe } = makeFakeIframe();
    const promise = requestScreenshot(iframe);
    vi.advanceTimersByTime(2_500);
    // At 2.5s a snapshot would have timed out, but screenshot's timeout is
    // 5s — the promise should still be pending.
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    vi.advanceTimersByTime(3_000);
    await expect(promise).resolves.toBeNull();
  });
});
