import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

const CONTRACT_FILES = [
  "src-tauri/templates/CLAUDE.md",
  "src-tauri/templates/rules-README.md",
  "src-tauri/templates/david-easter-egg.md",
  "sidecar/src/orchestrator-driver.ts",
];

describe("D-EEGG generated-project contract", () => {
  it.each(CONTRACT_FILES)("%s mentions the shortcut, text, and verifier marker", (file) => {
    const text = fs.readFileSync(path.join(root, file), "utf8");

    expect(text).toContain("Alt+Shift+D");
    expect(text).toContain("made by david");
    expect(text).toContain("builder:david-easter-egg");
  });
});
