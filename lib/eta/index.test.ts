import { describe, expect, it } from "vitest";

import { estimate, formatEta } from "./index";

describe("estimate", () => {
  it("returns 'estimating' mode + null estimates when n < 3", () => {
    expect(estimate([], 0)).toEqual({
      medianMs: null,
      p90Ms: null,
      sampleSize: 0,
      mode: "estimating",
    });
    expect(estimate([1000], 0).mode).toBe("estimating");
    expect(estimate([1000, 2000], 0).mode).toBe("estimating");
  });

  it("computes median + p90 once n >= 3", () => {
    const r = estimate([1000, 2000, 3000], 0);
    expect(r.mode).toBe("normal");
    expect(r.sampleSize).toBe(3);
    expect(r.medianMs).toBe(2000);
    expect(r.p90Ms).toBeCloseTo(2800, 0);
  });

  it("handles a 10-sample symmetric distribution correctly", () => {
    const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const r = estimate(samples, 0);
    // NIST type 7 percentile: rank = (n-1)*p
    // p=0.5 → rank=4.5 → interp(50, 60, 0.5) = 55
    // p=0.9 → rank=8.1 → interp(90, 100, 0.1) = 91
    expect(r.medianMs).toBe(55);
    expect(r.p90Ms).toBeCloseTo(91, 5);
  });

  it("flips to past_p90 when current elapsed exceeds the P90", () => {
    const samples = [1000, 2000, 3000, 4000, 5000];
    const r = estimate(samples, 10000);
    expect(r.mode).toBe("past_p90");
    expect(r.p90Ms).not.toBeNull();
  });

  it("does NOT flip to past_p90 when current elapsed is at or below P90", () => {
    const samples = [1000, 2000, 3000, 4000, 5000];
    const r = estimate(samples, 0);
    expect(r.mode).toBe("normal");
  });

  it("filters out NaN, Infinity, and negative durations", () => {
    const r = estimate([1000, NaN, 2000, Infinity, -500, 3000], 0);
    expect(r.sampleSize).toBe(3);
    expect(r.medianMs).toBe(2000);
  });

  it("treats the in-progress unit as not part of the percentile sample", () => {
    // Adding a long elapsed should NOT inflate the sample's P90.
    const a = estimate([1000, 2000, 3000], 0);
    const b = estimate([1000, 2000, 3000], 50000);
    expect(a.medianMs).toBe(b.medianMs);
    expect(a.p90Ms).toBe(b.p90Ms);
    // Only the mode differs.
    expect(b.mode).toBe("past_p90");
  });

  it("does not throw on an empty sample with non-zero elapsed (estimating wins)", () => {
    const r = estimate([], 100000);
    expect(r.mode).toBe("estimating");
    expect(r.medianMs).toBeNull();
  });
});

describe("formatEta", () => {
  it("returns 'estimating…' for the estimating mode regardless of ms", () => {
    expect(formatEta(null, "estimating")).toBe("estimating…");
    expect(formatEta(5000, "estimating")).toBe("estimating…");
  });

  it("returns 'more than expected' for past_p90, regardless of ms", () => {
    expect(formatEta(60000, "past_p90")).toBe("more than expected");
  });

  it("returns 'less than a minute' for sub-60s", () => {
    expect(formatEta(30_000, "normal")).toBe("less than a minute");
    expect(formatEta(59_999, "normal")).toBe("less than a minute");
  });

  it("returns minutes for sub-hour durations", () => {
    expect(formatEta(60_000, "normal")).toBe("~1 min");
    expect(formatEta(120_000, "normal")).toBe("~2 min");
    expect(formatEta(45 * 60_000, "normal")).toBe("~45 min");
  });

  it("returns hours + minutes for >1hr durations", () => {
    expect(formatEta(60 * 60_000, "normal")).toBe("~1 hr");
    expect(formatEta(72 * 60_000, "normal")).toBe("~1 hr 12 min");
    expect(formatEta(2 * 60 * 60_000, "normal")).toBe("~2 hr");
  });

  it("returns 'unknown' when ms is null in non-estimating modes", () => {
    expect(formatEta(null, "normal")).toBe("unknown");
  });
});
