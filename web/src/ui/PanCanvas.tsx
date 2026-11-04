import { Maximize, Minus, Plus } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { clampView, DRAG_THRESHOLD, fitView, openingView, zoomAt, type CanvasView, type Size } from "./panCanvasModel";

const ZOOM_STEP = 1.2;
const KEY_STEP = 80;
const control = "flex h-9 w-9 items-center justify-center text-[var(--ink)] hover:bg-[var(--panel-soft)]";

/**
 * Content too big for its place, moved by dragging rather than scrolled: drag anywhere,
 * including from a card. A press that does not move is still a click on what it landed
 * on. The buttons or a pinch zoom; the arrow keys move it when it has focus.
 */
export default function PanCanvas({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<CanvasView>({ x: 0, y: 0, scale: 1 });
  const [placed, setPlaced] = useState(false);
  const [dragging, setDragging] = useState(false);
  const press = useRef<{ id: number; x: number; y: number; view: CanvasView; moved: boolean } | null>(null);

  const sizes = useCallback((): { viewport: Size; content: Size } | null => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return null;
    return {
      viewport: { width: viewport.clientWidth, height: viewport.clientHeight },
      content: { width: content.offsetWidth, height: content.offsetHeight },
    };
  }, []);

  const move = useCallback(
    (next: CanvasView | ((current: CanvasView) => CanvasView)) => {
      const measured = sizes();
      setView((current) => {
        const wanted = typeof next === "function" ? next(current) : next;
        return measured ? clampView(wanted, measured.viewport, measured.content) : wanted;
      });
    },
    [sizes],
  );

  // Placed once it can be measured; after that, a tree that grows or a window that shrinks only keeps it in view.
  useLayoutEffect(() => {
    const measured = sizes();
    if (measured) {
      setView(openingView(measured.viewport, measured.content));
      setPlaced(true);
    }
  }, [sizes]);
  useEffect(() => {
    const observer = new ResizeObserver(() => move((current) => current));
    if (viewportRef.current) observer.observe(viewportRef.current);
    if (contentRef.current) observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [move]);

  // A pinch arrives as ctrl + wheel, and two fingers sideways as a sideways wheel. A plain
  // wheel is left alone so that the page keeps scrolling. Not a React handler: this has to prevent the default.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const box = viewport.getBoundingClientRect();
        const point = { x: event.clientX - box.left, y: event.clientY - box.top };
        move((current) => zoomAt(current, Math.exp(-event.deltaY * 0.01), point));
      } else if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        event.preventDefault();
        move((current) => ({ ...current, x: current.x - event.deltaX }));
      }
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [move]);

  const zoomFromCentre = (factor: number) => {
    const measured = sizes();
    if (!measured) return;
    move((current) => zoomAt(current, factor, { x: measured.viewport.width / 2, y: measured.viewport.height / 2 }));
  };
  const fit = () => {
    const measured = sizes();
    if (measured) setView(fitView(measured.viewport, measured.content));
  };

  return (
    <div className={`relative overflow-hidden ${className}`}>
      <div
        ref={viewportRef}
        role="group"
        tabIndex={0}
        aria-label={`${label}. Drag to move, or use the arrow keys.`}
        className={`h-full w-full touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--brand)] ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
        style={{ backgroundImage: "radial-gradient(color-mix(in oklab, var(--line) 70%, transparent) 1px, transparent 1px)", backgroundSize: "20px 20px", backgroundPosition: `${view.x}px ${view.y}px` }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          // Choosing text or an option in a field is not moving the canvas.
          if ((event.target as Element).closest("input, select, textarea")) return;
          press.current = { id: event.pointerId, x: event.clientX, y: event.clientY, view, moved: false };
        }}
        onPointerMove={(event) => {
          const current = press.current;
          if (!current || current.id !== event.pointerId) return;
          const dx = event.clientX - current.x;
          const dy = event.clientY - current.y;
          if (!current.moved) {
            if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
            current.moved = true;
            setDragging(true);
            // Only now: taken at the press, it would keep a plain click from reaching the card under it.
            event.currentTarget.setPointerCapture(event.pointerId);
          }
          move({ ...current.view, x: current.view.x + dx, y: current.view.y + dy });
        }}
        onPointerUp={() => {
          // The click after a drag belongs to nothing: onClickCapture drops it.
          window.setTimeout(() => { press.current = null; }, 0);
          setDragging(false);
        }}
        onPointerCancel={() => {
          press.current = null;
          setDragging(false);
        }}
        onClickCapture={(event) => {
          if (press.current?.moved) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          const step: Record<string, [number, number]> = { ArrowLeft: [KEY_STEP, 0], ArrowRight: [-KEY_STEP, 0], ArrowUp: [0, KEY_STEP], ArrowDown: [0, -KEY_STEP] };
          const by = step[event.key];
          if (by) {
            event.preventDefault();
            move((current) => ({ ...current, x: current.x + by[0], y: current.y + by[1] }));
          } else if (event.key === "+" || event.key === "=") {
            zoomFromCentre(ZOOM_STEP);
          } else if (event.key === "-") {
            zoomFromCentre(1 / ZOOM_STEP);
          } else if (event.key === "0") {
            fit();
          }
        }}
      >
        <div
          ref={contentRef}
          className="w-max"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, transformOrigin: "0 0", visibility: placed ? "visible" : "hidden" }}
        >
          {children}
        </div>
      </div>
      <div className="absolute right-3 top-3 flex divide-x divide-[var(--line)] overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--panel)] shadow-sm">
        <button type="button" className={control} onClick={() => zoomFromCentre(1 / ZOOM_STEP)} aria-label="Zoom out" title="Zoom out"><Minus size={16} aria-hidden /></button>
        <span className="flex w-14 items-center justify-center text-xs tabular-nums text-muted" aria-live="polite">{Math.round(view.scale * 100)}%</span>
        <button type="button" className={control} onClick={() => zoomFromCentre(ZOOM_STEP)} aria-label="Zoom in" title="Zoom in"><Plus size={16} aria-hidden /></button>
        <button type="button" className={control} onClick={fit} aria-label="Fit everything in view" title="Fit everything in view"><Maximize size={15} aria-hidden /></button>
      </div>
    </div>
  );
}
