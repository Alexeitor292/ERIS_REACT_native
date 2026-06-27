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
  deriveSceneHealth,
  evaluateLayerHealth,
  extractRenderableGeometries,
  gridBoundingRing,
  incidentSummaryLine,
  initialViewpointFor,
  isArcgisAccessError,
  isElementFullscreen,
  isValidIncidentLocation,
  overlayAvailability,
  sceneContainerClass,
  supportsFullscreenApi,
  terrainSceneErrorMessage,
  type GeoJsonGeometry,
  type LayerLike,
  type SceneBasemapMode,
  type SceneLoadFailure,
  type ServiceHealth,
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
type ServiceWarning = { kind: "imagery" | "elevation" | "access" } | null;

type OverlayToggles = {
  incidentMarker: boolean;
  roadBearing: boolean;
  terrainExtent: boolean;
  uploadedGeometry: boolean;
};

const WGS84 = SpatialReference.WGS84;
const OK_HEALTH: ServiceHealth = { failed: false, access: false };

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
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<SceneView | null>(null);
  const mapRef = useRef<Map | null>(null);
  const overlayRef = useRef<GraphicsLayer | null>(null);
  const elevHealthRef = useRef<ServiceHealth>(OK_HEALTH);
  const nativeFsRef = useRef(false);

  const [fullscreen, setFullscreen] = useState(false);
  const [nativeFs, setNativeFs] = useState(false);
  const [basemapMode, setBasemapMode] = useState<SceneBasemapMode>("satellite");
  const [status, setStatus] = useState<SceneStatus>("loading");
  const [errorKind, setErrorKind] = useState<SceneLoadFailure>("unknown");
  const [warning, setWarning] = useState<ServiceWarning>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const vp = useMemo(() => initialViewpointFor(location), [location]);
  const available = useMemo(
    () => overlayAvailability({ location, terrain, geometryJson }),
    [location, terrain, geometryJson],
  );

  const [toggles, setToggles] = useState<OverlayToggles>({
    incidentMarker: true,
    roadBearing: true,
    terrainExtent: false,
    uploadedGeometry: true,
  });

  nativeFsRef.current = nativeFs;

  const goToIncident = useCallback(() => {
    const view = viewRef.current;
    if (!view || !vp) return;
    view
      .goTo({ target: [vp.target[0], vp.target[1]], tilt: vp.tilt, heading: vp.heading, zoom: vp.zoom }, { animate: true })
      .catch(() => {});
  }, [vp]);

  const applyHealth = useCallback((imagery: ServiceHealth, elevation: ServiceHealth) => {
    const health = deriveSceneHealth(imagery, elevation);
    if (health.blocking) {
      setErrorKind(health.blocking);
      setStatus("error");
    } else {
      setWarning(health.warning);
      setStatus("ready");
    }
  }, []);

  // ---- Create the SceneView (and fully recreate on retry via reloadKey) ------
  useEffect(() => {
    if (!containerRef.current || !vp) return;

    esriConfig.assetsPath = "/assets";
    // Browser-safe, domain-restricted ArcGIS key (never the backend server key).
    const envApiKey = (import.meta as { env?: Record<string, string> }).env?.VITE_ARCGIS_API_KEY;
    if (envApiKey) esriConfig.apiKey = String(envApiKey);

    setStatus("loading");
    setWarning(null);

    const overlay = new GraphicsLayer({ title: "Operational overlays" });
    (overlay as unknown as { elevationInfo: unknown }).elevationInfo = { mode: "on-the-ground" };
    overlayRef.current = overlay;

    const map = new Map({
      basemap: basemapIdFor(basemapMode),
      ground: "world-elevation",
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
      .when(async () => {
        if (cancelled) return;
        view
          .goTo(
            { target: [vp.target[0], vp.target[1]], tilt: vp.tilt, heading: vp.heading, zoom: vp.zoom },
            { animate: false },
          )
          .catch(() => {});
        // Probe REAL service health from layer loadStatus/loadError (not counts).
        await Promise.allSettled([
          map.basemap?.loadAll?.() ?? Promise.resolve(null),
          map.ground?.loadAll?.() ?? Promise.resolve(null),
        ]);
        if (cancelled) return;
        const imagery = evaluateLayerHealth(
          (map.basemap?.baseLayers?.toArray?.() ?? []) as unknown as LayerLike[],
        );
        const elevation = evaluateLayerHealth(
          (map.ground?.layers?.toArray?.() ?? []) as unknown as LayerLike[],
        );
        elevHealthRef.current = elevation;
        applyHealth(imagery, elevation);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setErrorKind(isArcgisAccessError(err) ? "access" : "unknown");
        setStatus("error");
      });

    return () => {
      cancelled = true;
      overlayRef.current = null;
      mapRef.current = null;
      viewRef.current = null;
      elevHealthRef.current = OK_HEALTH;
      view.destroy();
    };
    // Recreated per incident anchor and on retry; basemap/overlays handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vp, reloadKey]);

  const retry = useCallback(() => {
    setErrorKind("unknown");
    setWarning(null);
    setStatus("loading");
    setReloadKey((k) => k + 1); // tears down and recreates the view/map/layers
  }, []);

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

  // ---- Basemap (satellite / topographic) toggle + imagery re-probe -----------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const bm = Basemap.fromId(basemapIdFor(basemapMode));
    if (!bm) return;
    map.basemap = bm;
    if (status !== "ready") return;
    let cancelled = false;
    (bm.loadAll?.() ?? Promise.resolve(null))
      .catch(() => {})
      .finally(() => {
        if (cancelled) return;
        const imagery = evaluateLayerHealth(
          (bm.baseLayers?.toArray?.() ?? []) as unknown as LayerLike[],
        );
        applyHealth(imagery, elevHealthRef.current);
      });
    return () => {
      cancelled = true;
    };
  }, [basemapMode, status, applyHealth]);

  // ---- Rebuild overlays when toggles / data change ---------------------------
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    overlay.removeAll();

    const validLoc = isValidIncidentLocation(location);

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

    if (toggles.uploadedGeometry && available.uploadedGeometry && geometryJson) {
      for (const geom of extractRenderableGeometries(geometryJson)) addGeoJsonGeometry(overlay, geom);
    }

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

  // ---- Fullscreen (real Fullscreen API + CSS fallback) -----------------------
  const toggleFullscreen = useCallback(async () => {
    const el = wrapperRef.current;
    if (!fullscreen) {
      if (el && supportsFullscreenApi(document, el)) {
        try {
          await el.requestFullscreen();
          return; // fullscreenchange handler sets state
        } catch {
          /* fall back to CSS */
        }
      }
      setNativeFs(false);
      setFullscreen(true);
      return;
    }
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
        return;
      } catch {
        /* fall back */
      }
    }
    setNativeFs(false);
    setFullscreen(false);
  }, [fullscreen]);

  // Keep button/state synced with Esc and native browser fullscreen controls.
  useEffect(() => {
    const onChange = () => {
      const active = isElementFullscreen(document, wrapperRef.current);
      if (active) {
        setNativeFs(true);
        setFullscreen(true);
      } else if (nativeFsRef.current) {
        setNativeFs(false);
        setFullscreen(false);
      }
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // ---- Restore scrolling + resize SceneView on fullscreen change -------------
  useEffect(() => {
    const view = viewRef.current;
    const id = window.setTimeout(() => {
      (view as unknown as { resize?: () => void } | null)?.resize?.();
    }, 180);
    // Only lock body scroll for the CSS fallback; native fullscreen is handled
    // by the browser. Always restored on cleanup.
    if (fullscreen && !nativeFs) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        window.clearTimeout(id);
        document.body.style.overflow = prev;
      };
    }
    return () => window.clearTimeout(id);
  }, [fullscreen, nativeFs]);

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

  const fsHeightStyle = fullscreen ? (nativeFs ? { height: "100vh" } : undefined) : { height };

  return (
    <div ref={wrapperRef} className={sceneContainerClass(fullscreen, nativeFs)} style={fsHeightStyle}>
      <div ref={containerRef} className="absolute inset-0" />

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
            onClick={toggleFullscreen}
            className="rounded bg-white/85 px-2 py-1 text-[10px] font-medium text-slate-800 shadow hover:bg-white"
            title={fullscreen ? "Exit full screen" : "Full screen"}
          >
            {fullscreen ? "Exit full screen" : "Full screen"}
          </button>
        </div>
      </div>

      {/* Non-blocking service warning (one of imagery/elevation failed) */}
      {status === "ready" && warning && (
        <div className="absolute left-1/2 top-2 z-10 max-w-[min(92%,460px)] -translate-x-1/2 rounded-md border border-amber-400/50 bg-amber-500/90 px-2.5 py-1 text-center text-[10px] font-medium text-slate-900 shadow">
          {terrainSceneErrorMessage(warning.kind)}
        </div>
      )}

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

      {/* Blocking error state */}
      {status === "error" && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-[#0f172a]/85 p-6 text-center">
          <div className="max-w-md text-xs text-white/90">
            <div className="mb-1 text-sm font-semibold text-amber-300">3D map could not load</div>
            <div>{terrainSceneErrorMessage(errorKind)}</div>
            <button
              type="button"
              onClick={retry}
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

/** Render a single validated GeoJSON geometry primitive as overlay graphic(s). */
function addGeoJsonGeometry(layer: GraphicsLayer, geom: GeoJsonGeometry) {
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

  const addPoint = (c: number[]) =>
    layer.add(
      new Graphic({
        geometry: new Point({ x: Number(c[0]), y: Number(c[1]), spatialReference: WGS84 }),
        symbol: pointSym,
        attributes: { __overlay: "uploaded_geometry" },
      }),
    );
  const addLine = (paths: number[][][]) =>
    layer.add(
      new Graphic({
        geometry: new Polyline({ paths, spatialReference: WGS84 }),
        symbol: lineSym,
        attributes: { __overlay: "uploaded_geometry" },
      }),
    );
  const addPolygon = (rings: number[][][]) =>
    layer.add(
      new Graphic({
        geometry: new Polygon({ rings, spatialReference: WGS84 }),
        symbol: fillSym,
        attributes: { __overlay: "uploaded_geometry" },
      }),
    );

  const c = geom.coordinates;
  switch (geom.type) {
    case "Point":
      addPoint(c as number[]);
      break;
    case "MultiPoint":
      (c as number[][]).forEach(addPoint);
      break;
    case "LineString":
      addLine([c as number[][]]);
      break;
    case "MultiLineString":
      addLine(c as number[][][]);
      break;
    case "Polygon":
      addPolygon(c as number[][][]);
      break;
    case "MultiPolygon":
      (c as number[][][][]).forEach(addPolygon);
      break;
    default:
      break;
  }
}
