"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Two-pane horizontal splitter with a draggable handle. Left pane is
// fluid; right pane width is the resizable axis. Mouse + keyboard
// (left/right arrow on the focused handle) for accessibility.
//
// No new dep — rule L1 says evaluate before adding, and a single
// component is well below the threshold where react-resizable-panels
// pays for itself.

export interface ResizableSplitProps {
  left: React.ReactNode;
  right: React.ReactNode;
  /** Current right-pane width in CSS pixels. Controlled. */
  rightWidth: number;
  onRightWidthChange: (px: number) => void;
  /** Hard floor / ceiling. Default 280 / 800. */
  min?: number;
  max?: number;
  /** Hide the splitter entirely (e.g. when one pane is fullscreened). */
  hideHandle?: boolean;
}

const HANDLE_PX = 6;
const KEYBOARD_STEP_PX = 24;

export function ResizableSplit({
  left,
  right,
  rightWidth,
  onRightWidthChange,
  min = 280,
  max = 800,
  hideHandle = false,
}: ResizableSplitProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);

  const clamp = useCallback((px: number): number => Math.min(max, Math.max(min, px)), [min, max]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (hideHandle) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging || !containerRef.current) return;
    // Right pane width = container right edge - pointer X.
    const rect = containerRef.current.getBoundingClientRect();
    const next = clamp(rect.right - e.clientX);
    onRightWidthChange(next);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (hideHandle) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      onRightWidthChange(clamp(rightWidth + KEYBOARD_STEP_PX));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      onRightWidthChange(clamp(rightWidth - KEYBOARD_STEP_PX));
    } else if (e.key === "Home") {
      e.preventDefault();
      onRightWidthChange(min);
    } else if (e.key === "End") {
      e.preventDefault();
      onRightWidthChange(max);
    }
  };

  // Cursor + user-select polish during drag — avoids text-selection
  // flicker as the pointer crosses pane boundaries.
  useEffect(() => {
    if (!dragging) return;
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  }, [dragging]);

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{left}</div>
      {hideHandle ? null : (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the right rail"
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={rightWidth}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onKeyDown}
          className={
            "relative shrink-0 cursor-col-resize select-none border-l " +
            "hover:bg-primary/30 focus-visible:bg-primary/40 focus-visible:outline-none " +
            (dragging ? "bg-primary/40" : "bg-border/40")
          }
          style={{ width: HANDLE_PX }}
        >
          {/* Visible grip dot trio for affordance. */}
          <div className="pointer-events-none absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col gap-1">
            <span className="block h-0.5 w-0.5 rounded-full bg-muted-foreground/60" />
            <span className="block h-0.5 w-0.5 rounded-full bg-muted-foreground/60" />
            <span className="block h-0.5 w-0.5 rounded-full bg-muted-foreground/60" />
          </div>
        </div>
      )}
      <div
        style={{ width: rightWidth }}
        className="flex min-h-0 shrink-0 flex-col"
      >
        {right}
      </div>
    </div>
  );
}
