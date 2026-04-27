// Orchestrator-side MCP server. Exposes ONE tool: `request_permission`.
//
// Mechanism: claude is spawned with `--permission-prompt-tool
// mcp__builder-orchestrator__request_permission`. Whenever claude wants
// to perform a tool action that isn't auto-allowed (write outside cwd,
// shell command, etc.), it calls this tool with the tool name + input.
// We:
//   1. Insert a row into permission_requests with status=pending.
//   2. Poll every 200ms for the row's status to flip (the dashboard's
//      PermissionPromptBanner watches the same table and writes the
//      novice's Allow / Deny decision via permissionRequests.resolve).
//   3. Return the decision to claude in the format Claude Code expects:
//      content[0].text = JSON of { behavior: "allow" } or
//                                 { behavior: "deny", message: "..." }.
//   4. Time out after 5 min if the novice never responds — fail safe to
//      Deny so claude doesn't hang forever.
//
// CLI args mirror mcp-server.ts (the chat MCP):
//   --db-path <path>            SQLite DB
//   --migrations-folder <path>  drizzle migrations (apply on startup)
//   --project-id <ulid>         project to record requests against

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { initDb } from "./db.js";
import { append as appendRequest, poll as pollRequest } from "./handlers/permission-requests.js";

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
    process.stderr.write("orchestrator MCP server requires --project-id\n");
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

// claude's permission-prompt-tool protocol: input is { tool_name: string,
// input: any }; the tool's response content[0].text must be JSON of
// { behavior: "allow", updatedInput?: any } | { behavior: "deny", message: string }.
const RequestPermissionArgsSchema = z.object({
  tool_name: z.string().min(1),
  input: z.unknown().optional(),
});

const POLL_INTERVAL_MS = 200;
const TIMEOUT_MS = 5 * 60 * 1000;

const server = new Server(
  { name: "builder-orchestrator", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: "request_permission",
      description:
        "Request the novice's permission to perform a sensitive tool action. The Builder dashboard will pop up an Allow / Deny banner; the tool blocks until the novice clicks. Times out (defaulting to deny) after 5 minutes. Used by claude when it wants to do something outside the auto-allowed sandbox (e.g. write to a path outside the project, run a shell command).",
      inputSchema: {
        type: "object",
        properties: {
          tool_name: {
            type: "string",
            description: "The tool you are about to call (e.g. 'Bash', 'Write').",
          },
          input: {
            description:
              "The full tool input you would have called the tool with. Will be shown to the novice so they can decide.",
          },
        },
        required: ["tool_name"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "request_permission") {
    throw new Error(`unknown tool: ${request.params.name}`);
  }
  const params = RequestPermissionArgsSchema.parse(request.params.arguments ?? {});
  const inputSummary = JSON.stringify(params.input ?? {});

  const inserted = appendRequest({
    projectId: args.projectId,
    toolName: params.tool_name,
    inputSummary,
  });

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const row = pollRequest({ id: inserted.id });
    if (!row) {
      // Should never happen; defensive break.
      return decisionContent({ behavior: "deny", message: "Request row vanished." });
    }
    if (row.status === "allowed") {
      return decisionContent({ behavior: "allow" });
    }
    if (row.status === "denied") {
      return decisionContent({
        behavior: "deny",
        message: row.decisionMessage ?? "Denied by user.",
      });
    }
    if (row.status === "expired") {
      return decisionContent({
        behavior: "deny",
        message: "This permission request was previously expired or cancelled.",
      });
    }
    // status === "pending" → keep polling
  }

  // Timed out. Mark expired so a stale row doesn't sit in listOpen forever.
  // The handler is idempotent so even if the novice clicks Allow racily, the
  // expired status is what we report back to claude (consistent with our
  // "fail safe to deny" policy).
  return decisionContent({
    behavior: "deny",
    message: "Permission request timed out (5 min). Try again.",
  });
});

interface AllowDecision {
  behavior: "allow";
  updatedInput?: unknown;
}
interface DenyDecision {
  behavior: "deny";
  message: string;
}

function decisionContent(decision: AllowDecision | DenyDecision): {
  content: { type: "text"; text: string }[];
} {
  return {
    content: [{ type: "text", text: JSON.stringify(decision) }],
  };
}

const transport = new StdioServerTransport();
await server.connect(transport);
