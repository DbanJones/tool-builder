"use client";

import { Menu } from "@base-ui/react/menu";
import {
  ChevronDown,
  ExternalLink,
  GitBranch,
  Globe,
  Loader2,
  Pencil,
  Play,
  Rocket,
  Sparkles,
  Square,
} from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";

// Single header dropdown that absorbs every action that used to live as
// its own button across the workspace's top row. The dropdown is the
// only thing visible by default; opening it reveals a context-filtered
// menu (the same gating logic as the prior inline buttons) so the
// novice still sees just the moves that are valid in their current
// state. Disabled items render in muted form with the disable reason
// in the title, mirroring the prior `<Button disabled>` behaviour.

export interface ActionItem {
  /** Stable id, used as the React key + for tests. */
  id: string;
  /** Display label. */
  label: string;
  /** Icon shown to the left of the label. */
  icon: ReactNode;
  /** Click handler. Skipped when disabled is true. */
  onSelect: () => void;
  /** Hidden entirely when false; default true. */
  visible?: boolean;
  /** Greyed out + non-clickable when true. */
  disabled?: boolean;
  /** Tooltip / accessible description; also rendered as the disabled
   *  reason hint on the menu item. */
  title?: string;
  /** When true, this item is the primary call to action — rendered
   *  with a destructive accent (used for "Stop" while building). */
  destructive?: boolean;
  /** Visual divider drawn ABOVE this item when true. */
  separatorBefore?: boolean;
}

export function WorkspaceActionsMenu({
  items,
  triggerLabel = "Actions",
  triggerDisabled = false,
  triggerDisabledReason,
}: {
  items: readonly ActionItem[];
  triggerLabel?: string;
  triggerDisabled?: boolean;
  triggerDisabledReason?: string;
}) {
  const visible = items.filter((i) => i.visible !== false);
  return (
    <Menu.Root>
      <Menu.Trigger
        render={
          <Button
            type="button"
            size="sm"
            disabled={triggerDisabled}
            title={triggerDisabledReason}
          >
            {triggerLabel}
            <ChevronDown className="ml-1 h-3 w-3" aria-hidden="true" />
          </Button>
        }
      />
      <Menu.Portal>
        <Menu.Positioner sideOffset={4} align="end" className="z-50 outline-none">
          <Menu.Popup className="min-w-[220px] rounded-md border bg-background p-1 shadow-md outline-none">
            {visible.map((item, i) => (
              <div key={item.id}>
                {item.separatorBefore && i > 0 ? (
                  <div className="my-1 h-px bg-border" />
                ) : null}
                <Menu.Item
                  disabled={item.disabled}
                  onClick={item.onSelect}
                  className={
                    "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs outline-none " +
                    (item.disabled
                      ? "cursor-not-allowed text-muted-foreground/60 "
                      : item.destructive
                        ? "text-destructive data-[highlighted]:bg-destructive/10 "
                        : "text-foreground data-[highlighted]:bg-muted ")
                  }
                  title={item.title}
                >
                  <span className="flex h-3 w-3 shrink-0 items-center justify-center">
                    {item.icon}
                  </span>
                  <span className="flex-1">{item.label}</span>
                </Menu.Item>
              </div>
            ))}
            {visible.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                No actions available right now.
              </div>
            ) : null}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

// Re-export the icons used by call sites so the page doesn't need to
// import lucide directly just for action items.
export { ExternalLink, GitBranch, Globe, Loader2, Pencil, Play, Rocket, Sparkles, Square };
