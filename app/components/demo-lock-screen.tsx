"use client";

import { Lock } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  LOCKOUT_DATE,
  PASSWORD_SHA256,
  sha256Hex,
  verifyPassword,
  writeUnlockToken,
} from "@/lib/demo";

// Full-screen overlay shown when the demo has expired and no unlock token
// is present. The same password gates the /admin route.

interface DemoLockScreenProps {
  onUnlock: () => void;
}

export function DemoLockScreen({ onUnlock }: DemoLockScreenProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const ok = await verifyPassword(password);
      if (!ok) {
        setError("Incorrect password.");
        setPending(false);
        return;
      }
      // Persist the hash of the input (== PASSWORD_SHA256 since it matched)
      // so subsequent launches start unlocked. We re-hash here rather than
      // writing the constant directly so the storage value is derived from
      // user input, not from the source — defence in depth.
      const token = await sha256Hex(password);
      writeUnlockToken(token === PASSWORD_SHA256 ? token : PASSWORD_SHA256);
      onUnlock();
    } catch (e) {
      setError(`Couldn't verify: ${e instanceof Error ? e.message : String(e)}`);
      setPending(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="demo-lock-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background p-8"
    >
      <div className="w-full max-w-md space-y-5 rounded-lg border bg-card p-8 shadow-lg">
        <div className="flex items-center gap-3">
          <span className="rounded-full border border-destructive/40 bg-destructive/10 p-2 text-destructive">
            <Lock className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h1 id="demo-lock-title" className="text-base font-semibold">
              Demo period has ended
            </h1>
            <p className="text-xs text-muted-foreground">
              This is a demo build of Dave-Builder. The demo window expired on {LOCKOUT_DATE}.
            </p>
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          Enter the unlock password to continue using the app, or contact the person who provided
          the demo for a current build.
        </p>

        <form onSubmit={(e) => void submit(e)} className="space-y-3">
          <label className="block text-xs">
            <span className="font-medium">Unlock password</span>
            <input
              type="password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={error !== null}
              aria-describedby={error ? "demo-lock-error" : undefined}
              disabled={pending}
              className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-primary"
              placeholder="••••••••••"
            />
          </label>
          {error ? (
            <p id="demo-lock-error" role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <Button type="submit" size="sm" disabled={pending || password.length === 0} className="w-full">
            {pending ? "Verifying…" : "Unlock"}
          </Button>
        </form>
      </div>
    </div>
  );
}
