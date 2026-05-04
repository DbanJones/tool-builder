// Validator driver. Owns:
//   - The ValidatorTransport interface (production vs stub).
//   - A production transport that wraps `query()` from the Claude
//     Agent SDK (already a sidecar dep per ADR-0005).
//   - Response parsing with strict JSON-schema validation; any parse
//     failure defaults to verdict="uncertain" so a prompt-injection
//     attempt cannot silently dismiss a finding.
//   - A `validateFinding` orchestrator that takes (RawFinding, graph,
//     projectPath, transport) and returns a fully-resolved
//     ValidatorResult — the unit G4c's handler integration consumes.

import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type { RawFinding } from "../detectors/types.js";
import type { SoftwareGraph } from "../graph/index.js";

import { renderPrompt, type RenderedPrompt } from "./prompt.js";
import { extractSlice } from "./slice.js";

export type ValidatorVerdict = "real" | "false_positive" | "uncertain";

export interface ValidatorResult {
  verdict: ValidatorVerdict;
  confidence: number;
  exploitPath: string;
  fixStrategy: string;
  fixTier: 1 | 2 | 3 | null;
  /** Raw model output, kept for diagnostics + audit. */
  raw: string;
}

export interface ValidatorTransport {
  /** Send a rendered prompt to the validator; return the model's raw text.
   *  Optional `model` overrides the SDK default; transport implementations
   *  that don't honour it are free to ignore the param. */
  validate(prompt: RenderedPrompt, model?: string): Promise<string>;
}

const ValidatorResponseSchema = z.object({
  verdict: z.enum(["real", "false_positive", "uncertain"]),
  confidence: z.number().min(0).max(1),
  exploitPath: z.string(),
  fixStrategy: z.string(),
  fixTier: z.union([z.literal(1), z.literal(2), z.literal(3), z.null()]),
});

const UNCERTAIN_FALLBACK: Omit<ValidatorResult, "raw"> = {
  verdict: "uncertain",
  confidence: 0.4,
  exploitPath: "",
  fixStrategy: "",
  fixTier: null,
};

/**
 * Parse the validator's text response into a ValidatorResult. Any of:
 * - Surrounded by prose / markdown fences
 * - Missing or extra fields
 * - Wrong types
 * - Empty
 * collapses to verdict="uncertain" with confidence 0.4 — never to
 * verdict="false_positive", which would silently drop the finding.
 */
export function parseValidatorResponse(raw: string): ValidatorResult {
  const json = extractJsonObject(raw);
  if (json === null) return { ...UNCERTAIN_FALLBACK, raw };
  const parsed = ValidatorResponseSchema.safeParse(json);
  if (!parsed.success) return { ...UNCERTAIN_FALLBACK, raw };
  return { ...parsed.data, raw };
}

/**
 * Pull the first balanced JSON object out of a string. Tolerates
 * surrounding prose or ```json fences; returns null if nothing parses.
 */
function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) return null;
  // Walk forward tracking depth; tolerate strings (we do not honour
  // escape sequences fully — a quote inside a string is enough).
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Production transport. One Claude Agent SDK session per call; we let
 * the SDK pick the model (it inherits from the sidecar's claude CLI
 * auth). G4 echo-back risk #4 prefers one session per scan over one
 * per finding — that batching is implemented by the caller, not here.
 */
export const sdkTransport: ValidatorTransport = {
  async validate(prompt, model) {
    const messages: SDKMessage[] = [];
    const stream = query({
      prompt: prompt.user,
      options: {
        // Validator is a one-shot text-in/text-out call; cap turns to
        // stop runaway tool-use loops if claude tries to call into the
        // sidecar (it has no tools registered for this session).
        maxTurns: 1,
        systemPrompt: prompt.system,
        ...(model !== undefined ? { model } : {}),
      },
    });
    for await (const msg of stream) {
      messages.push(msg);
    }
    return concatAssistantText(messages);
  },
};

function concatAssistantText(messages: readonly SDKMessage[]): string {
  let out = "";
  for (const m of messages) {
    if (m.type !== "assistant") continue;
    const content = (m as unknown as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<{ type?: string; text?: string }>) {
      if (block.type === "text" && typeof block.text === "string") {
        out += block.text;
      }
    }
  }
  return out;
}

/**
 * Stub transport for tests. Maps `ruleId` prefixes to canned verdicts;
 * unknown rules return "uncertain". Deterministic — the merge gate
 * never makes real LLM calls (G4 echo-back decision #1).
 */
export function stubTransport(
  responses: Readonly<Record<string, string>> = {}
): ValidatorTransport {
  return {
    async validate(prompt) {
      // Look for the rule id the prompt advertises.
      const m = /Rule id: ([^\n]+)/.exec(prompt.user);
      const ruleId = m?.[1]?.trim() ?? "";
      // Allow exact-match override first, then prefix match (so
      // `secret-regex` covers all `secret-regex/aws-access-key` etc.)
      if (responses[ruleId]) return responses[ruleId];
      const prefix = ruleId.split("/")[0] ?? "";
      if (responses[prefix]) return responses[prefix];
      // Default: uncertain, low confidence.
      return JSON.stringify({
        verdict: "uncertain",
        confidence: 0.4,
        exploitPath: "",
        fixStrategy: "",
        fixTier: null,
      });
    },
  };
}

/**
 * Validate one finding end-to-end: extract the slice, render the
 * prompt, dispatch to the transport, parse the response.
 */
export async function validateFinding(
  finding: RawFinding,
  graph: SoftwareGraph,
  projectPath: string,
  transport: ValidatorTransport,
  model?: string,
): Promise<ValidatorResult> {
  const slice = await extractSlice(finding, graph, projectPath);
  const prompt = renderPrompt(slice);
  let raw = "";
  try {
    raw = await transport.validate(prompt, model);
  } catch (e) {
    raw = `transport_error: ${e instanceof Error ? e.message : String(e)}`;
  }
  return parseValidatorResponse(raw);
}
