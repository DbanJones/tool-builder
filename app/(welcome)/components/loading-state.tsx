import { Loader2 } from "lucide-react";

export function LoadingState() {
  return (
    <div
      className="flex flex-col items-center justify-center gap-4 py-16 text-muted-foreground"
      aria-live="polite"
      aria-busy="true"
    >
      <Loader2 className="h-8 w-8 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      <p className="text-sm">Checking for Claude Code...</p>
    </div>
  );
}
