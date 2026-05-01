import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isUseClient, lineOfNode, visitAll, walkAst } from "./ts-ast.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ts-ast-test-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function touch(rel: string, content: string): Promise<void> {
  const abs = path.join(tmp, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

function parse(source: string, kind: ts.ScriptKind = ts.ScriptKind.TSX): ts.SourceFile {
  return ts.createSourceFile("f.tsx", source, ts.ScriptTarget.Latest, true, kind);
}

describe("isUseClient", () => {
  it("returns true when the first statement is a 'use client' directive", () => {
    expect(isUseClient(parse(`"use client";\nexport const x = 1;`))).toBe(true);
    expect(isUseClient(parse(`'use client';\nexport const x = 1;`))).toBe(true);
  });

  it("returns false when the file starts with import statements", () => {
    expect(isUseClient(parse(`import React from "react";\n"use client";`))).toBe(false);
  });

  it("returns false for a server component (no directive)", () => {
    expect(isUseClient(parse(`export default function Page() { return null; }`))).toBe(false);
  });

  it("returns false for a 'use server' directive", () => {
    expect(isUseClient(parse(`"use server";\nexport async function action() {}`))).toBe(false);
  });

  it("returns false for an empty file", () => {
    expect(isUseClient(parse(``))).toBe(false);
  });
});

describe("lineOfNode", () => {
  it("returns 1-indexed line numbers", () => {
    const src = `const a = 1;\nconst b = 2;\nconst c = 3;`;
    const ast = parse(src);
    expect(ast.statements).toHaveLength(3);
    expect(lineOfNode(ast, ast.statements[0]!)).toBe(1);
    expect(lineOfNode(ast, ast.statements[1]!)).toBe(2);
    expect(lineOfNode(ast, ast.statements[2]!)).toBe(3);
  });
});

describe("visitAll", () => {
  it("visits every descendant node, not just direct children", () => {
    const ast = parse(`const x = a + b * c;`);
    let binaryCount = 0;
    visitAll(ast, (n) => {
      if (ts.isBinaryExpression(n)) binaryCount++;
    });
    // a + (b * c): two binary expressions.
    expect(binaryCount).toBe(2);
  });
});

describe("walkAst", () => {
  it("yields parsed sources for .ts and .tsx files", async () => {
    await touch("app/page.tsx", `"use client";\nexport default function Page() {}`);
    await touch("lib/util.ts", `export const x = 1;`);
    const seen: string[] = [];
    for await (const parsed of walkAst(tmp)) {
      seen.push(parsed.relativePath);
      expect(parsed.ast).toBeDefined();
    }
    expect(seen.sort()).toEqual(["app/page.tsx", "lib/util.ts"]);
  });

  it("attaches the original source string to each entry", async () => {
    const src = `export const x = 1;\n`;
    await touch("lib/util.ts", src);
    const out: string[] = [];
    for await (const parsed of walkAst(tmp)) out.push(parsed.source);
    expect(out).toEqual([src]);
  });

  it("skips non-source files", async () => {
    await touch("app/page.tsx", `export default function P() {}`);
    await touch("app/style.css", `.x { color: red; }`);
    await touch("README.md", `# hi`);
    const seen: string[] = [];
    for await (const parsed of walkAst(tmp)) seen.push(parsed.relativePath);
    expect(seen).toEqual(["app/page.tsx"]);
  });

  it("uses the TSX script kind for .tsx (so JSX parses)", async () => {
    await touch(
      "app/page.tsx",
      `export default function Page() { return <div>hello</div>; }`
    );
    let parsed: ts.SourceFile | null = null;
    for await (const p of walkAst(tmp)) parsed = p.ast;
    expect(parsed).not.toBeNull();
    let jsxCount = 0;
    visitAll(parsed!, (n) => {
      if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) jsxCount++;
    });
    expect(jsxCount).toBeGreaterThan(0);
  });
});
