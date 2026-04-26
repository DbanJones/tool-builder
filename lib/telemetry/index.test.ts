import { describe, expect, it } from "vitest";

import {
  getSentryDecision,
  hasMadeSentryDecision,
  reportError,
  setSentryDecision,
} from "./index";

const fakeStorage = (initial: Record<string, string> = {}): Storage => {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    length: 0,
    clear: () => map.clear(),
    key: () => null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  };
};

describe("getSentryDecision / setSentryDecision", () => {
  it("returns null when no decision recorded", () => {
    const s = fakeStorage();
    expect(getSentryDecision(s)).toBeNull();
  });

  it("round-trips 'accepted'", () => {
    const s = fakeStorage();
    setSentryDecision("accepted", s);
    expect(getSentryDecision(s)).toBe("accepted");
  });

  it("round-trips 'declined'", () => {
    const s = fakeStorage();
    setSentryDecision("declined", s);
    expect(getSentryDecision(s)).toBe("declined");
  });

  it("round-trips 'deferred'", () => {
    const s = fakeStorage();
    setSentryDecision("deferred", s);
    expect(getSentryDecision(s)).toBe("deferred");
  });

  it("returns null when the stored value is malformed", () => {
    const s = fakeStorage({ "builder.sentryDecision": "yolo" });
    expect(getSentryDecision(s)).toBeNull();
  });
});

describe("hasMadeSentryDecision", () => {
  it("is false when no decision recorded", () => {
    expect(hasMadeSentryDecision(fakeStorage())).toBe(false);
  });

  it("is true after any of the three decision values is recorded", () => {
    const a = fakeStorage();
    setSentryDecision("accepted", a);
    expect(hasMadeSentryDecision(a)).toBe(true);

    const d = fakeStorage();
    setSentryDecision("declined", d);
    expect(hasMadeSentryDecision(d)).toBe(true);

    const f = fakeStorage();
    setSentryDecision("deferred", f);
    expect(hasMadeSentryDecision(f)).toBe(true);
  });
});

describe("reportError", () => {
  it("is a no-op when no decision is recorded (privacy default)", () => {
    const s = fakeStorage();
    expect(() => reportError(new Error("boom"), s)).not.toThrow();
  });

  it("is a no-op when decision is 'declined'", () => {
    const s = fakeStorage();
    setSentryDecision("declined", s);
    expect(() => reportError(new Error("boom"), s)).not.toThrow();
  });

  it("is a no-op when decision is 'deferred'", () => {
    const s = fakeStorage();
    setSentryDecision("deferred", s);
    expect(() => reportError(new Error("boom"), s)).not.toThrow();
  });

  it("does not throw when decision is 'accepted' (SDK call site is a no-op until D-019 closes)", () => {
    const s = fakeStorage();
    setSentryDecision("accepted", s);
    expect(() => reportError(new Error("boom"), s)).not.toThrow();
  });

  it("never inspects the error payload itself (privacy: no PII enumeration before consent)", () => {
    // Pass an object whose property access would throw if read.
    const trap = new Proxy(
      {},
      {
        get() {
          throw new Error("error payload was accessed before consent check");
        },
      },
    );
    const s = fakeStorage();
    expect(() => reportError(trap, s)).not.toThrow();
  });

  it("supports a no-DOM environment (storage param is null/undefined)", () => {
    // The default `storage` arg resolves to null when window is undefined.
    // The shim must fail closed: getSentryDecision returns null → reportError
    // returns without inspecting the error payload.
    const cast = null as unknown as Storage;
    expect(() => reportError(new Error("boom"), cast)).not.toThrow();
    expect(getSentryDecision(cast)).toBeNull();
    expect(hasMadeSentryDecision(cast)).toBe(false);
  });
});
