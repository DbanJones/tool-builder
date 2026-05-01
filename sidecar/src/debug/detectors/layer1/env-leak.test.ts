import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { envLeakScan, findEnvAccesses, isSecretShaped } from "./env-leak.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "envleak-test-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function touch(rel: string, content: string): Promise<void> {
  const abs = path.join(tmp, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

const CTX = (projectPath: string) => ({
  projectPath,
  scanId: "scan-1",
  startedAt: 0,
});

function parseTsx(source: string): ts.SourceFile {
  return ts.createSourceFile("f.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

describe("isSecretShaped", () => {
  it("matches *_KEY, *_TOKEN, *_SECRET, *_PASSWORD suffixes", () => {
    expect(isSecretShaped("STRIPE_KEY")).toBe(true);
    expect(isSecretShaped("GITHUB_TOKEN")).toBe(true);
    expect(isSecretShaped("API_SECRET")).toBe(true);
    expect(isSecretShaped("DB_PASSWORD")).toBe(true);
  });

  it("matches well-known full names (DATABASE_URL, SUPABASE_SERVICE_ROLE_KEY)", () => {
    expect(isSecretShaped("DATABASE_URL")).toBe(true);
    expect(isSecretShaped("SUPABASE_SERVICE_ROLE_KEY")).toBe(true);
  });

  it("matches vendor prefixes (STRIPE_*, OPENAI_*, ANTHROPIC_*, AWS_*)", () => {
    expect(isSecretShaped("STRIPE_WEBHOOK_SECRET_2024")).toBe(true);
    expect(isSecretShaped("OPENAI_API_KEY")).toBe(true);
    expect(isSecretShaped("ANTHROPIC_API_KEY")).toBe(true);
    expect(isSecretShaped("AWS_ACCESS_KEY_ID")).toBe(true);
  });

  it("does not match generic non-secret names", () => {
    expect(isSecretShaped("PORT")).toBe(false);
    expect(isSecretShaped("NODE_ENV")).toBe(false);
    expect(isSecretShaped("FEATURE_FLAG_FOO")).toBe(false);
  });
});

describe("findEnvAccesses", () => {
  it("captures process.env.X references", () => {
    const ast = parseTsx(`const x = process.env.FOO;`);
    expect(findEnvAccesses(ast).map((a) => a.variable)).toEqual(["FOO"]);
  });

  it("captures multiple references", () => {
    const ast = parseTsx(`const a = process.env.A; const b = process.env.B;`);
    expect(findEnvAccesses(ast).map((a) => a.variable).sort()).toEqual(["A", "B"]);
  });

  it("does not match unrelated property accesses", () => {
    const ast = parseTsx(`const x = config.env.FOO;\nconst y = process.config;`);
    expect(findEnvAccesses(ast)).toEqual([]);
  });
});

describe("envLeakScan — bundle-leak fixture", () => {
  it("flags a secret-shaped env read in a 'use client' file as critical", async () => {
    await touch(
      "app/checkout.tsx",
      `"use client";
       export default function Checkout() {
         const stripe = process.env.STRIPE_SECRET_KEY;
         return <div>{stripe}</div>;
       }`
    );
    const findings = await envLeakScan(CTX(tmp));
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.class).toBe("security");
    expect(f.ruleId).toBe("env-leak/secret-shaped-in-client");
    expect(f.severity).toBe(9);
    expect(f.confidence).toBeCloseTo(0.85, 5);
    expect(f.codeEvidence).toContain("STRIPE_SECRET_KEY");
    expect(f.humanExplanation).toContain("public JS bundle");
  });

  it("downgrades non-secret-shaped env reads to medium-band", async () => {
    await touch(
      "app/feature.tsx",
      `"use client";
       export default function F() {
         return <div>{process.env.MY_FEATURE_FLAG}</div>;
       }`
    );
    const findings = await envLeakScan(CTX(tmp));
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.class).toBe("deploy");
    expect(f.ruleId).toBe("env-leak/non-public-in-client");
    expect(f.severity).toBe(5);
    expect(f.confidence).toBeCloseTo(0.4, 5);
  });

  it("does not flag NEXT_PUBLIC_ prefixed reads (they are intentional)", async () => {
    await touch(
      "app/feature.tsx",
      `"use client";
       export default function F() {
         return <div>{process.env.NEXT_PUBLIC_API_URL}</div>;
       }`
    );
    expect(await envLeakScan(CTX(tmp))).toEqual([]);
  });

  it("does not flag env reads in server components (no 'use client' directive)", async () => {
    await touch(
      "app/server.tsx",
      `export default function Server() {
         const k = process.env.STRIPE_SECRET_KEY;
         return <div>{k}</div>;
       }`
    );
    expect(await envLeakScan(CTX(tmp))).toEqual([]);
  });

  it("flags env reads in 'use client' .ts files (not just .tsx)", async () => {
    await touch(
      "lib/client-helper.ts",
      `"use client";
       export const KEY = process.env.OPENAI_API_KEY;`
    );
    const findings = await envLeakScan(CTX(tmp));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.codeEvidence).toContain("OPENAI_API_KEY");
  });

  it("aggregates multiple leaks across files", async () => {
    await touch(
      "app/a.tsx",
      `"use client";\nexport const A = process.env.STRIPE_SECRET_KEY;`
    );
    await touch(
      "app/b.tsx",
      `"use client";\nexport const B = process.env.GITHUB_TOKEN;`
    );
    const findings = await envLeakScan(CTX(tmp));
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.file).sort()).toEqual(["app/a.tsx", "app/b.tsx"]);
  });

  it("returns empty when there are no env reads at all", async () => {
    await touch(`app/page.tsx`, `"use client";\nexport default function P() { return null; }`);
    expect(await envLeakScan(CTX(tmp))).toEqual([]);
  });
});
