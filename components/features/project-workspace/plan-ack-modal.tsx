"use client";

import { Dialog } from "@base-ui/react/dialog";
import { ArrowRight, FileText } from "lucide-react";

import { Button } from "@/components/ui/button";

// Pre-build plan acknowledgement (PR-5 of D-031). The first time the novice
// clicks Build it, we show them the spec we'll build against and an approved-
// files count, and ask for an explicit "Go" before the agent starts editing.
//
// Echo-back-protocol-for-novices: CLAUDE.md binding rule 10 demands the
// agent confirm understanding before code. Symmetric obligation here — the
// novice should know what they're committing to before an hour-long agent
// run starts. Not shown on subsequent (correction-mode) builds.

interface PlanAckModalProps {
  open: boolean;
  spec: string;
  approvedFileCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}

export function PlanAckModal({
  open,
  spec,
  approvedFileCount,
  onConfirm,
  onCancel,
}: PlanAckModalProps) {
  const specLines = spec.split("\n").length;
  return (
    <Dialog.Root open={open} onOpenChange={(o) => (o ? null : onCancel())}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/40 backdrop-blur-sm" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 flex max-h-[85vh] w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border bg-background shadow-lg">
          <div className="border-b p-5">
            <Dialog.Title className="text-base font-semibold">
              Ready to build? Quick check first.
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-xs text-muted-foreground">
              Before Dave starts writing code, take a minute to confirm this is what you want
              built. You can edit the spec by talking to Dave — it&apos;s rebuilt from your
              answers each time.
            </Dialog.Description>
            <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1">
                <FileText className="h-3 w-3" aria-hidden="true" />
                {specLines} line spec
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1">
                {approvedFileCount} approved source file{approvedFileCount === 1 ? "" : "s"}
              </span>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto bg-muted/30 p-5">
            <pre
              aria-label="Spec preview"
              className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground"
            >
              {spec.trim().length === 0
                ? "(spec is empty — answer at least one interview question first)"
                : spec}
            </pre>
          </div>
          <div className="flex items-center justify-between gap-3 border-t bg-background p-4">
            <p className="text-[11px] text-muted-foreground">
              Cancel to keep refining. Dave won&apos;t touch your project files until you click
              Go.
            </p>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
                Refine the spec first
              </Button>
              <Button type="button" size="sm" onClick={onConfirm} disabled={spec.trim().length === 0}>
                Go
                <ArrowRight className="ml-1 h-3 w-3" aria-hidden="true" />
              </Button>
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
