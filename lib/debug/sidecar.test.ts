import { errAsync, okAsync } from "neverthrow";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { sidecarCall } from "@/lib/sidecar/client";

import {
  applyDebugFix,
  listDefects,
  runDebugGraph,
  runDebugScan,
  type ApplyFixResult,
  type Defect,
  type DebugScanResult,
  type SoftwareGraph,
} from "./sidecar";

vi.mock("@/lib/sidecar/client", () => ({ sidecarCall: vi.fn() }));

const mockSidecar = vi.mocked(sidecarCall);

beforeEach(() => {
  mockSidecar.mockReset();
});

const sampleDefect = (overrides: Partial<Defect> = {}): Defect => ({
  id: "01DEF",
  projectId: "01PROJ",
  scanId: "01SCAN",
  detectedAt: 100,
  class: "auth",
  severity: 9,
  blastRadius: 2.5,
  confidence: 0.7,
  difficulty: 1.5,
  priority: 21,
  band: "critical",
  file: "supabase/migrations/0001.sql",
  lineStart: 1,
  lineEnd: 1,
  ruleId: "rls-missing/no-rls-on-pii-table",
  humanExplanation: "...",
  codeEvidence: "CREATE TABLE users …",
  status: "open",
  fixTier: null,
  fixBranch: null,
  fixTestPath: null,
  resolvedAt: null,
  resolvedCommit: null,
  validatorVerdict: null,
  validatorNotes: null,
  validatedAt: null,
  suggestion: null,
  ...overrides,
});

describe("runDebugScan", () => {
  it("forwards { projectId, userMode } to debug.scan and returns the result", async () => {
    const expected: DebugScanResult = {
      scanId: "01SCAN",
      findingCount: 1,
      durationMs: 42,
      failures: [],
      validatorDismissed: 0,
    };
    mockSidecar.mockReturnValueOnce(okAsync(expected));

    const result = await runDebugScan({ projectId: "01PROJ", userMode: "founder" });

    expect(mockSidecar).toHaveBeenCalledWith("debug.scan", {
      projectId: "01PROJ",
      userMode: "founder",
    });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual(expected);
  });

  it("forwards the validate flag when set", async () => {
    mockSidecar.mockReturnValueOnce(
      okAsync({
        scanId: "01SCAN",
        findingCount: 0,
        durationMs: 1,
        failures: [],
        validatorDismissed: 0,
      })
    );
    await runDebugScan({ projectId: "01PROJ", validate: true });
    expect(mockSidecar).toHaveBeenCalledWith("debug.scan", {
      projectId: "01PROJ",
      validate: true,
    });
  });

  it("translates a Sidecar error into a DebugError", async () => {
    mockSidecar.mockReturnValueOnce(
      errAsync({ kind: "Sidecar", code: "HANDLER_ERROR", message: "boom" })
    );
    const result = await runDebugScan({ projectId: "01PROJ" });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({
      kind: "Sidecar",
      message: "HANDLER_ERROR: boom",
    });
  });

  it("translates a Transport error into a DebugError", async () => {
    mockSidecar.mockReturnValueOnce(
      errAsync({ kind: "Transport", message: "ipc dead" })
    );
    const result = await runDebugScan({ projectId: "01PROJ" });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({
      kind: "Sidecar",
      message: "ipc dead",
    });
  });
});

describe("runDebugGraph", () => {
  it("forwards { projectId } to debug.graph and returns the graph", async () => {
    const expected: SoftwareGraph = {
      routes: [
        {
          framework: "next-app",
          kind: "route",
          pathPattern: "/api/users/[id]",
          methods: ["GET"],
          filePath: "app/api/users/[id]/route.ts",
          isDynamic: true,
          hasMiddleware: false,
        },
      ],
      schema: [],
      auth: [],
      warnings: [],
    };
    mockSidecar.mockReturnValueOnce(okAsync(expected));
    const result = await runDebugGraph({ projectId: "01PROJ" });
    expect(mockSidecar).toHaveBeenCalledWith("debug.graph", { projectId: "01PROJ" });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual(expected);
  });

  it("translates errors", async () => {
    mockSidecar.mockReturnValueOnce(
      errAsync({ kind: "Sidecar", code: "HANDLER_ERROR", message: "boom" })
    );
    const result = await runDebugGraph({ projectId: "01PROJ" });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain("HANDLER_ERROR");
  });
});

describe("applyDebugFix", () => {
  it("forwards { defectId } to debug.applyFix and returns the result", async () => {
    const expected: ApplyFixResult = {
      defectId: "01DEF",
      outcome: "applied",
      message: "fixed it",
      files: ["lib/aws.ts", ".env.example"],
      branch: "ai-fix-01DEF",
    };
    mockSidecar.mockReturnValueOnce(okAsync(expected));
    const result = await applyDebugFix({ defectId: "01DEF" });
    expect(mockSidecar).toHaveBeenCalledWith("debug.applyFix", { defectId: "01DEF" });
    expect(result._unsafeUnwrap()).toEqual(expected);
  });

  it("translates a Sidecar error", async () => {
    mockSidecar.mockReturnValueOnce(
      errAsync({ kind: "Sidecar", code: "HANDLER_ERROR", message: "no defect" })
    );
    const result = await applyDebugFix({ defectId: "01DEF" });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain("HANDLER_ERROR");
  });
});

describe("listDefects", () => {
  it("returns the array of defects on success", async () => {
    mockSidecar.mockReturnValueOnce(okAsync([sampleDefect()]));
    const result = await listDefects({ projectId: "01PROJ" });
    expect(mockSidecar).toHaveBeenCalledWith("debug.list", { projectId: "01PROJ" });
    expect(result._unsafeUnwrap()).toHaveLength(1);
  });

  it("forwards an optional scanId filter", async () => {
    mockSidecar.mockReturnValueOnce(okAsync([]));
    await listDefects({ projectId: "01PROJ", scanId: "01SCAN" });
    expect(mockSidecar).toHaveBeenCalledWith("debug.list", {
      projectId: "01PROJ",
      scanId: "01SCAN",
    });
  });

  it("translates errors", async () => {
    mockSidecar.mockReturnValueOnce(
      errAsync({ kind: "Sidecar", code: "HANDLER_ERROR", message: "nope" })
    );
    const result = await listDefects({ projectId: "01PROJ" });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain("HANDLER_ERROR");
  });
});
