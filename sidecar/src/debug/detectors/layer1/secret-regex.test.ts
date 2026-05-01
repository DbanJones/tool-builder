import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { secretRegexDetector, secretRegexScan } from "./secret-regex.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "secret-test-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function touch(rel: string, content: string): Promise<void> {
  const abs = path.join(tmp, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

const CTX_FIXTURE = (projectPath: string) => ({
  projectPath,
  scanId: "test-scan",
  startedAt: 0,
});

describe("secretRegexScan", () => {
  it("detects a hardcoded AWS access key", async () => {
    await touch(
      "lib/aws.ts",
      `const KEY = "AKIAIOSFODNN7EXAMPLE";\nexport { KEY };`
    );
    const findings = await secretRegexScan(CTX_FIXTURE(tmp));
    // EXAMPLE in the surrounding identifier triggers the placeholder
    // halving — the line still gets flagged, just at lower confidence.
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.class).toBe("security");
    expect(f.ruleId).toBe("secret-regex/aws-access-key");
    expect(f.severity).toBe(9);
    expect(f.file).toBe("lib/aws.ts");
    expect(f.lineStart).toBe(1);
    expect(f.codeEvidence).toContain("AKIA");
    expect(f.codeEvidence).toContain("***"); // redacted
    expect(f.codeEvidence).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("detects a GitHub PAT", async () => {
    await touch(
      "lib/gh.ts",
      `const TOKEN = "ghp_aB3dE6fG9jK2mN5pR8tU1xY4zC7dE0fG3hJ6";`
    );
    const findings = await secretRegexScan(CTX_FIXTURE(tmp));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.ruleId).toBe("secret-regex/github-pat");
    expect(findings[0]!.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("detects a Stripe live secret key", async () => {
    await touch(
      "components/checkout.tsx",
      `const stripe = new Stripe("sk_live_abcdefghijklmnopqrstuvwxyz1234567890");`
    );
    const findings = await secretRegexScan(CTX_FIXTURE(tmp));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.ruleId).toBe("secret-regex/stripe-live-secret");
  });

  it("detects an Anthropic API key", async () => {
    await touch(
      "lib/llm.ts",
      `const KEY = "sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";`
    );
    const findings = await secretRegexScan(CTX_FIXTURE(tmp));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.ruleId).toBe("secret-regex/anthropic-api-key");
  });

  it("flags a Google API key", async () => {
    // Real Google API keys are exactly AIza + 35 chars = 39 total.
    await touch(
      "lib/maps.ts",
      `const KEY = "AIzaSyBCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh";`
    );
    const findings = await secretRegexScan(CTX_FIXTURE(tmp));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.ruleId).toBe("secret-regex/google-api-key");
  });

  it("returns empty for clean source", async () => {
    await touch(
      "lib/util.ts",
      `export const greet = (name: string) => "hello, " + name;`
    );
    expect(await secretRegexScan(CTX_FIXTURE(tmp))).toHaveLength(0);
  });

  it("halves confidence when a placeholder marker shares the line as a separate word", async () => {
    // Word-boundary check: only standalone PLACEHOLDER/FAKE/DUMMY/EXAMPLE
    // markers in the same line halve confidence. The marker has to be
    // bounded by non-word chars; substrings buried inside the secret
    // itself do not trigger the downrank (that would skip every secret
    // whose vendor name happens to spell EXAMPLE).
    await touch(
      "lib/example.ts",
      `const fakeKey = "AKIAIOSFODNN7EXAMPLE"; // FAKE — real key lives in the vault`
    );
    const findings = await secretRegexScan(CTX_FIXTURE(tmp));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.confidence).toBeLessThan(0.7);
  });

  it("does not read non-code files", async () => {
    // .png is binary-shaped; even if it contains an AKIA* sequence in
    // bytes it should not be opened.
    await touch("app/asset.png", `AKIAIOSFODNN7EXAMPLE-fake binary contents`);
    expect(await secretRegexScan(CTX_FIXTURE(tmp))).toHaveLength(0);
  });

  it("scans .env files", async () => {
    await touch(
      "supabase/.env",
      `STRIPE_SECRET_KEY=sk_live_abcdefghijklmnopqrstuvwxyz1234567890`
    );
    const findings = await secretRegexScan(CTX_FIXTURE(tmp));
    expect(findings).toHaveLength(1);
  });

  it("reports the line number 1-indexed", async () => {
    await touch(
      "lib/multi.ts",
      `// header\n\nconst KEY = "AKIAIOSFODNN7EXAMPLE";`
    );
    const findings = await secretRegexScan(CTX_FIXTURE(tmp));
    expect(findings[0]!.lineStart).toBe(3);
    expect(findings[0]!.lineEnd).toBe(3);
  });

  it("flags multiple distinct secrets in one file", async () => {
    await touch(
      "lib/many.ts",
      `const A = "AKIAIOSFODNN7AAAAAAA";\nconst B = "ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";`
    );
    const findings = await secretRegexScan(CTX_FIXTURE(tmp));
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.ruleId).sort()).toEqual([
      "secret-regex/aws-access-key",
      "secret-regex/github-pat",
    ]);
  });
});

describe("secretRegexDetector (Detector adapter)", () => {
  it("conforms to the Detector interface", async () => {
    expect(secretRegexDetector.id).toBe("secret-regex");
    await touch("lib/k.ts", `const K = "AKIAIOSFODNN7AAAAAAA";`);
    const findings = await secretRegexDetector.run(CTX_FIXTURE(tmp));
    expect(findings).toHaveLength(1);
  });
});
