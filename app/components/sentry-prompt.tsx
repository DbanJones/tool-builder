"use client";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { setSentryDecision, type SentryDecision } from "@/lib/telemetry";

// Sentry opt-in prompt per rules/06-other.md O7 + spec.md §6 + §8 default.
// Shown ONCE after the user's first successful build (the dashboard tracks
// "first done event since mount + no decision recorded" and renders this).
//
// Per O16: we explicitly tell the novice we never send chat content or
// project paths. The actual Sentry SDK isn't wired yet (drift D-019); this
// just captures the consent so it's ready when the SDK lands.

interface SentryPromptProps {
  onDecided: (decision: SentryDecision) => void;
}

export function SentryPrompt({ onDecided }: SentryPromptProps) {
  const decide = (decision: SentryDecision): void => {
    setSentryDecision(decision);
    onDecided(decision);
  };

  return (
    <Alert className="mx-4 mt-3 mb-1">
      <AlertTitle>Help improve Dave-Builder?</AlertTitle>
      <AlertDescription>
        <p className="mb-2 text-xs">
          We can send anonymous error reports to Sentry when something goes wrong, so future
          builds work better. We never send your chat with Dave, your spec.md, your project
          path, or any file you uploaded — only the error itself and the line of code that
          threw.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => decide("accepted")}>
            Yes, send error reports
          </Button>
          <Button size="sm" variant="outline" onClick={() => decide("declined")}>
            No thanks
          </Button>
          <Button size="sm" variant="ghost" onClick={() => decide("deferred")}>
            Ask me later
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
