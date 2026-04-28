"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { open } from "@tauri-apps/plugin-dialog";
import { ChevronDown, ChevronRight, FolderOpen, Loader2, RefreshCw, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { createProject, sanitiseProjectName, type Project } from "@/lib/project";
import { sidecarCall } from "@/lib/sidecar/client";

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

const ALL_STATUSES: readonly Project["status"][] = [
  "interviewing",
  "ready",
  "building",
  "paused",
  "done",
];

type SortKey = "lastOpened" | "created" | "name";

const SORT_OPTIONS: readonly { key: SortKey; label: string }[] = [
  { key: "lastOpened", label: "Last opened" },
  { key: "created", label: "Created" },
  { key: "name", label: "Name" },
];

function sortProjects(
  projects: readonly Project[],
  key: SortKey,
): readonly Project[] {
  const copy = [...projects];
  switch (key) {
    case "lastOpened":
      return copy.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
    case "created":
      return copy.sort((a, b) => b.createdAt - a.createdAt);
    case "name":
      return copy.sort((a, b) => a.name.localeCompare(b.name));
  }
}

const POLL_MS = 4000;

const FormSchema = z.object({
  name: z
    .string()
    .min(1, "Project name is required")
    .max(200, "Project name is too long (200 characters max)")
    .refine((n) => sanitiseProjectName(n) !== null, {
      message:
        "Project name needs at least one letter or digit (after stripping punctuation/emoji).",
    }),
  folder: z.string().min(1, "Folder is required"),
});

type FormValues = z.infer<typeof FormSchema>;

const SAFE_DEFAULT_FOLDER = "~/Documents/ClaudeBuilds";

/**
 * The previous-session folder from localStorage IF it still looks safe;
 * otherwise the safe default. Live test 2026-04-27: a user picked the
 * Builder app's own source folder once, the choice was persisted, and
 * every subsequent project landed in the Builder repo and broke claude.
 */
function pickDefaultFolder(): string {
  if (typeof window === "undefined") return SAFE_DEFAULT_FOLDER;
  const last = window.localStorage.getItem("builder.lastProjectFolder");
  if (!last) return SAFE_DEFAULT_FOLDER;
  // Heuristic: refuse paths that smell like a dev repo or the Builder.
  const lower = last.toLowerCase();
  const looksUnsafe =
    lower.includes("/tool builder") ||
    lower.includes("/src-tauri") ||
    lower.includes("/sidecar") ||
    lower.endsWith("/airtec/coding") ||
    lower.includes("/onedrive/") ||
    lower.includes("/icloud") ||
    lower.includes("library/cloudstorage");
  return looksUnsafe ? SAFE_DEFAULT_FOLDER : last;
}

export default function NewProjectPage() {
  const router = useRouter();
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  // Existing-project recovery: list everything in the DB so the novice
  // can re-open a project whose tab was closed (or lost via the prune
  // bug fixed alongside this list).
  const [existingProjects, setExistingProjects] = useState<readonly Project[] | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  // Search by name + path (case-insensitive). Filter by status (empty set =
  // all). Sort key drives the order. Refresh button + a 4s poll keep the
  // list current with the DB so a project created from elsewhere shows up
  // without a manual reload.
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<ReadonlySet<Project["status"]>>(
    new Set(),
  );
  const [sortKey, setSortKey] = useState<SortKey>("lastOpened");
  // Collapsed by default — creating a new project is the primary task on
  // this page; the recovery list is one click away. Persist the preference
  // so users who use the recovery list often don't have to re-expand.
  const [isExistingOpen, setIsExistingOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("builder.newProject.existingOpen") === "true";
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      "builder.newProject.existingOpen",
      String(isExistingOpen),
    );
  }, [isExistingOpen]);

  const fetchProjects = useCallback(async (): Promise<void> => {
    const r = await sidecarCall<Project[]>("projects.list", {});
    r.match(
      (rows) => setExistingProjects(rows),
      () => setExistingProjects((prev) => prev ?? []),
    );
  }, []);

  // Initial load + 4s poll. Polling is cheap (single sqlite query against a
  // local file) and means a project created via another path shows up in
  // the recovery list without the user having to reload.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await fetchProjects();
      if (cancelled) return;
    })();
    const handle = setInterval(() => void fetchProjects(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [fetchProjects]);

  const onRefresh = async (): Promise<void> => {
    setIsRefreshing(true);
    try {
      await fetchProjects();
    } finally {
      setIsRefreshing(false);
    }
  };

  const filteredProjects = useMemo<readonly Project[]>(() => {
    if (existingProjects === null) return [];
    const q = searchQuery.trim().toLowerCase();
    let out: readonly Project[] = existingProjects;
    if (q.length > 0) {
      out = out.filter(
        (p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q),
      );
    }
    if (statusFilter.size > 0) {
      out = out.filter((p) => statusFilter.has(p.status));
    }
    return sortProjects(out, sortKey);
  }, [existingProjects, searchQuery, statusFilter, sortKey]);

  const toggleStatus = (s: Project["status"]): void => {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  };
  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      folder: pickDefaultFolder(),
    },
  });

  const browseFolder = async (): Promise<void> => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string" && picked.length > 0) {
      setValue("folder", picked, { shouldValidate: true, shouldDirty: true });
      window.localStorage.setItem("builder.lastProjectFolder", picked);
    }
  };

  const watchedName = watch("name") ?? "";
  const sanitisedFolder = watchedName ? sanitiseProjectName(watchedName) : null;

  const onSubmit = async (values: FormValues): Promise<void> => {
    setSubmissionError(null);
    const result = await createProject(values.name, values.folder);
    result.match(
      (project) => {
        router.push(`/project?id=${encodeURIComponent(project.id)}`);
      },
      (error) => {
        setSubmissionError(error.message);
      },
    );
  };

  const hasExisting = existingProjects !== null && existingProjects.length > 0;

  return (
    <main className="flex min-h-full items-center justify-center bg-background p-8">
      <div className="w-full max-w-2xl space-y-4">
        {hasExisting ? (
          <Card className="overflow-hidden">
            <button
              type="button"
              onClick={() => setIsExistingOpen((v) => !v)}
              aria-expanded={isExistingOpen}
              aria-controls="existing-projects-list"
              className="flex w-full items-center justify-between gap-3 px-6 py-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            >
              <div className="min-w-0">
                <h2 className="flex items-center gap-2 text-base font-semibold">
                  Your projects
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                    {existingProjects.length}
                  </span>
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {isExistingOpen
                    ? "Click any project to add it back to your tabs."
                    : `Reopen a previous project. Last touched ${relativeTime(existingProjects[0]!.lastOpenedAt)}.`}
                </p>
              </div>
              {isExistingOpen ? (
                <ChevronDown
                  className="h-5 w-5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              ) : (
                <ChevronRight
                  className="h-5 w-5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              )}
            </button>
            {isExistingOpen ? (
              <div id="existing-projects-list" className="border-t">
                <div className="flex flex-wrap items-center gap-2 px-6 py-3">
                  <div className="relative min-w-0 flex-1">
                    <Search
                      className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <input
                      type="search"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search by name or path…"
                      aria-label="Filter projects by name or path"
                      className="block w-full rounded-md border border-input bg-background py-1.5 pl-8 pr-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    />
                  </div>
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="sr-only sm:not-sr-only">Sort by</span>
                    <select
                      value={sortKey}
                      onChange={(e) => setSortKey(e.target.value as SortKey)}
                      className="rounded-md border border-input bg-background px-2 py-1.5 text-xs ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label="Sort projects"
                    >
                      {SORT_OPTIONS.map((o) => (
                        <option key={o.key} value={o.key}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={() => void onRefresh()}
                    aria-label="Refresh project list"
                    title="Refresh project list"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <RefreshCw
                      className={
                        "h-4 w-4 " + (isRefreshing ? "animate-spin motion-reduce:animate-none" : "")
                      }
                      aria-hidden="true"
                    />
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 px-6 pb-3 text-xs">
                  <span className="text-muted-foreground">Status:</span>
                  <button
                    type="button"
                    onClick={() => setStatusFilter(new Set())}
                    aria-pressed={statusFilter.size === 0}
                    className={
                      "rounded-full px-2.5 py-0.5 transition-colors " +
                      (statusFilter.size === 0
                        ? "bg-foreground text-background"
                        : "bg-muted text-muted-foreground hover:bg-muted-foreground/20")
                    }
                  >
                    All
                  </button>
                  {ALL_STATUSES.map((s) => {
                    const active = statusFilter.has(s);
                    return (
                      <button
                        key={s}
                        type="button"
                        onClick={() => toggleStatus(s)}
                        aria-pressed={active}
                        className={
                          "flex items-center gap-1.5 rounded-full px-2.5 py-0.5 transition-colors " +
                          (active
                            ? statusBadgeClass(s) + " ring-1 ring-current/30"
                            : "bg-muted text-muted-foreground hover:bg-muted-foreground/20")
                        }
                      >
                        <span
                          className={"inline-block h-1.5 w-1.5 rounded-full " + statusDotClass(s)}
                          aria-hidden="true"
                        />
                        {s}
                      </button>
                    );
                  })}
                </div>
                {filteredProjects.length === 0 ? (
                  <p className="px-6 pb-4 text-sm text-muted-foreground">
                    No projects match your filters.{" "}
                    <button
                      type="button"
                      onClick={() => {
                        setSearchQuery("");
                        setStatusFilter(new Set());
                      }}
                      className="underline hover:text-foreground"
                    >
                      Clear
                    </button>
                  </p>
                ) : (
                  <ul className="divide-y border-t" role="list">
                    {filteredProjects.map((p) => (
                      <li key={p.id}>
                    <Link
                      href={`/project?id=${encodeURIComponent(p.id)}`}
                      className="group flex items-center gap-4 px-6 py-3 transition-colors hover:bg-muted/40 focus-visible:bg-muted/60 focus-visible:outline-none"
                    >
                      <span
                        className={
                          "relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold uppercase tracking-tight text-muted-foreground"
                        }
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
                          <p className="truncate text-sm font-medium text-foreground">
                            {p.name}
                          </p>
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
              </div>
            ) : null}
          </Card>
        ) : null}
        <Card>
          <CardHeader>
            <CardTitle>
              {hasExisting ? "Create a new project" : "Create your first project"}
            </CardTitle>
            <CardDescription>
              The Builder will create a new folder for your project, initialise it as a git
              repository, and seed it with placeholder templates.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={(e) => {
                void handleSubmit(onSubmit)(e);
              }}
              className="space-y-6"
              noValidate
            >
              <div className="space-y-2">
                <label htmlFor="name" className="text-sm font-medium">
                  Project name
                </label>
                <input
                  id="name"
                  type="text"
                  autoComplete="off"
                  className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  aria-invalid={errors.name !== undefined}
                  aria-describedby={errors.name ? "name-error" : "name-hint"}
                  {...register("name")}
                />
                {errors.name ? (
                  <p id="name-error" className="text-sm text-destructive">
                    {errors.name.message}
                  </p>
                ) : sanitisedFolder ? (
                  <p id="name-hint" className="text-sm text-muted-foreground">
                    Folder will be{" "}
                    <span className="font-mono">{sanitisedFolder}</span>; the display name in the
                    Builder stays <span className="font-mono">{watchedName}</span>.
                  </p>
                ) : (
                  <p id="name-hint" className="text-sm text-muted-foreground">
                    Anything goes. Example: <span className="font-mono">PrepPilot</span> or{" "}
                    <span className="font-mono">My Cool App</span>.
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <label htmlFor="folder" className="text-sm font-medium">
                  Where to put it
                </label>
                <div className="flex gap-2">
                  <input
                    id="folder"
                    type="text"
                    className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    aria-invalid={errors.folder !== undefined}
                    aria-describedby={errors.folder ? "folder-error" : "folder-hint"}
                    {...register("folder")}
                  />
                  <Button type="button" variant="outline" onClick={() => void browseFolder()}>
                    <FolderOpen className="mr-1 h-4 w-4" aria-hidden="true" />
                    Browse
                  </Button>
                </div>
                {errors.folder ? (
                  <p id="folder-error" className="text-sm text-destructive">
                    {errors.folder.message}
                  </p>
                ) : (
                  <p id="folder-hint" className="text-sm text-muted-foreground">
                    Default is <span className="font-mono">~/Documents/ClaudeBuilds</span>; the
                    project folder will be created inside. Your last choice is remembered.
                  </p>
                )}
              </div>

              {submissionError !== null && (
                <Alert variant="destructive">
                  <AlertTitle>Could not create the project</AlertTitle>
                  <AlertDescription>{submissionError}</AlertDescription>
                </Alert>
              )}

              <Button type="submit" disabled={isSubmitting} aria-live="polite">
                {isSubmitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                    Creating...
                  </>
                ) : (
                  "Create project"
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
