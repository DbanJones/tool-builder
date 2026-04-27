"use client";

import { useCallback, useEffect, useState } from "react";

// Browser-style tab strip across the top of the workspace. Open tabs are
// remembered between sessions so closing the app and reopening lands the
// novice back where they were.
//
// localStorage is the right scope: open-tab state is per-install, not
// per-project, and we don't need it cross-process. The DB is project state;
// this is UI state that wraps it.

const KEY = "builder.openTabs.v1";

export interface OpenTab {
  id: string;
  name: string;
}

function read(): OpenTab[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: OpenTab[] = [];
    for (const item of parsed) {
      if (
        typeof item === "object" &&
        item !== null &&
        "id" in item &&
        "name" in item &&
        typeof (item as { id: unknown }).id === "string" &&
        typeof (item as { name: unknown }).name === "string"
      ) {
        out.push({
          id: (item as { id: string }).id,
          name: (item as { name: string }).name,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function write(tabs: readonly OpenTab[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(tabs));
  } catch {
    /* localStorage quota or disabled — non-fatal, tabs just don't persist. */
  }
}

// React hook that reads + writes through. Cross-component sync is via the
// `storage` event so opening a project in tab A reflects in the bar
// rendered by tab B (relevant once we move multi-window).
export function useOpenTabs(): {
  tabs: readonly OpenTab[];
  ensureOpen: (tab: OpenTab) => void;
  close: (id: string) => void;
  rename: (id: string, name: string) => void;
} {
  const [tabs, setTabs] = useState<readonly OpenTab[]>(() => read());

  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key === KEY) setTabs(read());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const ensureOpen = useCallback((tab: OpenTab): void => {
    setTabs((prev) => {
      const existing = prev.find((t) => t.id === tab.id);
      if (existing && existing.name === tab.name) return prev;
      const next = existing
        ? prev.map((t) => (t.id === tab.id ? { ...t, name: tab.name } : t))
        : [...prev, tab];
      write(next);
      return next;
    });
  }, []);

  const close = useCallback((id: string): void => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      write(next);
      return next;
    });
  }, []);

  const rename = useCallback((id: string, name: string): void => {
    setTabs((prev) => {
      const next = prev.map((t) => (t.id === id ? { ...t, name } : t));
      write(next);
      return next;
    });
  }, []);

  return { tabs, ensureOpen, close, rename };
}
