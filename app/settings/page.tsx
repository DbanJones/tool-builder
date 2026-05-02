"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  MODEL_IDS,
  STAGE_CATALOGUE,
  type ModelId,
  type Settings,
  type StageId,
  readSettings,
  resetAll,
  resolveModel,
  writeSettings,
} from "@/lib/settings";

// Per-stage model configuration. localStorage-backed; takes effect on
// the *next* session start for each stage (no hot-swap of an in-flight
// build). All overrides are optional — leaving a stage on "Default" is
// the recommended setting unless the novice has a specific reason.

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>({});
  // Initialise once on mount to avoid the flash of empty state.
  useEffect(() => {
    setSettings(readSettings());
  }, []);

  const setStage = (stage: StageId, value: ModelId | "default"): void => {
    const next: Settings = { ...settings };
    const models = { ...(next.models ?? {}) };
    if (value === "default") {
      delete models[stage];
    } else {
      models[stage] = value;
    }
    if (Object.keys(models).length === 0) {
      delete next.models;
    } else {
      next.models = models;
    }
    setSettings(next);
    writeSettings(next);
  };

  const resetEverything = (): void => {
    resetAll();
    setSettings({});
  };

  const overrideCount = settings.models ? Object.keys(settings.models).length : 0;

  return (
    <main className="flex min-h-full justify-center overflow-y-auto bg-background p-8">
      <div className="w-full max-w-3xl space-y-6">
        <div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Pick the model used at each stage. Defaults are the values the Builder ships
                with; overrides take effect the next time that stage runs.
              </p>
            </div>
            <Link
              href="/"
              className="text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              ← Back to home
            </Link>
          </div>
        </div>

        <Alert>
          <AlertTitle>How model choice affects cost and quality</AlertTitle>
          <AlertDescription className="text-xs">
            <span className="font-mono">opus-4-7</span> and{" "}
            <span className="font-mono">opus-4-5</span> are the most capable but ~5× the cost of
            sonnet. <span className="font-mono">sonnet-4-5</span> is a solid balance — the right
            default for long-running build sessions.{" "}
            <span className="font-mono">haiku-4-5</span> is fastest / cheapest but only suitable
            for short, structured tasks (validator adjudications, light tool-use loops).
          </AlertDescription>
        </Alert>

        <div className="space-y-3">
          {STAGE_CATALOGUE.map((stage) => {
            const current = resolveModel(stage.id, settings);
            const isOverride = settings.models?.[stage.id] !== undefined;
            return (
              <div
                key={stage.id}
                className="rounded-lg border bg-background p-4 shadow-sm"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <h2 className="text-sm font-semibold text-foreground">{stage.label}</h2>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {stage.description}
                    </p>
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      Default:{" "}
                      <span className="font-mono text-foreground">{stage.default}</span>
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <label className="sr-only" htmlFor={`stage-${stage.id}`}>
                      Model for {stage.label}
                    </label>
                    <select
                      id={`stage-${stage.id}`}
                      value={isOverride ? current : "default"}
                      onChange={(e) =>
                        setStage(
                          stage.id,
                          e.target.value === "default"
                            ? "default"
                            : (e.target.value as ModelId),
                        )
                      }
                      className="rounded-md border bg-background px-2 py-1.5 text-xs"
                    >
                      <option value="default">Default ({stage.default})</option>
                      {MODEL_IDS.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                    {isOverride ? (
                      <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                        Overridden
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between border-t pt-4">
          <p className="text-xs text-muted-foreground">
            {overrideCount === 0
              ? "All stages on default."
              : `${overrideCount} override${overrideCount === 1 ? "" : "s"} active.`}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={overrideCount === 0}
            onClick={resetEverything}
          >
            Reset all to defaults
          </Button>
        </div>
      </div>
    </main>
  );
}
