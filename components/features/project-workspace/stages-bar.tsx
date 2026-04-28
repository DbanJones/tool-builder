"use client";

import { Check, Loader2 } from "lucide-react";

import type { TodoItem } from "@/lib/orchestrator";

// Workflow progress: a horizontal stage bar so the novice can see at a
// glance where the project is in the lifecycle (interview → plan → build
// → test → review) and roughly how long is left.

export type WorkflowStage =
  | "interview"
  | "planning"
  | "building"
  | "testing"
  | "review";

interface StagesBarProps {
  hasStarted: boolean;
  plan: readonly TodoItem[];
  reviewPresent: boolean;
  isRunning: boolean;
  /** Median per-turn duration from the ETA estimator (ms). 0 means unknown. */
  etaMsPerTurn: number;
}

const STAGES: readonly { key: WorkflowStage; label: string }[] = [
  { key: "interview", label: "Interview" },
  { key: "planning", label: "Plan" },
  { key: "building", label: "Build" },
  { key: "testing", label: "Test" },
  { key: "review", label: "Review" },
];

function stageIndex(stage: WorkflowStage): number {
  return STAGES.findIndex((s) => s.key === stage);
}

// Heuristic detector: walks state in order of strongest signal first.
// Errors/test/build content is sniffed from the in-progress plan item's
// activeForm — TodoWrite labels are the agent's own self-narration.
export function detectStage(props: {
  hasStarted: boolean;
  plan: readonly TodoItem[];
  reviewPresent: boolean;
}): WorkflowStage {
  const { hasStarted, plan, reviewPresent } = props;
  if (!hasStarted) return "interview";
  if (reviewPresent) return "review";
  if (plan.length === 0) return "planning";
  const inProgress = plan.find((t) => t.status === "in_progress");
  const text = (inProgress?.activeForm ?? inProgress?.content ?? "").toLowerCase();
  if (/\b(test|spec|coverage|axe|playwright|vitest|integration)\b/.test(text)) {
    return "testing";
  }
  return "building";
}

function formatEta(ms: number): string {
  if (ms <= 0) return "—";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function StagesBar({
  hasStarted,
  plan,
  reviewPresent,
  isRunning,
  etaMsPerTurn,
}: StagesBarProps) {
  const current = detectStage({ hasStarted, plan, reviewPresent });
  const currentIdx = stageIndex(current);
  const completedSteps = plan.filter((t) => t.status === "completed").length;
  const totalSteps = plan.length;
  const buildPct = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;

  // Rough total ETA: median per-turn × remaining incomplete plan items.
  // Imperfect (build phases vary in cost), but better than nothing — and
  // disappears below 1s of useful information when no turns have run.
  const remainingItems = totalSteps - completedSteps;
  const totalEtaMs = remainingItems > 0 && etaMsPerTurn > 0 ? remainingItems * etaMsPerTurn : 0;

  return (
    <div className="border-b bg-muted/30 px-6 py-3">
      <div className="mx-auto flex w-full max-w-4xl items-center gap-4">
        <ol className="flex flex-1 items-center gap-0" aria-label="Workflow progress">
          {STAGES.map((s, i) => {
            const idx = i;
            const isComplete = idx < currentIdx;
            const isActive = idx === currentIdx;
            const isPending = idx > currentIdx;
            return (
              <li key={s.key} className="flex flex-1 items-center gap-2 last:flex-none">
                <div className="flex flex-col items-center gap-1">
                  <span
                    className={
                      "relative inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold transition-colors " +
                      (isComplete
                        ? "bg-green-600 text-white"
                        : isActive
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground")
                    }
                    aria-current={isActive ? "step" : undefined}
                  >
                    {isComplete ? (
                      <Check className="h-3 w-3" aria-hidden="true" />
                    ) : isActive && isRunning ? (
                      <Loader2
                        className="h-3 w-3 animate-spin motion-reduce:animate-none"
                        aria-hidden="true"
                      />
                    ) : (
                      idx + 1
                    )}
                  </span>
                  <span
                    className={
                      "text-[10px] font-medium uppercase tracking-wide " +
                      (isActive
                        ? "text-foreground"
                        : isComplete
                          ? "text-muted-foreground"
                          : "text-muted-foreground/60")
                    }
                  >
                    {s.label}
                    {isActive && s.key === "building" && totalSteps > 0 ? (
                      <span className="ml-1 lowercase text-muted-foreground">({buildPct}%)</span>
                    ) : null}
                  </span>
                </div>
                {idx < STAGES.length - 1 ? (
                  <div className="-mt-3 h-0.5 flex-1">
                    <div
                      className={
                        "h-full rounded transition-colors " +
                        (isPending ? "bg-muted" : "bg-primary")
                      }
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
        <div className="shrink-0 text-right">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">ETA</p>
          <p className="text-xs font-medium tabular-nums text-foreground">
            {totalEtaMs > 0 ? `~${formatEta(totalEtaMs)}` : "—"}
          </p>
        </div>
      </div>
    </div>
  );
}
