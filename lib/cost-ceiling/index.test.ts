import { describe, expect, it } from "vitest";

import { evaluate, readCapFromStorage, writeCapToStorage } from "./index";

describe("evaluate", () => {
  it("returns 'off' when capUsdCents is null", () => {
    const r = evaluate(1000, null);
    expect(r.state).toBe("off");
    expect(r.percent).toBeNull();
  });

  it("returns 'off' when capUsdCents is undefined", () => {
    const r = evaluate(1000, undefined);
    expect(r.state).toBe("off");
  });

  it("returns 'off' when capUsdCents is zero or negative", () => {
    expect(evaluate(1000, 0).state).toBe("off");
    expect(evaluate(1000, -50).state).toBe("off");
  });

  it("returns 'ok' when spent is below 50% of cap", () => {
    const r = evaluate(2000, 5000);
    expect(r.state).toBe("ok");
    expect(r.percent).toBeCloseTo(0.4, 5);
  });

  it("returns 'warn' when spent is at exactly 50% of cap", () => {
    const r = evaluate(2500, 5000);
    expect(r.state).toBe("warn");
    expect(r.percent).toBeCloseTo(0.5, 5);
  });

  it("returns 'warn' when spent is between 50% and 100%", () => {
    const r = evaluate(4000, 5000);
    expect(r.state).toBe("warn");
    expect(r.percent).toBeCloseTo(0.8, 5);
  });

  it("returns 'stop' when spent is at exactly 100% of cap", () => {
    const r = evaluate(5000, 5000);
    expect(r.state).toBe("stop");
    expect(r.percent).toBe(1);
  });

  it("returns 'stop' when spent has exceeded the cap", () => {
    const r = evaluate(7500, 5000);
    expect(r.state).toBe("stop");
    expect(r.percent).toBeCloseTo(1.5, 5);
  });

  it("treats negative or NaN spent as zero", () => {
    expect(evaluate(-100, 5000).state).toBe("ok");
    expect(evaluate(NaN, 5000).state).toBe("ok");
  });

  it("formats the message with dollar amounts in the 'ok' / 'warn' / 'stop' branches", () => {
    expect(evaluate(2000, 5000).message).toContain("$20.00");
    expect(evaluate(2000, 5000).message).toContain("$50.00");
    expect(evaluate(4000, 5000).message).toContain("Past 50%");
    expect(evaluate(5000, 5000).message).toContain("Spend cap reached");
  });
});

describe("readCapFromStorage / writeCapToStorage", () => {
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

  it("reads a previously written cap", () => {
    const s = fakeStorage();
    writeCapToStorage("01PROJ", 5000, s);
    expect(readCapFromStorage("01PROJ", s)).toBe(5000);
  });

  it("returns null when no entry exists", () => {
    const s = fakeStorage();
    expect(readCapFromStorage("01PROJ", s)).toBeNull();
  });

  it("returns null on a malformed stored value", () => {
    const s = fakeStorage({ "builder.costCap.01PROJ": "not a number" });
    expect(readCapFromStorage("01PROJ", s)).toBeNull();
  });

  it("removes the entry when the cap is written as null", () => {
    const s = fakeStorage();
    writeCapToStorage("01PROJ", 5000, s);
    expect(readCapFromStorage("01PROJ", s)).toBe(5000);
    writeCapToStorage("01PROJ", null, s);
    expect(readCapFromStorage("01PROJ", s)).toBeNull();
  });

  it("removes the entry when the cap is written as zero or negative", () => {
    const s = fakeStorage();
    writeCapToStorage("01PROJ", 5000, s);
    writeCapToStorage("01PROJ", 0, s);
    expect(readCapFromStorage("01PROJ", s)).toBeNull();
  });

  it("scopes the entry by project id (writes to one don't bleed into another)", () => {
    const s = fakeStorage();
    writeCapToStorage("01A", 1000, s);
    writeCapToStorage("01B", 2000, s);
    expect(readCapFromStorage("01A", s)).toBe(1000);
    expect(readCapFromStorage("01B", s)).toBe(2000);
  });
});
