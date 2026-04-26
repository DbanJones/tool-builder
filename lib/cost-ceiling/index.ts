// Optional user-set spend ceiling per build-order.md E4 + spec.md §6.
//
// Spec §6 explicitly says "No hard daily spend cap is enforced by the
// Builder (deferred to a later phase if required)" — so the default is
// "off". When the novice opts in by setting a cap on the dashboard, the
// evaluator returns "ok" / "warn" / "stop" thresholds the dashboard UI
// turns into a banner + a Start-button disable.
//
// "spent" is the lifetime total from costs.sumByProject. The build-order
// wording mentions "daily" but the spec doesn't define a day boundary;
// we treat the cap as a per-build cumulative cap. A rolled-by-day query
// can be added later if a real use case appears (drift D-018).

const WARN_PERCENT = 0.5;
const STOP_PERCENT = 1.0;

export type CostCeilingState = "off" | "ok" | "warn" | "stop";

export interface CostCeilingResult {
  /** Cap state. "off" when capUsdCents is null/undefined/<= 0. */
  state: CostCeilingState;
  /** spent / cap, in [0, +∞). 0 when cap is off; >1 when over. null when off. */
  percent: number | null;
  /** Convenience formatted message, suitable for an Alert banner. */
  message: string;
}

export function evaluate(
  spentUsdCents: number,
  capUsdCents: number | null | undefined,
): CostCeilingResult {
  if (capUsdCents === null || capUsdCents === undefined || capUsdCents <= 0) {
    return {
      state: "off",
      percent: null,
      message: "No spend cap set. Builder is unrestricted.",
    };
  }
  const safeSpent = Number.isFinite(spentUsdCents) && spentUsdCents > 0 ? spentUsdCents : 0;
  const percent = safeSpent / capUsdCents;
  if (percent >= STOP_PERCENT) {
    return {
      state: "stop",
      percent,
      message: `Spend cap reached: ${formatCents(safeSpent)} of ${formatCents(capUsdCents)}. Raise the cap to continue building.`,
    };
  }
  if (percent >= WARN_PERCENT) {
    return {
      state: "warn",
      percent,
      message: `Past 50% of your spend cap: ${formatCents(safeSpent)} of ${formatCents(capUsdCents)}.`,
    };
  }
  return {
    state: "ok",
    percent,
    message: `${formatCents(safeSpent)} of ${formatCents(capUsdCents)} (${Math.round(percent * 100)}%).`,
  };
}

function formatCents(cents: number): string {
  const dollars = cents / 100;
  return `$${dollars.toFixed(2)}`;
}

// localStorage helpers — kept here so the dashboard component stays thin
// and so the read/write contract is testable without DOM.

const STORAGE_PREFIX = "builder.costCap.";

export function readCapFromStorage(
  projectId: string,
  storage: Pick<Storage, "getItem"> = typeof window !== "undefined" ? window.localStorage : null!,
): number | null {
  if (!storage) return null;
  const raw = storage.getItem(STORAGE_PREFIX + projectId);
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function writeCapToStorage(
  projectId: string,
  capUsdCents: number | null,
  storage: Pick<Storage, "setItem" | "removeItem"> = typeof window !== "undefined"
    ? window.localStorage
    : null!,
): void {
  if (!storage) return;
  const key = STORAGE_PREFIX + projectId;
  if (capUsdCents === null || capUsdCents <= 0) {
    storage.removeItem(key);
    return;
  }
  storage.setItem(key, String(Math.round(capUsdCents)));
}
