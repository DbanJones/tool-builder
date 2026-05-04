import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RawFinding } from "../detectors/types.js";
import type { PatchTransport } from "./patch-driver.js";
import { MAX_TIER2_ATTEMPTS, runTier2 } from "./tier2.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tier2-test-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function touch(rel: string, content: string): Promise<void> {
  const abs = path.join(tmp, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(tmp, rel), "utf-8");
}

const sampleFinding = (overrides: Partial<RawFinding> = {}): RawFinding => ({
  class: "auth",
  ruleId: "client-side-auth/no-server-hint",
  severity: 9,
  blastRadius: 2.5,
  confidence: 0.7,
  difficulty: 2,
  file: "app/admin/page.tsx",
  lineStart: 3,
  lineEnd: 3,
  humanExplanation: "Client-side role gate without server check",
  codeEvidence: "user.role === 'admin'",
  ...overrides,
});

function makeTransport(responses: string[]): PatchTransport {
  let i = 0;
  return {
    async generate() {
      const r = responses[i] ?? responses[responses.length - 1] ?? "";
      i++;
      return r;
    },
  };
}

describe("runTier2", () => {
  it("applies a clean patch on the first attempt and reports applied", async () => {
    await touch(
      "app/admin/page.tsx",
      `"use client";\nexport default function P({ user }: any) {\n  return user.role === 'admin' ? <div /> : null;\n}`
    );
    const transport = makeTransport([
      JSON.stringify({
        explanation: "Add server-side guard via a stub session lookup.",
        edits: [
          {
            file: "app/admin/page.tsx",
            oldText: "user.role === 'admin'",
            newText: "(user?.role ?? 'guest') === 'admin'",
          },
        ],
      }),
    ]);
    const result = await runTier2({
      finding: sampleFinding(),
      projectPath: tmp,
      transport,
    });
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.attempts).toBe(1);
    expect(result.files).toEqual(["app/admin/page.tsx"]);
    expect(await read("app/admin/page.tsx")).toContain("user?.role ?? 'guest'");
  });

  it("retries once when the first patch's oldText is not present", async () => {
    await touch(
      "app/admin/page.tsx",
      `export default function P({ user }: any) { return user.role === 'admin' ? <div /> : null; }`
    );
    const transport = makeTransport([
      JSON.stringify({
        explanation: "First attempt, wrong oldText",
        edits: [
          {
            file: "app/admin/page.tsx",
            oldText: "definitely-not-in-file",
            newText: "x",
          },
        ],
      }),
      JSON.stringify({
        explanation: "Second attempt, correct oldText",
        edits: [
          {
            file: "app/admin/page.tsx",
            oldText: "user.role === 'admin'",
            newText: "(user?.role ?? 'guest') === 'admin'",
          },
        ],
      }),
    ]);
    const result = await runTier2({
      finding: sampleFinding(),
      projectPath: tmp,
      transport,
    });
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.attempts).toBe(2);
  });

  it("returns verify_failed after MAX_TIER2_ATTEMPTS unsuccessful tries", async () => {
    await touch(
      "app/admin/page.tsx",
      `export default function P() { return null; }`
    );
    const transport = makeTransport([
      JSON.stringify({
        explanation: "wrong",
        edits: [
          { file: "app/admin/page.tsx", oldText: "missing-1", newText: "x" },
        ],
      }),
      JSON.stringify({
        explanation: "wrong again",
        edits: [
          { file: "app/admin/page.tsx", oldText: "missing-2", newText: "x" },
        ],
      }),
    ]);
    const result = await runTier2({
      finding: sampleFinding(),
      projectPath: tmp,
      transport,
    });
    expect(result.kind).toBe("verify_failed");
    if (result.kind !== "verify_failed") return;
    expect(result.attempts).toBe(MAX_TIER2_ATTEMPTS);
    expect(result.lastErrors).toMatch(/old_text_not_found/);
  });

  it("returns no_patch when the LLM returns zero edits with an explanation", async () => {
    const transport = makeTransport([
      JSON.stringify({
        explanation: "Slice does not show enough context to fix safely",
        edits: [],
      }),
    ]);
    const result = await runTier2({
      finding: sampleFinding(),
      projectPath: tmp,
      transport,
    });
    expect(result.kind).toBe("no_patch");
    if (result.kind !== "no_patch") return;
    expect(result.reason).toContain("Slice does not show enough context");
  });

  it("retries when the response is unparseable JSON", async () => {
    await touch(
      "app/admin/page.tsx",
      `export const x = user.role === 'admin' ? 1 : 0;`
    );
    const transport = makeTransport([
      "Sorry, I can't help with that.",
      JSON.stringify({
        explanation: "Recovered on retry.",
        edits: [
          {
            file: "app/admin/page.tsx",
            oldText: "user.role === 'admin'",
            newText: "false",
          },
        ],
      }),
    ]);
    const result = await runTier2({
      finding: sampleFinding(),
      projectPath: tmp,
      transport,
    });
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.attempts).toBe(2);
  });

  it("preserves file contents when the first attempt's apply errors", async () => {
    // Two identical lines guarantee the LLM-emitted oldText is ambiguous,
    // so applyEdits errors out before writing anything to disk. The
    // second attempt gives up with empty edits.
    const before = `const x = 1;\nconst x = 1;\n`;
    await touch("lib/foo.ts", before);
    const finding = sampleFinding({ file: "lib/foo.ts", lineStart: 1, lineEnd: 1 });
    const transport = makeTransport([
      JSON.stringify({
        explanation: "ambiguous oldText",
        edits: [
          { file: "lib/foo.ts", oldText: "const x = 1", newText: "const x = 2" },
        ],
      }),
      JSON.stringify({ explanation: "give up", edits: [] }),
    ]);
    const result = await runTier2({
      finding,
      projectPath: tmp,
      transport,
    });
    expect(result.kind).toBe("no_patch");
    expect(await read("lib/foo.ts")).toBe(before);
  });

  it("rolls back files when the patch produces broken syntax", async () => {
    const before = `export const x = 1;\n`;
    await touch("lib/foo.ts", before);
    const finding = sampleFinding({ file: "lib/foo.ts", lineStart: 1, lineEnd: 1 });
    const transport = makeTransport([
      JSON.stringify({
        explanation: "broken syntax",
        edits: [
          { file: "lib/foo.ts", oldText: "const x = 1", newText: "const x = 1; function broken( {" },
        ],
      }),
      JSON.stringify({ explanation: "give up", edits: [] }),
    ]);
    const result = await runTier2({
      finding,
      projectPath: tmp,
      transport,
    });
    // Syntax check must abort + restore for the next attempt's snapshot.
    expect(result.kind).toBe("no_patch"); // second attempt is a graceful give-up
    expect(await read("lib/foo.ts")).toBe(before);
  });
});
