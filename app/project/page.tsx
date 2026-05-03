"use client";

import { invoke } from "@tauri-apps/api/core";
import { listen, type Event } from "@tauri-apps/api/event";
import {
  ExternalLink,
  GitBranch,
  Globe,
  Loader2,
  Pencil,
  Play,
  Rocket,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SentryPrompt } from "@/app/components/sentry-prompt";
import {
  ChatPanel,
  type ChatStatus,
  type DisplayMessage,
} from "@/components/features/project-workspace/chat-panel";
import { AnnotationModal } from "@/components/features/annotation/annotation-modal";
import { DeployGateModal, selectUnresolvedCritical } from "@/components/features/project-workspace/deploy-gate-modal";
import { DeployModal } from "@/components/features/project-workspace/deploy-modal";
import { PlanAckModal } from "@/components/features/project-workspace/plan-ack-modal";
import { ResearchDiffModal } from "@/components/features/project-workspace/research-diff-modal";
import {
  WorkspaceActionsMenu,
  type ActionItem,
} from "@/components/features/project-workspace/actions-menu";
import { DriftBanner } from "@/components/features/project-workspace/drift-banner";
import {
  PermissionPromptBanner,
  type OpenPermissionRequest,
} from "@/components/features/project-workspace/permission-prompt-banner";
import { RightRail, type RightTab } from "@/components/features/project-workspace/right-rail";
import { ResizableSplit } from "@/components/ui/resizable-split";
import { StagesBar } from "@/components/features/project-workspace/stages-bar";
import { bytesToBase64, type Shape } from "@/lib/annotation";
import {
  buildFeedbackSidecar,
  getBridgeListener,
  requestScreenshot,
  requestSnapshot,
  resolveElements,
  type IframePoint,
  type ResolvedElement,
} from "@/lib/preview-bridge";
import { ackForIntent, detectIntent } from "@/lib/chat-intent";
import { chatSend, type ChatChunk, type QueuedQuestion } from "@/lib/chat/client";
import {
  extractLatestPlan,
  readHistoryLogTail,
  readReviewMarkdown,
  readTargetState,
  type HistoryActionEntry,
  type TargetState,
} from "@/lib/build-state";
import { renderTurnSummary, summariseTurn } from "@/lib/build-state/turn-summary";
import {
  evaluate as evaluateCostCeiling,
  readCapFromStorage,
  writeCapToStorage,
  type CostCeilingResult,
} from "@/lib/cost-ceiling";
import {
  applyDebugFix,
  listDefects,
  rollbackDebugFix,
  runDebugScan,
  type Defect,
} from "@/lib/debug";
import { deployToVercel, getVercelToken, isVercelInstalled } from "@/lib/deploy";
import { listOpenDrifts, type DriftEvent } from "@/lib/drift";
import {
  verifyDavidEasterEgg,
  type EasterEggVerifyResult,
} from "@/lib/easter-egg";
import { estimate, formatEta, type EtaResult } from "@/lib/eta";
import { exportToGithub, isGhInstalled } from "@/lib/export";
import { ingestFile } from "@/lib/files/ingest";
import { classifyByName, type IngestedFile } from "@/lib/files/types";
import type { QuestionId } from "@/lib/interview/library";
import { useOpenTabs } from "@/lib/open-tabs";
import { checkReadiness, type ReadinessResult } from "@/lib/interview/readiness";
import { rebuildSpec, type RebuildAnswer } from "@/lib/interview/rebuild-spec";
import {
  orchestratorStart,
  orchestratorStop,
  type OrchestratorEvent,
  type TodoItem,
} from "@/lib/orchestrator";
import {
  targetAppLaunch,
  targetAppStop,
  targetAppWriteLaunchScripts,
} from "@/lib/launch";
import { translate } from "@/lib/orchestrator/translate";
import {
  buildAnswersDigest,
  buildFilesDigest,
  researchStart,
  researchStop,
  type ResearchEvent,
} from "@/lib/research";
import type { Project } from "@/lib/project";
import { resetAll as resetAllSettings, resolveModel, setAllStages } from "@/lib/settings";
import { sidecarCall } from "@/lib/sidecar/client";
import { hasMadeSentryDecision } from "@/lib/telemetry";

// Unified project workspace. Replaces the old /interview + /build split:
// one chat column on the left, one tabbed right rail (Spec / Plan / Activity
// / Review / Files). Mode is derived from project state — "Build it" flips
// the rail in place rather than navigating to a different page.

const HISTORY_TAIL_LIMIT = 200;

// HTML-comment marker prepended to spec.md when the novice adopts a
// deep-research proposal. Detected on every Build click so the
// deterministic rebuild from answers doesn't silently overwrite the
// adopted spec. Renders invisibly when spec.md is rendered as
// markdown — humans don't see it, but the build path does.
const SPEC_RESEARCH_ADOPTED_MARKER =
  "<!-- dave: spec adopted from deep research; do not auto-rebuild -->";

interface AnswerRow {
  id: string;
  projectId: string;
  questionId: string;
  answerText: string;
  confidence: "confident" | "tentative" | "default-applied";
  source: "chat" | "file" | "default";
  rationale: string | null;
  createdAt: number;
}

interface CostSum {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  usdCents: number;
}

type Status =
  | { kind: "idle" }
  | { kind: "streaming" }
  | { kind: "running" }
  | { kind: "rate_limited"; message: string }
  | { kind: "error"; message: string };

const rowToRebuildAnswer = (row: AnswerRow): RebuildAnswer => ({
  questionId: row.questionId as QuestionId,
  answerText: row.answerText,
  confidence: row.confidence,
  source: row.source,
  rationale: row.rationale,
});

function appendApprovedSourceMaterials(
  specMarkdown: string,
  files: readonly IngestedFile[],
  approvedFileIds: ReadonlySet<string>,
): string {
  const approved = files.filter((f) => approvedFileIds.has(f.id) && f.summary);
  if (approved.length === 0) return specMarkdown;
  const lines = [
    "## 0. Source materials",
    "",
    ...approved.flatMap((f) => [
      `- **${f.name}** (${f.kind}${f.hasPiiWarning ? ", PII warning reviewed" : ""})`,
      `  ${f.summary!.replace(/\s+/g, " ").trim().slice(0, 900)}`,
    ]),
    "",
  ];
  return `${lines.join("\n")}\n${specMarkdown}`;
}

function formatFailedEasterEggFindings(report: EasterEggVerifyResult): string {
  const failed = report.findings
    .filter((finding) => !finding.ok)
    .map((finding) => finding.message);
  return failed.length > 0
    ? failed.join(" ")
    : "The verifier could not confirm the required source markers.";
}

export default function ProjectPage() {
  return (
    <Suspense
      fallback={
        <main className="flex h-full items-center justify-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading project…
        </main>
      }
    >
      <ProjectPageInner />
    </Suspense>
  );
}

function ProjectPageInner() {
  const params = useSearchParams();
  const projectId = params.get("id");
  return <ProjectWorkspace projectId={projectId} />;
}

function ProjectWorkspace({ projectId }: { projectId: string | null }) {
  // Project + load
  const [project, setProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [recoveredFromCrash, setRecoveredFromCrash] = useState(false);
  const [recoveredBannerDismissed, setRecoveredBannerDismissed] = useState(false);
  const [reviewBannerDismissed, setReviewBannerDismissed] = useState(false);

  // Chat scrollback (unified; interview turns + build turns share the column).
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  // Spec / readiness / interview pipeline
  const [spec, setSpec] = useState<string>("");
  const [readiness, setReadiness] = useState<ReadinessResult>(() => checkReadiness([]));
  const [echoBackConfirmed, setEchoBackConfirmed] = useState(false);
  const [questionQueue, setQuestionQueue] = useState<readonly QueuedQuestion[]>([]);
  const [bufferedAnswers, setBufferedAnswers] = useState<
    readonly { id: string; text: string; question: string }[]
  >([]);
  const [isPreparingBank, setIsPreparingBank] = useState(false);
  const [echoBackPreview, setEchoBackPreview] = useState<{
    deliverable: string | null;
    anchors: string | null;
    nonNegotiables: string | null;
  }>({ deliverable: null, anchors: null, nonNegotiables: null });
  const interviewSessionRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Files (drag-drop ingest)
  const [files, setFiles] = useState<readonly IngestedFile[]>([]);
  const [approvedFileIds, setApprovedFileIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [pendingFileApprovals, setPendingFileApprovals] = useState<
    readonly { fileId: string; name: string; summary: string; hasPiiWarning: boolean }[]
  >([]);

  // Build orchestrator state
  const [targetState, setTargetState] = useState<TargetState | null>(null);
  const [actions, setActions] = useState<readonly HistoryActionEntry[]>([]);
  // Mirror of `actions` so the orchestrator event handler (memoised with
  // a narrow dep list to avoid churn) can read the latest list inside its
  // `done` branch when computing the turn summary. Without this, the
  // closure captures whatever `actions` was at memo time — usually empty.
  const actionsRef = useRef<readonly HistoryActionEntry[]>([]);
  useEffect(() => {
    actionsRef.current = actions;
  }, [actions]);
  const [plan, setPlan] = useState<readonly TodoItem[]>([]);
  const [latestToolLine, setLatestToolLine] = useState<string | null>(null);
  const [costSum, setCostSum] = useState<CostSum | null>(null);
  const [openDrifts, setOpenDrifts] = useState<readonly DriftEvent[]>([]);
  const [openPermissions, setOpenPermissions] = useState<readonly OpenPermissionRequest[]>([]);
  const [reviewMarkdown, setReviewMarkdown] = useState<string | null>(null);
  // Details (deploy/push buttons + technical activity log + footer extras)
  // are always visible per user request — they're not a power-user surface
  // worth a hide-toggle, just useful info.
  const showDetails = true;
  const [showSentryPrompt, setShowSentryPrompt] = useState(false);
  const [costCap, setCostCap] = useState<number | null>(null);
  const [turnDurations, setTurnDurations] = useState<readonly number[]>([]);
  const turnStartRef = useRef<number | null>(null);
  const buildSessionRef = useRef<string | null>(null);

  // Concurrent build prompt: when starting a build with another project
  // already mid-build, ask the user whether to run alongside, stop the
  // others first, or cancel. null = no prompt; non-null = list of conflicts.
  const [concurrentBuildPrompt, setConcurrentBuildPrompt] = useState<{
    conflicts: { id: string; name: string }[];
  } | null>(null);

  // Visual feedback modal (D-026 Slice 1). Opening it pauses the in-flight
  // build (if any) so the agent doesn't keep generating against state the
  // novice has just decided is wrong. Closing without sending leaves the
  // build paused — user resumes via the normal Build button.
  const [annotationOpen, setAnnotationOpen] = useState(false);
  const [annotationInitialImage, setAnnotationInitialImage] = useState<Blob | null>(null);
  // Tracks where the modal's image came from. "iframe" means the bytes were
  // rendered by the bridge from the live DOM, so mark coordinates land in
  // iframe-CSS pixel space and resolveElements() will give meaningful answers.
  // "screen" means screencapture-i produced the bytes; marks live in
  // screenshot-bitmap space with no DOM mapping (PR-2's known limitation).
  const [annotationCaptureSource, setAnnotationCaptureSource] =
    useState<"iframe" | "screen" | null>(null);
  // Pre-build plan ack modal (PR-5 of D-031). Only fires for the first build
  // of a session; correction-mode rebuilds skip the gate to avoid friction.
  const [planAckOpen, setPlanAckOpen] = useState(false);

  // Flow M (deep-research). Three discriminator states track the modal flow:
  // - "idle"      : nothing in progress
  // - "running"   : sidecar SDK session is open; spec tab shows progress
  // - "review"    : proposal arrived; diff modal is open
  type ResearchFinding = { topic: string; body: string };
  type ResearchUiState =
    | { kind: "idle" }
    | {
        kind: "running";
        streamId: string | null;
        findings: ResearchFinding[];
        startedAt: number;
      }
    | {
        kind: "review";
        originalSpec: string;
        proposedMarkdown: string;
        summaryOfChanges: string;
        partial: boolean;
        costUsdCents: number;
      };
  const [researchUi, setResearchUi] = useState<ResearchUiState>({ kind: "idle" });
  const researchStreamIdRef = useRef<string | null>(null);
  // Re-render once a second while research is running so the elapsed-time
  // counter in the progress block ticks. Cheap; 1Hz only while active.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (researchUi.kind !== "running") return;
    const id = window.setInterval(() => forceTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [researchUi.kind]);

  // Counter the Preview tab uses as part of its iframe key. Bumped when the
  // agent emits a file-mutating tool_use (Edit/Write/MultiEdit/NotebookEdit)
  // so the iframe reloads as soon as the dev server picks up the change.
  // D-028.
  const [previewRefreshTrigger, setPreviewRefreshTrigger] = useState(0);

  // Maximize-preview: hides the chat column and gives the iframe the full
  // workspace width. Auto-restores when switching off the preview tab so
  // a maximized rail can't strand the user without their chat. ESC also
  // restores. D-028 follow-up.
  const [previewMaximized, setPreviewMaximized] = useState(false);

  // Right-rail width (resizable splitter between chat and rail). Single
  // value across projects — matches the cost-cap pattern. Read once on
  // mount so SSR doesn't see a different value than the client.
  const RIGHT_RAIL_WIDTH_KEY = "dave-builder.right-rail.width";
  const RIGHT_RAIL_WIDTH_DEFAULT = 400;
  const [rightRailWidth, setRightRailWidth] = useState<number>(RIGHT_RAIL_WIDTH_DEFAULT);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(RIGHT_RAIL_WIDTH_KEY);
      const parsed = raw === null ? null : Number.parseInt(raw, 10);
      if (parsed !== null && Number.isFinite(parsed) && parsed >= 280 && parsed <= 800) {
        setRightRailWidth(parsed);
      }
    } catch {
      /* localStorage unavailable — use default */
    }
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem(RIGHT_RAIL_WIDTH_KEY, String(rightRailWidth));
    } catch {
      /* ignore */
    }
  }, [rightRailWidth]);

  // Debug module (Phase G G6 — Flow L AC2-AC6). On-demand scan only at
  // v1; no polling loop. The handler runs every Layer 1 detector and
  // optionally the Layer 2 validator (validate flag is off here for
  // latency — Debug now should feel responsive; the phase-boundary
  // scan in Flow L AC1 will set validate=true once that wiring lands).
  const [defects, setDefects] = useState<readonly Defect[]>([]);
  const [isDebugScanning, setIsDebugScanning] = useState(false);
  const [fixingDefectIds, setFixingDefectIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [rollingBackDefectIds, setRollingBackDefectIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [lastDebugScannedAt, setLastDebugScannedAt] = useState<number | null>(null);

  // Appends an assistant turn to the chat scrollback + persists it to the
  // chat_messages table. Defined here (before the debug callbacks below)
  // so runDebugFix can drop a "what was edited" summary on success.
  // The canonical definition; later code references this same const.
  const appendAssistantMessage = useCallback(
    (text: string): void => {
      if (!project) return;
      setMessages((prev) => [...prev, { role: "assistant" as const, text }]);
      void sidecarCall("chatMessages.append", {
        projectId: project.id,
        role: "assistant",
        text,
      });
    },
    [project],
  );

  const runDebugScanNow = useCallback(async () => {
    if (!project) return;
    setIsDebugScanning(true);
    // Live-tail entry so the novice sees the scan in the status rail
    // alongside everything else, not just on the Debug panel button.
    // Three checkpoints: start, finish, summary of top findings.
    const started = Date.now();
    const tailLog = (
      severity: "info" | "warn" | "error",
      message: string,
    ): void => {
      getBridgeListener().pushServerEvent({
        kind: "server",
        source: "stdout",
        severity,
        message: `[debug] ${message}`.slice(0, 400),
        ts: Date.now(),
      });
    };
    tailLog(
      "info",
      "Scan starting — Layer 1 detectors (tsc, hallucinated imports, secrets, RLS, client-side auth, env-leak, slopsquat). Typically ~5s.",
    );
    try {
      const scan = await runDebugScan({ projectId: project.id });
      if (scan.isErr()) {
        tailLog("error", `Scan failed: ${scan.error.message}`);
        // eslint-disable-next-line no-console
        console.error("debug.scan failed:", scan.error.message);
        return;
      }
      const elapsed = Date.now() - started;
      const findingCount = scan.value.findingCount;
      tailLog(
        findingCount > 0 ? "warn" : "info",
        `Scan complete in ${(elapsed / 1000).toFixed(1)}s — ${findingCount} finding${findingCount === 1 ? "" : "s"}.`,
      );
      const list = await listDefects({ projectId: project.id });
      if (list.isErr()) {
        tailLog("error", `Couldn't load defects: ${list.error.message}`);
        // eslint-disable-next-line no-console
        console.error("debug.list failed:", list.error.message);
        return;
      }
      setDefects(list.value);
      setLastDebugScannedAt(Date.now());
      // Surface the top 3 findings (by priority, already ranked by the
      // scan) so the novice sees what to act on without flipping to
      // the Defects sub-tab.
      const topByPriority = [...list.value]
        .sort((a, b) => b.priority - a.priority)
        .slice(0, 3);
      for (const d of topByPriority) {
        tailLog(
          d.band === "critical" || d.band === "high" ? "error" : "warn",
          `${d.band.toUpperCase()} · ${d.ruleId} · ${d.file}:${d.lineStart} — ${d.humanExplanation.slice(0, 140)}`,
        );
      }
      if (list.value.length > topByPriority.length) {
        tailLog(
          "info",
          `+${list.value.length - topByPriority.length} more in the Defects sub-tab.`,
        );
      }
    } finally {
      setIsDebugScanning(false);
    }
  }, [project]);

  const runDebugFix = useCallback(
    async (defectId: string) => {
      if (!project) return;
      setFixingDefectIds((prev) => {
        const next = new Set(prev);
        next.add(defectId);
        return next;
      });
      try {
        const result = await applyDebugFix({
          defectId,
          model: resolveModel("repair"),
        });
        if (result.isErr()) {
          // eslint-disable-next-line no-console
          console.error("debug.applyFix failed:", result.error.message);
          return;
        }
        // Refresh the list so status updates land on the card.
        const list = await listDefects({ projectId: project.id });
        if (list.isOk()) setDefects(list.value);
        // Drop a "what was edited" summary into the chat, mirroring the
        // build-turn-done hook. The repair handler returns the canonical
        // list of files it touched; rendering through the same helper
        // keeps the format consistent.
        const fix = result.value;
        const fileList = fix.files;
        if (fileList.length > 0) {
          const synthetic = renderTurnSummary(
            {
              filesEdited: fileList,
              filesWritten: [],
              bashCount: 0,
              testCount: 0,
              totalActions: fileList.length,
            },
            "repair",
          );
          if (synthetic.length > 0) {
            const outcomeNote =
              fix.outcome === "applied"
                ? " ✅"
                : fix.outcome === "syntax_check_failed"
                  ? " ⚠️ (verifier rejected — patch reverted)"
                  : "";
            appendAssistantMessage(`${synthetic}${outcomeNote}`);
          }
        }
      } finally {
        setFixingDefectIds((prev) => {
          const next = new Set(prev);
          next.delete(defectId);
          return next;
        });
      }
    },
    [project, appendAssistantMessage],
  );

  const runDebugRollback = useCallback(
    async (defectId: string) => {
      if (!project) return;
      setRollingBackDefectIds((prev) => {
        const next = new Set(prev);
        next.add(defectId);
        return next;
      });
      try {
        const result = await rollbackDebugFix({ defectId });
        if (result.isErr()) {
          // eslint-disable-next-line no-console
          console.error("debug.rollbackFix failed:", result.error.message);
          return;
        }
        const list = await listDefects({ projectId: project.id });
        if (list.isOk()) setDefects(list.value);
      } finally {
        setRollingBackDefectIds((prev) => {
          const next = new Set(prev);
          next.delete(defectId);
          return next;
        });
      }
    },
    [project],
  );

  // Deploy gate (Flow L AC8): when the user clicks Deploy and there
  // are unresolved critical-band defects, intercept with a typed-
  // confirmation modal. Once the user types the phrase + confirms, we
  // mark the gate bypassed and proceed; the bypass is per-deploy-attempt
  // (clears on completion / cancel / page navigation).
  const [deployGateOpen, setDeployGateOpen] = useState(false);
  const [deployGateBypassed, setDeployGateBypassed] = useState(false);

  // Deploy / GitHub export
  const [deployModalOpen, setDeployModalOpen] = useState(false);
  const [deployStatus, setDeployStatus] = useState<
    | { kind: "idle" }
    | { kind: "running" }
    | { kind: "success"; url: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [exportStatus, setExportStatus] = useState<
    | { kind: "idle" }
    | { kind: "running" }
    | { kind: "success"; url: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  // Local "Launch app" state (CLAUDE.md O33). Independent from build/deploy:
  // launching just starts the target app's dev server in a child process.
  const [launchStatus, setLaunchStatus] = useState<
    | { kind: "idle" }
    | { kind: "starting" }
    | { kind: "running"; url: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  // Tab state — auto-switches as mode changes; user can override.
  const [tab, setTab] = useState<RightTab>("spec");
  const tabPinnedRef = useRef(false);

  // Pin the current project as a visible tab in the strip. The strip
  // shows opened-only projects, not every project in the DB; without this
  // call a project visited via deep link wouldn't get a tab.
  const { ensureOpen: ensureTabOpen } = useOpenTabs();

  // Has the build started? Derived from session id OR prior actions on disk.
  // Once true for a session, doesn't flip back; lets a reload of a paused
  // project pick up in build mode.
  const hasStarted =
    buildSessionRef.current !== null || actions.length > 0 || plan.length > 0;

  // Stage-transition acks. Refs (not state) so re-renders don't fire the
  // announcement again, and we seed them on the next-effect tick from any
  // sentinel substring already in the rehydrated scrollback so a reload
  // mid-build doesn't replay every prompt.
  const announcedReadyRef = useRef(false);
  const announcedReviewRef = useRef(false);
  const announcedDeployedRef = useRef(false);
  const announcedPushedRef = useRef(false);
  // Phase G G7 follow-up #4 / Flow L AC1: auto-trigger a Debug scan at
  // the first-pass phase boundary (when review.md appears on disk so
  // the novice sees fresh defects in the Debug rail before deciding
  // what to do next). Once-per-session — the user can re-run via Scan
  // now if they want a fresh pass after iterating.
  const autoScannedAtPhaseBoundaryRef = useRef(false);
  // Auto-load the preview at the phase boundary so a broken build is caught
  // before the novice has to click around looking for it. One-shot per
  // session: clicking Stop preview / Launch app / re-running the build
  // resets the user-controlled launchStatus and the next phase boundary
  // re-arms naturally because review.md re-writes only on a fresh build.
  const autoPreviewLoadAttemptedRef = useRef(false);
  // Build's `done` event fires every time a turn ends. If Claude finished
  // the build without writing review.md (forgot, stopped early), prompt
  // exactly once per session so the novice always gets a coverage report.
  const autoReviewAttemptedRef = useRef(false);
  const runFollowUpTurnRef = useRef<((prompt: string) => void) | null>(null);
  const davidRepairAttemptedRef = useRef(false);
  const davidVerifiedRef = useRef(false);
  const davidFailureAnnouncedRef = useRef(false);

  // ---- Project load + hydration ------------------------------------------
  useEffect(() => {
    if (!projectId) {
      setLoadError("No project selected. Open one from the Welcome screen.");
      return;
    }
    let cancelled = false;
    void (async () => {
      // 8s defensive timeout: if the sidecar bridge is wedged the page
      // would otherwise sit on "Loading project…" forever. Surfacing a
      // clear error tells the user to restart instead of staring at a
      // spinner. Normal `projects.get` returns in well under 100ms.
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("RPC_TIMEOUT")), 8000),
      );
      const r = await Promise.race([
        sidecarCall<Project | null>("projects.get", { id: projectId }),
        timeoutPromise,
      ]).catch((e: unknown) => {
        // eslint-disable-next-line no-console
        console.error("[ProjectWorkspace] projects.get failed:", e);
        return e instanceof Error && e.message === "RPC_TIMEOUT"
          ? ({ kind: "timeout" } as const)
          : ({ kind: "throw", error: e } as const);
      });
      if (cancelled) return;
      // Non-Result branches (timeout / thrown) hit the load-error path.
      if ("kind" in r && (r.kind === "timeout" || r.kind === "throw")) {
        setLoadError(
          r.kind === "timeout"
            ? "Sidecar didn't respond after 8s. Restart the Builder (close the window and re-launch)."
            : `Couldn't load project: ${r.error instanceof Error ? r.error.message : String(r.error)}`,
        );
        return;
      }
      r.match(
        (p) => {
          if (p === null) {
            setLoadError(`Project ${projectId} not found.`);
            return;
          }
          setProject(p);
          ensureTabOpen({ id: p.id, name: p.name });
          buildSessionRef.current = p.currentSessionId;
          // Crash recovery: a "building" status on cold open means the prior
          // process died mid-turn. Park as paused so the next click is
          // deliberate.
          if (p.status === "building") {
            setRecoveredFromCrash(true);
            void sidecarCall<Project>("projects.setStatus", {
              id: p.id,
              status: "paused",
            });
          }
          void hydrate(p.id, p.path);
        },
        (e) => setLoadError(e.message),
      );
    })();

    async function hydrate(pid: string, projectPath: string): Promise<void> {
      const stateResult = await readTargetState(projectPath);
      if (cancelled) return;
      stateResult.match(
        (s) => setTargetState(s),
        () => {
          /* non-fatal */
        },
      );

      const tailResult = await readHistoryLogTail(projectPath, HISTORY_TAIL_LIMIT);
      if (cancelled) return;
      tailResult.match(
        (entries) => {
          setActions(entries);
          // Hydrate the Plan tab from the last TodoWrite call recorded in
          // history.log. Without this the plan stays empty after a cold
          // open / Resume until the agent emits its next TodoWrite, which
          // can be 30+ seconds and looks broken to the novice.
          const plan = extractLatestPlan(entries);
          if (plan.length > 0) setPlan(plan);
        },
        () => {
          /* non-fatal */
        },
      );

      const costResult = await sidecarCall<CostSum>("costs.sumByProject", { projectId: pid });
      if (cancelled) return;
      costResult.match(
        (sum) => setCostSum(sum),
        () => undefined,
      );

      const driftResult = await listOpenDrifts(pid);
      if (cancelled) return;
      driftResult.match(
        (events) => setOpenDrifts(events),
        () => undefined,
      );

      const reviewResult = await readReviewMarkdown(projectPath);
      if (cancelled) return;
      reviewResult.match(
        (md) => setReviewMarkdown(md),
        () => undefined,
      );
    }

    return () => {
      cancelled = true;
    };
  }, [projectId, ensureTabOpen]);

  // Pull spec from answers and rebuild the preview. EXCEPT when the
  // project's on-disk spec.md is research-adopted (carries the v2
  // marker `(via deep research)`) — in that case the on-disk file is
  // the source of truth, and rebuildSpec(answers) would silently
  // throw away the additions. Prefer disk; fall back to rebuild.
  const refreshSpec = useCallback(async (): Promise<void> => {
    if (!projectId || !project) return;
    let researchSpec: string | null = null;
    try {
      const onDisk = await invoke<string | null>("read_target_spec", {
        projectPath: project.path,
      });
      if (onDisk !== null && onDisk.includes("(via deep research)")) {
        researchSpec = onDisk;
      }
    } catch (e) {
      console.warn("read_target_spec failed during refreshSpec:", e);
    }
    const r = await sidecarCall<AnswerRow[]>("answers.list", { projectId });
    r.match(
      (rows) => {
        const rebuildAnswers = rows.map(rowToRebuildAnswer);
        try {
          setSpec(
            researchSpec ??
              appendApprovedSourceMaterials(
                rebuildSpec(rebuildAnswers),
                files,
                approvedFileIds,
              ),
          );
        } catch (e) {
          setSpec(`# Spec preview error\n\n${e instanceof Error ? e.message : String(e)}`);
        }
        // Auto-confirm the readiness echo-back the moment the fast-path is
        // complete. The user opted out of the explicit final-check popup; the
        // spec preview + the post-build "verify against spec" panel cover the
        // same anti-drift function without an extra interruption.
        const result = checkReadiness(rebuildAnswers, { echoBackConfirmed: true });
        if (
          !echoBackConfirmed &&
          result.fastPathTotal > 0 &&
          result.fastPathAnswered >= result.fastPathTotal
        ) {
          setEchoBackConfirmed(true);
        }
        setReadiness(result);
        const findAnswerText = (id: "Q33" | "Q34" | "Q35"): string | null => {
          const match = rebuildAnswers.find((a) => a.questionId === id);
          const text = match?.answerText.trim();
          return text && text.length > 0 ? text : null;
        };
        setEchoBackPreview({
          deliverable: findAnswerText("Q33"),
          anchors: findAnswerText("Q34"),
          nonNegotiables: findAnswerText("Q35"),
        });
      },
      () => undefined,
    );
  }, [projectId, project, echoBackConfirmed, files, approvedFileIds]);

  useEffect(() => {
    if (project) void refreshSpec();
  }, [project, refreshSpec]);

  useEffect(() => {
    if (!project || typeof window === "undefined") return;
    setEchoBackConfirmed(
      window.localStorage.getItem(`builder.echoBackConfirmed.${project.id}`) === "true",
    );
  }, [project]);

  useEffect(() => {
    if (!project || typeof window === "undefined") return;
    window.localStorage.setItem(
      `builder.echoBackConfirmed.${project.id}`,
      String(echoBackConfirmed),
    );
  }, [project, echoBackConfirmed]);

  // Rehydrate chat scrollback so a reload mid-session doesn't show empty.
  useEffect(() => {
    if (!project) return;
    void (async () => {
      const r = await sidecarCall<Array<{ role: "user" | "assistant"; text: string }>>(
        "chatMessages.list",
        { projectId: project.id },
      );
      r.match(
        (rows) => {
          if (rows.length > 0) setMessages(rows.map((row) => ({ role: row.role, text: row.text })));
        },
        () => undefined,
      );
    })();
  }, [project]);

  // Helper: append + persist an assistant-style message (used by the chat
  // intent dispatcher, the build event handlers, and the stage-transition
  // acks below).
  // Stage-transition phrases. Each is the leading sentinel substring of
  // the corresponding ack — used both to write the message and to detect
  // (on rehydrate) that we already announced this stage in a prior session.
  const STAGE_SENTINELS = {
    ready: "Got everything I need to build this.",
    review: "First-pass build done",
    deployed: "Preview live at",
    pushed: "Pushed to GitHub at",
  } as const;

  // Seed announced refs from rehydrated scrollback so a page reload after a
  // stage already passed doesn't replay the prompt. Effect is idempotent —
  // refs only flip false → true, never the reverse.
  useEffect(() => {
    if (messages.some((m) => m.role === "assistant" && m.text.includes(STAGE_SENTINELS.ready))) {
      announcedReadyRef.current = true;
    }
    if (messages.some((m) => m.role === "assistant" && m.text.includes(STAGE_SENTINELS.review))) {
      announcedReviewRef.current = true;
    }
    if (
      messages.some((m) => m.role === "assistant" && m.text.includes(STAGE_SENTINELS.deployed))
    ) {
      announcedDeployedRef.current = true;
    }
    if (messages.some((m) => m.role === "assistant" && m.text.includes(STAGE_SENTINELS.pushed))) {
      announcedPushedRef.current = true;
    }
  }, [messages, STAGE_SENTINELS.deployed, STAGE_SENTINELS.pushed, STAGE_SENTINELS.ready, STAGE_SENTINELS.review]);

  // Stage 1: interview "ready" — every fast-path question has an answer
  // and the user hasn't kicked off the build yet. Suggests the next move.
  useEffect(() => {
    if (announcedReadyRef.current) return;
    if (hasStarted) return;
    if (readiness.fastPathTotal === 0) return;
    if (readiness.fastPathAnswered < readiness.fastPathTotal) return;
    announcedReadyRef.current = true;
    appendAssistantMessage(
      `${STAGE_SENTINELS.ready} Review the final check above the chat, then confirm it when it looks right. After that, say **"build it"** and I'll start.\n\nOptional: say **"deep research"** first and I'll spend 2-5 minutes (roughly $1-3) thinking through competitors, edge cases, and data-model gaps, then propose an expanded spec for you to review side-by-side. Your original spec is preserved either way.`,
    );
  }, [
    readiness.fastPathAnswered,
    readiness.fastPathTotal,
    hasStarted,
    appendAssistantMessage,
    STAGE_SENTINELS.ready,
  ]);

  // Poll permission requests while a build session exists. 1s cadence.
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    const tick = async (): Promise<void> => {
      const r = await sidecarCall<OpenPermissionRequest[]>("permissionRequests.listOpen", {
        projectId: project.id,
      });
      if (cancelled) return;
      r.match(
        (rows) => setOpenPermissions(rows),
        () => undefined,
      );
    };
    void tick();
    const handle = setInterval(() => void tick(), 1000);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [project]);

  // Cost cap localStorage roundtrip.
  useEffect(() => {
    if (project) setCostCap(readCapFromStorage(project.id));
  }, [project]);
  useEffect(() => {
    if (project) writeCapToStorage(project.id, costCap);
  }, [project, costCap]);

  const ceiling: CostCeilingResult = evaluateCostCeiling(costSum?.usdCents ?? 0, costCap);

  // ---- Auto-switch tab as mode evolves -----------------------------------
  useEffect(() => {
    if (tabPinnedRef.current) return;
    if (!hasStarted) {
      setTab("spec");
      return;
    }
    if (reviewMarkdown !== null) {
      setTab("review");
      return;
    }
    setTab("plan");
  }, [hasStarted, reviewMarkdown]);

  const onTabChange = (t: RightTab): void => {
    tabPinnedRef.current = true;
    // Auto-restore preview maximize when leaving the preview tab — the
    // chat column shouldn't stay hidden when the user has switched away
    // from the thing that hid it.
    if (t !== "preview" && previewMaximized) setPreviewMaximized(false);
    setTab(t);
  };

  // ESC restores from maximized preview. Only attaches the listener when
  // maximized to avoid a global listener churn on every render.
  useEffect(() => {
    if (!previewMaximized) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setPreviewMaximized(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewMaximized]);

  // Subscribe to dev-server stdout/stderr events emitted by launch.rs
  // (PR-3 of D-031). Lines that look like errors / warnings get pushed
  // into the bridge listener so they merge into the live tail next to
  // browser-side bridge events. Routine progress lines are filtered in
  // Rust and never reach us.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void (async () => {
      const off = await listen("target-server-event", (event: Event<unknown>) => {
        const payload = event.payload as Record<string, unknown> | null;
        if (!payload) return;
        const severity = payload.severity;
        if (severity !== "error" && severity !== "warn" && severity !== "info") return;
        const message = typeof payload.message === "string" ? payload.message : "";
        const source = typeof payload.source === "string" ? payload.source : "stdout";
        const ts = typeof payload.ts === "number" ? payload.ts : Date.now();
        getBridgeListener().pushServerEvent({
          kind: "server",
          source,
          severity,
          message,
          ts,
        });
      });
      unlisten = off;
    })();
    return () => {
      unlisten?.();
    };
  }, []);

  // ---- Interview chat (pre-build) ----------------------------------------
  const handleChunk = (chunk: ChatChunk): void => {
    switch (chunk.kind) {
      case "session":
        interviewSessionRef.current = chunk.id;
        return;
      case "assistant_delta":
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant") {
            return [...prev.slice(0, -1), { role: "assistant", text: last.text + chunk.text }];
          }
          return [...prev, { role: "assistant", text: chunk.text }];
        });
        return;
      case "questions_queued":
        setQuestionQueue((prev) => [...prev, ...chunk.items]);
        setIsPreparingBank(false);
        return;
      case "done":
        setStatus({ kind: "idle" });
        setIsPreparingBank(false);
        void refreshSpec();
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (project && last?.role === "assistant" && last.text.trim().length > 0) {
            void sidecarCall("chatMessages.append", {
              projectId: project.id,
              role: "assistant",
              text: last.text,
            });
          }
          return prev;
        });
        return;
      case "rate_limit":
        setStatus({ kind: "rate_limited", message: chunk.message });
        return;
      case "error":
        setStatus({ kind: "error", message: chunk.message });
        return;
    }
  };

  // Expand any @filename mentions in the user's text into a structured
  // context block so claude sees the file's summary even though the chat
  // path doesn't have filesystem-read tools. The literal @filename stays
  // in the user-visible scrollback (it's just text); the context block is
  // appended after the user's message in the prompt sent to the SDK.
  const expandMentions = useCallback(
    (text: string): string => {
      const matches = Array.from(text.matchAll(/(?:^|\s)@([^\s]+)/g));
      if (matches.length === 0) return text;
      const seen = new Set<string>();
      const blocks: string[] = [];
      for (const m of matches) {
        const name = m[1];
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const file = files.find((f) => f.name === name);
        if (!file) continue;
        const summary = file.summary
          ? file.summary.slice(0, 600)
          : `(file present in inputs/, status: ${file.status}; no summary yet)`;
        blocks.push(`File: ${name} (${file.kind})\n${summary}`);
      }
      if (blocks.length === 0) return text;
      return `${text}\n\n[Files referenced:]\n${blocks.join("\n\n")}`;
    },
    [files],
  );

  const sendInterview = async (text: string): Promise<void> => {
    if (!project) return;
    if (!hasStarted && echoBackConfirmed) setEchoBackConfirmed(false);
    const isFirstTurn = interviewSessionRef.current === null;
    setStatus({ kind: "streaming" });
    if (isFirstTurn) setIsPreparingBank(true);
    const r = await chatSend({
      prompt: expandMentions(text),
      sessionId: interviewSessionRef.current,
      projectId: project.id,
      projectPath: project.path,
      model: resolveModel(isFirstTurn ? "interview_first_turn" : "interview_resume"),
      onChunk: handleChunk,
    });
    r.match(
      () => {
        setStatus((prev) => (prev.kind === "streaming" ? { kind: "idle" } : prev));
        setIsPreparingBank(false);
      },
      (e) => {
        setStatus({ kind: "error", message: e.message });
        setIsPreparingBank(false);
      },
    );
  };

  const flushingRef = useRef(false);
  const flushBuffer = async (
    buffer: readonly { id: string; text: string; question: string }[],
  ): Promise<void> => {
    if (buffer.length === 0 || flushingRef.current) return;
    flushingRef.current = true;
    const compiled = buffer
      .map((b, i) => `${i + 1}) ${b.id}: ${b.text} — (you asked: "${b.question}")`)
      .join("\n");
    setBufferedAnswers([]);
    try {
      await sendInterview(compiled);
    } finally {
      flushingRef.current = false;
    }
  };

  const submitAnswerForHead = (answerText: string): void => {
    const head = questionQueue[0];
    if (!head || !project) return;
    const trimmed = answerText.trim();
    if (trimmed.length === 0) return;
    if (!hasStarted && echoBackConfirmed) setEchoBackConfirmed(false);
    const entry = { id: head.id, text: trimmed, question: head.text };
    const newBuffer = [...bufferedAnswers, entry];
    const newQueue = questionQueue.slice(1);
    setMessages((prev) => [...prev, { role: "user", text: `${head.id}: ${trimmed}` }]);
    void sidecarCall("chatMessages.append", {
      projectId: project.id,
      role: "user",
      text: `${head.id}: ${trimmed}`,
    });
    setBufferedAnswers(newBuffer);
    setQuestionQueue(newQueue);
    setInput("");
    if (newQueue.length === 0) void flushBuffer(newBuffer);
  };

  // ---- Build orchestrator turn (post-build) ------------------------------
  const buildEventHandler = useCallback(
    (event: OrchestratorEvent): void => {
      if (!project) return;
      if (event.kind === "session") {
        turnStartRef.current = Date.now();
        buildSessionRef.current = event.id;
        void sidecarCall("projects.setStatus", {
          id: project.id,
          status: "building",
          currentSessionId: event.id,
        });
      } else if (event.kind === "todos_updated") {
        // Two things happen here:
        //  1. Diff prev → next to spot newly-completed plan items, and
        //     emit a synthetic "Stage X of N complete" line into the
        //     live tail so the novice sees milestones without having to
        //     read the rail.
        //  2. Update the plan, with the review-mode merge from D-040
        //     follow-up so reviews don't erase the build plan.
        setPlan((prev) => {
          const next = event.todos;
          const newlyCompleted: { idx: number; content: string }[] = [];
          next.forEach((t, i) => {
            const before = prev[i];
            if (t.status === "completed" && before?.status !== "completed") {
              newlyCompleted.push({ idx: i, content: t.content });
            }
          });
          if (newlyCompleted.length > 0) {
            const at = Date.now();
            const total = next.length;
            setActions((acts) => [
              ...acts,
              ...newlyCompleted.map((c, j) => ({
                id: `stage-${String(at)}-${String(c.idx)}`,
                ts: at + j,
                tool: "stage",
                rawInput: "",
                humanLine: `Stage ${String(c.idx + 1)} of ${String(total)} complete — ${c.content}`,
                phase: null,
                taskId: null,
              })),
            ]);
          }
          if (reviewMarkdown !== null) {
            const prevContents = new Set(prev.map((t) => t.content));
            const carried = prev.map((t) =>
              t.status === "completed"
                ? t
                : { ...t, status: "completed" as const },
            );
            const additions = next.filter((t) => !prevContents.has(t.content));
            return [...carried, ...additions];
          }
          return next;
        });
      } else if (event.kind === "tool_use") {
        const humanLine = translate(event.tool, event.raw_input);
        setLatestToolLine(humanLine);
        setActions((prev) => [
          ...prev,
          {
            id: `pending-${Date.now()}-${Math.random()}`,
            ts: Date.now(),
            tool: event.tool,
            rawInput: event.raw_input,
            humanLine,
            phase: null,
            taskId: null,
          },
        ]);
        const historyLogPath = project.path.replace(/\/$/, "") + "/.builder/history.log";
        void sidecarCall("actions.append", {
          projectId: project.id,
          tool: event.tool,
          rawInput: event.raw_input,
          humanLine,
          historyLogPath,
        });
        // Auto-refresh the live preview when the agent mutates source files
        // (D-028 C). The dev server's HMR usually picks the change up on its
        // own, but if HMR isn't fully working in the iframe (cross-origin
        // websocket quirks happen), re-keying the iframe forces a hard reload
        // so the novice never has to click Refresh manually.
        if (
          event.tool === "Edit" ||
          event.tool === "Write" ||
          event.tool === "MultiEdit" ||
          event.tool === "NotebookEdit"
        ) {
          // The novice should see *what* is being changed the moment code
          // starts mutating, not after the fact. Flip to the Plan & status
          // tab on the first file-mutating tool call so the live tail is
          // visible by default.
          setTab((current) => (current === "plan" ? current : "plan"));
          setPreviewRefreshTrigger((n) => n + 1);
          // Auto-snapshot the iframe's current state (PR-4 of D-031). We let
          // the iframe re-render first (small delay) so the snapshot reflects
          // the post-edit state, not the stale pre-refresh state. Best-effort:
          // failure (no preview running, bridge absent, render error) just
          // skips this snapshot — there'll be more.
          const tool = event.tool;
          const projectPath = project.path;
          window.setTimeout(() => {
            void (async () => {
              const listener = getBridgeListener();
              if (listener.snapshot().status !== "connected") return;
              const iframe = listener.getBoundIframe();
              const shot = await requestScreenshot(iframe);
              if (!shot) return;
              try {
                await invoke<string>("target_snapshot_save", {
                  projectPath,
                  contentBase64: shot.pngBase64,
                  label: tool,
                });
              } catch (e) {
                console.warn(
                  `auto-snapshot save failed: ${e instanceof Error ? e.message : String(e)}`,
                );
              }
            })();
          }, 1500);
        }
      } else if (event.kind === "done") {
        const turnStartedAt = turnStartRef.current;
        if (turnStartedAt !== null) {
          const elapsed = Date.now() - turnStartedAt;
          setTurnDurations((prev) => [...prev, elapsed]);
          turnStartRef.current = null;
        }
        // Drop a "what was edited this turn" summary into the chat so the
        // novice sees concrete progress without scanning the live tail.
        // sinceTs = turn start (or 0 if we somehow lost it) so the slice
        // matches exactly the actions emitted in this orchestrator turn.
        if (turnStartedAt !== null) {
          const summary = summariseTurn(actionsRef.current, turnStartedAt - 1);
          const rendered = renderTurnSummary(summary, "build");
          if (rendered.length > 0) appendAssistantMessage(rendered);
        }
        if (!hasMadeSentryDecision()) setShowSentryPrompt(true);
        void (async () => {
          await sidecarCall("costs.append", {
            projectId: project.id,
            model: "sonnet",
            inputTokens: event.input_tokens ?? 0,
            outputTokens: event.output_tokens ?? 0,
            costUsd: event.cost_usd ?? 0,
          });
          const sumRes = await sidecarCall<CostSum>("costs.sumByProject", {
            projectId: project.id,
          });
          sumRes.match((sum) => setCostSum(sum), () => undefined);
          const driftRes = await listOpenDrifts(project.id);
          driftRes.match((events) => setOpenDrifts(events), () => undefined);
          const reviewRes = await readReviewMarkdown(project.path);
          const reviewMd = reviewRes.match(
            (md) => md,
            () => null,
          );
          if (reviewMd !== null) {
            setReviewMarkdown(reviewMd);
            if (!davidVerifiedRef.current) {
              const eggResult = await verifyDavidEasterEgg(project.id);
              eggResult.match(
                (report) => {
                  if (report.ok) {
                    davidVerifiedRef.current = true;
                    return;
                  }

                  const failed = formatFailedEasterEggFindings(report);
                  if (!davidRepairAttemptedRef.current) {
                    davidRepairAttemptedRef.current = true;
                    runFollowUpTurnRef.current?.(
                      `The Builder's D-EEGG verification failed: ${failed} Add or repair the mandatory hidden D-EEGG now. Implement a DavidEasterEgg client component, mount it from the root layout so it works on every route, trigger it with Alt+Shift+D, show the exact text "made by david", include the non-visible marker "builder:david-easter-egg" in source, use CSS-only animation with prefers-reduced-motion support, close on Escape/outside click/short timeout, run verification, and update .builder/review.md with the D-EEGG item.`,
                    );
                    return;
                  }

                  if (!davidFailureAnnouncedRef.current) {
                    davidFailureAnnouncedRef.current = true;
                    appendAssistantMessage(
                      `D-EEGG still needs attention: ${failed}`,
                    );
                  }
                },
                (error) => {
                  if (!davidFailureAnnouncedRef.current) {
                    davidFailureAnnouncedRef.current = true;
                    appendAssistantMessage(
                      `I couldn't verify D-EEGG: ${error.message}`,
                    );
                  }
                },
              );
            }
          } else if (!autoReviewAttemptedRef.current) {
            // Claude ended the turn without writing .builder/review.md.
            // Send a follow-up that runs the REVIEW step from the kickoff
            // prompt — runs in the same SDK session so the agent keeps
            // its plan and history. Only attempt once per session.
            autoReviewAttemptedRef.current = true;
            runFollowUpTurnRef.current?.(
              "The build turn finished but .builder/review.md is not on disk. Run the REVIEW step from your kickoff prompt now: re-read spec.md, walk every in-scope item / Flow / data-model entity / integration, decide present | partial | missing, and write the result to .builder/review.md in the exact shape the kickoff prompt specified. Then mark a TodoWrite item 'Review complete — see .builder/review.md' as completed and end the turn.",
            );
          }
        })();
      } else if (event.kind === "rate_limit") {
        setStatus({ kind: "rate_limited", message: event.message });
      } else if (event.kind === "error") {
        setStatus({ kind: "error", message: event.message });
      }
    },
    [project, appendAssistantMessage, reviewMarkdown],
  );

  // Flow M / ADR-0017. Optional deep-research session that runs after the
  // interview reaches readiness and before the build kicks off. Streams
  // findings into the live tail, opens the diff modal on proposal, and
  // never writes spec.md itself — adoption goes through the modal.
  const runDeepResearch = useCallback(async (): Promise<void> => {
    if (!project) return;
    if (researchUi.kind !== "idle") return;

    // Pick the diff baseline. If the project already has a research-
    // adopted spec on disk, USE THAT — re-running research should
    // build on the previous research run, not start over from the
    // interview baseline. Otherwise rebuild deterministically from
    // the answer table.
    const answersResult = await sidecarCall<AnswerRow[]>("answers.list", {
      projectId: project.id,
    });
    const recordedAnswers = answersResult.isOk() ? answersResult.value : [];
    let baselineSpec = appendApprovedSourceMaterials(
      rebuildSpec(recordedAnswers.map(rowToRebuildAnswer)),
      files,
      approvedFileIds,
    );
    try {
      const onDisk = await invoke<string | null>("read_target_spec", {
        projectPath: project.path,
      });
      if (onDisk !== null && onDisk.includes("(via deep research)")) {
        baselineSpec = onDisk;
      }
    } catch (e) {
      console.warn("read_target_spec failed during research baseline pick:", e);
    }
    const answersDigest = buildAnswersDigest(
      recordedAnswers.map((r) => ({
        questionId: r.questionId,
        answerText: r.answerText,
        confidence: r.confidence,
      })),
    );
    const filesDigest = buildFilesDigest(
      files
        .filter((f) => approvedFileIds.has(f.id))
        .map((f) => ({ name: f.name, summary: f.summary })),
    );

    setResearchUi({
      kind: "running",
      streamId: null,
      findings: [],
      startedAt: Date.now(),
    });
    appendAssistantMessage(
      "Researching… typically 2-5 min. Switch to the Spec tab to watch findings stream in. You can hit Stop in either view to abandon.",
    );

    // Switch the rail to the Spec tab so the novice can watch the
    // research-progress block (and see the existing spec for context).
    setTab("spec");

    // Wrap mutable state in an object so closure assignments inside
    // `onEvent` survive TypeScript's let-narrowing across the await
    // boundary (assigning a literal to a `let` and reading it after an
    // await collapses the type to that literal).
    const collected: {
      proposal: { markdown: string; summaryOfChanges: string } | null;
      costUsdCents: number;
      inputTokens: number;
      outputTokens: number;
      cancellationReason: "none" | "user" | "wall_clock" | "step_cap";
    } = {
      proposal: null,
      costUsdCents: 0,
      inputTokens: 0,
      outputTokens: 0,
      cancellationReason: "none",
    };

    const onEvent = (event: ResearchEvent): void => {
      if (event.kind === "session") {
        researchStreamIdRef.current = event.id;
        setResearchUi((prev) =>
          prev.kind === "running" ? { ...prev, streamId: event.id } : prev,
        );
        return;
      }
      if (event.kind === "finding") {
        setResearchUi((prev) =>
          prev.kind === "running"
            ? {
                ...prev,
                findings: [...prev.findings, { topic: event.topic, body: event.body }],
              }
            : prev,
        );
        // Push the finding into the live tail via the bridge listener so
        // it lands next to orchestrator events. One row per finding.
        getBridgeListener().pushServerEvent({
          kind: "server",
          source: "stdout",
          severity: "info",
          message: `[research] ${event.topic} — ${event.body}`.slice(0, 400),
          ts: Date.now(),
        });
        return;
      }
      if (event.kind === "proposal") {
        collected.proposal = {
          markdown: event.markdown,
          summaryOfChanges: event.summaryOfChanges,
        };
        return;
      }
      if (event.kind === "done") {
        collected.cancellationReason = event.cancellation_reason;
        collected.costUsdCents = Math.round((event.cost_usd ?? 0) * 100);
        collected.inputTokens = event.input_tokens ?? 0;
        collected.outputTokens = event.output_tokens ?? 0;
        return;
      }
      if (event.kind === "rate_limit") {
        appendAssistantMessage(`Rate-limited during research: ${event.message}`);
        return;
      }
      if (event.kind === "error") {
        appendAssistantMessage(`Research run failed: ${event.message}`);
        return;
      }
    };

    const r = await researchStart({
      projectId: project.id,
      projectPath: project.path,
      specMarkdown: baselineSpec,
      answersDigest,
      filesDigest,
      model: resolveModel("research"),
      onEvent,
    });

    // The promise resolves with the streamId (or an error) once the SDK
    // stream ends — successfully, via cancel, or via cap.
    if (r.isErr()) {
      appendAssistantMessage(`Couldn't start research: ${r.error.message}`);
      setResearchUi({ kind: "idle" });
      return;
    }

    // Cost is non-zero on every successful or partial run. Always log it.
    if (collected.costUsdCents > 0) {
      void sidecarCall("costs.append", {
        projectId: project.id,
        model: "sonnet",
        inputTokens: collected.inputTokens,
        outputTokens: collected.outputTokens,
        costUsd: collected.costUsdCents / 100,
      });
    }

    if (collected.cancellationReason === "user") {
      appendAssistantMessage("Research stopped. Your spec is unchanged.");
      setResearchUi({ kind: "idle" });
      return;
    }

    if (collected.proposal === null) {
      appendAssistantMessage(
        collected.cancellationReason === "wall_clock"
          ? "Research hit the 5-minute cap before it finished. Your spec is unchanged."
          : "Research finished without producing a proposal. Your spec is unchanged.",
      );
      setResearchUi({ kind: "idle" });
      return;
    }

    setResearchUi({
      kind: "review",
      originalSpec: baselineSpec,
      proposedMarkdown: collected.proposal.markdown,
      summaryOfChanges: collected.proposal.summaryOfChanges,
      partial:
        collected.cancellationReason === "step_cap" ||
        collected.cancellationReason === "wall_clock",
      costUsdCents: collected.costUsdCents,
    });
  }, [project, researchUi.kind, files, approvedFileIds, appendAssistantMessage]);

  const adoptResearchProposal = useCallback(async (): Promise<void> => {
    if (researchUi.kind !== "review" || !project) return;
    try {
      await invoke("backup_target_spec", { projectPath: project.path });
      // Prepend a Builder-controlled header so the build path can detect
      // adoption deterministically — the (via deep research) inline marker
      // depends on the model honouring its prompt and was sometimes
      // missing, causing the build to silently revert the spec to the
      // deterministic rebuild from answers.
      const header = SPEC_RESEARCH_ADOPTED_MARKER + "\n\n";
      const text = researchUi.proposedMarkdown.startsWith(SPEC_RESEARCH_ADOPTED_MARKER)
        ? researchUi.proposedMarkdown
        : header + researchUi.proposedMarkdown;
      await invoke("write_target_spec", {
        projectPath: project.path,
        specText: text,
      });
      appendAssistantMessage(
        "Adopted the new spec. Original saved to .builder/spec.pre-research.md.",
      );
    } catch (e) {
      appendAssistantMessage(
        `Couldn't write the new spec: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    } finally {
      setResearchUi({ kind: "idle" });
    }
  }, [researchUi, project, appendAssistantMessage]);

  const cancelResearchRun = useCallback((): void => {
    const sid = researchStreamIdRef.current;
    if (sid) void researchStop(sid);
    researchStreamIdRef.current = null;
  }, []);

  // The "do the actual build" steps, after pre-flight gates and any
  // concurrent-build resolution have been handled. Pulled out so both the
  // no-conflict path and the concurrent-build modal callbacks can call it.
  const performBuild = useCallback(async (): Promise<void> => {
    if (!project) return;
    setStatus({ kind: "running" });
    try {
      const probe = await invoke<{ ok: boolean; errors: string[]; checkedPath: string }>(
        "build_capability_check",
        { projectPath: project.path },
      );
      if (!probe.ok) {
        setStatus({
          kind: "error",
          message:
            `Build can't start. Check failed for ${probe.checkedPath}:\n` +
            probe.errors.map((e) => `• ${e}`).join("\n"),
        });
        return;
      }
    } catch (e) {
      setStatus({
        kind: "error",
        message: `Couldn't run pre-flight check: ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }

    setRecoveredFromCrash(false);
    void sidecarCall("projects.setStatus", { id: project.id, status: "building" });

    // Refresh spec.md on disk so claude builds against the latest answers
    // — UNLESS the novice has adopted a deep-research-revised spec, in
    // which case the on-disk file contains content the deterministic
    // rebuild would silently throw away. Detect adoption by scanning
    // for the v2 prompt's required marker `(via deep research)`; if
    // present, skip the rebuild and trust what's on disk.
    let researchAdopted = false;
    try {
      const existingSpec = await invoke<string | null>("read_target_spec", {
        projectPath: project.path,
      });
      if (
        existingSpec !== null &&
        // Primary, deterministic marker we write at adoption time. Robust
        // against the model occasionally omitting the inline marker.
        (existingSpec.includes(SPEC_RESEARCH_ADOPTED_MARKER) ||
          // Fallback for specs adopted by older Builder versions that
          // didn't write the header — they relied on the model's
          // (via deep research) inline marker.
          existingSpec.includes("(via deep research)"))
      ) {
        researchAdopted = true;
      }
    } catch (e) {
      console.warn("Couldn't read existing spec.md:", e);
    }
    if (!researchAdopted) {
      const answersResult = await sidecarCall<AnswerRow[]>("answers.list", {
        projectId: project.id,
      });
      if (answersResult.isOk() && answersResult.value.length > 0) {
        try {
          const specMarkdown = appendApprovedSourceMaterials(
            rebuildSpec(answersResult.value.map(rowToRebuildAnswer)),
            files,
            approvedFileIds,
          );
          await invoke("write_target_spec", {
            projectPath: project.path,
            specText: specMarkdown,
          });
        } catch (e) {
          console.warn("Failed to write rebuilt spec.md:", e);
        }
      }
    }

    turnStartRef.current = Date.now();
    let terminal: Status = { kind: "idle" };
    // Resume vs. fresh: if we have a saved sessionId, the SDK loads the
    // prior conversation thread and the next prompt is appended as a new
    // user message. The default "begin" prompt would read like "start
    // over" against an in-flight plan; explicitly tell the agent to pick
    // up the next pending TodoWrite item instead.
    const isResume = buildSessionRef.current !== null;
    const r = await orchestratorStart({
      projectId: project.id,
      projectPath: project.path,
      sessionId: buildSessionRef.current,
      prompt: isResume
        ? "Continue the build. Look at your TodoWrite plan, find the next pending item, mark it in_progress, and execute it. Keep going through the plan. If the plan is complete, do the REVIEW step (rewrite .builder/review.md against spec.md)."
        : null,
      model: resolveModel("build"),
      onEvent: (event) => {
        buildEventHandler(event);
        if (event.kind === "rate_limit") terminal = { kind: "rate_limited", message: event.message };
        if (event.kind === "error") terminal = { kind: "error", message: event.message };
      },
    });
    r.mapErr((e) => {
      terminal = { kind: "error", message: e.message };
      setStatus(terminal);
    });
    if (terminal.kind === "idle") {
      setStatus({ kind: "idle" });
      void sidecarCall("projects.setStatus", { id: project.id, status: "paused" });
    }
  }, [project, files, approvedFileIds, buildEventHandler]);

  const startBuild = useCallback(async (): Promise<void> => {
    if (!project || status.kind === "running" || status.kind === "streaming") return;
    if (!hasStarted && !readiness.ready) {
      appendAssistantMessage(readiness.reason);
      return;
    }

    // Concurrent-build prompt: each project's webview can host its own SDK
    // session in parallel (per ADR-0005 the orchestrator-driver keys inflight
    // runs by stream id, not a singleton subprocess). When the novice clicks
    // Build while another project is mid-build we ask them how to proceed
    // rather than silently preempting (D-024) or silently parallelising —
    // either choice has cost (rate-limit budget vs. losing in-flight work).
    const listResult = await sidecarCall<Project[]>("projects.list", {});
    const conflicts = listResult.isOk()
      ? listResult.value
          .filter((p) => p.id !== project.id && p.status === "building")
          .map((p) => ({ id: p.id, name: p.name }))
      : [];
    if (conflicts.length > 0) {
      setConcurrentBuildPrompt({ conflicts });
      return;
    }
    // Pre-build plan ack (PR-5). Only on the FIRST build of a session — once
    // the agent is mid-plan, "rebuild" is correction mode and the modal would
    // be friction. `hasStarted` flips true the moment any session/action/plan
    // exists for this project.
    if (!hasStarted) {
      setPlanAckOpen(true);
      return;
    }
    await performBuild();
  }, [
    project,
    status.kind,
    hasStarted,
    readiness.ready,
    readiness.reason,
    appendAssistantMessage,
    performBuild,
  ]);

  const onRunAlongside = useCallback((): void => {
    setConcurrentBuildPrompt(null);
    void performBuild();
  }, [performBuild]);

  const onStopOthersFirst = useCallback(async (): Promise<void> => {
    const conflicts = concurrentBuildPrompt?.conflicts ?? [];
    setConcurrentBuildPrompt(null);
    for (const c of conflicts) {
      await orchestratorStop({ projectId: c.id });
      // Preserve the preempted project's currentSessionId so when the user
      // opens its tab and clicks Resume, the SDK picks up where it left off.
      await sidecarCall<Project>("projects.setStatus", {
        id: c.id,
        status: "paused",
      });
    }
    if (conflicts.length > 0) {
      appendAssistantMessage(
        conflicts.length === 1
          ? `Stopped the in-flight build on ${conflicts[0]?.name ?? ""} so this one can start. Resume that project from its tab when you're ready.`
          : `Stopped ${String(conflicts.length)} in-flight builds (${conflicts.map((c) => c.name).join(", ")}) so this one can start. Resume each from its tab when you're ready.`,
      );
    }
    await performBuild();
  }, [concurrentBuildPrompt, performBuild, appendAssistantMessage]);

  const onCancelConcurrentBuild = useCallback((): void => {
    setConcurrentBuildPrompt(null);
  }, []);

  const stopBuild = useCallback(async (): Promise<void> => {
    if (!project) return;
    await orchestratorStop({ projectId: project.id });
    setStatus({ kind: "idle" });
    // PRESERVE buildSessionRef.current and the DB's currentSessionId so
    // Resume can pick up the same Claude SDK session — the SDK persists
    // session history under ~/.claude/projects/, so resuming with the
    // saved id keeps the agent's plan and conversational context intact.
    // Status flips to "paused" (not "ready"); the status footer reads it
    // as such, and the next click on Build calls startBuild which threads
    // the saved sessionId into orchestratorStart.
    await sidecarCall("projects.setStatus", {
      id: project.id,
      status: "paused",
    });
  }, [project]);

  // Open the annotation modal. If a build is mid-stream, pause it first so
  // the agent isn't generating against state the novice has just decided
  // is wrong (D-026 AC1). The modal opens empty; the novice drops/pastes
  // a screenshot inside it.
  //
  // Preserves the SDK sessionId so the next sendBuildFeedback turn resumes
  // the same conversation thread (the agent already has the plan + context
  // in scrollback; we want it to act on the new visual feedback against
  // that history, not start fresh).
  const openAnnotation = useCallback(async (): Promise<void> => {
    if (!project) return;
    if (status.kind === "running" || status.kind === "streaming") {
      await orchestratorStop({ projectId: project.id });
      setStatus({ kind: "idle" });
      await sidecarCall("projects.setStatus", {
        id: project.id,
        status: "paused",
      });
    }
    setAnnotationInitialImage(null);
    setAnnotationCaptureSource(null);
    setAnnotationOpen(true);
  }, [project, status.kind]);

  // Capture-and-annotate (D-028 + D-031 PR-4). Two-phase: first try the
  // iframe-aware bridge screenshot (DOM-coord marks, elementFromPoint
  // resolution on Send). If that fails (no preview running, bridge absent,
  // cross-origin asset breaks the foreignObject render), fall back to the
  // OS-level region picker (`screencapture -i`). Pauses any in-flight build
  // for the same reason as openAnnotation.
  const captureRegionAndAnnotate = useCallback(async (): Promise<void> => {
    if (!project) return;
    if (status.kind === "running" || status.kind === "streaming") {
      await orchestratorStop({ projectId: project.id });
      setStatus({ kind: "idle" });
      await sidecarCall("projects.setStatus", {
        id: project.id,
        status: "paused",
      });
    }

    // Phase 1: iframe-aware bridge screenshot. Only attempted if the preview
    // is running and the bridge has announced itself.
    const listener = getBridgeListener();
    const iframe = listener.getBoundIframe();
    const bridgeReady =
      launchStatus.kind === "running" && listener.snapshot().status === "connected";
    if (bridgeReady && iframe) {
      const shot = await requestScreenshot(iframe);
      if (shot) {
        const bin = atob(shot.pngBase64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], { type: "image/png" });
        setAnnotationInitialImage(blob);
        setAnnotationCaptureSource("iframe");
        setAnnotationOpen(true);
        return;
      }
      // null = rendering failed (cross-origin assets, etc). Fall through.
    }

    // Phase 2: OS region capture (existing path).
    try {
      const b64 = await invoke<string>("capture_region_to_png");
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: "image/png" });
      setAnnotationInitialImage(blob);
      setAnnotationCaptureSource("screen");
      setAnnotationOpen(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // "Capture cancelled." is the user pressing ESC mid-pick — silently
      // ignore. Anything else is worth surfacing.
      if (!/cancelled/i.test(msg)) {
        appendAssistantMessage(`Couldn't capture: ${msg}`);
      }
    }
  }, [project, status.kind, appendAssistantMessage, launchStatus.kind]);

  // Centre point of a Shape in image-pixel coordinates. For iframe-rendered
  // captures (bridge screenshot) this is also iframe-CSS pixel space, so it
  // can be passed directly to elementFromPoint via the bridge.
  const shapeCenter = useCallback((shape: Shape): IframePoint => {
    switch (shape.kind) {
      case "box":
        return { x: shape.x + shape.width / 2, y: shape.y + shape.height / 2 };
      case "arrow":
        // Arrows point AT something — use the destination, not the midpoint.
        return { x: shape.to.x, y: shape.to.y };
      case "text":
        return { x: shape.x, y: shape.y };
      case "freedraw": {
        if (shape.points.length === 0) return { x: 0, y: 0 };
        const sum = shape.points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), {
          x: 0,
          y: 0,
        });
        return { x: sum.x / shape.points.length, y: sum.y / shape.points.length };
      }
    }
  }, []);

  const sendBuildFeedback = useCallback(
    async (
      feedback: string,
      imageBytes?: Uint8Array,
      marks?: readonly Shape[],
      captureSource?: "iframe" | "screen" | null,
    ): Promise<void> => {
      const trimmed = feedback.trim();
      if (!project) return;
      if (trimmed.length === 0 && !imageBytes) return;

      let imageRelPath: string | null = null;
      if (imageBytes) {
        try {
          imageRelPath = await invoke<string>("feedback_image_save", {
            projectPath: project.path,
            contentBase64: bytesToBase64(imageBytes),
          });
        } catch (e) {
          appendAssistantMessage(
            `Couldn't save your annotated screenshot: ${e instanceof Error ? e.message : String(e)}`,
          );
          return;
        }
      }

      // Assemble the JSON sidecar (ADR-0014 PR-2 + PR-4). Best-effort: if the
      // bridge isn't connected we still write a sidecar with the marks +
      // description, just without iframe context. When the capture came from
      // the iframe (PR-4), mark coords ARE iframe-CSS pixels, so each mark's
      // centre is asked of elementFromPoint and the result is attached to the
      // mark — the agent gets `<button class="cta">` instead of pixels.
      let sidecarRelPath: string | null = null;
      const listener = getBridgeListener();
      const bridgeSnap = listener.snapshot();
      const iframe = listener.getBoundIframe();
      const iframeSnapshot = await requestSnapshot(iframe);

      let resolvedElements: readonly (ResolvedElement | null)[] | null = null;
      if (captureSource === "iframe" && iframe && marks && marks.length > 0) {
        const points = marks.map(shapeCenter);
        resolvedElements = await resolveElements(iframe, points);
      }

      const sidecar = buildFeedbackSidecar({
        description: trimmed,
        marks: marks ?? [],
        imagePath: imageRelPath,
        iframe: iframeSnapshot,
        events: bridgeSnap.events,
        bridgeConnected: bridgeSnap.status === "connected",
        captureSource: captureSource ?? null,
        resolvedElements,
      });
      try {
        sidecarRelPath = await invoke<string>("feedback_sidecar_save", {
          projectPath: project.path,
          contentJson: JSON.stringify(sidecar, null, 2),
        });
      } catch (e) {
        // Sidecar save is best-effort. Keep going with image-only feedback.
        console.warn(
          `feedback sidecar save failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      const userVisible = imageRelPath
        ? trimmed.length > 0
          ? `${trimmed}\n[attached: ${imageRelPath}]`
          : `[attached: ${imageRelPath}]`
        : trimmed;
      echoUserMessage(userVisible);

      const framed = [
        trimmed.length > 0
          ? `The novice just reviewed the build and reports: ${trimmed}`
          : "The novice just reviewed the build and sent an annotated screenshot without a written description.",
        imageRelPath
          ? `\nThey've attached an annotated screenshot at \`${imageRelPath}\`. Read that file with your Read tool — it returns image content; the red boxes / arrows / freehand marks / text labels indicate exactly what's wrong or where it should be different. Treat the visual annotations as authoritative; they're more precise than any text description.`
          : "",
        sidecarRelPath
          ? `\nA structured context sidecar is at \`${sidecarRelPath}\` (JSON). Read it to get: the iframe URL/viewport at send time, mark coordinates and (when \`captureSource: "iframe"\`) per-mark \`resolvedElements\` — each entry is the DOM element each mark's centre landed on (tag/id/classes/text/outerHTML), so you know EXACTLY which element was being pointed at. Also includes recent browser console output, recent runtime errors, recent network requests (URL/method/status/duration/response sample for fetch + XHR), and recent dev-server stderr. Cross-reference these against the screenshot — the resolvedElements slice + the console + network + server-error slices are the highest-signal clues. A non-2xx response in the network slice or an "Error:" in serverErrors is usually the proximate cause.\nFor visual evolution context, you can also \`Read\` files in \`.builder/snapshots/\` — the Builder auto-saves a PNG of the preview after every Edit/Write/MultiEdit you perform (most recent ~50 are kept), so you can see how the build has changed over time and whether your last edit had the visual effect you expected.`
          : "",
        "",
        "Compare this against the deliverable artifact (Q33), reference anchors (Q34), and non-negotiables (Q35) in spec.md. Adjust the build to match. When done, re-run the spec coverage check and rewrite .builder/review.md with the updated state.",
      ].join("\n");
      void runFollowUpTurnRef.current?.(framed);
    },
    [project, appendAssistantMessage],
  );

  const runFollowUpTurn = useCallback(
    async (prompt: string, options: { force?: boolean } = {}): Promise<void> => {
      if (!project) return;
      if (!options.force && (status.kind === "running" || status.kind === "streaming")) return;
      setStatus({ kind: "running" });
      setLatestToolLine(`You said: ${prompt.slice(0, 80)}…`);
      turnStartRef.current = Date.now();
      const r = await orchestratorStart({
        projectId: project.id,
        projectPath: project.path,
        sessionId: buildSessionRef.current,
        prompt: expandMentions(prompt),
        model: resolveModel("build"),
        onEvent: buildEventHandler,
      });
      r.match(
        () => setStatus((prev) => (prev.kind === "running" ? { kind: "idle" } : prev)),
        (e) => setStatus({ kind: "error", message: e.message }),
      );
    },
    [project, status.kind, buildEventHandler, expandMentions],
  );

  // The build event handler is defined above runFollowUpTurn (it composes
  // with buildEventHandler) so we publish the runner through a ref to let
  // the auto-review trigger reach forward without a circular dep.
  useEffect(() => {
    runFollowUpTurnRef.current = (prompt) => void runFollowUpTurn(prompt, { force: true });
  }, [runFollowUpTurn]);

  // ---- Chat input dispatcher --------------------------------------------
  // Shared helper: echo the user's message to the scrollback + persist it,
  // then optionally drop a synthetic assistant ack (e.g. "kicking off the
  // build now") so the novice sees that their words triggered an action.
  const echoUserMessage = (text: string, ack?: string): void => {
    if (!project) return;
    setMessages((prev) => {
      const base = [...prev, { role: "user" as const, text }];
      return ack ? [...base, { role: "assistant" as const, text: ack }] : base;
    });
    void sidecarCall("chatMessages.append", {
      projectId: project.id,
      role: "user",
      text,
    });
    if (ack) {
      void sidecarCall("chatMessages.append", {
        projectId: project.id,
        role: "assistant",
        text: ack,
      });
    }
  };

  const handleSendInput = (): void => {
    const trimmed = input.trim();
    if (trimmed.length === 0 || !project) return;

    // Detect intent BEFORE any "is the build streaming" early return — the
    // whole point of a chat-driven action is that the user might not be
    // able to reach the header buttons (e.g. "stop" mid-stream). Per-intent
    // context guards in detectIntent prevent action collisions (you can't
    // "build" while a build is already running, etc.).
    const ctx = {
      hasStarted,
      isRunning,
      hasReview: reviewMarkdown !== null,
      isReadyToBuild: readiness.ready,
    };
    const intent = detectIntent(trimmed, ctx);

    if (intent !== "none") {
      echoUserMessage(trimmed, ackForIntent(intent, ctx));
      setInput("");
      switch (intent) {
        case "stop":
          void stopBuild();
          return;
        case "build":
          void startBuild();
          return;
        case "research":
          void runDeepResearch();
          return;
        case "launch":
          void launchApp();
          return;
        case "deploy":
          void deployPreview();
          return;
        case "push":
          void exportToGithubFlow();
          return;
        case "plan":
          setTab("plan");
          return;
        case "annotate":
          void openAnnotation();
          return;
        case "set_model_opus":
          setAllStages("claude-opus-4-5");
          return;
        case "set_model_sonnet":
          setAllStages("claude-sonnet-4-5");
          return;
        case "set_model_haiku":
          setAllStages("claude-haiku-4-5");
          return;
        case "set_model_default":
          resetAllSettings();
          return;
      }
    }

    // Freeform chat: while a turn is streaming we can't double-fire
    // Claude, but we *can* tell the user we heard them. Echo + ack
    // so the chat is never silent.
    if (status.kind === "streaming" || status.kind === "running") {
      echoUserMessage(
        trimmed,
        "Got it — finishing the current turn first. I'll come back to this once it's done.",
      );
      setInput("");
      return;
    }

    if (!hasStarted) {
      // Pre-build: interview chat. If a queued question exists, treat the
      // input as that question's freeform answer; otherwise it's a freeform
      // turn (the initial pitch, or a between-batches user prompt).
      if (questionQueue[0]) {
        submitAnswerForHead(trimmed);
        return;
      }
      // Plain-language ack so the chat never goes silent waiting on
      // Claude's first streamed token.
      echoUserMessage(trimmed, "Thinking…");
      setInput("");
      void sendInterview(trimmed);
      return;
    }

    // Build mode: send as a follow-up turn to the running session. Echo
    // an immediate "On it" so the novice never silently drops into build
    // mode without acknowledgement (per UX feedback — they'd type a
    // comment and the build would resume but the chat would stay quiet).
    echoUserMessage(trimmed, "On it — picking that up now.");
    setInput("");
    void runFollowUpTurn(trimmed);
  };

  // ---- Deploy / GitHub --------------------------------------------------
  const runDeploy = useCallback(async (): Promise<void> => {
    if (!project) return;
    setDeployStatus({ kind: "running" });
    const r = await deployToVercel({ projectPath: project.path, projectId: project.id });
    r.match(
      (result) => {
        setDeployStatus({ kind: "success", url: result.previewUrl });
        if (typeof navigator !== "undefined" && navigator.clipboard) {
          void navigator.clipboard.writeText(result.previewUrl);
        }
      },
      (e) => setDeployStatus({ kind: "error", message: e.message }),
    );
  }, [project]);

  const deployPreview = useCallback(async (): Promise<void> => {
    if (!project) return;

    // Gate first (Flow L AC8). If there are unresolved critical-band
    // defects and the user hasn't typed the bypass phrase this attempt,
    // open the gate modal and stop — it'll re-call deployPreview when
    // the user confirms.
    if (!deployGateBypassed) {
      const blocking = selectUnresolvedCritical(defects);
      if (blocking.length > 0) {
        setDeployGateOpen(true);
        return;
      }
    }

    const installed = await isVercelInstalled();
    if (installed.isErr() || !installed.value) {
      setDeployStatus({
        kind: "error",
        message:
          "vercel CLI not found on your PATH. Install it from npmjs.com/package/vercel and try again.",
      });
      return;
    }
    const tokenResult = await getVercelToken();
    if (tokenResult.isErr() || !tokenResult.value) {
      setDeployModalOpen(true);
      return;
    }
    // Bypass is per-deploy-attempt: clear it the moment the deploy
    // kicks off so a follow-up attempt re-checks the gate against the
    // current defect state.
    setDeployGateBypassed(false);
    void runDeploy();
  }, [project, runDeploy, deployGateBypassed, defects]);

  // ---- Launch target app (CLAUDE.md O33) -------------------------------
  const launchApp = useCallback(async (): Promise<void> => {
    if (!project || launchStatus.kind === "starting" || launchStatus.kind === "running") {
      // Already running: just re-open the URL in the browser.
      if (launchStatus.kind === "running") {
        window.open(launchStatus.url, "_blank", "noopener,noreferrer");
      }
      return;
    }
    setLaunchStatus({ kind: "starting" });
    // Best-effort write of the platform launch scripts so the novice can
    // also launch outside the Builder (O34). Failure here is non-fatal.
    void targetAppWriteLaunchScripts(project.path);
    const r = await targetAppLaunch(project.path);
    r.match(
      (info) => setLaunchStatus({ kind: "running", url: info.url }),
      (e) => setLaunchStatus({ kind: "error", message: e.message }),
    );
  }, [project, launchStatus]);

  const stopLaunchedApp = useCallback(async (): Promise<void> => {
    const r = await targetAppStop();
    r.match(
      () => setLaunchStatus({ kind: "idle" }),
      (e) => setLaunchStatus({ kind: "error", message: e.message }),
    );
    // Exit preview fullscreen on stop. Otherwise the rail stays as a
    // fixed inset-0 overlay with no toolbar (the toolbar belongs to the
    // running PreviewPanel branch) and the novice has no on-screen way
    // back to the rest of the workspace. ESC also restores; this matches
    // the same intent.
    setPreviewMaximized(false);
  }, []);

  // Preview-tab variant of launchApp: never opens the browser as a side
  // effect (the iframe IS the preview). Idempotent — clicking Start preview
  // when the dev server is already running is a no-op rather than popping
  // a browser window. Distinct from launchApp which preserves the header
  // Launch app button's "give me the link" gesture.
  const startPreviewServer = useCallback(async (): Promise<void> => {
    if (!project) return;
    if (launchStatus.kind === "starting" || launchStatus.kind === "running") return;
    setLaunchStatus({ kind: "starting" });
    void targetAppWriteLaunchScripts(project.path);
    const r = await targetAppLaunch(project.path, { openBrowser: false });
    r.match(
      (info) => setLaunchStatus({ kind: "running", url: info.url }),
      (e) => setLaunchStatus({ kind: "error", message: e.message }),
    );
  }, [project, launchStatus]);

  const exportToGithubFlow = useCallback(async (): Promise<void> => {
    if (!project) return;
    const installed = await isGhInstalled();
    if (installed.isErr() || !installed.value) {
      setExportStatus({
        kind: "error",
        message:
          "gh CLI not found on PATH. Install it from cli.github.com and run `gh auth login`.",
      });
      return;
    }
    setExportStatus({ kind: "running" });
    const r = await exportToGithub({
      projectPath: project.path,
      projectId: project.id,
      repoName: project.name,
    });
    r.match(
      (result) => {
        setExportStatus({ kind: "success", url: result.repoUrl });
        if (typeof navigator !== "undefined" && navigator.clipboard) {
          void navigator.clipboard.writeText(result.repoUrl);
        }
      },
      (e) => setExportStatus({ kind: "error", message: e.message }),
    );
  }, [project]);

  // Stage 2: first-pass build done — review.md just appeared on disk. The
  // banner stack already shows the live tail; this points the novice at
  // the action buttons in the header.
  useEffect(() => {
    if (announcedReviewRef.current) return;
    if (reviewMarkdown === null) return;
    announcedReviewRef.current = true;
    appendAssistantMessage(
      `${STAGE_SENTINELS.review} — the plan and activity are in the right rail. Click "Launch app" to try it locally, "Deploy" for a Vercel preview, or "Push to GitHub" to back the code up. You can also keep chatting with me to fill any gaps.`,
    );
  }, [reviewMarkdown, appendAssistantMessage, STAGE_SENTINELS.review]);

  // Phase boundary auto-scan (Flow L AC1 / G7 follow-up #4). Fire-and-
  // forget: kicks off a Debug scan once the first-pass review.md
  // appears, so the Debug tab is populated when the novice opens it.
  // Does not gate the existing review/Launch/Deploy flow — the full
  // approval-modal gate remains tracked under D-015 alongside the
  // phase_complete MCP tool.
  useEffect(() => {
    if (autoScannedAtPhaseBoundaryRef.current) return;
    if (reviewMarkdown === null) return;
    if (project === null) return;
    autoScannedAtPhaseBoundaryRef.current = true;
    void runDebugScanNow();
  }, [reviewMarkdown, project, runDebugScanNow]);

  // Auto-load the preview at the phase boundary so a broken build is
  // caught before the novice has to click around. Switches the rail to
  // the Preview tab so the iframe mounts and the bridge surfaces any
  // console / network / server errors in the live status. One-shot per
  // session via autoPreviewLoadAttemptedRef.
  useEffect(() => {
    if (autoPreviewLoadAttemptedRef.current) return;
    if (reviewMarkdown === null) return;
    if (project === null) return;
    if (launchStatus.kind !== "idle") return;
    autoPreviewLoadAttemptedRef.current = true;
    appendAssistantMessage(
      "Auto-loading the preview to check the build runs…",
    );
    setTab("preview");
    void startPreviewServer();
  }, [
    reviewMarkdown,
    project,
    launchStatus.kind,
    startPreviewServer,
    appendAssistantMessage,
  ]);

  // Announce the auto-preview result. Tied to the attempt ref so it only
  // fires when the launch was kicked off automatically (not when the
  // user clicked Launch app themselves — that flow has its own banners).
  const autoPreviewResultAnnouncedRef = useRef(false);
  useEffect(() => {
    if (!autoPreviewLoadAttemptedRef.current) return;
    if (autoPreviewResultAnnouncedRef.current) return;
    if (launchStatus.kind === "running") {
      autoPreviewResultAnnouncedRef.current = true;
      appendAssistantMessage(
        `Preview is up at ${launchStatus.url}. The Preview tab will surface any errors as they happen — leave a comment to iterate if something looks off.`,
      );
    } else if (launchStatus.kind === "error") {
      autoPreviewResultAnnouncedRef.current = true;
      appendAssistantMessage(
        `Preview failed to start: ${launchStatus.message}. The build may not be runnable yet — leave a comment in the chat to fix it.`,
      );
    }
  }, [launchStatus, appendAssistantMessage]);

  // Stage 3: deploy preview just succeeded.
  useEffect(() => {
    if (announcedDeployedRef.current) return;
    if (deployStatus.kind !== "success") return;
    announcedDeployedRef.current = true;
    appendAssistantMessage(
      `${STAGE_SENTINELS.deployed} ${deployStatus.url}. Click "Push to GitHub" if you want to back this up too.`,
    );
  }, [deployStatus, appendAssistantMessage, STAGE_SENTINELS.deployed]);

  // Stage 4: GitHub push just succeeded. End of the chain — no follow-up.
  useEffect(() => {
    if (announcedPushedRef.current) return;
    if (exportStatus.kind !== "success") return;
    announcedPushedRef.current = true;
    appendAssistantMessage(
      `${STAGE_SENTINELS.pushed} ${exportStatus.url}. You're set — keep chatting if you want to keep iterating.`,
    );
  }, [exportStatus, appendAssistantMessage, STAGE_SENTINELS.pushed]);

  // ---- File ingest -----------------------------------------------------
  // Workspace-wide drag overlay state. The user can drop files anywhere on
  // the page (not just on the Files tab) and they'll be accepted; the rail
  // auto-switches to the Files tab so the novice sees the ingest progress.
  const [isDraggingOverWorkspace, setIsDraggingOverWorkspace] = useState(false);
  const dragDepthRef = useRef(0);

  const handleFilesDropped = (added: readonly IngestedFile[], rawFiles: readonly File[]): void => {
    setFiles((prev) => [...prev, ...added]);
    if (!project) return;
    for (let i = 0; i < added.length; i++) {
      const ingested = added[i];
      const raw = rawFiles[i];
      if (ingested === undefined || raw === undefined) continue;
      const fileId = ingested.id;
      setFiles((prev) =>
        prev.map((f) =>
          f.id === fileId
            ? { ...f, status: "processing" as const, statusMessage: "Reading..." }
            : f,
        ),
      );
      void (async () => {
        const r = await ingestFile(raw, project.path);
        r.match(
          (result) => {
            setFiles((prev) =>
              prev.map((f) => {
                if (f.id !== fileId) return f;
                const rest: IngestedFile = { ...f };
                delete (rest as { statusMessage?: string }).statusMessage;
                return {
                  ...rest,
                  status: "done" as const,
                  summary: result.summary,
                  hasPiiWarning: result.hasPiiWarning,
                };
              }),
            );
            setPendingFileApprovals((prev) => [
              ...prev,
              {
                fileId,
                name: ingested.name,
                summary: result.summary,
                hasPiiWarning: result.hasPiiWarning,
              },
            ]);
            appendAssistantMessage(
              result.hasPiiWarning
                ? `I read ${ingested.name}, but it may contain personal data. Review the file banner before I use it in the spec.`
                : `I read ${ingested.name}. Review the file banner if you want me to use it in the spec.`,
            );
          },
          (e) => {
            setFiles((prev) =>
              prev.map((f) =>
                f.id === fileId ? { ...f, status: "error" as const, statusMessage: e.message } : f,
              ),
            );
          },
        );
      })();
    }
  };

  const acceptDroppedFiles = (rawFiles: readonly File[]): void => {
    if (rawFiles.length === 0) return;
    const now = Date.now();
    const added: IngestedFile[] = rawFiles.map((f) => ({
      id: Math.random().toString(36).slice(2, 12),
      name: f.name,
      kind: classifyByName(f.name),
      size: f.size,
      status: "pending" as const,
      droppedAt: now,
    }));
    handleFilesDropped(added, rawFiles);
    tabPinnedRef.current = true;
    // Files now live as a section inside the Spec tab — route there
    // so the novice sees the file panel light up.
    setTab("spec");
  };

  const approveFileForSpec = (fileId: string): void => {
    setApprovedFileIds((prev) => new Set(prev).add(fileId));
    const pending = pendingFileApprovals.find((f) => f.fileId === fileId);
    setPendingFileApprovals((prev) => prev.filter((f) => f.fileId !== fileId));
    if (pending) {
      appendAssistantMessage(`I'll use ${pending.name} as source material for the spec.`);
    }
    void refreshSpec();
  };

  const skipFileForSpec = (fileId: string): void => {
    const pending = pendingFileApprovals.find((f) => f.fileId === fileId);
    setPendingFileApprovals((prev) => prev.filter((f) => f.fileId !== fileId));
    if (pending) {
      appendAssistantMessage(`Okay, I won't use ${pending.name} in the spec.`);
    }
  };

  // ---- Derived UI labels -----------------------------------------------
  const isRunning = status.kind === "running" || status.kind === "streaming";
  const blockingPiiApproval = pendingFileApprovals.find((f) => f.hasPiiWarning);
  const isBlocked = isRunning || status.kind === "rate_limited" || !project || blockingPiiApproval !== undefined;
  const canStartOrResume = hasStarted || readiness.ready;
  const inProgressIdx = plan.findIndex((t) => t.status === "in_progress");
  const completedSteps = plan.filter((t) => t.status === "completed").length;
  const totalSteps = plan.length;
  const currentStepLabel: string | null =
    inProgressIdx >= 0 && plan[inProgressIdx] ? plan[inProgressIdx]!.activeForm : null;
  const nowDoingLine: string | null = currentStepLabel ?? latestToolLine;
  const stepCounter: string | null =
    totalSteps > 0
      ? inProgressIdx >= 0
        ? `Step ${inProgressIdx + 1} of ${totalSteps}`
        : `${completedSteps} of ${totalSteps} steps complete`
      : null;
  const inFlightElapsed = turnStartRef.current === null ? 0 : Date.now() - turnStartRef.current;
  const liveEta = estimate(turnDurations, inFlightElapsed);

  if (loadError) {
    return (
      <main className="flex h-full items-center justify-center p-6">
        <Alert variant="destructive" className="max-w-lg">
          <AlertTitle>Could not open the project</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      </main>
    );
  }
  if (!project) {
    return (
      <main className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading project…
      </main>
    );
  }

  return (
    <main
      className="relative flex h-full flex-col bg-background"
      onDragEnter={(e) => {
        // Only react to file drags. Internal element drags carry no Files
        // type and would otherwise flicker the overlay open.
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        dragDepthRef.current += 1;
        setIsDraggingOverWorkspace(true);
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
      }}
      onDragLeave={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        // dragleave fires for every child boundary crossed; we only want to
        // close when we truly leave the workspace, hence the depth counter.
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setIsDraggingOverWorkspace(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        dragDepthRef.current = 0;
        setIsDraggingOverWorkspace(false);
        const files = Array.from(e.dataTransfer.files);
        acceptDroppedFiles(files);
      }}
    >
      <header className="flex items-center justify-between border-b px-6 py-3">
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold">{project.name}</h1>
          <p className="truncate font-mono text-xs text-muted-foreground">{project.path}</p>
        </div>
        <div className="flex items-center gap-2">
          {!hasStarted ? (
            <span className="text-xs text-muted-foreground" aria-label="Fast-path interview progress">
              {readiness.fastPathAnswered} / {readiness.fastPathTotal} answered
            </span>
          ) : null}
          {/* Primary verb — promoted out of the Actions dropdown so the
              novice's most-needed button (Build it / Resume / Stop) is
              visible in one click instead of two. UX review 2026-05-03. */}
          {isRunning ? (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => void stopBuild()}
              title="Stop the build"
            >
              <Square className="mr-1.5 h-3 w-3" aria-hidden="true" />
              Stop the build
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              onClick={() => void startBuild()}
              disabled={ceiling.state === "stop" || !canStartOrResume}
              title={!canStartOrResume ? readiness.reason : undefined}
            >
              <Play className="mr-1.5 h-3 w-3" aria-hidden="true" />
              {hasStarted ? "Resume build" : "Build it"}
            </Button>
          )}
          <WorkspaceActionsMenu
            triggerLabel="Actions"
            items={(() => {
              const items: ActionItem[] = [];
              // Deep research — pre-build OR between turns of a started build.
              if (!isRunning && researchUi.kind === "idle" && (canStartOrResume || hasStarted)) {
                items.push({
                  id: "research",
                  label: "Deep research",
                  icon: <Sparkles className="h-3 w-3 text-primary" />,
                  onSelect: () => void runDeepResearch(),
                  disabled: ceiling.state === "stop",
                  title: hasStarted
                    ? "Re-run deep research against the current spec — adopted changes survive on Resume"
                    : "Spend 2-5 min researching competitors / edge cases before any code is written",
                });
              }
              // Annotate — once any build session has started.
              if (hasStarted) {
                items.push({
                  id: "annotate",
                  label: isRunning ? "Pause & annotate" : "Annotate the build",
                  icon: <Pencil className="h-3 w-3" />,
                  onSelect: () => void openAnnotation(),
                  title: isRunning
                    ? "Pause the build and annotate a screenshot"
                    : "Annotate a screenshot of the build",
                  separatorBefore: true,
                });
              }
              // Launch / Open / Stop app — only after review.md exists.
              if (hasStarted && reviewMarkdown !== null) {
                if (launchStatus.kind === "running") {
                  items.push(
                    {
                      id: "open-app",
                      label: "Open app in browser",
                      icon: <ExternalLink className="h-3 w-3" />,
                      onSelect: () =>
                        window.open(launchStatus.url, "_blank", "noopener,noreferrer"),
                      title: `Open ${launchStatus.url} in your browser`,
                      separatorBefore: true,
                    },
                    {
                      id: "stop-app",
                      label: "Stop dev server",
                      icon: <Square className="h-3 w-3" />,
                      onSelect: () => void stopLaunchedApp(),
                      title: "Stop the running dev server",
                    },
                  );
                } else {
                  items.push({
                    id: "launch-app",
                    label: "Launch app",
                    icon:
                      launchStatus.kind === "starting" ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Globe className="h-3 w-3" />
                      ),
                    onSelect: () => void launchApp(),
                    disabled: launchStatus.kind === "starting",
                    title: "Start the dev server and open it in your browser",
                    separatorBefore: true,
                  });
                }
              }
              // Deploy / Push — once any build has started.
              if (hasStarted) {
                items.push(
                  {
                    id: "deploy",
                    label: "Deploy preview to Vercel",
                    icon:
                      deployStatus.kind === "running" ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Rocket className="h-3 w-3" />
                      ),
                    onSelect: () => void deployPreview(),
                    disabled: deployStatus.kind === "running",
                    title: "Deploy a preview to Vercel",
                    separatorBefore: true,
                  },
                  {
                    id: "push",
                    label: "Push to GitHub",
                    icon:
                      exportStatus.kind === "running" ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <GitBranch className="h-3 w-3" />
                      ),
                    onSelect: () => void exportToGithubFlow(),
                    disabled: exportStatus.kind === "running",
                    title: "Push the project folder to a private GitHub repo",
                  },
                );
              }
              return items;
            })()}
          />
        </div>
      </header>

      {/* Workflow progress bar — always visible so the novice sees the
          stage chain (Interview → Plan → Build → Test → Review) and a
          rough ETA, even before the build is kicked off. */}
      <StagesBar
        hasStarted={hasStarted}
        plan={plan}
        reviewPresent={reviewMarkdown !== null}
        isRunning={isRunning}
        etaMsPerTurn={liveEta.medianMs ?? 0}
      />

      {/* The standalone "now doing" strip was removed per UX review
          2026-05-03 — its content (spinner + nowDoingLine + stepCounter)
          already lives in the StatusFooter at the bottom of the
          workspace, so showing it twice was a scannability tax. */}

      <BannerStack
        notifications={buildWorkspaceNotifications({
          deployStatus,
          onDismissDeploy: () => setDeployStatus({ kind: "idle" }),
          exportStatus,
          onDismissExport: () => setExportStatus({ kind: "idle" }),
          showSentryPrompt,
          onSentryDecided: () => setShowSentryPrompt(false),
          ceiling,
          pendingFileApproval: pendingFileApprovals[0] ?? null,
          pendingFileApprovalCount: pendingFileApprovals.length,
          onApproveFile: approveFileForSpec,
          onSkipFile: skipFileForSpec,
          recoveredFromCrash: recoveredFromCrash && !recoveredBannerDismissed,
          onDismissRecoveredBanner: () => setRecoveredBannerDismissed(true),
          openPermissions,
          onPermissionResolved: (id) =>
            setOpenPermissions((prev) => prev.filter((p) => p.id !== id)),
          openDrifts,
          projectPath: project.path,
          onDriftResolved: (resolved) =>
            setOpenDrifts((prev) => prev.filter((d) => d.id !== resolved.id)),
          reviewMarkdown,
          reviewBannerDismissed,
          onDismissReviewBanner: () => setReviewBannerDismissed(true),
          onFocusChat: () =>
            requestAnimationFrame(() => inputRef.current?.focus()),
          onOpenAnnotation: () => void openAnnotation(),
        })}
      />

      <ResizableSplit
        rightWidth={rightRailWidth}
        onRightWidthChange={setRightRailWidth}
        hideHandle={previewMaximized && tab === "preview"}
        left={
          previewMaximized && tab === "preview" ? null : (
            <ChatPanel
              messages={messages}
              status={chatStatusFor(status)}
              input={input}
              onInputChange={setInput}
              onSend={handleSendInput}
              disabled={isBlocked}
              disabledReason={
                !project
                  ? "Loading project..."
                  : status.kind === "rate_limited"
                    ? "Rate-limited; please wait."
                    : blockingPiiApproval
                      ? `Review ${blockingPiiApproval.name} before sending more.`
                      : isRunning
                        ? "Wait for the current turn to finish"
                        : null
              }
              questionQueue={hasStarted ? [] : questionQueue}
              bufferedAnswerCount={hasStarted ? 0 : bufferedAnswers.length}
              onOptionPick={submitAnswerForHead}
              onManualFlush={() => void flushBuffer(bufferedAnswers)}
              onEnterMyOwn={() => requestAnimationFrame(() => inputRef.current?.focus())}
              isPreparingBank={isPreparingBank}
              inputRef={inputRef}
              availableFiles={files}
              onAttachFiles={(rawFiles) =>
                acceptDroppedFiles(Array.from(rawFiles))
              }
            />
          )
        }
        right={
          <RightRail
          tab={tab}
          onTabChange={onTabChange}
          hasStarted={hasStarted}
          spec={spec}
          plan={plan}
          recentHistory={targetState?.history}
          actions={actions}
          showTechnicalDetail={showDetails}
          isRunning={isRunning}
          reviewMarkdown={reviewMarkdown}
          reviewIsRunning={isRunning}
          onBuildMissingPieces={() =>
            void runFollowUpTurn(
              "Look at .builder/review.md. For every item marked partial or missing, build it now. Mark each plan item completed in TodoWrite as you go. When everything is built, re-run the review and rewrite .builder/review.md with the updated coverage.",
            )
          }
          echoBackPreview={echoBackPreview}
          onSendBuildFeedback={sendBuildFeedback}
          launchStatus={launchStatus}
          onStartPreview={() => void startPreviewServer()}
          onStopPreview={() => void stopLaunchedApp()}
          onCaptureAndAnnotate={() => void captureRegionAndAnnotate()}
          previewRefreshTrigger={previewRefreshTrigger}
          previewMaximized={previewMaximized}
          onTogglePreviewMaximize={() => setPreviewMaximized((v) => !v)}
          onReportPreviewBroken={(summary) => {
            // Echo "On it — looking at that now." so the novice gets an
            // immediate ack, then resume the build session with the captured
            // console/network output as a follow-up turn.
            echoUserMessage(summary, "On it — looking at that now.");
            void runFollowUpTurn(summary);
            // Return the rail to its default Status view so the novice
            // sees Dave start working on the fix instead of staying on
            // the broken preview iframe.
            setTab(hasStarted ? "plan" : "spec");
            setPreviewMaximized(false);
          }}
          researchProgress={
            researchUi.kind === "running"
              ? {
                  findingsCount: researchUi.findings.length,
                  recentFindings: researchUi.findings.slice(-5),
                  elapsedMs: Date.now() - researchUi.startedAt,
                  onStop: cancelResearchRun,
                }
              : null
          }
          defects={defects}
          isDebugScanning={isDebugScanning}
          fixingDefectIds={fixingDefectIds}
          rollingBackDefectIds={rollingBackDefectIds}
          onDebugScanNow={() => void runDebugScanNow()}
          onDebugFix={(id) => void runDebugFix(id)}
          onDebugRollback={(id) => void runDebugRollback(id)}
          lastDebugScannedAt={lastDebugScannedAt}
          files={files}
          onFilesDropped={handleFilesDropped}
          onAskDaveToChangeIdea={() => {
            const starter = "Change ";
            setInput((prev) => (prev.length === 0 ? starter : prev));
            requestAnimationFrame(() => {
              const el = inputRef.current;
              if (!el) return;
              el.focus();
              const end = el.value.length;
              el.selectionStart = end;
              el.selectionEnd = end;
            });
          }}
          />
        }
      />

      <StatusFooter
        targetState={targetState}
        projectStatus={project.status}
        runtimeStatus={status}
        nowDoing={nowDoingLine}
        stepCounter={stepCounter}
        costSum={costSum}
        eta={liveEta}
        capUsdCents={costCap}
        onCapChange={setCostCap}
        showDetails={showDetails}
      />

      <DeployModal
        open={deployModalOpen}
        onOpenChange={setDeployModalOpen}
        onTokenSaved={() => void runDeploy()}
      />

      <DeployGateModal
        open={deployGateOpen}
        criticalDefects={selectUnresolvedCritical(defects)}
        onCancel={() => setDeployGateOpen(false)}
        onConfirm={() => {
          setDeployGateOpen(false);
          setDeployGateBypassed(true);
          // Re-trigger the deploy now that the gate is bypassed.
          void deployPreview();
        }}
      />

      {concurrentBuildPrompt ? (
        <ConcurrentBuildPromptDialog
          conflicts={concurrentBuildPrompt.conflicts}
          onRunAlongside={onRunAlongside}
          onStopOthersFirst={() => void onStopOthersFirst()}
          onCancel={onCancelConcurrentBuild}
        />
      ) : null}

      {annotationOpen ? (
        <AnnotationModal
          initialImage={annotationInitialImage}
          onSend={async ({ description, imageBytes, marks }) => {
            setAnnotationOpen(false);
            await sendBuildFeedback(
              description,
              imageBytes,
              marks,
              annotationCaptureSource,
            );
          }}
          onClose={() => setAnnotationOpen(false)}
        />
      ) : null}

      <PlanAckModal
        open={planAckOpen}
        spec={spec}
        approvedFileCount={approvedFileIds.size}
        onConfirm={() => {
          setPlanAckOpen(false);
          void performBuild();
        }}
        onCancel={() => setPlanAckOpen(false)}
        onResearchFirst={() => {
          setPlanAckOpen(false);
          void runDeepResearch();
        }}
        researchDisabled={
          ceiling.state === "stop" || researchUi.kind !== "idle"
        }
        researchDisabledReason={
          ceiling.state === "stop"
            ? "(at cost cap)"
            : researchUi.kind === "running"
              ? "(running)"
              : null
        }
      />

      {researchUi.kind === "review" ? (
        <ResearchDiffModal
          open
          originalMarkdown={researchUi.originalSpec}
          proposedMarkdown={researchUi.proposedMarkdown}
          summaryOfChanges={researchUi.summaryOfChanges}
          partial={researchUi.partial}
          onAdopt={() => void adoptResearchProposal()}
          onKeepOriginal={() => setResearchUi({ kind: "idle" })}
          onDiscard={() => setResearchUi({ kind: "idle" })}
        />
      ) : null}

      {researchUi.kind === "running" ? (
        <Alert className="mx-4 mt-3 mb-1 pr-9">
          <AlertTitle className="flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            Researching… ({researchUi.findings.length} finding
            {researchUi.findings.length === 1 ? "" : "s"} so far)
          </AlertTitle>
          <AlertDescription>
            Dave is exploring competitors, edge cases, and data-model gaps. Typically 2-5 minutes.
            Hit Stop to abandon — your spec stays unchanged.
          </AlertDescription>
          <button
            type="button"
            onClick={cancelResearchRun}
            aria-label="Stop research"
            title="Stop research"
            className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Square className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </Alert>
      ) : null}


      {isDraggingOverWorkspace ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-primary/10 backdrop-blur-sm"
        >
          <div className="rounded-lg border-2 border-dashed border-primary bg-background px-8 py-6 text-center shadow-lg">
            <p className="text-base font-semibold text-foreground">Drop to add</p>
            <p className="mt-1 text-xs text-muted-foreground">
              PDFs, screenshots, schemas, CSVs, or spreadsheets — Dave reads the structure on
              the next turn.
            </p>
          </div>
        </div>
      ) : null}
    </main>
  );
}

// Map our richer Status union onto the chat panel's narrower one.
function chatStatusFor(status: Status): ChatStatus {
  if (status.kind === "running") return { kind: "streaming" };
  if (status.kind === "streaming") return { kind: "streaming" };
  if (status.kind === "rate_limited") return { kind: "rate_limited", message: status.message };
  if (status.kind === "error") return { kind: "error", message: status.message };
  return { kind: "idle" };
}

// One workspace-level notification. Higher `priority` floats earlier.
// `render` returns the existing Alert / banner JSX so the visual design
// of each banner stays untouched — only the stacking semantics change.
export interface WorkspaceNotification {
  id: string;
  priority: number;
  render: () => React.ReactNode;
}

interface BuildNotificationsArgs {
  deployStatus:
    | { kind: "idle" }
    | { kind: "running" }
    | { kind: "success"; url: string }
    | { kind: "error"; message: string };
  onDismissDeploy: () => void;
  exportStatus:
    | { kind: "idle" }
    | { kind: "running" }
    | { kind: "success"; url: string }
    | { kind: "error"; message: string };
  onDismissExport: () => void;
  showSentryPrompt: boolean;
  onSentryDecided: () => void;
  ceiling: CostCeilingResult;
  pendingFileApproval: {
    fileId: string;
    name: string;
    summary: string;
    hasPiiWarning: boolean;
  } | null;
  pendingFileApprovalCount: number;
  onApproveFile: (fileId: string) => void;
  onSkipFile: (fileId: string) => void;
  recoveredFromCrash: boolean;
  onDismissRecoveredBanner: () => void;
  openPermissions: readonly OpenPermissionRequest[];
  onPermissionResolved: (id: string) => void;
  openDrifts: readonly DriftEvent[];
  projectPath: string;
  onDriftResolved: (resolved: DriftEvent) => void;
  reviewMarkdown: string | null;
  reviewBannerDismissed: boolean;
  onDismissReviewBanner: () => void;
  onFocusChat: () => void;
  onOpenAnnotation: () => void;
}

// Build the prioritised notification list. Priority bands:
//   100  drift event (blocks phase advancement, novice intervention)
//    95  PII file approval (privacy / consent)
//    90  cost ceiling: stop
//    85  deploy / export errors
//    80  permission request
//    75  file approval (no PII)
//    70  recovered from crash
//    60  post-build review CTA
//    55  cost ceiling: warn
//    40  deploy / export success
//    30  sentry prompt
function buildWorkspaceNotifications(
  a: BuildNotificationsArgs,
): readonly WorkspaceNotification[] {
  const out: WorkspaceNotification[] = [];
  if (a.openDrifts.length > 0 && a.openDrifts[0]) {
    const head = a.openDrifts[0];
    out.push({
      id: `drift-${head.id}`,
      priority: 100,
      render: () => (
        <DriftBanner
          event={head}
          projectPath={a.projectPath}
          totalOpen={a.openDrifts.length}
          onResolved={a.onDriftResolved}
        />
      ),
    });
  }
  if (a.pendingFileApproval) {
    const f = a.pendingFileApproval;
    out.push({
      id: `file-approval-${f.fileId}`,
      priority: f.hasPiiWarning ? 95 : 75,
      render: () => (
        <Alert
          variant={f.hasPiiWarning ? "destructive" : "default"}
          className="mx-4 mt-3 mb-1"
          role={f.hasPiiWarning ? "alert" : undefined}
        >
          <AlertTitle>
            {f.hasPiiWarning
              ? "Review personal data before using this file"
              : "Use this file in the spec?"}
            {a.pendingFileApprovalCount > 1
              ? ` (${a.pendingFileApprovalCount} pending)`
              : ""}
          </AlertTitle>
          <AlertDescription>
            <p className="mb-2 text-sm font-medium">{f.name}</p>
            <p className="mb-3 max-h-24 overflow-auto whitespace-pre-wrap text-xs">
              {f.summary}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => a.onApproveFile(f.fileId)}>
                {f.hasPiiWarning ? "Use reviewed summary" : "Use in spec"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => a.onSkipFile(f.fileId)}
              >
                Not for now
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ),
    });
  }
  if (a.ceiling.state === "stop") {
    out.push({
      id: "ceiling-stop",
      priority: 90,
      render: () => (
        <Alert variant="destructive" className="mx-4 mt-3 mb-1">
          <AlertTitle>Spend cap reached</AlertTitle>
          <AlertDescription>{a.ceiling.message}</AlertDescription>
        </Alert>
      ),
    });
  }
  if (a.deployStatus.kind === "error") {
    const msg = a.deployStatus.message;
    out.push({
      id: "deploy-error",
      priority: 85,
      render: () => (
        <Alert variant="destructive" className="relative mx-4 mt-3 mb-1 py-2 pr-9">
          <AlertTitle className="text-xs">Deploy failed</AlertTitle>
          <AlertDescription className="text-xs">{msg}</AlertDescription>
          <DismissBannerButton
            onClick={a.onDismissDeploy}
            label="Dismiss deploy error"
            variant="destructive"
          />
        </Alert>
      ),
    });
  }
  if (a.exportStatus.kind === "error") {
    const msg = a.exportStatus.message;
    out.push({
      id: "export-error",
      priority: 85,
      render: () => (
        <Alert variant="destructive" className="relative mx-4 mt-3 mb-1 py-2 pr-9">
          <AlertTitle className="text-xs">GitHub push failed</AlertTitle>
          <AlertDescription className="text-xs">{msg}</AlertDescription>
          <DismissBannerButton
            onClick={a.onDismissExport}
            label="Dismiss push error"
            variant="destructive"
          />
        </Alert>
      ),
    });
  }
  if (a.openPermissions.length > 0 && a.openPermissions[0]) {
    const head = a.openPermissions[0];
    out.push({
      id: `permission-${head.id}`,
      priority: 80,
      render: () => (
        <PermissionPromptBanner
          request={head}
          totalOpen={a.openPermissions.length}
          onResolved={a.onPermissionResolved}
        />
      ),
    });
  }
  if (a.recoveredFromCrash) {
    out.push({
      id: "recovered",
      priority: 70,
      render: () => (
        <Alert className="relative mx-4 mt-3 mb-1 pr-9">
          <AlertTitle>Recovered from crash</AlertTitle>
          <AlertDescription>
            The previous session ended unexpectedly. Click Resume to continue
            from where it left off, or Stop to drop the session and start
            fresh.
          </AlertDescription>
          <button
            type="button"
            onClick={a.onDismissRecoveredBanner}
            aria-label="Dismiss"
            title="Dismiss"
            className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </Alert>
      ),
    });
  }
  if (a.reviewMarkdown !== null && !a.reviewBannerDismissed) {
    out.push({
      id: "review-cta",
      priority: 60,
      render: () => (
        <Alert className="relative mx-4 mt-3 mb-1 pr-9">
          <AlertTitle>First-pass build done — review and iterate</AlertTitle>
          <AlertDescription>
            <p>
              Try the build below. When you spot something to change, leave a
              comment in the chat or annotate a screenshot — Dave picks up
              from where it left off.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button type="button" size="sm" onClick={a.onFocusChat}>
                Review with comments
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={a.onOpenAnnotation}
              >
                <Pencil className="mr-1 h-3 w-3" aria-hidden="true" />
                Annotate a screenshot
              </Button>
            </div>
          </AlertDescription>
          <button
            type="button"
            onClick={a.onDismissReviewBanner}
            aria-label="Dismiss review banner"
            className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </Alert>
      ),
    });
  }
  if (a.ceiling.state === "warn") {
    out.push({
      id: "ceiling-warn",
      priority: 55,
      render: () => (
        <Alert className="mx-4 mt-3 mb-1">
          <AlertTitle>Approaching spend cap</AlertTitle>
          <AlertDescription>{a.ceiling.message}</AlertDescription>
        </Alert>
      ),
    });
  }
  if (a.deployStatus.kind === "success") {
    const url = a.deployStatus.url;
    out.push({
      id: "deploy-success",
      priority: 40,
      render: () => (
        <Alert className="relative mx-4 mt-3 mb-1 py-2 pr-9">
          <AlertTitle className="text-xs">Preview deployed</AlertTitle>
          <AlertDescription className="text-xs">
            Copied to clipboard:{" "}
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              {url}
            </a>
          </AlertDescription>
          <DismissBannerButton
            onClick={a.onDismissDeploy}
            label="Dismiss preview banner"
          />
        </Alert>
      ),
    });
  }
  if (a.exportStatus.kind === "success") {
    const url = a.exportStatus.url;
    out.push({
      id: "export-success",
      priority: 40,
      render: () => (
        <Alert className="relative mx-4 mt-3 mb-1 py-2 pr-9">
          <AlertTitle className="text-xs">Pushed to GitHub</AlertTitle>
          <AlertDescription className="text-xs">
            Copied to clipboard:{" "}
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              {url}
            </a>
          </AlertDescription>
          <DismissBannerButton
            onClick={a.onDismissExport}
            label="Dismiss push banner"
          />
        </Alert>
      ),
    });
  }
  if (a.showSentryPrompt) {
    out.push({
      id: "sentry-prompt",
      priority: 30,
      render: () => <SentryPrompt onDecided={a.onSentryDecided} />,
    });
  }
  return out;
}

function DismissBannerButton({
  onClick,
  label,
  variant = "default",
}: {
  onClick: () => void;
  label: string;
  variant?: "default" | "destructive";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={
        "absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors " +
        (variant === "destructive"
          ? "text-destructive/70 hover:bg-destructive/10 hover:text-destructive"
          : "text-muted-foreground hover:bg-muted hover:text-foreground")
      }
    >
      <X className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}

function ConcurrentBuildPromptDialog({
  conflicts,
  onRunAlongside,
  onStopOthersFirst,
  onCancel,
}: {
  conflicts: { id: string; name: string }[];
  onRunAlongside: () => void;
  onStopOthersFirst: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);
  const single = conflicts.length === 1;
  const onlyName = conflicts[0]?.name ?? "";
  return (
    <dialog
      ref={ref}
      onClose={onCancel}
      aria-labelledby="concurrent-build-title"
      className="rounded-lg border bg-background p-0 text-foreground shadow-lg backdrop:bg-foreground/40"
    >
      <div className="max-w-md p-6">
        <h2 id="concurrent-build-title" className="text-base font-semibold">
          {single
            ? `${onlyName} is already building`
            : `${String(conflicts.length)} other projects are already building`}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {single
            ? `Run this build alongside it, or stop ${onlyName} first?`
            : "Run this build alongside them, or stop them first?"}
          {" "}Both can share the same Dave rate-limit budget if you run alongside.
        </p>
        {!single ? (
          <ul className="mt-2 list-disc pl-5 text-sm">
            {conflicts.map((c) => (
              <li key={c.id}>{c.name}</li>
            ))}
          </ul>
        ) : null}
        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="outline" size="sm" onClick={onRunAlongside}>
            Run alongside
          </Button>
          <Button size="sm" onClick={onStopOthersFirst} autoFocus>
            {single ? `Stop ${onlyName} first` : "Stop them first"}
          </Button>
        </div>
      </div>
    </dialog>
  );
}

function BannerStack({
  notifications,
}: {
  notifications: readonly WorkspaceNotification[];
}) {
  const [expanded, setExpanded] = useState(false);
  const sorted = [...notifications].sort((a, b) => b.priority - a.priority);
  if (sorted.length === 0) return null;
  const head = sorted[0]!;
  const rest = sorted.slice(1);
  return (
    <div className="shrink-0">
      <div key={head.id}>{head.render()}</div>
      {rest.length > 0 ? (
        <div className="mx-4 -mt-1 mb-1 flex justify-end">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="rounded-md border bg-background px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {expanded ? "Hide" : `+${rest.length} more`}
          </button>
        </div>
      ) : null}
      {expanded
        ? rest.map((n) => <div key={n.id}>{n.render()}</div>)
        : null}
    </div>
  );
}

function StatusFooter({
  targetState,
  projectStatus,
  runtimeStatus,
  nowDoing,
  stepCounter,
  costSum,
  eta,
  capUsdCents,
  onCapChange,
  showDetails,
}: {
  targetState: TargetState | null;
  projectStatus: Project["status"];
  runtimeStatus: Status;
  nowDoing: string | null;
  stepCounter: string | null;
  costSum: CostSum | null;
  eta: EtaResult;
  capUsdCents: number | null;
  onCapChange: (cap: number | null) => void;
  showDetails: boolean;
}) {
  const dollars = costSum ? (costSum.usdCents / 100).toFixed(2) : "0.00";
  const capDollars = capUsdCents !== null ? (capUsdCents / 100).toFixed(2) : "";

  // Compose a human-readable status from three sources, in priority order:
  //   1. The runtime Status state (idle/running/streaming/error/rate_limited)
  //      — most live; flips the moment the user clicks Build / Stop.
  //   2. The project's DB row status — survives reloads, always populated.
  //   3. targetState.status — only set if the orchestrator wrote state.json
  //      (most builds don't), so it's the last-resort fallback.
  let statusLabel: string;
  let statusTone: "live" | "warn" | "error" | "muted" = "muted";
  if (runtimeStatus.kind === "running" || runtimeStatus.kind === "streaming") {
    statusLabel = stepCounter ? `Building (${stepCounter})` : "Building";
    statusTone = "live";
  } else if (runtimeStatus.kind === "rate_limited") {
    statusLabel = "Paused — rate limit";
    statusTone = "warn";
  } else if (runtimeStatus.kind === "error") {
    statusLabel = "Error";
    statusTone = "error";
  } else {
    // idle — fall back to DB-row status
    switch (projectStatus) {
      case "interviewing":
        statusLabel = "Interviewing";
        break;
      case "ready":
        statusLabel = "Ready to build";
        break;
      case "building":
        // DB says building but runtime is idle — typically a stale crash flag.
        statusLabel = "Was building (paused)";
        statusTone = "warn";
        break;
      case "paused":
        statusLabel = "Paused";
        break;
      case "done":
        statusLabel = "Done";
        break;
      default:
        statusLabel = targetState?.status ?? "unknown";
    }
  }
  const toneClass =
    statusTone === "live"
      ? "text-primary font-medium"
      : statusTone === "warn"
        ? "text-yellow-600"
        : statusTone === "error"
          ? "text-destructive"
          : "text-foreground";

  return (
    <footer className="flex items-center justify-between gap-4 border-t px-6 py-2 text-xs text-muted-foreground">
      <div className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-1">
        <span className="flex items-center gap-1">
          {statusTone === "live" ? (
            <span aria-hidden="true" className="relative inline-flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60 motion-reduce:hidden" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
            </span>
          ) : null}
          Status: <span className={toneClass}>{statusLabel}</span>
        </span>
        {nowDoing ? (
          <span className="min-w-0 max-w-md truncate" title={nowDoing}>
            <span className="text-foreground">{nowDoing}</span>
          </span>
        ) : null}
        <span>
          Cost: <span className="text-foreground">${dollars}</span>
        </span>
        {showDetails ? (
          <>
            {targetState?.phase ? (
              <span>
                Phase: <span className="text-foreground">{targetState.phase}</span>
              </span>
            ) : null}
            {costSum ? (
              <span>
                {costSum.turns} turn{costSum.turns === 1 ? "" : "s"} · in {costSum.inputTokens} / out{" "}
                {costSum.outputTokens}
              </span>
            ) : null}
            <span>
              ETA per turn: <span className="text-foreground">{formatEta(eta.medianMs, eta.mode)}</span>
            </span>
            <label className="flex items-center gap-1">
              Cap $
              <input
                type="number"
                min="0"
                step="1"
                value={capDollars}
                placeholder="off"
                onChange={(e) => {
                  const v = e.target.value.trim();
                  if (v === "") {
                    onCapChange(null);
                    return;
                  }
                  const usd = Number.parseFloat(v);
                  if (!Number.isFinite(usd) || usd <= 0) {
                    onCapChange(null);
                    return;
                  }
                  onCapChange(Math.round(usd * 100));
                }}
                aria-label="Optional spend cap in USD"
                className="w-16 rounded border bg-background px-1 py-0.5 text-xs"
              />
            </label>
          </>
        ) : null}
      </div>
      <Link href="/" className="shrink-0 underline">
        Home
      </Link>
    </footer>
  );
}
