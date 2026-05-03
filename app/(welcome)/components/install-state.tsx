import { invoke } from "@tauri-apps/api/core";
import { Download, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface InstallStateProps {
  onRecheck: () => void | Promise<void>;
  errorMessage?: string;
}

interface ResolutionDiagnostics {
  resolved: string | null;
  probed: string[];
}

export function InstallState({ onRecheck, errorMessage }: InstallStateProps) {
  const [diag, setDiag] = useState<ResolutionDiagnostics | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        const r = await invoke<ResolutionDiagnostics>("cli_resolution_diagnostics");
        setDiag(r);
      } catch {
        /* non-fatal — diagnostics are advisory */
      }
    })();
  }, []);
  return (
    <Card>
      <CardHeader>
        <div className="mb-2 flex items-center gap-3">
          <Download className="h-6 w-6" aria-hidden="true" />
          <CardTitle>Install Claude Code</CardTitle>
        </div>
        <CardDescription>
          Dave-Builder needs the Claude Code CLI installed on your machine. Dave-Builder talks to
          Dave through it, so you do not need to paste an API key.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {errorMessage !== undefined && (
          <Alert variant="destructive">
            <AlertTitle>Detection failed</AlertTitle>
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        )}
        {diag !== null && diag.resolved === null ? (
          <Alert>
            <AlertTitle className="text-xs">Already installed?</AlertTitle>
            <AlertDescription className="text-xs">
              <p className="mb-1">
                If <span className="font-mono">claude</span> already works in your terminal, Dave
                is probably looking in a different place than where you installed it.
              </p>
              <p className="mb-1">Find your install path by running this in a terminal:</p>
              <pre className="rounded bg-muted px-2 py-1 font-mono text-[11px]">
                command -v claude
              </pre>
              <p className="mt-2">
                Dave checked the inherited PATH, your login shell&apos;s PATH (sources{" "}
                <span className="font-mono">.zshrc</span>/<span className="font-mono">.bashrc</span>
                ), plus these well-known install locations:
              </p>
              <details className="mt-1">
                <summary className="cursor-pointer text-muted-foreground">
                  show {diag.probed.length} paths checked
                </summary>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 font-mono text-[10px] text-muted-foreground">
                  {diag.probed.map((p, i) => (
                    <li key={i} className="break-all">
                      {p}
                    </li>
                  ))}
                </ul>
              </details>
              <p className="mt-2">
                If your install isn&apos;t in any of these, drop the path in the chat once Dave is
                up so we can extend the resolver.
              </p>
            </AlertDescription>
          </Alert>
        ) : null}
        <div className="space-y-2 text-sm">
          <p className="font-medium">Quick install</p>
          <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
            <li>
              Open Terminal (press <kbd className="rounded border bg-muted px-1">Cmd</kbd> +{" "}
              <kbd className="rounded border bg-muted px-1">Space</kbd>, type{" "}
              <span className="font-mono">terminal</span>, press Enter).
            </li>
            <li>
              Run:{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                npm install -g @anthropic-ai/claude-code
              </code>
            </li>
            <li>Click Re-check below.</li>
          </ol>
        </div>
        <p className="text-xs text-muted-foreground">
          Full instructions are at{" "}
          <a
            href="https://docs.claude.com/claude-code"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium underline underline-offset-2"
          >
            docs.claude.com/claude-code
          </a>
          .
        </p>
        <Button
          onClick={() => {
            void onRecheck();
          }}
        >
          <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
          Re-check
        </Button>
      </CardContent>
    </Card>
  );
}
