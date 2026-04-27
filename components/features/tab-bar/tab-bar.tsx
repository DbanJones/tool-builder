"use client";

import { Plus, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { useOpenTabs, type OpenTab } from "@/lib/open-tabs";
import type { Project } from "@/lib/project";
import { sidecarCall } from "@/lib/sidecar/client";

// Browser-style tab strip across the top of the window. Each tab is one
// open project; the active tab is whichever /project?id=… is in the URL.
// A status pill on each tab pulses while that project's build is running,
// so the novice can see at a glance which project is currently spending.

const POLL_MS = 2000;

export function TabBar() {
  // useSearchParams suspends during the static prerender pass; wrap so the
  // root layout doesn't blow up when next build snapshots the shell.
  return (
    <Suspense fallback={<div className="h-9 shrink-0 border-b bg-muted/40" aria-hidden="true" />}>
      <TabBarInner />
    </Suspense>
  );
}

function TabBarInner() {
  const pathname = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const activeId = pathname === "/project" ? params.get("id") : null;
  const { tabs, close } = useOpenTabs();
  const [byId, setById] = useState<Map<string, Project>>(new Map());

  // Poll project status so each tab's pill stays fresh.
  useEffect(() => {
    if (tabs.length === 0) {
      setById(new Map());
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
          setById(m);
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
  }, [tabs.length]);

  const onClose = (id: string, e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    close(id);
    // If we just closed the active tab, navigate somewhere sane.
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
          project={byId.get(t.id) ?? null}
          active={t.id === activeId}
          onClose={(e) => onClose(t.id, e)}
        />
      ))}
      <Link
        href="/"
        aria-label="Open another project"
        title="Open another project"
        className="flex h-9 items-center px-2 text-muted-foreground hover:text-foreground"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
      </Link>
    </div>
  );
}

function Tab({
  tab,
  project,
  active,
  onClose,
}: {
  tab: OpenTab;
  project: Project | null;
  active: boolean;
  onClose: (e: React.MouseEvent) => void;
}) {
  const status = project?.status ?? null;
  const isRunning = status === "building";
  return (
    <Link
      href={`/project?id=${encodeURIComponent(tab.id)}`}
      title={project?.path ?? tab.name}
      aria-current={active ? "page" : undefined}
      className={
        "group relative flex h-9 max-w-[220px] items-center gap-2 border-r px-3 text-xs " +
        (active
          ? "border-b-2 border-b-primary bg-background text-foreground"
          : "text-muted-foreground hover:bg-background/60 hover:text-foreground")
      }
    >
      <StatusDot running={isRunning} idle={!isRunning && project !== null} />
      <span className="min-w-0 flex-1 truncate">{project?.name ?? tab.name}</span>
      <button
        type="button"
        onClick={onClose}
        aria-label={`Close ${project?.name ?? tab.name}`}
        className="ml-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground/60 opacity-0 hover:bg-muted hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
      >
        <X className="h-3 w-3" aria-hidden="true" />
      </button>
    </Link>
  );
}

function StatusDot({ running, idle }: { running: boolean; idle: boolean }) {
  if (running) {
    return (
      <span
        aria-label="Build running"
        className="relative inline-flex h-2 w-2 shrink-0"
      >
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60 motion-reduce:hidden" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
      </span>
    );
  }
  return (
    <span
      aria-label={idle ? "Idle" : "Loading"}
      className={
        "inline-block h-2 w-2 shrink-0 rounded-full " +
        (idle ? "bg-muted-foreground/40" : "bg-muted-foreground/20")
      }
    />
  );
}
