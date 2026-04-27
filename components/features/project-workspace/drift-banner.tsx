"use client";

import { AlertTriangle, Loader2 } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  resolveDrift,
  type DriftEvent,
  type DriftResolution,
} from "@/lib/drift";

// Dashboard banner per Flow G AC2 + AC3. Shows the head of the open-drift
// queue with three resolution buttons; on click, persists the choice
// (DB row update + drift-log.md line) then calls onResolved so the parent
// can refresh its open-drifts list.

interface DriftBannerProps {
  event: DriftEvent;
  projectPath: string;
  totalOpen: number;
  onResolved: (resolved: DriftEvent) => void;
}

const KIND_LABEL: Record<DriftEvent["kind"], string> = {
  implementation: "Implementation drift",
  scope: "Scope drift",
  silent_assumption: "Silent assumption",
  nfr: "Non-functional drift",
};

export function DriftBanner({ event, projectPath, totalOpen, onResolved }: DriftBannerProps) {
  const [pending, setPending] = useState<DriftResolution | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apply = async (resolution: DriftResolution): Promise<void> => {
    setPending(resolution);
    setError(null);
    const r = await resolveDrift({ event, resolution, projectPath });
    setPending(null);
    r.match(
      (resolved) => onResolved(resolved),
      (e) => setError(e.message),
    );
  };

  return (
    <Alert variant="destructive" className="mx-4 mb-3" role="alert">
      <AlertTriangle className="h-4 w-4" aria-hidden="true" />
      <AlertTitle>
        Drift detected — {KIND_LABEL[event.kind]} ({totalOpen} open)
      </AlertTitle>
      <AlertDescription>
        <p className="mb-3 text-sm">
          <span className="text-muted-foreground">[{event.phase}]</span> {event.description}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={pending !== null}
            onClick={() => void apply("revert")}
          >
            {pending === "revert" ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
            Revert (match the spec)
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending !== null}
            onClick={() => void apply("amend_spec")}
          >
            {pending === "amend_spec" ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
            Change spec
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending !== null}
            onClick={() => void apply("accept")}
          >
            {pending === "accept" ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
            Accept (with comment)
          </Button>
        </div>
        {error ? (
          <p className="mt-2 text-xs">
            Couldn&apos;t persist the drift-log line: {error}. The DB record was updated; you can retry the file write later.
          </p>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
