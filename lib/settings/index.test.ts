/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  STAGE_CATALOGUE,
  readSettings,
  resetAll,
  resetStage,
  resolveModel,
  writeSettings,
} from "./index";

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  window.localStorage.clear();
});

describe("settings storage", () => {
  it("returns empty settings when localStorage is empty", () => {
    expect(readSettings()).toEqual({});
  });

  it("returns empty settings on malformed payload", () => {
    window.localStorage.setItem("dave-builder.settings.v1", "not json");
    expect(readSettings()).toEqual({});
  });

  it("returns empty settings when payload fails the schema", () => {
    window.localStorage.setItem(
      "dave-builder.settings.v1",
      JSON.stringify({ models: { build: "made-up-model" } }),
    );
    expect(readSettings()).toEqual({});
  });

  it("round-trips a valid settings blob", () => {
    writeSettings({ models: { build: "claude-opus-4-7" } });
    expect(readSettings()).toEqual({ models: { build: "claude-opus-4-7" } });
  });
});

describe("resolveModel", () => {
  it("returns the catalogue default when no override is set", () => {
    for (const stage of STAGE_CATALOGUE) {
      expect(resolveModel(stage.id, {})).toBe(stage.default);
    }
  });

  it("returns the override when one is set", () => {
    expect(
      resolveModel("research", { models: { research: "claude-haiku-4-5" } }),
    ).toBe("claude-haiku-4-5");
  });
});

describe("resetStage / resetAll", () => {
  it("clears a single stage and leaves others alone", () => {
    writeSettings({
      models: {
        build: "claude-opus-4-7",
        research: "claude-haiku-4-5",
      },
    });
    resetStage("build");
    expect(readSettings()).toEqual({
      models: { research: "claude-haiku-4-5" },
    });
  });

  it("removes the empty models object when the last override is cleared", () => {
    writeSettings({ models: { build: "claude-opus-4-7" } });
    resetStage("build");
    expect(readSettings()).toEqual({});
  });

  it("resetAll clears everything", () => {
    writeSettings({
      models: {
        build: "claude-opus-4-7",
        research: "claude-haiku-4-5",
      },
    });
    resetAll();
    expect(readSettings()).toEqual({});
  });
});
