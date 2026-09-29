// A small label on an ArcGIS map or scene: where the terrain at the middle of
// the view comes from and when it was flown ("Terrain here: USGS 3DEP 1 m
// lidar · flown Jan–Apr 2018"). It updates once the view stops moving.

import * as reactiveUtils from "@arcgis/core/core/reactiveUtils";
import type MapView from "@arcgis/core/views/MapView";
import type SceneView from "@arcgis/core/views/SceneView";

import { terrainSourceAt } from "./terrainSource";
import { terrainSourceText } from "./terrainSourceModel";

type Position = "bottom-left" | "bottom-right" | "top-left" | "top-right";

/** Adds the label to the view's UI; the returned function removes it. */
export function attachTerrainSourceBadge(view: MapView | SceneView, position: Position = "bottom-left"): () => void {
  const badge = document.createElement("div");
  badge.className = "esri-widget";
  badge.setAttribute("aria-live", "polite");
  Object.assign(badge.style, {
    padding: "3px 8px",
    fontSize: "11px",
    lineHeight: "16px",
    maxWidth: "min(26rem, 70vw)",
    borderRadius: "6px",
    opacity: "0.92",
  } satisfies Partial<CSSStyleDeclaration>);
  badge.textContent = "Terrain here: looking up…";
  view.ui.add(badge, position);

  let lookup = 0;
  const update = () => {
    const center = view.center;
    if (!center || center.longitude == null || center.latitude == null) return;
    const ticket = ++lookup;
    terrainSourceAt(center.longitude, center.latitude).then((source) => {
      if (ticket !== lookup) return;
      if (!source) {
        badge.textContent = "Terrain here: source not published";
        badge.title = "";
        return;
      }
      badge.replaceChildren();
      const label = document.createElement("span");
      label.textContent = `Terrain here: ${terrainSourceText(source)}`;
      badge.append(label);
      if (source.link) {
        const link = document.createElement("a");
        link.href = source.link;
        link.target = "_blank";
        link.rel = "noreferrer";
        link.textContent = " · source";
        link.style.textDecoration = "underline";
        badge.append(link);
      }
      badge.title = [
        source.project ? `Project: ${source.project}` : "",
        source.datasetDates ? "Dates span the whole dataset, not this place." : "",
        "The middle of the view.",
      ].filter(Boolean).join("\n");
    });
  };
  const handle = reactiveUtils.when(() => view.stationary, update, { initial: true });
  return () => {
    handle.remove();
    view.ui.remove(badge);
  };
}
