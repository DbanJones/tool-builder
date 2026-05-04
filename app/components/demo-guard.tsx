"use client";

import { useEffect, useState, type ReactNode } from "react";

import { DemoLockScreen } from "@/app/components/demo-lock-screen";
import { DEMO_MODE, isUnlocked, shouldShowLock } from "@/lib/demo";

// Wraps the app and, in demo builds, shows the lock screen on/after the
// configured lockout date. Unlock state persists in localStorage; once
// unlocked the guard stays out of the way until cleared from /admin.
//
// SSR note: shouldShowLock reads localStorage, which is undefined during
// Next's prerender. We render children on the server and let the effect
// re-evaluate on mount — momentary flash on lock-day reload is fine for a
// soft demo gate.

interface DemoGuardProps {
  children: ReactNode;
}

export function DemoGuard({ children }: DemoGuardProps) {
  const [locked, setLocked] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
    if (!DEMO_MODE) return;
    setLocked(shouldShowLock(new Date()));
  }, []);

  // Re-evaluate when the user crosses the lockout boundary while the app is
  // open (rare for a desktop app; cheap insurance). Checks once an hour.
  useEffect(() => {
    if (!DEMO_MODE) return;
    const id = window.setInterval(() => {
      setLocked(shouldShowLock(new Date()));
    }, 60 * 60 * 1000);
    return () => window.clearInterval(id);
  }, []);

  if (!hydrated || !DEMO_MODE) return <>{children}</>;
  if (locked && !isUnlocked()) {
    return <DemoLockScreen onUnlock={() => setLocked(false)} />;
  }
  return <>{children}</>;
}
