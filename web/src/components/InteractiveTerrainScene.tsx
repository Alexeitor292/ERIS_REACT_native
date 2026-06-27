import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import esriConfig from "@arcgis/core/config";
import Map from "@arcgis/core/Map";
import Basemap from "@arcgis/core/Basemap";
import SceneView from "@arcgis/core/views/SceneView";
import Graphic from "@arcgis/core/Graphic";
import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer";
import Point from "@arcgis/core/geometry/Point";
import Polyline from "@arcgis/core/geometry/Polyline";
import Polygon from "@arcgis/core/geometry/Polygon";
import SpatialReference from "@arcgis/core/geometry/SpatialReference";
import Home from "@arcgis/core/widgets/Home";
import Compass from "@arcgis/core/widgets/Compass";

import type { GisaTerrainGrid } from "../api/types";
import {
  basemapIdFor,
  bearingLineEndpoints,
  gridBoundingRing,
  incidentSummaryLine,
  initialViewpointFor,
  isValidIncidentLocation,
  overlayAvailability,
  sceneContainerClass,
  terrainSceneErrorMessage,
  type SceneBasemapMode,
} from "./terrainScene";

type Props = {
  location?: { latitude: number | null; longitude: number | null } | null;
  terrain?: GisaTerrainGrid | null;
  geometryJson?: Record<string, unknown> | null;
  route?: string | null;
  postMile?: string | null;
  county?: string | null;
  incidentLabel?: string | null;
  height?: number;
};

type SceneStatus = "loading" | "ready" | "error";

type OverlayToggles = {
  incidentMarker: boolean;
  roadBearing: boolean;
  terrainExtent: boolean;
  uploadedGeometry: boolean;
};

const WGS84 = SpatialReference.WGS84;

export default function InteractiveTerrainScene({
  location = null,
  terrain = null,
  geometryJson = null,
  route = null,
  postMile = null,
  county = null,
  incidentLabel = null,
  height = 460,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<SceneView | null>(null);
  const mapRef = useRef<Map | null>(null);
  const overlayRef = useRef<GraphicsLayer | null>(null);

  const [fullscreen, setFullscreen] = useState(false);
  const [basemapMode, setBasemapMode] = useState<SceneBasemapMode>("satellite");
  const [status, setStatus] = useState<SceneStatus>("loading");
  const [errorKind, setErrorKind] = useState<"elevation" | "imagery" | "both" | "unknown">("unknown");

  const vp = useMemo(() => initialViewpointFor(location), [location]);
  const available = useMemo(
    () => overlayAvailability({ location, terrain, geometryJson }),
    [location, terrain, geometryJson],
  );

  // Default each overlay ON only where real data backs it.
  const [toggles, setToggles] = useState<OverlayToggles>({
    incidentMarker: true,
    roadBearing: true,
    terrainExtent: false,
    uploadedGeometry: true,
  });

  const goToIncident = useCallback(() => {
    const view = viewRef.current;
    if (!view || !vp) return;
    view
      .goTo({ target: [vp.target[0], vp.target[1]], tilt: vp.tilt, heading: vp.heading, zoom: vp.zoom }, { animate: true })
      .catch(() => {});
  }, [vp]);

  // ---- Create the SceneView once (only with a valid incident anchor). --------
  useEffect(() => {
    if (!containerRef.current || !vp) return;

    esriConfig.assetsPath = "/assets";
    const envApiKey = (import.meta as { env?: Record<string, string> }).env?.VITE_ARCGIS_API_KEY;
    if (envApiKey) esriConfig.apiKey = String(envApiKey);

    const overlay = new GraphicsLayer({ title: "Operational overlays" });
    // Drape overlays on the terrain surface (truthful — follows real elevation).
    (overlay as unknown as { elevationInfo: unknown }).elevationInfo = { mode: "on-the-ground" };
    overlayRef.current = overlay;

    const map = new Map({
      basemap: basemapIdFor(basemapMode),
      ground: "world-elevation", // real Esri streaming elevation surface
      layers: [overlay],
    });
    mapRef.current = map;

    const view = new SceneView({
      container: containerRef.current,
      map,
      camera: {
        position: { longitude: vp.target[0], latitude: vp.target[1], z: 2500 },
        tilt: vp.tilt,
        heading: vp.heading,
      } as never,
      qualityProfile: "high",
    });
    viewRef.current = view;

    let cancelled = false;
    view
      .when(() => {
        if (cancelled) return;
        setStatus("ready");
        // Frame obliquely on the incident once the surface is ready.
        view
          .goTo(
            { target: [vp.target[0], vp.target[1]], tilt: vp.tilt, heading: vp.heading, zoom: vp.zoom },
            { animate: false },
          )
          .catch(() => {});
      })
      .catch(() => {
        if (cancelled) return;
        // Distinguish elevation vs imagery failure where we can.
        const groundFailed = (map.ground?.layers?.length ?? 0) === 0;
        setErrorKind(groundFailed ? "both" : "imagery");
        setStatus("error");
      });

    return () => {
      cancelled = true;
      overlayRef.current = null;
      mapRef.current = null;
      viewRef.current = null;
      view.destroy();
    };
    // Created once per incident anchor; basemap/overlay changes are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vp]);

  // ---- Home / Compass widgets ------------------------------------------------
  useEffect(() => {
    const view = viewRef.current;
    if (!view || status !== "ready") return;
    const home = new Home({ view });
    const compass = new Compass({ view });
    view.ui.add(home, "top-left");
    view.ui.add(compass, "top-left");
    return () => {
      view.ui.remove(home);
      view.ui.remove(compass);
      home.destroy();
      compass.destroy();
    };
  }, [status]);

  // ---- Basemap (satellite / topographic) toggle ------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    try {
      map.basemap = Basemap.fromId(basemapIdFor(basemapMode));
    } catch {
      /* keep current basemap */
    }
  }, [basemapMode]);

  // ---- Rebuild overlays when toggles / data change ---------------------------
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    overlay.removeAll();

    const validLoc = isValidIncidentLocation(location);

    // Terrain sample extent (real sampled grid boundary).
    if (toggles.terrainExtent && available.terrainExtent) {
      const ring = gridBoundingRing(terrain?.grid?.points ?? null);
      if (ring) {
        overlay.add(
          new Graphic({
            geometry: new Polygon({ rings: [ring], spatialReference: WGS84 }),
            symbol: {
              type: "simple-fill",
              color: [56, 189, 248, 0.08],
              outline: { color: [56, 189, 248, 0.9], width: 1.5 },
            } as never,
            attributes: { __overlay: "terrain_extent" },
          }),
        );
      }
    }

    // Road bearing direction (ONLY when a real bearing was resolved).
    if (toggles.roadBearing && available.roadBearing && validLoc) {
      const bearing = terrain?.road_bearing_deg_used as number;
      const [a, b] = bearingLineEndpoints(location!.latitude as number, location!.longitude as number, bearing, 130);
      overlay.add(
        new Graphic({
          geometry: new Polyline({ paths: [[a, b]], spatialReference: WGS84 }),
          symbol: { type: "simple-line", color: [250, 204, 21, 0.95], width: 3 } as never,
          attributes: { __overlay: "road_bearing" },
        }),
      );
    }

    // Uploaded incident geometry (only when present).
    if (toggles.uploadedGeometry && available.uploadedGeometry && geometryJson) {
      addGeoJson(overlay, geometryJson);
    }

    // Incident marker on top.
    if (toggles.incidentMarker && validLoc) {
      overlay.add(
        new Graphic({
          geometry: new Point({
            longitude: location!.longitude as number,
            latitude: location!.latitude as number,
            spatialReference: WGS84,
          }),
          symbol: {
            type: "simple-marker",
            style: "circle",
            color: [37, 99, 235, 0.95],
            size: 12,
            outline: { color: [255, 255, 255, 1], width: 2 },
          } as never,
          attributes: { __overlay: "incident" },
        }),
      );
    }
  }, [toggles, available, location, terrain, geometryJson]);

  // ---- Resize after fullscreen layout change ---------------------------------
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const id = window.setTimeout(() => {
      (view as unknown as { resize?: () => void }).resize?.();
    }, 180);
    if (fullscreen) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        window.clearTimeout(id);
        document.body.style.overflow = prev;
      };
    }
    return () => window.clearTimeout(id);
  }, [fullscreen]);

  // ---- Missing-coordinate safe empty state -----------------------------------
  if (!vp) {
    return (
      <div
        className="flex flex-col items-center justify-center rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-6 text-center"
        style={{ minHeight: 160 }}
      >
        <div className="mb-1 text-sm font-semibold text-[var(--ink)]">3D terrain map unavailable</div>
        <div className="max-w-md text-xs text-muted">
          This submission has no valid incident coordinates, so the interactive 3D scene cannot be centered. Set the
          incident latitude/longitude to enable the map.
        </div>
      </div>
    );
  }

  const summary = incidentSummaryLine({
    route,
    postMile,
    county,
    latitude: location?.latitude ?? null,
    longitude: location?.longitude ?? null,
  });

  return (
    <div className={sceneContainerClass(fullscreen)} style={fullscreen ? undefined : { height }}>
      <div ref={containerRef} className="absolute inset-0" style={fullscreen ? undefined : { height }} />

      {/* Incident summary + attribution panel */}
      <div className="pointer-events-none absolute left-2 top-2 z-10 max-w-[min(92%,360px)] rounded-md bg-black/55 px-2.5 py-1.5 text-white backdrop-blur-sm">
        <div className="text-[11px] font-semibold leading-tight">{incidentLabel || "Incident location"}</div>
        <div className="text-[10px] leading-tight text-white/80">{summary}</div>
        <div className="mt-0.5 text-[8px] leading-tight text-white/55">
          Terrain & imagery © Esri, Maxar, Earthstar Geographics, USGS, and the GIS community
        </div>
      </div>

      {/* Top-right controls */}
      <div className="absolute right-2 top-2 z-10 flex flex-col items-end gap-1.5">
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => setBasemapMode("satellite")}
            className={`rounded px-2 py-1 text-[10px] font-medium shadow ${basemapMode === "satellite" ? "bg-[var(--brand)] text-white" : "bg-white/85 text-slate-800 hover:bg-white"}`}
          >
            Satellite
          </button>
          <button
            type="button"
            onClick={() => setBasemapMode("topographic")}
            className={`rounded px-2 py-1 text-[10px] font-medium shadow ${basemapMode === "topographic" ? "bg-[var(--brand)] text-white" : "bg-white/85 text-slate-800 hover:bg-white"}`}
          >
            Topographic
          </button>
        </div>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={goToIncident}
            className="rounded bg-white/85 px-2 py-1 text-[10px] font-medium text-slate-800 shadow hover:bg-white"
            title="Reset camera to the incident"
          >
            Reset view
          </button>
          <button
            type="button"
            onClick={() => setFullscreen((v) => !v)}
            className="rounded bg-white/85 px-2 py-1 text-[10px] font-medium text-slate-800 shadow hover:bg-white"
            title={fullscreen ? "Exit full screen" : "Full screen"}
          >
            {fullscreen ? "Exit full screen" : "Full screen"}
          </button>
        </div>
      </div>

      {/* Overlay toggles (only those backed by real data) */}
      <div className="absolute bottom-2 left-2 z-10 flex flex-wrap gap-1.5 rounded-md bg-black/55 px-2 py-1.5 backdrop-blur-sm">
        <OverlayChip
          label="Incident"
          on={toggles.incidentMarker}
          enabled={available.incidentMarker}
          onClick={() => setToggles((t) => ({ ...t, incidentMarker: !t.incidentMarker }))}
        />
        <OverlayChip
          label="Road bearing"
          on={toggles.roadBearing}
          enabled={available.roadBearing}
          onClick={() => setToggles((t) => ({ ...t, roadBearing: !t.roadBearing }))}
        />
        <OverlayChip
          label="Sample extent"
          on={toggles.terrainExtent}
          enabled={available.terrainExtent}
          onClick={() => setToggles((t) => ({ ...t, terrainExtent: !t.terrainExtent }))}
        />
        <OverlayChip
          label="Uploaded geometry"
          on={toggles.uploadedGeometry}
          enabled={available.uploadedGeometry}
          onClick={() => setToggles((t) => ({ ...t, uploadedGeometry: !t.uploadedGeometry }))}
        />
      </div>

      {/* Loading state */}
      {status === "loading" && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-[#0f172a]/70 text-center">
          <div className="text-xs text-white/85">
            <div className="mx-auto mb-2 h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            Loading 3D terrain & imagery…
          </div>
        </div>
      )}

      {/* Error state */}
      {status === "error" && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-[#0f172a]/85 p-6 text-center">
          <div className="max-w-md text-xs text-white/90">
            <div className="mb-1 text-sm font-semibold text-amber-300">3D map could not load</div>
            <div>{terrainSceneErrorMessage(errorKind)}</div>
            <button
              type="button"
              onClick={() => {
                setStatus("loading");
                const view = viewRef.current;
                view?.when(() => setStatus("ready")).catch(() => setStatus("error"));
              }}
              className="mt-3 rounded bg-white/90 px-3 py-1 text-[11px] font-medium text-slate-900 hover:bg-white"
            >
              Retry
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function OverlayChip({
  label,
  on,
  enabled,
  onClick,
}: {
  label: string;
  on: boolean;
  enabled: boolean;
  onClick: () => void;
}) {
  if (!enabled) {
    return (
      <span
        className="cursor-not-allowed rounded px-1.5 py-0.5 text-[9px] text-white/35 line-through"
        title="No real ERIS data available for this overlay"
      >
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-1.5 py-0.5 text-[9px] font-medium ${on ? "bg-sky-400 text-slate-900" : "bg-white/15 text-white/80 hover:bg-white/25"}`}
    >
      {label}
    </button>
  );
}

/** Add a GeoJSON geometry (Point/LineString/Polygon + Multi*) as overlay graphics. */
function addGeoJson(layer: GraphicsLayer, geojson: Record<string, unknown>) {
  const type = String(geojson.type ?? "").toLowerCase();
  const coords = geojson.coordinates as unknown;
  const lineSym = { type: "simple-line", color: [20, 93, 203, 0.95], width: 3 } as never;
  const fillSym = {
    type: "simple-fill",
    color: [220, 38, 38, 0.14],
    outline: { color: [220, 38, 38, 0.95], width: 2 },
  } as never;
  const pointSym = {
    type: "simple-marker",
    color: [20, 93, 203, 0.92],
    size: 9,
    outline: { color: [255, 255, 255, 1], width: 1.5 },
  } as never;

  const addPoint = (c: unknown) => {
    if (!Array.isArray(c) || c.length < 2) return;
    layer.add(
      new Graphic({
        geometry: new Point({ x: Number(c[0]), y: Number(c[1]), spatialReference: WGS84 }),
        symbol: pointSym,
        attributes: { __overlay: "uploaded_geometry" },
      }),
    );
  };
  const addLine = (paths: unknown) => {
    if (!Array.isArray(paths)) return;
    layer.add(
      new Graphic({
        geometry: new Polyline({ paths: paths as number[][][], spatialReference: WGS84 }),
        symbol: lineSym,
        attributes: { __overlay: "uploaded_geometry" },
      }),
    );
  };
  const addPolygon = (rings: unknown) => {
    if (!Array.isArray(rings)) return;
    layer.add(
      new Graphic({
        geometry: new Polygon({ rings: rings as number[][][], spatialReference: WGS84 }),
        symbol: fillSym,
        attributes: { __overlay: "uploaded_geometry" },
      }),
    );
  };

  switch (type) {
    case "point":
      addPoint(coords);
      break;
    case "multipoint":
      (coords as unknown[])?.forEach?.(addPoint);
      break;
    case "linestring":
      addLine([coords]);
      break;
    case "multilinestring":
      addLine(coords);
      break;
    case "polygon":
      addPolygon(coords);
      break;
    case "multipolygon":
      (coords as unknown[])?.forEach?.(addPolygon);
      break;
    default:
      break;
  }
}
