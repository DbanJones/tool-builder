// Visual-feedback annotation primitives (Slice 1 of D-026).
//
// Pure types + drawing helpers. The canvas operations are thin wrappers over
// CanvasRenderingContext2D so the AnnotationModal component can stay focused
// on event handling. Tests live in `index.test.ts`; canvas-dependent helpers
// are only exercised in the smoke test (jsdom can't get a real 2D context
// without a heavy mock and the math here doesn't need it).

export interface Point {
  x: number;
  y: number;
}

export type Shape =
  | { kind: "box"; x: number; y: number; width: number; height: number }
  | { kind: "arrow"; from: Point; to: Point }
  | { kind: "freedraw"; points: Point[] }
  | { kind: "text"; x: number; y: number; content: string };

export type Tool = "box" | "arrow" | "freedraw" | "text";

export const ANNOTATION_COLOR = "#ef4444"; // Tailwind red-500
export const ANNOTATION_STROKE_WIDTH = 3;
export const ANNOTATION_FONT = "16px ui-sans-serif, system-ui, sans-serif";

/**
 * Build a freshly-started shape from a pointer-down event. Returns null for
 * the "text" tool — text shapes need a content string from the caller.
 */
export function startShape(tool: Tool, point: Point): Shape | null {
  switch (tool) {
    case "box":
      return { kind: "box", x: point.x, y: point.y, width: 0, height: 0 };
    case "arrow":
      return { kind: "arrow", from: point, to: point };
    case "freedraw":
      return { kind: "freedraw", points: [point] };
    case "text":
      return null;
  }
}

/**
 * Update an in-progress shape from a pointer-move event. Returns the new
 * shape immutably; callers replace their preview state.
 */
export function extendShape(shape: Shape, point: Point): Shape {
  switch (shape.kind) {
    case "box":
      return {
        kind: "box",
        x: shape.x,
        y: shape.y,
        width: point.x - shape.x,
        height: point.y - shape.y,
      };
    case "arrow":
      return { kind: "arrow", from: shape.from, to: point };
    case "freedraw":
      return { kind: "freedraw", points: [...shape.points, point] };
    case "text":
      return shape;
  }
}

/**
 * Discard tiny no-op shapes (a click without a drag draws a 0x0 box that
 * just clutters the overlay). Called at pointer-up before committing to
 * the shape array.
 */
export function isShapeCommittable(shape: Shape): boolean {
  switch (shape.kind) {
    case "box":
      return Math.abs(shape.width) >= 4 && Math.abs(shape.height) >= 4;
    case "arrow": {
      const dx = shape.to.x - shape.from.x;
      const dy = shape.to.y - shape.from.y;
      return Math.hypot(dx, dy) >= 6;
    }
    case "freedraw":
      return shape.points.length >= 2;
    case "text":
      return shape.content.trim().length > 0;
  }
}

/** Render one shape onto a 2D context. The caller sets stroke/fill defaults. */
export function drawShape(ctx: CanvasRenderingContext2D, shape: Shape): void {
  ctx.save();
  ctx.strokeStyle = ANNOTATION_COLOR;
  ctx.fillStyle = ANNOTATION_COLOR;
  ctx.lineWidth = ANNOTATION_STROKE_WIDTH;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  switch (shape.kind) {
    case "box": {
      const x = Math.min(shape.x, shape.x + shape.width);
      const y = Math.min(shape.y, shape.y + shape.height);
      const w = Math.abs(shape.width);
      const h = Math.abs(shape.height);
      ctx.strokeRect(x, y, w, h);
      break;
    }
    case "arrow": {
      ctx.beginPath();
      ctx.moveTo(shape.from.x, shape.from.y);
      ctx.lineTo(shape.to.x, shape.to.y);
      ctx.stroke();
      // Arrowhead — two short lines at ±25° from the shaft.
      const dx = shape.to.x - shape.from.x;
      const dy = shape.to.y - shape.from.y;
      const angle = Math.atan2(dy, dx);
      const head = 14;
      const spread = Math.PI / 7; // ~25°
      ctx.beginPath();
      ctx.moveTo(shape.to.x, shape.to.y);
      ctx.lineTo(
        shape.to.x - head * Math.cos(angle - spread),
        shape.to.y - head * Math.sin(angle - spread),
      );
      ctx.moveTo(shape.to.x, shape.to.y);
      ctx.lineTo(
        shape.to.x - head * Math.cos(angle + spread),
        shape.to.y - head * Math.sin(angle + spread),
      );
      ctx.stroke();
      break;
    }
    case "freedraw": {
      if (shape.points.length < 2) {
        ctx.restore();
        return;
      }
      ctx.beginPath();
      const first = shape.points[0]!;
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < shape.points.length; i++) {
        const p = shape.points[i]!;
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      break;
    }
    case "text": {
      ctx.font = ANNOTATION_FONT;
      ctx.textBaseline = "top";
      // Outline behind the text so it's readable on any background.
      ctx.lineWidth = 4;
      ctx.strokeStyle = "#ffffff";
      ctx.strokeText(shape.content, shape.x, shape.y);
      ctx.fillText(shape.content, shape.x, shape.y);
      break;
    }
  }
  ctx.restore();
}

/**
 * Composite a source image + the annotation overlay into a single PNG.
 * Returns the bytes ready to base64-encode for the Tauri `feedback_image_save`
 * command. Runs on a detached canvas so the modal's visible canvas is left
 * untouched.
 */
export async function flattenAnnotations(
  image: HTMLImageElement,
  shapes: readonly Shape[],
): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("flattenAnnotations: 2D context unavailable");
  ctx.drawImage(image, 0, 0);
  for (const s of shapes) drawShape(ctx, s);
  const blob: Blob | null = await new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/png"),
  );
  if (!blob) throw new Error("flattenAnnotations: canvas.toBlob returned null");
  return new Uint8Array(await blob.arrayBuffer());
}

/** Convert a Uint8Array (raw PNG bytes) to a base64 string for IPC. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}
