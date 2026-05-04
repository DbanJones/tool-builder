import { describe, expect, it } from "vitest";

import { BAND_RANGES, bandOf, CLASS_META } from "./taxonomy.js";

describe("bandOf", () => {
  it("returns 'critical' for score >= 20", () => {
    expect(bandOf(20)).toBe("critical");
    expect(bandOf(25.5)).toBe("critical");
    expect(bandOf(100)).toBe("critical");
  });

  it("returns 'high' for 10 <= score < 20", () => {
    expect(bandOf(10)).toBe("high");
    expect(bandOf(15)).toBe("high");
    expect(bandOf(19.99)).toBe("high");
  });

  it("returns 'medium' for 5 <= score < 10", () => {
    expect(bandOf(5)).toBe("medium");
    expect(bandOf(7)).toBe("medium");
    expect(bandOf(9.99)).toBe("medium");
  });

  it("returns 'low' for 1 <= score < 5", () => {
    expect(bandOf(1)).toBe("low");
    expect(bandOf(2.5)).toBe("low");
    expect(bandOf(4.99)).toBe("low");
  });

  it("returns 'info' for score < 1", () => {
    expect(bandOf(0)).toBe("info");
    expect(bandOf(0.475)).toBe("info");
    expect(bandOf(0.999)).toBe("info");
  });

  it("treats negative scores as 'info' (defensive)", () => {
    expect(bandOf(-5)).toBe("info");
  });
});

describe("CLASS_META", () => {
  it("defines metadata for all eight classes", () => {
    const classes = Object.keys(CLASS_META).sort();
    expect(classes).toEqual([
      "api",
      "auth",
      "build",
      "deploy",
      "maintain",
      "perf",
      "runtime",
      "security",
    ]);
  });

  it("ranks auth severity highest among defaults", () => {
    const max = Math.max(...Object.values(CLASS_META).map((m) => m.defaultSeverity));
    expect(CLASS_META.auth.defaultSeverity).toBe(max);
  });

  it("ranks maintain severity lowest among defaults", () => {
    const min = Math.min(...Object.values(CLASS_META).map((m) => m.defaultSeverity));
    expect(CLASS_META.maintain.defaultSeverity).toBe(min);
  });

  it("keeps every default severity inside the source spec's [1,10] range", () => {
    for (const meta of Object.values(CLASS_META)) {
      expect(meta.defaultSeverity).toBeGreaterThanOrEqual(1);
      expect(meta.defaultSeverity).toBeLessThanOrEqual(10);
    }
  });
});

describe("BAND_RANGES", () => {
  it("orders bands strictly: critical > high > medium > low > info", () => {
    expect(BAND_RANGES.critical.min).toBeGreaterThan(BAND_RANGES.high.min);
    expect(BAND_RANGES.high.min).toBeGreaterThan(BAND_RANGES.medium.min);
    expect(BAND_RANGES.medium.min).toBeGreaterThan(BAND_RANGES.low.min);
    expect(BAND_RANGES.low.min).toBeGreaterThan(BAND_RANGES.info.min);
  });
});
