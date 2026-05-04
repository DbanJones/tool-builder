import type { HistoryActionEntry } from "./index";

// Aggregate "what changed this turn" from the orchestrator action stream.
// One summary per build / repair turn — the page-level handler invokes
// this on the `done` event, slicing the actions list from `sinceTs`
// (the previous done-boundary) to the present.
//
// Pure: no I/O, no side effects, deterministic. Tests can pass canned
// HistoryActionEntry arrays.

export interface TurnSummary {
  /** Files passed to Edit / MultiEdit / NotebookEdit. */
  filesEdited: string[];
  /** Files passed to Write (creation OR full overwrite — Claude uses Write
   *  for both, we can't distinguish without disk lookups). */
  filesWritten: string[];
  /** Bash commands run (count + first verb of each, e.g. "npm" / "rm" / "ls"). */
  bashCount: number;
  /** Number of test invocations detected in Bash commands. */
  testCount: number;
  /** Total tool calls in the turn — useful for "noisy turn" detection. */
  totalActions: number;
}

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "NotebookEdit"]);
const WRITE_TOOLS = new Set(["Write"]);
const BASH_TOOLS = new Set(["Bash"]);

const TEST_PATTERNS = [
  /\bnpm (run )?test\b/,
  /\bpnpm (run )?test\b/,
  /\byarn test\b/,
  /\bvitest\b/,
  /\bjest\b/,
  /\bplaywright test\b/,
  /\bcorepack pnpm (test|verify|e2e)\b/,
  /\bcargo test\b/,
];

/**
 * Build a summary of all actions newer than `sinceTs`. Pass `0` for
 * "everything in the array". Files are de-duped, preserving first-seen
 * order so the rendered list is chronological.
 */
export function summariseTurn(
  actions: readonly HistoryActionEntry[],
  sinceTs: number,
): TurnSummary {
  const filesEditedSet = new Set<string>();
  const filesEdited: string[] = [];
  const filesWrittenSet = new Set<string>();
  const filesWritten: string[] = [];
  let bashCount = 0;
  let testCount = 0;
  let totalActions = 0;

  for (const a of actions) {
    if (a.ts <= sinceTs) continue;
    totalActions++;

    if (EDIT_TOOLS.has(a.tool)) {
      const path = extractFilePath(a.rawInput);
      if (path !== null && !filesEditedSet.has(path)) {
        filesEditedSet.add(path);
        filesEdited.push(path);
      }
      continue;
    }
    if (WRITE_TOOLS.has(a.tool)) {
      const path = extractFilePath(a.rawInput);
      if (path !== null && !filesWrittenSet.has(path)) {
        filesWrittenSet.add(path);
        filesWritten.push(path);
      }
      continue;
    }
    if (BASH_TOOLS.has(a.tool)) {
      bashCount++;
      const command = extractBashCommand(a.rawInput);
      if (command !== null && TEST_PATTERNS.some((re) => re.test(command))) {
        testCount++;
      }
      continue;
    }
  }

  return {
    filesEdited,
    filesWritten,
    bashCount,
    testCount,
    totalActions,
  };
}

/**
 * Render a TurnSummary as a chat-friendly markdown bullet list. Empty
 * string when the turn produced no observable changes (just thinking
 * + reads, no edits) — caller can elide rather than show "did nothing".
 */
export function renderTurnSummary(summary: TurnSummary, kind: "build" | "repair"): string {
  const parts: string[] = [];
  if (summary.filesEdited.length > 0) {
    parts.push(
      `Edited ${summary.filesEdited.length} file${summary.filesEdited.length === 1 ? "" : "s"}: ${formatFileList(summary.filesEdited)}`,
    );
  }
  if (summary.filesWritten.length > 0) {
    parts.push(
      `Wrote ${summary.filesWritten.length} file${summary.filesWritten.length === 1 ? "" : "s"}: ${formatFileList(summary.filesWritten)}`,
    );
  }
  if (summary.bashCount > 0) {
    const testNote = summary.testCount > 0
      ? ` (${summary.testCount} test run${summary.testCount === 1 ? "" : "s"})`
      : "";
    parts.push(`Ran ${summary.bashCount} shell command${summary.bashCount === 1 ? "" : "s"}${testNote}`);
  }
  if (parts.length === 0) return "";
  const heading = kind === "build" ? "**Build turn finished.**" : "**Repair finished.**";
  return `${heading}\n- ${parts.join("\n- ")}`;
}

/**
 * Extract a file_path from an Edit/Write/MultiEdit/NotebookEdit raw_input
 * (which is JSON-stringified by the orchestrator).
 */
function extractFilePath(rawInput: string): string | null {
  try {
    const parsed = JSON.parse(rawInput) as { file_path?: unknown; notebook_path?: unknown };
    if (typeof parsed.file_path === "string" && parsed.file_path.length > 0) {
      return shortenPath(parsed.file_path);
    }
    if (typeof parsed.notebook_path === "string" && parsed.notebook_path.length > 0) {
      return shortenPath(parsed.notebook_path);
    }
    return null;
  } catch {
    return null;
  }
}

function extractBashCommand(rawInput: string): string | null {
  try {
    const parsed = JSON.parse(rawInput) as { command?: unknown };
    return typeof parsed.command === "string" ? parsed.command : null;
  } catch {
    return null;
  }
}

/**
 * Render an absolute path as a project-relative-ish label. Drops everything
 * up to and including the last "/ClaudeBuilds/<projectName>/" so the chat
 * line stays short. Falls back to the basename if the prefix isn't there.
 */
function shortenPath(absolute: string): string {
  const m = /\/ClaudeBuilds\/[^/]+\/(.+)$/.exec(absolute);
  if (m && m[1] !== undefined) return m[1];
  const slash = absolute.lastIndexOf("/");
  return slash >= 0 ? absolute.slice(slash + 1) : absolute;
}

/**
 * Render a list of paths. Up to 5 inline; the rest become "+N more".
 */
function formatFileList(paths: readonly string[]): string {
  if (paths.length <= 5) return paths.map((p) => `\`${p}\``).join(", ");
  const head = paths.slice(0, 5).map((p) => `\`${p}\``).join(", ");
  return `${head}, +${paths.length - 5} more`;
}
