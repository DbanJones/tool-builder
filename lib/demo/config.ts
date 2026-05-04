// Demo-version lockout configuration.
//
// Trust model: this is a SOFT lock. Anyone with the source or the binary can
// bypass it by editing constants, replacing the hash, or rolling system clock
// back. The intent is to gate casual demo users on or after the lockout date,
// not to defeat a determined attacker. Pair with a server-side check if you
// ever need real enforcement.
//
// To change the password:
//   1. Run `corepack pnpm tsx scripts/hash-password.ts <new-password>`
//   2. Paste the printed hash into PASSWORD_SHA256 below.
//   3. Optionally bump LOCKOUT_DATE.
// The default password is shipped intentionally for the initial demo build —
// rotate before the real release.

/** Master switch. Set false on the production build to skip the lock entirely. */
export const DEMO_MODE = true;

/**
 * The literal date string the user said the demo should lock on. Lockout
 * triggers at the start of the day AFTER this date — so the demo is usable
 * through end-of-day on this date and locked from the following midnight.
 *
 * Format: YYYY-MM-DD (local time).
 */
export const LOCKOUT_DATE = "2026-05-31";

/**
 * SHA-256 hex digest of the admin / unlock password.
 *
 * Default password: "D4v1dJ0n3s"
 *
 * Replace this hash before shipping a real demo. The default exists so the
 * gate works out of the box; it's not a secret.
 */
export const PASSWORD_SHA256 =
  "e88b73ae1480331662b7b9978d6ba0a7c0c2286092c673640cec413bcdc980e1";

/**
 * localStorage key holding the unlock token (the same hash as PASSWORD_SHA256
 * once unlocked). Storing the hash means a stolen browser profile from a
 * locked machine can be replayed on another, but for a single-user desktop
 * app with an in-source hash anyway that's fine — it's a soft lock.
 */
export const UNLOCK_TOKEN_STORAGE_KEY = "dave-builder.demo.unlock";

/** Visible label everywhere in the UI when DEMO_MODE is true. */
export const DEMO_LABEL = "Demo";
