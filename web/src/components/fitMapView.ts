import Extent from "@arcgis/core/geometry/Extent";
import type MapView from "@arcgis/core/views/MapView";

import type { LonLatExtent } from "./mapFit";

/**
 * Move a map to show `extent` — once the view is ready, so a fit requested while
 * the map is still loading is applied rather than dropped. The move animates
 * unless the reader asked for reduced motion or the caller asked for an instant
 * jump (the first fit of a freshly opened map has nothing to animate from).
 * A later fit interrupts an earlier one; the interrupted move is not an error.
 */
export function fitMapView(view: MapView, extent: LonLatExtent | null, { animate = true }: { animate?: boolean } = {}): void {
  if (!extent) return;
  const target = new Extent({ ...extent, spatialReference: { wkid: 4326 } });
  const reducedMotion = typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  view
    .when(() => view.goTo(target, { animate: animate && !reducedMotion, duration: 900, easing: "in-out-cubic" }))
    .catch(() => {});
}
