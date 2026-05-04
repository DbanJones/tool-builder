// Per-route authentication + authorization model. For every RouteInfo
// from routes.ts, parse the file's TS AST and identify:
//   - Authentication points: calls to getServerSession / auth() /
//     supabase.auth.getUser / supabase.auth.getSession / currentUser.
//   - Authorization checks: property accesses on role-shaped names
//     (user.role, user.isAdmin, user.permissions, …).
//
// The output is the third leg of the SoftwareGraph that G4's validator
// uses for auth-class subgraph slices and that the source spec §B.1.5
// detectors (missing-auth-on-route, broken-access-control, IDOR) will
// query directly.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import ts from "typescript";

import type { RouteInfo } from "./routes.js";

const AUTHENTICATION_FUNCTIONS: ReadonlySet<string> = new Set([
  "getServerSession",
  "currentUser",
  "auth",
  "getUser",
  "getSession",
]);

const ROLE_SHAPED_NAMES: ReadonlySet<string> = new Set([
  "role",
  "roles",
  "isAdmin",
  "isAdministrator",
  "is_admin",
  "isOwner",
  "isStaff",
  "permission",
  "permissions",
]);

export interface AuthCheck {
  kind: "authentication" | "authorization";
  /** The function name or property name as it appears in source. */
  identifier: string;
  file: string;
  line: number;
}

export interface RouteAuthInfo {
  route: RouteInfo;
  authentication: AuthCheck | null;
  authorizations: AuthCheck[];
}

/**
 * Find auth-related identifiers in the given TS source. Returns a flat
 * list — `analyseRouteFile` separates them into authentication vs
 * authorization buckets per the RouteAuthInfo shape.
 */
export function findAuthChecks(
  ast: ts.SourceFile,
  filePath: string
): AuthCheck[] {
  const out: AuthCheck[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name && AUTHENTICATION_FUNCTIONS.has(name)) {
        out.push({
          kind: "authentication",
          identifier: name,
          file: filePath,
          line: lineOf(ast, node),
        });
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      const name = node.name.text;
      if (ROLE_SHAPED_NAMES.has(name)) {
        out.push({
          kind: "authorization",
          identifier: node.getText(ast),
          file: filePath,
          line: lineOf(ast, node),
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return out;
}

/** Read the route file from disk, parse it, and return its RouteAuthInfo. */
export async function analyseRouteFile(
  projectPath: string,
  route: RouteInfo
): Promise<RouteAuthInfo> {
  const abs = path.join(projectPath, route.filePath);
  let source: string;
  try {
    source = await fs.readFile(abs, "utf-8");
  } catch {
    return { route, authentication: null, authorizations: [] };
  }
  const ast = ts.createSourceFile(
    route.filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(route.filePath)
  );
  const checks = findAuthChecks(ast, route.filePath);

  const authentications = checks.filter((c) => c.kind === "authentication");
  const authorizations = checks.filter((c) => c.kind === "authorization");

  return {
    route,
    authentication: authentications[0] ?? null,
    authorizations,
  };
}

/**
 * Build the auth model for every route in the inventory. Pure — drives
 * `analyseRouteFile` over each RouteInfo and collects the results.
 */
export async function buildAuthModel(
  projectPath: string,
  routes: readonly RouteInfo[]
): Promise<RouteAuthInfo[]> {
  return Promise.all(routes.map((r) => analyseRouteFile(projectPath, r)));
}

function calleeName(node: ts.CallExpression): string | null {
  const expr = node.expression;
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

function lineOf(ast: ts.SourceFile, node: ts.Node): number {
  return ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
}

function scriptKindFor(filePath: string): ts.ScriptKind {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs"))
    return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}
