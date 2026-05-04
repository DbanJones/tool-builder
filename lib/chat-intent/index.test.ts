import { describe, it, expect } from "vitest";

import { ackForIntent, detectIntent, type IntentContext } from "./index";

const preBuild: IntentContext = {
  hasStarted: false,
  isRunning: false,
  hasReview: false,
  isReadyToBuild: false,
};
const readyToBuild: IntentContext = {
  hasStarted: false,
  isRunning: false,
  hasReview: false,
  isReadyToBuild: true,
};
const running: IntentContext = {
  hasStarted: true,
  isRunning: true,
  hasReview: false,
  isReadyToBuild: true,
};
const pausedAfterStart: IntentContext = {
  hasStarted: true,
  isRunning: false,
  hasReview: false,
  isReadyToBuild: true,
};
const builtIdle: IntentContext = {
  hasStarted: true,
  isRunning: false,
  hasReview: true,
  isReadyToBuild: true,
};

describe("detectIntent", () => {
  describe("stop (only while running)", () => {
    it.each(["stop", "stop it", "halt", "pause", "cancel", "abort"])(
      "matches %j",
      (msg) => {
        expect(detectIntent(msg, running)).toBe("stop");
      },
    );

    it("does not match before any build has run", () => {
      expect(detectIntent("stop", preBuild)).toBe("none");
    });

    it("does not match while idle post-build", () => {
      expect(detectIntent("stop", builtIdle)).toBe("none");
    });
  });

  describe("build (start fresh, when ready)", () => {
    it.each(["build", "build it", "go", "ship it", "begin", "start"])(
      "matches %j when ready to build",
      (msg) => {
        expect(detectIntent(msg, readyToBuild)).toBe("build");
      },
    );

    it("does not match before readiness gate is satisfied", () => {
      expect(detectIntent("build", preBuild)).toBe("none");
    });

    it("does not match while a build is already running (stop wins, build is muted)", () => {
      expect(detectIntent("build", running)).toBe("none");
    });
  });

  describe("build (resume)", () => {
    it.each(["resume", "continue", "carry on", "keep going"])(
      "matches %j when paused after a previous start",
      (msg) => {
        expect(detectIntent(msg, pausedAfterStart)).toBe("build");
      },
    );

    it("ack distinguishes resume from fresh build via context", () => {
      expect(ackForIntent("build", pausedAfterStart)).toMatch(/Resuming/);
      expect(ackForIntent("build", readyToBuild)).toMatch(/Kicking off/);
    });
  });

  describe("annotate (any time the build has started)", () => {
    it.each(["annotate", "feedback", "screenshot", "draw", "mark up"])(
      "matches %j once a build exists",
      (msg) => {
        expect(detectIntent(msg, builtIdle)).toBe("annotate");
        expect(detectIntent(msg, running)).toBe("annotate");
        expect(detectIntent(msg, pausedAfterStart)).toBe("annotate");
      },
    );

    it("does not match before any build", () => {
      expect(detectIntent("annotate", preBuild)).toBe("none");
    });
  });

  describe("launch / deploy / push (only after review.md exists)", () => {
    it.each([
      ["launch", "launch"],
      ["open the app", "launch"],
      ["preview", "launch"],
      ["deploy", "deploy"],
      ["publish", "deploy"],
      ["push", "push"],
      ["github", "push"],
      ["export", "push"],
    ])("matches %j → %s when review.md is present", (msg, expected) => {
      expect(detectIntent(msg, builtIdle)).toBe(expected);
    });

    it("does not match before the build has produced a review", () => {
      expect(detectIntent("launch", pausedAfterStart)).toBe("none");
      expect(detectIntent("deploy", pausedAfterStart)).toBe("none");
      expect(detectIntent("push", pausedAfterStart)).toBe("none");
    });

    it("does not match while a turn is running (avoid clobbering an in-flight build)", () => {
      expect(
        detectIntent("deploy", { ...builtIdle, isRunning: true }),
      ).toBe("none");
    });
  });

  describe("research (only between readiness and first build)", () => {
    it.each([
      "research",
      "research it",
      "deep research",
      "do research",
      "yes research",
      "research approach",
    ])("matches %j when ready and not started", (msg) => {
      expect(detectIntent(msg, readyToBuild)).toBe("research");
    });

    it("does not match before readiness", () => {
      expect(detectIntent("research", preBuild)).toBe("none");
    });

    it("does not match once the build has started", () => {
      expect(detectIntent("research", pausedAfterStart)).toBe("none");
      expect(detectIntent("deep research", builtIdle)).toBe("none");
    });

    it("does not match while a turn is streaming", () => {
      expect(detectIntent("research", running)).toBe("none");
    });
  });

  describe("set_model (always allowed)", () => {
    it.each(["use opus", "switch to opus", "opus please", "make it opus"])(
      "matches %j → set_model_opus",
      (msg) => {
        expect(detectIntent(msg, preBuild)).toBe("set_model_opus");
        expect(detectIntent(msg, running)).toBe("set_model_opus");
      },
    );
    it.each(["use sonnet", "sonnet please"])("matches %j → set_model_sonnet", (msg) => {
      expect(detectIntent(msg, preBuild)).toBe("set_model_sonnet");
    });
    it.each(["use haiku", "switch to haiku"])("matches %j → set_model_haiku", (msg) => {
      expect(detectIntent(msg, preBuild)).toBe("set_model_haiku");
    });
    it.each(["default model", "reset model", "use defaults"])(
      "matches %j → set_model_default",
      (msg) => {
        expect(detectIntent(msg, preBuild)).toBe("set_model_default");
      },
    );
  });

  describe("plan (tab switch, always allowed)", () => {
    it.each(["plan", "show plan", "what's the plan"])("matches %j in any state", (msg) => {
      expect(detectIntent(msg, preBuild)).toBe("plan");
      expect(detectIntent(msg, running)).toBe("plan");
      expect(detectIntent(msg, builtIdle)).toBe("plan");
    });
  });

  describe("none (fallthrough)", () => {
    it("returns none for empty / whitespace input", () => {
      expect(detectIntent("", preBuild)).toBe("none");
      expect(detectIntent("   ", preBuild)).toBe("none");
    });

    it("returns none for messages over the length cap", () => {
      const long = "stop the build please because I need to think more about this thing";
      expect(detectIntent(long, running)).toBe("none");
    });

    it("returns none for arbitrary chat content", () => {
      expect(detectIntent("hello", preBuild)).toBe("none");
      expect(detectIntent("can you tell me about X", preBuild)).toBe("none");
      expect(detectIntent("the menu bar should be at the top", builtIdle)).toBe("none");
    });
  });
});

describe("ackForIntent", () => {
  it("returns a non-empty acknowledgement for every active intent", () => {
    const intents = [
      "stop",
      "build",
      "research",
      "launch",
      "deploy",
      "push",
      "plan",
      "annotate",
      "set_model_opus",
      "set_model_sonnet",
      "set_model_haiku",
      "set_model_default",
    ] as const;
    for (const i of intents) {
      expect(ackForIntent(i, readyToBuild).length).toBeGreaterThan(0);
    }
  });

  it("returns empty string for the none intent", () => {
    expect(ackForIntent("none")).toBe("");
  });
});
