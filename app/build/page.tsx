"use client";

import { Loader2, Pause, Play, Square } from "lucide-react";
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
import { orchestratorStart, type OrchestratorEvent } from "@/lib/orchestrator";
import { translate } from "@/lib/orchestrator/translate";
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
          void hydrateBuildArtefacts(p.path);
        },
        (e) => setLoadError(e.message),
      );
    })();

    async function hydrateBuildArtefacts(projectPath: string): Promise<void> {
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
    }

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Auto-scroll the live tail when new events arrive.
  useEffect(() => {
    tailRef.current?.scrollTo({ top: tailRef.current.scrollHeight });
  }, [actions]);

  const startBuild = useCallback(async (): Promise<void> => {
    if (!project || status.kind === "running") return;
    setStatus({ kind: "running" });
    const historyLogPath = project.path.replace(/\/$/, "") + "/.builder/history.log";
    let terminal: DashboardStatus = { kind: "idle" };

    const r = await orchestratorStart({
      projectPath: project.path,
      onEvent: (event: OrchestratorEvent) => {
        if (event.kind === "tool_use") {
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
    if (terminal.kind === "idle") setStatus({ kind: "idle" });
  }, [project, status.kind]);

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
            disabled={status.kind === "running"}
            onClick={() => void startBuild()}
          >
            {status.kind === "running" ? (
              <>
                <Loader2 className="mr-1 h-3 w-3 animate-spin" /> Running
              </>
            ) : (
              <>
                <Play className="mr-1 h-3 w-3" /> Start build
              </>
            )}
          </Button>
          <Button size="sm" variant="outline" disabled title="D6: pause/resume">
            <Pause className="h-3 w-3" />
          </Button>
          <Button size="sm" variant="outline" disabled title="D6: stop">
            <Square className="h-3 w-3" />
          </Button>
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
      <footer className="flex items-center justify-between border-t px-6 py-2 text-xs text-muted-foreground">
        <div className="flex gap-6">
          <span>
            Status: <span className="text-foreground">{targetState?.status ?? "unknown"}</span>
          </span>
          <span>
            Phase: <span className="text-foreground">{targetState?.phase ?? "(none)"}</span>
          </span>
          <span>Cost: $0.00 (D4)</span>
          <span>ETA: pending (D4)</span>
        </div>
        <Link href={projectId ? `/interview?project=${projectId}` : "/"} className="underline">
          Back to interview
        </Link>
      </footer>
    </main>
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
