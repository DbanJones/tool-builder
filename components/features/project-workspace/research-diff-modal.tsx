"use client";

import { Dialog } from "@base-ui/react/dialog";
import { ArrowRight, FileText, Sparkles, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";

// Side-by-side preview of the original spec.md vs. the deep-research
// proposal. Three actions:
//   - Use new spec  : adopt the proposal (parent backs up the original)
//   - Keep original : drop the proposal silently
//   - Discard       : drop the proposal AND clear the cached run from
//                     state.json so the novice can restart fresh
//
// Default view: rendered markdown in two columns (as <pre> blocks, the
// same rendering the rest of the app uses for spec.md / review.md). The
// "Show raw diff" toggle stacks the two specs with a per-line marker so
// inserted/deleted lines stand out.

interface ResearchDiffModalProps {
  open: boolean;
  /** Original spec.md content. */
  originalMarkdown: string;
  /** Proposed replacement from `propose_spec_revision`. */
  proposedMarkdown: string;
  /** 5-10 line bullet list summarising the changes. Headline of the modal. */
  summaryOfChanges: string;
  /** When true, the proposal is annotated as a partial run (cap-hit). */
  partial: boolean;
  onAdopt: () => void;
  onKeepOriginal: () => void;
  onDiscard: () => void;
}

type ViewMode = "side-by-side" | "raw";

export function ResearchDiffModal({
  open,
  originalMarkdown,
  proposedMarkdown,
  summaryOfChanges,
  partial,
  onAdopt,
  onKeepOriginal,
  onDiscard,
}: ResearchDiffModalProps) {
  const [view, setView] = useState<ViewMode>("side-by-side");
  return (
    <Dialog.Root open={open} onOpenChange={(o) => (o ? null : onKeepOriginal())}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/40 backdrop-blur-sm" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 flex max-h-[90vh] w-full max-w-6xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border bg-background shadow-lg">
          <div className="shrink-0 border-b p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <Dialog.Title className="flex items-center gap-2 text-base font-semibold">
                  <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" />
                  Research finished — adopt the new spec?
                  {partial ? (
                    <span className="rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700">
                      partial
                    </span>
                  ) : null}
                </Dialog.Title>
                <Dialog.Description className="mt-1 text-xs text-muted-foreground">
                  Dave proposes these changes after researching competitors, edge cases, and
                  data-model gaps. Your original spec is preserved either way — you can always
                  go back.
                </Dialog.Description>
              </div>
              <div className="flex shrink-0 gap-1 rounded-md border bg-muted/40 p-0.5">
                <button
                  type="button"
                  onClick={() => setView("side-by-side")}
                  aria-pressed={view === "side-by-side"}
                  className={
                    "rounded px-2 py-1 text-[11px] font-medium transition-colors " +
                    (view === "side-by-side"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground")
                  }
                >
                  Side by side
                </button>
                <button
                  type="button"
                  onClick={() => setView("raw")}
                  aria-pressed={view === "raw"}
                  className={
                    "rounded px-2 py-1 text-[11px] font-medium transition-colors " +
                    (view === "raw"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground")
                  }
                >
                  Show raw diff
                </button>
              </div>
            </div>
            {summaryOfChanges.trim().length > 0 ? (
              <div className="mt-3 rounded-md border bg-muted/30 p-3">
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Headline of the changes
                </p>
                <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-foreground">
                  {summaryOfChanges.trim()}
                </pre>
              </div>
            ) : null}
          </div>

          {view === "side-by-side" ? (
            <SideBySideView original={originalMarkdown} proposed={proposedMarkdown} />
          ) : (
            <RawDiffView original={originalMarkdown} proposed={proposedMarkdown} />
          )}

          <div className="flex shrink-0 items-center justify-between gap-3 border-t bg-background p-4">
            <p className="text-[11px] text-muted-foreground">
              Adopting writes the proposal to spec.md. Original is saved to
              .builder/spec.pre-research.md.
            </p>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={onDiscard}>
                <Trash2 className="mr-1 h-3 w-3" aria-hidden="true" />
                Discard
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={onKeepOriginal}>
                Keep original
              </Button>
              <Button type="button" size="sm" onClick={onAdopt}>
                Use new spec
                <ArrowRight className="ml-1 h-3 w-3" aria-hidden="true" />
              </Button>
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SideBySideView({ original, proposed }: { original: string; proposed: string }) {
  const originalLines = original.split("\n").length;
  const proposedLines = proposed.split("\n").length;
  return (
    <div className="grid min-h-0 flex-1 grid-cols-2">
      <SpecColumn label="Original" lineCount={originalLines} markdown={original} />
      <div className="border-l">
        <SpecColumn
          label="Proposed"
          lineCount={proposedLines}
          markdown={proposed}
          accent="primary"
        />
      </div>
    </div>
  );
}

function SpecColumn({
  label,
  lineCount,
  markdown,
  accent,
}: {
  label: string;
  lineCount: number;
  markdown: string;
  accent?: "primary";
}) {
  return (
    <div className="flex min-h-0 flex-col">
      <div
        className={
          "flex shrink-0 items-center gap-2 border-b px-4 py-2 text-[11px] font-medium " +
          (accent === "primary" ? "bg-primary/5 text-primary" : "bg-muted/30 text-muted-foreground")
        }
      >
        <FileText className="h-3 w-3" aria-hidden="true" />
        {label} · {lineCount} lines
      </div>
      <pre
        aria-label={`${label} spec`}
        className="flex-1 overflow-auto whitespace-pre-wrap break-words bg-muted/10 p-4 font-mono text-[11px] leading-relaxed text-foreground"
      >
        {markdown.trim().length === 0 ? "(empty)" : markdown}
      </pre>
    </div>
  );
}

function RawDiffView({ original, proposed }: { original: string; proposed: string }) {
  // Compute a line-by-line zip diff: lines that match in both (any
  // position) are context; lines unique to original are deletions; lines
  // unique to proposed are insertions. Naive O(n*m) line-set check is
  // fine for a spec.md (typically < 500 lines).
  const rows = useMemo(() => buildLineDiff(original, proposed), [original, proposed]);
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-muted/10 p-4 font-mono text-[11px] leading-relaxed">
      <ol className="space-y-0">
        {rows.map((row, i) => (
          <li
            key={i}
            className={
              "whitespace-pre-wrap break-words " +
              (row.kind === "add"
                ? "bg-emerald-500/10 text-emerald-700"
                : row.kind === "del"
                  ? "bg-rose-500/10 text-rose-700"
                  : "text-muted-foreground")
            }
          >
            <span aria-hidden="true" className="select-none pr-2">
              {row.kind === "add" ? "+" : row.kind === "del" ? "-" : " "}
            </span>
            {row.text}
          </li>
        ))}
      </ol>
    </div>
  );
}

interface DiffRow {
  kind: "ctx" | "add" | "del";
  text: string;
}

function buildLineDiff(original: string, proposed: string): DiffRow[] {
  const a = original.split("\n");
  const b = proposed.split("\n");
  const aSet = new Set(a);
  const bSet = new Set(b);
  // Walk both sequences with two cursors. When the heads match, emit
  // context. Otherwise look ahead in the other side: if the current
  // a-line appears later in b, treat the b-side as inserted; symmetric
  // for deletion. Falls back to del+add pair.
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const aLine = a[i];
    const bLine = b[j];
    if (aLine !== undefined && bLine !== undefined && aLine === bLine) {
      rows.push({ kind: "ctx", text: aLine });
      i++;
      j++;
      continue;
    }
    if (aLine !== undefined && !bSet.has(aLine)) {
      rows.push({ kind: "del", text: aLine });
      i++;
      continue;
    }
    if (bLine !== undefined && !aSet.has(bLine)) {
      rows.push({ kind: "add", text: bLine });
      j++;
      continue;
    }
    // Both lines exist somewhere in the other side but not at the head —
    // emit as a pair so the reader can see them together.
    if (aLine !== undefined) {
      rows.push({ kind: "del", text: aLine });
      i++;
    }
    if (bLine !== undefined) {
      rows.push({ kind: "add", text: bLine });
      j++;
    }
  }
  return rows;
}
