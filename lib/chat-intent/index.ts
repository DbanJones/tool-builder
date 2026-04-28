// Pure intent matcher for the workspace chat input. The novice should be
// able to drive the whole flow from chat — "build it", "deploy", "stop",
// "push to github" — without hunting for buttons. We classify the message
// here; the workspace decides which side-effect to fire.
//
// Design principle: high precision, low recall. False positives are
// expensive (firing a build because the user said "I think we should build
// a CRM" would be terrible), so we only match short imperative messages
// against a tight whitelist. Longer messages always fall through to chat.

export type ChatIntent = "build" | "stop" | "deploy" | "push" | "none";

export interface IntentContext {
  /** Has the orchestrator session been kicked off at least once? */
  hasStarted: boolean;
  /** Is a build / chat turn streaming right now? */
  isRunning: boolean;
  /** Has the agent written .builder/review.md (build is past first pass)? */
  hasReview: boolean;
}

/** Messages over this length are always chat content, never intents. */
const MAX_INTENT_CHARS = 32;

const BUILD_PHRASES = new Set([
  "build",
  "build it",
  "build now",
  "build please",
  "build the app",
  "go",
  "go ahead",
  "lets build",
  "let's build",
  "let's build it",
  "lets build it",
  "ok build",
  "ok build it",
  "ok go",
  "yes build",
  "yes build it",
  "start",
  "start build",
  "start the build",
]);

const STOP_PHRASES = new Set([
  "stop",
  "stop it",
  "stop please",
  "stop the build",
  "halt",
  "pause",
  "cancel",
  "abort",
]);

const DEPLOY_PHRASES = new Set([
  "deploy",
  "deploy it",
  "deploy now",
  "deploy please",
  "deploy preview",
  "publish",
  "publish it",
  "push live",
  "ship it",
]);

const PUSH_PHRASES = new Set([
  "push",
  "push it",
  "push to github",
  "push to gh",
  "save to github",
  "save it to github",
  "github",
  "back up to github",
]);

function normalise(message: string): string {
  return message
    .trim()
    .toLowerCase()
    // strip surrounding punctuation but keep apostrophes inside words
    .replace(/^[!.?,\s]+|[!.?,\s]+$/g, "")
    // collapse runs of whitespace
    .replace(/\s+/g, " ");
}

export function detectIntent(message: string, ctx: IntentContext): ChatIntent {
  const m = normalise(message);
  if (m.length === 0 || m.length > MAX_INTENT_CHARS) return "none";

  if (!ctx.hasStarted && !ctx.isRunning && BUILD_PHRASES.has(m)) return "build";
  if (ctx.isRunning && STOP_PHRASES.has(m)) return "stop";
  if (ctx.hasStarted && !ctx.isRunning && ctx.hasReview && DEPLOY_PHRASES.has(m)) {
    return "deploy";
  }
  if (ctx.hasStarted && !ctx.isRunning && PUSH_PHRASES.has(m)) return "push";
  return "none";
}

/**
 * Human-readable acknowledgement to drop into the chat scrollback when an
 * intent fires. Shown as an assistant-style bubble so the novice sees that
 * their words triggered something.
 */
export function ackForIntent(intent: ChatIntent): string {
  switch (intent) {
    case "build":
      return "Got it — kicking off the build now. The right rail will switch to the live plan.";
    case "stop":
      return "Stopping the current turn. You can resume any time.";
    case "deploy":
      return "Deploying a preview to Vercel. I'll drop the URL here when it's up.";
    case "push":
      return "Pushing the project folder to a private GitHub repo.";
    case "none":
      return "";
  }
}
