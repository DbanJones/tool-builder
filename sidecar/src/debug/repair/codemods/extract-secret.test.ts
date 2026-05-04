import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyExtractSecret, handlesRuleId } from "./extract-secret.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "extract-secret-test-"));
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

describe("handlesRuleId", () => {
  it("handles every secret-regex/* rule", () => {
    expect(handlesRuleId("secret-regex/aws-access-key")).toBe(true);
    expect(handlesRuleId("secret-regex/github-pat")).toBe(true);
    expect(handlesRuleId("secret-regex/stripe-live-secret")).toBe(true);
    expect(handlesRuleId("secret-regex/anthropic-api-key")).toBe(true);
  });

  it("does not handle other rule families", () => {
    expect(handlesRuleId("rls-missing/no-rls-on-pii-table")).toBe(false);
    expect(handlesRuleId("tsc/TS2304")).toBe(false);
  });
});

describe("applyExtractSecret", () => {
  it("rewrites an AWS access key to process.env.AWS_ACCESS_KEY_ID", async () => {
    await touch("lib/aws.ts", `const KEY = "AKIAIOSFODNN7EXAMPLE";`);
    const result = await applyExtractSecret({
      defect: {
        ruleId: "secret-regex/aws-access-key",
        file: "lib/aws.ts",
        lineStart: 1,
        lineEnd: 1,
      },
      projectPath: tmp,
    });
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.fixTier).toBe(1);
    expect(result.files).toEqual(["lib/aws.ts", ".env.example"]);

    const after = await read("lib/aws.ts");
    expect(after).toContain("process.env.AWS_ACCESS_KEY_ID!");
    expect(after).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("creates .env.example when missing and seeds the new var", async () => {
    await touch("lib/aws.ts", `const KEY = "AKIAIOSFODNN7EXAMPLE";`);
    await applyExtractSecret({
      defect: {
        ruleId: "secret-regex/aws-access-key",
        file: "lib/aws.ts",
        lineStart: 1,
        lineEnd: 1,
      },
      projectPath: tmp,
    });
    const env = await read(".env.example");
    expect(env).toContain("# AWS access key");
    expect(env).toMatch(/^AWS_ACCESS_KEY_ID=/m);
  });

  it("appends to an existing .env.example without disturbing prior entries", async () => {
    await touch(".env.example", "DATABASE_URL=\nNODE_ENV=development\n");
    await touch("lib/gh.ts", `const T = "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";`);
    await applyExtractSecret({
      defect: {
        ruleId: "secret-regex/github-pat",
        file: "lib/gh.ts",
        lineStart: 1,
        lineEnd: 1,
      },
      projectPath: tmp,
    });
    const env = await read(".env.example");
    expect(env).toContain("DATABASE_URL=");
    expect(env).toContain("NODE_ENV=development");
    expect(env).toMatch(/^GITHUB_TOKEN=/m);
  });

  it("does not duplicate an env var that is already declared", async () => {
    await touch(".env.example", "AWS_ACCESS_KEY_ID=\n");
    await touch("lib/aws.ts", `const KEY = "AKIAIOSFODNN7EXAMPLE";`);
    await applyExtractSecret({
      defect: {
        ruleId: "secret-regex/aws-access-key",
        file: "lib/aws.ts",
        lineStart: 1,
        lineEnd: 1,
      },
      projectPath: tmp,
    });
    const env = await read(".env.example");
    const matches = env.match(/^AWS_ACCESS_KEY_ID=/gm) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("returns skipped when the literal is no longer on the line", async () => {
    await touch("lib/aws.ts", `const KEY = "rotated-since-the-scan";`);
    const result = await applyExtractSecret({
      defect: {
        ruleId: "secret-regex/aws-access-key",
        file: "lib/aws.ts",
        lineStart: 1,
        lineEnd: 1,
      },
      projectPath: tmp,
    });
    expect(result.kind).toBe("skipped");
  });

  it("returns error when the source file no longer exists", async () => {
    const result = await applyExtractSecret({
      defect: {
        ruleId: "secret-regex/aws-access-key",
        file: "lib/missing.ts",
        lineStart: 1,
        lineEnd: 1,
      },
      projectPath: tmp,
    });
    expect(result.kind).toBe("error");
  });

  it("returns error when the line is out of range", async () => {
    await touch("lib/aws.ts", `// short file`);
    const result = await applyExtractSecret({
      defect: {
        ruleId: "secret-regex/aws-access-key",
        file: "lib/aws.ts",
        lineStart: 9999,
        lineEnd: 9999,
      },
      projectPath: tmp,
    });
    expect(result.kind).toBe("error");
  });

  it("returns skipped for a ruleId we do not handle", async () => {
    const result = await applyExtractSecret({
      defect: {
        ruleId: "tsc/TS2304",
        file: "lib/foo.ts",
        lineStart: 1,
        lineEnd: 1,
      },
      projectPath: tmp,
    });
    expect(result.kind).toBe("skipped");
  });

  it("preserves the rest of the line around the secret", async () => {
    await touch(
      "lib/stripe.ts",
      `const stripe = new Stripe("sk_live_abcdefghijklmnopqrstuvwxyz1234567890");`
    );
    await applyExtractSecret({
      defect: {
        ruleId: "secret-regex/stripe-live-secret",
        file: "lib/stripe.ts",
        lineStart: 1,
        lineEnd: 1,
      },
      projectPath: tmp,
    });
    const after = await read("lib/stripe.ts");
    expect(after).toBe(`const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);`);
  });
});
