"use client";

import { Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { Band, Defect } from "@/lib/debug";

import { DebugCard } from "./debug-card";

// Right-rail Debug panel per Flow L AC3/AC4. Lists defects ranked by
// PRIORITY band (critical → high → medium → low → info), founder mode
// (per the source spec §F.2 — plain English first, code on tap).
//
// Layer 2 dismissals (status='dismissed') hide by default; the toggle
// reveals them so the user can audit what the validator filtered. Info
// band hides by default per source spec §C.5.

const RULE_IDS_WITH_CODEMOD = new Set([
  "secret-regex/aws-access-key",
  "secret-regex/github-pat",
  "secret-regex/stripe-live-secret",
  "secret-regex/stripe-live-publishable",
  "secret-regex/anthropic-api-key",
  "secret-regex/openai-api-key",
  "secret-regex/google-api-key",
  "secret-regex/slack-bot-token",
  "rls-missing/no-rls-on-pii-table",
]);

const BAND_ORDER: readonly Band[] = ["critical", "high", "medium", "low", "info"];

export interface DebugPanelProps {
  defects: readonly Defect[];
  /** True while any debug.scan is in flight. */
  isScanning: boolean;
  /** Set of defect ids whose applyDebugFix is in flight. */
  fixingDefectIds: ReadonlySet<string>;
  /** Set of defect ids whose rollbackDebugFix is in flight. */
  rollingBackDefectIds: ReadonlySet<string>;
  onScanNow: () => void;
  onFix: (defectId: string) => void;
  onRollback: (defectId: string) => void;
  /** Last completed scan timestamp; null before the first scan. */
  lastScannedAt: number | null;
}

export function DebugPanel({
  defects,
  isScanning,
  fixingDefectIds,
  rollingBackDefectIds,
  onScanNow,
  onFix,
  onRollback,
  lastScannedAt,
}: DebugPanelProps) {
  const [showDismissed, setShowDismissed] = useState(false);
  const [showInfo, setShowInfo] = useState(false);

  const visible = useMemo(() => {
    return defects.filter((d) => {
      if (!showDismissed && d.status === "dismissed") return false;
      if (!showInfo && d.band === "info") return false;
      return true;
    });
  }, [defects, showDismissed, showInfo]);

  const grouped = useMemo(() => {
    const out: Record<Band, Defect[]> = {
      critical: [],
      high: [],
      medium: [],
      low: [],
      info: [],
    };
    for (const d of visible) out[d.band].push(d);
    for (const band of BAND_ORDER) out[band].sort((a, b) => b.priority - a.priority);
    return out;
  }, [visible]);

  const dismissedCount = defects.filter((d) => d.status === "dismissed").length;
  const infoCount = defects.filter((d) => d.band === "info").length;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="debug-panel">
      <div className="shrink-0 border-b px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Debug
            </h2>
            <p className="text-[11px] text-muted-foreground">
              {lastScannedAt === null
                ? "Run a scan to find defects in your app."
                : `Last scan: ${formatRelative(lastScannedAt)}.`}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={isScanning}
            onClick={onScanNow}
            data-testid="debug-panel-scan"
          >
            {isScanning ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="mr-1 h-3 w-3" aria-hidden="true" />
            )}
            {isScanning ? "Scanning…" : "Scan now"}
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {visible.length === 0 ? (
          <EmptyState
            hasScanned={lastScannedAt !== null}
            isScanning={isScanning}
          />
        ) : (
          BAND_ORDER.map((band) =>
            grouped[band].length === 0 ? null : (
              <BandSection key={band} band={band} count={grouped[band].length}>
                {grouped[band].map((d) => (
                  <DebugCard
                    key={d.id}
                    defect={d}
                    hasCodemod={RULE_IDS_WITH_CODEMOD.has(d.ruleId)}
                    isFixing={fixingDefectIds.has(d.id)}
                    isRollingBack={rollingBackDefectIds.has(d.id)}
                    onFix={onFix}
                    onRollback={onRollback}
                  />
                ))}
              </BandSection>
            )
          )
        )}
      </div>

      {(dismissedCount > 0 || infoCount > 0) && (
        <div className="shrink-0 border-t px-4 py-2 text-xs text-muted-foreground">
          {dismissedCount > 0 && (
            <button
              type="button"
              className="mr-3 underline-offset-2 hover:underline"
              onClick={() => setShowDismissed((s) => !s)}
              data-testid="debug-panel-toggle-dismissed"
            >
              {showDismissed ? "Hide" : "Show"} {dismissedCount} dismissed
            </button>
          )}
          {infoCount > 0 && (
            <button
              type="button"
              className="underline-offset-2 hover:underline"
              onClick={() => setShowInfo((s) => !s)}
              data-testid="debug-panel-toggle-info"
            >
              {showInfo ? "Hide" : "Show"} {infoCount} info
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function BandSection({
  band,
  count,
  children,
}: {
  band: Band;
  count: number;
  children: React.ReactNode;
}) {
  const labels: Record<Band, string> = {
    critical: "Critical",
    high: "High",
    medium: "Medium",
    low: "Low",
    info: "Info",
  };
  return (
    <section>
      <h3 className="sticky top-0 z-10 border-b bg-background/95 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground backdrop-blur">
        {labels[band]} <span className="font-normal">· {count}</span>
      </h3>
      {children}
    </section>
  );
}

function EmptyState({
  hasScanned,
  isScanning,
}: {
  hasScanned: boolean;
  isScanning: boolean;
}) {
  if (isScanning && !hasScanned) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 p-8 text-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden="true" />
        <p className="text-xs text-muted-foreground">Scanning your app…</p>
      </div>
    );
  }
  if (!hasScanned) {
    return (
      <div className="p-4">
        <Alert>
          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>No scan yet</AlertTitle>
          <AlertDescription>
            Click <strong>Scan now</strong> to check your app for security,
            authentication, and build defects.
          </AlertDescription>
        </Alert>
      </div>
    );
  }
  return (
    <div className="p-4">
      <Alert>
        <ShieldCheck className="h-4 w-4" aria-hidden="true" />
        <AlertTitle>No defects found</AlertTitle>
        <AlertDescription>
          Your app passed the eight-class scan. We checked: hardcoded secrets,
          missing row-level security, hallucinated imports, build errors,
          client-side auth, environment leaks.
        </AlertDescription>
      </Alert>
    </div>
  );
}

function formatRelative(ts: number): string {
  const seconds = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
