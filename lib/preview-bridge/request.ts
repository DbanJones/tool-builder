// Request/response over the preview bridge. The bridge JS in the iframe
// (src-tauri/assets/builder-bridge.js) listens for `{type, requestId}`
// messages and posts back `{type:"<type>Result", requestId, ...}`.
//
// Each request has a 2s timeout and resolves to null on miss — the caller
// degrades gracefully when the iframe has navigated away, the bridge isn't
// loaded (CSP), or the response was simply slow.

const REQUEST_TIMEOUT_MS = 2_000;
const SCREENSHOT_TIMEOUT_MS = 5_000;

export interface IframeSnapshot {
  url: string;
  viewport: { w: number; h: number };
  scroll: { x: number; y: number };
}

export interface ResolvedElement {
  tag: string | null;
  id: string | null;
  classes: string | null;
  role: string | null;
  text: string | null;
  outerHTML: string | null;
}

export type ResolvedElements = readonly (ResolvedElement | null)[];

export interface IframePoint {
  /** iframe-content x in CSS pixels (post-translation from the screenshot bitmap) */
  x: number;
  /** iframe-content y in CSS pixels */
  y: number;
}

let nextRequestId = 0;

function makeRequestId(): string {
  nextRequestId += 1;
  return `bridge-req-${Date.now()}-${nextRequestId}`;
}

/**
 * Send a `{type, ...payload, requestId}` to the iframe and wait for a
 * `{type:"<type>Result", requestId, ...}` reply. Returns null on timeout.
 *
 * The promise NEVER rejects for transport errors — calling code should treat
 * a null return as "context unavailable, fall back to image-only".
 */
async function request<T>(
  iframe: HTMLIFrameElement | null,
  type: string,
  payload: Record<string, unknown>,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<T | null> {
  if (!iframe || !iframe.contentWindow) return null;
  const requestId = makeRequestId();
  const expectedType = `${type}Result`;

  return new Promise<T | null>((resolve) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      resolve(null);
    }, timeoutMs);

    function onMessage(e: MessageEvent): void {
      const data: unknown = e.data;
      if (
        typeof data !== "object" ||
        data === null ||
        e.source !== iframe!.contentWindow
      ) {
        return;
      }
      const d = data as Record<string, unknown>;
      if (d.__builderBridge !== true || d.type !== expectedType || d.requestId !== requestId) {
        return;
      }
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(d as unknown as T);
    }

    window.addEventListener("message", onMessage);
    iframe.contentWindow!.postMessage(
      { __builderBridge: true, version: 1, type, requestId, ...payload },
      "*",
    );
  });
}

/** Ask the iframe for its current URL, viewport, and scroll position. */
export async function requestSnapshot(
  iframe: HTMLIFrameElement | null,
): Promise<IframeSnapshot | null> {
  const result = await request<{
    url: string;
    viewport: { w: number; h: number };
    scroll: { x: number; y: number };
  }>(iframe, "snapshot", {});
  if (!result) return null;
  return { url: result.url, viewport: result.viewport, scroll: result.scroll };
}

/**
 * Ask the iframe to resolve a list of `(x, y)` points (iframe-content CSS
 * pixels, NOT bitmap pixels) to the DOM elements at those points. Returns
 * one element-or-null per input point, in order.
 */
export async function resolveElements(
  iframe: HTMLIFrameElement | null,
  points: readonly IframePoint[],
): Promise<ResolvedElements | null> {
  const result = await request<{ elements: readonly (ResolvedElement | null)[] }>(
    iframe,
    "resolve",
    { points },
  );
  if (!result) return null;
  return result.elements;
}

export interface IframeScreenshot {
  pngBase64: string;
  viewport: { w: number; h: number };
  scroll: { x: number; y: number };
}

/**
 * Ask the iframe to render its current DOM to a PNG via the bridge's
 * `<foreignObject>`-based renderer. 5s timeout (DOM rendering is slower
 * than a snapshot/resolve roundtrip). Returns null on timeout / render
 * failure / cross-origin asset issues — the caller should fall back to
 * the OS region capture path.
 */
export async function requestScreenshot(
  iframe: HTMLIFrameElement | null,
): Promise<IframeScreenshot | null> {
  const result = await request<{
    ok: boolean;
    pngBase64?: string;
    viewport?: { w: number; h: number };
    scroll?: { x: number; y: number };
    error?: string;
  }>(iframe, "screenshot", {}, SCREENSHOT_TIMEOUT_MS);
  if (!result || !result.ok || !result.pngBase64 || !result.viewport || !result.scroll) {
    return null;
  }
  return {
    pngBase64: result.pngBase64,
    viewport: result.viewport,
    scroll: result.scroll,
  };
}
