import { useCallback, useEffect, useRef, useState } from "react";
import esriConfig from "@arcgis/core/config";
import Map from "@arcgis/core/Map";
import MapView from "@arcgis/core/views/MapView";
import Graphic from "@arcgis/core/Graphic";
import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer";
import FeatureLayer from "@arcgis/core/layers/FeatureLayer";
import Polygon from "@arcgis/core/geometry/Polygon";
import Polyline from "@arcgis/core/geometry/Polyline";
import Point from "@arcgis/core/geometry/Point";
import SpatialReference from "@arcgis/core/geometry/SpatialReference";
import * as webMercatorUtils from "@arcgis/core/geometry/support/webMercatorUtils";
import Home from "@arcgis/core/widgets/Home";
import Locate from "@arcgis/core/widgets/Locate";
import Compass from "@arcgis/core/widgets/Compass";
import ScaleBar from "@arcgis/core/widgets/ScaleBar";
import Search from "@arcgis/core/widgets/Search";
import BasemapGallery from "@arcgis/core/widgets/BasemapGallery";
import LayerList from "@arcgis/core/widgets/LayerList";
import Legend from "@arcgis/core/widgets/Legend";
import Measurement from "@arcgis/core/widgets/Measurement";
import CoordinateConversion from "@arcgis/core/widgets/CoordinateConversion";
import Sketch from "@arcgis/core/widgets/Sketch";
import Expand from "@arcgis/core/widgets/Expand";
import { appConfig } from "../config";

// Optional ONLINE "Caltrans Highways & Freeways" context layer: the PUBLIC Caltrans CRS
// Functional Classification FeatureServer, filtered to highway/freeway functional classes
// (F_System 1,2,3) and streamed live. It is OFF by default (toggle it on in the Layers
// widget). This live overlay is intentionally independent of the offline package's
// packaged roads — it does not claim to contain every California road, and it is never
// used to decide whether a downloaded package contains roads.
function createCaltransHighwaysLayer(): FeatureLayer | null {
  const url = (appConfig.caltransHighwaysUrl ?? "").trim();
  if (!url) return null;
  return new FeatureLayer({
    url,
    title: "Caltrans Highways & Freeways",
    visible: false, // opt-in: streamed only after the operator toggles it on
    // Highways/freeways only — keeps the online overlay consistent with its name and the
    // offline provider's scope, and avoids streaming local streets.
    definitionExpression: "F_System IN (1, 2, 3)",
    outFields: ["OBJECTID", "RouteID", "F_System", "County_label", "Caltrans_District"],
    // The service exposes no copyrightText; declare attribution explicitly so the built-in
    // attribution widget credits Caltrans. ERIS does not own or author this data.
    copyright: "Highway geometry © California Department of Transportation (Caltrans), CRS Functional Classification",
    renderer: {
      type: "simple",
      symbol: { type: "simple-line", width: 2.4, color: [234, 88, 12, 0.92] },
    } as any,
    popupTemplate: {
      title: "Caltrans route {RouteID}",
      content:
        "Functional class {F_System} · County {County_label} · Caltrans District {Caltrans_District}" +
        "<br/><small>Source: Caltrans CRS Functional Classification (live). Not survey/engineering-grade.</small>",
    } as any,
  });
}

type Props = {
  geojson: any | null; // GeoJSON geometry object
  location?: { latitude: number | null; longitude: number | null } | null;
  height?: number;
  editable?: boolean;
  onGeometryChange?: (geometry: any | null) => void;
};

function toGeoJsonGeometry(rawGeometry: any): any | null {
  if (!rawGeometry) return null;

  let geometry = rawGeometry;
  if (geometry.spatialReference?.isWebMercator) {
    try {
      geometry = webMercatorUtils.webMercatorToGeographic(geometry) ?? geometry;
    } catch {
      // Keep source geometry if conversion fails.
    }
  }

  const toPair = (coord: any): [number, number] => [Number(coord?.[0]), Number(coord?.[1])];
  const mapCoords = (coords: any) =>
    Array.isArray(coords) ? coords.map((coord: any) => toPair(coord)) : [];

  switch (String(geometry.type || "").toLowerCase()) {
    case "point":
      return { type: "Point", coordinates: [Number(geometry.x), Number(geometry.y)] };
    case "multipoint":
      return { type: "MultiPoint", coordinates: mapCoords(geometry.points) };
    case "polyline": {
      const paths = Array.isArray(geometry.paths) ? geometry.paths.map((path: any) => mapCoords(path)) : [];
      if (paths.length === 1) return { type: "LineString", coordinates: paths[0] };
      return { type: "MultiLineString", coordinates: paths };
    }
    case "polygon": {
      const rings = Array.isArray(geometry.rings) ? geometry.rings.map((ring: any) => mapCoords(ring)) : [];
      return { type: "Polygon", coordinates: rings };
    }
    default:
      return null;
  }
}

export default function SubmissionArcGisMap({
  geojson,
  location = null,
  height = 320,
  editable = false,
  onGeometryChange,
}: Props) {
  const divRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<MapView | null>(null);
  const layerRef = useRef<GraphicsLayer | null>(null);
  const autoCenteredRef = useRef(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    esriConfig.assetsPath = "/assets";

    if (!divRef.current) return;

    const graphicsLayer = new GraphicsLayer({ title: "Submission overlays" });
    layerRef.current = graphicsLayer;

    // Optional Caltrans highways layer sits BELOW the submission overlays so drawn/loaded
    // geometry always stays on top. It appears in the Layers + Legend widgets (off until
    // toggled). Null when no URL is configured.
    const caltransLayer = createCaltransHighwaysLayer();

    const map = new Map({
      basemap: "hybrid",
      layers: caltransLayer ? [caltransLayer, graphicsLayer] : [graphicsLayer],
    });

    const view = new MapView({
      container: divRef.current,
      map,
      center: [-121.4944, 38.5816],
      zoom: 10,
    });

    const home = new Home({ view });
    const locate = new Locate({ view });
    const compass = new Compass({ view });
    const scaleBar = new ScaleBar({ view, unit: "dual" });
    const search = new Search({ view });
    const basemapGallery = new BasemapGallery({ view });
    const layerList = new LayerList({ view });
    const legend = new Legend({ view });
    const measurement = new Measurement({ view });
    const coordinateConversion = new CoordinateConversion({ view });
    const subscriptions: Array<{ remove: () => void }> = [];

    const searchExpand = new Expand({ view, content: search, expandTooltip: "Search" });
    const basemapExpand = new Expand({
      view,
      content: basemapGallery,
      expandTooltip: "Basemap gallery",
    });
    const layerExpand = new Expand({ view, content: layerList, expandTooltip: "Layers" });
    const legendExpand = new Expand({ view, content: legend, expandTooltip: "Legend" });
    const measurementExpand = new Expand({
      view,
      content: measurement,
      expandTooltip: "Measurement tools",
    });
    const coordinatesExpand = new Expand({
      view,
      content: coordinateConversion,
      expandTooltip: "Coordinates",
    });

    view.ui.add(home, "top-left");
    view.ui.add(locate, "top-left");
    view.ui.add(compass, "top-left");
    view.ui.add(scaleBar, "bottom-left");
    view.ui.add(searchExpand, "top-right");
    view.ui.add(basemapExpand, "top-right");
    view.ui.add(layerExpand, "top-right");
    view.ui.add(legendExpand, "top-right");
    view.ui.add(measurementExpand, "bottom-right");
    view.ui.add(coordinatesExpand, "bottom-right");

    if (editable) {
      const sketch = new Sketch({
        view,
        layer: graphicsLayer,
        availableCreateTools: ["point", "polyline", "polygon", "rectangle", "circle"],
        creationMode: "update",
        visibleElements: {
          selectionTools: {
            "lasso-selection": true,
            "rectangle-selection": true,
          },
          settingsMenu: true,
          undoRedoMenu: true,
        },
      });
      const sketchExpand = new Expand({
        view,
        content: sketch,
        expandTooltip: "Draw and edit geometry",
      });
      view.ui.add(sketchExpand, "bottom-right");

      const currentSubmissionGraphic = () => {
        const filtered = graphicsLayer.graphics
          .toArray()
          .filter((graphic) => !graphic.attributes?.__location_marker);
        return filtered.length > 0 ? filtered[filtered.length - 1] : null;
      };

      subscriptions.push(
        sketch.on("create", (event: any) => {
          if (event.state !== "complete") return;
          const createdGraphic = event.graphic;
          graphicsLayer.graphics.toArray().forEach((graphic) => {
            if (graphic === createdGraphic || graphic.attributes?.__location_marker) return;
            graphicsLayer.remove(graphic);
          });
          onGeometryChange?.(toGeoJsonGeometry(createdGraphic?.geometry));
        })
      );

      subscriptions.push(
        sketch.on("update", (event: any) => {
          if (event.state !== "complete") return;
          const updatedGraphic = event.graphics?.[0] ?? currentSubmissionGraphic();
          onGeometryChange?.(toGeoJsonGeometry(updatedGraphic?.geometry));
        })
      );

      subscriptions.push(
        sketch.on("delete", () => {
          const remaining = currentSubmissionGraphic();
          onGeometryChange?.(toGeoJsonGeometry(remaining?.geometry));
        })
      );
    }

    viewRef.current = view;

    return () => {
      subscriptions.forEach((sub) => sub.remove());
      layerRef.current = null;
      viewRef.current = null;
      view.destroy();
    };
  }, [editable, onGeometryChange]);

  const goToRecordedLocation = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    if (
      location &&
      typeof location.latitude === "number" &&
      typeof location.longitude === "number" &&
      !Number.isNaN(location.latitude) &&
      !Number.isNaN(location.longitude)
    ) {
      view
        .goTo({
          center: [location.longitude, location.latitude],
          zoom: 16,
        })
        .catch(() => {});
      return;
    }
    const ext = layerRef.current?.fullExtent;
    if (ext) {
      view.goTo(ext.expand(1.35)).catch(() => {});
    }
  }, [location]);

  useEffect(() => {
    const view = viewRef.current;
    const graphicsLayer = layerRef.current;

    if (!view || !graphicsLayer) return;

    graphicsLayer.removeAll();

    const hasLocationPoint =
      location != null &&
      typeof location.latitude === "number" &&
      typeof location.longitude === "number" &&
      !Number.isNaN(location.latitude) &&
      !Number.isNaN(location.longitude);

    const pointKey = (coords: any) =>
      Array.isArray(coords) && coords.length >= 2
        ? `${Number(coords[0]).toFixed(6)}:${Number(coords[1]).toFixed(6)}`
        : null;

    const geometryPoints = new Set<string>();
    const t = geojson ? String(geojson.type || "").toLowerCase() : "";

    const firstCoord = (value: any): [number, number] | null => {
      if (!Array.isArray(value)) return null;
      if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
        return [Number(value[0]), Number(value[1])];
      }
      for (const item of value) {
        const found = firstCoord(item);
        if (found) return found;
      }
      return null;
    };

    const inferSpatialReference = (coords: any) => {
      const p = firstCoord(coords);
      if (!p) return SpatialReference.WGS84;
      const [x, y] = p;
      const looksMercator = Math.abs(x) > 180 || Math.abs(y) > 90;
      return looksMercator ? SpatialReference.WebMercator : SpatialReference.WGS84;
    };

    const goToIfPossible = (geometry: any) => {
      const ext = geometry?.extent;
      if (ext) {
        view.goTo(ext.expand(1.5)).catch(() => {});
        return;
      }
      if (geometry?.type === "point") {
        view.goTo({ center: geometry, zoom: 15 }).catch(() => {});
      }
    };

    const addPolygon = (rings: any) => {
      const sr = inferSpatialReference(rings);
      const polygon = new Polygon({
        rings,
        spatialReference: sr,
      });

      const graphic = new Graphic({
        geometry: polygon,
        attributes: { __submission_geometry: true },
        symbol: {
          type: "simple-fill",
          color: [220, 38, 38, 0.14],
          outline: { width: 2, color: [220, 38, 38, 0.95] },
        } as any,
      });

      graphicsLayer.add(graphic);
      goToIfPossible(polygon);
    };

    const addLineString = (paths: any) => {
      const sr = inferSpatialReference(paths);
      const line = new Polyline({
        paths,
        spatialReference: sr,
      });
      const graphic = new Graphic({
        geometry: line,
        attributes: { __submission_geometry: true },
        symbol: {
          type: "simple-line",
          width: 3,
          color: [20, 93, 203, 0.95],
        } as any,
      });
      graphicsLayer.add(graphic);
      goToIfPossible(line);
    };

    const addPoint = (coordinates: any) => {
      if (!Array.isArray(coordinates) || coordinates.length < 2) return;
      const sr = inferSpatialReference(coordinates);
      const point = new Point({
        x: Number(coordinates[0]),
        y: Number(coordinates[1]),
        spatialReference: sr,
      });
      const graphic = new Graphic({
        geometry: point,
        attributes: { __submission_geometry: true },
        symbol: {
          type: "simple-marker",
          color: [20, 93, 203, 0.92],
          size: 10,
          outline: { color: [255, 255, 255, 1], width: 1.5 },
        } as any,
      });
      graphicsLayer.add(graphic);
      const k = pointKey(coordinates);
      if (k) geometryPoints.add(k);
      goToIfPossible(point);
    };

    let addedAnyGeometry = false;

    if (t === "polygon") {
      const rings = geojson.coordinates;
      if (Array.isArray(rings) && rings.length) addPolygon(rings);
      addedAnyGeometry = true;
    }

    if (t === "multipolygon") {
      const polygons = geojson.coordinates;
      if (Array.isArray(polygons)) {
        polygons.forEach((poly: any) => {
          if (Array.isArray(poly) && poly.length) addPolygon(poly);
        });
        addedAnyGeometry = polygons.length > 0;
      }
    }

    if (t === "linestring") {
      const path = geojson.coordinates;
      if (path?.length) addLineString(path);
      addedAnyGeometry = true;
    }

    if (t === "multilinestring") {
      const paths = geojson.coordinates;
      if (paths?.length) addLineString(paths);
      addedAnyGeometry = true;
    }

    if (t === "point") {
      addPoint(geojson.coordinates);
      addedAnyGeometry = true;
    }

    if (t === "multipoint") {
      if (Array.isArray(geojson.coordinates)) {
        geojson.coordinates.forEach((p: any) => addPoint(p));
        addedAnyGeometry = geojson.coordinates.length > 0;
      }
    }

    if (hasLocationPoint) {
      const coords = [location.longitude as number, location.latitude as number];
      const key = pointKey(coords);
      if (!key || !geometryPoints.has(key)) {
        const locationPoint = new Point({
          longitude: location.longitude as number,
          latitude: location.latitude as number,
          spatialReference: SpatialReference.WGS84,
        });
        const locationGraphic = new Graphic({
          geometry: locationPoint,
          attributes: { __location_marker: true },
          symbol: {
            type: "simple-marker",
            color: [37, 99, 235, 0.95],
            size: 11,
            outline: { color: [255, 255, 255, 1], width: 2 },
          } as any,
        });
        graphicsLayer.add(locationGraphic);
      }
    }

    const extent = graphicsLayer.fullExtent;
    if (extent) {
      view.goTo(extent.expand(1.35)).catch(() => {});
    } else if (
      !addedAnyGeometry &&
      hasLocationPoint &&
      location &&
      typeof location.latitude === "number" &&
      typeof location.longitude === "number"
    ) {
      view.goTo({ center: [location.longitude, location.latitude], zoom: 16 }).catch(() => {});
    }
  }, [geojson, location]);

  useEffect(() => {
    if (autoCenteredRef.current) return;
    if (
      location &&
      typeof location.latitude === "number" &&
      typeof location.longitude === "number" &&
      !Number.isNaN(location.latitude) &&
      !Number.isNaN(location.longitude)
    ) {
      autoCenteredRef.current = true;
      goToRecordedLocation();
    }
  }, [location, goToRecordedLocation]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const id = window.setTimeout(() => {
      (view as any).resize?.();
    }, 220);
    return () => window.clearTimeout(id);
  }, [expanded, height]);

  useEffect(() => {
    if (!expanded) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [expanded]);

  const mapHeight = expanded ? "min(88vh, 900px)" : height;

  return (
    <div className={expanded ? "fixed inset-0 z-50 flex items-center justify-center p-3" : "relative"}>
      {expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="absolute inset-0"
          style={{
            backgroundColor: "rgba(15, 23, 42, 0.16)",
            backdropFilter: "blur(10px) saturate(125%)",
            WebkitBackdropFilter: "blur(10px) saturate(125%)",
          }}
          aria-label="Close map overlay"
        />
      ) : null}

      <div
        className={expanded ? "relative z-10 w-[min(96vw,1400px)] rounded-xl border border-[var(--line)] p-2 shadow-2xl" : "relative"}
        style={expanded ? { backgroundColor: "color-mix(in oklab, var(--panel) 84%, transparent)" } : undefined}
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className={expanded
            ? "absolute -right-3 -top-3 z-20 h-8 w-8 rounded-full border border-[var(--line)] bg-[var(--panel)] text-sm font-semibold leading-none shadow-lg hover:brightness-95"
            : "absolute -right-3 -top-3 z-20 rounded-md border border-[var(--line)] bg-[var(--panel)] px-2 py-1 text-xs shadow-lg hover:brightness-95"}
          title={expanded ? "Close expanded map" : "Expand map"}
        >
          {expanded ? "X" : "Expand"}
        </button>
        <div
          ref={divRef}
          style={{ width: "100%", height: mapHeight, borderRadius: expanded ? 10 : 12, overflow: "hidden" }}
        />
      </div>
    </div>
  );
}
