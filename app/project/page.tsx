"use client";

import { invoke } from "@tauri-apps/api/core";
import {
  GitBranch,
  Loader2,
  Play,
  Rocket,
  Square,
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
import { DeployModal } from "@/components/features/project-workspace/deploy-modal";
import { DriftBanner } from "@/components/features/project-workspace/drift-banner";
import {
  PermissionPromptBanner,
  type OpenPermissionRequest,
} from "@/components/features/project-workspace/permission-prompt-banner";
import { RightRail, type RightTab } from "@/components/features/project-workspace/right-rail";
import { StagesBar } from "@/components/features/project-workspace/stages-bar";
import { ackForIntent, detectIntent } from "@/lib/chat-intent";
import { chatSend, type ChatChunk, type QueuedQuestion } from "@/lib/chat/client";
import {
  readHistoryLogTail,
  readReviewMarkdown,
  readTargetState,
  type HistoryActionEntry,
  type TargetState,
} from "@/lib/build-state";
import {
  evaluate as evaluateCostCeiling,
  readCapFromStorage,
  writeCapToStorage,
  type CostCeilingResult,
} from "@/lib/cost-ceiling";
import { deployToVercel, getVercelToken, isVercelInstalled } from "@/lib/deploy";
import { listOpenDrifts, type DriftEvent } from "@/lib/drift";
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
import { translate } from "@/lib/orchestrator/translate";
import type { Project } from "@/lib/project";
import { sidecarCall } from "@/lib/sidecar/client";
import { hasMadeSentryDecision } from "@/lib/telemetry";

// Unified project workspace. Replaces the old /interview + /build split:
// one chat column on the left, one tabbed right rail (Spec / Plan / Activity
// / Review / Files). Mode is derived from project state — "Build it" flips
// the rail in place rather than navigating to a different page.

const HISTORY_TAIL_LIMIT = 200;

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

  // Chat scrollback (unified; interview turns + build turns share the column).
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  // Spec / readiness / interview pipeline
  const [spec, setSpec] = useState<string>("");
  const [readiness, setReadiness] = useState<ReadinessResult>(() => checkReadiness([]));
  const [questionQueue, setQuestionQueue] = useState<readonly QueuedQuestion[]>([]);
  const [bufferedAnswers, setBufferedAnswers] = useState<
    readonly { id: string; text: string; question: string }[]
  >([]);
  const [isPreparingBank, setIsPreparingBank] = useState(false);
  const interviewSessionRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Files (drag-drop ingest)
  const [files, setFiles] = useState<readonly IngestedFile[]>([]);

  // Build orchestrator state
  const [targetState, setTargetState] = useState<TargetState | null>(null);
  const [actions, setActions] = useState<readonly HistoryActionEntry[]>([]);
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

  // Tab state — auto-switches as mode changes; user can override.
  const [tab, setTab] = useState<RightTab>("spec");
  const tabPinnedRef = useRef(false);

  // Pin the current project as a visible tab in the strip. The strip
  // shows opened-only projects, not every project in the DB; without this
  // call a project visited via deep link wouldn't get a tab.
  const { ensureOpen: ensureTabOpen } = useOpenTabs();

  // If another open project's build is already running, the orchestrator
  // singleton can't take a second one. We surface a banner with the
  // offending project's name + a deep link to switch tabs.
  const [otherBuildBlock, setOtherBuildBlock] = useState<{
    projectId: string;
    name: string;
  } | null>(null);

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

  // ---- Project load + hydration ------------------------------------------
  useEffect(() => {
    if (!projectId) {
      setLoadError("No project selected. Open one from the Welcome screen.");
      return;
    }
    let cancelled = false;
    void (async () => {
      const r = await sidecarCall<Project | null>("projects.get", { id: projectId });
      if (cancelled) return;
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
        (entries) => setActions(entries),
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

  // Pull spec from answers and rebuild the preview.
  const refreshSpec = useCallback(async (): Promise<void> => {
    if (!projectId) return;
    const r = await sidecarCall<AnswerRow[]>("answers.list", { projectId });
    r.match(
      (rows) => {
        const rebuildAnswers = rows.map(rowToRebuildAnswer);
        try {
          setSpec(rebuildSpec(rebuildAnswers));
        } catch (e) {
          setSpec(`# Spec preview error\n\n${e instanceof Error ? e.message : String(e)}`);
        }
        setReadiness(checkReadiness(rebuildAnswers));
      },
      () => undefined,
    );
  }, [projectId]);

  useEffect(() => {
    if (project) void refreshSpec();
  }, [project, refreshSpec]);

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
      `${STAGE_SENTINELS.ready} Say "build it" when you're ready and I'll start, or keep talking to flesh out anything I missed.`,
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
    setTab(t);
  };

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

  const sendInterview = async (text: string): Promise<void> => {
    if (!project) return;
    const isFirstTurn = interviewSessionRef.current === null;
    setStatus({ kind: "streaming" });
    if (isFirstTurn) setIsPreparingBank(true);
    const r = await chatSend({
      prompt: text,
      sessionId: interviewSessionRef.current,
      projectId: project.id,
      projectPath: project.path,
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
        setPlan(event.todos);
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
      } else if (event.kind === "done") {
        if (turnStartRef.current !== null) {
          const elapsed = Date.now() - turnStartRef.current;
          setTurnDurations((prev) => [...prev, elapsed]);
          turnStartRef.current = null;
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
          reviewRes.match((md) => setReviewMarkdown(md), () => undefined);
        })();
      } else if (event.kind === "rate_limit") {
        setStatus({ kind: "rate_limited", message: event.message });
      } else if (event.kind === "error") {
        setStatus({ kind: "error", message: event.message });
      }
    },
    [project],
  );

  const startBuild = useCallback(async (): Promise<void> => {
    if (!project || status.kind === "running" || status.kind === "streaming") return;

    // Refuse to start a second concurrent build. The orchestrator subprocess
    // is process-global; running two would either error on spawn or compete
    // for the same claude auth's rate limit. Query DB-persisted status —
    // anything marked "building" by another project is a live siblings.
    const listResult = await sidecarCall<Project[]>("projects.list", {});
    if (listResult.isOk()) {
      const conflict = listResult.value.find(
        (p) => p.id !== project.id && p.status === "building",
      );
      if (conflict) {
        setOtherBuildBlock({ projectId: conflict.id, name: conflict.name });
        return;
      }
    }
    setOtherBuildBlock(null);

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

    // Write the rebuilt spec.md so claude reads real interview answers.
    const answersResult = await sidecarCall<AnswerRow[]>("answers.list", {
      projectId: project.id,
    });
    if (answersResult.isOk() && answersResult.value.length > 0) {
      try {
        const specMarkdown = rebuildSpec(answersResult.value.map(rowToRebuildAnswer));
        await invoke("write_target_spec", {
          projectPath: project.path,
          specText: specMarkdown,
        });
      } catch (e) {
        console.warn("Failed to write rebuilt spec.md:", e);
      }
    }

    turnStartRef.current = Date.now();
    let terminal: Status = { kind: "idle" };
    const r = await orchestratorStart({
      projectId: project.id,
      projectPath: project.path,
      sessionId: buildSessionRef.current,
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
  }, [project, status.kind, buildEventHandler]);

  const stopBuild = useCallback(async (): Promise<void> => {
    if (!project) return;
    await orchestratorStop();
    buildSessionRef.current = null;
    setStatus({ kind: "idle" });
    await sidecarCall("projects.setStatus", {
      id: project.id,
      status: "ready",
      currentSessionId: null,
    });
  }, [project]);

  const runFollowUpTurn = useCallback(
    async (prompt: string): Promise<void> => {
      if (!project || status.kind === "running" || status.kind === "streaming") return;
      setStatus({ kind: "running" });
      setLatestToolLine(`You said: ${prompt.slice(0, 80)}…`);
      turnStartRef.current = Date.now();
      const r = await orchestratorStart({
        projectId: project.id,
        projectPath: project.path,
        sessionId: buildSessionRef.current,
        prompt,
        onEvent: buildEventHandler,
      });
      r.match(
        () => setStatus((prev) => (prev.kind === "running" ? { kind: "idle" } : prev)),
        (e) => setStatus({ kind: "error", message: e.message }),
      );
    },
    [project, status.kind, buildEventHandler],
  );

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
    if (status.kind === "streaming" || status.kind === "running") return;

    // Intent matcher first: short imperative messages like "build it",
    // "deploy", "stop" trigger the corresponding action so the chat is the
    // primary control surface, not the buttons. Long messages or anything
    // ambiguous fall through to the regular chat path.
    const intent = detectIntent(trimmed, {
      hasStarted,
      isRunning,
      hasReview: reviewMarkdown !== null,
    });
    if (intent !== "none") {
      echoUserMessage(trimmed, ackForIntent(intent));
      setInput("");
      switch (intent) {
        case "build":
          void startBuild();
          return;
        case "stop":
          void stopBuild();
          return;
        case "deploy":
          void deployPreview();
          return;
        case "push":
          void exportToGithubFlow();
          return;
      }
    }

    if (!hasStarted) {
      // Pre-build: interview chat. If a queued question exists, treat the
      // input as that question's freeform answer; otherwise it's a freeform
      // turn (the initial pitch, or a between-batches user prompt).
      if (questionQueue[0]) {
        submitAnswerForHead(trimmed);
        return;
      }
      echoUserMessage(trimmed);
      setInput("");
      void sendInterview(trimmed);
      return;
    }

    // Build mode: send as a follow-up turn to the running session.
    echoUserMessage(trimmed);
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
    void runDeploy();
  }, [project, runDeploy]);

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
  // banner stack already shows the live tail; this nudges the novice to
  // type the next imperative ("deploy", "push") instead of hunting for
  // buttons.
  useEffect(() => {
    if (announcedReviewRef.current) return;
    if (reviewMarkdown === null) return;
    announcedReviewRef.current = true;
    appendAssistantMessage(
      `${STAGE_SENTINELS.review} — the plan and activity are in the right rail. Say "deploy" for a Vercel preview, "push" to back the code up to GitHub, or keep chatting with me to fill any gaps.`,
    );
  }, [reviewMarkdown, appendAssistantMessage, STAGE_SENTINELS.review]);

  // Stage 3: deploy preview just succeeded.
  useEffect(() => {
    if (announcedDeployedRef.current) return;
    if (deployStatus.kind !== "success") return;
    announcedDeployedRef.current = true;
    appendAssistantMessage(
      `${STAGE_SENTINELS.deployed} ${deployStatus.url}. Say "push" if you want to back this up to GitHub too.`,
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
    setTab("files");
  };

  // ---- Derived UI labels -----------------------------------------------
  const isRunning = status.kind === "running" || status.kind === "streaming";
  const isBlocked = isRunning || status.kind === "rate_limited" || !project;
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
          {!hasStarted && (
            <span className="text-xs text-muted-foreground" aria-label="Fast-path interview progress">
              {readiness.fastPathAnswered} / {readiness.fastPathTotal} answered
            </span>
          )}
          {isRunning ? (
            <Button size="sm" variant="outline" onClick={() => void stopBuild()} title="Stop the build">
              <Square className="mr-1 h-3 w-3" />
              Stop
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={ceiling.state === "stop"}
              onClick={() => void startBuild()}
            >
              <Play className="mr-1 h-3 w-3" />
              {hasStarted ? "Resume" : "Build it"}
            </Button>
          )}
          {hasStarted ? (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void deployPreview()}
                disabled={deployStatus.kind === "running"}
                title="Deploy a preview to Vercel"
              >
                {deployStatus.kind === "running" ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                ) : (
                  <Rocket className="mr-1 h-3 w-3" />
                )}
                Deploy
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void exportToGithubFlow()}
                disabled={exportStatus.kind === "running"}
                title="Push the project folder to a private GitHub repo"
              >
                {exportStatus.kind === "running" ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                ) : (
                  <GitBranch className="mr-1 h-3 w-3" />
                )}
                Push to GitHub
              </Button>
            </>
          ) : null}
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

      {hasStarted ? (
        <div className="border-b bg-primary/5 px-6 py-3">
          <div className="flex items-center gap-3">
            {isRunning ? (
              <Loader2 className="h-4 w-4 animate-spin text-primary motion-reduce:animate-none" />
            ) : (
              <span className="inline-block h-2 w-2 rounded-full bg-muted-foreground/40" />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">
                {nowDoingLine ?? (isRunning ? "Working…" : "Ready when you are.")}
              </p>
              {stepCounter ? (
                <p className="text-[11px] text-muted-foreground">{stepCounter}</p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <BannerStack
        deployStatus={deployStatus}
        exportStatus={exportStatus}
        showSentryPrompt={showSentryPrompt}
        onSentryDecided={() => setShowSentryPrompt(false)}
        ceiling={ceiling}
        recoveredFromCrash={recoveredFromCrash}
        openPermissions={openPermissions}
        onPermissionResolved={(id) =>
          setOpenPermissions((prev) => prev.filter((p) => p.id !== id))
        }
        openDrifts={openDrifts}
        projectPath={project.path}
        onDriftResolved={(resolved) =>
          setOpenDrifts((prev) => prev.filter((d) => d.id !== resolved.id))
        }
        otherBuildBlock={otherBuildBlock}
        onDismissOtherBuildBlock={() => setOtherBuildBlock(null)}
      />

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_400px]">
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
        />

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
          files={files}
          onFilesDropped={handleFilesDropped}
        />
      </div>

      <StatusFooter
        targetState={targetState}
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

      {isDraggingOverWorkspace ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-primary/10 backdrop-blur-sm"
        >
          <div className="rounded-lg border-2 border-dashed border-primary bg-background px-8 py-6 text-center shadow-lg">
            <p className="text-base font-semibold text-foreground">Drop to add</p>
            <p className="mt-1 text-xs text-muted-foreground">
              PDFs, screenshots, schemas, CSVs, or spreadsheets — Claude reads the structure on
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

interface BannerStackProps {
  deployStatus:
    | { kind: "idle" }
    | { kind: "running" }
    | { kind: "success"; url: string }
    | { kind: "error"; message: string };
  exportStatus:
    | { kind: "idle" }
    | { kind: "running" }
    | { kind: "success"; url: string }
    | { kind: "error"; message: string };
  showSentryPrompt: boolean;
  onSentryDecided: () => void;
  ceiling: CostCeilingResult;
  recoveredFromCrash: boolean;
  openPermissions: readonly OpenPermissionRequest[];
  onPermissionResolved: (id: string) => void;
  openDrifts: readonly DriftEvent[];
  projectPath: string;
  onDriftResolved: (resolved: DriftEvent) => void;
  otherBuildBlock: { projectId: string; name: string } | null;
  onDismissOtherBuildBlock: () => void;
}

function BannerStack(props: BannerStackProps) {
  return (
    <div className="shrink-0">
      {props.deployStatus.kind === "success" ? (
        <Alert className="mx-4 mt-3 mb-1">
          <AlertTitle>Preview deployed</AlertTitle>
          <AlertDescription>
            Copied to clipboard:{" "}
            <a
              href={props.deployStatus.url}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              {props.deployStatus.url}
            </a>
          </AlertDescription>
        </Alert>
      ) : null}
      {props.deployStatus.kind === "error" ? (
        <Alert variant="destructive" className="mx-4 mt-3 mb-1">
          <AlertTitle>Deploy failed</AlertTitle>
          <AlertDescription>{props.deployStatus.message}</AlertDescription>
        </Alert>
      ) : null}
      {props.exportStatus.kind === "success" ? (
        <Alert className="mx-4 mt-3 mb-1">
          <AlertTitle>Pushed to GitHub</AlertTitle>
          <AlertDescription>
            Copied to clipboard:{" "}
            <a
              href={props.exportStatus.url}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              {props.exportStatus.url}
            </a>
          </AlertDescription>
        </Alert>
      ) : null}
      {props.exportStatus.kind === "error" ? (
        <Alert variant="destructive" className="mx-4 mt-3 mb-1">
          <AlertTitle>GitHub push failed</AlertTitle>
          <AlertDescription>{props.exportStatus.message}</AlertDescription>
        </Alert>
      ) : null}
      {props.showSentryPrompt ? <SentryPrompt onDecided={props.onSentryDecided} /> : null}
      {props.ceiling.state === "warn" || props.ceiling.state === "stop" ? (
        <Alert
          variant={props.ceiling.state === "stop" ? "destructive" : "default"}
          className="mx-4 mt-3 mb-1"
        >
          <AlertTitle>
            {props.ceiling.state === "stop" ? "Spend cap reached" : "Approaching spend cap"}
          </AlertTitle>
          <AlertDescription>{props.ceiling.message}</AlertDescription>
        </Alert>
      ) : null}
      {props.otherBuildBlock ? (
        <Alert className="mx-4 mt-3 mb-1">
          <AlertTitle>Another build is running</AlertTitle>
          <AlertDescription>
            <span className="font-medium">{props.otherBuildBlock.name}</span> is currently
            building. Switch to its tab and Stop or wait for it to finish, then come back.{" "}
            <Link
              href={`/project?id=${encodeURIComponent(props.otherBuildBlock.projectId)}`}
              className="underline"
              onClick={props.onDismissOtherBuildBlock}
            >
              Open {props.otherBuildBlock.name}
            </Link>
          </AlertDescription>
        </Alert>
      ) : null}
      {props.recoveredFromCrash ? (
        <Alert className="mx-4 mt-3 mb-1">
          <AlertTitle>Recovered from crash</AlertTitle>
          <AlertDescription>
            The previous session ended unexpectedly. Click Resume to continue from where it left
            off, or Stop to drop the session and start fresh.
          </AlertDescription>
        </Alert>
      ) : null}
      {props.openPermissions.length > 0 && props.openPermissions[0] ? (
        <PermissionPromptBanner
          request={props.openPermissions[0]}
          totalOpen={props.openPermissions.length}
          onResolved={(id) => props.onPermissionResolved(id)}
        />
      ) : null}
      {props.openDrifts.length > 0 && props.openDrifts[0] ? (
        <DriftBanner
          event={props.openDrifts[0]}
          projectPath={props.projectPath}
          totalOpen={props.openDrifts.length}
          onResolved={props.onDriftResolved}
        />
      ) : null}
    </div>
  );
}

function StatusFooter({
  targetState,
  costSum,
  eta,
  capUsdCents,
  onCapChange,
  showDetails,
}: {
  targetState: TargetState | null;
  costSum: CostSum | null;
  eta: EtaResult;
  capUsdCents: number | null;
  onCapChange: (cap: number | null) => void;
  showDetails: boolean;
}) {
  const dollars = costSum ? (costSum.usdCents / 100).toFixed(2) : "0.00";
  const capDollars = capUsdCents !== null ? (capUsdCents / 100).toFixed(2) : "";
  return (
    <footer className="flex items-center justify-between gap-4 border-t px-6 py-2 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
        <span>
          Cost: <span className="text-foreground">${dollars}</span>
        </span>
        {showDetails ? (
          <>
            <span>
              Status: <span className="text-foreground">{targetState?.status ?? "unknown"}</span>
            </span>
            <span>
              Phase: <span className="text-foreground">{targetState?.phase ?? "(none)"}</span>
            </span>
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
      <Link href="/" className="underline">
        Home
      </Link>
    </footer>
  );
}
