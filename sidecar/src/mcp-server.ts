// MCP server entry point. See ADR-0002 (Claude CLI as orchestrator interface)
// and build-order.md B2.
//
// claude spawns this process via its --mcp-config feature and communicates
// over stdio. The server exposes one tool today (`record_answer`) which
// inserts into `.builder/builder.db`'s answers table. The Tauri shell
// generates the MCP config file per chat turn, baking in the project_id so
// every recorded answer is FK'd to the right project.
//
// Process lifecycle: claude starts the server when a chat turn begins and
// kills it when the turn ends. We open our own better-sqlite3 connection
// (separate from the main sidecar's connection); SQLite + WAL handles
// concurrent readers + serial writers fine.
//
// CLI args:
//   --db-path <path>            Path to SQLite DB file
//   --migrations-folder <path>  Path to drizzle migrations (apply on startup)
//   --project-id <id>           ULID of the project this MCP server is bound to

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { initDb } from "./db.js";
import { record as recordAnswer } from "./handlers/answers.js";

interface Args {
  dbPath: string;
  migrationsFolder: string;
  projectId: string;
}

function parseArgs(argv: string[]): Args {
  let dbPath = ".builder/builder.db";
  let migrationsFolder = "./migrations";
  let projectId: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--db-path" && next !== undefined) {
      dbPath = next;
      i++;
    } else if (arg === "--migrations-folder" && next !== undefined) {
      migrationsFolder = next;
      i++;
    } else if (arg === "--project-id" && next !== undefined) {
      projectId = next;
      i++;
    }
  }
  if (projectId === null) {
    process.stderr.write("MCP server requires --project-id\n");
    process.exit(2);
  }
  return { dbPath, migrationsFolder, projectId };
}

const args = parseArgs(process.argv.slice(2));

try {
  initDb({ dbPath: args.dbPath, migrationsFolder: args.migrationsFolder });
} catch (e) {
  process.stderr.write(`db init failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}

const RecordAnswerArgsSchema = z.object({
  question_id: z.string().min(1),
  answer: z.string().min(1),
  confidence: z.enum(["confident", "tentative", "default-applied"]).optional(),
  rationale: z.string().optional(),
});

const server = new Server(
  { name: "builder-record-answer", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: "record_answer",
      description:
        "Persist the novice's answer to an interview question. Call this whenever the novice gives a clear answer to one of the kit's interview questions. The orchestrator stores the answer, increments the topic counter, and rebuilds spec.md.",
      inputSchema: {
        type: "object",
        properties: {
          question_id: {
            type: "string",
            description: "The kit question id, e.g. 'Q1' or 'Q15'.",
          },
          answer: {
            type: "string",
            description:
              "The novice's answer in their own words, or the synthesised summary you would put in spec.md.",
          },
          confidence: {
            type: "string",
            enum: ["confident", "tentative", "default-applied"],
            description:
              "How confident you are: 'confident' if the novice was clear, 'tentative' if you inferred or partially extracted, 'default-applied' if you fell back to the kit's default.",
          },
          rationale: {
            type: "string",
            description:
              "Optional one-sentence note on why you chose this confidence level or interpretation.",
          },
        },
        required: ["question_id", "answer"],
      },
    },
    {
      name: "queue_questions",
      description:
        "Pre-fetch a batch of up to 10 interview questions for the novice in one round trip. Call this ONCE per turn with all the questions you want to ask. The Builder UI displays them ONE AT A TIME (the novice sees + answers Q1 first, then Q2, etc.); each answer goes into a buffer that is sent back to you in a single follow-up turn so you can call record_answer for all of them at once. This trades round-trip latency for batch throughput — a turn that queues 8 questions is far better than 8 turns of one question each.",
      inputSchema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            description: "The next batch of questions, in the order you want them asked (up to 10).",
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  description: "Kit question id, e.g. 'Q1' or 'Q15'. Used to FK the recorded answer.",
                },
                text: {
                  type: "string",
                  description: "The question itself, in plain language. Shown verbatim to the novice.",
                },
                options: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Optional 3 click-to-pick options for closed questions (yes/no, single-select). Omit for open-ended questions (elevator pitch, freeform descriptions). The UI always appends a 4th 'Enter my own response' button.",
                },
                allow_freeform: {
                  type: "boolean",
                  description:
                    "Whether the novice may type their own answer alongside the click options. Default true; only set false for an enum the build pipeline depends on.",
                },
              },
              required: ["id", "text"],
            },
          },
        },
        required: ["items"],
      },
    },
  ],
}));

const QueueQuestionsArgsSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().min(1),
        text: z.string().min(1),
        // 3 options when present (matches the click-to-pick UX); omit for open-ended.
        options: z.array(z.string().min(1)).length(3).optional(),
        allow_freeform: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(10),
});

server.setRequestHandler(CallToolRequestSchema, (request) => {
  if (request.params.name === "record_answer") {
    const params = RecordAnswerArgsSchema.parse(request.params.arguments ?? {});
    const inserted = recordAnswer({
      projectId: args.projectId,
      questionId: params.question_id,
      answerText: params.answer,
      confidence: params.confidence ?? "tentative",
      source: "chat",
      rationale: params.rationale ?? null,
    });
    return {
      content: [
        {
          type: "text",
          text: `Recorded answer ${inserted.id} for ${inserted.questionId} (confidence=${inserted.confidence}).`,
        },
      ],
    };
  }

  if (request.params.name === "queue_questions") {
    // Same shape as the old offer_options handler: validate the args and
    // return success. The actual UI surfacing happens in the Tauri shell's
    // stream-json parser, which sees the tool_use call and emits a
    // QuestionsQueued chunk to the webview.
    const params = QueueQuestionsArgsSchema.parse(request.params.arguments ?? {});
    return {
      content: [
        {
          type: "text",
          text: `Queued ${String(params.items.length)} question${params.items.length === 1 ? "" : "s"} for the novice; they will answer them one at a time and you will receive all the answers in a single follow-up turn.`,
        },
      ],
    };
  }

  throw new Error(`unknown tool: ${request.params.name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
