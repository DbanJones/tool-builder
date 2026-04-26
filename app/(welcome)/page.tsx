"use client";

import { useEffect, useState } from "react";

import { UpdatePrompt } from "@/app/components/update-prompt";
import { logAuditEvent } from "@/lib/audit";
import { detectCli, type CliState, type DetectionError } from "@/lib/cli-detection";
import { checkForUpdateQuiet, type AvailableUpdate } from "@/lib/updater";

import { AuthState } from "./components/auth-state";
import { InstallState } from "./components/install-state";
import { LoadingState } from "./components/loading-state";
import { ReadyState } from "./components/ready-state";

type Status =
  | { kind: "loading" }
  | { kind: "result"; state: CliState }
  | { kind: "error"; error: DetectionError };

export default function WelcomePage() {
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [pendingUpdate, setPendingUpdate] = useState<AvailableUpdate | null>(null);

  const runDetection = async (): Promise<void> => {
    setStatus({ kind: "loading" });
    const result = await detectCli();
    result.match(
      (state) => setStatus({ kind: "result", state }),
      (error) => setStatus({ kind: "error", error }),
    );
  };

  useEffect(() => {
    void logAuditEvent("app_first_run", {}, { once: true });
    void runDetection();
    // Updater check (Flow J AC1). Quiet variant swallows NotConfigured
    // until Phase E0 ships the real signing keypair (drift D-017).
    void (async () => {
      const r = await checkForUpdateQuiet();
      r.match(
        (update) => setPendingUpdate(update),
        () => {
          /* Network errors etc. — silent on launch; user can retry via menu later. */
        },
      );
    })();
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-8">
      <div className="w-full max-w-2xl">
        {pendingUpdate ? (
          <UpdatePrompt update={pendingUpdate} onDismiss={() => setPendingUpdate(null)} />
        ) : null}
        {status.kind === "loading" && <LoadingState />}
        {status.kind === "result" && status.state === "missing" && (
          <InstallState onRecheck={runDetection} />
        )}
        {status.kind === "result" && status.state === "unauthenticated" && (
          <AuthState onRecheck={runDetection} />
        )}
        {status.kind === "result" && status.state === "ready" && <ReadyState />}
        {status.kind === "error" && (
          <InstallState
            onRecheck={runDetection}
            errorMessage={`Detection failed: ${status.error.message}`}
          />
        )}
      </div>
    </main>
  );
}
