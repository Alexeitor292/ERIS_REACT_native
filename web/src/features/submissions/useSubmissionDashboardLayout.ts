import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";

import {
  buildDefaultCanvasLayout,
  CANVAS_CARD_IDS,
  cardsOverlap,
  canvasContentBounds,
  DASHBOARD_DEFAULT_SIZES,
  DASHBOARD_LAYOUT_GAP,
  DASHBOARD_LAYOUT_V2_KEY,
  DASHBOARD_MAX_CARD_HEIGHT,
  DASHBOARD_MAX_CARD_WIDTH,
  DASHBOARD_MIN_CARD_HEIGHT,
  DASHBOARD_MIN_CARD_WIDTH,
  flowDashboardCards,
  orderFromPositions,
  readStoredCanvasLayout,
  serializeCanvasLayout,
  type DashboardCanvasLayout,
  type DashboardCardId,
  type DashboardCardLayout,
  type DashboardCardPosition,
} from "./submissionLayoutModel";

export type ResizeMode = "right" | "bottom" | "bottomRight";

type RenderedLayout = {
  positions: Record<DashboardCardId, DashboardCardPosition>;
  sizes: Record<DashboardCardId, DashboardCardLayout>;
};

type DragState = {
  id: DashboardCardId;
  startX: number;
  startY: number;
  cardX: number;
  cardY: number;
  snapshot: RenderedLayout;
  active: boolean;
  pointerX: number;
  pointerY: number;
};

type ResizeState = {
  id: DashboardCardId;
  mode: ResizeMode;
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
  snapshot: RenderedLayout;
  active: boolean;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const DRAG_THRESHOLD_PX = 5;

function customLayoutFrom(snapshot: RenderedLayout, order: DashboardCardId[]): DashboardCanvasLayout {
  const positions: Partial<Record<DashboardCardId, DashboardCardPosition>> = {};
  const sizes = {} as Record<DashboardCardId, DashboardCardLayout>;
  for (const id of CANVAS_CARD_IDS) {
    positions[id] = { ...snapshot.positions[id] };
    sizes[id] = { ...snapshot.sizes[id] };
  }
  return { custom: true, order, sizes, positions };
}

function overlapsAnother(
  id: DashboardCardId,
  rect: { x: number; y: number; width: number; height: number },
  layout: RenderedLayout,
) {
  for (const otherId of CANVAS_CARD_IDS) {
    if (otherId === id) continue;
    const other = { ...layout.positions[otherId], ...layout.sizes[otherId] };
    if (cardsOverlap(rect, other)) return true;
  }
  return false;
}

/**
 * GISA form canvas layout controller: auto-fit flow by default, custom absolute layout
 * after the first drag/resize, persisted in localStorage (v2 key), plus full-screen.
 */
export function useSubmissionDashboardLayout() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [layout, setLayout] = useState<DashboardCanvasLayout>(() =>
    readStoredCanvasLayout(typeof window === "undefined" ? null : window.localStorage),
  );
  const [drag, setDrag] = useState<DragState | null>(null);
  const [resize, setResize] = useState<ResizeState | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const persistReadyRef = useRef(false);

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = () => setContainerWidth(element.clientWidth);
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(() => update());
    observer.observe(element);
    return () => observer.disconnect();
  }, [fullscreen]);

  useEffect(() => {
    if (!persistReadyRef.current) {
      persistReadyRef.current = true;
      return;
    }
    try {
      window.localStorage.setItem(DASHBOARD_LAYOUT_V2_KEY, serializeCanvasLayout(layout));
    } catch {
      // Storage may be unavailable; layout still works for the session.
    }
  }, [layout]);

  useEffect(() => {
    if (!fullscreen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullscreen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [fullscreen]);

  const effectiveWidth = Math.max(containerWidth, DASHBOARD_LAYOUT_GAP * 2 + DASHBOARD_MIN_CARD_WIDTH);

  const rendered = useMemo<RenderedLayout>(() => {
    if (layout.custom) {
      const positions = {} as Record<DashboardCardId, DashboardCardPosition>;
      const sizes = {} as Record<DashboardCardId, DashboardCardLayout>;
      for (const id of CANVAS_CARD_IDS) {
        positions[id] = layout.positions[id] ?? { x: DASHBOARD_LAYOUT_GAP, y: DASHBOARD_LAYOUT_GAP };
        sizes[id] = layout.sizes[id] ?? DASHBOARD_DEFAULT_SIZES[id];
      }
      return { positions, sizes };
    }
    const flowed = flowDashboardCards(layout.order, layout.sizes, effectiveWidth);
    return { positions: flowed.positions, sizes: flowed.sizes };
  }, [layout, effectiveWidth]);

  const bounds = useMemo(() => canvasContentBounds(CANVAS_CARD_IDS, rendered.positions, rendered.sizes), [rendered]);

  const startDrag = useCallback(
    (id: DashboardCardId, event: ReactMouseEvent) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement;
      if (target.closest("input, select, textarea, button, a, label, summary, [data-no-drag]")) return;
      event.preventDefault();
      const position = rendered.positions[id];
      setDrag({
        id,
        startX: event.clientX,
        startY: event.clientY,
        cardX: position.x,
        cardY: position.y,
        snapshot: rendered,
        active: false,
        pointerX: event.clientX,
        pointerY: event.clientY,
      });
    },
    [rendered],
  );

  const startResize = useCallback(
    (id: DashboardCardId, mode: ResizeMode, event: ReactMouseEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const size = rendered.sizes[id];
      setResize({
        id,
        mode,
        startX: event.clientX,
        startY: event.clientY,
        startWidth: size.width,
        startHeight: size.height,
        snapshot: rendered,
        active: false,
      });
    },
    [rendered],
  );

  useEffect(() => {
    if (!drag && !resize) return;

    const onMove = (event: MouseEvent) => {
      if (resize) {
        const dx = event.clientX - resize.startX;
        const dy = event.clientY - resize.startY;
        if (!resize.active && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        const width = resize.mode === "bottom"
          ? resize.startWidth
          : Math.round(clamp(resize.startWidth + dx, DASHBOARD_MIN_CARD_WIDTH, DASHBOARD_MAX_CARD_WIDTH));
        const height = resize.mode === "right"
          ? resize.startHeight
          : Math.round(clamp(resize.startHeight + dy, DASHBOARD_MIN_CARD_HEIGHT, DASHBOARD_MAX_CARD_HEIGHT));
        setLayout((previous) => {
          const base = previous.custom ? previous : customLayoutFrom(resize.snapshot, orderFromPositions(CANVAS_CARD_IDS, resize.snapshot.positions));
          const current: RenderedLayout = {
            positions: { ...(base.positions as Record<DashboardCardId, DashboardCardPosition>) },
            sizes: { ...base.sizes },
          };
          const position = current.positions[resize.id];
          if (overlapsAnother(resize.id, { x: position.x, y: position.y, width, height }, current)) return base;
          return { ...base, sizes: { ...base.sizes, [resize.id]: { width, height } } };
        });
        if (!resize.active) setResize({ ...resize, active: true });
        return;
      }

      if (drag) {
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        const moved = Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX;
        if (!drag.active && !moved) return;
        const size = drag.snapshot.sizes[drag.id];
        const nextX = Math.max(0, Math.round(drag.cardX + dx));
        const nextY = Math.max(0, Math.round(drag.cardY + dy));
        setLayout((previous) => {
          const base = previous.custom ? previous : customLayoutFrom(drag.snapshot, orderFromPositions(CANVAS_CARD_IDS, drag.snapshot.positions));
          const current: RenderedLayout = {
            positions: { ...(base.positions as Record<DashboardCardId, DashboardCardPosition>) },
            sizes: { ...base.sizes },
          };
          if (overlapsAnother(drag.id, { x: nextX, y: nextY, width: size.width, height: size.height }, current)) return base;
          return { ...base, positions: { ...base.positions, [drag.id]: { x: nextX, y: nextY } } };
        });
        setDrag((previous) => (previous ? { ...previous, active: true, pointerX: event.clientX, pointerY: event.clientY } : previous));
      }
    };

    const onUp = () => {
      setDrag(null);
      setResize(null);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [drag, resize]);

  const tidy = useCallback(() => {
    setLayout((previous) => ({
      custom: false,
      order: previous.custom ? orderFromPositions(CANVAS_CARD_IDS, previous.positions) : previous.order,
      sizes: previous.sizes,
      positions: {},
    }));
  }, []);

  const reset = useCallback(() => setLayout(buildDefaultCanvasLayout()), []);

  const cardStyle = useCallback(
    (id: DashboardCardId): CSSProperties => {
      const position = rendered.positions[id];
      const size = rendered.sizes[id];
      const dragging = drag?.active && drag.id === id;
      return {
        position: "absolute",
        left: `${position.x}px`,
        top: `${position.y}px`,
        width: `${size.width}px`,
        height: `${size.height}px`,
        zIndex: dragging ? 20 : 1,
        transition: drag || resize ? "none" : "left 160ms ease-out, top 160ms ease-out, width 160ms ease-out, height 160ms ease-out",
      };
    },
    [rendered, drag, resize],
  );

  const canvasStyle = useMemo<CSSProperties>(
    () => ({
      position: "relative",
      height: `${bounds.height}px`,
      width: layout.custom ? `${Math.max(bounds.width, containerWidth)}px` : "100%",
      minWidth: "100%",
    }),
    [bounds.height, bounds.width, containerWidth, layout.custom],
  );

  return {
    containerRef,
    layout,
    custom: layout.custom,
    rendered,
    cardIds: CANVAS_CARD_IDS,
    cardStyle,
    canvasStyle,
    startDrag,
    startResize,
    draggingId: drag?.active ? drag.id : null,
    dragPointer: drag?.active ? { x: drag.pointerX, y: drag.pointerY } : null,
    resizingId: resize?.active ? resize.id : null,
    tidy,
    reset,
    fullscreen,
    setFullscreen,
  };
}
