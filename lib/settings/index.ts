"use client";

import { z } from "zod";

// User settings: per-stage model overrides. Persisted to localStorage
// (single value across projects, same pattern as the cost-cap and the
// right-rail width). Read once at app start; writes immediately. The
// drivers receive the chosen model on each session start via the
// existing `chat.start` / `orch.start` / `research.start` RPC params.
//
// All fields are optional — when a stage is unset, the driver falls
// back to its hardcoded default. That keeps existing projects (and
// integration tests) on known-good models when settings are empty.

const STORAGE_KEY = "dave-builder.settings.v1";

// Allowed model ids. Pinned to the Claude 4.x family currently used
// across the codebase (chat-driver, orchestrator-driver, research-
// driver). Adding a new model here is a one-line change; the SDK
// accepts unknown strings too but we keep the dropdown bounded.
export const MODEL_IDS = [
  "claude-opus-4-7",
  "claude-opus-4-5",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
] as const;

export type ModelId = (typeof MODEL_IDS)[number];

// One enum entry per stage that consults a model. Stage ids are
// stable strings — they appear in the localStorage payload and in
// the Tauri/sidecar RPC params. Renaming a stage is a migration.
export const STAGE_IDS = [
  "interview_first_turn",
  "interview_resume",
  "build",
  "research",
  "debug_validator",
  "repair",
] as const;

export type StageId = (typeof STAGE_IDS)[number];

export interface StageDescriptor {
  id: StageId;
  label: string;
  description: string;
  /** Built-in default the driver uses when the stage is unset. */
  default: ModelId;
}

// Source of truth for the settings page UI. Stays in sync with the
// driver hardcoded values — when a default changes in a driver, bump
// it here in the same commit.
export const STAGE_CATALOGUE: readonly StageDescriptor[] = [
  {
    id: "interview_first_turn",
    label: "Interview · first turn",
    description:
      "Opens the conversation when the novice describes the project. Heavier model gives a stronger first impression and a better question batch.",
    default: "claude-opus-4-5",
  },
  {
    id: "interview_resume",
    label: "Interview · subsequent turns",
    description:
      "Drives the rest of the recursive interview. Faster + cheaper makes sense once the question bank exists.",
    default: "claude-sonnet-4-5",
  },
  {
    id: "research",
    label: "Deep research",
    description:
      "Expands the spec before any code is written. Tool-aware (WebSearch / WebFetch / Read). Heavier model usually buys real research depth.",
    default: "claude-opus-4-5",
  },
  {
    id: "build",
    label: "Build orchestration",
    description:
      "The agent that writes the target app's code. The session can run for hours with hundreds of tool calls, so cost compounds.",
    default: "claude-sonnet-4-5",
  },
  {
    id: "debug_validator",
    label: "Debug · Layer 2 validator",
    description:
      "Adjudicates Layer 1 detector findings (real / false_positive / uncertain). Runs once per finding; speed > depth.",
    default: "claude-sonnet-4-5",
  },
  {
    id: "repair",
    label: "Debug · Tier 2 repair patcher",
    description:
      "Generates the failing-test → patch → verify loop for findings the deterministic codemods can't fix.",
    default: "claude-sonnet-4-5",
  },
];

const SettingsSchema = z.object({
  models: z.record(z.enum(STAGE_IDS), z.enum(MODEL_IDS)).optional(),
});

export type Settings = z.infer<typeof SettingsSchema>;

const DEFAULT_SETTINGS: Settings = {};

/** Read the current settings blob from localStorage. Returns the
 *  empty object on any parse / read failure so the rest of the app
 *  always sees a usable shape. */
export function readSettings(): Settings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_SETTINGS;
    const parsed: unknown = JSON.parse(raw);
    const validated = SettingsSchema.safeParse(parsed);
    return validated.success ? validated.data : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** Persist the entire settings blob. Callers that want to update a
 *  single field should `readSettings` → mutate → `writeSettings`. */
export function writeSettings(next: Settings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* localStorage unavailable / quota — silent (cosmetic feature) */
  }
}

/** Resolve the active model for a stage. Looks at the stored override
 *  first, falls back to the catalogue default. Drivers should NOT
 *  call readSettings themselves — the webview owns settings; pass
 *  the resolved model into the driver via the start-RPC params. */
export function resolveModel(stage: StageId, settings: Settings = readSettings()): ModelId {
  const override = settings.models?.[stage];
  if (override !== undefined) return override;
  const cat = STAGE_CATALOGUE.find((s) => s.id === stage);
  // The catalogue is a const so this is exhaustive; assertNever-style
  // fallback to opus-4-5 in case a stage id is added without bumping
  // the catalogue.
  return cat?.default ?? "claude-opus-4-5";
}

/** Clear a single stage's override (revert to default). */
export function resetStage(stage: StageId): void {
  const next = readSettings();
  if (next.models !== undefined) {
    delete next.models[stage];
    if (Object.keys(next.models).length === 0) {
      delete next.models;
    }
  }
  writeSettings(next);
}

/** Clear every override (factory reset). */
export function resetAll(): void {
  writeSettings(DEFAULT_SETTINGS);
}

/** Apply one model id as the override for *every* stage. Used by the
 *  chat shortcut "use opus" / "use sonnet" / "use haiku" — finer-
 *  grained per-stage control still goes through the Settings page. */
export function setAllStages(model: ModelId): void {
  const next: Settings = { models: {} };
  for (const stage of STAGE_IDS) {
    next.models![stage] = model;
  }
  writeSettings(next);
}
