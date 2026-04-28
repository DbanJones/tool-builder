"use client";

import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import type { HistoryActionEntry, TargetState } from "@/lib/build-state";
import type { TodoItem } from "@/lib/orchestrator";

import { FilePanel } from "./file-panel";
import type { IngestedFile } from "@/lib/files/types";

// Tabbed right rail. The parent owns the active tab; this component just
// renders the strip and delegates content to the relevant panel.

// "plan" tab is now Plan + live Status (the activity tail) on one tab so
// the user never has to switch to see what's happening. "activity" was
// dropped as a standalone — its content lives at the bottom of "plan".
export type RightTab = "spec" | "plan" | "review" | "files";

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
  // Review
  reviewMarkdown: string | null;
  reviewIsRunning: boolean;
  onBuildMissingPieces: () => void;
  // Files
  files: readonly IngestedFile[];
  onFilesDropped: (files: readonly IngestedFile[], rawFiles: readonly File[]) => void;
}

export function RightRail(props: RightRailProps) {
  const { tab, onTabChange, hasStarted } = props;

  const tabs: { id: RightTab; label: string; visible: boolean }[] = [
    { id: "spec", label: "Spec", visible: true },
    { id: "plan", label: "Plan & status", visible: hasStarted },
    { id: "review", label: "Review", visible: hasStarted && props.reviewMarkdown !== null },
    { id: "files", label: "Files", visible: true },
  ];

  return (
    <aside className="hidden min-h-0 flex-col border-l lg:flex">
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

      <RailBody>
        {tab === "spec" && <SpecPanel spec={props.spec} />}
        {tab === "plan" && (
          <PlanAndStatusPanel
            plan={props.plan}
            recentHistory={props.recentHistory}
            actions={props.actions}
            showTechnicalDetail={props.showTechnicalDetail}
            isRunning={props.isRunning}
          />
        )}
        {tab === "review" && props.reviewMarkdown !== null && (
          <ReviewPanel
            markdown={props.reviewMarkdown}
            isRunning={props.reviewIsRunning}
            onBuildMissing={props.onBuildMissingPieces}
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

function SpecPanel({ spec }: { spec: string }) {
  return (
    <>
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Spec preview</h2>
        <p className="text-xs text-muted-foreground">
          Rebuilt after each answer. Becomes read-only once the build starts.
        </p>
      </div>
      <pre className="flex-1 overflow-auto whitespace-pre-wrap break-words bg-muted/40 p-4 text-xs leading-relaxed">
        {spec || "_(no answers recorded yet)_"}
      </pre>
    </>
  );
}

// Combined Plan + live Status panel. Top half: TodoWrite plan with steps
// + completion ticks. Bottom half: live activity tail (latest tool calls)
// so the novice can see the build advance in real time without flipping
// to a separate tab. Recent commits sit at the very bottom.
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
  const completed = plan.filter((t) => t.status === "completed").length;
  const total = plan.length;
  // Most-recent first, capped — the full history.log is on disk if anyone
  // really wants 200+ entries, but the rail is for at-a-glance status.
  const recentActions = [...actions].slice(-30).reverse();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b px-4 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Steps {total > 0 ? `· ${completed} / ${total}` : null}
        </h2>
        <p className="text-[11px] text-muted-foreground">
          The plan Claude is working through. Live status is below.
        </p>
      </div>
      <div className="max-h-[45%] shrink-0 overflow-auto p-4">
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
        <div className="flex-1 overflow-auto px-4 py-2 text-xs" aria-live="polite">
          {recentActions.length === 0 ? (
            <p className="text-muted-foreground">
              {isRunning
                ? "Claude is reading your spec…"
                : "Click Build it to begin. Claude reads your spec and lays out a plan."}
            </p>
          ) : (
            <ul className="space-y-1">
              {recentActions.map((a) => (
                <li key={a.id}>
                  <div>{a.humanLine ?? a.tool}</div>
                  {showTechnicalDetail ? (
                    <div className="font-mono text-[10px] text-muted-foreground">
                      {a.tool} · {a.rawInput}
                    </div>
                  ) : null}
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
      <pre className="flex-1 overflow-auto whitespace-pre-wrap break-words bg-muted/40 px-4 py-3 text-[11px] leading-relaxed">
        {markdown}
      </pre>
    </>
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
