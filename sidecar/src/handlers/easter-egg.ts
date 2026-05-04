import { eq } from "drizzle-orm";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";

import { getDb } from "../db.js";
import { projects } from "../schema/projects.js";

const VerifyParamsSchema = z.object({
  projectId: z.string().min(1),
});

const EXCLUDED_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", "out"]);
const SOURCE_EXTENSIONS = new Set([
  ".css",
  ".cjs",
  ".cts",
  ".html",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".sass",
  ".scss",
  ".svelte",
  ".ts",
  ".tsx",
  ".vue",
]);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

export type EasterEggFindingCheck = "project" | "marker" | "text" | "shortcut";

export interface EasterEggFinding {
  check: EasterEggFindingCheck;
  ok: boolean;
  message: string;
}

export interface EasterEggVerifyResult {
  ok: boolean;
  findings: EasterEggFinding[];
  filesScanned: number;
  bytesScanned: number;
}

interface ScanResult {
  text: string;
  filesScanned: number;
  bytesScanned: number;
}

export function verify(rawParams: unknown): EasterEggVerifyResult {
  const params = VerifyParamsSchema.parse(rawParams);
  const db = getDb();
  const [project] = db.select().from(projects).where(eq(projects.id, params.projectId)).all();

  if (!project) {
    return {
      ok: false,
      filesScanned: 0,
      bytesScanned: 0,
      findings: [
        {
          check: "project",
          ok: false,
          message: `Project ${params.projectId} was not found.`,
        },
      ],
    };
  }

  return verifyProjectPath(project.path);
}

export function verifyProjectPath(projectPath: string): EasterEggVerifyResult {
  const root = path.resolve(projectPath);
  const projectFinding = validateProjectRoot(root);
  if (!projectFinding.ok) {
    return {
      ok: false,
      filesScanned: 0,
      bytesScanned: 0,
      findings: [projectFinding],
    };
  }

  const scan = scanSourceFiles(root);
  const findings: EasterEggFinding[] = [
    projectFinding,
    {
      check: "marker",
      ok: scan.text.includes("builder:david-easter-egg"),
      message: scan.text.includes("builder:david-easter-egg")
        ? "Found builder:david-easter-egg marker."
        : "Missing builder:david-easter-egg marker in source files.",
    },
    {
      check: "text",
      ok: scan.text.includes("made by david"),
      message: scan.text.includes("made by david")
        ? "Found exact text made by david."
        : "Missing exact text made by david in source files.",
    },
    {
      check: "shortcut",
      ok: hasAltShiftDShortcut(scan.text),
      message: hasAltShiftDShortcut(scan.text)
        ? "Found Alt+Shift+D shortcut handling."
        : "Missing Alt+Shift+D shortcut handling in source files.",
    },
  ];

  return {
    ok: findings.every((f) => f.ok),
    findings,
    filesScanned: scan.filesScanned,
    bytesScanned: scan.bytesScanned,
  };
}

function validateProjectRoot(root: string): EasterEggFinding {
  if (!fs.existsSync(root)) {
    return {
      check: "project",
      ok: false,
      message: `Project folder does not exist: ${root}`,
    };
  }
  if (!fs.statSync(root).isDirectory()) {
    return {
      check: "project",
      ok: false,
      message: `Project path is not a folder: ${root}`,
    };
  }
  return {
    check: "project",
    ok: true,
    message: `Scanned source files in ${root}.`,
  };
}

function scanSourceFiles(root: string): ScanResult {
  const chunks: string[] = [];
  let filesScanned = 0;
  let bytesScanned = 0;

  const walk = (dir: string): void => {
    if (bytesScanned >= MAX_TOTAL_BYTES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (bytesScanned >= MAX_TOTAL_BYTES) return;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;

      const stat = fs.statSync(fullPath);
      if (stat.size > MAX_FILE_BYTES) continue;
      if (bytesScanned + stat.size > MAX_TOTAL_BYTES) return;

      chunks.push(fs.readFileSync(fullPath, "utf8"));
      filesScanned++;
      bytesScanned += stat.size;
    }
  };

  walk(root);
  return { text: chunks.join("\n"), filesScanned, bytesScanned };
}

function hasAltShiftDShortcut(text: string): boolean {
  if (/alt\s*\+\s*shift\s*\+\s*d/i.test(text)) return true;

  const hasAlt = /\baltKey\b|\bgetModifierState\(["']Alt["']\)/.test(text);
  const hasShift = /\bshiftKey\b|\bgetModifierState\(["']Shift["']\)/.test(text);
  const hasD =
    /\.key\.toLowerCase\(\)\s*===\s*["']d["']/.test(text) ||
    /\bkey\s*===\s*["'][dD]["']/.test(text) ||
    /\bcode\s*===\s*["']KeyD["']/.test(text) ||
    /["']KeyD["']/.test(text);

  return hasAlt && hasShift && hasD;
}
