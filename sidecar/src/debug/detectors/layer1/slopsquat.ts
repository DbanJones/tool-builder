// Slopsquat detector. Per ADR-0007 follow-up #3 and source spec §B.1.3
// row 14: when an LLM hallucinates a package name, an attacker can
// register that name on npm before it ever appears in real code. The
// hallucinated-import detector catches the "package isn't installed"
// case; this one catches "package IS installed but looks like a
// recently-registered slopsquat".
//
// Heuristics per source spec:
//   - publish date < 60 days
//   - weekly downloads < 10k
//   - no repository / publisher metadata
//
// Each is a soft signal at v1; we score them additively so a package
// that trips two heuristics lands at higher confidence than one.
//
// v1 scope:
//   - Detector module with an injected HttpClient + in-memory cache;
//     production uses node:fetch, tests use a stub.
//   - NOT wired into DEFAULT_DETECTORS yet — needs real-world
//     telemetry first to size the false-positive rate. Callers can
//     opt in by including `slopsquatDetector` in the detector list
//     they pass to `debug.scan`.

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { Detector, RawFinding, ScanContext } from "../types.js";

export interface PackageInfo {
  /** Unix ms when the package was first published. */
  publishedAt: number;
  /** Weekly download count from the npm downloads API. */
  weeklyDownloads: number;
  /** Whether the package.json declares a `repository` field. */
  hasRepository: boolean;
}

export interface SlopsquatHttpClient {
  /** Returns null if the package is not on npm or the request failed. */
  fetchPackageInfo(name: string): Promise<PackageInfo | null>;
}

export const PUBLISH_AGE_THRESHOLD_DAYS = 60;
export const DOWNLOADS_THRESHOLD = 10_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SlopsquatCache {
  get(name: string): PackageInfo | null;
  set(name: string, info: PackageInfo): void;
}

/** Default cache: in-memory map with 24-hour TTL keyed by package name. */
export function memoryCache(now: () => number = Date.now): SlopsquatCache {
  const entries = new Map<string, { info: PackageInfo; cachedAt: number }>();
  const TTL = 24 * 60 * 60 * 1000;
  return {
    get(name) {
      const entry = entries.get(name);
      if (!entry) return null;
      if (now() - entry.cachedAt > TTL) {
        entries.delete(name);
        return null;
      }
      return entry.info;
    },
    set(name, info) {
      entries.set(name, { info, cachedAt: now() });
    },
  };
}

/** Production HttpClient using node:fetch against the npm registry. */
export const fetchHttpClient: SlopsquatHttpClient = {
  async fetchPackageInfo(name) {
    try {
      const [packumentRes, downloadsRes] = await Promise.all([
        fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`),
        fetch(
          `https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(name)}`
        ),
      ]);
      if (!packumentRes.ok) return null;
      const packument = (await packumentRes.json()) as {
        time?: Record<string, string>;
        repository?: unknown;
      };
      const created = packument.time?.created;
      if (typeof created !== "string") return null;
      const publishedAt = Date.parse(created);
      if (!Number.isFinite(publishedAt)) return null;

      let weeklyDownloads = 0;
      if (downloadsRes.ok) {
        const dl = (await downloadsRes.json()) as { downloads?: unknown };
        if (typeof dl.downloads === "number") weeklyDownloads = dl.downloads;
      }

      return {
        publishedAt,
        weeklyDownloads,
        hasRepository:
          packument.repository !== undefined && packument.repository !== null,
      };
    } catch {
      return null;
    }
  },
};

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface SlopsquatScore {
  packageName: string;
  reasons: string[];
  /** Number of heuristics tripped: 1, 2, or 3. */
  severity: 1 | 2 | 3;
  info: PackageInfo;
}

/**
 * Score a single package's PackageInfo against the three heuristics.
 * Returns null if no heuristic trips (not suspicious).
 */
export function scorePackage(
  name: string,
  info: PackageInfo,
  now: number
): SlopsquatScore | null {
  const reasons: string[] = [];
  if (now - info.publishedAt < PUBLISH_AGE_THRESHOLD_DAYS * DAY_MS) {
    reasons.push(
      `first published less than ${PUBLISH_AGE_THRESHOLD_DAYS} days ago`
    );
  }
  if (info.weeklyDownloads < DOWNLOADS_THRESHOLD) {
    reasons.push(
      `weekly downloads (${info.weeklyDownloads}) below the ${DOWNLOADS_THRESHOLD.toLocaleString()} threshold`
    );
  }
  if (!info.hasRepository) {
    reasons.push("no repository declared in the package's metadata");
  }
  if (reasons.length === 0) return null;
  return {
    packageName: name,
    reasons,
    severity: reasons.length as 1 | 2 | 3,
    info,
  };
}

export interface SlopsquatScanOptions {
  http: SlopsquatHttpClient;
  cache?: SlopsquatCache;
  now?: () => number;
}

export async function slopsquatScan(
  ctx: ScanContext,
  opts: SlopsquatScanOptions
): Promise<readonly RawFinding[]> {
  const cache = opts.cache ?? memoryCache(opts.now);
  const nowFn = opts.now ?? Date.now;

  const pkgPath = path.join(ctx.projectPath, "package.json");
  let pkgRaw: string;
  try {
    pkgRaw = await fs.readFile(pkgPath, "utf-8");
  } catch {
    return [];
  }
  let pkg: PackageJson;
  try {
    pkg = JSON.parse(pkgRaw) as PackageJson;
  } catch {
    return [];
  }
  const names = new Set<string>([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);

  const findings: RawFinding[] = [];
  const now = nowFn();
  for (const name of names) {
    let info = cache.get(name);
    if (info === null) {
      info = await opts.http.fetchPackageInfo(name);
      if (info === null) continue;
      cache.set(name, info);
    }
    const score = scorePackage(name, info, now);
    if (score === null) continue;
    findings.push(toFinding(score));
  }
  return findings;
}

function toFinding(score: SlopsquatScore): RawFinding {
  // Severity scales by reasons-tripped. All three tripped → severity 9
  // (almost certainly slopsquat). One tripped → severity 6 (suspicious;
  // user should verify before installing more).
  const severity = score.severity === 3 ? 9 : score.severity === 2 ? 8 : 6;
  const confidence =
    score.severity === 3 ? 0.85 : score.severity === 2 ? 0.7 : 0.5;
  return {
    class: "security",
    ruleId: `slopsquat/${score.severity === 3 ? "almost-certain" : score.severity === 2 ? "likely" : "suspicious"}`,
    severity,
    blastRadius: 3, // a malicious dep affects the whole installed tree
    confidence,
    difficulty: 1,
    file: "package.json",
    lineStart: 1,
    lineEnd: 1,
    humanExplanation:
      `The package "${score.packageName}" looks like a slopsquat candidate: ` +
      `${score.reasons.join("; ")}. ` +
      `If you didn't deliberately add this, remove it and verify whether ` +
      `the package you meant exists under a different name.`,
    codeEvidence: `"${score.packageName}": "..."`,
  };
}

/** Detector wrapper used by callers that include slopsquat in their list. */
export function makeSlopsquatDetector(opts: SlopsquatScanOptions): Detector {
  return {
    id: "slopsquat",
    run: (ctx) => slopsquatScan(ctx, opts),
  };
}
