import { useEffect, useRef } from "react";
import esriConfig from "@arcgis/core/config";
import Map from "@arcgis/core/Map";
import MapView from "@arcgis/core/views/MapView";
import Graphic from "@arcgis/core/Graphic";
import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer";
import Point from "@arcgis/core/geometry/Point";
import Extent from "@arcgis/core/geometry/Extent";
import Home from "@arcgis/core/widgets/Home";
import ScaleBar from "@arcgis/core/widgets/ScaleBar";
import Search from "@arcgis/core/widgets/Search";
import Expand from "@arcgis/core/widgets/Expand";

import { basemapForTheme, useThemeBasemap } from "../../components/mapTheme";

const CALIFORNIA = new Extent({ xmin: -124.482003, ymin: 32.528832, xmax: -114.131211, ymax: 42.009518, spatialReference: { wkid: 4326 } });
/** Street level: close enough to see which lane or shoulder the pin is on. */
const PLACE_ZOOM = 17;

type LatLon = { latitude: number; longitude: number };

/**
 * The map a desktop reporter uses in place of the phone's GPS: click where the
 * problem is and the pin drops there. The first pin zooms in to street level;
 * after that the map stays where the reporter put it, so they can nudge the pin
 * without the view jumping. A pin set another way (route and post mile, or
 * coordinates) is brought into view when the map opens.
 */
export default function IncidentLocationMap({ point, onPick, height = 340 }: { point: LatLon | null; onPick: (point: LatLon) => void; height?: number }) {
  const divRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<MapView | null>(null);
  const pinLayerRef = useRef<GraphicsLayer | null>(null);
  const onPickRef = useRef(onPick);
  const apiKey = String((import.meta as any)?.env?.VITE_ARCGIS_API_KEY ?? "");
  useEffect(() => { onPickRef.current = onPick; }, [onPick]);
  useThemeBasemap(viewRef, !!apiKey);

  useEffect(() => {
    esriConfig.assetsPath = "/assets";
    if (apiKey) esriConfig.apiKey = apiKey;
    if (!divRef.current) return;
    const pinLayer = new GraphicsLayer({ title: "Incident location" });
    pinLayerRef.current = pinLayer;
    const view = new MapView({
      container: divRef.current,
      map: new Map({ basemap: basemapForTheme(!!apiKey), layers: [pinLayer] }),
      extent: CALIFORNIA.clone(),
      constraints: { minZoom: 5, snapToZoom: false },
      popupEnabled: false,
    });
    view.ui.add(new Home({ view }), "top-left");
    view.ui.add(new ScaleBar({ view, unit: "dual" }), "bottom-left");
    view.ui.add(new Expand({ view, content: new Search({ view, popupEnabled: false }), expandTooltip: "Find a place" }), "top-right");
    const clickHandle = view.on("click", (event) => {
      const mapPoint = event.mapPoint;
      if (!mapPoint || mapPoint.latitude == null || mapPoint.longitude == null) return;
      onPickRef.current({ latitude: mapPoint.latitude, longitude: mapPoint.longitude });
    });
    viewRef.current = view;
    return () => {
      clickHandle.remove();
      view.destroy();
      viewRef.current = null;
      pinLayerRef.current = null;
    };
  }, [apiKey]);

  const latitude = point?.latitude ?? null;
  const longitude = point?.longitude ?? null;
  useEffect(() => {
    const view = viewRef.current;
    const layer = pinLayerRef.current;
    if (!view || !layer) return;
    layer.removeAll();
    if (latitude == null || longitude == null) return;
    const geometry = new Point({ latitude, longitude, spatialReference: { wkid: 4326 } });
    layer.add(new Graphic({
      geometry,
      symbol: { type: "simple-marker", style: "circle", size: 16, color: [209, 75, 84, 1], outline: { color: [255, 255, 255, 1], width: 3 } } as any,
    }));
    view.when(() => {
      // Bring the pin to street level from a wider view; leave a street-level
      // view alone unless the pin has left it.
      if (view.zoom < PLACE_ZOOM - 2) return view.goTo({ target: geometry, zoom: PLACE_ZOOM });
      const onScreen = view.toScreen(geometry);
      const visible = onScreen != null && onScreen.x >= 0 && onScreen.y >= 0 && onScreen.x <= view.width && onScreen.y <= view.height;
      return visible ? undefined : view.goTo({ target: geometry });
    }).catch(() => {});
  }, [latitude, longitude]);

  return (
    <div
      ref={divRef}
      className="map-stack-guard overflow-hidden rounded-lg border border-[var(--line)] [&_.esri-view-surface]:cursor-crosshair"
      style={{ height }}
      aria-label="Map: click where the incident is to place it"
    />
  );
}
