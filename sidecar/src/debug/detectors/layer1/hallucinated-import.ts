// Hallucinated-import detector. Walks the target's TS/JS sources, extracts
// every bare module specifier (excluding relative and Node builtins), and
// flags any that do not resolve to a directory under the target's
// node_modules. Per debug_repair_engine_spec.md §B.1.1 this is one of the
// highest-rate vibecoding defects (19.7% of LLM-generated packages
// hallucinate names per Spracklen et al. 2024) and a non-existent import
// is a hard build blocker.
//
// v1 limitations:
// - We use a regex rather than a real TS AST so we do not promote the
//   `typescript` package to a runtime dependency yet. G2b-2 needs the
//   AST and will move that dep up. False negatives at v1 are acceptable
//   per source spec §C.3.3 confidence model.
// - We check whether `${node_modules}/${pkg}/package.json` exists, which
//   is enough to flag the "the package literally is not installed" case.
//   Subpath exports edge cases (a real package whose declared exports
//   miss a subpath) are out of scope at v1.

import * as fs from "node:fs/promises";
import { builtinModules } from "node:module";
import * as path from "node:path";

import type { Detector, RawFinding, ScanContext } from "../types.js";
import { walk } from "../walk.js";

const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

// Single-line and multi-line import / export-from / require / dynamic
// import. Each pattern captures the module specifier in group 1.
const SPECIFIER_PATTERNS: readonly RegExp[] = [
  // `import [...] from "spec"` — handles multi-line via [\s\S]*?
  /\bimport\s+(?:[\s\S]*?from\s+)?['"]([^'"`\n]+)['"]/g,
  // `export {...} from "spec"` and `export * from "spec"`
  /\bexport\s+(?:\*|\{[\s\S]*?\})\s+from\s+['"]([^'"`\n]+)['"]/g,
  // `require("spec")` — CommonJS
  /\brequire\(\s*['"]([^'"`\n]+)['"]\s*\)/g,
  // `import("spec")` — dynamic
  /\bimport\(\s*['"]([^'"`\n]+)['"]\s*\)/g,
];

// node:foo and the bare names of every builtin (fs, path, …). We treat
// both spellings as builtin so we never flag them.
const BUILTIN = new Set<string>(builtinModules.flatMap((m) => [m, `node:${m}`]));

interface ExtractedImport {
  specifier: string;
  line: number;
}

export function extractImports(source: string): ExtractedImport[] {
  const out: ExtractedImport[] = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    for (const m of source.matchAll(pattern)) {
      const spec = m[1];
      if (!spec) continue;
      const line = lineOfIndex(source, m.index ?? 0);
      out.push({ specifier: spec, line });
    }
  }
  return out;
}

// A specifier is "external" if it does not start with `.` or `/` and is
// not a Node builtin. External specs need to resolve to node_modules.
export function isExternalSpecifier(spec: string): boolean {
  if (spec.startsWith(".") || spec.startsWith("/")) return false;
  if (BUILTIN.has(spec)) return false;
  if (spec.startsWith("node:")) return false;
  return true;
}

// `react` → `react`. `react/jsx-runtime` → `react`. `@scope/pkg` →
// `@scope/pkg`. `@scope/pkg/sub` → `@scope/pkg`. The package root is what
// has to exist under node_modules for the import to resolve at all.
export function packageRoot(spec: string): string {
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    if (parts.length < 2) return spec;
    return `${parts[0]}/${parts[1]}`;
  }
  const slash = spec.indexOf("/");
  return slash < 0 ? spec : spec.slice(0, slash);
}

async function resolvable(
  pkg: string,
  nodeModulesAbs: string,
  cache: Map<string, boolean>
): Promise<boolean> {
  const cached = cache.get(pkg);
  if (cached !== undefined) return cached;
  const pkgJsonPath = path.join(nodeModulesAbs, ...pkg.split("/"), "package.json");
  try {
    await fs.access(pkgJsonPath);
    cache.set(pkg, true);
    return true;
  } catch {
    cache.set(pkg, false);
    return false;
  }
}

export async function hallucinatedImportScan(
  ctx: ScanContext
): Promise<readonly RawFinding[]> {
  const nodeModulesAbs = path.join(ctx.projectPath, "node_modules");
  const cache = new Map<string, boolean>();
  const findings: RawFinding[] = [];

  for await (const entry of walk(ctx.projectPath)) {
    const ext = extOf(entry.relativePath);
    if (!SOURCE_EXTS.has(ext)) continue;

    let source: string;
    try {
      source = await fs.readFile(entry.absolutePath, "utf-8");
    } catch {
      continue;
    }

    for (const imp of extractImports(source)) {
      if (!isExternalSpecifier(imp.specifier)) continue;
      const pkg = packageRoot(imp.specifier);
      if (await resolvable(pkg, nodeModulesAbs, cache)) continue;
      findings.push({
        class: "build",
        ruleId: "hallucinated-import",
        severity: 9,
        blastRadius: 3,
        confidence: 0.9,
        difficulty: 1,
        file: entry.relativePath,
        lineStart: imp.line,
        lineEnd: imp.line,
        humanExplanation: humanExplanation(pkg, entry.relativePath),
        codeEvidence: `import from "${imp.specifier}"`,
      });
    }
  }
  return findings;
}

function humanExplanation(pkg: string, file: string): string {
  return (
    `The package "${pkg}" is imported in ${file} but is not installed. ` +
    `If you build the app it will fail with "Cannot find module". ` +
    `Either run pnpm install ${pkg}, or replace it with a real package — ` +
    `LLMs sometimes invent plausible-sounding package names that do not exist.`
  );
}

function extOf(relativePath: string): string {
  const dot = relativePath.lastIndexOf(".");
  return dot < 0 ? "" : relativePath.slice(dot).toLowerCase();
}

function lineOfIndex(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) line++;
  }
  return line;
}

export const hallucinatedImportDetector: Detector = {
  id: "hallucinated-import",
  run(ctx: ScanContext): Promise<readonly RawFinding[]> {
    return hallucinatedImportScan(ctx);
  },
};
