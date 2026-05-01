import { KeyRound, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface AuthStateProps {
  onRecheck: () => void | Promise<void>;
}

export function AuthState({ onRecheck }: AuthStateProps) {
  return (
    <Card>
      <CardHeader>
        <div className="mb-2 flex items-center gap-3">
          <KeyRound className="h-6 w-6" aria-hidden="true" />
          <CardTitle>Sign in to Claude Code</CardTitle>
        </div>
        <CardDescription>
          Claude Code is installed but not yet signed in. Sign in once and Dave-Builder will pick it
          up automatically.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2 text-sm">
          <p className="font-medium">Sign in</p>
          <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
            <li>Open Terminal.</li>
            <li>
              Run: <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">claude</code>
            </li>
            <li>Follow the prompts in your browser to sign in to your Claude account.</li>
            <li>Click Re-check below when done.</li>
          </ol>
        </div>
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
