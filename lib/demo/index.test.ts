// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  clearUnlockToken,
  daysUntilLockout,
  isDemoExpired,
  isUnlocked,
  lockoutEndOfDay,
  PASSWORD_SHA256,
  readUnlockToken,
  shouldShowLock,
  UNLOCK_TOKEN_STORAGE_KEY,
  verifyPassword,
  writeUnlockToken,
} from "./index";

// jsdom doesn't ship Web Crypto subtle. Stub with Node's. Done once before
// any test runs; constant-time + correctness are what we care about, not
// the API surface.
beforeAll(async () => {
  if (!globalThis.crypto || !globalThis.crypto.subtle) {
    const { webcrypto } = await import("node:crypto");
    Object.defineProperty(globalThis, "crypto", {
      value: webcrypto,
      configurable: true,
    });
  }
});

afterEach(() => {
  clearUnlockToken();
});

describe("isDemoExpired", () => {
  it("returns false on the lockout day until end-of-day", () => {
    expect(isDemoExpired(new Date(2026, 4, 31, 12, 0, 0), "2026-05-31")).toBe(false);
    expect(isDemoExpired(new Date(2026, 4, 31, 23, 59, 59), "2026-05-31")).toBe(false);
  });

  it("returns true at midnight following the lockout day", () => {
    expect(isDemoExpired(new Date(2026, 5, 1, 0, 0, 0), "2026-05-31")).toBe(true);
  });

  it("returns true any time after the lockout day", () => {
    expect(isDemoExpired(new Date(2026, 6, 15, 9, 30, 0), "2026-05-31")).toBe(true);
  });

  it("returns false well before the lockout day", () => {
    expect(isDemoExpired(new Date(2026, 0, 15, 12, 0, 0), "2026-05-31")).toBe(false);
  });

  it("throws on a malformed lockout date", () => {
    expect(() => isDemoExpired(new Date(), "not-a-date")).toThrow();
  });
});

describe("lockoutEndOfDay", () => {
  it("returns 23:59:59.999 local on the configured date", () => {
    const d = lockoutEndOfDay("2026-05-31");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(4); // May, zero-indexed
    expect(d.getDate()).toBe(31);
    expect(d.getHours()).toBe(23);
    expect(d.getMinutes()).toBe(59);
    expect(d.getSeconds()).toBe(59);
  });
});

describe("daysUntilLockout", () => {
  it("counts days remaining when before the lockout", () => {
    expect(daysUntilLockout(new Date(2026, 4, 1, 0, 0, 0), "2026-05-31")).toBeGreaterThan(29);
  });

  it("returns 0 or negative on/after the lockout", () => {
    expect(daysUntilLockout(new Date(2026, 5, 1, 0, 0, 1), "2026-05-31")).toBeLessThanOrEqual(0);
  });
});

describe("verifyPassword", () => {
  it("accepts the known default password", async () => {
    expect(await verifyPassword("D4v1dJ0n3s")).toBe(true);
  });

  it("rejects the wrong password", async () => {
    expect(await verifyPassword("not-the-password")).toBe(false);
  });

  it("rejects the empty string fast", async () => {
    expect(await verifyPassword("")).toBe(false);
  });

  it("is case-sensitive", async () => {
    expect(await verifyPassword("d4v1dj0n3s")).toBe(false);
  });
});

describe("unlock token storage", () => {
  it("round-trips the token through localStorage", () => {
    expect(readUnlockToken()).toBeNull();
    writeUnlockToken(PASSWORD_SHA256);
    expect(readUnlockToken()).toBe(PASSWORD_SHA256);
    expect(window.localStorage.getItem(UNLOCK_TOKEN_STORAGE_KEY)).toBe(PASSWORD_SHA256);
  });

  it("isUnlocked is true after writing the matching hash", () => {
    expect(isUnlocked()).toBe(false);
    writeUnlockToken(PASSWORD_SHA256);
    expect(isUnlocked()).toBe(true);
  });

  it("isUnlocked is false after a clear", () => {
    writeUnlockToken(PASSWORD_SHA256);
    clearUnlockToken();
    expect(isUnlocked()).toBe(false);
  });

  it("isUnlocked rejects a stale token from a previous password", () => {
    writeUnlockToken("0".repeat(64));
    expect(isUnlocked()).toBe(false);
  });
});

describe("shouldShowLock", () => {
  it("is false before lockout regardless of unlock state", () => {
    expect(shouldShowLock(new Date(2026, 4, 1, 12, 0, 0))).toBe(false);
  });

  it("is true after lockout when locked", () => {
    expect(shouldShowLock(new Date(2026, 5, 15, 0, 0, 0))).toBe(true);
  });

  it("is false after lockout when unlocked", () => {
    writeUnlockToken(PASSWORD_SHA256);
    expect(shouldShowLock(new Date(2026, 5, 15, 0, 0, 0))).toBe(false);
  });
});
