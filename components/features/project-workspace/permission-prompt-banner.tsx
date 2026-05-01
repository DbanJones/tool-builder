"use client";

import { Loader2, ShieldQuestion } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { sidecarCall } from "@/lib/sidecar/client";

// Permission prompt banner. Renders the head of the open-permission-request
// queue (one at a time so the novice isn't bombarded). On Allow / Deny:
// resolves the row via the sidecar; the orchestrator MCP server's
// request_permission tool, which is polling that row, picks up the decision
// and returns it to claude (allow → tool runs; deny → tool blocks with
// the optional message back to claude).

export interface OpenPermissionRequest {
  id: string;
  toolName: string;
  inputSummary: string;
  requestedAt: number;
}

interface PermissionPromptBannerProps {
  request: OpenPermissionRequest;
  totalOpen: number;
  onResolved: (id: string) => void;
}

export function PermissionPromptBanner({
  request,
  totalOpen,
  onResolved,
}: PermissionPromptBannerProps) {
  const [pending, setPending] = useState<"allowed" | "denied" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: "allowed" | "denied"): Promise<void> => {
    setPending(decision);
    setError(null);
    const r = await sidecarCall("permissionRequests.resolve", {
      id: request.id,
      decision,
      decisionMessage:
        decision === "denied"
          ? "Novice clicked Deny in the dashboard."
          : null,
    });
    setPending(null);
    r.match(
      () => onResolved(request.id),
      (e) => setError(e.kind === "Sidecar" ? `${e.code}: ${e.message}` : e.message),
    );
  };

  return (
    <Alert className="mx-4 mt-3 mb-1 border-yellow-600/40 bg-yellow-50/30 dark:bg-yellow-950/20">
      <ShieldQuestion className="h-4 w-4" aria-hidden="true" />
      <AlertTitle>
        Dave wants to run <span className="font-mono">{request.toolName}</span>
        {totalOpen > 1 ? ` (${totalOpen} pending)` : null}
      </AlertTitle>
      <AlertDescription>
        <pre className="mb-3 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded border bg-background/80 p-2 text-[10px] font-mono">
          {prettyInput(request.inputSummary)}
        </pre>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={pending !== null}
            onClick={() => void decide("allowed")}
          >
            {pending === "allowed" ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
            Allow
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending !== null}
            onClick={() => void decide("denied")}
          >
            {pending === "denied" ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
            Deny
          </Button>
        </div>
        {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
      </AlertDescription>
    </Alert>
  );
}

function prettyInput(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
