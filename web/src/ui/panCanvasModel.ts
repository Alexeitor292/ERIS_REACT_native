// Dependency-free (runs under `node --test`): where a canvas's content sits when dragged and zoomed.

export type Size = { width: number; height: number };
/** The content's top-left corner in the viewport, and its scale. */
export type CanvasView = { x: number; y: number; scale: number };

export const MIN_SCALE = 0.25;
export const MAX_SCALE = 1.5;
/** A drag shorter than this is a click. */
export const DRAG_THRESHOLD = 5;
/** How much of the content always stays in view, so it cannot be dragged away and lost. */
const KEEP_VISIBLE = 80;
const TOP_MARGIN = 16;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** Keeps part of the content in view. */
export function clampView(view: CanvasView, viewport: Size, content: Size): CanvasView {
  const width = content.width * view.scale;
  const height = content.height * view.scale;
  return {
    scale: view.scale,
    x: clamp(view.x, KEEP_VISIBLE - width, viewport.width - KEEP_VISIBLE),
    y: clamp(view.y, KEEP_VISIBLE - height, viewport.height - KEEP_VISIBLE),
  };
}

/** Actual size, centred across and starting from the top: where a tree's root is. */
export function openingView(viewport: Size, content: Size): CanvasView {
  return { scale: 1, x: (viewport.width - content.width) / 2, y: Math.max(TOP_MARGIN, (viewport.height - content.height) / 2) };
}

/** All of the content in view, never enlarged. */
export function fitView(viewport: Size, content: Size): CanvasView {
  if (content.width <= 0 || content.height <= 0) return { x: 0, y: 0, scale: 1 };
  const scale = clamp(Math.min((viewport.width - 2 * TOP_MARGIN) / content.width, (viewport.height - 2 * TOP_MARGIN) / content.height), MIN_SCALE, 1);
  return { scale, x: (viewport.width - content.width * scale) / 2, y: Math.max(TOP_MARGIN, (viewport.height - content.height * scale) / 2) };
}

/** Zooms keeping the spot at `point` (in the viewport) where it is. */
export function zoomAt(view: CanvasView, factor: number, point: { x: number; y: number }): CanvasView {
  const scale = clamp(view.scale * factor, MIN_SCALE, MAX_SCALE);
  const applied = scale / view.scale;
  return { scale, x: point.x - (point.x - view.x) * applied, y: point.y - (point.y - view.y) * applied };
}
