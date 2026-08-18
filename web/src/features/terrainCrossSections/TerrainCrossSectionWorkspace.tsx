import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import esriConfig from "@arcgis/core/config";
import Map from "@arcgis/core/Map";
import Basemap from "@arcgis/core/Basemap";
import SceneView from "@arcgis/core/views/SceneView";
import Graphic from "@arcgis/core/Graphic";
import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer";
import Point from "@arcgis/core/geometry/Point";
import Polyline from "@arcgis/core/geometry/Polyline";
import SpatialReference from "@arcgis/core/geometry/SpatialReference";
import Home from "@arcgis/core/widgets/Home";
import Compass from "@arcgis/core/widgets/Compass";
import Search from "@arcgis/core/widgets/Search";
import * as geodeticDensifyOperator from "@arcgis/core/geometry/operators/geodeticDensifyOperator";

import CrossSectionProfileChart from "./CrossSectionProfileChart";
import SceneDualScaleBar from "./SceneDualScaleBar";
import {
  adaptiveSampleSpacingMeters,
  controlPointDistances,
  formatElevation,
  formatHorizontalDistance,
  pathLengthMeters,
  profileFromPath,
  type CrossSectionControlPoint,
  type CrossSectionProfile,
} from "./terrainCrossSectionModel";

type SceneState = "loading" | "ready" | "error";
type BasemapMode = "satellite" | "topo-vector";

const WGS84 = SpatialReference.WGS84;
const CALIFORNIA_CENTER: [number, number] = [-119.4179, 36.7783];
const MAX_RENDER_SAMPLES = 1800;

function pointKey(point: CrossSectionControlPoint) {
  return `${point.longitude.toFixed(7)}:${point.latitude.toFixed(7)}`;
}

function nearestSampleElevation(profile: CrossSectionProfile | null, controlDistance: number): number | null {
  if (!profile?.samples.length) return null;
  let best = profile.samples[0];
  let bestDelta = Math.abs(best.distance_m - controlDistance);
  for (const sample of profile.samples) {
    const delta = Math.abs(sample.distance_m - controlDistance);
    if (delta < bestDelta) {
      best = sample;
      bestDelta = delta;
    }
  }
  return best.elevation_m;
}

export default function TerrainCrossSectionWorkspace() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<SceneView | null>(null);
  const mapRef = useRef<Map | null>(null);
  const controlLayerRef = useRef<GraphicsLayer | null>(null);
  const profileLayerRef = useRef<GraphicsLayer | null>(null);
  const hoverLayerRef = useRef<GraphicsLayer | null>(null);
  const drawingRef = useRef(false);

  const [sceneState, setSceneState] = useState<SceneState>("loading");
  const [sceneError, setSceneError] = useState<string | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [controlPoints, setControlPoints] = useState<CrossSectionControlPoint[]>([]);
  const [profile, setProfile] = useState<CrossSectionProfile | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [preferredSpacingM, setPreferredSpacingM] = useState(10);
  const [actualSpacingM, setActualSpacingM] = useState<number | null>(null);
  const [metric, setMetric] = useState(false);
  const [basemapMode, setBasemapMode] = useState<BasemapMode>("satellite");
  const [sceneScale, setSceneScale] = useState<number | null>(null);

  drawingRef.current = drawing;

  const controlDistances = useMemo(() => controlPointDistances(controlPoints), [controlPoints]);
  const draftDistanceM = useMemo(() => pathLengthMeters(controlPoints), [controlPoints]);

  const clearHover = useCallback(() => {
    hoverLayerRef.current?.removeAll();
  }, []);

  const showHoverSample = useCallback((sampleIndex: number | null) => {
    const layer = hoverLayerRef.current;
    if (!layer) return;
    layer.removeAll();
    if (sampleIndex == null || !profile) return;
    const sample = profile.samples[sampleIndex];
    if (!sample) return;
    layer.add(new Graphic({
      geometry: new Point({
        longitude: sample.longitude,
        latitude: sample.latitude,
        z: sample.elevation_m + 2,
        spatialReference: WGS84,
      }),
      symbol: {
        type: "simple-marker",
        style: "circle",
        size: 13,
        color: [220, 38, 38, 1],
        outline: { color: [255, 255, 255, 1], width: 2 },
      } as never,
      attributes: { __cross_section_hover: true },
    }));
  }, [profile]);

  useEffect(() => {
    if (!containerRef.current) return;

    esriConfig.assetsPath = "/assets";
    const apiKey = import.meta.env.VITE_ARCGIS_API_KEY;
    if (apiKey) esriConfig.apiKey = String(apiKey);

    setSceneState("loading");
    setSceneError(null);

    const controlLayer = new GraphicsLayer({ title: "Cross-section control points" });
    const profileLayer = new GraphicsLayer({ title: "DEM cross-section profile" });
    const hoverLayer = new GraphicsLayer({ title: "Cross-section cursor" });
    (controlLayer as unknown as { elevationInfo: unknown }).elevationInfo = { mode: "on-the-ground" };
    (profileLayer as unknown as { elevationInfo: unknown }).elevationInfo = { mode: "absolute-height" };
    (hoverLayer as unknown as { elevationInfo: unknown }).elevationInfo = { mode: "absolute-height" };

    controlLayerRef.current = controlLayer;
    profileLayerRef.current = profileLayer;
    hoverLayerRef.current = hoverLayer;

    const map = new Map({
      basemap: "satellite",
      ground: "world-elevation",
      layers: [controlLayer, profileLayer, hoverLayer],
    });
    mapRef.current = map;

    const view = new SceneView({
      container: containerRef.current,
      map,
      camera: {
        position: { longitude: CALIFORNIA_CENTER[0], latitude: CALIFORNIA_CENTER[1], z: 1_650_000 },
        tilt: 0,
        heading: 0,
      } as never,
      qualityProfile: "high",
    });
    viewRef.current = view;

    let disposed = false;
    let clickHandle: { remove: () => void } | null = null;
    let search: Search | null = null;
    let home: Home | null = null;
    let compass: Compass | null = null;
    let scaleHandle: { remove: () => void } | null = null;

    view.when(async () => {
      if (disposed) return;
      await map.ground.loadAll();
      if (disposed) return;

      search = new Search({ view });
      home = new Home({ view });
      compass = new Compass({ view });
      view.ui.add(search, "top-right");
      view.ui.add(home, "top-left");
      view.ui.add(compass, "top-left");
      const updateScale = (value: number) => setSceneScale(Number.isFinite(value) && value > 0 ? value : null);
      updateScale(Number(view.scale));
      scaleHandle = view.watch("scale", (value) => updateScale(Number(value)));

      clickHandle = view.on("click", (event) => {
        if (!drawingRef.current) return;
        event.stopPropagation();
        const mapPoint = event.mapPoint;
        if (!mapPoint) return;
        const longitude = Number(mapPoint.longitude);
        const latitude = Number(mapPoint.latitude);
        if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return;

        setControlPoints((current) => {
          const nextPoint = { longitude, latitude };
          const previous = current[current.length - 1];
          if (previous && pointKey(previous) === pointKey(nextPoint)) return current;
          return [...current, nextPoint];
        });
        setProfile(null);
        setActualSpacingM(null);
        setProfileError(null);
      });

      setSceneState("ready");
    }).catch((error: unknown) => {
      if (disposed) return;
      setSceneError(error instanceof Error ? error.message : "ArcGIS terrain scene failed to load.");
      setSceneState("error");
    });

    return () => {
      disposed = true;
      clickHandle?.remove();
      scaleHandle?.remove();
      setSceneScale(null);
      if (search) view.ui.remove(search);
      if (home) view.ui.remove(home);
      if (compass) view.ui.remove(compass);
      search?.destroy();
      home?.destroy();
      compass?.destroy();
      controlLayerRef.current = null;
      profileLayerRef.current = null;
      hoverLayerRef.current = null;
      mapRef.current = null;
      viewRef.current = null;
      view.destroy();
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const basemap = Basemap.fromId(basemapMode);
    if (basemap) map.basemap = basemap;
  }, [basemapMode]);

  useEffect(() => {
    const layer = controlLayerRef.current;
    if (!layer) return;
    layer.removeAll();

    if (controlPoints.length >= 2) {
      layer.add(new Graphic({
        geometry: new Polyline({
          paths: [controlPoints.map((point) => [point.longitude, point.latitude])],
          spatialReference: WGS84,
        }),
        symbol: {
          type: "simple-line",
          color: [37, 99, 235, 0.95],
          width: 3,
          style: drawing ? "dash" : "solid",
        } as never,
        attributes: { __cross_section_control_path: true },
      }));
    }

    controlPoints.forEach((point, index) => {
      layer.add(new Graphic({
        geometry: new Point({ longitude: point.longitude, latitude: point.latitude, spatialReference: WGS84 }),
        symbol: {
          type: "simple-marker",
          style: "circle",
          color: [37, 99, 235, 1],
          size: 11,
          outline: { color: [255, 255, 255, 1], width: 2 },
        } as never,
        attributes: { point_number: index + 1 },
        popupTemplate: {
          title: `Control point P${index + 1}`,
          content: `${point.latitude.toFixed(6)}, ${point.longitude.toFixed(6)}`,
        },
      }));
      layer.add(new Graphic({
        geometry: new Point({ longitude: point.longitude, latitude: point.latitude, spatialReference: WGS84 }),
        symbol: {
          type: "text",
          text: `P${index + 1}`,
          color: [255, 255, 255, 1],
          haloColor: [15, 23, 42, 0.95],
          haloSize: 2,
          yoffset: 18,
          font: { size: 11, weight: "bold" },
        } as never,
      }));
    });
  }, [controlPoints, drawing]);

  useEffect(() => {
    const layer = profileLayerRef.current;
    if (!layer) return;
    layer.removeAll();
    if (!profile?.samples.length) return;
    layer.add(new Graphic({
      geometry: new Polyline({
        hasZ: true,
        paths: [profile.samples.map((sample) => [sample.longitude, sample.latitude, sample.elevation_m + 1])],
        spatialReference: WGS84,
      }),
      symbol: {
        type: "simple-line",
        color: [250, 204, 21, 1],
        width: 5,
      } as never,
      attributes: { __cross_section_sampled_profile: true },
    }));
  }, [profile]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const container = view.container as HTMLElement | null;
    if (container) container.style.cursor = drawing ? "crosshair" : "default";
  }, [drawing]);

  function beginDrawing() {
    clearHover();
    setControlPoints([]);
    setProfile(null);
    setActualSpacingM(null);
    setProfileError(null);
    setDrawing(true);
  }

  function continueDrawing() {
    clearHover();
    setProfile(null);
    setActualSpacingM(null);
    setProfileError(null);
    setDrawing(true);
  }

  function undoLastPoint() {
    clearHover();
    setControlPoints((current) => current.slice(0, -1));
    setProfile(null);
    setActualSpacingM(null);
    setProfileError(null);
  }

  function clearAll() {
    clearHover();
    setDrawing(false);
    setControlPoints([]);
    setProfile(null);
    setActualSpacingM(null);
    setProfileError(null);
  }

  async function buildProfile() {
    const map = mapRef.current;
    const view = viewRef.current;
    if (!map || !view || controlPoints.length < 2) return;

    setDrawing(false);
    setProfileBusy(true);
    setProfileError(null);
    clearHover();
    try {
      const rawLine = new Polyline({
        paths: [controlPoints.map((point) => [point.longitude, point.latitude])],
        spatialReference: WGS84,
      });
      const totalLength = pathLengthMeters(controlPoints);
      const spacing = adaptiveSampleSpacingMeters(totalLength, {
        preferredSpacingM,
        maxSamples: MAX_RENDER_SAMPLES,
      });
      setActualSpacingM(spacing);

      if (!geodeticDensifyOperator.isLoaded()) await geodeticDensifyOperator.load();
      const densified = geodeticDensifyOperator.execute(rawLine, spacing, {
        curveType: "geodesic",
        unit: "meters",
      }) as Polyline | null | undefined;
      if (!densified) throw new Error("ArcGIS could not densify the selected cross-section path.");

      const elevation = await map.ground.queryElevation(densified, {
        demResolution: "auto",
        returnSampleInfo: true,
      });
      const sampled = elevation.geometry as Polyline;
      const path = sampled.paths?.[0] ?? [];
      const nextProfile = profileFromPath(path, elevation.noDataValue);
      if (!nextProfile) throw new Error("No usable DEM elevation samples were returned for this path.");
      setProfile(nextProfile);

      const profileLine = new Polyline({
        hasZ: true,
        paths: [nextProfile.samples.map((sample) => [sample.longitude, sample.latitude, sample.elevation_m])],
        spatialReference: WGS84,
      });
      const profileExtent = profileLine.extent;
      if (profileExtent) {
        view.goTo(profileExtent.expand(1.25), { animate: true }).catch(() => {});
      }
    } catch (error: any) {
      setProfile(null);
      setProfileError(error?.message ?? "Failed to sample ArcGIS terrain elevation.");
    } finally {
      setProfileBusy(false);
    }
  }

  const profileControlRows = controlPoints.map((point, index) => ({
    point,
    distance: controlDistances[index] ?? 0,
    elevation: nearestSampleElevation(profile, controlDistances[index] ?? 0),
  }));

  return (
    <div className="flex min-h-[760px] flex-col gap-4 p-4 md:p-5">
      <div className="flex flex-col gap-3 rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] p-4 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <div className="text-sm font-semibold">ArcGIS DEM cross-section workspace</div>
          <div className="mt-1 max-w-4xl text-sm text-muted">
            Select two or more control points directly on the 3D terrain. ERIS connects them into one continuous cross-section path, samples the ArcGIS elevation surface between them, and plots the resulting profile. This Web tool has no fixed 1.5 km path limit.
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={beginDrawing} disabled={sceneState !== "ready" || profileBusy} className="rounded-md bg-[var(--brand)] px-3 py-2 text-sm font-semibold text-white hover:brightness-95 disabled:opacity-50">New cross section</button>
          {controlPoints.length > 0 && !drawing ? <button type="button" onClick={continueDrawing} disabled={profileBusy} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)]">Add more points</button> : null}
          <button type="button" onClick={undoLastPoint} disabled={controlPoints.length === 0 || profileBusy} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50">Undo point</button>
          <button type="button" onClick={clearAll} disabled={controlPoints.length === 0 || profileBusy} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium text-[var(--bad)] hover:bg-[var(--panel-soft)] disabled:opacity-50">Clear</button>
        </div>
      </div>

      <div className="grid flex-1 items-start gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(520px,0.85fr)]">
        <div className="relative min-h-[560px] overflow-hidden rounded-xl border border-[var(--line)] bg-[#0f172a] xl:sticky xl:top-[82px] xl:h-[calc(100vh-110px)] xl:max-h-[780px]">
          <div ref={containerRef} className="absolute inset-0" />

          <div className="pointer-events-none absolute left-3 top-3 z-10 max-w-[min(90%,520px)] rounded-lg bg-black/60 px-3 py-2 text-white backdrop-blur-sm">
            <div className="text-xs font-semibold">Terrain Cross Sections</div>
            <div className="mt-0.5 text-[11px] text-white/75">
              {drawing
                ? `Drawing active — click the DEM to place P${controlPoints.length + 1}. Pan/rotate with drag; use Finish profile when ready.`
                : controlPoints.length >= 2
                  ? "Selection complete. Build the profile or add more control points."
                  : "Search or navigate to an area, then start a new cross section."}
            </div>
          </div>

          <div className="absolute bottom-3 left-3 z-10 flex overflow-hidden rounded-lg border border-white/20 bg-black/55 text-[11px] text-white backdrop-blur-sm">
            {(["satellite", "topo-vector"] as BasemapMode[]).map((mode) => (
              <button key={mode} type="button" onClick={() => setBasemapMode(mode)} className={`px-3 py-2 ${basemapMode === mode ? "bg-white/20 font-semibold" : "hover:bg-white/10"}`}>{mode === "satellite" ? "Imagery" : "Topographic"}</button>
            ))}
          </div>

          <SceneDualScaleBar scale={sceneScale} />

          {sceneState === "loading" ? (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-[#0f172a]/80 text-sm text-white">Loading ArcGIS 3D terrain…</div>
          ) : null}
          {sceneState === "error" ? (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-[#0f172a]/90 p-8 text-center text-white">
              <div><div className="text-base font-semibold">3D terrain unavailable</div><div className="mt-2 max-w-lg text-sm text-white/75">{sceneError ?? "ArcGIS terrain could not be loaded."}</div></div>
            </div>
          ) : null}
        </div>

        <aside className="flex min-h-0 flex-col gap-3">
          <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">
            <div className="flex items-center justify-between gap-3">
              <div><div className="text-sm font-semibold">Cross-section controls</div><div className="mt-0.5 text-xs text-muted">No Incident or Submission is required.</div></div>
              <div className="inline-flex overflow-hidden rounded-md border border-[var(--line)] text-xs">
                <button type="button" onClick={() => setMetric(false)} className={`px-2.5 py-1.5 ${!metric ? "bg-[var(--brand)] text-white" : "bg-[var(--panel-soft)]"}`}>US</button>
                <button type="button" onClick={() => setMetric(true)} className={`px-2.5 py-1.5 ${metric ? "bg-[var(--brand)] text-white" : "bg-[var(--panel-soft)]"}`}>Metric</button>
              </div>
            </div>

            <label className="mt-4 grid gap-1.5 text-xs font-semibold text-muted">
              Preferred DEM sample spacing
              <select value={preferredSpacingM} onChange={(event) => setPreferredSpacingM(Number(event.target.value))} disabled={profileBusy} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-normal text-[var(--ink)]">
                <option value={5}>5 m — high detail</option>
                <option value={10}>10 m — default</option>
                <option value={25}>25 m — long transects</option>
                <option value={50}>50 m — regional</option>
              </select>
            </label>
            <div className="mt-2 text-[11px] leading-5 text-muted">Very long paths are not rejected. ERIS increases the actual spacing only when necessary to keep the profile within approximately {MAX_RENDER_SAMPLES.toLocaleString()} render samples.</div>

            <button type="button" onClick={buildProfile} disabled={controlPoints.length < 2 || profileBusy || sceneState !== "ready"} className="mt-4 w-full rounded-md bg-[var(--brand)] px-4 py-2.5 text-sm font-semibold text-white hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50">
              {profileBusy ? "Sampling DEM…" : drawing ? "Finish & build profile" : profile ? "Rebuild profile" : "Build cross section"}
            </button>
            {profileError ? <div role="alert" className="mt-3 rounded-md border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-3 py-2 text-xs text-[var(--bad)]">{profileError}</div> : null}
          </div>

          <div className="grid grid-cols-2 gap-3 2xl:grid-cols-3">
            <MetricCard label="Path distance" value={formatHorizontalDistance(profile?.stats.total_distance_m ?? draftDistanceM, metric)} />
            <MetricCard label="DEM samples" value={profile ? profile.stats.sample_count.toLocaleString() : "—"} />
            <MetricCard label="Actual spacing" value={actualSpacingM == null ? "—" : `${actualSpacingM.toLocaleString()} m`} />
            <MetricCard label="Min elevation" value={profile ? formatElevation(profile.stats.min_elevation_m, metric) : "—"} />
            <MetricCard label="Max elevation" value={profile ? formatElevation(profile.stats.max_elevation_m, metric) : "—"} />
            <MetricCard label="Elevation range" value={profile ? formatElevation(profile.stats.elevation_range_m, metric) : "—"} />
          </div>

          {profile ? (
            <>
              <CrossSectionProfileChart profile={profile} controlDistances={controlDistances} metric={metric} onHoverSample={showHoverSample} />
              <div className="grid grid-cols-2 gap-3">
                <MetricCard label="Cumulative gain" value={formatElevation(profile.stats.elevation_gain_m, metric)} />
                <MetricCard label="Cumulative loss" value={formatElevation(profile.stats.elevation_loss_m, metric)} />
                <MetricCard label="Start elevation" value={formatElevation(profile.samples[0].elevation_m, metric)} />
                <MetricCard label="End elevation" value={formatElevation(profile.samples[profile.samples.length - 1].elevation_m, metric)} />
              </div>
            </>
          ) : null}

          <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-semibold">Selected control points</div>
              <div className="text-xs font-semibold tabular-nums text-muted">{controlPoints.length} point{controlPoints.length === 1 ? "" : "s"}</div>
            </div>
            {controlPoints.length === 0 ? (
              <div className="mt-3 rounded-lg border border-dashed border-[var(--line)] bg-[var(--panel-soft)] p-4 text-sm text-muted">Start a cross section, then click the DEM to add P1, P2, P3, and additional vertices.</div>
            ) : (
              <div className="mt-3 space-y-2">
                {profileControlRows.map(({ point, distance, elevation }, index) => (
                  <div key={pointKey(point)} className="rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3">
                    <div className="flex items-center justify-between"><div className="text-sm font-semibold">P{index + 1}</div><div className="text-xs font-medium text-[var(--brand)]">{formatHorizontalDistance(distance, metric)}</div></div>
                    <div className="mt-1 text-xs tabular-nums text-muted">{point.latitude.toFixed(6)}, {point.longitude.toFixed(6)}</div>
                    <div className="mt-1 text-xs text-muted">Elevation: <span className="font-medium text-[var(--ink)]">{elevation == null ? "Sample profile to resolve" : formatElevation(elevation, metric)}</span></div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>

    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}
