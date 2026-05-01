"use client";

import {
  ArrowUpRight,
  MousePointer2,
  Square,
  Type,
  Undo2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  drawShape,
  extendShape,
  flattenAnnotations,
  isShapeCommittable,
  startShape,
  type Point,
  type Shape,
  type Tool,
} from "@/lib/annotation";

// Visual-feedback annotation modal (Slice 1 of D-026). Receives an image
// (or null — empty placeholder mode), lets the novice draw boxes/arrows/
// freehand/text on top, and on Send flattens the result into a PNG that
// the parent posts back to the orchestrator with a description.

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface AnnotationModalProps {
  /** Image to annotate. null = empty modal showing the drop/paste placeholder. */
  initialImage: Blob | File | null;
  /**
   * Called when the novice clicks Send.
   * - `imageBytes` is the flattened PNG (original image + overlay drawn).
   * - `marks` is the raw Shape array in image-bitmap coordinates, included
   *   so the agent gets exact mark positions in addition to the rasterised
   *   pixels (the parent assembles the rest of the sidecar).
   */
  onSend: (args: {
    description: string;
    imageBytes: Uint8Array;
    marks: readonly Shape[];
  }) => Promise<void> | void;
  /** Called when the novice clicks Cancel or hits ESC. */
  onClose: () => void;
}

export function AnnotationModal({ initialImage, onSend, onClose }: AnnotationModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

  const [tool, setTool] = useState<Tool>("box");
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [preview, setPreview] = useState<Shape | null>(null);
  const [description, setDescription] = useState("");
  const [imageBlob, setImageBlob] = useState<Blob | null>(initialImage);
  const [imageURL, setImageURL] = useState<string | null>(null);
  const [imageNaturalSize, setImageNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  // Open the dialog modally on mount; close on unmount or Cancel.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  // When the image blob changes, build an Image element and a blob URL so
  // the canvas can paint it. Revoke the old URL on cleanup to avoid leaks.
  useEffect(() => {
    if (!imageBlob) {
      setImageURL(null);
      imageRef.current = null;
      setImageNaturalSize(null);
      return;
    }
    const url = URL.createObjectURL(imageBlob);
    setImageURL(url);
    const img = new Image();
    img.onload = () => {
      imageRef.current = img;
      setImageNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
      // Reset the in-flight shape state when the image changes.
      setShapes([]);
      setPreview(null);
    };
    img.onerror = () => setError("Couldn't decode the dropped image.");
    img.src = url;
    return () => URL.revokeObjectURL(url);
  }, [imageBlob]);

  // Repaint the canvas whenever shapes / preview / image changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    if (!canvas || !img || !imageNaturalSize) return;
    canvas.width = imageNaturalSize.w;
    canvas.height = imageNaturalSize.h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    for (const s of shapes) drawShape(ctx, s);
    if (preview) drawShape(ctx, preview);
  }, [shapes, preview, imageNaturalSize]);

  // Map a pointer event to canvas-internal coords (account for CSS scaling).
  const eventToPoint = useCallback((e: React.PointerEvent<HTMLCanvasElement>): Point => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!imageRef.current) return;
    const point = eventToPoint(e);
    if (tool === "text") {
      const content = window.prompt("Label text:");
      if (content === null) return;
      const next: Shape = { kind: "text", x: point.x, y: point.y, content };
      if (isShapeCommittable(next)) setShapes((s) => [...s, next]);
      return;
    }
    const fresh = startShape(tool, point);
    if (fresh) {
      setPreview(fresh);
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!preview) return;
    setPreview(extendShape(preview, eventToPoint(e)));
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!preview) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    if (isShapeCommittable(preview)) {
      setShapes((s) => [...s, preview]);
    }
    setPreview(null);
  };

  const onUndo = (): void => setShapes((s) => s.slice(0, -1));
  const onClear = (): void => {
    if (shapes.length === 0) return;
    if (window.confirm("Clear all annotations?")) setShapes([]);
  };

  // Drop handler: replace the source image with a dropped one.
  const onDrop = (e: React.DragEvent<HTMLDialogElement>): void => {
    e.preventDefault();
    const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith("image/"));
    if (!file) return;
    if (file.size > MAX_IMAGE_BYTES) {
      setError(`Image too large (${Math.round(file.size / 1024 / 1024)} MB, max 10 MB)`);
      return;
    }
    setError(null);
    setImageBlob(file);
  };

  // Paste handler: pulls an image off the clipboard. Wired at the dialog
  // root so paste works without the canvas being focused.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      const items = Array.from(e.clipboardData?.items ?? []);
      const item = items.find((i) => i.type.startsWith("image/"));
      if (!item) return;
      const file = item.getAsFile();
      if (!file) return;
      if (file.size > MAX_IMAGE_BYTES) {
        setError(`Pasted image too large (${Math.round(file.size / 1024 / 1024)} MB, max 10 MB)`);
        return;
      }
      e.preventDefault();
      setError(null);
      setImageBlob(file);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  const onSendClick = async (): Promise<void> => {
    if (!imageRef.current) {
      setError("No image to send. Drop or paste a screenshot first.");
      return;
    }
    if (description.trim().length === 0 && shapes.length === 0) {
      setError("Add at least an annotation or a description so the agent has something to act on.");
      return;
    }
    setSending(true);
    setError(null);
    try {
      const bytes = await flattenAnnotations(imageRef.current, shapes);
      await onSend({ description: description.trim(), imageBytes: bytes, marks: shapes });
    } catch (e) {
      setError(`Couldn't send: ${e instanceof Error ? e.message : String(e)}`);
      setSending(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      aria-labelledby="annotation-modal-title"
      className="rounded-lg border bg-background p-0 text-foreground shadow-lg backdrop:bg-foreground/40"
    >
      <div className="flex w-[min(90vw,900px)] flex-col gap-3 p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="annotation-modal-title" className="text-base font-semibold">
              Annotate the build
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Drop or paste a screenshot of the built app, circle what's wrong, and write a note.
              The agent reads the image and acts on what it sees.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {imageURL ? (
          <>
            <div className="flex flex-wrap items-center gap-1 border-y py-2">
              <ToolButton active={tool === "box"} onClick={() => setTool("box")} label="Box" icon={<Square className="h-4 w-4" />} />
              <ToolButton active={tool === "arrow"} onClick={() => setTool("arrow")} label="Arrow" icon={<ArrowUpRight className="h-4 w-4" />} />
              <ToolButton active={tool === "freedraw"} onClick={() => setTool("freedraw")} label="Free draw" icon={<MousePointer2 className="h-4 w-4" />} />
              <ToolButton active={tool === "text"} onClick={() => setTool("text")} label="Text" icon={<Type className="h-4 w-4" />} />
              <span aria-hidden="true" className="mx-2 h-5 w-px bg-border" />
              <ToolButton onClick={onUndo} label="Undo" icon={<Undo2 className="h-4 w-4" />} disabled={shapes.length === 0} />
              <button
                type="button"
                onClick={onClear}
                disabled={shapes.length === 0}
                className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-40"
              >
                Clear
              </button>
              <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">
                {shapes.length} {shapes.length === 1 ? "annotation" : "annotations"}
              </span>
            </div>
            <div className="flex max-h-[55vh] justify-center overflow-auto rounded-md border bg-muted/40 p-2">
              <canvas
                ref={canvasRef}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                className="max-h-[50vh] cursor-crosshair touch-none"
              />
            </div>
          </>
        ) : (
          <div className="flex h-48 items-center justify-center rounded-md border-2 border-dashed border-muted-foreground/30 bg-muted/20">
            <p className="text-sm text-muted-foreground">
              Drop a screenshot here, or paste one (Cmd/Ctrl+V).
            </p>
          </div>
        )}

        <div>
          <label htmlFor="annotation-description" className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
            What needs to change?
          </label>
          <textarea
            id="annotation-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. the navigation menu is missing across the top"
            rows={3}
            className="w-full resize-none rounded-md border bg-background px-2 py-1.5 text-sm"
          />
        </div>

        {error ? (
          <p role="alert" className="text-xs text-destructive">{error}</p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={sending}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void onSendClick()} disabled={sending || !imageURL}>
            {sending ? "Sending..." : "Send to agent"}
          </Button>
        </div>
      </div>
    </dialog>
  );
}

function ToolButton({
  active,
  onClick,
  label,
  icon,
  disabled,
}: {
  active?: boolean;
  onClick: () => void;
  label: string;
  icon: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      aria-label={label}
      title={label}
      className={
        "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors disabled:opacity-40 " +
        (active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground")
      }
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
