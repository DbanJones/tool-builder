// Per kit section 14.5.2: every tool call observed from the build subprocess
// is translated into one short, novice-readable line for the live tail. The
// raw stream-json `input` block becomes `humanLine` ("Editing app/page.tsx",
// "Running pnpm verify"), suitable for showing in the dashboard without the
// novice ever seeing a JSON blob.
//
// All built-in Claude Code tools are covered; any unrecognised tool falls
// back to a generic "<tool>(<one-key-summary>)" form so we never silently
// drop a tool call from the live tail. MCP tools are recognised by their
// `mcp__<server>__<name>` prefix.
//
// Pure: no I/O. Defensive parsing — `rawInput` arrives as a JSON string from
// the orchestrator and may be malformed in edge cases.

const MAX_LINE_LENGTH = 140;

function trim(s: string): string {
  if (s.length <= MAX_LINE_LENGTH) return s;
  return s.slice(0, MAX_LINE_LENGTH - 1) + "…";
}

function safeParse(rawInput: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(rawInput);
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function basename(p: string): string {
  // The actions log shows the file basename for readability; full paths land
  // in raw_input for anyone who needs them.
  const slashIdx = p.lastIndexOf("/");
  return slashIdx >= 0 ? p.slice(slashIdx + 1) : p;
}

// Friendly labels for the most common build-phase commands. Returned in
// activeForm style ("Installing dependencies", "Running tests") so the live
// activity reads like a status line a non-coder understands.
//
// Order matters: more specific patterns first. Fall through to null when no
// rule matches; the caller will render the raw command instead.
function friendlyForCommand(cmd: string): string | null {
  const c = cmd.trim();
  // Package install (pnpm/npm/yarn/bun) — `add`/`install`/`i` shapes.
  if (/^(pnpm|npm|yarn|bun)\s+(add|install|i)(\s|$)/.test(c)) return "Installing dependencies";
  // Common script shorthands.
  if (/^(pnpm|npm|yarn|bun)\s+(run\s+)?(dev|start)(\s|$)/.test(c)) return "Starting the dev server";
  if (/^(pnpm|npm|yarn|bun)\s+(run\s+)?build(\s|$)/.test(c)) return "Building the app";
  if (/^(pnpm|npm|yarn|bun)\s+(run\s+)?(test|vitest|jest)(\s|$)/.test(c)) return "Running tests";
  if (/^(pnpm|npm|yarn|bun)\s+(run\s+)?(lint|eslint)(\s|$)/.test(c)) return "Checking for code-style issues";
  if (/^(pnpm|npm|yarn|bun)\s+(run\s+)?(typecheck|tsc)(\s|$)/.test(c)) return "Type-checking the code";
  if (/^(pnpm|npm|yarn|bun)\s+(run\s+)?verify(\s|$)/.test(c)) return "Running the full check suite";
  if (/^(pnpm|npm|yarn|bun)\s+(run\s+)?(format|prettier)(\s|$)/.test(c)) return "Formatting the code";
  if (/^(pnpm|npm|yarn|bun)\s+(run\s+)?(db:migrate|drizzle-kit\s+migrate|prisma\s+migrate)(\s|$)/.test(c))
    return "Setting up the database";
  // Project scaffolding.
  if (/^npx\s+create-next-app/.test(c)) return "Scaffolding a Next.js project";
  if (/^npx\s+create-react-app/.test(c)) return "Scaffolding a React project";
  if (/^npx\s+create-vite/.test(c) || /^npm\s+create\s+vite/.test(c)) return "Scaffolding a Vite project";
  if (/^npx\s+shadcn(?:-ui)?\s+(init|add)/.test(c)) return "Adding UI components";
  // Git operations.
  if (/^git\s+init/.test(c)) return "Setting up version control";
  if (/^git\s+commit/.test(c)) return "Saving a checkpoint";
  if (/^git\s+add/.test(c)) return "Staging files";
  if (/^git\s+push/.test(c)) return "Pushing to GitHub";
  if (/^git\s+status/.test(c)) return "Checking what's changed";
  if (/^git\s+log/.test(c)) return "Reviewing recent history";
  // File / dir scaffolding.
  if (/^mkdir\s/.test(c)) return "Creating folders";
  if (/^touch\s/.test(c)) return "Creating files";
  if (/^cp\s/.test(c)) return "Copying files";
  if (/^mv\s/.test(c)) return "Moving files";
  if (/^rm\s/.test(c)) return "Removing files";
  // Inspection.
  if (/^(ls|find|tree)\s/.test(c) || c === "ls" || c === "tree") return "Looking around the project";
  if (/^cat\s/.test(c) || /^head\s/.test(c) || /^tail\s/.test(c)) return "Reading a file";
  return null;
}

/**
 * Map a single tool call to a one-line human description for the live tail.
 *
 * `tool` is the bare name as it arrives from claude's stream-json
 * (Bash | Read | Edit | Write | Glob | Grep | Task | WebFetch | WebSearch |
 * NotebookEdit | TodoWrite | mcp__<server>__<name>). Names not in the table
 * fall through to a generic "<tool>(<one-key-summary>)" form.
 *
 * `rawInput` is the JSON-encoded tool input as a string (matches the
 * orchestrator's OrchestratorEvent.tool_use.raw_input shape).
 */
export function translate(tool: string, rawInput: string): string {
  const input = safeParse(rawInput);

  switch (tool) {
    case "Bash": {
      const command = asString(input["command"]) ?? "";
      const description = asString(input["description"]);
      const firstLine = command.split("\n")[0] ?? command;
      // Recognise common commands and surface a plain-English description
      // novices can read at a glance. The agent's own description (when
      // present) wins, but otherwise we infer from the command shape so
      // the live activity reads "Installing dependencies" rather than
      // "Running pnpm install".
      const friendly = friendlyForCommand(firstLine);
      if (description) {
        return trim(`${description} (${firstLine})`);
      }
      if (friendly) {
        return trim(`${friendly} (${firstLine})`);
      }
      return trim(`Running ${firstLine}`);
    }

    case "Read": {
      const path = asString(input["file_path"]);
      if (!path) return "Reading a file";
      return trim(`Reading ${basename(path)}`);
    }

    case "Edit": {
      const path = asString(input["file_path"]);
      if (!path) return "Editing a file";
      return trim(`Editing ${basename(path)}`);
    }

    case "Write": {
      const path = asString(input["file_path"]);
      if (!path) return "Writing a file";
      return trim(`Writing ${basename(path)}`);
    }

    case "Glob": {
      const pattern = asString(input["pattern"]) ?? "";
      return trim(`Searching for files matching ${pattern || "(no pattern)"}`);
    }

    case "Grep": {
      const pattern = asString(input["pattern"]) ?? "";
      const path = asString(input["path"]);
      const where = path ? ` in ${basename(path)}` : "";
      return trim(`Searching for ${pattern || "(no pattern)"}${where}`);
    }

    case "Task": {
      // Subagent dispatch.
      const description = asString(input["description"]) ?? "(no description)";
      const subagentType = asString(input["subagent_type"]) ?? "general";
      return trim(`Delegating to ${subagentType} agent: ${description}`);
    }

    case "WebFetch": {
      const url = asString(input["url"]) ?? "";
      return trim(`Fetching ${url}`);
    }

    case "WebSearch": {
      const query = asString(input["query"]) ?? "";
      return trim(`Web search: ${query}`);
    }

    case "TodoWrite": {
      // Surface the in-progress item's activeForm if we can find one — the
      // dashboard already has a structured plan view; this just makes the
      // raw activity log slightly less mysterious when TodoWrite scrolls by.
      const todos = input["todos"];
      if (Array.isArray(todos)) {
        const active = todos.find(
          (t): t is { status: "in_progress"; activeForm: string } =>
            typeof t === "object" &&
            t !== null &&
            (t as { status?: unknown }).status === "in_progress" &&
            typeof (t as { activeForm?: unknown }).activeForm === "string",
        );
        if (active) return trim(`Now: ${active.activeForm}`);
      }
      return "Updating the plan";
    }

    case "NotebookEdit": {
      const path = asString(input["notebook_path"]);
      if (!path) return "Editing a notebook";
      return trim(`Editing notebook ${basename(path)}`);
    }

    case "ExitPlanMode":
      return "Exiting plan mode";

    case "BashOutput":
      return "Reading bash output";

    case "KillBash":
      return "Stopping a background command";

    default:
      return translateMcpOrFallback(tool, input);
  }
}

// ---- redacted diff extraction (PR-5 of D-031) -----------------------------
// Pull a small snippet out of an Edit / Write / MultiEdit / NotebookEdit
// rawInput so the live tail can show the novice what actually changed
// without forcing them to flip on the technical-detail toggle. We intentionally
// truncate aggressively — this is a reassurance / awareness surface, not a
// replacement for `git diff`.

const SNIPPET_MAX_LINES = 10;
const SNIPPET_MAX_CHARS = 400;

function clipSnippet(text: string): string {
  const lines = text.split("\n").slice(0, SNIPPET_MAX_LINES);
  let s = lines.join("\n");
  if (s.length > SNIPPET_MAX_CHARS) s = s.slice(0, SNIPPET_MAX_CHARS) + "\n…";
  return s;
}

/**
 * Returns a short, human-readable preview of what changed in a file-mutating
 * tool call, or null if no preview can be derived. The snippet is the new
 * content (Edit's `new_string`, Write's `content`), not a full diff —
 * reading "+10 lines / -3 lines" without context would be less helpful for
 * non-coders than showing the actual lines they're getting.
 */
export function extractDiffSnippet(tool: string, rawInput: string): string | null {
  const input = safeParse(rawInput);
  switch (tool) {
    case "Edit": {
      const next = asString(input["new_string"]);
      return next && next.trim().length > 0 ? clipSnippet(next) : null;
    }
    case "Write": {
      const content = asString(input["content"]);
      return content && content.trim().length > 0 ? clipSnippet(content) : null;
    }
    case "MultiEdit": {
      // MultiEdit's input has `edits: [{old_string, new_string}]`; concatenate
      // the new_strings of the first couple of edits so the novice sees a
      // representative slice without us serialising the whole batch.
      const edits = input["edits"];
      if (!Array.isArray(edits)) return null;
      const fragments: string[] = [];
      for (const e of edits.slice(0, 2)) {
        if (e && typeof e === "object") {
          const ns = asString((e as Record<string, unknown>)["new_string"]);
          if (ns && ns.trim().length > 0) fragments.push(ns);
        }
        if (fragments.join("\n").length >= SNIPPET_MAX_CHARS) break;
      }
      if (fragments.length === 0) return null;
      const joined = fragments.join("\n…\n");
      return clipSnippet(joined);
    }
    case "NotebookEdit": {
      const next = asString(input["new_source"]);
      return next && next.trim().length > 0 ? clipSnippet(next) : null;
    }
    default:
      return null;
  }
}

function translateMcpOrFallback(tool: string, input: Record<string, unknown>): string {
  // claude exposes MCP tools as `mcp__<server>__<name>`. Strip the prefix and
  // present a slightly friendlier form so the novice doesn't see double
  // underscores in the live tail.
  if (tool.startsWith("mcp__")) {
    const rest = tool.slice("mcp__".length);
    const parts = rest.split("__");
    const server = parts[0] ?? rest;
    const name = parts.slice(1).join("__") || "tool";
    return trim(`Tool ${name} on ${server} server`);
  }

  // Generic fallback: pick the first scalar value from the input as the
  // summary, e.g. `<tool>(file_path: "...")`.
  const firstKey = Object.keys(input)[0];
  if (firstKey === undefined) return tool;
  const firstValue = input[firstKey];
  if (typeof firstValue === "string" || typeof firstValue === "number" || typeof firstValue === "boolean") {
    return trim(`${tool}(${firstKey}: ${String(firstValue)})`);
  }
  return tool;
}
