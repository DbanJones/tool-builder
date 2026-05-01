// Parent-side preview bridge (ADR-0014). Listens for postMessage events from
// the iframe's injected bridge script, ring-buffers console + error events,
// and exposes them to the workspace via subscribe().
//
// The bridge is dev-time instrumentation: a quiet failure (proxy disabled,
// CSP blocks the script) just means events never arrive. We surface that as
// `status === "absent"` in the parent UI rather than throwing.

export type BridgeLevel = "log" | "warn" | "error" | "info" | "debug";

export interface BridgeConsoleEvent {
  kind: "console";
  level: BridgeLevel;
  args: readonly string[];
  ts: number;
}

export interface BridgeErrorEvent {
  kind: "error";
  message: string;
  filename: string | null;
  line: number | null;
  column: number | null;
  stack: string | null;
  ts: number;
}

export interface BridgeRejectionEvent {
  kind: "unhandledrejection";
  message: string;
  stack: string | null;
  ts: number;
}

export interface BridgeHelloEvent {
  kind: "hello";
  url: string;
  ts: number;
}

/** Network request observed via fetch / XMLHttpRequest patches in the bridge. */
export interface BridgeNetworkEvent {
  kind: "network";
  method: string;
  url: string;
  /** HTTP status; 0 indicates a transport-level failure (e.g. CORS, DNS). */
  status: number;
  ok: boolean;
  durationMs: number;
  /** First ~500 chars of the response body if it sniffed as text-ish. */
  responseSample: string | null;
  /** Set when the request rejected (e.g. network error) instead of resolving. */
  error: string | null;
  ts: number;
}

/** Server-side dev server output captured by launch.rs and forwarded over a Tauri channel. */
export interface BridgeServerEvent {
  kind: "server";
  /** "stdout" | "stderr". */
  source: string;
  /** Inferred severity from line content (error / warn / info). */
  severity: "error" | "warn" | "info";
  message: string;
  ts: number;
}

export type BridgeEvent =
  | BridgeConsoleEvent
  | BridgeErrorEvent
  | BridgeRejectionEvent
  | BridgeHelloEvent
  | BridgeNetworkEvent
  | BridgeServerEvent;

export type BridgeStatus = "absent" | "connected";

const RING_BUFFER_SIZE = 200;

/**
 * Singleton bridge listener. Multiple call sites (right-rail badge, live tail,
 * annotation modal) read from the same ring so they observe a consistent
 * stream. Lazily attached to `window` on first subscription.
 */
class BridgeListener {
  private events: BridgeEvent[] = [];
  private status: BridgeStatus = "absent";
  private subscribers = new Set<(snapshot: BridgeSnapshot) => void>();
  private attached = false;
  private iframe: HTMLIFrameElement | null = null;

  constructor() {
    this.attach();
  }

  /**
   * Tie the listener to a specific iframe element. Only messages whose
   * `source` matches the iframe's contentWindow are accepted; anything else
   * is ignored to avoid noise from sibling iframes / cross-origin pop-ups.
   */
  bindIframe(iframe: HTMLIFrameElement | null): void {
    this.iframe = iframe;
    this.attach();
  }

  /** The currently-bound iframe, if any. Used by feedback assembly to ask
   *  the bridge for an iframe snapshot at Send time. */
  getBoundIframe(): HTMLIFrameElement | null {
    return this.iframe;
  }

  /**
   * Reset the buffer + status. Call when the iframe re-keys or the dev
   * server restarts so stale events don't carry over.
   */
  reset(): void {
    this.events = [];
    this.status = "absent";
    this.notify();
  }

  subscribe(fn: (snapshot: BridgeSnapshot) => void): () => void {
    this.attach();
    this.subscribers.add(fn);
    fn(this.snapshot());
    return () => {
      this.subscribers.delete(fn);
    };
  }

  snapshot(): BridgeSnapshot {
    return {
      status: this.status,
      events: this.events,
      errorCount: this.events.filter(
        (e) =>
          e.kind === "error" ||
          e.kind === "unhandledrejection" ||
          (e.kind === "network" && !e.ok) ||
          (e.kind === "server" && e.severity === "error"),
      ).length,
    };
  }

  /** Used by launch.rs's Tauri channel to inject server-side events that
   *  didn't come through window.message (the proxy/bridge owns browser-side
   *  events; this owns dev-server stdout/stderr). */
  pushServerEvent(event: BridgeServerEvent): void {
    this.attach();
    this.push(event);
  }

  private attach(): void {
    if (this.attached || typeof window === "undefined") return;
    window.addEventListener("message", this.onMessage);
    this.attached = true;
  }

  private onMessage = (e: MessageEvent): void => {
    const data: unknown = e.data;
    if (!isBridgePayload(data)) return;
    if (this.iframe && e.source !== this.iframe.contentWindow) return;
    const event = parseEvent(data);
    if (!event) return;
    if (event.kind === "hello") {
      this.status = "connected";
    }
    this.push(event);
  };

  private push(event: BridgeEvent): void {
    this.events = [...this.events.slice(-(RING_BUFFER_SIZE - 1)), event];
    this.notify();
  }

  private notify(): void {
    const snap = this.snapshot();
    for (const fn of this.subscribers) fn(snap);
  }
}

export interface BridgeSnapshot {
  status: BridgeStatus;
  events: readonly BridgeEvent[];
  errorCount: number;
}

let listener: BridgeListener | null = null;

export function getBridgeListener(): BridgeListener {
  if (!listener) listener = new BridgeListener();
  return listener;
}

/** For tests only — drop the singleton so each test gets a fresh listener. */
export function __resetBridgeForTests(): void {
  listener = null;
}

// ---- payload validation ----------------------------------------------------

interface BridgePayload {
  __builderBridge: true;
  version: number;
  type: string;
  [key: string]: unknown;
}

function isBridgePayload(data: unknown): data is BridgePayload {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return d.__builderBridge === true && typeof d.type === "string" && typeof d.version === "number";
}

function parseEvent(data: BridgePayload): BridgeEvent | null {
  switch (data.type) {
    case "console":
      return {
        kind: "console",
        level: parseLevel(data.level),
        args: parseStringArray(data.args),
        ts: parseTs(data.ts),
      };
    case "error":
      return {
        kind: "error",
        message: parseString(data.message, "Uncaught error"),
        filename: parseStringOrNull(data.filename),
        line: parseNumberOrNull(data.line),
        column: parseNumberOrNull(data.column),
        stack: parseStringOrNull(data.stack),
        ts: parseTs(data.ts),
      };
    case "unhandledrejection":
      return {
        kind: "unhandledrejection",
        message: parseString(data.message, "Unhandled rejection"),
        stack: parseStringOrNull(data.stack),
        ts: parseTs(data.ts),
      };
    case "hello":
      return { kind: "hello", url: parseString(data.url, ""), ts: parseTs(data.ts) };
    case "network":
      return {
        kind: "network",
        method: parseString(data.method, "GET"),
        url: parseString(data.url, ""),
        status: parseNumber(data.status, 0),
        ok: parseBoolean(data.ok),
        durationMs: parseNumber(data.durationMs, 0),
        responseSample: parseStringOrNull(data.responseSample),
        error: parseStringOrNull(data.error),
        ts: parseTs(data.ts),
      };
    default:
      // snapshotResult / resolveResult / screenshotResult are PR-2/PR-4's
      // request/response surface; they're routed elsewhere (see
      // lib/preview-bridge/request.ts) and intentionally not stored in the
      // ring buffer.
      return null;
  }
}

function parseLevel(value: unknown): BridgeLevel {
  if (value === "log" || value === "warn" || value === "error" || value === "info" || value === "debug") {
    return value;
  }
  return "log";
}

function parseStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => (typeof v === "string" ? v : String(v)));
}

function parseString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function parseStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseTs(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

function parseNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseBoolean(value: unknown): boolean {
  return value === true;
}

// ---- formatters used by the live tail and the badge -----------------------

// ---- re-exports for the public surface ------------------------------------

export {
  requestScreenshot,
  requestSnapshot,
  resolveElements,
  type IframePoint,
  type IframeScreenshot,
  type IframeSnapshot,
  type ResolvedElement,
  type ResolvedElements,
} from "./request";
export {
  buildFeedbackSidecar,
  type FeedbackSidecar,
} from "./feedback-sidecar";

export function formatBridgeEventForLiveTail(event: BridgeEvent): string | null {
  switch (event.kind) {
    case "error": {
      const where = event.filename ? ` at ${event.filename}:${event.line ?? "?"}` : "";
      return `[target browser] error: ${event.message}${where}`;
    }
    case "unhandledrejection":
      return `[target browser] unhandled rejection: ${event.message}`;
    case "console":
      if (event.level === "error" || event.level === "warn") {
        return `[target browser] ${event.level}: ${event.args.join(" ")}`;
      }
      return null;
    case "network":
      if (event.error) {
        return `[target network] ${event.method} ${event.url} — failed: ${event.error}`;
      }
      // Surface non-2xx and slow requests; quiet on healthy ones.
      if (!event.ok || event.status >= 400) {
        return `[target network] ${event.method} ${event.url} — ${event.status} (${event.durationMs}ms)`;
      }
      return null;
    case "server":
      // Only error-severity server events make it to the tail; warn/info
      // stay in the ring buffer for the sidecar.
      if (event.severity === "error") {
        return `[target server] ${event.message}`;
      }
      return null;
    case "hello":
      return null;
  }
}
