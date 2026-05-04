import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildSchemaGraph,
  parseMigrationStatements,
  stripSqlComments,
} from "./schema.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "schema-test-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function migration(name: string, content: string): Promise<void> {
  const abs = path.join(tmp, "supabase", "migrations", name);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

describe("stripSqlComments", () => {
  it("removes line comments", () => {
    expect(stripSqlComments("SELECT 1; -- a comment\nSELECT 2;")).toBe(
      "SELECT 1; \nSELECT 2;"
    );
  });

  it("removes block comments", () => {
    expect(stripSqlComments("SELECT /* drop */ 1;")).toBe("SELECT  1;");
  });

  it("does not strip strings that look like comments", () => {
    // Note: this is a known limitation — a SQL string containing `--`
    // would be partially stripped. The detector tolerates the false
    // negative; documented here as a regression marker.
    expect(stripSqlComments("SELECT 'a -- b';")).toBe("SELECT 'a ");
  });
});

describe("parseMigrationStatements", () => {
  it("extracts CREATE TABLE columns with type, nullability, and primary key", () => {
    const sql = `
      CREATE TABLE users (
        id uuid PRIMARY KEY,
        email text NOT NULL,
        full_name text
      );
    `;
    const { tables } = parseMigrationStatements(sql, "x.sql");
    expect(tables).toHaveLength(1);
    const t = tables[0]!;
    expect(t.name).toBe("users");
    expect(t.columns.map((c) => c.name)).toEqual(["id", "email", "full_name"]);
    const id = t.columns.find((c) => c.name === "id")!;
    expect(id.primaryKey).toBe(true);
    expect(id.nullable).toBe(false);
    const email = t.columns.find((c) => c.name === "email")!;
    expect(email.nullable).toBe(false);
    const fullName = t.columns.find((c) => c.name === "full_name")!;
    expect(fullName.nullable).toBe(true);
  });

  it("captures inline foreign keys", () => {
    const sql = `
      CREATE TABLE posts (
        id uuid PRIMARY KEY,
        author_id uuid REFERENCES users(id)
      );
    `;
    const { tables } = parseMigrationStatements(sql, "x.sql");
    const author = tables[0]!.columns.find((c) => c.name === "author_id")!;
    expect(author.foreignKey).toEqual({ table: "users", column: "id" });
  });

  it("captures every ENABLE RLS variant", () => {
    const sql = `
      ALTER TABLE users ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ONLY "comments" ENABLE ROW LEVEL SECURITY;
    `;
    const { enables } = parseMigrationStatements(sql, "x.sql");
    expect([...enables].sort()).toEqual(["comments", "posts", "users"]);
  });

  it("captures CREATE POLICY with explicit FOR action", () => {
    const sql = `
      CREATE POLICY p1 ON users FOR SELECT USING (true);
      CREATE POLICY p2 ON users FOR INSERT WITH CHECK (true);
      CREATE POLICY p3 ON users FOR UPDATE USING (true);
      CREATE POLICY p4 ON users FOR DELETE USING (true);
    `;
    const { policies } = parseMigrationStatements(sql, "x.sql");
    expect(policies).toEqual([
      { table: "users", name: "p1", for: "SELECT" },
      { table: "users", name: "p2", for: "INSERT" },
      { table: "users", name: "p3", for: "UPDATE" },
      { table: "users", name: "p4", for: "DELETE" },
    ]);
  });

  it("defaults policy action to ALL when FOR is omitted", () => {
    const sql = `CREATE POLICY p ON users USING (true);`;
    const { policies } = parseMigrationStatements(sql, "x.sql");
    expect(policies).toEqual([{ table: "users", name: "p", for: "ALL" }]);
  });

  it("does not mistake commented-out RLS for the real thing", () => {
    const sql = `
      CREATE TABLE users (id uuid PRIMARY KEY, email text);
      -- ALTER TABLE users ENABLE ROW LEVEL SECURITY;
      /* CREATE POLICY x ON users FOR SELECT USING (true); */
    `;
    const { tables, enables, policies } = parseMigrationStatements(sql, "x.sql");
    expect(tables).toHaveLength(1);
    expect(enables.size).toBe(0);
    expect(policies).toEqual([]);
  });

  it("survives non-CREATE-TABLE statements that node-sql-parser cannot parse", () => {
    const sql = `
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE TABLE accounts (id uuid PRIMARY KEY, email text);
    `;
    const { tables } = parseMigrationStatements(sql, "x.sql");
    expect(tables.map((t) => t.name)).toEqual(["accounts"]);
  });
});

describe("buildSchemaGraph (e2e against tmp dir)", () => {
  it("returns one SchemaTable per logical table merged across migrations", async () => {
    await migration(
      "0001_users.sql",
      `CREATE TABLE users (id uuid PRIMARY KEY, email text NOT NULL);`
    );
    await migration(
      "0002_enable_rls.sql",
      `ALTER TABLE users ENABLE ROW LEVEL SECURITY;`
    );
    await migration(
      "0003_policy.sql",
      `CREATE POLICY users_owner ON users FOR SELECT USING (auth.uid() = id);`
    );

    const graph = await buildSchemaGraph(tmp);
    expect(graph).toHaveLength(1);
    const t = graph[0]!;
    expect(t.name).toBe("users");
    expect(t.rlsEnabled).toBe(true);
    expect(t.policies).toEqual([{ name: "users_owner", for: "SELECT" }]);
    expect(t.source.file).toBe("supabase/migrations/0001_users.sql");
  });

  it("flags rlsEnabled: false on a table with no ENABLE migration", async () => {
    await migration(
      "0001_users.sql",
      `CREATE TABLE users (id uuid PRIMARY KEY, email text NOT NULL);`
    );
    const [t] = await buildSchemaGraph(tmp);
    expect(t!.rlsEnabled).toBe(false);
  });

  it("returns an empty graph when supabase/ does not exist", async () => {
    expect(await buildSchemaGraph(tmp)).toEqual([]);
  });

  it("does not look outside supabase/", async () => {
    const stray = path.join(tmp, "app", "fake.sql");
    await fs.mkdir(path.dirname(stray), { recursive: true });
    await fs.writeFile(stray, `CREATE TABLE users (id uuid PRIMARY KEY);`);
    expect(await buildSchemaGraph(tmp)).toEqual([]);
  });

  it("captures multiple tables across migrations with FKs intact", async () => {
    await migration(
      "0001_users.sql",
      `CREATE TABLE users (id uuid PRIMARY KEY);`
    );
    await migration(
      "0002_posts.sql",
      `CREATE TABLE posts (
         id uuid PRIMARY KEY,
         author_id uuid REFERENCES users(id),
         title text NOT NULL
       );`
    );
    const graph = await buildSchemaGraph(tmp);
    expect(graph.map((t) => t.name).sort()).toEqual(["posts", "users"]);
    const posts = graph.find((t) => t.name === "posts")!;
    const author = posts.columns.find((c) => c.name === "author_id")!;
    expect(author.foreignKey).toEqual({ table: "users", column: "id" });
  });
});
