"use client";

import { Loader2 } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { downloadAndInstall, type AvailableUpdate } from "@/lib/updater";

// Update prompt per Flow J AC2-AC3. Shown at the top of the Welcome
// screen when checkForUpdate reports a newer version. On Install, runs
// downloadAndInstall (which verifies the signature against the pubkey in
// tauri.conf.json and restarts the app on success). Until Phase E0 ships
// the real pubkey, this UI is unreachable in practice — checkForUpdate
// reports NotConfigured and the launch flow stays quiet.

interface UpdatePromptProps {
  update: AvailableUpdate;
  onDismiss: () => void;
}

export function UpdatePrompt({ update, onDismiss }: UpdatePromptProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const install = async (): Promise<void> => {
    setPending(true);
    setError(null);
    const r = await downloadAndInstall();
    setPending(false);
    r.match(
      () => {
        // The plugin restarts the app on success; this branch usually doesn't
        // run. Defensive: if it does, just let the parent dismiss.
        onDismiss();
      },
      (e) => setError(e.message),
    );
  };

  return (
    <Alert className="mb-4">
      <AlertTitle>
        Builder {update.version} is available (you&apos;re on {update.currentVersion})
      </AlertTitle>
      <AlertDescription>
        {update.body ? <p className="mb-2 text-xs whitespace-pre-wrap">{update.body}</p> : null}
        {error ? <p className="mb-2 text-xs text-destructive">{error}</p> : null}
        <div className="flex gap-2">
          <Button size="sm" onClick={() => void install()} disabled={pending}>
            {pending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
            Install and restart
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss} disabled={pending}>
            Later
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
