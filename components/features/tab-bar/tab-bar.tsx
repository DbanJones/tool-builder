"use client";

import { FilePlus, Plus, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";

import { useOpenTabs, type TabSummary } from "@/lib/open-tabs";

// Tab strip across the top of the window. Tabs ARE the projects in the DB —
// every project shows up automatically, sorted by lastOpenedAt. The strip's
// job is to make it obvious which projects exist, which is active, and which
// are currently building.

export function TabBar() {
  // useSearchParams suspends during the static prerender pass; wrap so the
  // root layout doesn't blow up when next build snapshots the shell.
  return (
    <Suspense
      fallback={<div className="h-9 shrink-0 border-b bg-muted/40" aria-hidden="true" />}
    >
      <TabBarInner />
    </Suspense>
  );
}

function TabBarInner() {
  const pathname = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const activeId = pathname === "/project" ? params.get("id") : null;
  const onNewProjectRoute = pathname === "/new-project";
  const { tabs, close } = useOpenTabs();
  const buildingCount = tabs.filter((t) => t.status === "building").length;

  const onClose = (id: string, e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    close(id);
    if (id === activeId) {
      const remaining = tabs.filter((t) => t.id !== id);
      router.push(remaining[0] ? `/project?id=${encodeURIComponent(remaining[0].id)}` : "/");
    }
  };

  return (
    <div className="flex h-9 shrink-0 items-end gap-0 border-b bg-muted/40">
      <Link
        href="/"
        aria-label="Builder home"
        className={
          "flex h-9 items-center px-3 text-xs font-semibold " +
          (activeId === null && pathname === "/"
            ? "border-b-2 border-primary text-foreground"
            : "text-muted-foreground hover:text-foreground")
        }
      >
        Builder
      </Link>
      {tabs.map((t) => (
        <Tab
          key={t.id}
          tab={t}
          active={t.id === activeId}
          onClose={(e) => onClose(t.id, e)}
        />
      ))}
      {onNewProjectRoute ? <NewProjectTab /> : null}
      <Link
        href="/new-project"
        aria-label="Open another project"
        title="Open a new project tab"
        className="flex h-9 items-center px-2 text-muted-foreground hover:text-foreground"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
      </Link>
      {buildingCount > 0 ? (
        <span
          className="ml-auto flex items-center gap-1.5 px-3 text-[11px] font-medium text-primary"
          aria-live="polite"
        >
          <span className="relative inline-flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60 motion-reduce:hidden" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
          </span>
          {buildingCount} building
        </span>
      ) : null}
    </div>
  );
}

function Tab({
  tab,
  active,
  onClose,
}: {
  tab: TabSummary;
  active: boolean;
  onClose: (e: React.MouseEvent) => void;
}) {
  const isRunning = tab.status === "building";
  return (
    <Link
      href={`/project?id=${encodeURIComponent(tab.id)}`}
      title={tab.name}
      aria-current={active ? "page" : undefined}
      className={
        "group relative flex h-9 max-w-[220px] items-center gap-2 border-r px-3 text-xs " +
        (active
          ? "border-b-2 border-b-primary bg-background text-foreground"
          : "text-muted-foreground hover:bg-background/60 hover:text-foreground")
      }
    >
      <StatusDot status={tab.status} />
      <span className="min-w-0 flex-1 truncate">{tab.name}</span>
      {isRunning ? (
        <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide text-primary">
          building
        </span>
      ) : null}
      <button
        type="button"
        onClick={onClose}
        aria-label={`Close ${tab.name}`}
        className="ml-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground/60 opacity-0 hover:bg-muted hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
      >
        <X className="h-3 w-3" aria-hidden="true" />
      </button>
    </Link>
  );
}

// Synthetic tab shown while the user is on /new-project. Replaced by the
// real project tab once createProject succeeds and routes to /project?id=…
function NewProjectTab() {
  return (
    <div
      aria-current="page"
      className="relative flex h-9 max-w-[220px] items-center gap-2 border-r border-b-2 border-b-primary bg-background px-3 text-xs text-foreground"
    >
      <FilePlus className="h-3 w-3 shrink-0 text-primary" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">New project</span>
    </div>
  );
}

function StatusDot({ status }: { status: TabSummary["status"] }) {
  if (status === "building") {
    return (
      <span aria-label="Build running" className="relative inline-flex h-2 w-2 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60 motion-reduce:hidden" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
      </span>
    );
  }
  if (status === "done") {
    return (
      <span
        aria-label="Done"
        className="inline-block h-2 w-2 shrink-0 rounded-full bg-green-600"
      />
    );
  }
  if (status === "paused") {
    return (
      <span
        aria-label="Paused"
        className="inline-block h-2 w-2 shrink-0 rounded-full bg-yellow-500"
      />
    );
  }
  return (
    <span
      aria-label={status ?? "loading"}
      className="inline-block h-2 w-2 shrink-0 rounded-full bg-muted-foreground/40"
    />
  );
}
