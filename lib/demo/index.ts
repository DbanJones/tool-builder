// Pure helpers for the demo-version lockout. UI consumes these via
// app/components/demo-guard.tsx and the /admin page. No side effects beyond
// the localStorage helpers, which are guarded so SSR / Node tests don't
// trip on a missing window.

import {
  DEMO_MODE,
  LOCKOUT_DATE,
  PASSWORD_SHA256,
  UNLOCK_TOKEN_STORAGE_KEY,
} from "./config";

export {
  DEMO_LABEL,
  DEMO_MODE,
  LOCKOUT_DATE,
  PASSWORD_SHA256,
  UNLOCK_TOKEN_STORAGE_KEY,
} from "./config";

/**
 * Returns true when the given moment is past the configured lockout date
 * (i.e. the demo should be inaccessible). The lockout date itself is
 * usable through end-of-day local time; lockout fires at midnight on the
 * following day.
 *
 * Pure — accepts a Date so tests don't depend on the wall clock.
 */
export function isDemoExpired(now: Date, lockoutDateIso: string = LOCKOUT_DATE): boolean {
  const cutoff = parseEndOfDayLocal(lockoutDateIso);
  return now.getTime() > cutoff.getTime();
}

/**
 * The end of the lockout day in local time. Used both for the comparison
 * above and for the "X days remaining" countdown the admin page shows.
 */
export function lockoutEndOfDay(lockoutDateIso: string = LOCKOUT_DATE): Date {
  return parseEndOfDayLocal(lockoutDateIso);
}

function parseEndOfDayLocal(iso: string): Date {
  const parts = iso.split("-");
  if (parts.length !== 3) {
    throw new Error(`LOCKOUT_DATE: expected YYYY-MM-DD, got ${iso}`);
  }
  const [yStr, mStr, dStr] = parts;
  const year = Number(yStr);
  const month = Number(mStr);
  const day = Number(dStr);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    throw new Error(`LOCKOUT_DATE: non-numeric component in ${iso}`);
  }
  // Local time so display countdowns match the user's wall clock. End of day:
  // 23:59:59.999.
  return new Date(year, month - 1, day, 23, 59, 59, 999);
}

/**
 * Days between now and the end-of-day lockout. Negative once expired.
 * Rounded up so partial days still show as "1 day left" until midnight.
 */
export function daysUntilLockout(now: Date, lockoutDateIso: string = LOCKOUT_DATE): number {
  const ms = parseEndOfDayLocal(lockoutDateIso).getTime() - now.getTime();
  if (ms <= 0) return Math.floor(ms / (1000 * 60 * 60 * 24));
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

/**
 * Hash a password input via the Web Crypto API (returns hex digest).
 *
 * Throws when crypto.subtle isn't available, which only happens outside a
 * secure context — Tauri webviews qualify, jsdom test environments don't, so
 * tests stub this with a deterministic shim.
 */
export async function sha256Hex(input: string): Promise<string> {
  const subtle =
    typeof globalThis !== "undefined" && globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) {
    throw new Error("Web Crypto unavailable; can't hash password.");
  }
  const data = new TextEncoder().encode(input);
  const digest = await subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Compare a password input against the configured hash. */
export async function verifyPassword(
  input: string,
  expectedHash: string = PASSWORD_SHA256,
): Promise<boolean> {
  if (input.length === 0) return false;
  const hash = await sha256Hex(input);
  return constantTimeEqualHex(hash, expectedHash);
}

/**
 * Constant-time hex compare. Both inputs are lowercased; mismatched lengths
 * fail fast (the lengths aren't secrets so leaking that timing is fine).
 */
function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ---- unlock token storage --------------------------------------------------

export type UnlockState = "locked" | "unlocked";

export function readUnlockToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(UNLOCK_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function writeUnlockToken(token: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(UNLOCK_TOKEN_STORAGE_KEY, token);
  } catch {
    // localStorage can throw in private mode; the lock then re-asserts on
    // next launch, which is the safe fallback.
  }
}

export function clearUnlockToken(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(UNLOCK_TOKEN_STORAGE_KEY);
  } catch {
    // ignore
  }
}

/**
 * The current unlock state, derived from the stored token. We compare to the
 * configured hash so a stale token from a previous build (with a different
 * password) doesn't grant access — rotating the password automatically
 * re-locks every machine.
 */
export function isUnlocked(expectedHash: string = PASSWORD_SHA256): boolean {
  const token = readUnlockToken();
  return token !== null && constantTimeEqualHex(token, expectedHash);
}

/**
 * High-level: should the lock screen be shown? Combines demo-mode flag,
 * date check, and unlock state. The admin page reuses the same predicate
 * so its "Lockout status" label matches what users see at the gate.
 */
export function shouldShowLock(now: Date): boolean {
  if (!DEMO_MODE) return false;
  if (isUnlocked()) return false;
  return isDemoExpired(now);
}
