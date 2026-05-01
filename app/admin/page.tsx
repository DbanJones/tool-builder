"use client";

import { useState } from "react";

import { AdminDashboard } from "./components/admin-dashboard";
import { AdminLogin } from "./components/admin-login";

// /admin — gated dashboard for managing the demo lockout (view state,
// extend/release, force-relock for testing). Same password as the demo
// unlock screen. The session-only `authed` flag means closing the tab
// re-asserts the gate; we deliberately don't reuse the persisted unlock
// token here so admin access is more deliberate than just "the demo is
// unlocked on this machine".

export default function AdminPage() {
  const [authed, setAuthed] = useState(false);
  return (
    <main className="flex min-h-full items-center justify-center bg-background p-8">
      <div className="w-full max-w-2xl">
        {authed ? (
          <AdminDashboard onSignOut={() => setAuthed(false)} />
        ) : (
          <AdminLogin onSuccess={() => setAuthed(true)} />
        )}
      </div>
    </main>
  );
}
