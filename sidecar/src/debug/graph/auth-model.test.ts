import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { analyseRouteFile, buildAuthModel, findAuthChecks } from "./auth-model.js";
import type { RouteInfo } from "./routes.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "auth-model-test-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function touch(rel: string, content: string): Promise<void> {
  const abs = path.join(tmp, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

function parseTsx(source: string): ts.SourceFile {
  return ts.createSourceFile("f.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

const route = (overrides: Partial<RouteInfo> = {}): RouteInfo => ({
  framework: "next-app",
  kind: "route",
  pathPattern: "/api/test",
  methods: ["GET"],
  filePath: "app/api/test/route.ts",
  isDynamic: false,
  hasMiddleware: false,
  ...overrides,
});

describe("findAuthChecks", () => {
  it("captures getServerSession() as authentication", () => {
    const ast = parseTsx(
      `import { getServerSession } from "next-auth";
       export async function GET() {
         const s = await getServerSession();
         return new Response();
       }`
    );
    const checks = findAuthChecks(ast, "app/api/route.ts");
    const auths = checks.filter((c) => c.kind === "authentication");
    expect(auths).toHaveLength(1);
    expect(auths[0]!.identifier).toBe("getServerSession");
  });

  it("captures supabase.auth.getUser() as authentication", () => {
    const ast = parseTsx(
      `export async function GET() {
         const { data } = await supabase.auth.getUser();
         return new Response();
       }`
    );
    const auths = findAuthChecks(ast, "app/api/route.ts").filter(
      (c) => c.kind === "authentication"
    );
    expect(auths).toHaveLength(1);
    expect(auths[0]!.identifier).toBe("getUser");
  });

  it("captures auth() and currentUser() patterns (Clerk / NextAuth v5)", () => {
    const ast = parseTsx(
      `import { auth, currentUser } from "@clerk/nextjs/server";
       export async function GET() {
         const u = await currentUser();
         const a = await auth();
         return new Response();
       }`
    );
    const idents = findAuthChecks(ast, "x.ts")
      .filter((c) => c.kind === "authentication")
      .map((c) => c.identifier)
      .sort();
    expect(idents).toEqual(["auth", "currentUser"]);
  });

  it("captures role-shaped property accesses as authorization", () => {
    const ast = parseTsx(
      `export async function GET() {
         if (user.role === "admin") return new Response();
         if (user.isAdmin) return new Response();
         return new Response();
       }`
    );
    const auths = findAuthChecks(ast, "x.ts").filter((c) => c.kind === "authorization");
    expect(auths.map((c) => c.identifier).sort()).toEqual(["user.isAdmin", "user.role"]);
  });

  it("returns empty for a file with neither authentication nor authorization", () => {
    const ast = parseTsx(
      `export async function GET() { return new Response(JSON.stringify({})); }`
    );
    expect(findAuthChecks(ast, "x.ts")).toEqual([]);
  });

  it("captures line numbers correctly (1-indexed)", () => {
    const ast = parseTsx(
      `// line 1\n// line 2\nexport async function GET() {\n  await getServerSession();\n}`
    );
    const auth = findAuthChecks(ast, "x.ts").find((c) => c.kind === "authentication");
    expect(auth?.line).toBe(4);
  });

  it("captures session.user.role in nested expressions", () => {
    const ast = parseTsx(
      `export async function GET() {
         const session: any = {};
         if (session.user.role === "admin") return new Response();
         return new Response();
       }`
    );
    const auths = findAuthChecks(ast, "x.ts").filter((c) => c.kind === "authorization");
    expect(auths.some((a) => a.identifier === "session.user.role")).toBe(true);
  });
});

describe("analyseRouteFile (e2e)", () => {
  it("returns null authentication + empty authorizations for an unauthed route", async () => {
    await touch(
      "app/api/users/[id]/route.ts",
      `export async function GET() { return new Response(); }`
    );
    const info = await analyseRouteFile(
      tmp,
      route({ filePath: "app/api/users/[id]/route.ts", pathPattern: "/api/users/[id]" })
    );
    expect(info.authentication).toBeNull();
    expect(info.authorizations).toEqual([]);
  });

  it("returns the authentication entry for a route with getServerSession", async () => {
    await touch(
      "app/api/users/route.ts",
      `import { getServerSession } from "next-auth";
       export async function GET() {
         const s = await getServerSession();
         return new Response();
       }`
    );
    const info = await analyseRouteFile(
      tmp,
      route({ filePath: "app/api/users/route.ts", pathPattern: "/api/users" })
    );
    expect(info.authentication).toMatchObject({
      kind: "authentication",
      identifier: "getServerSession",
    });
  });

  it("returns both authentication and authorizations when present", async () => {
    await touch(
      "app/admin/page.tsx",
      `import { getServerSession } from "next-auth";
       export default async function AdminPage() {
         const s: any = await getServerSession();
         if (s?.user.role !== "admin") return null;
         return null;
       }`
    );
    const info = await analyseRouteFile(
      tmp,
      route({
        kind: "page",
        methods: [],
        filePath: "app/admin/page.tsx",
        pathPattern: "/admin",
      })
    );
    expect(info.authentication?.identifier).toBe("getServerSession");
    expect(info.authorizations.length).toBeGreaterThanOrEqual(1);
    expect(info.authorizations[0]!.identifier).toBe("s?.user.role");
  });

  it("returns null authentication when the file is missing on disk", async () => {
    const info = await analyseRouteFile(
      tmp,
      route({ filePath: "app/api/missing/route.ts" })
    );
    expect(info.authentication).toBeNull();
    expect(info.authorizations).toEqual([]);
  });
});

describe("buildAuthModel", () => {
  it("returns one RouteAuthInfo per RouteInfo, in the same order", async () => {
    await touch(
      "app/page.tsx",
      `export default function Home() { return null; }`
    );
    await touch(
      "app/admin/page.tsx",
      `import { getServerSession } from "next-auth";
       export default async function P() {
         await getServerSession();
         return null;
       }`
    );
    const routes: RouteInfo[] = [
      route({ kind: "page", methods: [], filePath: "app/page.tsx", pathPattern: "/" }),
      route({
        kind: "page",
        methods: [],
        filePath: "app/admin/page.tsx",
        pathPattern: "/admin",
      }),
    ];
    const model = await buildAuthModel(tmp, routes);
    expect(model).toHaveLength(2);
    expect(model[0]!.route.pathPattern).toBe("/");
    expect(model[0]!.authentication).toBeNull();
    expect(model[1]!.route.pathPattern).toBe("/admin");
    expect(model[1]!.authentication?.identifier).toBe("getServerSession");
  });
});
