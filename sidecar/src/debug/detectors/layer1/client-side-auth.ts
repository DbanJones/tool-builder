// Enrichlead-class client-side-auth detector. The defect: a `.tsx` file
// gates render on `user.role === "admin"` (or similar) without any
// matching server-side authorisation check, so the "admin only" UI is
// hidden by JS but the underlying API/data is still readable by anyone.
// Source spec §B.1.5 row 1: "Enrichlead shut down because of this exact
// pattern."
//
// v1 detection: AST visit every .tsx file. Flag any property access on
// a "role-shaped" name — `user.role`, `user.isAdmin`, `user.permissions`,
// `session.user.role`, etc. The detector cannot decide on its own
// whether the matching server-side check exists; it lowers confidence
// when the file *also* references `getServerSession`, `supabase.auth.
// getUser`, a `redirect(`/`notFound(`, a `'use server'` directive, or
// `fetch(` (which usually implies an authenticated API call). The Layer
// 2 validator at G4 makes the real call.

import ts from "typescript";

import type { Detector, RawFinding, ScanContext } from "../types.js";
import { lineOfNode, visitAll, walkAst } from "../ts-ast.js";

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

// Tokens whose presence in the same file lowers confidence. Coarse — does
// not check actual reachability — but enough to stop critical-band noise
// on pages that already redirect unauthenticated visitors.
const SERVER_SIDE_HINTS: readonly string[] = [
  "getServerSession",
  "supabase.auth.getUser",
  "supabase.auth.getSession",
  "'use server'",
  '"use server"',
  "redirect(",
  "notFound(",
  "fetch(",
  "createClient",
];

interface RoleCheck {
  name: string;
  line: number;
  /** The literal text of the property access path (`user.role`). */
  expression: string;
}

export function findRoleChecks(ast: ts.SourceFile): RoleCheck[] {
  const out: RoleCheck[] = [];
  visitAll(ast, (node) => {
    if (!ts.isPropertyAccessExpression(node)) return;
    const name = node.name.text;
    if (!ROLE_SHAPED_NAMES.has(name)) return;
    out.push({
      name,
      line: lineOfNode(ast, node),
      expression: node.getText(ast),
    });
  });
  return out;
}

export function hasServerSideHint(source: string): boolean {
  return SERVER_SIDE_HINTS.some((hint) => source.includes(hint));
}

export async function clientSideAuthScan(
  ctx: ScanContext
): Promise<readonly RawFinding[]> {
  const findings: RawFinding[] = [];
  for await (const parsed of walkAst(ctx.projectPath)) {
    if (!parsed.relativePath.toLowerCase().endsWith(".tsx")) continue;

    const checks = findRoleChecks(parsed.ast);
    if (checks.length === 0) continue;

    const compensated = hasServerSideHint(parsed.source);

    // De-duplicate by line so a `user.role === "admin"` that the AST
    // visits via multiple parent chains only fires once per location.
    const seen = new Set<number>();
    for (const check of checks) {
      if (seen.has(check.line)) continue;
      seen.add(check.line);

      const severity = compensated ? 6 : 9;
      const confidence = compensated ? 0.4 : 0.7;
      findings.push({
        class: "auth",
        ruleId: compensated
          ? "client-side-auth/with-server-hint"
          : "client-side-auth/no-server-hint",
        severity,
        blastRadius: 2.5,
        confidence,
        difficulty: 2,
        file: parsed.relativePath,
        lineStart: check.line,
        lineEnd: check.line,
        humanExplanation: humanExplanation(check, parsed.relativePath, compensated),
        codeEvidence: check.expression,
      });
    }
  }
  return findings;
}

function humanExplanation(
  check: RoleCheck,
  file: string,
  compensated: boolean
): string {
  if (compensated) {
    return (
      `${file} checks ${check.expression} to decide what to render, and the ` +
      `same file also references a server-side check. Verify the server ` +
      `check actually protects the data this page reads — client-side role ` +
      `gating is presentation, not security.`
    );
  }
  return (
    `${file} hides UI based on ${check.expression}, but this file shows no ` +
    `sign of a matching server-side authorisation check. Anyone can open ` +
    `the browser dev tools, override the role check, and see the hidden ` +
    `content — and any API the hidden UI calls is reachable directly.`
  );
}

export const clientSideAuthDetector: Detector = {
  id: "client-side-auth",
  run(ctx: ScanContext): Promise<readonly RawFinding[]> {
    return clientSideAuthScan(ctx);
  },
};
