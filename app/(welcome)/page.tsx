"use client";

import { useEffect, useState } from "react";

import { logAuditEvent } from "@/lib/audit";
import { detectCli, type CliState, type DetectionError } from "@/lib/cli-detection";

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
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-8">
      <div className="w-full max-w-2xl">
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
