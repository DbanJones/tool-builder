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
      name: "offer_options",
      description:
        "Present the novice with a set of click-to-pick answer options for a closed question (yes/no, single-select from a known list, etc.). The Builder UI renders each option as a button next to the chat input; if allow_freeform is true the novice can also type their own answer. Use this for any question where the answer space is small and well-defined; for open-ended questions (elevator pitch, lists of flows) do not call this tool — the novice will write a paragraph.",
      inputSchema: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description:
              "The question being asked, in plain language, repeated here for clarity (the same text typically also appears in your chat message).",
          },
          options: {
            type: "array",
            items: { type: "string" },
            description:
              "The candidate answers, in the order you want them shown. Keep each option short (under 30 characters when possible).",
          },
          allow_freeform: {
            type: "boolean",
            description:
              "Whether the novice may type their own answer alongside picking an option. Default true; only set false when no other answer is sensible (e.g. an enum that the build pipeline depends on).",
          },
        },
        required: ["question", "options"],
      },
    },
  ],
}));

const OfferOptionsArgsSchema = z.object({
  question: z.string().min(1),
  // Exactly 3 options per the human's 2026-04-26 direction. The UI always
  // appends a 4th "Enter my own response" button regardless of allow_freeform.
  options: z.array(z.string().min(1)).length(3),
  allow_freeform: z.boolean().optional(),
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

  if (request.params.name === "offer_options") {
    // The MCP server's only job for offer_options is to validate the args
    // and return success — the actual UI surfacing happens in the Tauri
    // shell's stream-json parser, which sees the tool_use call and emits
    // an OptionsOffered chunk to the webview. We return a confirmation so
    // claude knows the options were accepted and can continue its turn.
    const params = OfferOptionsArgsSchema.parse(request.params.arguments ?? {});
    return {
      content: [
        {
          type: "text",
          text: `Offered ${String(params.options.length)} options to the novice; awaiting their pick.`,
        },
      ],
    };
  }

  throw new Error(`unknown tool: ${request.params.name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
