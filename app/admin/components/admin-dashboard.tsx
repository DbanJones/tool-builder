"use client";

import { CheckCircle2, Lock, LogOut, Unlock, XCircle } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  clearUnlockToken,
  daysUntilLockout,
  DEMO_MODE,
  isDemoExpired,
  isUnlocked,
  LOCKOUT_DATE,
  PASSWORD_SHA256,
  writeUnlockToken,
} from "@/lib/demo";

interface AdminDashboardProps {
  onSignOut: () => void;
}

interface State {
  now: Date;
  unlocked: boolean;
}

function readState(): State {
  return { now: new Date(), unlocked: isUnlocked() };
}

export function AdminDashboard({ onSignOut }: AdminDashboardProps) {
  const [state, setState] = useState<State>(readState);

  // Refresh on focus so toggling unlock here doesn't go stale if you leave
  // the tab and come back. Cheap.
  useEffect(() => {
    const onFocus = (): void => setState(readState());
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const expired = isDemoExpired(state.now);
  const days = daysUntilLockout(state.now);

  const onUnlock = (): void => {
    writeUnlockToken(PASSWORD_SHA256);
    setState(readState());
  };
  const onRelock = (): void => {
    clearUnlockToken();
    setState(readState());
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-base font-semibold">Demo administration</h1>
        <Button size="sm" variant="ghost" onClick={onSignOut}>
          <LogOut className="mr-1 h-3 w-3" />
          Sign out
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Lockout status</CardTitle>
          <CardDescription>
            Build is in {DEMO_MODE ? "demo mode" : "production mode (no demo gate)"}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Lockout date</dt>
            <dd className="font-mono">{LOCKOUT_DATE}</dd>
            <dt className="text-muted-foreground">Days until lockout</dt>
            <dd className="font-mono">{days}</dd>
            <dt className="text-muted-foreground">Demo expired</dt>
            <dd className="flex items-center gap-1">
              {expired ? (
                <>
                  <XCircle className="h-4 w-4 text-destructive" aria-hidden="true" />
                  <span className="font-medium text-destructive">Yes</span>
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-4 w-4 text-green-600" aria-hidden="true" />
                  <span>Not yet</span>
                </>
              )}
            </dd>
            <dt className="text-muted-foreground">Unlock token present</dt>
            <dd className="flex items-center gap-1">
              {state.unlocked ? (
                <>
                  <Unlock className="h-4 w-4" aria-hidden="true" />
                  <span>Yes — app is currently unlocked</span>
                </>
              ) : (
                <>
                  <Lock className="h-4 w-4" aria-hidden="true" />
                  <span>No</span>
                </>
              )}
            </dd>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Controls</CardTitle>
          <CardDescription>
            Manage the unlock token on this machine. These controls don&apos;t change the lockout
            date itself — to extend, edit <code className="font-mono">lib/demo/config.ts</code>{" "}
            and rebuild.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button size="sm" onClick={onUnlock} disabled={state.unlocked}>
            <Unlock className="mr-1 h-3 w-3" aria-hidden="true" />
            Mark unlocked
          </Button>
          <Button size="sm" variant="outline" onClick={onRelock} disabled={!state.unlocked}>
            <Lock className="mr-1 h-3 w-3" aria-hidden="true" />
            Re-lock (test the demo gate)
          </Button>
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted-foreground">
        Soft demo gate: the lockout date and password hash live in the source. Determined users
        can bypass; this is a speed bump for casual demos, not a security control.
      </p>
    </div>
  );
}
