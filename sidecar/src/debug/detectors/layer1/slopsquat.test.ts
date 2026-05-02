import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DOWNLOADS_THRESHOLD,
  PUBLISH_AGE_THRESHOLD_DAYS,
  makeSlopsquatDetector,
  memoryCache,
  scorePackage,
  slopsquatScan,
  type PackageInfo,
  type SlopsquatHttpClient,
} from "./slopsquat.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "slopsquat-test-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const NOW = 1_700_000_000_000; // arbitrary fixed clock

const dayMs = 24 * 60 * 60 * 1000;

const pkgInfo = (overrides: Partial<PackageInfo> = {}): PackageInfo => ({
  publishedAt: NOW - 365 * dayMs, // a year old by default → safe
  weeklyDownloads: 1_000_000,
  hasRepository: true,
  ...overrides,
});

const httpReturning = (
  responses: Record<string, PackageInfo | null>
): SlopsquatHttpClient => ({
  async fetchPackageInfo(name) {
    return responses[name] ?? null;
  },
});

async function writePkg(deps: Record<string, string>, dev = {}): Promise<void> {
  await fs.writeFile(
    path.join(tmp, "package.json"),
    JSON.stringify({ dependencies: deps, devDependencies: dev }),
    "utf-8"
  );
}

describe("scorePackage", () => {
  it("returns null when none of the heuristics trip", () => {
    expect(scorePackage("react", pkgInfo(), NOW)).toBeNull();
  });

  it("severity 1 when only the publish-date heuristic trips", () => {
    const result = scorePackage(
      "new-pkg",
      pkgInfo({ publishedAt: NOW - 30 * dayMs }),
      NOW
    );
    expect(result?.severity).toBe(1);
    expect(result?.reasons[0]).toMatch(/published less than/);
  });

  it("severity 2 when two heuristics trip", () => {
    const result = scorePackage(
      "new-low",
      pkgInfo({
        publishedAt: NOW - 30 * dayMs,
        weeklyDownloads: 100,
      }),
      NOW
    );
    expect(result?.severity).toBe(2);
  });

  it("severity 3 when all three trip", () => {
    const result = scorePackage(
      "new-low-norepo",
      pkgInfo({
        publishedAt: NOW - 5 * dayMs,
        weeklyDownloads: 50,
        hasRepository: false,
      }),
      NOW
    );
    expect(result?.severity).toBe(3);
    expect(result?.reasons).toHaveLength(3);
  });

  it("respects the PUBLISH_AGE_THRESHOLD_DAYS boundary", () => {
    // Just under threshold → trips.
    expect(
      scorePackage(
        "x",
        pkgInfo({ publishedAt: NOW - (PUBLISH_AGE_THRESHOLD_DAYS - 1) * dayMs }),
        NOW
      )?.severity
    ).toBe(1);
    // Exactly at threshold → does not trip.
    expect(
      scorePackage(
        "x",
        pkgInfo({ publishedAt: NOW - PUBLISH_AGE_THRESHOLD_DAYS * dayMs }),
        NOW
      )
    ).toBeNull();
  });

  it("respects the DOWNLOADS_THRESHOLD boundary", () => {
    expect(
      scorePackage("x", pkgInfo({ weeklyDownloads: DOWNLOADS_THRESHOLD - 1 }), NOW)
        ?.severity
    ).toBe(1);
    expect(
      scorePackage("x", pkgInfo({ weeklyDownloads: DOWNLOADS_THRESHOLD }), NOW)
    ).toBeNull();
  });
});

describe("memoryCache", () => {
  it("returns null on a miss and caches values within the TTL", () => {
    let now = NOW;
    const cache = memoryCache(() => now);
    expect(cache.get("react")).toBeNull();
    cache.set("react", pkgInfo());
    expect(cache.get("react")).not.toBeNull();
    // 23 hours later: still cached.
    now = NOW + 23 * 60 * 60 * 1000;
    expect(cache.get("react")).not.toBeNull();
  });

  it("expires entries after 24 hours", () => {
    let now = NOW;
    const cache = memoryCache(() => now);
    cache.set("react", pkgInfo());
    now = NOW + 25 * 60 * 60 * 1000;
    expect(cache.get("react")).toBeNull();
  });
});

describe("slopsquatScan (e2e)", () => {
  const ctx = {
    projectPath: "",
    scanId: "test",
    startedAt: 0,
  };

  it("returns no findings when package.json is missing", async () => {
    const findings = await slopsquatScan(
      { ...ctx, projectPath: tmp },
      { http: httpReturning({}), now: () => NOW }
    );
    expect(findings).toEqual([]);
  });

  it("returns no findings for packages with clean metadata", async () => {
    await writePkg({ react: "^18" });
    const findings = await slopsquatScan(
      { ...ctx, projectPath: tmp },
      {
        http: httpReturning({ react: pkgInfo() }),
        now: () => NOW,
      }
    );
    expect(findings).toEqual([]);
  });

  it("flags a freshly-published low-download package as suspicious", async () => {
    await writePkg({ "totally-new": "^0.0.1" });
    const findings = await slopsquatScan(
      { ...ctx, projectPath: tmp },
      {
        http: httpReturning({
          "totally-new": pkgInfo({
            publishedAt: NOW - 5 * dayMs,
            weeklyDownloads: 12,
            hasRepository: false,
          }),
        }),
        now: () => NOW,
      }
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.ruleId).toBe("slopsquat/almost-certain");
    expect(findings[0]!.class).toBe("security");
    expect(findings[0]!.humanExplanation).toContain("totally-new");
  });

  it("scans both dependencies and devDependencies", async () => {
    await writePkg({ a: "^1" }, { b: "^1" });
    const findings = await slopsquatScan(
      { ...ctx, projectPath: tmp },
      {
        http: httpReturning({
          a: pkgInfo({ publishedAt: NOW - 5 * dayMs }),
          b: pkgInfo({ publishedAt: NOW - 5 * dayMs }),
        }),
        now: () => NOW,
      }
    );
    expect(findings).toHaveLength(2);
  });

  it("skips packages the registry doesn't know about (returns null)", async () => {
    await writePkg({ unknown: "^1" });
    const findings = await slopsquatScan(
      { ...ctx, projectPath: tmp },
      { http: httpReturning({ unknown: null }), now: () => NOW }
    );
    expect(findings).toEqual([]);
  });

  it("uses the cache across multiple packages with the same name reference", async () => {
    await writePkg({ shared: "^1" });
    let calls = 0;
    const http: SlopsquatHttpClient = {
      async fetchPackageInfo(name) {
        calls++;
        return name === "shared"
          ? pkgInfo({ publishedAt: NOW - 5 * dayMs })
          : null;
      },
    };
    const cache = memoryCache(() => NOW);
    await slopsquatScan({ ...ctx, projectPath: tmp }, { http, cache, now: () => NOW });
    await slopsquatScan({ ...ctx, projectPath: tmp }, { http, cache, now: () => NOW });
    expect(calls).toBe(1);
  });

  it("returns no findings when package.json is malformed", async () => {
    await fs.writeFile(path.join(tmp, "package.json"), "not valid json", "utf-8");
    const findings = await slopsquatScan(
      { ...ctx, projectPath: tmp },
      { http: httpReturning({}), now: () => NOW }
    );
    expect(findings).toEqual([]);
  });
});

describe("makeSlopsquatDetector", () => {
  it("conforms to the Detector interface and runs against the project path", async () => {
    await writePkg({ totally: "^1" });
    const detector = makeSlopsquatDetector({
      http: httpReturning({
        totally: pkgInfo({ publishedAt: NOW - 5 * dayMs }),
      }),
      now: () => NOW,
    });
    expect(detector.id).toBe("slopsquat");
    const findings = await detector.run({
      projectPath: tmp,
      scanId: "test",
      startedAt: 0,
    });
    expect(findings).toHaveLength(1);
  });
});
