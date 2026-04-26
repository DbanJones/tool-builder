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
      // The description (when claude provides it) is more readable than the
      // raw command; show it with the command in parens for trust.
      if (description) {
        return trim(`${description} (${command.split("\n")[0] ?? command})`);
      }
      return trim(`Running ${command.split("\n")[0] ?? command}`);
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

    case "TodoWrite":
      return "Updating todo list";

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
