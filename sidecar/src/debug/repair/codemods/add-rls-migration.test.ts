import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyAddRlsMigration,
  handlesRuleId,
  nextMigrationNumber,
  parseTableName,
} from "./add-rls-migration.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "add-rls-test-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function touch(rel: string, content = ""): Promise<void> {
  const abs = path.join(tmp, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

describe("handlesRuleId", () => {
  it("handles only rls-missing/no-rls-on-pii-table at v1", () => {
    expect(handlesRuleId("rls-missing/no-rls-on-pii-table")).toBe(true);
    // policy-without-enable also describes a missing-RLS state but
    // the policy is already there — different fix.
    expect(handlesRuleId("rls-missing/policy-without-enable")).toBe(false);
    expect(handlesRuleId("secret-regex/aws-access-key")).toBe(false);
  });
});

describe("parseTableName", () => {
  it("extracts the table name from the canonical evidence shape", () => {
    expect(parseTableName("CREATE TABLE users (… email, password_hash …)")).toBe(
      "users"
    );
  });

  it("strips quoted identifiers", () => {
    expect(parseTableName(`CREATE TABLE "users" (...)`)).toBe("users");
  });

  it("handles uppercase keywords", () => {
    expect(parseTableName("create table accounts (id uuid)")).toBe("accounts");
  });

  it("returns null when no CREATE TABLE is present", () => {
    expect(parseTableName("ALTER TABLE users ENABLE RLS")).toBeNull();
  });
});

describe("nextMigrationNumber", () => {
  it("returns 0001 when no migrations exist", async () => {
    expect(await nextMigrationNumber(path.join(tmp, "missing"))).toBe("0001");
  });

  it("returns 0001 for an empty migrations directory", async () => {
    await fs.mkdir(path.join(tmp, "supabase", "migrations"), { recursive: true });
    expect(
      await nextMigrationNumber(path.join(tmp, "supabase", "migrations"))
    ).toBe("0001");
  });

  it("returns max+1 for an existing sequence", async () => {
    await touch("supabase/migrations/0001_users.sql");
    await touch("supabase/migrations/0002_posts.sql");
    await touch("supabase/migrations/0007_audit.sql");
    expect(
      await nextMigrationNumber(path.join(tmp, "supabase", "migrations"))
    ).toBe("0008");
  });

  it("ignores files that do not match the NNNN_ prefix", async () => {
    await touch("supabase/migrations/0001_users.sql");
    await touch("supabase/migrations/README.md");
    expect(
      await nextMigrationNumber(path.join(tmp, "supabase", "migrations"))
    ).toBe("0002");
  });

  it("supports 5+ digit prefixes (defensive)", async () => {
    await touch("supabase/migrations/12345_legacy.sql");
    expect(
      await nextMigrationNumber(path.join(tmp, "supabase", "migrations"))
    ).toBe("12346");
  });
});

describe("applyAddRlsMigration", () => {
  it("writes a new migration file with the next sequence number", async () => {
    await touch("supabase/migrations/0001_users.sql");
    const result = await applyAddRlsMigration({
      defect: {
        ruleId: "rls-missing/no-rls-on-pii-table",
        file: "supabase/migrations/0001_users.sql",
        lineStart: 1,
        codeEvidence: "CREATE TABLE users (… email, password_hash …)",
      },
      projectPath: tmp,
    });
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.fixTier).toBe(1);
    expect(result.files).toEqual([
      "supabase/migrations/0002_enable_rls_users.sql",
    ]);

    const written = await fs.readFile(
      path.join(tmp, "supabase", "migrations", "0002_enable_rls_users.sql"),
      "utf-8"
    );
    expect(written).toContain("ALTER TABLE users ENABLE ROW LEVEL SECURITY;");
    expect(written).toContain("CREATE POLICY users_owner_select ON users");
    expect(written).toContain("CREATE POLICY users_owner_modify ON users");
    expect(written).toContain("OWNER_COLUMN");
    expect(written).toContain("TODO");
  });

  it("creates supabase/migrations when it does not yet exist", async () => {
    const result = await applyAddRlsMigration({
      defect: {
        ruleId: "rls-missing/no-rls-on-pii-table",
        file: "supabase/migrations/0001_users.sql",
        lineStart: 1,
        codeEvidence: "CREATE TABLE accounts (...)",
      },
      projectPath: tmp,
    });
    expect(result.kind).toBe("applied");
    const stat = await fs.stat(
      path.join(tmp, "supabase", "migrations", "0001_enable_rls_accounts.sql")
    );
    expect(stat.isFile()).toBe(true);
  });

  it("returns skipped for a rule the codemod does not handle", async () => {
    const result = await applyAddRlsMigration({
      defect: {
        ruleId: "secret-regex/aws-access-key",
        file: "lib/aws.ts",
        lineStart: 1,
        codeEvidence: "AKIA*** (redacted)",
      },
      projectPath: tmp,
    });
    expect(result.kind).toBe("skipped");
  });

  it("returns error when the codeEvidence does not name a table", async () => {
    const result = await applyAddRlsMigration({
      defect: {
        ruleId: "rls-missing/no-rls-on-pii-table",
        file: "supabase/migrations/0001.sql",
        lineStart: 1,
        codeEvidence: "ALTER TABLE foo ENABLE RLS",
      },
      projectPath: tmp,
    });
    expect(result.kind).toBe("error");
  });
});
