import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dispatchTier1, hasTier1Codemod } from "./dispatcher.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dispatcher-test-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function touch(rel: string, content: string): Promise<void> {
  const abs = path.join(tmp, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

describe("hasTier1Codemod", () => {
  it("returns true for every rule with a Tier 1 codemod registered", () => {
    expect(hasTier1Codemod("secret-regex/aws-access-key")).toBe(true);
    expect(hasTier1Codemod("secret-regex/anthropic-api-key")).toBe(true);
    expect(hasTier1Codemod("rls-missing/no-rls-on-pii-table")).toBe(true);
  });

  it("returns false for rules without a v1 codemod", () => {
    expect(hasTier1Codemod("client-side-auth/no-server-hint")).toBe(false);
    expect(hasTier1Codemod("env-leak/secret-shaped-in-client")).toBe(false);
    expect(hasTier1Codemod("hallucinated-import")).toBe(false);
    expect(hasTier1Codemod("tsc/TS2304")).toBe(false);
  });
});

describe("dispatchTier1", () => {
  it("routes a secret-regex finding to the extract-secret codemod", async () => {
    await touch("lib/aws.ts", `const KEY = "AKIAIOSFODNN7EXAMPLE";`);
    const result = await dispatchTier1({
      defect: {
        ruleId: "secret-regex/aws-access-key",
        file: "lib/aws.ts",
        lineStart: 1,
        lineEnd: 1,
        codeEvidence: `const KEY = "AKIA***MPLE";`,
      },
      projectPath: tmp,
    });
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.files).toContain("lib/aws.ts");
    expect(result.files).toContain(".env.example");
  });

  it("routes a rls-missing finding to the add-rls-migration codemod", async () => {
    await touch("supabase/migrations/0001_users.sql", "CREATE TABLE users (id uuid);");
    const result = await dispatchTier1({
      defect: {
        ruleId: "rls-missing/no-rls-on-pii-table",
        file: "supabase/migrations/0001_users.sql",
        lineStart: 1,
        lineEnd: 1,
        codeEvidence: "CREATE TABLE users (… email …)",
      },
      projectPath: tmp,
    });
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.files[0]).toMatch(/0002_enable_rls_users\.sql$/);
  });

  it("returns skipped for a rule with no codemod", async () => {
    const result = await dispatchTier1({
      defect: {
        ruleId: "client-side-auth/no-server-hint",
        file: "app/admin/page.tsx",
        lineStart: 5,
        lineEnd: 5,
        codeEvidence: "user.role === 'admin'",
      },
      projectPath: tmp,
    });
    expect(result.kind).toBe("skipped");
    if (result.kind !== "skipped") return;
    expect(result.message).toContain("no Tier 1 codemod");
  });
});
