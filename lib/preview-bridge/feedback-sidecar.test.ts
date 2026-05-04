import { describe, expect, it } from "vitest";

import type { Shape } from "@/lib/annotation";

import { buildFeedbackSidecar } from "./feedback-sidecar";
import type { BridgeEvent } from "./index";

const FIXED_NOW = 1714521600000; // 2024-05-01T00:00:00Z
const FIXED_ISO = "2024-05-01T00:00:00.000Z";

const someBoxMark: Shape = { kind: "box", x: 10, y: 20, width: 90, height: 60 };

function consoleEvent(level: "log" | "warn" | "error", arg: string, ts: number): BridgeEvent {
  return { kind: "console", level, args: [arg], ts };
}
function errorEvent(message: string, ts: number): BridgeEvent {
  return {
    kind: "error",
    message,
    filename: null,
    line: null,
    column: null,
    stack: null,
    ts,
  };
}

describe("buildFeedbackSidecar", () => {
  it("includes description, marks, and the iframe snapshot", () => {
    const sidecar = buildFeedbackSidecar({
      description: "the button is red",
      marks: [someBoxMark],
      imagePath: ".builder/feedback/fb-1.png",
      iframe: {
        url: "http://localhost:3000/",
        viewport: { w: 1024, h: 768 },
        scroll: { x: 0, y: 0 },
      },
      events: [],
      bridgeConnected: true,
      now: FIXED_NOW,
    });
    expect(sidecar.ts).toBe(FIXED_ISO);
    expect(sidecar.description).toBe("the button is red");
    expect(sidecar.marks).toEqual([someBoxMark]);
    expect(sidecar.imagePath).toBe(".builder/feedback/fb-1.png");
    expect(sidecar.iframe?.url).toBe("http://localhost:3000/");
    expect(sidecar.bridgeConnected).toBe(true);
  });

  it("partitions events into console vs errors", () => {
    const events: BridgeEvent[] = [
      consoleEvent("log", "chatty", 1),
      errorEvent("crash 1", 2),
      consoleEvent("error", "console-err", 3),
      { kind: "unhandledrejection", message: "reject 1", stack: null, ts: 4 },
    ];
    const sidecar = buildFeedbackSidecar({
      description: "",
      marks: [],
      imagePath: null,
      iframe: null,
      events,
      bridgeConnected: true,
      now: FIXED_NOW,
    });
    expect(sidecar.console.map((e) => (e.kind === "console" ? e.level : null))).toEqual([
      "log",
      "error",
    ]);
    expect(sidecar.errors).toHaveLength(2);
    expect(sidecar.errors[0]).toMatchObject({ kind: "error", message: "crash 1" });
    expect(sidecar.errors[1]).toMatchObject({ kind: "unhandledrejection", message: "reject 1" });
  });

  it("caps console at 50 and errors at 20", () => {
    const events: BridgeEvent[] = [];
    for (let i = 0; i < 80; i++) events.push(consoleEvent("log", String(i), i));
    for (let i = 0; i < 30; i++) events.push(errorEvent(`e${i}`, 100 + i));
    const sidecar = buildFeedbackSidecar({
      description: "",
      marks: [],
      imagePath: null,
      iframe: null,
      events,
      bridgeConnected: true,
      now: FIXED_NOW,
    });
    expect(sidecar.console).toHaveLength(50);
    expect(sidecar.errors).toHaveLength(20);
    // The most-recent ones survive (last 50 of 80 are 30..79; last 20 of 30 are 10..29).
    const firstConsole = sidecar.console[0];
    expect(firstConsole?.kind).toBe("console");
    if (firstConsole?.kind === "console") {
      expect(firstConsole.args[0]).toBe("30");
    }
  });

  it("encodes bridgeConnected=false when bridge never said hello", () => {
    const sidecar = buildFeedbackSidecar({
      description: "x",
      marks: [],
      imagePath: null,
      iframe: null,
      events: [],
      bridgeConnected: false,
      now: FIXED_NOW,
    });
    expect(sidecar.bridgeConnected).toBe(false);
    expect(sidecar.iframe).toBeNull();
    expect(sidecar.console).toEqual([]);
    expect(sidecar.errors).toEqual([]);
    expect(sidecar.network).toEqual([]);
    expect(sidecar.serverErrors).toEqual([]);
  });

  it("includes captureSource and resolvedElements when provided", () => {
    const sidecar = buildFeedbackSidecar({
      description: "the button is wrong",
      marks: [someBoxMark],
      imagePath: ".builder/feedback/fb-1.png",
      iframe: null,
      events: [],
      bridgeConnected: true,
      captureSource: "iframe",
      resolvedElements: [
        { tag: "button", id: "submit", classes: "cta", role: null, text: "Submit", outerHTML: "<button>Submit</button>" },
      ],
      now: FIXED_NOW,
    });
    expect(sidecar.captureSource).toBe("iframe");
    expect(sidecar.resolvedElements).toHaveLength(1);
    expect(sidecar.resolvedElements?.[0]).toMatchObject({ tag: "button", id: "submit" });
  });

  it("captureSource and resolvedElements default to null when omitted (back-compat)", () => {
    const sidecar = buildFeedbackSidecar({
      description: "x",
      marks: [],
      imagePath: null,
      iframe: null,
      events: [],
      bridgeConnected: false,
      now: FIXED_NOW,
    });
    expect(sidecar.captureSource).toBeNull();
    expect(sidecar.resolvedElements).toBeNull();
  });

  it("partitions network and server events into their own slices", () => {
    const events: BridgeEvent[] = [
      {
        kind: "network",
        method: "GET",
        url: "/api/x",
        status: 200,
        ok: true,
        durationMs: 5,
        responseSample: null,
        error: null,
        ts: 1,
      },
      {
        kind: "server",
        source: "stderr",
        severity: "error",
        message: "Cannot find module",
        ts: 2,
      },
      consoleEvent("log", "noise", 3),
    ];
    const sidecar = buildFeedbackSidecar({
      description: "",
      marks: [],
      imagePath: null,
      iframe: null,
      events,
      bridgeConnected: true,
      now: FIXED_NOW,
    });
    expect(sidecar.network).toHaveLength(1);
    expect(sidecar.network[0]?.kind).toBe("network");
    expect(sidecar.serverErrors).toHaveLength(1);
    expect(sidecar.serverErrors[0]?.kind).toBe("server");
    expect(sidecar.console).toHaveLength(1);
    expect(sidecar.errors).toHaveLength(0);
  });

  it("serialises round-trip through JSON", () => {
    const sidecar = buildFeedbackSidecar({
      description: "round trip",
      marks: [someBoxMark],
      imagePath: ".builder/feedback/fb-1.png",
      iframe: {
        url: "http://localhost:3000/page",
        viewport: { w: 800, h: 600 },
        scroll: { x: 0, y: 100 },
      },
      events: [errorEvent("oops", 1)],
      bridgeConnected: true,
      now: FIXED_NOW,
    });
    const round = JSON.parse(JSON.stringify(sidecar));
    expect(round).toEqual(sidecar);
  });
});
