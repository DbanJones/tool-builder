// Online ETA estimator per kit §14.5.3.
//
// Inputs are observed durations of completed work units (at v1, one per
// claude turn; D5 swaps to per-task-id observations once phase markers are
// wired). Outputs the central estimate (median), the upper end (P90), and
// a `mode` signalling how confident the estimate is + whether the live
// build has already exceeded its own P90 (the "honesty fallback" — when
// the estimator is wrong, say so loudly rather than keep predicting).
//
// Pure: no time, no I/O. The caller passes elapsedMs explicitly so this
// module is fully testable with a clock fixture.

const MIN_OBSERVATIONS_FOR_ESTIMATE = 3;

export type EtaMode =
  | "estimating" // not enough observations yet (n < MIN)
  | "normal" // we have a real central + P90; elapsed < P90
  | "past_p90"; // elapsed exceeds P90 — switch the UI to "more than expected"

export interface EtaResult {
  /** Central estimate of remaining work, in ms. null while `estimating`. */
  medianMs: number | null;
  /** Upper-bound estimate, in ms. null while `estimating`. */
  p90Ms: number | null;
  /** Number of observations folded into the estimate. */
  sampleSize: number;
  mode: EtaMode;
}

/**
 * Compute ETA from a list of past durations and the current elapsed time
 * for the in-progress unit. Linear-interpolation percentile per NIST.
 *
 * `currentElapsedMs` is the elapsed time of the IN-PROGRESS work unit,
 * counted toward the `past_p90` mode flip but not into the percentile
 * sample (otherwise an in-progress unit would skew its own estimate).
 */
export function estimate(
  pastDurationsMs: readonly number[],
  currentElapsedMs: number,
): EtaResult {
  const cleaned = pastDurationsMs.filter((d) => Number.isFinite(d) && d >= 0);
  const sampleSize = cleaned.length;

  if (sampleSize < MIN_OBSERVATIONS_FOR_ESTIMATE) {
    return { medianMs: null, p90Ms: null, sampleSize, mode: "estimating" };
  }

  const sorted = [...cleaned].sort((a, b) => a - b);
  const medianMs = percentile(sorted, 0.5);
  const p90Ms = percentile(sorted, 0.9);
  const mode: EtaMode = currentElapsedMs > p90Ms ? "past_p90" : "normal";

  return { medianMs, p90Ms, sampleSize, mode };
}

/**
 * Linear-interpolation percentile (NIST type 7, the default for numpy and
 * the kit's reference). Caller MUST pass `sortedAsc` already sorted; we
 * exploit that to avoid re-sorting per percentile call (estimate() asks
 * for two percentiles per call).
 */
function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0] ?? 0;
  const rank = (sortedAsc.length - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo] ?? 0;
  const loVal = sortedAsc[lo] ?? 0;
  const hiVal = sortedAsc[hi] ?? 0;
  return loVal + (hiVal - loVal) * (rank - lo);
}

/**
 * Format an ms duration as a short novice-readable string. Used by the
 * dashboard footer ("~2 min" / "~1 hr 12 min" / "less than a minute").
 */
export function formatEta(ms: number | null, mode: EtaMode): string {
  if (mode === "estimating") return "estimating…";
  if (ms === null) return "unknown";
  if (mode === "past_p90") return "more than expected";
  if (ms < 60_000) return "less than a minute";
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 60) return `~${totalMin} min`;
  const hr = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return min === 0 ? `~${hr} hr` : `~${hr} hr ${min} min`;
}
