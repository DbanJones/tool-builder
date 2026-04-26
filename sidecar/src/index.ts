// Node sidecar entry point. See ADR-0004.
//
// Reads JSON-RPC requests one per line on stdin, dispatches to handlers,
// writes one JSON response per line on stdout. Stderr is reserved for log
// output and is captured by the Tauri shell for debugging.
//
// Protocol:
//   request:  { "id": "<opaque>", "method": "<name>", "params": <any> }
//   success:  { "id": "<same>", "ok": true,  "result": <any> }
//   failure:  { "id": "<same>", "ok": false, "error": { "code": "<str>", "message": "<str>" } }
//
// CLI args:
//   --db-path <path>            Path to SQLite DB file (default: .builder/builder.db)
//   --migrations-folder <path>  Path to drizzle migrations (default: ./migrations)

import { z } from "zod";

import { initDb } from "./db.js";
import { record as recordAnswer, list as listAnswers } from "./handlers/answers.js";
import { logEvent, listEvents } from "./handlers/audit.js";
import { extractText, parseSchema, summariseImage } from "./handlers/files.js";
import { create as createProject, list as listProjects, get as getProject } from "./handlers/projects.js";

const RequestSchema = z.object({
  id: z.string(),
  method: z.string(),
  params: z.unknown().optional(),
});

type Request = z.infer<typeof RequestSchema>;
type Handler = (params: unknown) => Promise<unknown> | unknown;

interface Args {
  dbPath: string;
  migrationsFolder: string;
}

function parseArgs(argv: string[]): Args {
  let dbPath = ".builder/builder.db";
  let migrationsFolder = "./migrations";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--db-path" && next !== undefined) {
      dbPath = next;
      i++;
    } else if (arg === "--migrations-folder" && next !== undefined) {
      migrationsFolder = next;
      i++;
    }
  }
  return { dbPath, migrationsFolder };
}

const writeResponse = (response: object): void => {
  process.stdout.write(JSON.stringify(response) + "\n");
};

const writeLog = (level: "info" | "warn" | "error", message: string): void => {
  process.stderr.write(JSON.stringify({ level, message, at: new Date().toISOString() }) + "\n");
};

const args = parseArgs(process.argv.slice(2));

try {
  initDb({ dbPath: args.dbPath, migrationsFolder: args.migrationsFolder });
  writeLog("info", `db initialised at ${args.dbPath}`);
} catch (e) {
  writeLog("error", `db init failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

const handlers: Record<string, Handler> = {
  ping: () => ({ pong: true, version: "0.1.0", at: new Date().toISOString() }),
  "audit.logEvent": logEvent,
  "audit.listEvents": listEvents,
  "projects.create": createProject,
  "projects.list": listProjects,
  "projects.get": getProject,
  "answers.record": recordAnswer,
  "answers.list": listAnswers,
  "files.extractText": extractText,
  "files.summariseImage": summariseImage,
  "files.parseSchema": parseSchema,
};

const handleLine = async (line: string): Promise<void> => {
  let request: Request;
  try {
    const parsed: unknown = JSON.parse(line);
    request = RequestSchema.parse(parsed);
  } catch (e) {
    writeResponse({
      id: "unknown",
      ok: false,
      error: {
        code: "BAD_REQUEST",
        message: e instanceof Error ? e.message : String(e),
      },
    });
    return;
  }

  const handler = handlers[request.method];
  if (!handler) {
    writeResponse({
      id: request.id,
      ok: false,
      error: { code: "UNKNOWN_METHOD", message: `no handler for method '${request.method}'` },
    });
    return;
  }

  try {
    const result = await handler(request.params);
    writeResponse({ id: request.id, ok: true, result });
  } catch (e) {
    writeResponse({
      id: request.id,
      ok: false,
      error: {
        code: "HANDLER_ERROR",
        message: e instanceof Error ? e.message : String(e),
      },
    });
  }
};

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let newlineIdx;
  while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newlineIdx).trim();
    buffer = buffer.slice(newlineIdx + 1);
    if (line.length === 0) continue;
    void handleLine(line);
  }
});

process.stdin.on("end", () => {
  writeLog("info", "stdin closed, sidecar exiting");
  process.exit(0);
});

process.on("SIGTERM", () => {
  writeLog("info", "SIGTERM received, sidecar exiting");
  process.exit(0);
});

writeLog("info", "sidecar ready");
