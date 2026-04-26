"use client";

import { GitBranch, Loader2, Pause, Play, Rocket, Square } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  readHistoryLogTail,
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
import { appendDrift, listOpenDrifts, type DriftEvent } from "@/lib/drift";
import { estimate, formatEta, type EtaResult } from "@/lib/eta";
import { orchestratorStart, orchestratorStop, type OrchestratorEvent } from "@/lib/orchestrator";
import { translate } from "@/lib/orchestrator/translate";
import { hasMadeSentryDecision } from "@/lib/telemetry";

import { SentryPrompt } from "@/app/components/sentry-prompt";

import { DeployModal } from "./components/deploy-modal";
import { DriftBanner } from "./components/drift-banner";
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

  const [project, setProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [targetState, setTargetState] = useState<TargetState | null>(null);
  const [actions, setActions] = useState<readonly HistoryActionEntry[]>([]);
  const [status, setStatus] = useState<DashboardStatus>({ kind: "idle" });
  const [costSum, setCostSum] = useState<CostSum | null>(null);
  const [openDrifts, setOpenDrifts] = useState<readonly DriftEvent[]>([]);
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
    }

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Auto-scroll the live tail when new events arrive.
  useEffect(() => {
    tailRef.current?.scrollTo({ top: tailRef.current.scrollHeight });
  }, [actions]);

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

  const startBuild = useCallback(async (): Promise<void> => {
    if (!project || status.kind === "running") return;
    setStatus({ kind: "running" });
    setRecoveredFromCrash(false);
    // Mark the project as building BEFORE we spawn so a hard crash mid-turn
    // is detectable on next mount (the only writer of "building" is here).
    void sidecarCall("projects.setStatus", { id: project.id, status: "building" });
    const historyLogPath = project.path.replace(/\/$/, "") + "/.builder/history.log";
    let terminal: DashboardStatus = { kind: "idle" };
    turnStartRef.current = Date.now();
    const sessionIdAtStart = sessionIdRef.current;

    const r = await orchestratorStart({
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
          // some during the turn via its own /recheck pass — D5b).
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
          })();
        } else if (event.kind === "tool_use") {
          const humanLine = translate(event.tool, event.raw_input);
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

  // Pause = ask the orchestrator to stop after the current turn naturally
  // ends, AND mark the project as paused. The current turn is already
  // turn-bounded in `-p` mode, so this is effectively "don't auto-resume".
  // (For interactive multi-tool turns we'd need the kit's "finish current
  // tool then halt" semantics; out of scope for D6.)
  const pauseBuild = useCallback(async (): Promise<void> => {
    if (!project) return;
    await orchestratorStop();
    setStatus({ kind: "idle" });
    await sidecarCall("projects.setStatus", { id: project.id, status: "paused" });
  }, [project]);

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
          <Button
            size="sm"
            disabled={status.kind === "running" || ceiling.state === "stop"}
            onClick={() => void startBuild()}
          >
            {status.kind === "running" ? (
              <>
                <Loader2 className="mr-1 h-3 w-3 animate-spin" /> Running
              </>
            ) : (
              <>
                <Play className="mr-1 h-3 w-3" />
                {sessionIdRef.current ? "Resume build" : "Start build"}
              </>
            )}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={status.kind !== "running"}
            onClick={() => void pauseBuild()}
            title="Pause after the current turn"
          >
            <Pause className="h-3 w-3" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void stopBuild()}
            title="Stop the build (drops the session)"
          >
            <Square className="h-3 w-3" />
          </Button>
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
          {process.env.NODE_ENV !== "production" ? (
            <Button
              size="sm"
              variant="outline"
              title="DEV ONLY: inject a test drift event (D5 trigger; removed when D5b wires the report_drift MCP tool)"
              onClick={() => {
                if (!project) return;
                void (async () => {
                  const r = await appendDrift({
                    projectId: project.id,
                    phase: targetState?.phase ?? "phase-1",
                    kind: "implementation",
                    description: "Test drift injected from the dashboard for D5 verification",
                  });
                  r.match(
                    (created) => setOpenDrifts((prev) => [...prev, created]),
                    () => undefined,
                  );
                })();
              }}
            >
              Inject drift (dev)
            </Button>
          ) : null}
        </div>
      </header>

      {/* Phase bar */}
      <PhaseBar state={targetState} />

      {/* Task lane + Live tail */}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[260px_1fr]">
        <aside className="hidden border-r p-4 lg:block">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Current task
          </h2>
          <p className="text-sm">{targetState?.current_task ?? targetState?.next_task ?? "(no task in progress)"}</p>

          <h2 className="mt-6 mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Recent history
          </h2>
          <ul className="space-y-1 text-xs">
            {(targetState?.history ?? []).slice(-8).reverse().map((h) => (
              <li key={h.task_id} className="font-mono">
                <span className="text-muted-foreground">{h.task_id}</span>
                {h.commit ? <span className="text-muted-foreground"> · {h.commit.slice(0, 7)}</span> : null}
              </li>
            ))}
            {(targetState?.history ?? []).length === 0 ? (
              <li className="text-muted-foreground">(no history yet)</li>
            ) : null}
          </ul>
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
          <div className="border-b px-4 py-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Live tail · {actions.length} action{actions.length === 1 ? "" : "s"}
            </h2>
          </div>
          <div ref={tailRef} className="flex-1 overflow-auto px-4 py-2 text-xs" aria-live="polite">
            {actions.length === 0 ? (
              <p className="text-muted-foreground">
                No actions yet. Click Start build to spawn the orchestrator.
              </p>
            ) : (
              <ul className="space-y-1">
                {actions.map((a) => (
                  <li key={a.id}>
                    <div>{a.humanLine ?? a.tool}</div>
                    <div className="font-mono text-[10px] text-muted-foreground">
                      {a.tool} · {a.rawInput}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

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

      {/* Status footer */}
      <StatusFooter
        targetState={targetState}
        costSum={costSum}
        eta={liveEta}
        backHref={projectId ? `/interview?project=${projectId}` : "/"}
        capUsdCents={costCap}
        onCapChange={setCostCap}
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
}: {
  targetState: TargetState | null;
  costSum: CostSum | null;
  eta: EtaResult;
  backHref: string;
  capUsdCents: number | null;
  onCapChange: (cap: number | null) => void;
}) {
  const dollars = costSum ? (costSum.usdCents / 100).toFixed(2) : "0.00";
  const capDollars = capUsdCents !== null ? (capUsdCents / 100).toFixed(2) : "";
  return (
    <footer className="flex items-center justify-between gap-4 border-t px-6 py-2 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
        <span>
          Status: <span className="text-foreground">{targetState?.status ?? "unknown"}</span>
        </span>
        <span>
          Phase: <span className="text-foreground">{targetState?.phase ?? "(none)"}</span>
        </span>
        <span>
          Cost: <span className="text-foreground">${dollars}</span>
          {costSum ? (
            <span> · {costSum.turns} turn{costSum.turns === 1 ? "" : "s"}, in {costSum.inputTokens} / out {costSum.outputTokens}</span>
          ) : null}
        </span>
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
      </div>
      <Link href={backHref} className="underline">
        Back to interview
      </Link>
    </footer>
  );
}

function PhaseBar({ state }: { state: TargetState | null }) {
  const phase = state?.phase ?? null;
  const done = state?.tasks_completed_in_phase ?? 0;
  const total = state?.tasks_total_in_phase ?? null;
  const pct = total && total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div className="border-b bg-muted/30 px-6 py-2">
      <div className="flex items-center justify-between text-xs">
        <span className="font-semibold">{phase ? `Phase ${phase}` : "(no phase yet)"}</span>
        <span className="text-muted-foreground">
          {done} / {total ?? "?"} task{done === 1 ? "" : "s"} complete
        </span>
      </div>
      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full bg-primary transition-[width]"
          style={{ width: total ? `${pct}%` : "0%" }}
        />
      </div>
    </div>
  );
}
