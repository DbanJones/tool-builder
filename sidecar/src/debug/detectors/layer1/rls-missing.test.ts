import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isPiiColumn, parseMigration, rlsMissingScan } from "./rls-missing.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rls-test-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function migration(name: string, content: string): Promise<void> {
  const abs = path.join(tmp, "supabase", "migrations", name);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

const CTX = (projectPath: string) => ({
  projectPath,
  scanId: "scan-1",
  startedAt: 0,
});

describe("isPiiColumn", () => {
  it("matches exact PII names regardless of case", () => {
    expect(isPiiColumn("email")).toBe(true);
    expect(isPiiColumn("EMAIL")).toBe(true);
    expect(isPiiColumn("Phone")).toBe(true);
    expect(isPiiColumn("password_hash")).toBe(true);
    expect(isPiiColumn("ssn")).toBe(true);
  });

  it("matches PII suffix conventions", () => {
    expect(isPiiColumn("primary_email")).toBe(true);
    expect(isPiiColumn("billing_address")).toBe(true);
    expect(isPiiColumn("auth_token")).toBe(true);
  });

  it("does not flag non-PII columns", () => {
    expect(isPiiColumn("id")).toBe(false);
    expect(isPiiColumn("title")).toBe(false);
    expect(isPiiColumn("created_at")).toBe(false);
    expect(isPiiColumn("status")).toBe(false);
  });
});

describe("parseMigration", () => {
  it("extracts table name + PII columns from CREATE TABLE", () => {
    const sql = `
      CREATE TABLE users (
        id uuid PRIMARY KEY,
        email text NOT NULL,
        full_name text
      );
    `;
    const { creates } = parseMigration(sql, "supabase/migrations/0001.sql");
    expect(creates).toHaveLength(1);
    expect(creates[0]!.name).toBe("users");
    expect(creates[0]!.piiColumns).toEqual(["email"]);
  });

  it("recognises ENABLE ROW LEVEL SECURITY across many syntactic variants", () => {
    const sql = `
      ALTER TABLE users ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ONLY "comments" ENABLE ROW LEVEL SECURITY;
    `;
    const { enables } = parseMigration(sql, "x.sql");
    expect([...enables].sort()).toEqual(["comments", "posts", "users"]);
  });

  it("captures CREATE POLICY targets", () => {
    const sql = `CREATE POLICY allow_owner ON profiles FOR SELECT USING (auth.uid() = user_id);`;
    const { policies } = parseMigration(sql, "x.sql");
    expect([...policies]).toEqual(["profiles"]);
  });

  it("ignores CREATE TABLE inside line comments", () => {
    const sql = `
      -- CREATE TABLE fake_users (email text);
      CREATE TABLE real_users (id uuid PRIMARY KEY);
    `;
    const { creates } = parseMigration(sql, "x.sql");
    expect(creates).toHaveLength(1);
    expect(creates[0]!.name).toBe("real_users");
  });

  it("recovers when a non-CREATE-TABLE statement is unparseable", () => {
    // Some Supabase migrations include CREATE EXTENSION which the parser
    // may not love; we should still find the CREATE TABLE.
    const sql = `
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE TABLE accounts (id uuid PRIMARY KEY, email text);
    `;
    const { creates } = parseMigration(sql, "x.sql");
    expect(creates.map((c) => c.name)).toEqual(["accounts"]);
  });
});

describe("rlsMissingScan — Lovable-class fixture", () => {
  it("flags a PII table with no RLS as critical (the headline case)", async () => {
    await migration(
      "0001_users.sql",
      `
        CREATE TABLE users (
          id uuid PRIMARY KEY,
          email text NOT NULL,
          full_name text
        );
      `
    );
    const findings = await rlsMissingScan(CTX(tmp));
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.class).toBe("auth");
    expect(f.ruleId).toBe("rls-missing/no-rls-on-pii-table");
    expect(f.severity).toBe(9);
    expect(f.blastRadius).toBe(2.5);
    // Founder mode: (9 × 2.5 × 0.7 × 2.0) / 1.5 = 21 → critical band.
    // The detector reports the components; the scan handler scores. Just
    // assert the components match the source spec's worked example.
    expect(f.confidence).toBeCloseTo(0.7, 5);
    expect(f.difficulty).toBeCloseTo(1.5, 5);
    expect(f.humanExplanation).toContain("row-level security");
    expect(f.humanExplanation).toContain("anon key");
  });

  it("does not flag a PII table that enables RLS in a later migration", async () => {
    await migration(
      "0001_users.sql",
      `CREATE TABLE users (id uuid PRIMARY KEY, email text);`
    );
    await migration(
      "0002_enable_rls.sql",
      `ALTER TABLE users ENABLE ROW LEVEL SECURITY;`
    );
    expect(await rlsMissingScan(CTX(tmp))).toEqual([]);
  });

  it("does not flag a non-PII table even without RLS", async () => {
    await migration(
      "0001_posts.sql",
      `CREATE TABLE posts (id uuid PRIMARY KEY, title text, body text);`
    );
    expect(await rlsMissingScan(CTX(tmp))).toEqual([]);
  });

  it("emits BOTH findings when a table has CREATE POLICY but no ENABLE", async () => {
    await migration(
      "0001_profiles.sql",
      `
        CREATE TABLE profiles (id uuid PRIMARY KEY, email text NOT NULL);
        CREATE POLICY owner_select ON profiles FOR SELECT USING (auth.uid() = id);
      `
    );
    const findings = await rlsMissingScan(CTX(tmp));
    const ruleIds = findings.map((f) => f.ruleId).sort();
    expect(ruleIds).toEqual([
      "rls-missing/no-rls-on-pii-table",
      "rls-missing/policy-without-enable",
    ]);
  });

  it("does not flag the policy-without-enable case if RLS IS enabled", async () => {
    await migration(
      "0001_profiles.sql",
      `
        CREATE TABLE profiles (id uuid PRIMARY KEY, email text NOT NULL);
        ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
        CREATE POLICY owner_select ON profiles FOR SELECT USING (auth.uid() = id);
      `
    );
    expect(await rlsMissingScan(CTX(tmp))).toEqual([]);
  });

  it("returns empty when there are no migrations", async () => {
    expect(await rlsMissingScan(CTX(tmp))).toEqual([]);
  });

  it("does not look outside the supabase/ root", async () => {
    // A file under app/ that happens to be SQL (it shouldn't be) must be
    // ignored by this detector.
    const stray = path.join(tmp, "app", "fake.sql");
    await fs.mkdir(path.dirname(stray), { recursive: true });
    await fs.writeFile(stray, `CREATE TABLE users (email text);`);
    expect(await rlsMissingScan(CTX(tmp))).toEqual([]);
  });
});
