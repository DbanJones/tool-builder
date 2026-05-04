import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  extractImports,
  hallucinatedImportScan,
  isExternalSpecifier,
  packageRoot,
} from "./hallucinated-import.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "halimp-test-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function touch(rel: string, content: string): Promise<void> {
  const abs = path.join(tmp, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

async function pkg(name: string): Promise<void> {
  // Minimal node_modules entry: just a package.json so the resolvable
  // check returns true. Subpath exports etc. are out of scope for v1.
  await touch(`node_modules/${name}/package.json`, JSON.stringify({ name }));
}

const CTX = (projectPath: string) => ({
  projectPath,
  scanId: "scan-1",
  startedAt: 0,
});

describe("extractImports", () => {
  it("captures single-line static imports", () => {
    const source = `import React from "react";\nimport { useEffect } from "react";`;
    const out = extractImports(source);
    expect(out.map((i) => i.specifier).sort()).toEqual(["react", "react"]);
    expect(out[0]!.line).toBe(1);
    expect(out[1]!.line).toBe(2);
  });

  it("captures multi-line imports", () => {
    const source = `import {\n  a,\n  b,\n} from "lodash-es";`;
    const out = extractImports(source);
    expect(out).toHaveLength(1);
    expect(out[0]!.specifier).toBe("lodash-es");
  });

  it("captures `import \"side-effect-only\"`", () => {
    const source = `import "polyfill";`;
    const out = extractImports(source);
    expect(out[0]!.specifier).toBe("polyfill");
  });

  it("captures dynamic imports", () => {
    const source = `const m = await import("dynamic-mod");`;
    const out = extractImports(source);
    expect(out[0]!.specifier).toBe("dynamic-mod");
  });

  it("captures require() calls", () => {
    const source = `const fs = require("node:fs");\nconst x = require("commonjs-pkg");`;
    const out = extractImports(source);
    expect(out.map((i) => i.specifier).sort()).toEqual(["commonjs-pkg", "node:fs"]);
  });

  it("captures `export * from`", () => {
    const source = `export * from "barrel-pkg";`;
    expect(extractImports(source)[0]!.specifier).toBe("barrel-pkg");
  });

  it("captures `export { x } from`", () => {
    const source = `export { x } from "named-pkg";`;
    expect(extractImports(source)[0]!.specifier).toBe("named-pkg");
  });

  it("returns empty for source with no imports", () => {
    expect(extractImports("const x = 1;\nfoo(x);")).toEqual([]);
  });
});

describe("isExternalSpecifier", () => {
  it("treats relative paths as non-external", () => {
    expect(isExternalSpecifier("./foo")).toBe(false);
    expect(isExternalSpecifier("../bar")).toBe(false);
  });

  it("treats absolute paths as non-external", () => {
    expect(isExternalSpecifier("/abs/path")).toBe(false);
  });

  it("treats node: prefixed builtins as non-external", () => {
    expect(isExternalSpecifier("node:fs")).toBe(false);
    expect(isExternalSpecifier("node:path")).toBe(false);
  });

  it("treats bare builtins (fs, path, ...) as non-external", () => {
    expect(isExternalSpecifier("fs")).toBe(false);
    expect(isExternalSpecifier("path")).toBe(false);
    expect(isExternalSpecifier("crypto")).toBe(false);
  });

  it("treats real npm specifiers as external", () => {
    expect(isExternalSpecifier("react")).toBe(true);
    expect(isExternalSpecifier("@scope/pkg")).toBe(true);
    expect(isExternalSpecifier("react/jsx-runtime")).toBe(true);
  });
});

describe("packageRoot", () => {
  it("returns bare names unchanged", () => {
    expect(packageRoot("react")).toBe("react");
  });

  it("strips subpaths from unscoped packages", () => {
    expect(packageRoot("react/jsx-runtime")).toBe("react");
  });

  it("preserves the @scope/pkg pair for scoped packages", () => {
    expect(packageRoot("@radix-ui/react-dialog")).toBe("@radix-ui/react-dialog");
  });

  it("strips subpaths from scoped packages", () => {
    expect(packageRoot("@radix-ui/react-dialog/dist/index.js")).toBe(
      "@radix-ui/react-dialog"
    );
  });
});

describe("hallucinatedImportScan", () => {
  it("flags an import for a package not in node_modules", async () => {
    await touch("app/page.tsx", `import { foo } from "totally-fake-pkg";`);
    const findings = await hallucinatedImportScan(CTX(tmp));
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.class).toBe("build");
    expect(f.ruleId).toBe("hallucinated-import");
    expect(f.severity).toBe(9);
    expect(f.confidence).toBeCloseTo(0.9, 5);
    expect(f.file).toBe("app/page.tsx");
    expect(f.codeEvidence).toContain("totally-fake-pkg");
  });

  it("does not flag a package that is installed", async () => {
    await pkg("react");
    await touch("app/page.tsx", `import React from "react";`);
    expect(await hallucinatedImportScan(CTX(tmp))).toEqual([]);
  });

  it("does not flag relative imports", async () => {
    await touch("app/page.tsx", `import { x } from "./local";`);
    expect(await hallucinatedImportScan(CTX(tmp))).toEqual([]);
  });

  it("does not flag Node builtins", async () => {
    await touch(
      "lib/util.ts",
      `import * as fs from "node:fs";\nimport * as path from "path";`
    );
    expect(await hallucinatedImportScan(CTX(tmp))).toEqual([]);
  });

  it("treats the package root, not the subpath, as the resolvable target", async () => {
    await pkg("react");
    await touch(
      "app/page.tsx",
      `import { jsx } from "react/jsx-runtime";`
    );
    expect(await hallucinatedImportScan(CTX(tmp))).toEqual([]);
  });

  it("flags a scoped hallucination", async () => {
    await touch("app/page.tsx", `import { x } from "@evil/not-real";`);
    const findings = await hallucinatedImportScan(CTX(tmp));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.codeEvidence).toContain("@evil/not-real");
  });

  it("aggregates findings across multiple files but caches the resolver", async () => {
    await touch("app/a.tsx", `import x from "ghost-pkg";`);
    await touch("app/b.tsx", `import y from "ghost-pkg";`);
    const findings = await hallucinatedImportScan(CTX(tmp));
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.file).sort()).toEqual(["app/a.tsx", "app/b.tsx"]);
  });

  it("is silent when there are no source files", async () => {
    expect(await hallucinatedImportScan(CTX(tmp))).toEqual([]);
  });

  it("reports the correct line number for multi-import files", async () => {
    await touch(
      "app/page.tsx",
      `import a from "real";\nimport b from "ghost";\nimport c from "real";`
    );
    await pkg("real");
    const findings = await hallucinatedImportScan(CTX(tmp));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.lineStart).toBe(2);
  });
});
