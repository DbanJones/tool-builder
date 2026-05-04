// Next.js 15 App Router route inventory. Walks the target's `app/` tree,
// emits one `RouteInfo` per page.tsx / route.ts / layout.tsx, with method
// list and middleware-presence flag derived from a top-level
// `middleware.ts` at the project root.
//
// v1 scope (per the G3 echo-back):
//  - App Router only (no Pages, no Server Actions)
//  - Global middleware.ts only (no per-route withMiddleware introspection)
//  - Route groups `(name)` stripped from the path; dynamic `[name]` and
//    catch-all `[...name]` preserved verbatim because the validator at
//    G4 still needs to know "this is dynamic".
//  - Methods detected via TS AST: function declarations OR const-arrow
//    exports whose name is one of GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import ts from "typescript";

import { walk } from "../detectors/walk.js";

export const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

const HTTP_METHOD_SET: ReadonlySet<string> = new Set(HTTP_METHODS);

export type RouteKind = "page" | "route" | "layout";

export interface RouteInfo {
  framework: "next-app";
  kind: RouteKind;
  /** Original Next.js form including `[id]`/`[...slug]`; route groups stripped. */
  pathPattern: string;
  /** Empty for `page`/`layout`; populated for `route` files. */
  methods: HttpMethod[];
  /** Workspace-relative file path with POSIX separators. */
  filePath: string;
  /** True if any segment of `pathPattern` is `[...]`-bracketed. */
  isDynamic: boolean;
  /** True if a top-level `middleware.ts` (or .js) exists at the project root. */
  hasMiddleware: boolean;
}

const ROUTE_FILE_BASES: ReadonlySet<string> = new Set([
  "page",
  "route",
  "layout",
]);
const ROUTE_FILE_EXTS: ReadonlySet<string> = new Set([
  ".tsx",
  ".ts",
  ".jsx",
  ".js",
]);

/**
 * Translate a workspace-relative file path under `app/` to its Next.js
 * App Router URL pattern. Route groups `(name)` are stripped; dynamic
 * `[name]` and catch-all `[...name]` segments are preserved.
 *
 * Examples:
 *   `app/page.tsx`                       -> `/`
 *   `app/about/page.tsx`                 -> `/about`
 *   `app/api/users/[id]/route.ts`        -> `/api/users/[id]`
 *   `app/(marketing)/about/page.tsx`     -> `/about`
 *   `app/blog/[...slug]/page.tsx`        -> `/blog/[...slug]`
 *
 * Returns `null` if the path is not under `app/` or does not name a
 * recognised route file.
 */
export function pathPatternFor(relativePath: string): string | null {
  const posix = relativePath.replace(/\\/g, "/");
  const segments = posix.split("/");
  if (segments[0] !== "app") return null;

  const last = segments[segments.length - 1];
  if (!last) return null;
  const dot = last.lastIndexOf(".");
  if (dot < 0) return null;
  const base = last.slice(0, dot);
  const ext = last.slice(dot);
  if (!ROUTE_FILE_BASES.has(base) || !ROUTE_FILE_EXTS.has(ext)) return null;

  // Drop the leading `app` and the filename; keep the directory chain.
  const middle = segments.slice(1, -1);
  // Strip route groups: `(marketing)` is a layout grouping and is
  // invisible in the URL.
  const visible = middle.filter((s) => !(s.startsWith("(") && s.endsWith(")")));
  if (visible.length === 0) return "/";
  return "/" + visible.join("/");
}

export function kindFromBasename(relativePath: string): RouteKind | null {
  const last = relativePath.split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  if (dot < 0) return null;
  const base = last.slice(0, dot);
  if (base === "page") return "page";
  if (base === "route") return "route";
  if (base === "layout") return "layout";
  return null;
}

export function isDynamicPattern(pattern: string): boolean {
  return pattern
    .split("/")
    .some((s) => s.startsWith("[") && s.endsWith("]"));
}

/**
 * Parse a `route.ts`-shape source file and return the HTTP methods it
 * exports. Recognises both
 *   `export async function GET(...) {}`
 * and
 *   `export const GET = async (...) => {};`
 */
export function methodsExported(source: string, kind: RouteKind): HttpMethod[] {
  if (kind !== "route") return [];
  const ast = ts.createSourceFile(
    "route.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const found = new Set<HttpMethod>();
  for (const stmt of ast.statements) {
    if (!hasExportModifier(stmt)) continue;
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      tryAdd(found, stmt.name.text);
      continue;
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) tryAdd(found, decl.name.text);
      }
    }
  }
  return [...found].sort((a, b) =>
    HTTP_METHODS.indexOf(a) - HTTP_METHODS.indexOf(b)
  );
}

function hasExportModifier(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function tryAdd(set: Set<HttpMethod>, name: string): void {
  if (HTTP_METHOD_SET.has(name)) set.add(name as HttpMethod);
}

/**
 * Walk the project's `app/` tree and collect a `RouteInfo` per route
 * file. Reads `middleware.{ts,js}` at the project root once to populate
 * `hasMiddleware` on every entry.
 */
export async function inventoryRoutes(projectPath: string): Promise<RouteInfo[]> {
  const hasMiddleware = await detectMiddleware(projectPath);
  const entries: RouteInfo[] = [];
  for await (const entry of walk(projectPath, { includeRoots: ["app"] })) {
    const kind = kindFromBasename(entry.relativePath);
    if (!kind) continue;
    const pathPattern = pathPatternFor(entry.relativePath);
    if (!pathPattern) continue;

    let methods: HttpMethod[] = [];
    if (kind === "route") {
      try {
        const source = await fs.readFile(entry.absolutePath, "utf-8");
        methods = methodsExported(source, kind);
      } catch {
        methods = [];
      }
    }
    entries.push({
      framework: "next-app",
      kind,
      pathPattern,
      methods,
      filePath: entry.relativePath,
      isDynamic: isDynamicPattern(pathPattern),
      hasMiddleware,
    });
  }
  return entries;
}

async function detectMiddleware(projectPath: string): Promise<boolean> {
  for (const candidate of ["middleware.ts", "middleware.js"]) {
    try {
      await fs.access(path.join(projectPath, candidate));
      return true;
    } catch {
      // continue
    }
  }
  return false;
}
