import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyEdits, formatVerifyErrors, syntaxCheck } from "./verify.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "verify-test-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function touch(rel: string, content: string): Promise<void> {
  const abs = path.join(tmp, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(tmp, rel), "utf-8");
}

describe("applyEdits", () => {
  it("applies a single edit and reports the modified file", async () => {
    await touch("lib/foo.ts", `export const x = 1;\n`);
    const result = await applyEdits(tmp, [
      { file: "lib/foo.ts", oldText: "const x = 1", newText: "const x = 2" },
    ]);
    expect(result.errors).toEqual([]);
    expect(result.modifiedFiles).toEqual(["lib/foo.ts"]);
    expect(await read("lib/foo.ts")).toBe(`export const x = 2;\n`);
  });

  it("applies multiple edits to the same file in order", async () => {
    await touch("lib/foo.ts", `const a = 1;\nconst b = 2;\n`);
    const result = await applyEdits(tmp, [
      { file: "lib/foo.ts", oldText: "const a = 1", newText: "const a = 10" },
      { file: "lib/foo.ts", oldText: "const b = 2", newText: "const b = 20" },
    ]);
    expect(result.errors).toEqual([]);
    expect(await read("lib/foo.ts")).toBe(`const a = 10;\nconst b = 20;\n`);
  });

  it("aborts a file's edits on the first ambiguous oldText", async () => {
    await touch("lib/foo.ts", `const x = 1;\nconst x = 1;\n`);
    const result = await applyEdits(tmp, [
      { file: "lib/foo.ts", oldText: "const x = 1", newText: "const x = 2" },
    ]);
    expect(result.modifiedFiles).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.reason).toBe("old_text_ambiguous");
    // File untouched.
    expect(await read("lib/foo.ts")).toBe(`const x = 1;\nconst x = 1;\n`);
  });

  it("reports old_text_not_found when oldText is absent", async () => {
    await touch("lib/foo.ts", `const x = 1;\n`);
    const result = await applyEdits(tmp, [
      { file: "lib/foo.ts", oldText: "DOES NOT EXIST", newText: "y" },
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.reason).toBe("old_text_not_found");
  });

  it("reports file_missing when the target file does not exist", async () => {
    const result = await applyEdits(tmp, [
      { file: "lib/missing.ts", oldText: "x", newText: "y" },
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.reason).toBe("file_missing");
  });

  it("groups edits by file (so the second edit sees the first's mutation)", async () => {
    await touch("lib/foo.ts", `const a = 1;\n`);
    const result = await applyEdits(tmp, [
      { file: "lib/foo.ts", oldText: "const a = 1", newText: "const a = 1; const b = 2" },
      { file: "lib/foo.ts", oldText: "const b = 2", newText: "const b = 20" },
    ]);
    expect(result.errors).toEqual([]);
    expect(await read("lib/foo.ts")).toBe(`const a = 1; const b = 20;\n`);
  });

  it("returns empty for an empty edits list", async () => {
    const result = await applyEdits(tmp, []);
    expect(result.modifiedFiles).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});

describe("syntaxCheck", () => {
  it("returns no issues for clean source", async () => {
    await touch("lib/foo.ts", `export const x = 1;\n`);
    expect(await syntaxCheck(tmp, ["lib/foo.ts"])).toEqual([]);
  });

  it("flags files with parse diagnostics", async () => {
    await touch("lib/broken.ts", `function x( {\n`);
    const issues = await syntaxCheck(tmp, ["lib/broken.ts"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.file).toBe("lib/broken.ts");
    expect(issues[0]!.diagnostics).toBeGreaterThan(0);
  });

  it("skips non-parseable extensions", async () => {
    await touch("supabase/migrations/0001.sql", "CREATE TABLE x;");
    await touch(".env.example", "FOO=");
    expect(
      await syntaxCheck(tmp, ["supabase/migrations/0001.sql", ".env.example"])
    ).toEqual([]);
  });

  it("flags missing files with diagnostics: -1", async () => {
    const issues = await syntaxCheck(tmp, ["lib/missing.ts"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.diagnostics).toBe(-1);
  });
});

describe("formatVerifyErrors", () => {
  it("renders apply errors with their reason", () => {
    const out = formatVerifyErrors(
      [
        {
          edit: { file: "a.ts", oldText: "x", newText: "y" },
          reason: "old_text_not_found",
          detail: "oldText not present in a.ts",
        },
      ],
      []
    );
    expect(out).toContain("old_text_not_found");
    expect(out).toContain("a.ts");
  });

  it("renders syntax issues with their counts", () => {
    expect(formatVerifyErrors([], [{ file: "b.ts", diagnostics: 3 }])).toContain(
      "3 parse error(s)"
    );
  });

  it("renders missing-file syntax issues with a special string", () => {
    expect(formatVerifyErrors([], [{ file: "c.ts", diagnostics: -1 }])).toContain(
      "file unreadable after patch"
    );
  });

  it("returns the empty string when there are no errors", () => {
    expect(formatVerifyErrors([], [])).toBe("");
  });
});
