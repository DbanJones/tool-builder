"use client";

import { Dialog } from "@base-ui/react/dialog";
import { Loader2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { setVercelToken } from "@/lib/deploy";

// Modal per Flow I AC1: prompts the novice for a Vercel access token with a
// "Where do I get this?" link. On submit, persists the token to the OS
// keychain (lib/deploy::setVercelToken) and fires onTokenSaved so the parent
// can immediately call deployToVercel without re-reading.

interface DeployModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onTokenSaved: () => void;
}

export function DeployModal({ open, onOpenChange, onTokenSaved }: DeployModalProps) {
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!token.trim()) {
      setError("Paste your Vercel access token to continue.");
      return;
    }
    setPending(true);
    setError(null);
    const r = await setVercelToken(token.trim());
    setPending(false);
    r.match(
      () => {
        setToken("");
        onTokenSaved();
        onOpenChange(false);
      },
      (e) => setError(e.message),
    );
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/40 backdrop-blur-sm" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-background p-6 shadow-lg">
          <Dialog.Title className="text-base font-semibold">Vercel access token</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-muted-foreground">
            Stored in your OS keychain (per ADR-0003) — never written to disk in plain text and never sent
            to Anthropic. Only used to run `vercel deploy` from your project folder.
          </Dialog.Description>

          <form onSubmit={(e) => void submit(e)} className="mt-4 space-y-3">
            <label className="block text-xs">
              <span className="font-medium">Token</span>
              <input
                type="password"
                autoFocus
                value={token}
                onChange={(e) => setToken(e.target.value)}
                aria-invalid={error !== null}
                aria-describedby={error ? "deploy-token-error" : undefined}
                disabled={pending}
                className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-primary"
                placeholder="vrc_..."
              />
            </label>
            {error ? (
              <p id="deploy-token-error" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
            <p className="text-[11px] text-muted-foreground">
              <a
                href="https://vercel.com/account/tokens"
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                Where do I get this?
              </a>{" "}
              Generate a personal access token at vercel.com/account/tokens, scoped to your team.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={pending}>
                {pending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                Save and deploy
              </Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
