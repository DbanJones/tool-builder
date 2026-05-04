import { describe, it, expect } from "vitest";

import {
  extendShape,
  isShapeCommittable,
  startShape,
  type Shape,
} from "./index";

describe("startShape", () => {
  it("creates a zero-size box at the start point", () => {
    const s = startShape("box", { x: 10, y: 20 });
    expect(s).toEqual({ kind: "box", x: 10, y: 20, width: 0, height: 0 });
  });

  it("creates a degenerate arrow with from === to", () => {
    const s = startShape("arrow", { x: 5, y: 7 });
    expect(s).toEqual({ kind: "arrow", from: { x: 5, y: 7 }, to: { x: 5, y: 7 } });
  });

  it("creates a single-point freedraw stroke", () => {
    const s = startShape("freedraw", { x: 0, y: 0 });
    expect(s).toEqual({ kind: "freedraw", points: [{ x: 0, y: 0 }] });
  });

  it("returns null for the text tool (caller supplies content separately)", () => {
    expect(startShape("text", { x: 0, y: 0 })).toBeNull();
  });
});

describe("extendShape", () => {
  it("recomputes box width/height from the start point to the new point (supports negative drag)", () => {
    const start: Shape = { kind: "box", x: 100, y: 100, width: 0, height: 0 };
    const grown = extendShape(start, { x: 60, y: 80 });
    expect(grown).toEqual({ kind: "box", x: 100, y: 100, width: -40, height: -20 });
  });

  it("moves an arrow's tip without touching the tail", () => {
    const start: Shape = { kind: "arrow", from: { x: 0, y: 0 }, to: { x: 0, y: 0 } };
    const grown = extendShape(start, { x: 30, y: 40 });
    expect(grown).toEqual({ kind: "arrow", from: { x: 0, y: 0 }, to: { x: 30, y: 40 } });
  });

  it("appends a point to a freedraw stroke immutably", () => {
    const start: Shape = { kind: "freedraw", points: [{ x: 1, y: 1 }] };
    const extended = extendShape(start, { x: 2, y: 3 });
    expect(extended).toEqual({ kind: "freedraw", points: [{ x: 1, y: 1 }, { x: 2, y: 3 }] });
    // Original is untouched.
    expect((start as { points: unknown[] }).points).toHaveLength(1);
  });

  it("returns text shapes unchanged (text doesn't drag)", () => {
    const start: Shape = { kind: "text", x: 5, y: 5, content: "note" };
    expect(extendShape(start, { x: 100, y: 100 })).toBe(start);
  });
});

describe("isShapeCommittable", () => {
  it("rejects boxes smaller than 4x4 (a click without a drag)", () => {
    expect(isShapeCommittable({ kind: "box", x: 0, y: 0, width: 3, height: 10 })).toBe(false);
    expect(isShapeCommittable({ kind: "box", x: 0, y: 0, width: 10, height: 3 })).toBe(false);
    expect(isShapeCommittable({ kind: "box", x: 0, y: 0, width: 4, height: 4 })).toBe(true);
  });

  it("accepts boxes whose negative width still has >=4 magnitude", () => {
    expect(isShapeCommittable({ kind: "box", x: 100, y: 100, width: -50, height: -50 })).toBe(true);
  });

  it("rejects arrows shorter than 6 pixels", () => {
    expect(
      isShapeCommittable({ kind: "arrow", from: { x: 0, y: 0 }, to: { x: 4, y: 0 } }),
    ).toBe(false);
    expect(
      isShapeCommittable({ kind: "arrow", from: { x: 0, y: 0 }, to: { x: 6, y: 0 } }),
    ).toBe(true);
  });

  it("rejects freedraw with fewer than 2 points (a single click)", () => {
    expect(isShapeCommittable({ kind: "freedraw", points: [{ x: 0, y: 0 }] })).toBe(false);
    expect(
      isShapeCommittable({ kind: "freedraw", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }),
    ).toBe(true);
  });

  it("rejects empty / whitespace-only text", () => {
    expect(isShapeCommittable({ kind: "text", x: 0, y: 0, content: "" })).toBe(false);
    expect(isShapeCommittable({ kind: "text", x: 0, y: 0, content: "   " })).toBe(false);
    expect(isShapeCommittable({ kind: "text", x: 0, y: 0, content: "x" })).toBe(true);
  });
});
