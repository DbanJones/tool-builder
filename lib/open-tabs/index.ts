"use client";

import { useCallback, useEffect, useState } from "react";

import type { Project } from "@/lib/project";
import { sidecarCall } from "@/lib/sidecar/client";

// Tabs in the strip are projects the novice has explicitly opened during
// this install. Two-layer state:
//
//   1. localStorage holds the curated list of *opened* project ids — that's
//      the source of truth for which tabs render.
//   2. sidecar.projects.list polls the live status (building / paused /
//      done / …) so the per-tab pill stays current. Polling is keyed by the
//      curated list so we never widen the visible set behind the user's
//      back.
//
// Adding a tab: a project is pushed into the curated list when its
// workspace mounts (so navigating to /project?id=X opens its tab). Closing
// removes the id from the curated list — the project itself stays in the
// DB, it just disappears from the strip.

const KEY = "builder.openTabs.v1";
const POLL_MS = 2000;

interface StoredEntry {
  id: string;
  /** Cached so the strip can render the name before the first poll lands. */
  name: string;
}

export interface TabSummary {
  id: string;
  name: string;
  /** null until the first sidecar poll resolves; treated as "loading". */
  status: Project["status"] | null;
}

function readStored(): StoredEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: StoredEntry[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const o = item as Record<string, unknown>;
      if (typeof o.id === "string" && typeof o.name === "string") {
        out.push({ id: o.id, name: o.name });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function writeStored(entries: readonly StoredEntry[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    /* quota / disabled — non-fatal. */
  }
}

export function useOpenTabs(): {
  tabs: readonly TabSummary[];
  ensureOpen: (entry: StoredEntry) => void;
  close: (id: string) => void;
} {
  const [stored, setStored] = useState<readonly StoredEntry[]>(() => readStored());
  const [statusById, setStatusById] = useState<Map<string, Project>>(new Map());

  // Cross-tab sync (relevant if we ever open multiple webview windows).
  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key === KEY) setStored(readStored());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Poll status for the curated set so the build pill pulses in near real
  // time. We deliberately don't widen `stored` from the poll result — the
  // curated list is the source of truth for *visibility*; the poll only
  // refreshes status of already-visible tabs (and prunes any whose project
  // has been deleted from the DB).
  useEffect(() => {
    if (stored.length === 0) {
      setStatusById(new Map());
      return;
    }
    let cancelled = false;
    const tick = async (): Promise<void> => {
      const r = await sidecarCall<Project[]>("projects.list", {});
      if (cancelled) return;
      r.match(
        (rows) => {
          const m = new Map<string, Project>();
          for (const p of rows) m.set(p.id, p);
          setStatusById(m);
          // Prune curated entries whose project no longer exists.
          const aliveIds = new Set(rows.map((p) => p.id));
          const pruned = stored.filter((e) => aliveIds.has(e.id));
          if (pruned.length !== stored.length) {
            setStored(pruned);
            writeStored(pruned);
          }
        },
        () => undefined,
      );
    };
    void tick();
    const handle = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [stored]);

  const ensureOpen = useCallback((entry: StoredEntry): void => {
    setStored((prev) => {
      const existing = prev.find((e) => e.id === entry.id);
      if (existing && existing.name === entry.name) return prev;
      const next = existing
        ? prev.map((e) => (e.id === entry.id ? { ...e, name: entry.name } : e))
        : [...prev, entry];
      writeStored(next);
      return next;
    });
  }, []);

  const close = useCallback((id: string): void => {
    setStored((prev) => {
      const next = prev.filter((e) => e.id !== id);
      writeStored(next);
      return next;
    });
  }, []);

  const tabs: TabSummary[] = stored.map((e) => {
    const live = statusById.get(e.id);
    return {
      id: e.id,
      name: live?.name ?? e.name,
      status: live?.status ?? null,
    };
  });

  return { tabs, ensureOpen, close };
}
