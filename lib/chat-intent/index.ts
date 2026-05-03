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
  | "research"
  | "launch"
  | "deploy"
  | "push"
  | "plan"
  | "annotate"
  | "set_model_opus"
  | "set_model_sonnet"
  | "set_model_haiku"
  | "set_model_default"
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

// Model-swap shortcuts. Setting the model from chat applies the same
// override the Settings page exposes — but to *every* stage at once.
// For per-stage tuning the novice still goes to Settings; this is the
// "give me opus quality across the board" or "drop to sonnet to save
// money" shortcut. Always allowed (no state guard) — the new model
// only takes effect on the next session start for each stage.
const MODEL_OPUS_PHRASES = new Set([
  "use opus",
  "switch to opus",
  "opus please",
  "opus mode",
  "set model opus",
  "make it opus",
]);
const MODEL_SONNET_PHRASES = new Set([
  "use sonnet",
  "switch to sonnet",
  "sonnet please",
  "sonnet mode",
  "set model sonnet",
  "make it sonnet",
]);
const MODEL_HAIKU_PHRASES = new Set([
  "use haiku",
  "switch to haiku",
  "haiku please",
  "haiku mode",
  "set model haiku",
  "make it haiku",
]);
const MODEL_DEFAULT_PHRASES = new Set([
  "default model",
  "default models",
  "reset model",
  "reset models",
  "use defaults",
  "default ai",
]);

// Flow M (deep research). Offered in the chat the moment the interview
// hits readiness; the novice can also type these phrases on their own.
// Only valid before the build has started — running research mid-build
// would race against the orchestrator's use of spec.md.
const RESEARCH_PHRASES = new Set([
  "research",
  "research it",
  "research first",
  "deep research",
  "do research",
  "do deep research",
  "yes research",
  "research approach",
  "research the approach",
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

  // Deep research — only when the interview has reached readiness AND the
  // build hasn't started yet. After the build kicks off, spec.md is the
  // orchestrator's input and a research overwrite would race.
  if (
    !ctx.isRunning &&
    !ctx.hasStarted &&
    ctx.isReadyToBuild &&
    RESEARCH_PHRASES.has(m)
  ) {
    return "research";
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

  // Model swaps — always allowed. They only affect future session
  // starts, so an in-flight build/research keeps its current model.
  if (MODEL_OPUS_PHRASES.has(m)) return "set_model_opus";
  if (MODEL_SONNET_PHRASES.has(m)) return "set_model_sonnet";
  if (MODEL_HAIKU_PHRASES.has(m)) return "set_model_haiku";
  if (MODEL_DEFAULT_PHRASES.has(m)) return "set_model_default";

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
    case "research":
      return "Starting deep research. This usually takes 2-5 minutes — you'll see findings stream in the live tail and a side-by-side diff at the end.";
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
    case "set_model_opus":
      return "Switching every stage to Claude Opus 4.5. Takes effect on the next chat / build / research turn.";
    case "set_model_sonnet":
      return "Switching every stage to Claude Sonnet 4.5. Takes effect on the next chat / build / research turn.";
    case "set_model_haiku":
      return "Switching every stage to Claude Haiku 4.5. Fastest + cheapest, but only suited to short structured turns.";
    case "set_model_default":
      return "Resetting every stage to its built-in default. Settings page > Reset all to defaults does the same thing.";
    case "none":
      return "";
  }
}
