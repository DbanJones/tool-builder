import { Download, RefreshCw } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface InstallStateProps {
  onRecheck: () => void | Promise<void>;
  errorMessage?: string;
}

export function InstallState({ onRecheck, errorMessage }: InstallStateProps) {
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
