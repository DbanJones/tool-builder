import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clientSideAuthScan,
  findRoleChecks,
  hasServerSideHint,
} from "./client-side-auth.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "csa-test-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function touch(rel: string, content: string): Promise<void> {
  const abs = path.join(tmp, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

const CTX = (projectPath: string) => ({
  projectPath,
  scanId: "scan-1",
  startedAt: 0,
});

function parseTsx(source: string): ts.SourceFile {
  return ts.createSourceFile("f.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

describe("findRoleChecks", () => {
  it("captures `user.role` access", () => {
    const ast = parseTsx(
      `export default function P({ user }: any) { return user.role === "admin" ? <A /> : null; }`
    );
    const checks = findRoleChecks(ast);
    expect(checks.map((c) => c.name)).toEqual(["role"]);
  });

  it("captures `user.isAdmin` and `user.permissions`", () => {
    const ast = parseTsx(
      `export default function P({ user }: any) {
         if (user.isAdmin) return <X />;
         if (user.permissions.includes("read")) return <Y />;
         return null;
       }`
    );
    const names = findRoleChecks(ast).map((c) => c.name).sort();
    expect(names).toEqual(["isAdmin", "permissions"]);
  });

  it("captures nested role access (session.user.role)", () => {
    const ast = parseTsx(
      `export default function P({ session }: any) { return session.user.role === "admin" && <A />; }`
    );
    const checks = findRoleChecks(ast);
    expect(checks.some((c) => c.name === "role")).toBe(true);
  });

  it("ignores property accesses with non-role names", () => {
    const ast = parseTsx(
      `export default function P({ user }: any) { return <div>{user.name}, {user.email}</div>; }`
    );
    expect(findRoleChecks(ast)).toEqual([]);
  });
});

describe("hasServerSideHint", () => {
  it("detects getServerSession", () => {
    expect(hasServerSideHint(`import { getServerSession } from "next-auth";`)).toBe(true);
  });

  it("detects 'use server' directive", () => {
    expect(hasServerSideHint(`"use server";\nexport async function act() {}`)).toBe(true);
    expect(hasServerSideHint(`'use server';\nexport async function act() {}`)).toBe(true);
  });

  it("detects redirect() and notFound() calls", () => {
    expect(hasServerSideHint(`if (!user) redirect("/login");`)).toBe(true);
    expect(hasServerSideHint(`if (!post) notFound();`)).toBe(true);
  });

  it("detects fetch() calls", () => {
    expect(hasServerSideHint(`const r = await fetch("/api/foo");`)).toBe(true);
  });

  it("returns false on a file with none of the hints", () => {
    expect(hasServerSideHint(`return <div>Hello</div>;`)).toBe(false);
  });
});

describe("clientSideAuthScan — Enrichlead-class fixture", () => {
  it("flags a role-gated render with no server-side compensation as critical-shape", async () => {
    await touch(
      "app/admin/page.tsx",
      `"use client";
       export default function AdminPage({ user }: any) {
         return user.role === "admin" ? <div>secrets</div> : <div>nope</div>;
       }`
    );
    const findings = await clientSideAuthScan(CTX(tmp));
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.class).toBe("auth");
    expect(f.ruleId).toBe("client-side-auth/no-server-hint");
    expect(f.severity).toBe(9);
    expect(f.confidence).toBeCloseTo(0.7, 5);
    expect(f.file).toBe("app/admin/page.tsx");
    expect(f.codeEvidence).toContain("user.role");
  });

  it("downgrades when the file also references a server-side check", async () => {
    await touch(
      "app/admin/page.tsx",
      `import { getServerSession } from "next-auth";
       export default async function AdminPage() {
         const session: any = await getServerSession();
         return session.user.role === "admin" ? <div>ok</div> : null;
       }`
    );
    const findings = await clientSideAuthScan(CTX(tmp));
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.ruleId).toBe("client-side-auth/with-server-hint");
    expect(f.severity).toBe(6);
    expect(f.confidence).toBeCloseTo(0.4, 5);
  });

  it("ignores .ts files (only .tsx)", async () => {
    await touch(
      "lib/auth.ts",
      `export function isAdmin(user: any) { return user.role === "admin"; }`
    );
    expect(await clientSideAuthScan(CTX(tmp))).toEqual([]);
  });

  it("ignores .tsx files with no role checks", async () => {
    await touch(
      "app/page.tsx",
      `export default function Page() { return <div>hello</div>; }`
    );
    expect(await clientSideAuthScan(CTX(tmp))).toEqual([]);
  });

  it("de-duplicates findings on the same line", async () => {
    await touch(
      "app/page.tsx",
      `"use client";
       export default function P({ user }: any) {
         return user.role && user.role === "admin" ? <X /> : null;
       }`
    );
    const findings = await clientSideAuthScan(CTX(tmp));
    expect(findings).toHaveLength(1);
  });

  it("flags multiple distinct role-gates across different lines", async () => {
    await touch(
      "app/admin.tsx",
      `"use client";
       export default function P({ user }: any) {
         if (user.isAdmin) return <X />;
         if (user.permissions.includes("read")) return <Y />;
         return null;
       }`
    );
    const findings = await clientSideAuthScan(CTX(tmp));
    expect(findings.length).toBeGreaterThanOrEqual(2);
  });
});
