// PII guard. Per build-order.md C7 (kit section 14.4.4): regex-detect
// emails, phone numbers, credit cards (Luhn-validated), SSN-like patterns,
// and IP addresses; replace matched values with synthetic equivalents
// before any value reaches a Claude call. Returns inspection results
// AND a redacted version of the input so callers can either:
//   (a) halt and ask the novice for permission to send the original
//       (the C8 ingestion-contract UX), or
//   (b) proceed with shape-only processing using the redacted text.

import { z } from "zod";

const GuardPiiParamsSchema = z.object({
  text: z.string(),
  /** Hint for the source of the text — included in each hit for the UI. */
  source: z.string().optional(),
});

export type PiiKind = "email" | "phone" | "credit_card" | "ssn" | "ip";

export interface PiiHit {
  kind: PiiKind;
  /** Masked sample (first 2 + last 2 chars; middle "..."). Never the raw value. */
  masked: string;
  /** 1-based line number of the first occurrence in the input text. */
  firstLine: number;
  /** Total occurrences of this exact value in the text. */
  count: number;
  /** What the synthetic replacement looks like in the redacted text. */
  redactedTo: string;
}

export interface GuardPiiResult {
  hasPii: boolean;
  source: string | null;
  hits: PiiHit[];
  /** The input text with every PII match replaced by its synthetic equivalent. */
  redactedText: string;
  /** Total characters scanned; useful for the UI to decide truncation. */
  scannedChars: number;
}

// Patterns. Tight enough to avoid the worst false positives; the UI is
// expected to confirm with the novice before taking destructive action.

// Email: RFC-lite. Local part is conservative on purpose.
const EMAIL_RX = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}\b/g;

// Phone: NANP-ish + international with separators. 7-15 digits, optional
// country prefix, optional separators (space/dash/dot/parens). Pre-filter
// keeps things sane; exact-validation is for the UI to confirm.
const PHONE_RX = /\+?\d[\d\s().-]{6,20}\d/g;

// Credit-card-shaped: 13-19 digits with optional separators; we validate
// Luhn on the digits-only form to drop most false positives.
const CC_LIKE_RX = /(?<![\d-])(?:\d[\d\s-]{11,22}\d)(?![\d-])/g;

// US SSN: NNN-NN-NNNN. Disallow obvious dummies (000-, 666-, 9NN-).
const SSN_RX = /\b(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g;

// IPv4. Simple 0-255 per octet via a stricter alternation.
const IP_RX = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\b/g;

// Synthetic stand-ins. Stable per kind so the redacted text reads naturally.
const SYNTHETIC = {
  email: "novice@example.invalid",
  phone: "+1-555-0100",
  credit_card: "4111-1111-1111-1111", // documented test number, not a real PAN
  ssn: "123-45-6789", // also documented as not-a-real SSN
  ip: "192.0.2.1", // RFC 5737 documentation address
} as const;

function maskValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length <= 4) return "*".repeat(trimmed.length);
  return `${trimmed.slice(0, 2)}...${trimmed.slice(-2)}`;
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0 && digits.length >= 13 && digits.length <= 19;
}

function lineNumberOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

interface RawMatch {
  kind: PiiKind;
  raw: string;
  index: number;
}

function collectMatches(text: string, kind: PiiKind, rx: RegExp): RawMatch[] {
  const out: RawMatch[] = [];
  rx.lastIndex = 0;
  let m;
  while ((m = rx.exec(text)) !== null) {
    out.push({ kind, raw: m[0], index: m.index });
    if (m.index === rx.lastIndex) rx.lastIndex++;
  }
  return out;
}

export function guardPii(rawParams: unknown): GuardPiiResult {
  const { text, source } = GuardPiiParamsSchema.parse(rawParams);

  // Phone matches are post-filtered by digit count: phones top out at ~12
  // digits in real-world use; longer digit runs are almost certainly CC
  // numbers, IDs, or other shapes that the phone regex shouldn't claim.
  const phoneMatches = collectMatches(text, "phone", PHONE_RX).filter((m) => {
    const digits = m.raw.replace(/\D/g, "");
    return digits.length >= 7 && digits.length <= 12;
  });

  const all: RawMatch[] = [
    ...collectMatches(text, "email", EMAIL_RX),
    ...phoneMatches,
    ...collectMatches(text, "ssn", SSN_RX),
    ...collectMatches(text, "ip", IP_RX),
  ];

  // Credit-card pre-matches need Luhn validation on the digits-only form.
  for (const m of collectMatches(text, "credit_card", CC_LIKE_RX)) {
    const digits = m.raw.replace(/[^\d]/g, "");
    if (luhnValid(digits)) all.push(m);
  }

  // De-overlap: phone matches that are entirely contained within a
  // credit-card or SSN match are dropped (these patterns can collide).
  const ccSpans = all
    .filter((m) => m.kind === "credit_card")
    .map((m) => [m.index, m.index + m.raw.length] as const);
  const ssnSpans = all
    .filter((m) => m.kind === "ssn")
    .map((m) => [m.index, m.index + m.raw.length] as const);
  const containedIn = (idx: number, len: number, spans: readonly (readonly [number, number])[]): boolean =>
    spans.some(([s, e]) => idx >= s && idx + len <= e);
  const filtered = all.filter((m) => {
    if (m.kind !== "phone") return true;
    return !containedIn(m.index, m.raw.length, ccSpans) && !containedIn(m.index, m.raw.length, ssnSpans);
  });

  // Aggregate per (kind, raw value) for the hit summary.
  const aggregated = new Map<string, { kind: PiiKind; raw: string; firstIndex: number; count: number }>();
  for (const m of filtered) {
    const key = `${m.kind}::${m.raw}`;
    const existing = aggregated.get(key);
    if (existing === undefined) {
      aggregated.set(key, { kind: m.kind, raw: m.raw, firstIndex: m.index, count: 1 });
    } else {
      existing.count++;
      if (m.index < existing.firstIndex) existing.firstIndex = m.index;
    }
  }

  // Build redacted text. Sort matches by index DESC so replacements
  // don't shift the indexes of later matches.
  const sortedForRedact = [...filtered].sort((a, b) => b.index - a.index);
  let redacted = text;
  for (const m of sortedForRedact) {
    const replacement = SYNTHETIC[m.kind];
    redacted = redacted.slice(0, m.index) + replacement + redacted.slice(m.index + m.raw.length);
  }

  const hits: PiiHit[] = Array.from(aggregated.values())
    .map((a) => ({
      kind: a.kind,
      masked: maskValue(a.raw),
      firstLine: lineNumberOf(text, a.firstIndex),
      count: a.count,
      redactedTo: SYNTHETIC[a.kind],
    }))
    .sort((a, b) => (a.firstLine !== b.firstLine ? a.firstLine - b.firstLine : a.kind.localeCompare(b.kind)));

  return {
    hasPii: hits.length > 0,
    source: source ?? null,
    hits,
    redactedText: redacted,
    scannedChars: text.length,
  };
}
