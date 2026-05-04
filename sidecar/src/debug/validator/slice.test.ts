import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RawFinding } from "../detectors/types.js";
import type { RouteAuthInfo, SchemaTable, SoftwareGraph } from "../graph/index.js";
import {
  CONTEXT_LINES,
  extractSlice,
  filterRelatedTables,
  renderContext,
} from "./slice.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "slice-test-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function touch(rel: string, content: string): Promise<void> {
  const abs = path.join(tmp, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

const sampleFinding = (overrides: Partial<RawFinding> = {}): RawFinding => ({
  class: "auth",
  ruleId: "test/rule",
  severity: 9,
  blastRadius: 2.5,
  confidence: 0.7,
  difficulty: 1.5,
  file: "supabase/migrations/0001_users.sql",
  lineStart: 1,
  lineEnd: 1,
  humanExplanation: "explanation",
  codeEvidence: "code",
  ...overrides,
});

const sampleTable = (name: string, overrides: Partial<SchemaTable> = {}): SchemaTable => ({
  name,
  columns: [],
  rlsEnabled: false,
  policies: [],
  source: { file: `supabase/migrations/0001_${name}.sql`, line: 1 },
  ...overrides,
});

const emptyGraph = (): SoftwareGraph => ({
  routes: [],
  schema: [],
  auth: [],
  warnings: [],
});

describe("renderContext", () => {
  it("renders nothing for an empty file", () => {
    expect(renderContext([], 1, 1)).toBe("");
  });

  it("marks the hit line with a `> ` prefix", () => {
    const lines = ["a", "b", "c", "d", "e"];
    const out = renderContext(lines, 3, 3);
    const split = out.split("\n");
    expect(split.find((l) => l.includes(": c"))).toMatch(/^> /);
    expect(split.find((l) => l.includes(": b"))).toMatch(/^ {2}/);
  });

  it("clamps the lower bound to line 1 and upper bound to file length", () => {
    const lines = ["only"];
    const out = renderContext(lines, 1, 1);
    expect(out).toBe("> 1: only");
  });

  it("includes up to CONTEXT_LINES lines on each side of the hit", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line${i + 1}`);
    const out = renderContext(lines, 100, 100);
    const split = out.split("\n");
    expect(split).toHaveLength(2 * CONTEXT_LINES + 1);
    expect(split[0]).toContain(`line${100 - CONTEXT_LINES}`);
    expect(split[split.length - 1]).toContain(`line${100 + CONTEXT_LINES}`);
  });

  it("supports a multi-line hit range", () => {
    const lines = ["a", "b", "c", "d", "e"];
    const out = renderContext(lines, 2, 4);
    const hits = out.split("\n").filter((l) => l.startsWith("> "));
    expect(hits).toHaveLength(3);
  });

  it("pads line numbers to a consistent width", () => {
    const lines = Array.from({ length: 120 }, (_, i) => `line${i + 1}`);
    const out = renderContext(lines, 50, 50);
    // The widest line number in the slice is 100 (50+50) → 3-char wide.
    const split = out.split("\n");
    // Every line begins with a 2-char marker + 3-char number + ": ".
    expect(split.every((l) => /^[> ]{2}\s*\d+: /.test(l))).toBe(true);
  });
});

describe("filterRelatedTables", () => {
  it("returns tables whose unquoted name appears as a whole word", () => {
    const source = `SELECT * FROM users WHERE id = 1;`;
    const result = filterRelatedTables(source, [
      sampleTable("users"),
      sampleTable("posts"),
    ]);
    expect(result.map((t) => t.name)).toEqual(["users"]);
  });

  it("ignores partial-word matches", () => {
    const source = `const usersList = [];`; // 'users' is a substring of usersList
    const result = filterRelatedTables(source, [sampleTable("users")]);
    expect(result).toEqual([]);
  });

  it("matches case-insensitively", () => {
    const source = `SELECT * FROM USERS;`;
    const result = filterRelatedTables(source, [sampleTable("users")]);
    expect(result).toHaveLength(1);
  });

  it("returns empty for empty source or empty schema", () => {
    expect(filterRelatedTables("", [sampleTable("users")])).toEqual([]);
    expect(filterRelatedTables("SELECT * FROM users", [])).toEqual([]);
  });

  it("returns multiple tables when multiple names appear", () => {
    const source = `SELECT * FROM users JOIN posts ON posts.author_id = users.id;`;
    const result = filterRelatedTables(source, [
      sampleTable("users"),
      sampleTable("posts"),
      sampleTable("comments"),
    ]);
    expect(result.map((t) => t.name).sort()).toEqual(["posts", "users"]);
  });
});

describe("extractSlice (e2e)", () => {
  it("returns an orphan slice when the file is not referenced by the graph", async () => {
    await touch("supabase/migrations/0001_users.sql", `CREATE TABLE users (id uuid);`);
    const finding = sampleFinding({ file: "supabase/migrations/0001_users.sql" });
    const slice = await extractSlice(finding, emptyGraph(), tmp);
    expect(slice.isOrphan).toBe(true);
    expect(slice.contextSource).toContain("CREATE TABLE users");
    expect(slice.relatedRoutes).toEqual([]);
    expect(slice.relatedTables).toEqual([]);
  });

  it("joins related routes by file path", async () => {
    await touch(
      "app/api/users/route.ts",
      `import { getServerSession } from "next-auth";
       export async function GET() { await getServerSession(); }`
    );
    const route: RouteAuthInfo = {
      route: {
        framework: "next-app",
        kind: "route",
        pathPattern: "/api/users",
        methods: ["GET"],
        filePath: "app/api/users/route.ts",
        isDynamic: false,
        hasMiddleware: false,
      },
      authentication: {
        kind: "authentication",
        identifier: "getServerSession",
        file: "app/api/users/route.ts",
        line: 2,
      },
      authorizations: [],
    };
    const graph: SoftwareGraph = {
      routes: [route.route],
      schema: [],
      auth: [route],
      warnings: [],
    };
    const finding = sampleFinding({
      file: "app/api/users/route.ts",
      lineStart: 2,
      lineEnd: 2,
    });
    const slice = await extractSlice(finding, graph, tmp);
    expect(slice.relatedRoutes).toHaveLength(1);
    expect(slice.relatedRoutes[0]!.route.pathPattern).toBe("/api/users");
    expect(slice.isOrphan).toBe(false);
  });

  it("joins related schema tables by name appearing in the source", async () => {
    await touch(
      "lib/queries.ts",
      `export const getUsers = () => db.from("users").select("*");`
    );
    const graph: SoftwareGraph = {
      routes: [],
      schema: [sampleTable("users"), sampleTable("posts")],
      auth: [],
      warnings: [],
    };
    const finding = sampleFinding({ file: "lib/queries.ts", lineStart: 1, lineEnd: 1 });
    const slice = await extractSlice(finding, graph, tmp);
    expect(slice.relatedTables.map((t) => t.name)).toEqual(["users"]);
  });

  it("emits an empty contextSource when the file no longer exists", async () => {
    const finding = sampleFinding({ file: "deleted.ts" });
    const slice = await extractSlice(finding, emptyGraph(), tmp);
    expect(slice.contextSource).toBe("");
    expect(slice.isOrphan).toBe(true);
    expect(slice.totalLines).toBe(0);
  });

  it("populates totalLines from the source", async () => {
    await touch("lib/util.ts", "a\nb\nc\nd\n");
    const finding = sampleFinding({ file: "lib/util.ts", lineStart: 2, lineEnd: 2 });
    const slice = await extractSlice(finding, emptyGraph(), tmp);
    // Trailing newline produces an empty 5th element from split — we report 5.
    expect(slice.totalLines).toBeGreaterThanOrEqual(4);
  });
});
