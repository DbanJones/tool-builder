// Build/compile detector. Spawns the target app's `tsc --noEmit` against
// its own tsconfig and converts each diagnostic to a `RawFinding` of
// class `build`. Per debug_repair_engine_spec.md §B.1.1, type errors are
// blocker-severity (8) and detection is deterministic — confidence 1.0.
//
// The spawn is parameterised so unit tests can inject a stub. Production
// callers use the default which shells out to `pnpm exec tsc` from the
// target folder so the target's own TypeScript version is used.

import { spawn } from "node:child_process";

import type { Detector, RawFinding, ScanContext } from "../types.js";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type RunCommand = (
  cmd: string,
  args: readonly string[],
  cwd: string
) => Promise<CommandResult>;

const defaultRunCommand: RunCommand = (cmd, args, cwd) =>
  new Promise((resolve) => {
    const child = spawn(cmd, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (err) => {
      resolve({ stdout, stderr: stderr + String(err), exitCode: -1 });
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
  });

// `path/to/file.ts(LINE,COL): error TS####: message` — legacy non-pretty
// `path/to/file.ts:LINE:COL - error TS####: message` — newer formatter
// We accept either; multi-line continuations (caret indicator + the source
// snippet that tsc prints in pretty mode) are ignored because they do not
// match this header shape.
const HEADER_RE =
  /^(?<file>[^()\s][^():]*?)(?:\((?<line1>\d+),(?<col1>\d+)\):|:(?<line2>\d+):(?<col2>\d+) -) error TS(?<code>\d+): (?<message>.*)$/;

export interface TscFinding {
  file: string;
  line: number;
  column: number;
  errorCode: number;
  message: string;
}

export function parseTscOutput(output: string): TscFinding[] {
  const found: TscFinding[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const m = HEADER_RE.exec(raw);
    if (!m || !m.groups) continue;
    const g = m.groups;
    const line = Number(g.line1 ?? g.line2);
    const column = Number(g.col1 ?? g.col2);
    if (!Number.isFinite(line) || !Number.isFinite(column)) continue;
    const file = g.file ?? "";
    const code = Number(g.code ?? "0");
    const message = (g.message ?? "").trim();
    if (!file) continue;
    found.push({ file, line, column, errorCode: code, message });
  }
  return found;
}

export async function tscScan(
  ctx: ScanContext,
  runCommand: RunCommand = defaultRunCommand
): Promise<readonly RawFinding[]> {
  const result = await runCommand(
    "pnpm",
    ["exec", "tsc", "--noEmit", "--pretty", "false"],
    ctx.projectPath
  );

  // tsc returns 0 on success, 1+ on errors. Either way we parse stdout —
  // tsc writes diagnostics there even when it exits non-zero. A spawn
  // failure (-1 exitCode) is the one path where we silently produce no
  // findings; a build that cannot even start is a Layer 3 concern (sandbox
  // build, G7), not a Layer 1 finding.
  if (result.exitCode === -1) return [];

  const tscFindings = parseTscOutput(result.stdout + "\n" + result.stderr);
  return tscFindings.map((f) => toRawFinding(f, ctx.projectPath));
}

function toRawFinding(f: TscFinding, projectPath: string): RawFinding {
  const rel = relativise(f.file, projectPath);
  return {
    class: "build",
    ruleId: `tsc/TS${f.errorCode}`,
    severity: 8,
    blastRadius: 3,
    confidence: 1,
    difficulty: 1,
    file: rel,
    lineStart: f.line,
    lineEnd: f.line,
    humanExplanation: humanExplanation(rel, f.line, f.message),
    codeEvidence: `TS${f.errorCode}: ${f.message}`,
  };
}

function relativise(file: string, projectPath: string): string {
  // tsc usually emits paths relative to the cwd we passed it (which is
  // the project root), but absolute paths slip in occasionally. Strip the
  // project prefix; otherwise return as-is.
  const normalised = file.replace(/\\/g, "/");
  const project = projectPath.replace(/\\/g, "/");
  if (normalised.startsWith(project + "/")) {
    return normalised.slice(project.length + 1);
  }
  return normalised;
}

function humanExplanation(file: string, line: number, message: string): string {
  return (
    `TypeScript reports an error in ${file} at line ${line}: ${message}. ` +
    `Builds will fail until this is fixed.`
  );
}

export const tscDetector: Detector = {
  id: "tsc",
  run(ctx: ScanContext): Promise<readonly RawFinding[]> {
    return tscScan(ctx);
  },
};
