// Node sidecar entry point. See ADR-0004 + ADR-0005.
//
// Reads JSON-RPC requests one per line on stdin, dispatches to handlers,
// writes one JSON response per line on stdout. Stderr is reserved for log
// output and is captured by the Tauri shell for debugging.
//
// Protocol:
//   request:      { "id": "<opaque>", "method": "<name>", "params": <any> }
//   success:      { "id": "<same>", "ok": true,  "result": <any> }
//   failure:      { "id": "<same>", "ok": false, "error": { "code": "<str>", "message": "<str>" } }
//   notification: { "notification": { "stream": "<id>", "event": <any> } }   // ADR-0005
//
// Notifications are server-pushed (no `id`, no response expected). The
// Tauri shell parses them out of stdout and forwards `event` onto a
// per-stream Tauri Channel<T> that the webview registered when it kicked
// off the streaming call. Used by long-running streamed work where one
// request elicits N events (orchestrator runs, future chat migration).
//
// CLI args:
//   --db-path <path>            Path to SQLite DB file (default: .builder/builder.db)
//   --migrations-folder <path>  Path to drizzle migrations (default: ./migrations)

import { z } from "zod";

import { initDb } from "./db.js";
import { append as appendAction, list as listActions } from "./handlers/actions.js";
import { record as recordAnswer, list as listAnswers } from "./handlers/answers.js";
import {
  append as appendChatMessage,
  list as listChatMessages,
} from "./handlers/chat-messages.js";
import {
  listOpen as listOpenPermissionRequests,
  resolve as resolvePermissionRequest,
} from "./handlers/permission-requests.js";
import { append as appendCost, sumByProject as sumCostsByProject } from "./handlers/costs.js";
import {
  cancelAllOrchestrators,
  cancelOrchestrator,
  cancelOrchestratorByProject,
  runOrchestrator,
} from "./orchestrator-driver.js";
import { cancelChat, runChat } from "./chat-driver.js";
import {
  cancelAllResearch,
  cancelResearch,
  runResearch,
  stubTransport as researchStubTransport,
  type ResearchTransport,
} from "./research-driver.js";
import {
  listByProject as listResearchFindingsByProject,
  listByScan as listResearchFindingsByScan,
} from "./handlers/research-findings.js";
import {
  graph as debugGraph,
  list as listDefects,
  scan as debugScan,
} from "./handlers/debug.js";
import {
  applyFix as debugApplyFix,
  rollbackFix as debugRollbackFix,
} from "./handlers/repair.js";
import { stubTransport, type ValidatorTransport } from "./debug/validator/index.js";
import {
  append as appendDrift,
  listOpen as listOpenDrifts,
  resolve as resolveDrift,
} from "./handlers/drift.js";
import { logEvent, listEvents } from "./handlers/audit.js";
import { extractText, fetchUrl, parseDataSample, parseSchema, summariseImage } from "./handlers/files.js";
import { verify as verifyEasterEgg } from "./handlers/easter-egg.js";
import { guardPii } from "./handlers/pii.js";
import {
  create as createProject,
  list as listProjects,
  get as getProject,
  setStatus as setProjectStatus,
} from "./handlers/projects.js";

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

/**
 * Push a server-side event to the Tauri shell. Per ADR-0005's streaming
 * protocol — no id, no response expected; the shell forwards `event` onto
 * the webview's registered Channel for the matching `stream` id.
 */
export const writeNotification = (stream: string, event: unknown): void => {
  process.stdout.write(JSON.stringify({ notification: { stream, event } }) + "\n");
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

// Test injection point: when BUILDER_VALIDATOR_STUB_JSON is set, parse
// it as a `Record<ruleId, jsonResponseString>` and use stubTransport.
// Used only by the integration test harness; production startup leaves
// this undefined and the scan handler defaults to sdkTransport.
const validatorTransportOverride: ValidatorTransport | undefined =
  parseValidatorStub();

function parseValidatorStub(): ValidatorTransport | undefined {
  const raw = process.env.BUILDER_VALIDATOR_STUB_JSON;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    writeLog("info", "validator stub transport active for tests");
    return stubTransport(parsed);
  } catch (e) {
    writeLog(
      "warn",
      `BUILDER_VALIDATOR_STUB_JSON failed to parse — falling back to sdkTransport: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
    return undefined;
  }
}

const handlers: Record<string, Handler> = {
  ping: () => ({ pong: true, version: "0.1.0", at: new Date().toISOString() }),
  "audit.logEvent": logEvent,
  "audit.listEvents": listEvents,
  "projects.create": createProject,
  "projects.list": listProjects,
  "projects.get": getProject,
  "projects.setStatus": setProjectStatus,
  "answers.record": recordAnswer,
  "answers.list": listAnswers,
  "files.extractText": extractText,
  "files.summariseImage": summariseImage,
  "files.parseSchema": parseSchema,
  "files.parseDataSample": parseDataSample,
  "files.fetchUrl": fetchUrl,
  "files.guardPii": guardPii,
  "easterEgg.verify": verifyEasterEgg,
  "actions.append": appendAction,
  "actions.list": listActions,
  "costs.append": appendCost,
  "costs.sumByProject": sumCostsByProject,
  "drift.append": appendDrift,
  "drift.resolve": resolveDrift,
  "drift.listOpen": listOpenDrifts,
  "debug.scan": (params) => debugScan(params, undefined, validatorTransportOverride),
  "debug.list": listDefects,
  "debug.graph": debugGraph,
  "debug.applyFix": debugApplyFix,
  "debug.rollbackFix": debugRollbackFix,
  "chatMessages.append": appendChatMessage,
  "chatMessages.list": listChatMessages,
  "permissionRequests.listOpen": listOpenPermissionRequests,
  "permissionRequests.resolve": resolvePermissionRequest,
  "orch.start": orchStart,
  "orch.stop": orchStop,
  "chat.start": chatStart,
  "chat.stop": chatStop,
  "research.start": researchStart,
  "research.stop": researchStop,
  "researchFindings.listByScan": listResearchFindingsByScan,
  "researchFindings.listByProject": listResearchFindingsByProject,
};

// Test injection: BUILDER_RESEARCH_STUB_JSON encodes the stub options
// (findings, proposal, abort point) so the integration test can run the
// research driver without a real Claude call. Same pattern as
// validatorTransportOverride above.
const researchTransportOverride: ResearchTransport | undefined =
  parseResearchStub();

function parseResearchStub(): ResearchTransport | undefined {
  const raw = process.env.BUILDER_RESEARCH_STUB_JSON;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Parameters<typeof researchStubTransport>[0];
    writeLog("info", "research stub transport active for tests");
    return researchStubTransport(parsed);
  } catch (e) {
    writeLog(
      "warn",
      `BUILDER_RESEARCH_STUB_JSON failed to parse — falling back to sdkTransport: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return undefined;
  }
}

// ADR-0005: streaming orchestrator. The webview-side Tauri command holds
// the request open while we push notifications keyed by streamId. Returns
// when the orchestrator's query() generator ends.
const OrchStartParams = z.object({
  streamId: z.string().min(1),
  projectId: z.string().min(1),
  projectPath: z.string().min(1),
  prompt: z.string().nullable().optional(),
  sessionId: z.string().nullable().optional(),
  model: z.string().min(1).optional(),
});
async function orchStart(rawParams: unknown): Promise<{ ok: true }> {
  const params = OrchStartParams.parse(rawParams);
  await runOrchestrator(
    params.streamId,
    {
      projectId: params.projectId,
      projectPath: params.projectPath,
      prompt: params.prompt ?? null,
      sessionId: params.sessionId ?? null,
      ...(params.model !== undefined ? { model: params.model } : {}),
    },
    (event) => writeNotification(params.streamId, event),
  );
  return { ok: true };
}

const OrchStopParams = z.object({
  streamId: z.string().min(1).nullable().optional(),
  projectId: z.string().min(1).nullable().optional(),
});
function orchStop(rawParams: unknown): { cancelled: boolean; count: number } {
  const params = OrchStopParams.parse(rawParams);
  if (params.streamId) {
    const cancelled = cancelOrchestrator(params.streamId);
    return { cancelled, count: cancelled ? 1 : 0 };
  }
  if (params.projectId) {
    const count = cancelOrchestratorByProject(params.projectId);
    return { cancelled: count > 0, count };
  }
  const count = cancelAllOrchestrators();
  return { cancelled: count > 0, count };
}

// Chat path (interview). Same shape as orch.start: streams ChatChunks via
// notifications keyed by streamId.
const ChatStartParams = z.object({
  streamId: z.string().min(1),
  projectId: z.string().min(1),
  projectPath: z.string().min(1),
  prompt: z.string().min(1),
  sessionId: z.string().nullable().optional(),
  model: z.string().min(1).optional(),
});
async function chatStart(rawParams: unknown): Promise<{ ok: true }> {
  const params = ChatStartParams.parse(rawParams);
  await runChat(
    params.streamId,
    {
      projectId: params.projectId,
      projectPath: params.projectPath,
      prompt: params.prompt,
      sessionId: params.sessionId ?? null,
      ...(params.model !== undefined ? { model: params.model } : {}),
    },
    (event) => writeNotification(params.streamId, event),
  );
  return { ok: true };
}

const ChatStopParams = z.object({ streamId: z.string().min(1) });
function chatStop(rawParams: unknown): { cancelled: boolean } {
  const params = ChatStopParams.parse(rawParams);
  return { cancelled: cancelChat(params.streamId) };
}

// Deep research path (Flow M). Streams ResearchEvents via notifications
// keyed by streamId. ADR-0017 §"Why a separate SDK session" — runs in its
// own inflight slot, never shares state with the build orchestrator.
const ResearchStartParams = z.object({
  streamId: z.string().min(1),
  projectId: z.string().min(1),
  projectPath: z.string().min(1),
  specMarkdown: z.string().min(1),
  answersDigest: z.string(),
  filesDigest: z.string(),
  // Tauri shell ships the system prompt (compile-time include_str!).
  // Optional so the integration test can fall back to the file path.
  systemPrompt: z.string().min(1).optional(),
  builderRepoPath: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});
async function researchStart(rawParams: unknown): Promise<{ ok: true }> {
  const params = ResearchStartParams.parse(rawParams);
  await runResearch(
    params.streamId,
    {
      projectId: params.projectId,
      projectPath: params.projectPath,
      specMarkdown: params.specMarkdown,
      answersDigest: params.answersDigest,
      filesDigest: params.filesDigest,
      ...(params.systemPrompt !== undefined
        ? { systemPrompt: params.systemPrompt }
        : {}),
      ...(params.builderRepoPath !== undefined
        ? { builderRepoPath: params.builderRepoPath }
        : {}),
      ...(params.model !== undefined ? { model: params.model } : {}),
    },
    (event) => writeNotification(params.streamId, event),
    researchTransportOverride,
  );
  return { ok: true };
}

const ResearchStopParams = z.object({
  streamId: z.string().min(1).nullable().optional(),
});
function researchStop(rawParams: unknown): { cancelled: boolean; count: number } {
  const params = ResearchStopParams.parse(rawParams);
  if (params.streamId) {
    const cancelled = cancelResearch(params.streamId);
    return { cancelled, count: cancelled ? 1 : 0 };
  }
  const count = cancelAllResearch();
  return { cancelled: count > 0, count };
}

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
