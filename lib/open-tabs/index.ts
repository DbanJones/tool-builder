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
// Browser quirk: the `storage` event fires only in OTHER windows that share
// the same localStorage origin — never in the window that did the write.
// Without an in-window signal, the TabBar (mounted in the root layout)
// never re-reads localStorage after the workspace component calls
// `ensureOpen`, so the active project's tab disappears until full reload.
// Dispatch a CustomEvent on every write and listen for it alongside the
// cross-window `storage` event.
const SAME_WINDOW_EVENT = "builder.openTabs.changed";

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
    window.dispatchEvent(new CustomEvent(SAME_WINDOW_EVENT));
  } catch {
    /* quota / disabled — non-fatal. */
  }
}

export function useOpenTabs(): {
  tabs: readonly TabSummary[];
  ensureOpen: (entry: StoredEntry) => void;
  close: (id: string) => void;
} {
  // Initial state is always empty so the SSR / static-export render matches
  // the first client render (no hydration mismatch). The first client-side
  // effect rehydrates from localStorage on mount.
  const [stored, setStored] = useState<readonly StoredEntry[]>([]);
  const [statusById, setStatusById] = useState<Map<string, Project>>(new Map());

  useEffect(() => {
    setStored(readStored());
  }, []);

  // Cross-window sync (storage event fires in OTHER windows only).
  // Same-window sync (CustomEvent dispatched on every writeStored, picked
  // up by every useOpenTabs consumer in the same window — including the
  // TabBar mounted in the root layout that doesn't itself call ensureOpen).
  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key === KEY) setStored(readStored());
    };
    const onSameWindow = (): void => setStored(readStored());
    window.addEventListener("storage", onStorage);
    window.addEventListener(SAME_WINDOW_EVENT, onSameWindow);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(SAME_WINDOW_EVENT, onSameWindow);
    };
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
          // Deliberately NOT pruning curated entries that don't appear in
          // `rows` — a transient sidecar hiccup that returns [] would
          // otherwise wipe every tab from localStorage (lost a real
          // project once that way). If a project is genuinely deleted the
          // user can close its tab manually with the X.
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

  // localStorage is the source of truth; React state mirrors it. We read
  // the current persisted list synchronously, compute the next snapshot,
  // then call writeStored (which dispatches the cross-component CustomEvent)
  // BEFORE setStored. The previous version called writeStored inside the
  // setState updater function, which ran during render and triggered a
  // setState on TabBarInner from inside ProjectWorkspace's render — React
  // 19 errors on that ("Cannot update a component while rendering").
  const ensureOpen = useCallback((entry: StoredEntry): void => {
    const current = readStored();
    const existing = current.find((e) => e.id === entry.id);
    if (existing && existing.name === entry.name) return;
    const next = existing
      ? current.map((e) => (e.id === entry.id ? { ...e, name: entry.name } : e))
      : [...current, entry];
    writeStored(next);
    setStored(next);
  }, []);

  const close = useCallback((id: string): void => {
    const current = readStored();
    if (!current.some((e) => e.id === id)) return;
    const next = current.filter((e) => e.id !== id);
    writeStored(next);
    setStored(next);
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
