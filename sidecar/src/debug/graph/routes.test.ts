import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  inventoryRoutes,
  isDynamicPattern,
  kindFromBasename,
  methodsExported,
  pathPatternFor,
} from "./routes.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "routes-test-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function touch(rel: string, content = ""): Promise<void> {
  const abs = path.join(tmp, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

describe("pathPatternFor", () => {
  it("maps app/page.tsx to '/'", () => {
    expect(pathPatternFor("app/page.tsx")).toBe("/");
  });

  it("maps top-level pages", () => {
    expect(pathPatternFor("app/about/page.tsx")).toBe("/about");
    expect(pathPatternFor("app/blog/page.tsx")).toBe("/blog");
  });

  it("maps API routes including dynamic segments", () => {
    expect(pathPatternFor("app/api/users/route.ts")).toBe("/api/users");
    expect(pathPatternFor("app/api/users/[id]/route.ts")).toBe("/api/users/[id]");
  });

  it("preserves catch-all segments", () => {
    expect(pathPatternFor("app/blog/[...slug]/page.tsx")).toBe("/blog/[...slug]");
  });

  it("strips route groups (parens) from the URL", () => {
    expect(pathPatternFor("app/(marketing)/about/page.tsx")).toBe("/about");
    expect(pathPatternFor("app/(marketing)/page.tsx")).toBe("/");
    expect(pathPatternFor("app/foo/(group)/bar/page.tsx")).toBe("/foo/bar");
  });

  it("accepts layout files", () => {
    expect(pathPatternFor("app/layout.tsx")).toBe("/");
    expect(pathPatternFor("app/dashboard/layout.tsx")).toBe("/dashboard");
  });

  it("accepts every recognised extension", () => {
    expect(pathPatternFor("app/page.tsx")).toBe("/");
    expect(pathPatternFor("app/page.ts")).toBe("/");
    expect(pathPatternFor("app/page.jsx")).toBe("/");
    expect(pathPatternFor("app/page.js")).toBe("/");
  });

  it("returns null for non-route files inside app/", () => {
    expect(pathPatternFor("app/components/button.tsx")).toBeNull();
    expect(pathPatternFor("app/util.ts")).toBeNull();
    expect(pathPatternFor("app/api/users/[id]/handler.ts")).toBeNull();
  });

  it("returns null for files outside app/", () => {
    expect(pathPatternFor("pages/index.tsx")).toBeNull();
    expect(pathPatternFor("lib/util.ts")).toBeNull();
  });
});

describe("kindFromBasename", () => {
  it("classifies the three route file kinds", () => {
    expect(kindFromBasename("app/page.tsx")).toBe("page");
    expect(kindFromBasename("app/api/route.ts")).toBe("route");
    expect(kindFromBasename("app/layout.tsx")).toBe("layout");
  });

  it("returns null for other files", () => {
    expect(kindFromBasename("app/components/foo.tsx")).toBeNull();
  });
});

describe("isDynamicPattern", () => {
  it("flags simple and catch-all dynamic segments", () => {
    expect(isDynamicPattern("/users/[id]")).toBe(true);
    expect(isDynamicPattern("/blog/[...slug]")).toBe(true);
    expect(isDynamicPattern("/foo/[id]/bar")).toBe(true);
  });

  it("returns false for purely static patterns", () => {
    expect(isDynamicPattern("/")).toBe(false);
    expect(isDynamicPattern("/about")).toBe(false);
    expect(isDynamicPattern("/api/users")).toBe(false);
  });
});

describe("methodsExported", () => {
  it("returns an empty list for page/layout kinds", () => {
    expect(methodsExported(`export default function Page() {}`, "page")).toEqual([]);
    expect(methodsExported(`export default function Layout() {}`, "layout")).toEqual([]);
  });

  it("captures named-function exports", () => {
    const source = `export async function GET(req: Request) { return new Response(); }
                    export async function POST(req: Request) { return new Response(); }`;
    expect(methodsExported(source, "route")).toEqual(["GET", "POST"]);
  });

  it("captures arrow-function const exports", () => {
    const source = `export const GET = async (req: Request) => new Response();
                    export const DELETE = async (req: Request) => new Response();`;
    expect(methodsExported(source, "route")).toEqual(["GET", "DELETE"]);
  });

  it("captures every HTTP method", () => {
    const source = `
      export async function GET() {}
      export async function POST() {}
      export async function PUT() {}
      export async function PATCH() {}
      export async function DELETE() {}
      export async function HEAD() {}
      export async function OPTIONS() {}
    `;
    expect(methodsExported(source, "route")).toEqual([
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "HEAD",
      "OPTIONS",
    ]);
  });

  it("ignores non-HTTP-method exports", () => {
    const source = `
      export async function GET() {}
      export const helper = () => {};
      export async function notAMethod() {}
    `;
    expect(methodsExported(source, "route")).toEqual(["GET"]);
  });

  it("ignores non-exported declarations even if named GET", () => {
    const source = `async function GET() {}\nexport async function POST() {}`;
    expect(methodsExported(source, "route")).toEqual(["POST"]);
  });

  it("dedupes duplicate exports (defensive)", () => {
    // TS would reject this at compile time but we should not crash.
    const source = `export async function GET() {}\nexport const GET = async () => {};`;
    const result = methodsExported(source, "route");
    expect(result).toEqual(["GET"]);
  });
});

describe("inventoryRoutes (e2e against tmp dir)", () => {
  it("returns an empty list for a project with no app/ directory", async () => {
    expect(await inventoryRoutes(tmp)).toEqual([]);
  });

  it("inventories pages, routes, and layouts with the right metadata", async () => {
    await touch("app/page.tsx", `export default function Page() { return null; }`);
    await touch("app/layout.tsx", `export default function Layout() { return null; }`);
    await touch("app/about/page.tsx", `export default function About() { return null; }`);
    await touch(
      "app/api/users/[id]/route.ts",
      `export async function GET() { return new Response(); }
       export async function DELETE() { return new Response(); }`
    );
    const inv = await inventoryRoutes(tmp);
    const byPath = new Map(inv.map((r) => [r.filePath, r]));

    expect(byPath.get("app/page.tsx")).toMatchObject({
      kind: "page",
      pathPattern: "/",
      methods: [],
      isDynamic: false,
      hasMiddleware: false,
    });
    expect(byPath.get("app/layout.tsx")).toMatchObject({
      kind: "layout",
      pathPattern: "/",
    });
    expect(byPath.get("app/about/page.tsx")).toMatchObject({
      kind: "page",
      pathPattern: "/about",
    });
    expect(byPath.get("app/api/users/[id]/route.ts")).toMatchObject({
      kind: "route",
      pathPattern: "/api/users/[id]",
      methods: ["GET", "DELETE"],
      isDynamic: true,
    });
  });

  it("flags hasMiddleware: true when middleware.ts exists at the project root", async () => {
    await touch("app/page.tsx", `export default function P() { return null; }`);
    await touch("middleware.ts", `export function middleware() {}`);
    const inv = await inventoryRoutes(tmp);
    expect(inv).toHaveLength(1);
    expect(inv[0]!.hasMiddleware).toBe(true);
  });

  it("flags hasMiddleware: true for middleware.js too", async () => {
    await touch("app/page.tsx", `export default function P() { return null; }`);
    await touch("middleware.js", `export function middleware() {}`);
    expect((await inventoryRoutes(tmp))[0]!.hasMiddleware).toBe(true);
  });

  it("ignores non-route files under app/", async () => {
    await touch("app/page.tsx", `export default function P() { return null; }`);
    await touch("app/components/button.tsx", `export const Button = () => null;`);
    await touch("app/util.ts", `export const x = 1;`);
    const inv = await inventoryRoutes(tmp);
    expect(inv.map((r) => r.filePath)).toEqual(["app/page.tsx"]);
  });

  it("strips route groups from the path but keeps the file location", async () => {
    await touch(
      "app/(marketing)/about/page.tsx",
      `export default function P() { return null; }`
    );
    const inv = await inventoryRoutes(tmp);
    expect(inv).toHaveLength(1);
    expect(inv[0]!.pathPattern).toBe("/about");
    expect(inv[0]!.filePath).toBe("app/(marketing)/about/page.tsx");
  });
});
