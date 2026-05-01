// Shared TypeScript AST helpers for the two AST-driven Layer 1 detectors
// (client-side-auth, env-leak) and any future ones. Centralised so the
// "is this a 'use client' file?" check and the .tsx walker are not
// reimplemented per detector.
//
// We use the official `typescript` package (promoted to a runtime
// dependency in this slice). G4's validator will need it too; better to
// share than to maintain a parallel parser.

import * as fs from "node:fs/promises";
import ts from "typescript";

import { walk } from "./walk.js";

export interface ParsedSource {
  relativePath: string;
  absolutePath: string;
  source: string;
  ast: ts.SourceFile;
}

const TS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/**
 * Yield each parseable TS/TSX/JS/JSX file under the target's standard
 * include-roots, with its parsed AST. Detectors consume lazily so we
 * never hold the whole tree in memory.
 */
export async function* walkAst(projectPath: string): AsyncGenerator<ParsedSource> {
  for await (const entry of walk(projectPath)) {
    const dot = entry.relativePath.lastIndexOf(".");
    const ext = dot < 0 ? "" : entry.relativePath.slice(dot).toLowerCase();
    if (!TS_EXTS.has(ext)) continue;

    let source: string;
    try {
      source = await fs.readFile(entry.absolutePath, "utf-8");
    } catch {
      continue;
    }

    const ast = ts.createSourceFile(
      entry.relativePath,
      source,
      ts.ScriptTarget.Latest,
      /*setParentNodes*/ true,
      scriptKindFor(ext)
    );
    yield { relativePath: entry.relativePath, absolutePath: entry.absolutePath, source, ast };
  }
}

function scriptKindFor(ext: string): ts.ScriptKind {
  switch (ext) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

/**
 * True if the source file's first non-comment top-level statement is a
 * `"use client"` (or `'use client'`) directive. Per the Next.js semantic:
 * a single string-literal expression statement at the top of the file.
 */
export function isUseClient(ast: ts.SourceFile): boolean {
  for (const stmt of ast.statements) {
    if (!ts.isExpressionStatement(stmt)) return false;
    if (!ts.isStringLiteral(stmt.expression)) return false;
    return stmt.expression.text === "use client";
  }
  return false;
}

/**
 * 1-indexed line number for an AST node, computed against its source file.
 * Detectors emit `lineStart`/`lineEnd` in this convention.
 */
export function lineOfNode(ast: ts.SourceFile, node: ts.Node): number {
  const { line } = ast.getLineAndCharacterOfPosition(node.getStart(ast));
  return line + 1;
}

/**
 * Walk every descendant of `node`, calling `visit`. Mirrors ts.forEachChild
 * recursion but yields every node, not just direct children — convenient
 * for "find every BinaryExpression that touches user.role" style searches.
 */
export function visitAll(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => visitAll(child, visit));
}
