import { describe, it, expect } from "vitest";

import { detectIntent, type IntentContext } from "./index";

const preBuild: IntentContext = { hasStarted: false, isRunning: false, hasReview: false };
const running: IntentContext = { hasStarted: true, isRunning: true, hasReview: false };
const builtIdle: IntentContext = { hasStarted: true, isRunning: false, hasReview: true };
const builtIdleNoReview: IntentContext = { hasStarted: true, isRunning: false, hasReview: false };

describe("detectIntent", () => {
  describe("build (pre-build idle)", () => {
    it.each(["build", "build it", "let's build", "lets build it", "go", "OK build", "Build It!", "  build it.  "])(
      "matches %j",
      (msg) => {
        expect(detectIntent(msg, preBuild)).toBe("build");
      },
    );

    it("does not match if the build has already started", () => {
      expect(detectIntent("build it", { ...preBuild, hasStarted: true })).toBe("none");
    });

    it("does not match if a turn is currently running", () => {
      expect(detectIntent("build it", { ...preBuild, isRunning: true })).toBe("none");
    });

    it("does not match a long message that happens to contain 'build'", () => {
      expect(
        detectIntent("I think we should build a CRM with feature X", preBuild),
      ).toBe("none");
    });
  });

  describe("stop (running)", () => {
    it.each(["stop", "stop it", "halt", "pause", "cancel", "abort"])("matches %j", (msg) => {
      expect(detectIntent(msg, running)).toBe("stop");
    });

    it("does not match when nothing is running", () => {
      expect(detectIntent("stop", preBuild)).toBe("none");
    });
  });

  describe("deploy (built + review + idle)", () => {
    it.each(["deploy", "deploy it", "publish", "ship it"])("matches %j", (msg) => {
      expect(detectIntent(msg, builtIdle)).toBe("deploy");
    });

    it("does not match before the review file exists", () => {
      expect(detectIntent("deploy", builtIdleNoReview)).toBe("none");
    });

    it("does not match while a turn is running", () => {
      expect(detectIntent("deploy", { ...builtIdle, isRunning: true })).toBe("none");
    });
  });

  describe("push (built + idle)", () => {
    it.each(["push", "push it", "push to github", "github"])("matches %j", (msg) => {
      expect(detectIntent(msg, builtIdleNoReview)).toBe("push");
    });

    it("does not match before any build has started", () => {
      expect(detectIntent("push it", preBuild)).toBe("none");
    });
  });

  describe("none (fallthrough)", () => {
    it("returns none for empty / whitespace input", () => {
      expect(detectIntent("", preBuild)).toBe("none");
      expect(detectIntent("   ", preBuild)).toBe("none");
    });

    it("returns none for messages over the length cap", () => {
      const long = "build the app with the feature that does X and Y and Z please";
      expect(detectIntent(long, preBuild)).toBe("none");
    });

    it("returns none for arbitrary chat content", () => {
      expect(detectIntent("hello", preBuild)).toBe("none");
      expect(detectIntent("can you tell me about X", preBuild)).toBe("none");
    });
  });
});
