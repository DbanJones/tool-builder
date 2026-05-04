"use client";

import { ChevronDown, ChevronRight, Search } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Card } from "@/components/ui/card";
import type { Project } from "@/lib/project";
import { sidecarCall } from "@/lib/sidecar/client";

// Reusable project picker card. Used on /new-project for recovery + on
// the welcome page so the home view doubles as a launcher. Owns its own
// fetch/poll cycle so any host can drop it in without setting up state.

const POLL_MS = 4000;
// Below this many projects the search box is hidden — scanning a short
// list with the eye is faster than typing.
const SEARCH_THRESHOLD = 5;

function relativeTime(ms: number): string {
  const diff = Math.max(0, Date.now() - ms);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 30) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function statusBadgeClass(status: Project["status"]): string {
  switch (status) {
    case "building":
      return "bg-primary/15 text-primary";
    case "done":
      return "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400";
    case "paused":
      return "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400";
    case "ready":
      return "bg-muted text-muted-foreground";
    case "interviewing":
      return "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400";
  }
}

function statusDotClass(status: Project["status"]): string {
  switch (status) {
    case "building":
      return "bg-primary";
    case "done":
      return "bg-green-600";
    case "paused":
      return "bg-yellow-500";
    case "ready":
      return "bg-muted-foreground/40";
    case "interviewing":
      return "bg-blue-500";
  }
}

export interface ProjectsPickerProps {
  /** Heading shown in the collapsed header (default "Your projects"). */
  title?: string;
  /** Whether the card is collapsable. When false the list is always expanded. */
  collapsable?: boolean;
  /** Initial expanded state when collapsable. Ignored when collapsable=false. */
  defaultOpen?: boolean;
  /** localStorage key for persisting the expanded state. Omit (or pass null)
   *  to disable persistence — the picker then always mounts at `defaultOpen`. */
  persistKey?: string | null;
  /** Override on what to show when the project list is empty (e.g. a CTA).
   *  Default behaviour: render nothing, so the host can decide. */
  emptyContent?: React.ReactNode;
}

export function ProjectsPicker({
  title = "Your projects",
  collapsable = true,
  defaultOpen = false,
  persistKey = null,
  emptyContent = null,
}: ProjectsPickerProps) {
  const [projects, setProjects] = useState<readonly Project[] | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  // SSR + first client render must agree, so the initial value is the prop only;
  // any persisted state is hydrated in a useEffect.
  const [isOpen, setIsOpen] = useState<boolean>(collapsable ? defaultOpen : true);
  const searchRef = useRef<HTMLInputElement>(null);
  const didMountRef = useRef(false);

  useEffect(() => {
    if (!collapsable || !persistKey || typeof window === "undefined") return;
    const stored = window.localStorage.getItem(persistKey);
    if (stored !== null) setIsOpen(stored === "true");
  }, [collapsable, persistKey]);

  useEffect(() => {
    if (!collapsable || !persistKey || typeof window === "undefined") return;
    window.localStorage.setItem(persistKey, String(isOpen));
  }, [isOpen, collapsable, persistKey]);

  // Auto-focus the search input when the user expands the picker (skip the
  // initial mount so we don't steal focus on page load).
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    if (isOpen) searchRef.current?.focus();
  }, [isOpen]);

  const fetchProjects = useCallback(async (): Promise<void> => {
    const r = await sidecarCall<Project[]>("projects.list", {});
    r.match(
      (rows) => setProjects(rows),
      () => setProjects((prev) => prev ?? []),
    );
  }, []);

  useEffect(() => {
    void fetchProjects();
    const handle = setInterval(() => void fetchProjects(), POLL_MS);
    return () => clearInterval(handle);
  }, [fetchProjects]);

  const filteredProjects = useMemo<readonly Project[]>(() => {
    if (projects === null) return [];
    const sorted = [...projects].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
    const q = searchQuery.trim().toLowerCase();
    if (q.length === 0) return sorted;
    return sorted.filter(
      (p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q),
    );
  }, [projects, searchQuery]);

  if (projects === null) return null;
  if (projects.length === 0) return <>{emptyContent}</>;

  const showSearch = projects.length > SEARCH_THRESHOLD;

  const body = (
    <>
      {showSearch ? (
        <div className="border-b px-6 py-3">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              ref={searchRef}
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by name or path…"
              aria-label="Filter projects by name or path"
              className="block w-full rounded-md border border-input bg-background py-1.5 pl-8 pr-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            />
          </div>
        </div>
      ) : null}
      {filteredProjects.length === 0 ? (
        <p className="px-6 py-4 text-sm text-muted-foreground">
          No projects match.{" "}
          <button
            type="button"
            onClick={() => setSearchQuery("")}
            className="underline hover:text-foreground"
          >
            Clear
          </button>
        </p>
      ) : (
        <ul className="max-h-96 divide-y overflow-y-auto" role="list">
          {filteredProjects.map((p) => (
            <li key={p.id}>
              <Link
                href={`/project?id=${encodeURIComponent(p.id)}`}
                className="group flex items-center gap-4 px-6 py-3 transition-colors hover:bg-muted/40 focus-visible:bg-muted/60 focus-visible:outline-none"
              >
                <span
                  className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold uppercase tracking-tight text-muted-foreground"
                  aria-hidden="true"
                >
                  {p.name.replace(/[^a-zA-Z0-9]/g, "").slice(0, 2) || "—"}
                  <span
                    className={
                      "absolute -bottom-0.5 -right-0.5 inline-block h-2.5 w-2.5 rounded-full ring-2 ring-background " +
                      statusDotClass(p.status)
                    }
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="truncate text-sm font-medium text-foreground">{p.name}</p>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {relativeTime(p.lastOpenedAt)}
                    </span>
                  </div>
                  <p className="truncate font-mono text-[11px] text-muted-foreground">
                    {p.path}
                  </p>
                </div>
                <span
                  className={
                    "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide " +
                    statusBadgeClass(p.status)
                  }
                >
                  {p.status}
                </span>
                <ChevronRight
                  className="h-4 w-4 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground"
                  aria-hidden="true"
                />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );

  return (
    <Card className="overflow-hidden">
      {collapsable ? (
        <button
          type="button"
          onClick={() => setIsOpen((v) => !v)}
          aria-expanded={isOpen}
          aria-controls="projects-picker-list"
          className="flex w-full items-center justify-between gap-3 px-6 py-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              {title}
              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                {projects.length}
              </span>
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {isOpen
                ? "Click any project to add it back to your tabs."
                : `Last touched ${relativeTime(filteredProjects[0]!.lastOpenedAt)}.`}
            </p>
          </div>
          {isOpen ? (
            <ChevronDown className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          )}
        </button>
      ) : (
        <div className="px-6 py-4">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            {title}
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              {projects.length}
            </span>
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Click any project to add it back to your tabs.
          </p>
        </div>
      )}
      {!collapsable || isOpen ? (
        <div id="projects-picker-list" className="border-t">
          {body}
        </div>
      ) : null}
    </Card>
  );
}
