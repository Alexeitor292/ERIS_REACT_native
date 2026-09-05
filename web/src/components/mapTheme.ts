import { useEffect } from "react";
import type MapView from "@arcgis/core/views/MapView";

/**
 * Theme-aware basemap selection for ArcGIS MapViews.
 *
 * Vector basemaps need an ArcGIS API key; without one the OSM raster basemap is
 * the only key-free option, so the theme only influences the map when a key is
 * configured (VITE_ARCGIS_API_KEY).
 */
export function currentTheme(): string {
  if (typeof document === "undefined") return "light";
  return document.documentElement.getAttribute("data-theme") || "light";
}

export function basemapForTheme(hasApiKey: boolean, theme = currentTheme()): string {
  if (!hasApiKey) return "osm";
  return theme === "dark" ? "dark-gray-vector" : "topo-vector";
}

/** Swap the basemap whenever the app theme changes (data-theme on <html>). */
export function useThemeBasemap(viewRef: { current: MapView | null }, hasApiKey: boolean) {
  useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => {
      const view = viewRef.current;
      if (!view?.map) return;
      const next = basemapForTheme(hasApiKey);
      if ((view.map.basemap as any)?.id !== next) (view.map as any).basemap = next;
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, [hasApiKey, viewRef]);
}
