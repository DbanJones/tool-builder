// Builds the per-feedback sidecar JSON (one file per Send click) that
// accompanies the rasterised PNG. Co-locates everything the agent needs to
// understand the user's marks: the iframe URL/viewport at the moment of
// send, raw mark coordinates (in image-bitmap space), and a recent slice
// of the bridge's console + error ring buffer.
//
// The bitmap-coord limitation: marks come from rasters of OS-level region
// captures (`screencapture -i` on macOS) which carry no information about
// where on screen the captured region was. We can't translate marks to
// iframe-DOM CSS pixels without that origin. The sidecar therefore reports
// raw bitmap coords + the visual screenshot; the agent reasons about both
// together. Per-mark `elementFromPoint` resolution is deferred until the
// capture path moves inside the iframe (xcap or html2canvas-via-bridge).

import type { Shape } from "@/lib/annotation";

import type { BridgeEvent } from "./index";
import type { IframeSnapshot, ResolvedElement } from "./request";

/** What the agent reads from .builder/feedback/<ts>.json. */
export interface FeedbackSidecar {
  /** ISO timestamp of when the user clicked Send. */
  ts: string;
  /** Image file path (relative to project root) that this sidecar pairs with. */
  imagePath: string | null;
  /** Free-text description from the modal's textarea (already trimmed). */
  description: string;
  /** Marks in screenshot bitmap coordinates. See module note above. */
  marks: readonly Shape[];
  /**
   * Iframe state snapshot at Send time (URL, viewport, scroll). Null when
   * the bridge wasn't available — proxy down, CSP blocked the script, or
   * no preview running.
   */
  iframe: IframeSnapshot | null;
  /**
   * Recent console events from the iframe (last `consoleLimit`). Includes
   * log/info/debug/warn/error.
   */
  console: readonly BridgeEvent[];
  /**
   * Recent runtime errors (window.error + unhandledrejection). May overlap
   * with `console` for `console.error` calls; kept separate so the agent
   * sees them clearly.
   */
  errors: readonly BridgeEvent[];
  /**
   * Recent network events observed by the bridge's fetch/XHR hooks. Useful
   * when the user's complaint is API-shaped ("the form doesn't submit",
   * "the data doesn't load").
   */
  network: readonly BridgeEvent[];
  /**
   * Recent dev-server stdout/stderr lines that classified as error or warn
   * (routine progress lines are filtered upstream in Rust).
   */
  serverErrors: readonly BridgeEvent[];
  /**
   * Whether the bridge ever announced itself (status === "connected"). When
   * false, the absence of console/error data is "we couldn't observe", not
   * "everything was fine".
   */
  bridgeConnected: boolean;
  /**
   * Where the screenshot came from: "iframe" means a bridge-rendered DOM
   * capture (marks live in iframe-CSS pixel space, can be resolved to
   * elements); "screen" means OS-level region capture (marks live in
   * bitmap pixel space, no DOM mapping). Null if no image was attached.
   */
  captureSource: "iframe" | "screen" | null;
  /**
   * Per-mark element resolution. `resolvedElements[i]` corresponds to
   * `marks[i]`. Null in two cases: (1) capture came from the screen so
   * mark coords don't map to DOM, or (2) the iframe was bridge-rendered
   * but resolveElements failed. When non-null, each entry is the element
   * the mark's centre point landed on (or null if it landed on whitespace).
   */
  resolvedElements: readonly (ResolvedElement | null)[] | null;
}

const CONSOLE_LIMIT = 50;
const ERROR_LIMIT = 20;
const NETWORK_LIMIT = 30;
const SERVER_ERROR_LIMIT = 20;

/** Pure assembly — separate from any IO so we can unit-test it cleanly. */
export function buildFeedbackSidecar(args: {
  description: string;
  marks: readonly Shape[];
  imagePath: string | null;
  iframe: IframeSnapshot | null;
  events: readonly BridgeEvent[];
  bridgeConnected: boolean;
  /** PR-4 fields — both default to null when omitted (e.g. legacy callsites). */
  captureSource?: "iframe" | "screen" | null;
  resolvedElements?: readonly (ResolvedElement | null)[] | null;
  /** Defaults to Date.now(); overridable in tests. */
  now?: number;
}): FeedbackSidecar {
  const console_ = args.events
    .filter((e) => e.kind === "console")
    .slice(-CONSOLE_LIMIT);
  const errors = args.events
    .filter((e) => e.kind === "error" || e.kind === "unhandledrejection")
    .slice(-ERROR_LIMIT);
  const network = args.events.filter((e) => e.kind === "network").slice(-NETWORK_LIMIT);
  const serverErrors = args.events
    .filter((e) => e.kind === "server")
    .slice(-SERVER_ERROR_LIMIT);
  return {
    ts: new Date(args.now ?? Date.now()).toISOString(),
    imagePath: args.imagePath,
    description: args.description,
    marks: args.marks,
    iframe: args.iframe,
    console: console_,
    errors,
    network,
    serverErrors,
    bridgeConnected: args.bridgeConnected,
    captureSource: args.captureSource ?? null,
    resolvedElements: args.resolvedElements ?? null,
  };
}
