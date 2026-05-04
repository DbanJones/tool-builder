// Interview-chat driver per ADR-0005 follow-up. Same shape as
// orchestrator-driver.ts but with a different system prompt + tool set:
//   - First turn uses Opus (kit-style "preparing question bank" UX)
//   - Exposes the queue_questions MCP tool (so claude can pre-fetch
//     batches of interview questions; the dashboard renders them one
//     at a time and flushes answers in bulk per UX3)
//   - Exposes the record_answer MCP tool so each clear answer lands in
//     the answers table
//
// Replaces the Rust subprocess spawn in chat.rs. The Tauri shell becomes
// a thin pass-through (chat_send → sidecar_rpc_stream → chat.start).

import {
  query,
  type Options,
  type SDKMessage,
  createSdkMcpServer,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { list as listAnswers, record as recordAnswer } from "./handlers/answers.js";
import { QUESTION_IDS } from "./interview-question-ids.js";

const INTERVIEW_SYSTEM_PROMPT = `You are the Builder's recursive interviewer. Your job is to populate the project's spec.md by asking the novice the kit's fast-path questions (28 baseline, plus high-stakes follow-ups when activated, plus any extra questions the project genuinely needs — you are NOT capped at 28).

THE PIPELINE (read this carefully — it changes how you should behave):
- The Builder UI shows the novice ONE question at a time, but you generate them in BATCHES of up to 10 per turn. You call the \`queue_questions\` tool ONCE per turn with the next batch; the UI displays the head of the queue, the novice answers, the UI displays the next, and so on.
- When the queue empties, the UI sends you all the buffered answers in a single follow-up turn. You must:
  1. Call \`record_answer\` ONCE per question they answered.
  2. Then call \`queue_questions\` ONCE with the next batch.
  3. Write a brief one-sentence acknowledgement to the chat so the novice sees the batch landed.
- Do NOT put the question text in your assistant message instead of (or in addition to) \`queue_questions\`. The UI only renders questions from the queue.

The first turn is special:
- The novice's first message describes their project. The Builder UI shows a 'Preparing question bank' indicator while you generate your reply.
- In your first reply: briefly (one sentence) reflect what you understood, then state 'Question bank ready: ~35 fast-path questions to work through.', then call \`queue_questions\` with the FIRST batch of up to 10 questions. Do NOT call record_answer for the freeform first message.

Files: The first batch SHOULD include one question asking the novice if they have any supporting files (PDFs, screenshots, schemas, CSVs, spreadsheets, transcripts) they'd like to share. Tell them they can drop files anywhere on the workspace; the right rail's Files tab shows what they've shared. If they reference a file with @filename in chat, the workspace will inject the file's structural summary into your context — treat the summary as authoritative for that file.

Valid question ids are Q1 through Q35 only. The Builder will reject any other id.

Three of the questions exist specifically to stop the build from generating something the novice didn't picture. Treat them as load-bearing — never skip them, never paper over a vague answer:
- **Q33 (deliverable artifact)**: forces the novice to name the concrete thing they will open at the end (an .xlsx file, a web dashboard, an emailed PDF). If they answer in features ("a financial model"), follow up to get the form ("an Excel file? a web app?"). Without this answer, the agent will pick a shape and probably the wrong one.
- **Q34 (reference anchors)**: 1-3 named tools the build should resemble, with similarities and differences. Anchors the agent to prior art rather than inventing.
- **Q35 (non-negotiables)**: features or properties whose absence would make the novice reject the build outright. Capture them verbatim; they become hard constraints downstream.

How to write each queued question:
- Plain language. No jargon unless you have just defined it.
- For closed questions (yes/no, single-select), supply EXACTLY 3 candidate \`options\`. The UI appends a 4th 'Enter my own response' button automatically.
- For open-ended questions, omit \`options\`.
- The \`id\` field is the kit question id (Q1, Q15, etc.).

Section coverage rule: spec.md has seven numbered sections (§1 problem & users, §2 scope, §3 flows + definition of done, §4 data model, §5 integrations, §6 non-functional, §7 build methodology). The interview is NOT complete until at least one question has been asked AND answered for each section. Track section coverage as you go and bias your next batch toward sections that haven't yet been touched. The question library's \`influencesSpecSections\` field tells you which sections each Q feeds — use it.

Do not invent answers. If an answer is unclear after one follow-up, mark it tentative and move on.`;

export interface ChatOptions {
  projectId: string;
  projectPath: string;
  prompt: string;
  sessionId?: string | null;
  /** Model override from settings. When omitted, the driver picks
   *  Opus for first turn / Sonnet for subsequent turns. */
  model?: string;
}

export interface QueuedQuestion {
  id: string;
  text: string;
  options: string[];
  allow_freeform: boolean;
}

export type ChatChunk =
  | { kind: "session"; id: string }
  | { kind: "assistant_delta"; text: string }
  | { kind: "questions_queued"; items: QueuedQuestion[] }
  | {
      kind: "done";
      cost_usd: number | null;
      input_tokens: number | null;
      output_tokens: number | null;
    }
  | { kind: "rate_limit"; message: string }
  | { kind: "error"; message: string };

const inflight = new Map<string, AbortController>();

/** Build the SDK MCP server that exposes record_answer + queue_questions
 *  as plain Node functions running in this same process — no external
 *  spawn, no separate auth, no permission prompts. */
function buildChatMcp(projectId: string, onQueue: (items: QueuedQuestion[]) => void) {
  return createSdkMcpServer({
    name: "builder-chat",
    version: "0.1.0",
    tools: [
      tool(
        "record_answer",
        "Persist the novice's answer to an interview question.",
        {
          question_id: z.enum(QUESTION_IDS),
          answer: z.string().min(1),
          confidence: z.enum(["confident", "tentative", "default-applied"]).optional(),
          rationale: z.string().nullable().optional(),
        },
        async (args) => {
          const inserted = recordAnswer({
            projectId,
            questionId: args.question_id,
            answerText: args.answer,
            confidence: args.confidence ?? "tentative",
            source: "chat",
            rationale: args.rationale ?? null,
          });
          return {
            content: [
              {
                type: "text",
                text: `Recorded answer ${inserted.id} for ${inserted.questionId} (confidence=${inserted.confidence}).`,
              },
            ],
          };
        },
      ),
      tool(
        "queue_questions",
        "Pre-fetch a batch of up to 10 interview questions; the UI shows them one at a time and flushes answers in bulk.",
        {
          items: z
            .array(
              z.object({
                id: z.enum(QUESTION_IDS),
                text: z.string().min(1),
                options: z.array(z.string().min(1)).length(3).optional(),
                allow_freeform: z.boolean().optional(),
              }),
            )
            .min(1)
            .max(10),
        },
        async (args) => {
          const items: QueuedQuestion[] = args.items.map((it) => ({
            id: it.id,
            text: it.text,
            options: it.options ?? [],
            allow_freeform: it.allow_freeform ?? true,
          }));
          onQueue(items);
          return {
            content: [
              {
                type: "text",
                text: `Queued ${String(items.length)} question${items.length === 1 ? "" : "s"} for the novice.`,
              },
            ],
          };
        },
      ),
    ],
  });
}

export async function runChat(
  streamId: string,
  opts: ChatOptions,
  onEvent: (event: ChatChunk) => void,
): Promise<void> {
  const ac = new AbortController();
  inflight.set(streamId, ac);
  const queuedDuringTurn: QueuedQuestion[] = [];
  try {
    const mcp = buildChatMcp(opts.projectId, (items) => {
      queuedDuringTurn.push(...items);
    });
    // On a new session (no resume id) we look at the answers table and
    // inject any previously-recorded answers into the system prompt as
    // "already answered, do not re-ask" context. Without this, reloading
    // the project mid-interview makes claude restart from Q1 because the
    // SDK session it had is gone — the user's complaint that it keeps
    // re-asking old questions.
    let systemPrompt = INTERVIEW_SYSTEM_PROMPT;
    if (!opts.sessionId) {
      try {
        const prior = listAnswers({ projectId: opts.projectId });
        if (prior.length > 0) {
          // De-dupe to the newest answer per question id (list returns
          // newest-first, so first occurrence wins).
          const seen = new Set<string>();
          const lines: string[] = [];
          for (const a of prior) {
            if (seen.has(a.questionId)) continue;
            seen.add(a.questionId);
            lines.push(`- ${a.questionId}: ${a.answerText.replace(/\s+/g, " ").trim()}`);
          }
          systemPrompt += `\n\n=== ALREADY ANSWERED — DO NOT RE-ASK ===\nThe novice has already given the following answers in a previous session. Treat each as a recorded answer; do NOT call record_answer for them again, and do NOT include them in your next queue_questions batch. Pick up from the next un-answered question.\n${lines.join("\n")}\n=== END ===`;
        }
      } catch {
        /* If the table is empty or the read fails, just use the base prompt — non-fatal. */
      }
    }

    const sdkOptions: Options = {
      cwd: opts.projectPath,
      additionalDirectories: [opts.projectPath],
      // First turn → Opus for first-impression quality. Subsequent turns
      // (sessionId set) → Sonnet for speed/cost. Same heuristic as the
      // old chat.rs. Settings can override either branch by passing
      // `model`; without an override the heuristic stands.
      model: opts.model ?? (opts.sessionId ? "claude-sonnet-4-5" : "claude-opus-4-5"),
      permissionMode: "default",
      // Chat path doesn't need to write files in the novice's project,
      // and we want NO permission UI for it. Allow only our own MCP tools.
      allowedTools: [
        "mcp__builder-chat__record_answer",
        "mcp__builder-chat__queue_questions",
      ],
      mcpServers: { "builder-chat": mcp },
      systemPrompt,
      abortController: ac,
    };
    if (opts.sessionId) {
      sdkOptions.resume = opts.sessionId;
    }
    const q = query({ prompt: opts.prompt, options: sdkOptions });
    for await (const msg of q) {
      const events = translate(msg);
      for (const ev of events) onEvent(ev);
    }
    // Flush any questions queued during this turn — emit AFTER the SDK's
    // generator ends so the dashboard sees them as a single
    // `questions_queued` event per turn.
    if (queuedDuringTurn.length > 0) {
      onEvent({ kind: "questions_queued", items: queuedDuringTurn });
    }
  } catch (e) {
    if (ac.signal.aborted) return;
    onEvent({
      kind: "error",
      message: e instanceof Error ? e.message : String(e),
    });
  } finally {
    inflight.delete(streamId);
  }
}

export function cancelChat(streamId: string): boolean {
  const ac = inflight.get(streamId);
  if (!ac) return false;
  ac.abort();
  return true;
}

function translate(msg: SDKMessage): ChatChunk[] {
  switch (msg.type) {
    case "system": {
      const m = msg as { type: "system"; subtype?: string; session_id?: string };
      if (m.subtype === "init" && m.session_id) {
        return [{ kind: "session", id: m.session_id }];
      }
      return [];
    }
    case "assistant": {
      const m = msg as unknown as {
        type: "assistant";
        message: { content: Array<Record<string, unknown>> };
      };
      const content = Array.isArray(m.message?.content) ? m.message.content : [];
      let text = "";
      for (const block of content) {
        if (
          (block as { type?: string }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string"
        ) {
          text += (block as { text: string }).text;
        }
      }
      return text ? [{ kind: "assistant_delta", text }] : [];
    }
    case "result": {
      const m = msg as {
        type: "result";
        subtype?: string;
        total_cost_usd?: number;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      if (m.subtype !== "success") return [];
      return [
        {
          kind: "done",
          cost_usd: typeof m.total_cost_usd === "number" ? m.total_cost_usd : null,
          input_tokens:
            typeof m.usage?.input_tokens === "number" ? m.usage.input_tokens : null,
          output_tokens:
            typeof m.usage?.output_tokens === "number" ? m.usage.output_tokens : null,
        },
      ];
    }
    default:
      return [];
  }
}
