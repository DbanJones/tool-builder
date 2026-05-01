// Pure intent matcher for the workspace chat input.
//
// Originally chat was reserved for actual conversation about the spec and
// only "stop" fired actions (the safety hotkey while a build was running).
// D-027 broadens this: the chat is now the primary control surface, and
// short imperative phrases trigger the same actions as the workspace
// header buttons (Build / Resume / Pause-and-annotate / Launch / Deploy /
// Push) plus tab-switch shortcuts (Plan).
//
// Design principle: high precision, low recall. Phrases are matched
// against tight whitelists keyed to the current context (you can't fire
// "build" while running, can't "stop" while idle), and any message over
// MAX_INTENT_CHARS falls through to chat regardless. The novice can still
// type long sentences without accidentally triggering an action.

export type ChatIntent =
  | "stop"
  | "build"
  | "launch"
  | "deploy"
  | "push"
  | "plan"
  | "annotate"
  | "none";

export interface IntentContext {
  /** Has the orchestrator session been kicked off at least once? */
  hasStarted: boolean;
  /** Is a build / chat turn streaming right now? */
  isRunning: boolean;
  /** Has the agent written .builder/review.md (build is past first pass)? */
  hasReview: boolean;
  /** Is the interview readiness gate satisfied (35/35)? */
  isReadyToBuild: boolean;
}

/** Messages over this length are always chat content, never intents. */
const MAX_INTENT_CHARS = 32;

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

const BUILD_PHRASES = new Set([
  "build",
  "build it",
  "start",
  "start build",
  "start the build",
  "begin",
  "go",
  "ship it",
  "make it",
]);

const RESUME_PHRASES = new Set([
  "resume",
  "continue",
  "carry on",
  "keep going",
  "go again",
]);

const LAUNCH_PHRASES = new Set([
  "launch",
  "launch it",
  "launch the app",
  "open",
  "open it",
  "open the app",
  "preview",
  "run it",
  "show me",
]);

const DEPLOY_PHRASES = new Set([
  "deploy",
  "deploy it",
  "publish",
  "publish it",
  "release",
]);

const PUSH_PHRASES = new Set([
  "push",
  "push it",
  "push to github",
  "github",
  "export",
  "export to github",
]);

const PLAN_PHRASES = new Set([
  "plan",
  "show plan",
  "show the plan",
  "open plan",
  "what's the plan",
  "whats the plan",
]);

const ANNOTATE_PHRASES = new Set([
  "annotate",
  "feedback",
  "screenshot",
  "draw",
  "mark up",
  "markup",
]);

function normalise(message: string): string {
  return message
    .trim()
    .toLowerCase()
    .replace(/^[!.?,\s]+|[!.?,\s]+$/g, "")
    .replace(/\s+/g, " ");
}

export function detectIntent(message: string, ctx: IntentContext): ChatIntent {
  const m = normalise(message);
  if (m.length === 0 || m.length > MAX_INTENT_CHARS) return "none";

  // Stop is the priority match — even ambiguous phrases like "pause"
  // should kill the build first if one's running.
  if (ctx.isRunning && STOP_PHRASES.has(m)) return "stop";

  // Build / Resume share an action (startBuild) but the user-facing acks
  // differ; both surface as the "build" intent and the caller decides
  // whether the result is a fresh build or a resume by inspecting hasStarted.
  if (!ctx.isRunning && (BUILD_PHRASES.has(m) || RESUME_PHRASES.has(m))) {
    if (!ctx.hasStarted && !ctx.isReadyToBuild) return "none";
    return "build";
  }

  // Annotate works any time the build has started (button is gated the
  // same way). It auto-pauses if the build is mid-stream.
  if (ctx.hasStarted && ANNOTATE_PHRASES.has(m)) return "annotate";

  // Launch / Deploy / Push only make sense once review.md has been written
  // (the build has produced an artefact worth running, deploying, pushing).
  if (ctx.hasReview && !ctx.isRunning) {
    if (LAUNCH_PHRASES.has(m)) return "launch";
    if (DEPLOY_PHRASES.has(m)) return "deploy";
    if (PUSH_PHRASES.has(m)) return "push";
  }

  // Plan is a tab-switch — always allowed, no state gate.
  if (PLAN_PHRASES.has(m)) return "plan";

  return "none";
}

/**
 * Human-readable acknowledgement to drop into the chat scrollback when an
 * intent fires. Shown as an assistant-style bubble so the novice sees that
 * their words triggered something.
 */
export function ackForIntent(intent: ChatIntent, ctx?: IntentContext): string {
  switch (intent) {
    case "stop":
      return "Stopping the current turn. You can resume any time.";
    case "build":
      return ctx?.hasStarted
        ? "Resuming the build."
        : "Kicking off the build. The dashboard will show progress.";
    case "launch":
      return "Launching the app. Your default browser will open.";
    case "deploy":
      return "Opening the deploy dialog.";
    case "push":
      return "Starting the GitHub push.";
    case "plan":
      return "Switching to the Plan & status tab.";
    case "annotate":
      return "Pausing the build (if running) and opening the annotate window.";
    case "none":
      return "";
  }
}
