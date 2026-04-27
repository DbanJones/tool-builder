import { describe, expect, it } from "vitest";

import { translate } from "./translate";

describe("translate", () => {
  it("Bash with description prefers the description and shows the command in parens", () => {
    expect(
      translate(
        "Bash",
        JSON.stringify({ command: "pnpm verify", description: "merge gate" }),
      ),
    ).toBe("merge gate (pnpm verify)");
  });

  it("Bash without description falls back to 'Running <command>' for unrecognised commands", () => {
    expect(translate("Bash", JSON.stringify({ command: "ls -la" }))).toBe(
      "Looking around the project (ls -la)",
    );
    expect(translate("Bash", JSON.stringify({ command: "obscure-tool --weird" }))).toBe(
      "Running obscure-tool --weird",
    );
  });

  it("Bash recognises common commands and surfaces a friendly label", () => {
    expect(translate("Bash", JSON.stringify({ command: "pnpm install" }))).toBe(
      "Installing dependencies (pnpm install)",
    );
    expect(translate("Bash", JSON.stringify({ command: "pnpm verify" }))).toBe(
      "Running the full check suite (pnpm verify)",
    );
    expect(translate("Bash", JSON.stringify({ command: "git init" }))).toBe(
      "Setting up version control (git init)",
    );
  });

  it("Bash trims multi-line commands to the first line", () => {
    expect(translate("Bash", JSON.stringify({ command: "set -e\npnpm test\necho done" }))).toBe(
      "Running set -e",
    );
  });

  it("Read shows the basename, not the full path", () => {
    expect(translate("Read", JSON.stringify({ file_path: "/abs/path/to/CLAUDE.md" }))).toBe(
      "Reading CLAUDE.md",
    );
  });

  it("Edit shows the basename", () => {
    expect(translate("Edit", JSON.stringify({ file_path: "app/page.tsx" }))).toBe(
      "Editing page.tsx",
    );
  });

  it("Write shows the basename", () => {
    expect(translate("Write", JSON.stringify({ file_path: "lib/foo.ts" }))).toBe("Writing foo.ts");
  });

  it("Glob describes the search pattern", () => {
    expect(translate("Glob", JSON.stringify({ pattern: "**/*.tsx" }))).toBe(
      "Searching for files matching **/*.tsx",
    );
  });

  it("Grep with path includes the location", () => {
    expect(
      translate("Grep", JSON.stringify({ pattern: "TODO", path: "src/important.ts" })),
    ).toBe("Searching for TODO in important.ts");
  });

  it("Grep without path skips the location clause", () => {
    expect(translate("Grep", JSON.stringify({ pattern: "TODO" }))).toBe("Searching for TODO");
  });

  it("Task surfaces both subagent type and description", () => {
    expect(
      translate(
        "Task",
        JSON.stringify({ subagent_type: "Explore", description: "find auth code" }),
      ),
    ).toBe("Delegating to Explore agent: find auth code");
  });

  it("WebFetch shows the URL", () => {
    expect(translate("WebFetch", JSON.stringify({ url: "https://example.com" }))).toBe(
      "Fetching https://example.com",
    );
  });

  it("WebSearch shows the query", () => {
    expect(translate("WebSearch", JSON.stringify({ query: "react server components" }))).toBe(
      "Web search: react server components",
    );
  });

  it("TodoWrite without an in-progress item shows a generic 'Updating the plan'", () => {
    expect(translate("TodoWrite", JSON.stringify({ todos: [] }))).toBe("Updating the plan");
  });

  it("TodoWrite with an in-progress item surfaces its activeForm", () => {
    const todos = [
      { content: "Install deps", status: "completed", activeForm: "Installing deps" },
      { content: "Wire up homepage", status: "in_progress", activeForm: "Wiring up the homepage" },
      { content: "Write tests", status: "pending", activeForm: "Writing tests" },
    ];
    expect(translate("TodoWrite", JSON.stringify({ todos }))).toBe("Now: Wiring up the homepage");
  });

  it("MCP-prefixed tools strip the prefix and surface server + tool", () => {
    expect(translate("mcp__builder-record-answer__record_answer", JSON.stringify({}))).toBe(
      "Tool record_answer on builder-record-answer server",
    );
  });

  it("unknown tool with a string first key falls through to a generic '<tool>(<key>: <val>)' form", () => {
    expect(translate("ImaginaryTool", JSON.stringify({ target: "x", extra: "y" }))).toBe(
      "ImaginaryTool(target: x)",
    );
  });

  it("unknown tool with no input returns just the tool name", () => {
    expect(translate("ImaginaryTool", JSON.stringify({}))).toBe("ImaginaryTool");
  });

  it("malformed rawInput JSON does not throw", () => {
    expect(translate("Bash", "{not json")).toBe("Running ");
  });

  it("trims long lines to MAX_LINE_LENGTH and ends with an ellipsis", () => {
    const longCommand = "echo " + "x".repeat(500);
    const out = translate("Bash", JSON.stringify({ command: longCommand }));
    expect(out.length).toBeLessThanOrEqual(140);
    expect(out.endsWith("…")).toBe(true);
  });

  it("missing file_path on Read returns a fallback line rather than throwing", () => {
    expect(translate("Read", JSON.stringify({}))).toBe("Reading a file");
  });
});
