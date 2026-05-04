// Client-bundle env-leak detector. The defect: a `'use client'` file
// references `process.env.SOMETHING_SECRET` directly. Next.js inlines
// `process.env.X` references in client builds at build time, so a server
// secret pulled in through that path ends up in the public JS bundle.
// (`NEXT_PUBLIC_*` vars are explicitly opt-in for the client; everything
// else is meant to stay server-side.) Per source spec §B.1.6 row 5: this
// pattern was the cause of the documented exposed-secrets-in-bundle
// incidents.
//
// Detection: AST visit every TS/TSX/JS/JSX file whose first statement is
// `"use client"`. For each `process.env.X` access:
//  - skip if X starts with NEXT_PUBLIC_
//  - rank confidence by whether X looks secret-shaped (*_KEY, *_TOKEN,
//    *_SECRET, *_PASSWORD, STRIPE_*, DATABASE_URL,
//    SUPABASE_SERVICE_ROLE_KEY, etc.)
// Severity / blast radius / difficulty per source spec.

import ts from "typescript";

import type { Detector, RawFinding, ScanContext } from "../types.js";
import { isUseClient, lineOfNode, visitAll, walkAst } from "../ts-ast.js";

const SECRET_SHAPE_RE =
  /(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_PRIVATE|_CREDENTIAL|_DSN)$|^STRIPE_|^DATABASE_URL$|^SUPABASE_SERVICE_ROLE_KEY$|^OPENAI_|^ANTHROPIC_|^AWS_/;

interface EnvAccess {
  variable: string;
  line: number;
  text: string;
}

export function isSecretShaped(varName: string): boolean {
  return SECRET_SHAPE_RE.test(varName);
}

export function findEnvAccesses(ast: ts.SourceFile): EnvAccess[] {
  const out: EnvAccess[] = [];
  visitAll(ast, (node) => {
    // Match the AST shape of `process.env.NAME`:
    //   PropertyAccess(
    //     PropertyAccess(Identifier process, Identifier env),
    //     Identifier NAME
    //   )
    if (!ts.isPropertyAccessExpression(node)) return;
    const parent = node.expression;
    if (!ts.isPropertyAccessExpression(parent)) return;
    if (!ts.isIdentifier(parent.expression)) return;
    if (parent.expression.text !== "process") return;
    if (parent.name.text !== "env") return;
    out.push({
      variable: node.name.text,
      line: lineOfNode(ast, node),
      text: node.getText(ast),
    });
  });
  return out;
}

export async function envLeakScan(ctx: ScanContext): Promise<readonly RawFinding[]> {
  const findings: RawFinding[] = [];
  for await (const parsed of walkAst(ctx.projectPath)) {
    if (!isUseClient(parsed.ast)) continue;

    for (const access of findEnvAccesses(parsed.ast)) {
      if (access.variable.startsWith("NEXT_PUBLIC_")) continue;

      const secret = isSecretShaped(access.variable);
      findings.push({
        class: secret ? "security" : "deploy",
        ruleId: secret
          ? "env-leak/secret-shaped-in-client"
          : "env-leak/non-public-in-client",
        severity: secret ? 9 : 5,
        blastRadius: 2.5,
        confidence: secret ? 0.85 : 0.4,
        difficulty: 1,
        file: parsed.relativePath,
        lineStart: access.line,
        lineEnd: access.line,
        humanExplanation: humanExplanation(access.variable, parsed.relativePath, secret),
        codeEvidence: access.text,
      });
    }
  }
  return findings;
}

function humanExplanation(varName: string, file: string, secret: boolean): string {
  if (secret) {
    return (
      `${file} reads process.env.${varName} from a 'use client' file. ` +
      `Next.js inlines this value into the public JS bundle at build time, ` +
      `so anyone visiting your site can read it via dev tools. Move this ` +
      `code to a server component or a Route Handler, or — if the value is ` +
      `genuinely safe to expose — rename the env var to NEXT_PUBLIC_${varName}.`
    );
  }
  return (
    `${file} reads process.env.${varName} from a 'use client' file. ` +
    `Next.js will inline this value into the public bundle. If the variable ` +
    `is meant to be public, rename it to NEXT_PUBLIC_${varName}; if not, ` +
    `move the read to a server component or Route Handler.`
  );
}

export const envLeakDetector: Detector = {
  id: "env-leak",
  run(ctx: ScanContext): Promise<readonly RawFinding[]> {
    return envLeakScan(ctx);
  },
};
