import { Channel, invoke } from "@tauri-apps/api/core";
import { ResultAsync } from "neverthrow";

// Mirrors sidecar/src/research-driver.ts ResearchEvent. Wire format is
// the JSON payload the sidecar emits; serde forwards them verbatim
// through the Tauri Channel.
export type ResearchEvent =
  | { kind: "session"; id: string }
  | { kind: "assistant_delta"; text: string }
  | {
      kind: "finding";
      topic: string;
      body: string;
      /** Which prompt axis this came from (problem_users, competitive_landscape, …); null when the model didn't classify. */
      axis: string | null;
      /** URLs / file paths cited via WebFetch / Read. Empty array means general-knowledge claim. */
      sources: string[];
    }
  | { kind: "proposal"; markdown: string; summaryOfChanges: string }
  | {
      kind: "done";
      cost_usd: number | null;
      input_tokens: number | null;
      output_tokens: number | null;
      cancellation_reason: "none" | "user" | "wall_clock" | "step_cap";
    }
  | { kind: "rate_limit"; message: string }
  | { kind: "error"; message: string };

export type ResearchError = { kind: "Transport"; message: string };

export interface ResearchStartOptions {
  projectId: string;
  projectPath: string;
  /** Current spec.md content; the driver fences it into the user prompt. */
  specMarkdown: string;
  /** One line per recorded answer ("Q12 (confident): ..."). May be empty. */
  answersDigest: string;
  /** Approved-file summary block, one section per file. May be empty. */
  filesDigest: string;
  /** Optional model id from settings; sidecar falls back to default. */
  model?: string;
  onEvent: (event: ResearchEvent) => void;
}

const fromInvokeError = (e: unknown): ResearchError => ({
  kind: "Transport",
  message: e instanceof Error ? e.message : String(e),
});

/**
 * Open a deep-research session in the sidecar (Flow M). Returns the
 * streamId so the caller can hand it to `researchStop`. Streams events
 * to `onEvent`; the returned promise resolves when the SDK session
 * ends — successfully, via cancellation, or via cap.
 */
export function researchStart(
  options: ResearchStartOptions,
): ResultAsync<string, ResearchError> {
  const channel = new Channel<ResearchEvent>();
  channel.onmessage = options.onEvent;
  return ResultAsync.fromPromise(
    invoke<string>("research_start", {
      projectId: options.projectId,
      projectPath: options.projectPath,
      specMarkdown: options.specMarkdown,
      answersDigest: options.answersDigest,
      filesDigest: options.filesDigest,
      model: options.model ?? null,
      onEvent: channel,
    }),
    fromInvokeError,
  );
}

/** Cancel an in-flight research session by streamId. No-op if the
 *  streamId is not currently inflight. */
export function researchStop(streamId: string | null = null): ResultAsync<void, ResearchError> {
  return ResultAsync.fromPromise(
    invoke<void>("research_stop", { streamId }),
    fromInvokeError,
  );
}

/**
 * Render a list of recorded answers into the digest format the deep-
 * research prompt expects. One line per answer, newest first.
 */
export function buildAnswersDigest(
  answers: ReadonlyArray<{
    questionId: string;
    answerText: string;
    confidence: string;
  }>,
): string {
  if (answers.length === 0) return "";
  return answers
    .map((a) => `${a.questionId} (${a.confidence}): ${a.answerText.replace(/\s+/g, " ").trim()}`)
    .join("\n");
}

/**
 * Render approved file summaries into the digest block the prompt
 * expects. Empty string if no files are approved or have summaries.
 */
export function buildFilesDigest(
  files: ReadonlyArray<{ name: string; summary?: string | null | undefined }>,
): string {
  const approved = files.filter(
    (f) => typeof f.summary === "string" && f.summary.trim().length > 0,
  );
  if (approved.length === 0) return "";
  return approved
    .map((f) => `## ${f.name}\n${(f.summary ?? "").trim()}`)
    .join("\n\n");
}
