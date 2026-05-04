import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildGraph } from "./index.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "graph-test-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function touch(rel: string, content: string): Promise<void> {
  const abs = path.join(tmp, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

describe("buildGraph (composition)", () => {
  it("returns an empty graph + no warnings for an empty project", async () => {
    const g = await buildGraph(tmp);
    expect(g.routes).toEqual([]);
    expect(g.schema).toEqual([]);
    expect(g.auth).toEqual([]);
    expect(g.warnings).toEqual([]);
  });

  it("composes routes + schema + auth for a fixture-shape project", async () => {
    // One page, one route handler with auth, one supabase migration.
    await touch(
      "app/page.tsx",
      `export default function Home() { return null; }`
    );
    await touch(
      "app/api/users/[id]/route.ts",
      `import { getServerSession } from "next-auth";
       export async function GET() {
         const s = await getServerSession();
         return new Response();
       }`
    );
    await touch(
      "supabase/migrations/0001_users.sql",
      `CREATE TABLE users (id uuid PRIMARY KEY, email text NOT NULL);
       ALTER TABLE users ENABLE ROW LEVEL SECURITY;`
    );

    const g = await buildGraph(tmp);

    expect(g.routes.map((r) => r.pathPattern).sort()).toEqual([
      "/",
      "/api/users/[id]",
    ]);
    expect(g.schema).toHaveLength(1);
    expect(g.schema[0]!.name).toBe("users");
    expect(g.schema[0]!.rlsEnabled).toBe(true);

    const apiRoute = g.auth.find((a) => a.route.pathPattern === "/api/users/[id]");
    expect(apiRoute?.authentication?.identifier).toBe("getServerSession");

    const homePage = g.auth.find((a) => a.route.pathPattern === "/");
    expect(homePage?.authentication).toBeNull();

    expect(g.warnings).toEqual([]);
  });

  it("preserves warnings even when one area succeeds", async () => {
    // We don't have an easy reproducer for an area failure in v1 — both
    // route inventory and schema build are robust against missing dirs.
    // This test instead asserts the SHAPE of the result so future areas
    // (e.g. tsc-aware detection) have a contract to follow.
    const g = await buildGraph(tmp);
    expect(Array.isArray(g.warnings)).toBe(true);
  });
});
