"use client";

import { invoke } from "@tauri-apps/api/core";
import { CheckCircle2, XCircle } from "lucide-react";
import { useEffect, useState } from "react";

import { UpdatePrompt } from "@/app/components/update-prompt";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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

interface CapabilityProbe {
  ok: boolean;
  errors: string[];
  checkedPath: string;
}

const DEFAULT_PROJECT_FOLDER = "~/Documents/ClaudeBuilds";

export default function WelcomePage() {
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [pendingUpdate, setPendingUpdate] = useState<AvailableUpdate | null>(null);
  const [probe, setProbe] = useState<CapabilityProbe | null>(null);

  const runDetection = async (): Promise<void> => {
    setStatus({ kind: "loading" });
    const result = await detectCli();
    result.match(
      (state) => setStatus({ kind: "result", state }),
      (error) => setStatus({ kind: "error", error }),
    );
  };

  const runProbe = async (): Promise<void> => {
    try {
      const r = await invoke<CapabilityProbe>("build_capability_check", {
        projectPath: DEFAULT_PROJECT_FOLDER,
      });
      setProbe(r);
    } catch (e) {
      setProbe({
        ok: false,
        errors: [e instanceof Error ? e.message : String(e)],
        checkedPath: DEFAULT_PROJECT_FOLDER,
      });
    }
  };

  useEffect(() => {
    void logAuditEvent("app_first_run", {}, { once: true });
    void runDetection();
    void runProbe();
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
        {probe ? (
          <Alert
            variant={probe.ok ? "default" : "destructive"}
            className="mb-4"
            role={probe.ok ? undefined : "alert"}
          >
            {probe.ok ? (
              <CheckCircle2 className="h-4 w-4 text-green-600" />
            ) : (
              <XCircle className="h-4 w-4" />
            )}
            <AlertTitle>
              {probe.ok
                ? `Project folder is writable (${probe.checkedPath})`
                : `Project folder check failed (${probe.checkedPath})`}
            </AlertTitle>
            {!probe.ok ? (
              <AlertDescription>
                <ul className="ml-4 list-disc space-y-1 text-xs">
                  {probe.errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </AlertDescription>
            ) : null}
          </Alert>
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
