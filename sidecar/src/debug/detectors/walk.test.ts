import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { walk } from "./walk.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "walk-test-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function touch(rel: string, content = ""): Promise<void> {
  const abs = path.join(tmp, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

async function collect(): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of walk(tmp)) out.push(entry.relativePath);
  return out.sort();
}

describe("walk", () => {
  it("yields files under the default include roots", async () => {
    await touch("app/page.tsx");
    await touch("lib/util.ts");
    await touch("components/foo.tsx");
    await touch("supabase/migrations/0001.sql");
    expect(await collect()).toEqual([
      "app/page.tsx",
      "components/foo.tsx",
      "lib/util.ts",
      "supabase/migrations/0001.sql",
    ]);
  });

  it("skips top-level files that are not under an include root", async () => {
    await touch("README.md");
    await touch("package.json");
    await touch("app/page.tsx");
    expect(await collect()).toEqual(["app/page.tsx"]);
  });

  it("excludes node_modules, .next, .git, out, dist, build, coverage", async () => {
    await touch("app/page.tsx");
    await touch("node_modules/foo/index.js");
    await touch(".next/cache.js");
    await touch(".git/HEAD");
    await touch("out/index.html");
    await touch("dist/bundle.js");
    await touch("build/out.js");
    await touch("coverage/report.html");
    expect(await collect()).toEqual(["app/page.tsx"]);
  });

  it("excludes nested node_modules anywhere in the tree", async () => {
    await touch("app/sub/node_modules/foo/index.js");
    await touch("app/sub/page.tsx");
    expect(await collect()).toEqual(["app/sub/page.tsx"]);
  });

  it("skips .test.* and .spec.* files by default", async () => {
    await touch("lib/util.ts");
    await touch("lib/util.test.ts");
    await touch("lib/util.spec.tsx");
    await touch("lib/util.test.mjs");
    expect(await collect()).toEqual(["lib/util.ts"]);
  });

  it("includes test files when excludeTestFiles is false", async () => {
    await touch("lib/util.ts");
    await touch("lib/util.test.ts");
    const out: string[] = [];
    for await (const entry of walk(tmp, { excludeTestFiles: false })) {
      out.push(entry.relativePath);
    }
    expect(out.sort()).toEqual(["lib/util.test.ts", "lib/util.ts"]);
  });

  it("yields POSIX-separated relative paths even on Windows-style traversal", async () => {
    await touch("app/sub/page.tsx");
    const entries: string[] = [];
    for await (const e of walk(tmp)) entries.push(e.relativePath);
    expect(entries).toEqual(["app/sub/page.tsx"]);
    expect(entries[0]).not.toContain("\\");
  });

  it("returns empty when no include root exists", async () => {
    await touch("README.md"); // outside any root
    expect(await collect()).toEqual([]);
  });

  it("respects custom includeRoots", async () => {
    await touch("app/page.tsx");
    await touch("custom/file.ts");
    const out: string[] = [];
    for await (const e of walk(tmp, { includeRoots: ["custom"] })) {
      out.push(e.relativePath);
    }
    expect(out).toEqual(["custom/file.ts"]);
  });

  it("returns absolute paths that resolve to real files", async () => {
    await touch("app/page.tsx", "hello");
    const entries: { absolutePath: string; relativePath: string }[] = [];
    for await (const e of walk(tmp)) entries.push(e);
    expect(entries).toHaveLength(1);
    const content = await fs.readFile(entries[0]!.absolutePath, "utf-8");
    expect(content).toBe("hello");
  });
});
