"use client";

import { Dialog } from "@base-ui/react/dialog";
import { AlertTriangle } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { Defect } from "@/lib/debug";

// Deploy-gate modal per Flow L AC8 and source spec §F.2 ("block deploy
// on critical"). When the novice clicks Deploy preview to Vercel and
// the project has unresolved critical-band defects, the page intercepts
// and opens this dialog. The user sees the findings + a typed-
// confirmation input requiring them to type "deploy anyway" verbatim
// before the deploy proceeds. Matches the "irreversible-action double-
// confirm" pattern in O30/O31 + lib/danger.ts (rules/06-other.md).

const REQUIRED_PHRASE = "deploy anyway";

export interface DeployGateModalProps {
  open: boolean;
  /** Critical-band defects whose status is open or fixing. */
  criticalDefects: readonly Defect[];
  onCancel: () => void;
  /** Called when the user types the phrase verbatim and clicks Deploy anyway. */
  onConfirm: () => void;
}

export function DeployGateModal({
  open,
  criticalDefects,
  onCancel,
  onConfirm,
}: DeployGateModalProps) {
  const [typed, setTyped] = useState("");
  const allowed = typed.trim().toLowerCase() === REQUIRED_PHRASE;

  const handleConfirm = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!allowed) return;
    setTyped("");
    onConfirm();
  };

  const handleCancel = (): void => {
    setTyped("");
    onCancel();
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o: boolean) => {
        if (!o) handleCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/40 backdrop-blur-sm" />
        <Dialog.Popup
          className="fixed left-1/2 top-1/2 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-background p-6 shadow-lg"
          data-testid="deploy-gate-modal"
        >
          <Dialog.Title className="flex items-center gap-2 text-base font-semibold">
            <AlertTriangle className="h-4 w-4 text-destructive" aria-hidden="true" />
            Deploy blocked: critical defects unresolved
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-muted-foreground">
            Your app has {criticalDefects.length} critical-band{" "}
            {criticalDefects.length === 1 ? "defect" : "defects"} that have not
            been fixed. Deploying now will ship them to your Vercel preview URL.
          </Dialog.Description>

          <ul
            className="mt-4 max-h-48 space-y-2 overflow-auto rounded border bg-muted/40 p-3 text-xs"
            data-testid="deploy-gate-list"
          >
            {criticalDefects.map((d) => (
              <li key={d.id}>
                <p className="font-medium text-foreground">
                  {d.humanExplanation}
                </p>
                <p className="text-muted-foreground">
                  {d.file}:{d.lineStart}
                </p>
              </li>
            ))}
          </ul>

          <form onSubmit={handleConfirm} className="mt-4 space-y-3">
            <label className="block text-xs font-medium" htmlFor="deploy-gate-phrase">
              To proceed anyway, type <code className="font-mono">deploy anyway</code>:
            </label>
            <input
              id="deploy-gate-phrase"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="w-full rounded border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              data-testid="deploy-gate-input"
              aria-label="Confirmation phrase"
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={handleCancel}
                data-testid="deploy-gate-cancel"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="destructive"
                disabled={!allowed}
                data-testid="deploy-gate-confirm"
              >
                Deploy anyway
              </Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// selectUnresolvedCritical lives in lib/debug/selectors.ts so its unit
// tests don't drag the @/components/ui/button alias into the Vitest
// resolver. Re-export here for the page's import-as-pair convenience.
export { selectUnresolvedCritical } from "@/lib/debug/selectors";
