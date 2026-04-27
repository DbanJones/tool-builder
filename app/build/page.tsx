"use client";

import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, ChevronRight, GitBranch, Loader2, Play, Rocket, Square } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
import { exportToGithub, isGhInstalled } from "@/lib/export";
import { listOpenDrifts, type DriftEvent } from "@/lib/drift";
import { estimate, formatEta, type EtaResult } from "@/lib/eta";
import type { QuestionId } from "@/lib/interview/library";
import { rebuildSpec } from "@/lib/interview/rebuild-spec";
import {
  orchestratorStart,
  orchestratorStop,
  type OrchestratorEvent,
  type TodoItem,
} from "@/lib/orchestrator";
import { translate } from "@/lib/orchestrator/translate";
import { hasMadeSentryDecision } from "@/lib/telemetry";

import { SentryPrompt } from "@/app/components/sentry-prompt";

import { DeployModal } from "./components/deploy-modal";
import { DriftBanner } from "./components/drift-banner";
import {
  PermissionPromptBanner,
  type OpenPermissionRequest,
} from "./components/permission-prompt-banner";
import type { Project } from "@/lib/project";
import { sidecarCall } from "@/lib/sidecar/client";

// Build dashboard per kit §14.5.1: header (project + controls), phase bar,
// task lane, live tail, status footer. Reads existing state.json +
// history.log on mount so a paused project shows everything populated even
// before the orchestrator emits a new event. New tool_use events arrive via
// the orchestrator Channel, get translated, and append to the live tail.

const HISTORY_TAIL_LIMIT = 200;

interface DashboardStatus {
  kind: "idle" | "running" | "rate_limited" | "error";
  message?: string;
}

// Mirrors sidecar/src/handlers/costs.ts CostSum. Re-declared here since the
// sidecar doesn't currently emit TS types to the webview.
interface CostSum {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  usdCents: number;
}

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

export default function BuildPage() {
  return (
    <Suspense fallback={<Skeleton />}>
      <BuildClient />
    </Suspense>
  );
}

function Skeleton() {
  return (
    <main className="flex h-screen items-center justify-center text-sm text-muted-foreground">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading dashboard…
    </main>
  );
}

function BuildClient() {
  const params = useSearchParams();
  const projectId = params.get("project");
  // UX5: when the interview's "Build it" button hands off here it sets
  // autostart=1 so the dashboard kicks the orchestrator on mount instead
  // of forcing the novice to find a second "Start" button.
  const autostart = params.get("autostart") === "1";

  const [project, setProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [targetState, setTargetState] = useState<TargetState | null>(null);
  const [actions, setActions] = useState<readonly HistoryActionEntry[]>([]);
  const [status, setStatus] = useState<DashboardStatus>({ kind: "idle" });
  const [costSum, setCostSum] = useState<CostSum | null>(null);
  const [openDrifts, setOpenDrifts] = useState<readonly DriftEvent[]>([]);
  // BD1 plan panel: latest TodoWrite snapshot + the human line of the most
  // recent tool call. Drives the steps panel + the status strip under the
  // header so the novice always sees the pathway.
  const [plan, setPlan] = useState<readonly TodoItem[]>([]);
  const [latestToolLine, setLatestToolLine] = useState<string | null>(null);
  // End-of-build coverage report (.builder/review.md). Re-read after every
  // `done` event; rendered as the prominent finish-state panel when present.
  const [reviewMarkdown, setReviewMarkdown] = useState<string | null>(null);
  // Show details (activity log, project path, advanced controls) only when
  // the novice asks for them. By default we show the simple step view.
  const [showDetails, setShowDetails] = useState(false);
  // True when the project's persisted status was "building" but no
  // subprocess is alive on app open — Flow H AC4. Cleared on Resume/Stop.
  const [recoveredFromCrash, setRecoveredFromCrash] = useState(false);
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
  // The latest claude session id observed during the run, used by Resume.
  // Initially loaded from project.currentSessionId so a paused project can
  // resume across an app restart.
  const sessionIdRef = useRef<string | null>(null);
  // Optional spend cap (USD cents). null = "no cap" (the spec default per
  // §6 + L23). Stored in localStorage per project so it survives reloads
  // without needing a DB migration; if a real per-project setting is
  // needed later, swap the storage backend without changing the UI.
  const [costCap, setCostCap] = useState<number | null>(null);
  // E5 Sentry opt-in prompt: shown ONCE after the user's first successful
  // build (the first `done` event since mount, gated on no prior decision).
  const [showSentryPrompt, setShowSentryPrompt] = useState(false);
  // Open permission requests claude has emitted via the orchestrator MCP.
  // Polled every 1s while a build is running. The banner renders the head;
  // Allow / Deny resolves via the sidecar and the MCP tool returns the
  // decision to claude.
  const [openPermissions, setOpenPermissions] = useState<readonly OpenPermissionRequest[]>([]);
  // Past per-turn elapsed durations (ms). Updated on each `done` event;
  // feeds the ETA estimator. v1 granularity is per-turn; D5 swaps to
  // per-task-id when phase markers are wired (drift D-014).
  const [turnDurations, setTurnDurations] = useState<readonly number[]>([]);
  const turnStartRef = useRef<number | null>(null);
  const tailRef = useRef<HTMLDivElement>(null);

  // Load project + state.json + history.log tail on mount.
  useEffect(() => {
    if (!projectId) {
      setLoadError("No project selected. Open one from the Welcome screen.");
      return;
    }
    let cancelled = false;
    void (async () => {
      const projectResult = await sidecarCall<Project | null>("projects.get", { id: projectId });
      if (cancelled) return;
      projectResult.match(
        (p) => {
          if (p === null) {
            setLoadError(`Project ${projectId} not found.`);
            return;
          }
          setProject(p);
          sessionIdRef.current = p.currentSessionId;
          // Crash recovery (Flow H AC3 + AC4): the only writer of the
          // "building" status is startBuild; if we open the dashboard and
          // it's still set, the previous app process died mid-build. Mark
          // the project as paused so the next Start/Resume click is a
          // deliberate decision.
          if (p.status === "building") {
            setRecoveredFromCrash(true);
            void sidecarCall<Project>("projects.setStatus", { id: p.id, status: "paused" });
          }
          void hydrateBuildArtefacts(p.id, p.path);
        },
        (e) => setLoadError(e.message),
      );
    })();

    async function hydrateBuildArtefacts(pid: string, projectPath: string): Promise<void> {
      const stateResult = await readTargetState(projectPath);
      if (cancelled) return;
      stateResult.match(
        (s) => setTargetState(s),
        (e) => setLoadError(`state.json: ${e.message}`),
      );

      const tailResult = await readHistoryLogTail(projectPath, HISTORY_TAIL_LIMIT);
      if (cancelled) return;
      tailResult.match(
        (entries) => setActions(entries),
        (e) => setLoadError(`history.log: ${e.message}`),
      );

      const costResult = await sidecarCall<CostSum>("costs.sumByProject", { projectId: pid });
      if (cancelled) return;
      costResult.match(
        (sum) => setCostSum(sum),
        () => {
          /* non-fatal — meter just shows "$0.00" */
        },
      );

      const driftResult = await listOpenDrifts(pid);
      if (cancelled) return;
      driftResult.match(
        (events) => setOpenDrifts(events),
        () => {
          /* non-fatal — banner just doesn't render */
        },
      );

      const reviewResult = await readReviewMarkdown(projectPath);
      if (cancelled) return;
      reviewResult.match(
        (md) => setReviewMarkdown(md),
        () => {
          /* non-fatal — review panel renders the placeholder */
        },
      );
    }

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Auto-scroll the live tail when new events arrive.
  useEffect(() => {
    tailRef.current?.scrollTo({ top: tailRef.current.scrollHeight });
  }, [actions]);

  // Poll for open permission requests while a build is running. 1s cadence
  // is responsive enough for novice approvals without thrashing the DB.
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

  // Load the saved cost cap when the project becomes available.
  useEffect(() => {
    if (project) {
      setCostCap(readCapFromStorage(project.id));
    }
  }, [project]);

  // Persist on change.
  useEffect(() => {
    if (project) writeCapToStorage(project.id, costCap);
  }, [project, costCap]);

  const ceiling: CostCeilingResult = evaluateCostCeiling(costSum?.usdCents ?? 0, costCap);

  // UX5: when the dashboard loads with ?autostart=1 (the interview's "Build
  // it" handoff), fire startBuild once the project is loaded and we're idle.
  // Guarded by a ref so re-renders don't retrigger the spawn. We refuse to
  // autostart when the project was crash-recovered — that case still needs a
  // deliberate Resume click so the novice can decide whether to keep going.
  const autostartFiredRef = useRef(false);

  const startBuild = useCallback(async (): Promise<void> => {
    if (!project || status.kind === "running") return;

    // Pre-flight capability probe (added per user feedback 2026-04-27 after
    // repeated "can't write to directory" failures). Verifies the project
    // folder exists + is writable + .builder/ creatable + claude CLI on
    // PATH BEFORE we spawn — surfaces problems with a clear actionable
    // message instead of letting the spawn fail 30 seconds later.
    setStatus({ kind: "running" });
    try {
      const probe = await invoke<{
        ok: boolean;
        errors: string[];
        checkedPath: string;
      }>("build_capability_check", { projectPath: project.path });
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
    // Mark the project as building BEFORE we spawn so a hard crash mid-turn
    // is detectable on next mount (the only writer of "building" is here).
    void sidecarCall("projects.setStatus", { id: project.id, status: "building" });

    // Write the rebuilt spec into the project's spec.md before spawning, so
    // claude reads real interview answers instead of the placeholder template
    // (live-tested 2026-04-26: claude went off on VS Code tangents because
    // spec.md was the placeholder). Skips on first start with no answers.
    const answersResult = await sidecarCall<AnswerRow[]>("answers.list", { projectId: project.id });
    if (answersResult.isOk() && answersResult.value.length > 0) {
      try {
        const rebuildAnswers = answersResult.value.map((row) => ({
          questionId: row.questionId as QuestionId,
          answerText: row.answerText,
          confidence: row.confidence,
          source: row.source,
          rationale: row.rationale,
        }));
        const specMarkdown = rebuildSpec(rebuildAnswers);
        await invoke("write_target_spec", {
          projectPath: project.path,
          specText: specMarkdown,
        });
      } catch (e) {
        // Non-fatal: claude reads the placeholder; the chat input lets the
        // novice paste their requirements directly.
        console.warn("Failed to write rebuilt spec.md:", e);
      }
    }

    const historyLogPath = project.path.replace(/\/$/, "") + "/.builder/history.log";
    let terminal: DashboardStatus = { kind: "idle" };
    turnStartRef.current = Date.now();
    const sessionIdAtStart = sessionIdRef.current;

    const r = await orchestratorStart({
      projectId: project.id,
      projectPath: project.path,
      sessionId: sessionIdAtStart,
      onEvent: (event: OrchestratorEvent) => {
        if (event.kind === "session") {
          // Reset the turn clock on the first event of the turn (mirrors
          // claude's session.init arrival). Persist the session id so a
          // pause / crash followed by Resume can pass --resume <id>.
          turnStartRef.current = Date.now();
          sessionIdRef.current = event.id;
          void sidecarCall("projects.setStatus", {
            id: project.id,
            status: "building",
            currentSessionId: event.id,
          });
        } else if (event.kind === "done") {
          if (turnStartRef.current !== null) {
            const elapsed = Date.now() - turnStartRef.current;
            setTurnDurations((prev) => [...prev, elapsed]);
            turnStartRef.current = null;
          }
          // First-successful-build trigger for the Sentry opt-in prompt.
          // Shown at most once per app install (decision persists in
          // localStorage). O7 + spec §8 default.
          if (!hasMadeSentryDecision()) {
            setShowSentryPrompt(true);
          }
          // Persist the turn's cost row for the meter, then re-read the
          // aggregate AND re-poll open drifts (claude may have appended
          // some during the turn via its own /recheck pass — D5b) AND
          // re-read .builder/review.md (the end-of-build review file).
          // Orchestrator currently spawns claude with --model sonnet.
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
            sumRes.match(
              (sum) => setCostSum(sum),
              () => undefined,
            );
            const driftRes = await listOpenDrifts(project.id);
            driftRes.match(
              (events) => setOpenDrifts(events),
              () => undefined,
            );
            const reviewRes = await readReviewMarkdown(project.path);
            reviewRes.match(
              (md) => setReviewMarkdown(md),
              () => undefined,
            );
          })();
        } else if (event.kind === "todos_updated") {
          setPlan(event.todos);
        } else if (event.kind === "tool_use") {
          const humanLine = translate(event.tool, event.raw_input);
          setLatestToolLine(humanLine);
          // Optimistic append. The sidecar persists in parallel; we don't
          // wait on it because the goal is sub-200ms tail latency (Flow F
          // AC2 — measurement deferred until D4).
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
          void sidecarCall("actions.append", {
            projectId: project.id,
            tool: event.tool,
            rawInput: event.raw_input,
            humanLine,
            historyLogPath,
          });
        } else if (event.kind === "rate_limit") {
          terminal = { kind: "rate_limited", message: event.message };
          setStatus(terminal);
        } else if (event.kind === "error") {
          terminal = { kind: "error", message: event.message };
          setStatus(terminal);
        }
      },
    });
    r.mapErr((e) => {
      terminal = { kind: "error", message: e.message };
      setStatus(terminal);
    });
    if (terminal.kind === "idle") {
      setStatus({ kind: "idle" });
      // Natural turn end: park the project in "paused" so the novice's next
      // click is a deliberate Resume, not an accidental new turn.
      void sidecarCall("projects.setStatus", { id: project.id, status: "paused" });
    }
  }, [project, status.kind]);

  // Send a follow-up turn to the running session (resumes via sessionIdRef).
  // Used by the Review panel's "Build the missing pieces" button. Mirrors
  // the chat-input's onSend so it gets the same cost/drift/review re-reads.
  const runFollowUpTurn = useCallback(
    async (prompt: string): Promise<void> => {
      if (!project) return;
      if (status.kind === "running") return;
      setStatus({ kind: "running" });
      setLatestToolLine(`You said: ${prompt.slice(0, 80)}…`);
      turnStartRef.current = Date.now();
      const r = await orchestratorStart({
        projectId: project.id,
        projectPath: project.path,
        sessionId: sessionIdRef.current,
        prompt,
        onEvent: (event: OrchestratorEvent) => {
          if (event.kind === "session") {
            sessionIdRef.current = event.id;
          } else if (event.kind === "todos_updated") {
            setPlan(event.todos);
          } else if (event.kind === "done") {
            if (turnStartRef.current !== null) {
              const elapsed = Date.now() - turnStartRef.current;
              setTurnDurations((prev) => [...prev, elapsed]);
              turnStartRef.current = null;
            }
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
          } else if (event.kind === "rate_limit") {
            setStatus({ kind: "rate_limited", message: event.message });
          } else if (event.kind === "error") {
            setStatus({ kind: "error", message: event.message });
          }
        },
      });
      r.match(
        () => setStatus((prev) => (prev.kind === "running" ? { kind: "idle" } : prev)),
        (e) => setStatus({ kind: "error", message: e.message }),
      );
    },
    [project, status.kind],
  );

  // Autostart effect: when the interview hands off with ?autostart=1, kick
  // the build automatically once the project loads. Fires at most once per
  // mount (autostartFiredRef). Skips when crash-recovered (the user should
  // pick Resume / Stop deliberately) and skips when a build is already
  // running on this dashboard (shouldn't happen on first mount).
  useEffect(() => {
    if (!autostart) return;
    if (!project) return;
    if (autostartFiredRef.current) return;
    if (recoveredFromCrash) return;
    if (status.kind === "running") return;
    autostartFiredRef.current = true;
    void startBuild();
  }, [autostart, project, recoveredFromCrash, status.kind, startBuild]);

  // Stop = kill the subprocess AND drop the session id so the next start is
  // a fresh kickoff (not a resume of the current build).
  const stopBuild = useCallback(async (): Promise<void> => {
    if (!project) return;
    await orchestratorStop();
    sessionIdRef.current = null;
    setStatus({ kind: "idle" });
    await sidecarCall("projects.setStatus", {
      id: project.id,
      status: "ready",
      currentSessionId: null,
    });
  }, [project]);

  // Deploy preview to Vercel — Flow I AC1-AC6. If the keychain has no token,
  // open the modal first; otherwise go straight to the CLI invocation.
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
  }, [project]);

  const runDeploy = useCallback(async (): Promise<void> => {
    if (!project) return;
    setDeployStatus({ kind: "running" });
    const r = await deployToVercel({ projectPath: project.path, projectId: project.id });
    r.match(
      (result) => {
        setDeployStatus({ kind: "success", url: result.previewUrl });
        // Flow I AC5: copy URL to clipboard. Tauri webview supports the
        // standard Clipboard API.
        if (typeof navigator !== "undefined" && navigator.clipboard) {
          void navigator.clipboard.writeText(result.previewUrl);
        }
      },
      (e) => setDeployStatus({ kind: "error", message: e.message }),
    );
  }, [project]);

  // Push to GitHub (Flow I AC8). Auth handled by `gh auth login`; we
  // surface a clear error if the CLI isn't installed or not authenticated.
  const exportToGithubFlow = useCallback(async (): Promise<void> => {
    if (!project) return;
    const installed = await isGhInstalled();
    if (installed.isErr() || !installed.value) {
      setExportStatus({
        kind: "error",
        message: "gh CLI not found on PATH. Install it from cli.github.com and run `gh auth login`.",
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

  // The in-progress turn's elapsed time (counted toward past_p90 only).
  // For idle/finished states there's no in-flight turn, so 0 is correct
  // (it can never exceed P90).
  const inFlightElapsed = turnStartRef.current === null ? 0 : Date.now() - turnStartRef.current;
  const liveEta = estimate(turnDurations, inFlightElapsed);

  // Step view (UX5): prefer the in-progress TodoWrite activeForm as the
  // novice-readable "Now doing" line — the agent writes these lines
  // explicitly for the dashboard. Fall back to the latest tool's translated
  // line when no plan item is in progress (early in the run, or between
  // turns). Step counter is the index of the in-progress item among all
  // plan items, 1-based; it's null when the plan is empty.
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
        : completedSteps === totalSteps && totalSteps > 0
          ? `${totalSteps} of ${totalSteps} steps complete`
          : `${completedSteps} of ${totalSteps} steps complete`
      : null;

  if (loadError) {
    return (
      <main className="flex h-screen items-center justify-center p-6">
        <Alert variant="destructive" className="max-w-lg">
          <AlertTitle>Could not load the build dashboard</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      </main>
    );
  }

  if (!project) {
    return <Skeleton />;
  }

  return (
    <main className="flex h-screen flex-col bg-background">
      {/* Header */}
      <header className="flex items-center justify-between border-b px-6 py-3">
        <div>
          <h1 className="text-base font-semibold">{project.name}</h1>
          <p className="font-mono text-xs text-muted-foreground">{project.path}</p>
        </div>
        <div className="flex items-center gap-2">
          {status.kind === "running" ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void stopBuild()}
              title="Stop the build"
            >
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
              {sessionIdRef.current ? "Resume" : "Start"}
            </Button>
          )}
          {/* Show / hide details toggle (everything else lives in here). */}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowDetails((v) => !v)}
            title={showDetails ? "Hide advanced controls" : "Show advanced controls"}
          >
            {showDetails ? (
              <ChevronDown className="mr-1 h-3 w-3" />
            ) : (
              <ChevronRight className="mr-1 h-3 w-3" />
            )}
            Details
          </Button>
          {showDetails ? (
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

      {/* Progress bar (replaces the old PhaseBar — uses TodoWrite plan, not
          state.json's task counter, so it tracks the agent's own pacing). */}
      <ProgressBar completed={completedSteps} total={totalSteps} />

      {/* Headline status: prominent, plain-language line that mirrors the
          agent's TodoWrite activeForm (e.g. "Setting up the database").
          This is the primary thing a novice should look at while the build
          runs. Falls back to the most recent tool when no item is in_progress. */}
      <div className="border-b bg-primary/5 px-6 py-3">
        <div className="flex items-center gap-3">
          {status.kind === "running" ? (
            <Loader2 className="h-4 w-4 animate-spin text-primary motion-reduce:animate-none" />
          ) : (
            <span className="inline-block h-2 w-2 rounded-full bg-muted-foreground/40" />
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">
              {nowDoingLine ?? (status.kind === "running" ? "Working…" : "Ready when you are.")}
            </p>
            {stepCounter ? (
              <p className="text-[11px] text-muted-foreground">{stepCounter}</p>
            ) : null}
          </div>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[300px_1fr]">
        <aside className="hidden min-h-0 flex-col border-r lg:flex">
          <div className="border-b px-4 py-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Steps {plan.length > 0 ? `· ${completedSteps} / ${totalSteps}` : null}
            </h2>
            <p className="text-[11px] text-muted-foreground">
              The plan Claude is working through. It updates itself as the build progresses.
            </p>
          </div>
          <div className="flex-1 overflow-auto p-4">
            {plan.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Claude will lay out the steps here as soon as the build starts.
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
          {(targetState?.history ?? []).length > 0 ? (
            <div className="border-t px-4 py-3">
              <h3 className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                Recent commits
              </h3>
              <ul className="space-y-0.5 text-[11px]">
                {(targetState?.history ?? []).slice(-5).reverse().map((h) => (
                  <li key={h.task_id} className="font-mono text-muted-foreground">
                    {h.task_id}
                    {h.commit ? ` · ${h.commit.slice(0, 7)}` : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </aside>

        <section className="flex min-h-0 flex-col">
          {deployStatus.kind === "success" ? (
            <Alert className="mx-4 mt-3 mb-1">
              <AlertTitle>Preview deployed</AlertTitle>
              <AlertDescription>
                Copied to clipboard:{" "}
                <a href={deployStatus.url} target="_blank" rel="noopener noreferrer" className="underline">
                  {deployStatus.url}
                </a>
              </AlertDescription>
            </Alert>
          ) : null}
          {deployStatus.kind === "error" ? (
            <Alert variant="destructive" className="mx-4 mt-3 mb-1">
              <AlertTitle>Deploy failed</AlertTitle>
              <AlertDescription>{deployStatus.message}</AlertDescription>
            </Alert>
          ) : null}
          {exportStatus.kind === "success" ? (
            <Alert className="mx-4 mt-3 mb-1">
              <AlertTitle>Pushed to GitHub</AlertTitle>
              <AlertDescription>
                Copied to clipboard:{" "}
                <a href={exportStatus.url} target="_blank" rel="noopener noreferrer" className="underline">
                  {exportStatus.url}
                </a>
              </AlertDescription>
            </Alert>
          ) : null}
          {exportStatus.kind === "error" ? (
            <Alert variant="destructive" className="mx-4 mt-3 mb-1">
              <AlertTitle>GitHub push failed</AlertTitle>
              <AlertDescription>{exportStatus.message}</AlertDescription>
            </Alert>
          ) : null}
          {showSentryPrompt ? (
            <SentryPrompt onDecided={() => setShowSentryPrompt(false)} />
          ) : null}
          {ceiling.state === "warn" || ceiling.state === "stop" ? (
            <Alert
              variant={ceiling.state === "stop" ? "destructive" : "default"}
              className="mx-4 mt-3 mb-1"
            >
              <AlertTitle>
                {ceiling.state === "stop" ? "Spend cap reached" : "Approaching spend cap"}
              </AlertTitle>
              <AlertDescription>{ceiling.message}</AlertDescription>
            </Alert>
          ) : null}
          {recoveredFromCrash ? (
            <Alert className="mx-4 mt-3 mb-1">
              <AlertTitle>Recovered from crash</AlertTitle>
              <AlertDescription>
                The previous session ended unexpectedly. Click Resume build to continue from where it
                left off, or Stop to drop the session and start fresh.
              </AlertDescription>
            </Alert>
          ) : null}
          {openPermissions.length > 0 && openPermissions[0] ? (
            <PermissionPromptBanner
              request={openPermissions[0]}
              totalOpen={openPermissions.length}
              onResolved={(id) =>
                setOpenPermissions((prev) => prev.filter((p) => p.id !== id))
              }
            />
          ) : null}
          {openDrifts.length > 0 && openDrifts[0] ? (
            <DriftBanner
              event={openDrifts[0]}
              projectPath={project.path}
              totalOpen={openDrifts.length}
              onResolved={(resolved) =>
                setOpenDrifts((prev) => prev.filter((d) => d.id !== resolved.id))
              }
            />
          ) : null}
          {/* End-of-build review panel. Rendered prominently above the
              activity log when .builder/review.md exists, so the novice
              sees coverage against spec.md as the headline finish state. */}
          {reviewMarkdown ? (
            <ReviewPanel
              markdown={reviewMarkdown}
              isRunning={status.kind === "running"}
              onBuildMissing={() => {
                if (!project) return;
                void runFollowUpTurn(
                  "Look at .builder/review.md. For every item marked partial or missing, build it now. Mark each plan item completed in TodoWrite as you go. When everything is built, re-run the review and rewrite .builder/review.md with the updated coverage.",
                );
              }}
            />
          ) : null}

          <div className="flex items-center justify-between border-b px-4 py-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Activity {actions.length > 0 ? `· ${actions.length}` : ""}
            </h2>
            {actions.length > 0 ? (
              <span className="text-[10px] text-muted-foreground">
                {showDetails ? "showing technical detail" : "plain view"}
              </span>
            ) : null}
          </div>
          <div ref={tailRef} className="flex-1 overflow-auto px-4 py-2 text-xs" aria-live="polite">
            {actions.length === 0 ? (
              <p className="text-muted-foreground">
                {status.kind === "running"
                  ? "Claude is reading your spec…"
                  : "Click Start to begin. Claude reads your spec and lays out a plan."}
              </p>
            ) : (
              <ul className="space-y-1">
                {actions.map((a) => (
                  <li key={a.id}>
                    <div>{a.humanLine ?? a.tool}</div>
                    {showDetails ? (
                      <div className="font-mono text-[10px] text-muted-foreground">
                        {a.tool} · {a.rawInput}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* BD2: send a message to the running build subprocess. */}
          <BuildChatInput
            disabled={!project || status.kind === "running" || sessionIdRef.current === null}
            disabledReason={
              !project
                ? "Project loading"
                : sessionIdRef.current === null
                  ? "Start a build first to open a session"
                  : status.kind === "running"
                    ? "Wait for the current turn to finish"
                    : null
            }
            onSend={async (text) => {
              if (!project) return;
              setStatus({ kind: "running" });
              setLatestToolLine(`You said: ${text}`);
              turnStartRef.current = Date.now();
              const r = await orchestratorStart({
                projectId: project.id,
                projectPath: project.path,
                sessionId: sessionIdRef.current,
                prompt: text,
                onEvent: (event: OrchestratorEvent) => {
                  if (event.kind === "session") {
                    sessionIdRef.current = event.id;
                  } else if (event.kind === "todos_updated") {
                    setPlan(event.todos);
                  } else if (event.kind === "done") {
                    // BLOCKER fix from bug review: chat-input turns now
                    // record cost + duration + re-poll drifts + show the
                    // Sentry consent prompt the same way startBuild does.
                    if (turnStartRef.current !== null) {
                      const elapsed = Date.now() - turnStartRef.current;
                      setTurnDurations((prev) => [...prev, elapsed]);
                      turnStartRef.current = null;
                    }
                    if (!hasMadeSentryDecision()) {
                      setShowSentryPrompt(true);
                    }
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
                  } else if (event.kind === "rate_limit") {
                    setStatus({ kind: "rate_limited", message: event.message });
                  } else if (event.kind === "error") {
                    setStatus({ kind: "error", message: event.message });
                  }
                },
              });
              r.match(
                () => setStatus((prev) => (prev.kind === "running" ? { kind: "idle" } : prev)),
                (e) => setStatus({ kind: "error", message: e.message }),
              );
            }}
          />

          {status.kind === "rate_limited" ? (
            <Alert className="mx-4 mb-3">
              <AlertTitle>Rate limited</AlertTitle>
              <AlertDescription>{status.message}</AlertDescription>
            </Alert>
          ) : null}
          {status.kind === "error" ? (
            <Alert variant="destructive" className="mx-4 mb-3">
              <AlertTitle>Orchestrator error</AlertTitle>
              <AlertDescription>{status.message}</AlertDescription>
            </Alert>
          ) : null}
        </section>
      </div>

      {/* Status footer (simple by default; expanded under Details). */}
      <StatusFooter
        targetState={targetState}
        costSum={costSum}
        eta={liveEta}
        backHref={projectId ? `/interview?project=${projectId}` : "/"}
        capUsdCents={costCap}
        onCapChange={setCostCap}
        showDetails={showDetails}
      />

      <DeployModal
        open={deployModalOpen}
        onOpenChange={setDeployModalOpen}
        onTokenSaved={() => void runDeploy()}
      />
    </main>
  );
}

function StatusFooter({
  targetState,
  costSum,
  eta,
  backHref,
  capUsdCents,
  onCapChange,
  showDetails,
}: {
  targetState: TargetState | null;
  costSum: CostSum | null;
  eta: EtaResult;
  backHref: string;
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
                {costSum.turns} turn{costSum.turns === 1 ? "" : "s"} · in {costSum.inputTokens} / out {costSum.outputTokens}
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
                  const dollars = Number.parseFloat(v);
                  if (!Number.isFinite(dollars) || dollars <= 0) {
                    onCapChange(null);
                    return;
                  }
                  onCapChange(Math.round(dollars * 100));
                }}
                aria-label="Optional spend cap in USD"
                className="w-16 rounded border bg-background px-1 py-0.5 text-xs"
              />
            </label>
          </>
        ) : null}
      </div>
      <Link href={backHref} className="underline">
        Back to interview
      </Link>
    </footer>
  );
}

function BuildChatInput({
  disabled,
  disabledReason,
  onSend,
}: {
  disabled: boolean;
  disabledReason: string | null;
  onSend: (text: string) => Promise<void> | void;
}) {
  const [text, setText] = useState("");
  const send = (): void => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || disabled) return;
    setText("");
    void onSend(trimmed);
  };
  return (
    <div className="border-t bg-background px-4 py-2">
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={
            disabled
              ? (disabledReason ?? "Cannot send right now")
              : "Tell Claude something. Enter to send, Shift+Enter for newline."
          }
          rows={2}
          disabled={disabled}
          aria-label="Send a message to the running build"
          className="block flex-1 resize-none rounded-md border bg-background px-3 py-2 text-xs ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
        />
        <Button size="sm" disabled={disabled || text.trim().length === 0} onClick={send}>
          Send
        </Button>
      </div>
    </div>
  );
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

function ProgressBar({ completed, total }: { completed: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  return (
    <div className="border-b bg-muted/30 px-6 py-2">
      <div className="flex items-center justify-between text-xs">
        <span className="font-semibold">
          {total > 0 ? "Build progress" : "Waiting to start"}
        </span>
        {total > 0 ? (
          <span className="text-muted-foreground">{pct}%</span>
        ) : null}
      </div>
      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full bg-primary transition-[width]"
          style={{ width: total > 0 ? `${pct}%` : "0%" }}
        />
      </div>
    </div>
  );
}

// End-of-build coverage panel. Renders the markdown the orchestrator wrote
// to .builder/review.md (per the kickoff prompt's REVIEW step). Includes a
// quick summary parsed from the leading "## Summary" block, the full body
// in a scrollable area, and a "Build the missing pieces" button that fires
// a follow-up turn so the agent fills any gaps.
function ReviewPanel({
  markdown,
  isRunning,
  onBuildMissing,
}: {
  markdown: string;
  isRunning: boolean;
  onBuildMissing: () => void;
}) {
  const counts = parseReviewCounts(markdown);
  const hasGaps = (counts?.partial ?? 0) + (counts?.missing ?? 0) > 0;
  return (
    <div className="m-4 rounded-md border bg-card">
      <div className="flex items-center justify-between border-b px-4 py-2">
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
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words bg-muted/40 px-4 py-3 text-[11px] leading-relaxed">
        {markdown}
      </pre>
    </div>
  );
}

// Best-effort summary parser. Looks for the bullets the kickoff prompt
// asks the agent to write under "## Summary" (Built, Partial, Missing).
// Returns null if any field is unparseable; the panel falls back to the
// generic "Coverage report" label.
function parseReviewCounts(markdown: string): { built: number; partial: number; missing: number } | null {
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
