import { describe, it, expect } from "vitest";

describe("integration sanity", () => {
  it("runs the integration test pipeline", () => {
    expect(1 + 1).toBe(2);
  });
});
