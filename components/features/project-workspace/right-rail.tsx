"use client";

import {
  AlertTriangle,
  Bug,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Loader2,
  Maximize2,
  Minimize2,
  Pencil,
  Play,
  RotateCw,
  Sparkles,
  Square,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import type { HistoryActionEntry, TargetState } from "@/lib/build-state";
import type { TodoItem } from "@/lib/orchestrator";
import { extractDiffSnippet } from "@/lib/orchestrator/translate";
import {
  formatBridgeEventForLiveTail,
  getBridgeListener,
  type BridgeEvent,
  type BridgeSnapshot,
} from "@/lib/preview-bridge";

import type { Defect } from "@/lib/debug";
import { DebugPanel } from "./debug-panel";
import { FilePanel } from "./file-panel";
import type { IngestedFile } from "@/lib/files/types";

export interface EchoBackPreview {
  deliverable: string | null;
  anchors: string | null;
  nonNegotiables: string | null;
}

export type LaunchStatus =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "running"; url: string }
  | { kind: "error"; message: string };

// Tabbed right rail. The parent owns the active tab; this component just
// renders the strip and delegates content to the relevant panel.

// "plan" tab is now Plan + live Status (the activity tail) on one tab so
// the user never has to switch to see what's happening. "activity" was
// dropped as a standalone — its content lives at the bottom of "plan".
export type RightTab = "spec" | "plan" | "preview" | "review" | "debug" | "files";

interface RightRailProps {
  tab: RightTab;
  onTabChange: (tab: RightTab) => void;
  // Pre-build context: Spec tab is the headline. Once the build starts the
  // tabs reorder so Plan/Activity/Review come first; Spec stays accessible
  // as a read-only reference.
  hasStarted: boolean;
  // Spec
  spec: string;
  // Plan
  plan: readonly TodoItem[];
  recentHistory: TargetState["history"];
  // Activity
  actions: readonly HistoryActionEntry[];
  showTechnicalDetail: boolean;
  isRunning: boolean;
  // Preview (D-027 Slice 2 of the visual feedback feature)
  launchStatus: LaunchStatus;
  onStartPreview: () => void;
  onStopPreview: () => void;
  onCaptureAndAnnotate: () => void;
  /** Bumped by the parent on each agent edit so the iframe re-keys and
   *  reloads. Counter, not a date — monotonic is all the iframe needs. */
  previewRefreshTrigger: number;
  /** When true, the workspace has hidden the chat column to give the iframe
   *  the full window width — controlled by the parent. */
  previewMaximized: boolean;
  onTogglePreviewMaximize: () => void;
  /** Called when the novice clicks "App not working" inside the preview.
   *  The handler should drop the rendered summary into chat and kick off a
   *  fix turn. */
  onReportPreviewBroken: (summary: string) => void;
  /** Live deep-research state. When non-null, the Spec tab renders an
   *  inline progress block above the spec preview so the novice can watch
   *  findings stream in without leaving the spec context. */
  researchProgress: ResearchProgressView | null;
  // Review
  reviewMarkdown: string | null;
  reviewIsRunning: boolean;
  onBuildMissingPieces: () => void;
  echoBackPreview: EchoBackPreview;
  onSendBuildFeedback: (feedback: string) => void;
  // Debug (Phase G G6 — Flow L AC3/AC4; G7b adds rollback)
  defects: readonly Defect[];
  isDebugScanning: boolean;
  fixingDefectIds: ReadonlySet<string>;
  rollingBackDefectIds: ReadonlySet<string>;
  onDebugScanNow: () => void;
  onDebugFix: (defectId: string) => void;
  onDebugRollback: (defectId: string) => void;
  lastDebugScannedAt: number | null;
  // Files
  files: readonly IngestedFile[];
  onFilesDropped: (files: readonly IngestedFile[], rawFiles: readonly File[]) => void;
}

export function RightRail(props: RightRailProps) {
  const { tab, onTabChange, hasStarted } = props;

  const tabs: { id: RightTab; label: string; visible: boolean }[] = [
    { id: "spec", label: "Spec", visible: true },
    { id: "plan", label: "Plan & status", visible: hasStarted },
    // Preview is always available — the panel itself handles the
    // not-yet-launched state with a Start preview button. Gating on
    // hasStarted hid the tab on projects that had source code on disk
    // (e.g. recovered or re-created builds) but no session id yet.
    { id: "preview", label: "Preview", visible: true },
    { id: "review", label: "Review", visible: hasStarted && props.reviewMarkdown !== null },
    // Debug tab is visible once a build has started — defects are
    // produced by the orchestrator's target-app code, so the tab has
    // nothing to surface before that.
    { id: "debug", label: "Debug", visible: hasStarted },
    { id: "files", label: "Files", visible: true },
  ];

  // True fullscreen mode: when the preview is maximized AND the preview tab
  // is active, lift the rail out of the layout entirely with fixed
  // positioning so it covers the header, banners, footer, and chat column.
  // The preview's own toolbar remains visible (it's inside PreviewPanel) so
  // the novice can still hit Stop, Capture, or restore.
  const previewFullscreen = props.previewMaximized && tab === "preview";

  return (
    <aside
      className={
        previewFullscreen
          ? "fixed inset-0 z-50 flex min-h-0 flex-col bg-background"
          : "flex h-full min-h-0 flex-1 flex-col border-l"
      }
    >
      {previewFullscreen ? null : (
      <div className="flex shrink-0 items-stretch border-b" role="tablist" aria-label="Workspace panels">
        {tabs.filter((t) => t.visible).map((t) => {
          const active = t.id === tab;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onTabChange(t.id)}
              className={
                "flex-1 px-3 py-2 text-xs font-medium transition-colors " +
                (active
                  ? "border-b-2 border-primary text-foreground"
                  : "text-muted-foreground hover:text-foreground")
              }
            >
              {t.label}
            </button>
          );
        })}
      </div>
      )}

      <RailBody>
        {tab === "spec" && (
          <SpecPanel spec={props.spec} research={props.researchProgress} />
        )}
        {tab === "plan" && (
          <PlanAndStatusPanel
            plan={props.plan}
            recentHistory={props.recentHistory}
            actions={props.actions}
            showTechnicalDetail={props.showTechnicalDetail}
            isRunning={props.isRunning}
          />
        )}
        {tab === "preview" && (
          <PreviewPanel
            launchStatus={props.launchStatus}
            onStart={props.onStartPreview}
            onStop={props.onStopPreview}
            onCaptureAndAnnotate={props.onCaptureAndAnnotate}
            externalRefreshTrigger={props.previewRefreshTrigger}
            isMaximized={props.previewMaximized}
            onToggleMaximize={props.onTogglePreviewMaximize}
            onReportBroken={props.onReportPreviewBroken}
          />
        )}
        {tab === "review" && props.reviewMarkdown !== null && (
          <ReviewPanel
            markdown={props.reviewMarkdown}
            isRunning={props.reviewIsRunning}
            onBuildMissing={props.onBuildMissingPieces}
            echoBackPreview={props.echoBackPreview}
            onSendBuildFeedback={props.onSendBuildFeedback}
          />
        )}
        {tab === "debug" && (
          <DebugPanel
            defects={props.defects}
            isScanning={props.isDebugScanning}
            fixingDefectIds={props.fixingDefectIds}
            rollingBackDefectIds={props.rollingBackDefectIds}
            onScanNow={props.onDebugScanNow}
            onFix={props.onDebugFix}
            onRollback={props.onDebugRollback}
            lastScannedAt={props.lastDebugScannedAt}
          />
        )}
        {tab === "files" && (
          <div className="flex min-h-0 flex-1 flex-col">
            <FilePanel files={props.files} onDrop={props.onFilesDropped} />
          </div>
        )}
      </RailBody>
    </aside>
  );
}

function RailBody({ children }: { children: ReactNode }) {
  return <div className="flex min-h-0 flex-1 flex-col">{children}</div>;
}

export interface ResearchProgressView {
  /** Number of findings recorded since the run started. */
  findingsCount: number;
  /** The most recent few findings (newest last) for inline display. */
  recentFindings: ReadonlyArray<{ topic: string; body: string }>;
  /** Wall-clock ms since the run began; rendered as mm:ss. */
  elapsedMs: number;
  /** Optional cancel handler — when present, a Stop button is rendered. */
  onStop?: () => void;
}

function SpecPanel({
  spec,
  research,
}: {
  spec: string;
  research: ResearchProgressView | null;
}) {
  return (
    <>
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Spec preview</h2>
        <p className="text-xs text-muted-foreground">
          Rebuilt after each answer. Becomes read-only once the build starts. Lines marked
          <span className="mx-1 inline-flex items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
            <Sparkles className="h-2.5 w-2.5" aria-hidden="true" />
            new
          </span>
          were added by deep research.
        </p>
      </div>
      {research !== null ? <ResearchProgressBlock research={research} /> : null}
      <SpecBody spec={spec} />
    </>
  );
}

function ResearchProgressBlock({ research }: { research: ResearchProgressView }) {
  const [collapsed, setCollapsed] = useState(false);
  const minutes = Math.floor(research.elapsedMs / 60000);
  const seconds = Math.floor((research.elapsedMs % 60000) / 1000);
  const elapsed = `${minutes}:${seconds.toString().padStart(2, "0")}`;
  return (
    <div className="shrink-0 border-b bg-primary/5" aria-live="polite">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        aria-controls="research-progress-detail"
        className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-primary/10"
      >
        {collapsed ? (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
        )}
        <Loader2
          className="h-4 w-4 shrink-0 animate-spin text-primary motion-reduce:animate-none"
          aria-hidden="true"
        />
        <h3 className="flex-1 text-xs font-semibold text-primary">
          Deep research in progress
        </h3>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {elapsed} · {research.findingsCount} finding
          {research.findingsCount === 1 ? "" : "s"}
        </span>
      </button>
      {collapsed ? null : (
        <div id="research-progress-detail" className="px-4 pb-3">
          {research.recentFindings.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              Dave is reading your spec, answers, and approved files. Findings will appear here
              as they land. The proposed spec opens in a side-by-side diff when finished.
            </p>
          ) : (
            <ol className="space-y-1.5">
              {research.recentFindings.map((f, i) => (
                <li key={i} className="text-[11px] leading-relaxed">
                  <span className="font-semibold text-foreground">{f.topic}</span>
                  <span className="text-muted-foreground"> — {f.body}</span>
                </li>
              ))}
            </ol>
          )}
          {research.onStop ? (
            <button
              type="button"
              onClick={research.onStop}
              className="mt-2 inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Square className="h-3 w-3" aria-hidden="true" />
              Stop research
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

// Marker convention emitted by the deep-research v2 prompt. Lines that
// contain INLINE_MARKER (anywhere on the line) are highlighted as
// research-added. Lines bracketed by `<!-- via deep research vN -->` and
// the next sibling `<!-- /via deep research -->` (or end of section) are
// also highlighted, but for v2 we keep it simple and only key on the
// inline marker — the model is told to put the inline marker on every
// new AC / bullet, so this is enough coverage.
const RESEARCH_INLINE_MARKER = "(via deep research)";
const RESEARCH_SECTION_MARKER_PREFIX = "<!-- via deep research";

/**
 * Renders the spec markdown line-by-line, applying a highlight class to
 * any line containing the research marker. Output is a single block of
 * pre-formatted text — visually identical to the previous `<pre>` view,
 * just with per-line styling and an inline "new" chip on highlighted
 * lines.
 */
function SpecBody({ spec }: { spec: string }) {
  if (spec.trim().length === 0) {
    return (
      <pre className="flex-1 overflow-auto whitespace-pre-wrap break-words bg-muted/40 p-4 text-xs leading-relaxed">
        _(no answers recorded yet)_
      </pre>
    );
  }
  const lines = spec.split("\n");
  return (
    <div className="flex-1 overflow-auto bg-muted/40 p-4 font-mono text-xs leading-relaxed">
      {lines.map((line, i) => {
        const isResearchAdded =
          line.includes(RESEARCH_INLINE_MARKER) ||
          line.trim().startsWith(RESEARCH_SECTION_MARKER_PREFIX);
        if (isResearchAdded) {
          return (
            <div
              key={i}
              className="-mx-2 my-px rounded-sm bg-primary/10 px-2 py-0.5 text-foreground"
            >
              <Sparkles
                className="mr-1 inline-block h-2.5 w-2.5 text-primary"
                aria-hidden="true"
              />
              <span className="whitespace-pre-wrap break-words">{line}</span>
            </div>
          );
        }
        return (
          <div key={i} className="whitespace-pre-wrap break-words">
            {line.length === 0 ? " " : line}
          </div>
        );
      })}
    </div>
  );
}

// Combined Plan + live Status panel. Top half: TodoWrite plan with steps
// + completion ticks. Bottom half: live activity tail (latest tool calls)
// so the novice can see the build advance in real time without flipping
// to a separate tab. Recent commits sit at the very bottom.
// One row in the live-status list. Either an orchestrator action (from
// history.log) or a browser-side event from the preview bridge. Same shape
// for both so the renderer is uniform; `kind` keys the styling.
type LiveStatusRow =
  | {
      kind: "action";
      ts: number;
      key: string;
      primary: string;
      detail: string | null;
      diffSnippet: string | null;
    }
  | { kind: "browser"; ts: number; key: string; primary: string; severity: "error" | "warn" };

function rowsFromActions(
  actions: readonly HistoryActionEntry[],
  showTechnicalDetail: boolean,
): LiveStatusRow[] {
  return actions.map((a) => ({
    kind: "action",
    ts: a.ts,
    key: `a-${a.id}`,
    primary: a.humanLine ?? a.tool,
    detail: showTechnicalDetail ? `${a.tool} · ${a.rawInput}` : null,
    diffSnippet: extractDiffSnippet(a.tool, a.rawInput),
  }));
}

function rowsFromBridgeEvents(events: readonly BridgeEvent[]): LiveStatusRow[] {
  const out: LiveStatusRow[] = [];
  for (const [i, ev] of events.entries()) {
    const line = formatBridgeEventForLiveTail(ev);
    if (!line) continue;
    const severity: "error" | "warn" = isErrorSeverity(ev) ? "error" : "warn";
    out.push({ kind: "browser", ts: ev.ts, key: `b-${ev.ts}-${i}`, primary: line, severity });
  }
  return out;
}

function isErrorSeverity(ev: BridgeEvent): boolean {
  if (ev.kind === "error" || ev.kind === "unhandledrejection") return true;
  if (ev.kind === "console" && ev.level === "error") return true;
  if (ev.kind === "network" && (!ev.ok || ev.status >= 500 || ev.error !== null)) return true;
  if (ev.kind === "server" && ev.severity === "error") return true;
  return false;
}

function PlanAndStatusPanel({
  plan,
  recentHistory,
  actions,
  showTechnicalDetail,
  isRunning,
}: {
  plan: readonly TodoItem[];
  recentHistory: TargetState["history"];
  actions: readonly HistoryActionEntry[];
  showTechnicalDetail: boolean;
  isRunning: boolean;
}) {
  const [bridge, setBridge] = useState<BridgeSnapshot>({
    status: "absent",
    events: [],
    errorCount: 0,
  });
  useEffect(() => getBridgeListener().subscribe(setBridge), []);

  const completed = plan.filter((t) => t.status === "completed").length;
  const total = plan.length;
  // Merge orchestrator actions with browser-side bridge events into one
  // chronologically-sorted live status list. Cap at 30 entries because the
  // rail is for at-a-glance; the full history.log + bridge ring buffer are
  // available elsewhere if anyone needs more.
  const merged = [...rowsFromActions(actions, showTechnicalDetail), ...rowsFromBridgeEvents(bridge.events)];
  merged.sort((a, b) => a.ts - b.ts);
  // Newest at the bottom, auto-scrolled into view (per UX feedback). Showing
  // newest-at-top forces the novice to glance up every time something
  // happens; bottom-anchored matches what people expect from a log/console.
  const recentActions = merged.slice(-30);
  const liveTailRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = liveTailRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [recentActions.length]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b px-4 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Steps {total > 0 ? `· ${completed} / ${total}` : null}
        </h2>
        <p className="text-[11px] text-muted-foreground">
          The plan Dave is working through. Live status is below.
        </p>
      </div>
      <div className="max-h-[45%] shrink-0 overflow-auto p-4">
        {plan.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Dave will lay out the steps here as soon as the build starts.
          </p>
        ) : (
          <ol className="space-y-2 text-xs">
            {plan.map((todo, i) => (
              <li
                key={`${i}-${todo.content}`}
                className={
                  "flex items-start gap-2 " +
                  (todo.status === "completed" ? "text-muted-foreground line-through" : "")
                }
              >
                <PlanStatusIcon status={todo.status} />
                <span className="flex-1">
                  {todo.status === "in_progress" ? (
                    <span className="font-medium">{todo.activeForm}</span>
                  ) : (
                    todo.content
                  )}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col border-t">
        <div className="flex shrink-0 items-center justify-between border-b bg-muted/30 px-4 py-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Live status {actions.length > 0 ? `· ${actions.length}` : ""}
          </h3>
          {isRunning ? (
            <span className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-primary">
              <span className="relative inline-flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60 motion-reduce:hidden" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
              </span>
              live
            </span>
          ) : null}
        </div>
        <div ref={liveTailRef} className="flex-1 overflow-auto px-4 py-2 text-xs" aria-live="polite">
          {recentActions.length === 0 ? (
            <p className="text-muted-foreground">
              {isRunning
                ? "Dave is reading your spec…"
                : "Click Build it to begin. Dave reads your spec and lays out a plan."}
            </p>
          ) : (
            <ul className="space-y-1">
              {recentActions.map((row) => (
                <li key={row.key} className="flex items-baseline gap-2">
                  <time
                    dateTime={new Date(row.ts).toISOString()}
                    className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70"
                  >
                    {formatActionTime(row.ts)}
                  </time>
                  <div className="min-w-0 flex-1">
                    <div
                      className={
                        row.kind === "browser"
                          ? row.severity === "error"
                            ? "text-destructive"
                            : "text-amber-600 dark:text-amber-500"
                          : ""
                      }
                    >
                      {row.primary}
                    </div>
                    {row.kind === "action" && row.detail ? (
                      <div className="font-mono text-[10px] text-muted-foreground">{row.detail}</div>
                    ) : null}
                    {row.kind === "action" && row.diffSnippet ? (
                      <details className="mt-0.5 group">
                        <summary className="cursor-pointer select-none text-[10px] text-muted-foreground hover:text-foreground">
                          show what changed
                        </summary>
                        <pre className="mt-1 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 px-2 py-1 font-mono text-[10px] leading-relaxed">
                          {row.diffSnippet}
                        </pre>
                      </details>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {(recentHistory ?? []).length > 0 ? (
        <div className="shrink-0 border-t px-4 py-3">
          <h3 className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
            Recent commits
          </h3>
          <ul className="space-y-0.5 text-[11px]">
            {(recentHistory ?? []).slice(-5).reverse().map((h) => (
              <li key={h.task_id} className="font-mono text-muted-foreground">
                {h.task_id}
                {h.commit ? ` · ${h.commit.slice(0, 7)}` : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function PreviewPanel({
  launchStatus,
  onStart,
  onStop,
  onCaptureAndAnnotate,
  externalRefreshTrigger,
  isMaximized,
  onToggleMaximize,
  onReportBroken,
}: {
  launchStatus: LaunchStatus;
  onStart: () => void;
  onStop: () => void;
  onCaptureAndAnnotate: () => void;
  externalRefreshTrigger: number;
  isMaximized: boolean;
  onToggleMaximize: () => void;
  onReportBroken: (summary: string) => void;
}) {
  // Bumping the key remounts the iframe — cheapest way to force a reload
  // (history-preserving src=src reassignment is finicky inside Tauri's
  // webview).
  const [refreshKey, setRefreshKey] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [bridge, setBridge] = useState<BridgeSnapshot>({
    status: "absent",
    events: [],
    errorCount: 0,
  });

  // Subscribe to the bridge listener while this panel is mounted. Reset on
  // refresh / external bump so error counts reflect the current page only.
  useEffect(() => {
    const listener = getBridgeListener();
    listener.bindIframe(iframeRef.current);
    listener.reset();
    return listener.subscribe(setBridge);
  }, [refreshKey, externalRefreshTrigger, launchStatus.kind]);

  // Build a "this isn't working, please fix" message from the current bridge
  // events and hand it to the parent. We pull from the listener directly
  // (not stale `bridge` state) so a fast click captures the latest events.
  const reportBroken = (): void => {
    const events = getBridgeListener().snapshot().events;
    const lines = events
      .map((e) => formatBridgeEventForLiveTail(e))
      .filter((s): s is string => s !== null)
      .slice(-30);
    const body = lines.length === 0 ? "(no console errors captured yet)" : lines.join("\n");
    onReportBroken(`This isn't working, please fix.\n\nConsole / network from the preview:\n${body}`);
  };

  if (launchStatus.kind === "running") {
    return (
      <>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Live preview</h2>
            <p className="truncate font-mono text-[11px] text-muted-foreground" title={launchStatus.url}>
              {launchStatus.url}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {bridge.errorCount > 0 ? (
              <span
                role="status"
                aria-label={`${bridge.errorCount} runtime error${bridge.errorCount === 1 ? "" : "s"} in the preview`}
                title="Runtime errors caught by the preview bridge — see the live tail."
                className="inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 text-[11px] font-medium text-destructive"
              >
                <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                {bridge.errorCount}
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => setRefreshKey((k) => k + 1)}
              aria-label="Refresh preview"
              title="Reload the iframe"
              className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() =>
                window.open(launchStatus.url, "_blank", "noopener,noreferrer")
              }
              aria-label="Open in external browser"
              title="Open in your default browser"
              className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={onToggleMaximize}
              aria-label={isMaximized ? "Restore split view" : "Maximize preview"}
              aria-pressed={isMaximized}
              title={
                isMaximized
                  ? "Restore the chat column (ESC also restores)"
                  : "Hide the chat column to give the preview full width"
              }
              className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {isMaximized ? (
                <Minimize2 className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
              )}
            </button>
            <Button
              size="sm"
              variant="outline"
              onClick={reportBroken}
              title="Send the captured console + network errors to chat with a fix request"
            >
              <Bug className="mr-1 h-3 w-3" />
              App not working
            </Button>
            <Button size="sm" variant="outline" onClick={onCaptureAndAnnotate}>
              <Pencil className="mr-1 h-3 w-3" />
              Capture & annotate
            </Button>
            <Button size="sm" variant="outline" onClick={onStop}>
              <Square className="mr-1 h-3 w-3" />
              Stop preview
            </Button>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 bg-muted/40">
          <iframe
            key={refreshKey + externalRefreshTrigger}
            ref={iframeRef}
            src={launchStatus.url}
            title="Live preview of the target app"
            // Sandbox tokens cover the basic functioning of an SPA; the
            // critical addition over the original list is allow-pointer-lock,
            // without which any game that uses requestPointerLock (FPS-style
            // mouse capture) loads but won't initialize. allow-downloads
            // covers apps that let the novice export results.
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-pointer-lock allow-downloads allow-orientation-lock allow-presentation"
            // Permissions Policy via the `allow` attribute — distinct from
            // sandbox. Lets the framed app actually USE features it has
            // permission for (sandbox just gates whether the API exists at
            // all). Critical for canvas/WebGL games and media playback.
            allow="fullscreen; pointer-lock; autoplay; gamepad; clipboard-read; clipboard-write"
            className="h-full w-full border-0 bg-background"
          />
        </div>
        <p className="shrink-0 border-t px-4 py-1.5 text-[10px] text-muted-foreground">
          Cmd-Shift-4 to grab a region → Cmd-V into the annotate window. (Auto-capture from the iframe is a Slice 2.5 follow-up.)
        </p>
      </>
    );
  }

  if (launchStatus.kind === "starting") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
        <p>Starting the dev server…</p>
      </div>
    );
  }

  if (launchStatus.kind === "error") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-sm">
        <p className="text-destructive">Preview failed to start.</p>
        <p className="font-mono text-xs text-muted-foreground">{launchStatus.message}</p>
        <Button size="sm" variant="outline" onClick={onStart}>
          <Play className="mr-1 h-3 w-3" />
          Try again
        </Button>
      </div>
    );
  }

  // idle
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <p className="text-sm text-muted-foreground">
        See your built app live, right inside Dave-Builder.
      </p>
      <p className="text-xs text-muted-foreground">
        Click Start preview to spawn the target app's dev server. Once it's running,
        the iframe below renders it; refresh it whenever the agent lands an edit.
      </p>
      <Button size="sm" onClick={onStart}>
        <Play className="mr-1 h-3 w-3" />
        Start preview
      </Button>
    </div>
  );
}

function ReviewPanel({
  markdown,
  isRunning,
  onBuildMissing,
  echoBackPreview,
  onSendBuildFeedback,
}: {
  markdown: string;
  isRunning: boolean;
  onBuildMissing: () => void;
  echoBackPreview: EchoBackPreview;
  onSendBuildFeedback: (feedback: string) => void;
}) {
  const counts = parseReviewCounts(markdown);
  const hasGaps = (counts?.partial ?? 0) + (counts?.missing ?? 0) > 0;
  return (
    <>
      <div className="flex shrink-0 items-center justify-between border-b px-4 py-2">
        <div>
          <h2 className="text-sm font-semibold">Review against your spec</h2>
          <p className="text-[11px] text-muted-foreground">
            {counts
              ? `${counts.built} built · ${counts.partial} partial · ${counts.missing} missing`
              : "Coverage report"}
          </p>
        </div>
        {hasGaps ? (
          <Button size="sm" disabled={isRunning} onClick={onBuildMissing}>
            Build the missing pieces
          </Button>
        ) : null}
      </div>
      <div className="flex-1 overflow-auto">
        <BuildPreviewVerifier
          preview={echoBackPreview}
          isRunning={isRunning}
          onSendFeedback={onSendBuildFeedback}
        />
        <pre className="whitespace-pre-wrap break-words bg-muted/40 px-4 py-3 text-[11px] leading-relaxed">
          {markdown}
        </pre>
      </div>
    </>
  );
}

function BuildPreviewVerifier({
  preview,
  isRunning,
  onSendFeedback,
}: {
  preview: EchoBackPreview;
  isRunning: boolean;
  onSendFeedback: (feedback: string) => void;
}) {
  const [feedback, setFeedback] = useState("");
  const splitLines = (text: string): string[] =>
    text
      .split(/\r?\n/)
      .map((s) => s.trim().replace(/^[-*]\s*/, ""))
      .filter((s) => s.length > 0);
  const send = (): void => {
    const trimmed = feedback.trim();
    if (trimmed.length === 0) return;
    onSendFeedback(trimmed);
    setFeedback("");
  };
  // Hide the verifier entirely when none of the three anchor answers exist
  // — the novice has no reference point to compare against, and an empty
  // block would just be noise.
  if (
    preview.deliverable === null &&
    preview.anchors === null &&
    preview.nonNegotiables === null
  ) {
    return null;
  }
  return (
    <div className="border-b px-4 py-3 text-xs">
      <h3 className="mb-2 text-sm font-semibold">Does the build match what you pictured?</h3>
      {preview.deliverable !== null ? (
        <div className="mb-2">
          <p className="font-medium uppercase tracking-wide text-[10px] text-muted-foreground">
            You said you wanted
          </p>
          <p className="mt-0.5">{preview.deliverable}</p>
        </div>
      ) : null}
      {preview.nonNegotiables !== null ? (
        <div className="mb-2">
          <p className="font-medium uppercase tracking-wide text-[10px] text-muted-foreground">
            Non-negotiables to verify
          </p>
          <ul className="mt-0.5 list-disc pl-5">
            {splitLines(preview.nonNegotiables).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="mt-3">
        <label
          htmlFor="build-feedback"
          className="mb-1 block font-medium uppercase tracking-wide text-[10px] text-muted-foreground"
        >
          Anything missing or wrong? Tell the agent
        </label>
        <textarea
          id="build-feedback"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder="e.g. it built a web view but I asked for an Excel file"
          rows={3}
          className="w-full resize-none rounded-md border bg-background px-2 py-1.5 text-xs"
        />
        <div className="mt-1.5 flex justify-end">
          <Button
            size="sm"
            disabled={isRunning || feedback.trim().length === 0}
            onClick={send}
          >
            Send feedback
          </Button>
        </div>
      </div>
    </div>
  );
}

// Best-effort summary parser. Looks for the bullets the kickoff prompt asks
// the agent to write under "## Summary" (Built / Partial / Missing).
function parseReviewCounts(
  markdown: string,
): { built: number; partial: number; missing: number } | null {
  const built = /^- *Built: *(\d+)/m.exec(markdown);
  const partial = /^- *Partial: *(\d+)/m.exec(markdown);
  const missing = /^- *Missing: *(\d+)/m.exec(markdown);
  if (!built || !partial || !missing) return null;
  return {
    built: Number(built[1]),
    partial: Number(partial[1]),
    missing: Number(missing[1]),
  };
}

function formatActionTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function PlanStatusIcon({ status }: { status: TodoItem["status"] }) {
  if (status === "completed") {
    return (
      <span
        aria-label="completed"
        className="mt-0.5 inline-flex h-3 w-3 shrink-0 items-center justify-center rounded-full bg-green-600 text-white"
      >
        <svg className="h-2 w-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </span>
    );
  }
  if (status === "in_progress") {
    return (
      <Loader2
        aria-label="in progress"
        className="mt-0.5 h-3 w-3 shrink-0 animate-spin text-primary motion-reduce:animate-none"
      />
    );
  }
  return (
    <span
      aria-label="pending"
      className="mt-0.5 inline-block h-3 w-3 shrink-0 rounded-full border border-muted-foreground/40"
    />
  );
}
