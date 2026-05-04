"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  RotateCcw,
  Wrench,
  XCircle,
} from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { BAND_TREATMENT, type Defect } from "@/lib/debug";

const ROLLBACK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function isRollbackAvailable(defect: Defect): boolean {
  if (defect.status !== "fixed") return false;
  if (defect.resolvedCommit === null) return false;
  if (defect.resolvedAt === null) return false;
  return Date.now() - defect.resolvedAt < ROLLBACK_WINDOW_MS;
}

// One finding card. Founder mode UX per debug_repair_engine_spec.md §F.2:
// plain-English impact first, code evidence second (one tap), no CWE
// numbers in the default view. The "Fix this" verb is the only primary
// action; advanced metadata (rule id, validator verdict, code evidence)
// hides behind a toggle.

export interface DebugCardProps {
  defect: Defect;
  /** True iff a Tier 1 codemod is registered for this rule. */
  hasCodemod: boolean;
  /** Set while applyDebugFix is in flight for this defect. */
  isFixing: boolean;
  /** Set while rollbackDebugFix is in flight for this defect. */
  isRollingBack: boolean;
  onFix: (defectId: string) => void;
  onRollback: (defectId: string) => void;
}

export function DebugCard({
  defect,
  hasCodemod,
  isFixing,
  isRollingBack,
  onFix,
  onRollback,
}: DebugCardProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const treatment = BAND_TREATMENT[defect.band];
  const isFixed = defect.status === "fixed";
  const isDismissed = defect.status === "dismissed";
  const canRollback = isRollbackAvailable(defect);

  return (
    <article
      className={
        "border-b last:border-b-0 px-4 py-3 " +
        (isFixed ? "bg-emerald-50/40 dark:bg-emerald-950/20" : "") +
        (isDismissed ? " opacity-60" : "")
      }
      data-testid={`debug-card-${defect.id}`}
    >
      <header className="flex items-start gap-2">
        <BandIcon defect={defect} />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-foreground" data-testid="debug-card-band">
            {treatment.label}
          </p>
          <p className="mt-1 text-sm leading-relaxed text-foreground">
            {defect.humanExplanation}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {defect.file}:{defect.lineStart}
          </p>
        </div>
      </header>

      <div className="mt-2 flex items-center gap-2">
        {isFixed ? (
          <>
            <span className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="h-3 w-3" aria-hidden="true" /> Fixed
            </span>
            {canRollback && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={isRollingBack}
                onClick={() => onRollback(defect.id)}
                data-testid={`debug-card-rollback-${defect.id}`}
              >
                {isRollingBack ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden="true" />
                ) : (
                  <RotateCcw className="mr-1 h-3 w-3" aria-hidden="true" />
                )}
                Roll back
              </Button>
            )}
          </>
        ) : isDismissed ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <XCircle className="h-3 w-3" aria-hidden="true" /> Dismissed by validator
          </span>
        ) : hasCodemod ? (
          <Button
            type="button"
            size="sm"
            variant="default"
            disabled={isFixing}
            onClick={() => onFix(defect.id)}
            data-testid={`debug-card-fix-${defect.id}`}
          >
            {isFixing ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden="true" />
            ) : (
              <Wrench className="mr-1 h-3 w-3" aria-hidden="true" />
            )}
            Fix this
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">
            No automatic fix — open the file and apply the suggestion below.
          </span>
        )}

        <button
          type="button"
          className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setShowAdvanced((s) => !s)}
          aria-expanded={showAdvanced}
          data-testid={`debug-card-advanced-${defect.id}`}
        >
          {showAdvanced ? (
            <ChevronDown className="h-3 w-3" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-3 w-3" aria-hidden="true" />
          )}
          Advanced
        </button>
      </div>

      {showAdvanced && (
        <dl className="mt-2 space-y-1 rounded bg-muted/40 p-2 text-xs">
          <Row label="Rule">{defect.ruleId}</Row>
          <Row label="Class">{defect.class}</Row>
          <Row label="Priority">{defect.priority.toFixed(1)}</Row>
          <Row label="Confidence">{(defect.confidence * 100).toFixed(0)}%</Row>
          {defect.validatorVerdict && (
            <Row label="Validator">{defect.validatorVerdict}</Row>
          )}
          <Row label="Code">
            <code className="break-words font-mono text-[11px]">
              {defect.codeEvidence}
            </code>
          </Row>
        </dl>
      )}

      <SuggestionPanel suggestion={defect.suggestion} />
    </article>
  );
}

interface ParsedSuggestion {
  explanation: string;
  edits: Array<{ file: string; oldText: string; newText: string }>;
  errors: string;
}

function parseSuggestion(raw: string | null): ParsedSuggestion | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ParsedSuggestion>;
    if (typeof parsed.explanation !== "string") return null;
    if (!Array.isArray(parsed.edits)) return null;
    return {
      explanation: parsed.explanation,
      edits: parsed.edits as ParsedSuggestion["edits"],
      errors: typeof parsed.errors === "string" ? parsed.errors : "",
    };
  } catch {
    return null;
  }
}

function SuggestionPanel({ suggestion }: { suggestion: string | null }) {
  const parsed = parseSuggestion(suggestion);
  if (!parsed) return null;
  return (
    <aside
      className="mt-3 rounded border border-amber-300/60 bg-amber-50/40 p-3 text-xs dark:border-amber-700/40 dark:bg-amber-950/20"
      data-testid="debug-card-suggestion"
    >
      <p className="font-medium text-amber-900 dark:text-amber-200">
        Suggested manual fix
      </p>
      <p className="mt-1 text-foreground">{parsed.explanation}</p>
      {parsed.edits.length > 0 && (
        <ul className="mt-2 space-y-2">
          {parsed.edits.map((edit, i) => (
            <li key={i} className="rounded bg-background/80 p-2">
              <p className="font-mono text-[11px] text-muted-foreground">
                {edit.file}
              </p>
              <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-destructive">
                - {edit.oldText}
              </pre>
              <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-emerald-700 dark:text-emerald-300">
                + {edit.newText}
              </pre>
            </li>
          ))}
        </ul>
      )}
      {parsed.errors.length > 0 && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          Verification errors: {parsed.errors}
        </p>
      )}
    </aside>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-20 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}

function BandIcon({ defect }: { defect: Defect }) {
  const cls = "h-4 w-4 shrink-0 mt-0.5";
  switch (defect.band) {
    case "critical":
      return <AlertTriangle className={cls + " text-destructive"} aria-hidden="true" />;
    case "high":
      return <AlertTriangle className={cls + " text-amber-600"} aria-hidden="true" />;
    case "medium":
      return <AlertTriangle className={cls + " text-muted-foreground"} aria-hidden="true" />;
    default:
      return <AlertTriangle className={cls + " text-muted-foreground/60"} aria-hidden="true" />;
  }
}
