import { describe, expect, it } from "vitest";

import type { CommandResult, RunCommand } from "./tsc.js";
import { parseTscOutput, tscScan } from "./tsc.js";

const CTX = {
  projectPath: "/tmp/proj",
  scanId: "scan-1",
  startedAt: 0,
};

function fakeRun(stdout: string, exitCode = 1, stderr = ""): RunCommand {
  return async (): Promise<CommandResult> => ({ stdout, stderr, exitCode });
}

describe("parseTscOutput", () => {
  it("parses the legacy parenthesised location format", () => {
    const out = "src/foo.ts(12,3): error TS2304: Cannot find name 'bar'.";
    expect(parseTscOutput(out)).toEqual([
      {
        file: "src/foo.ts",
        line: 12,
        column: 3,
        errorCode: 2304,
        message: "Cannot find name 'bar'.",
      },
    ]);
  });

  it("parses the colon-and-dash format that newer tsc emits", () => {
    const out = "src/foo.ts:12:3 - error TS2322: Type 'X' is not assignable to 'Y'.";
    expect(parseTscOutput(out)).toEqual([
      {
        file: "src/foo.ts",
        line: 12,
        column: 3,
        errorCode: 2322,
        message: "Type 'X' is not assignable to 'Y'.",
      },
    ]);
  });

  it("parses multiple errors across many lines", () => {
    const out = [
      "src/a.ts(1,1): error TS2304: Cannot find name 'foo'.",
      "src/a.ts(5,9): error TS2322: Type error.",
      "src/b.ts(10,2): error TS7006: Parameter implicitly has an 'any' type.",
    ].join("\n");
    expect(parseTscOutput(out)).toHaveLength(3);
  });

  it("ignores warning rows and unrelated text", () => {
    const out = [
      "Building...",
      "src/a.ts(1,1): warning TS2304: not an error",
      "src/a.ts(2,2): error TS2322: real error",
      "Done.",
    ].join("\n");
    const findings = parseTscOutput(out);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.errorCode).toBe(2322);
  });

  it("ignores the caret/code-snippet continuation lines tsc prints in pretty mode", () => {
    const out = [
      "src/a.ts(2,5): error TS2322: Type error.",
      "  2 |   const x: string = 1",
      "      ~",
      "src/b.ts(7,1): error TS2304: Cannot find name 'bar'.",
    ].join("\n");
    expect(parseTscOutput(out)).toHaveLength(2);
  });

  it("returns empty for a clean run", () => {
    expect(parseTscOutput("")).toEqual([]);
    expect(parseTscOutput("Compilation finished\n\n")).toEqual([]);
  });
});

describe("tscScan", () => {
  it("returns RawFindings of class 'build' with severity 8 and confidence 1", async () => {
    const findings = await tscScan(
      CTX,
      fakeRun("src/foo.ts(12,3): error TS2304: Cannot find name 'bar'.")
    );
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.class).toBe("build");
    expect(f.severity).toBe(8);
    expect(f.confidence).toBe(1);
    expect(f.ruleId).toBe("tsc/TS2304");
    expect(f.file).toBe("src/foo.ts");
    expect(f.lineStart).toBe(12);
    expect(f.lineEnd).toBe(12);
    expect(f.humanExplanation).toContain("TypeScript reports an error");
  });

  it("strips the project-path prefix from absolute file paths", async () => {
    const findings = await tscScan(
      CTX,
      fakeRun("/tmp/proj/src/foo.ts(1,1): error TS9999: example")
    );
    expect(findings[0]!.file).toBe("src/foo.ts");
  });

  it("returns an empty array when tsc cannot start (exit -1)", async () => {
    const findings = await tscScan(
      CTX,
      fakeRun("", -1, "spawn pnpm ENOENT")
    );
    expect(findings).toEqual([]);
  });

  it("returns an empty array on a clean compile (exit 0, no diagnostics)", async () => {
    const findings = await tscScan(CTX, fakeRun("", 0, ""));
    expect(findings).toEqual([]);
  });

  it("groups findings line-accurate", async () => {
    const findings = await tscScan(
      CTX,
      fakeRun(
        [
          "src/a.ts(2,5): error TS2322: Type error.",
          "src/a.ts(7,1): error TS2304: Cannot find name 'bar'.",
        ].join("\n")
      )
    );
    expect(findings.map((f) => f.lineStart)).toEqual([2, 7]);
  });

  it("scans stderr too — pnpm sometimes pipes tsc errors there", async () => {
    const findings = await tscScan(
      CTX,
      fakeRun("", 1, "src/foo.ts(1,1): error TS2304: Cannot find name 'bar'.")
    );
    expect(findings).toHaveLength(1);
  });
});
