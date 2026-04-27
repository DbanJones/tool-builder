"use client";

import { useEffect, useState } from "react";

import type { Project } from "@/lib/project";
import { sidecarCall } from "@/lib/sidecar/client";

// Tab strip state. Tabs ARE the projects in the DB (every non-deleted
// project shows up as a tab automatically). The novice doesn't have to
// "open" a project to see it in the strip — that mental model was confusing
// and meant builds running in another project couldn't be seen at a glance.
//
// We keep a localStorage cache of the project list so the strip renders
// instantly on cold start, then refresh from the sidecar every POLL_MS so
// build-status pills + name changes stay current.

const CACHE_KEY = "builder.openTabs.v2";
const POLL_MS = 2000;

export interface TabSummary {
  id: string;
  name: string;
  /** Mirrors Project.status so the tab pill can render running/idle/done. */
  status: Project["status"];
  lastOpenedAt: number;
}

function readCache(): TabSummary[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: TabSummary[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const o = item as Record<string, unknown>;
      if (
        typeof o.id === "string" &&
        typeof o.name === "string" &&
        typeof o.status === "string" &&
        typeof o.lastOpenedAt === "number"
      ) {
        out.push({
          id: o.id,
          name: o.name,
          status: o.status as Project["status"],
          lastOpenedAt: o.lastOpenedAt,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function writeCache(tabs: readonly TabSummary[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(tabs));
  } catch {
    /* quota / disabled — non-fatal, just no instant render on next reload. */
  }
}

function projectsToTabs(projects: readonly Project[]): TabSummary[] {
  return [...projects]
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    .map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      lastOpenedAt: p.lastOpenedAt,
    }));
}

/**
 * Hook backing the tab strip. Returns tabs derived from sidecar.projects.list,
 * polled every 2s so build status pulses propagate without manual refresh.
 *
 * We render an immediate first frame from the localStorage cache so the strip
 * doesn't blink empty between mount and the first poll's resolution.
 */
export function useOpenTabs(): { tabs: readonly TabSummary[] } {
  const [tabs, setTabs] = useState<readonly TabSummary[]>(() => readCache());

  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      const r = await sidecarCall<Project[]>("projects.list", {});
      if (cancelled) return;
      r.match(
        (projects) => {
          const next = projectsToTabs(projects);
          setTabs(next);
          writeCache(next);
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
  }, []);

  return { tabs };
}
