// Integration test for files.guardPii (kit section 14.4.4).

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface SuccessResponse<T> {
  id: string;
  ok: true;
  result: T;
}
interface FailureResponse {
  id: string;
  ok: false;
  error: { code: string; message: string };
}
type Response<T> = SuccessResponse<T> | FailureResponse;

interface PiiHit {
  kind: "email" | "phone" | "credit_card" | "ssn" | "ip";
  masked: string;
  firstLine: number;
  count: number;
  redactedTo: string;
}

interface GuardPiiResult {
  hasPii: boolean;
  source: string | null;
  hits: PiiHit[];
  redactedText: string;
  scannedChars: number;
}

class SidecarHarness {
  private child!: ChildProcessWithoutNullStreams;
  private buffer = "";
  private pending = new Map<string, (line: string) => void>();
  private nextId = 1;

  async start(dbPath: string, migrationsFolder: string): Promise<void> {
    const sidecarRoot = path.resolve(process.cwd(), "sidecar");
    const entry = path.join(sidecarRoot, "dist", "index.js");
    this.child = spawn(
      "node",
      [entry, "--db-path", dbPath, "--migrations-folder", migrationsFolder],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onChunk(chunk));
    this.child.stderr.on("data", () => undefined);
    await new Promise((r) => setTimeout(r, 200));
  }

  private onChunk(chunk: string): void {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length === 0) continue;
      try {
        const parsed = JSON.parse(line) as { id: string };
        const r = this.pending.get(parsed.id);
        if (r) {
          this.pending.delete(parsed.id);
          r(line);
        }
      } catch {
        // ignore
      }
    }
  }

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<Response<T>> {
    const id = String(this.nextId++);
    const promise = new Promise<string>((resolve, reject) => {
      this.pending.set(id, resolve);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout id=${id}`));
        }
      }, 10000);
    });
    this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    const line = await promise;
    return JSON.parse(line) as Response<T>;
  }

  async stop(): Promise<void> {
    this.child.stdin.end();
    await new Promise((r) => this.child.on("exit", r));
  }
}

describe("sidecar files.guardPii (integration)", () => {
  let tempDir: string;
  let harness: SidecarHarness;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "builder-pii-test-"));
    const dbPath = path.join(tempDir, "builder.db");
    const migrationsFolder = path.resolve(process.cwd(), "sidecar", "migrations");
    harness = new SidecarHarness();
    await harness.start(dbPath, migrationsFolder);
  });

  afterAll(async () => {
    await harness.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("flags clean text as having no PII and returns it unchanged", async () => {
    const text = "This file has no personal data, just words and 12 numbers like 7 or 99.";
    const r = await harness.call<GuardPiiResult>("files.guardPii", { text });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.hasPii).toBe(false);
    expect(r.result.hits).toEqual([]);
    expect(r.result.redactedText).toBe(text);
  });

  it("detects + masks + redacts emails", async () => {
    const text = "Contact me at alice@example.com or alice@example.com again, and bob@test.io.";
    const r = await harness.call<GuardPiiResult>("files.guardPii", { text });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.hasPii).toBe(true);

    const emails = r.result.hits.filter((h) => h.kind === "email");
    expect(emails).toHaveLength(2); // alice@example.com counted twice
    const alice = emails.find((h) => h.masked.startsWith("al") && h.masked.endsWith("om"));
    expect(alice?.count).toBe(2);

    expect(r.result.redactedText).not.toContain("alice@example.com");
    expect(r.result.redactedText).not.toContain("bob@test.io");
    expect(r.result.redactedText).toContain("novice@example.invalid");
  });

  it("validates credit-card-shaped numbers via Luhn (only real CCs are flagged AS credit cards)", async () => {
    // 4111-1111-1111-1111 is a documented Luhn-valid Visa test number.
    // 1234-5678-9012-3456 is NOT Luhn-valid; it must NOT appear in the
    // credit_card hits. (It may still be flagged conservatively under
    // another kind — over-flagging is acceptable per the "halt and ask"
    // intent.)
    const text = "Real-looking: 4111 1111 1111 1111. Not real: 1234 5678 9012 3456.";
    const r = await harness.call<GuardPiiResult>("files.guardPii", { text });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ccs = r.result.hits.filter((h) => h.kind === "credit_card");
    expect(ccs).toHaveLength(1);
    // The Luhn-valid number was redacted to the synthetic stand-in.
    expect(r.result.redactedText).toContain("4111-1111-1111-1111");
    // The non-Luhn-valid number was not flagged AS a credit card (Luhn
    // rejected it) and is too long (16 digits) for the phone-shape filter,
    // so it remains in the output unchanged.
    expect(r.result.redactedText).toContain("1234 5678 9012 3456");
  });

  it("detects SSNs and IPs without false-positive on the obvious dummy SSN block", async () => {
    // 000-12-3456 is an explicitly excluded SSN block; it must NOT be
    // flagged AS an SSN. (Like the CC case, it may still be flagged as
    // another kind by the conservative regexes — that is acceptable.)
    const text = "Real SSN: 246-80-1357. Dummy: 000-12-3456. IP: 10.0.0.42.";
    const r = await harness.call<GuardPiiResult>("files.guardPii", { text });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ssns = r.result.hits.filter((h) => h.kind === "ssn");
    expect(ssns).toHaveLength(1);
    expect(ssns[0]?.masked).toContain("...");
    const ips = r.result.hits.filter((h) => h.kind === "ip");
    expect(ips).toHaveLength(1);
    expect(r.result.redactedText).toContain("192.0.2.1"); // RFC-5737 stand-in
    expect(r.result.redactedText).toContain("123-45-6789"); // synthetic SSN stand-in
  });

  it("forwards the source label back in the result for the UI", async () => {
    const r = await harness.call<GuardPiiResult>("files.guardPii", {
      text: "no pii",
      source: "uploads/spec.md",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.source).toBe("uploads/spec.md");
  });

  it("does not double-flag a phone number that is part of a credit card or SSN match", async () => {
    // The CC and SSN regexes both match number-with-separators patterns;
    // the de-overlap logic should ensure only the more-specific kind survives.
    const text = "CC: 4111 1111 1111 1111. SSN: 246-80-1357.";
    const r = await harness.call<GuardPiiResult>("files.guardPii", { text });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const phones = r.result.hits.filter((h) => h.kind === "phone");
    // The CC and SSN matches should NOT also appear as phone hits.
    for (const p of phones) {
      expect(p.masked).not.toContain("11");
      expect(p.masked).not.toContain("13");
    }
  });
});
