// Shared file-tree walker for Layer 1 detectors. All six Layer 1 detectors
// in `detectors/layer1/` traverse the same file set, so this exists once
// and yields lazily — each detector consumes the stream and reads the
// files it needs.
//
// Glob-free by design: a curated include-roots list plus a basename
// exclude set is enough for the kit's stack (Next.js 15 + Supabase). We
// do not need full glob semantics; the v1 false-positive cost from a
// missed exotic layout is one scan that returns no findings, which the
// Layer 2 validator (G4) cannot make worse.

import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface WalkEntry {
  /** Path relative to `projectPath`, POSIX separators. */
  relativePath: string;
  absolutePath: string;
}

export interface WalkOptions {
  /**
   * Top-level directory names to descend into. Default covers Next.js +
   * supabase + common src layouts. A target may have only a subset; the
   * walker silently skips ones that don't exist.
   */
  includeRoots?: readonly string[];
  /** Basenames to exclude wherever they appear in the tree. */
  excludeBasenames?: readonly string[];
  /**
   * Skip files whose basename matches the test/spec convention. Detectors
   * never need to scan their own tests; defaults to true.
   */
  excludeTestFiles?: boolean;
}

const DEFAULT_INCLUDE_ROOTS = [
  "app",
  "pages",
  "components",
  "lib",
  "src",
  "supabase",
] as const;

const DEFAULT_EXCLUDES = [
  "node_modules",
  ".next",
  ".git",
  "out",
  "dist",
  "build",
  "coverage",
  ".turbo",
] as const;

const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/**
 * Walk the target-app folder lazily. Yields one entry per file under the
 * configured roots, sorted by directory depth (parent before child).
 */
export async function* walk(
  projectPath: string,
  opts: WalkOptions = {}
): AsyncGenerator<WalkEntry> {
  const includeRoots = opts.includeRoots ?? DEFAULT_INCLUDE_ROOTS;
  const excludes = new Set<string>(opts.excludeBasenames ?? DEFAULT_EXCLUDES);
  const skipTests = opts.excludeTestFiles ?? true;

  for (const root of includeRoots) {
    const rootAbs = path.join(projectPath, root);
    if (!(await exists(rootAbs))) continue;
    yield* walkDir(rootAbs, projectPath, excludes, skipTests);
  }
}

async function* walkDir(
  dirAbs: string,
  projectPath: string,
  excludes: ReadonlySet<string>,
  skipTests: boolean
): AsyncGenerator<WalkEntry> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dirAbs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (excludes.has(entry.name)) continue;
    const childAbs = path.join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      yield* walkDir(childAbs, projectPath, excludes, skipTests);
    } else if (entry.isFile()) {
      if (skipTests && TEST_FILE_RE.test(entry.name)) continue;
      const rel = path.relative(projectPath, childAbs).split(path.sep).join("/");
      yield { relativePath: rel, absolutePath: childAbs };
    }
  }
}

async function exists(absPath: string): Promise<boolean> {
  try {
    await fs.access(absPath);
    return true;
  } catch {
    return false;
  }
}
