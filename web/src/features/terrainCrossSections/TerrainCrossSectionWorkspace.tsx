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
type WorkspacePanel = "details" | "points" | "settings";

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
  const [activePanel, setActivePanel] = useState<WorkspacePanel | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);

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
        setProfileOpen(false);
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
          size: 9,
          outline: { color: [255, 255, 255, 1], width: 1.5 },
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
          yoffset: 16,
          font: { size: 10, weight: "bold" },
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
    setActivePanel(null);
    setProfileOpen(false);
    setDrawing(true);
  }

  function continueDrawing() {
    clearHover();
    setProfile(null);
    setActualSpacingM(null);
    setProfileError(null);
    setActivePanel(null);
    setProfileOpen(false);
    setDrawing(true);
  }

  function undoLastPoint() {
    clearHover();
    setControlPoints((current) => current.slice(0, -1));
    setProfile(null);
    setActualSpacingM(null);
    setProfileError(null);
    setProfileOpen(false);
  }

  function clearAll() {
    clearHover();
    setDrawing(false);
    setControlPoints([]);
    setProfile(null);
    setActualSpacingM(null);
    setProfileError(null);
    setActivePanel(null);
    setProfileOpen(false);
  }

  function togglePanel(panel: WorkspacePanel) {
    setProfileOpen(false);
    setActivePanel((current) => current === panel ? null : panel);
  }

  function toggleProfile() {
    if (!profile) return;
    setActivePanel(null);
    setProfileOpen((open) => !open);
  }

  async function buildProfile(spacingOverride?: number) {
    const map = mapRef.current;
    const view = viewRef.current;
    if (!map || !view || controlPoints.length < 2 || profileBusy) return;

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
        preferredSpacingM: spacingOverride ?? preferredSpacingM,
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
      setActivePanel(null);
      setProfileOpen(true);

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
      setProfileOpen(false);
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

  const displayedDistanceM = profile?.stats.total_distance_m ?? draftDistanceM;

  return (
    <div className="relative h-full min-h-[620px] overflow-hidden bg-[#0f172a]">
      <div ref={containerRef} className="absolute inset-0" />

      <div className="pointer-events-none absolute left-14 top-3 z-30 max-w-[calc(100%-360px)]">
        <div className="pointer-events-auto flex flex-wrap items-center gap-1 rounded-xl border border-white/20 bg-slate-950/80 p-1.5 text-white shadow-lg backdrop-blur-md">
          <button
            type="button"
            onClick={beginDrawing}
            disabled={sceneState !== "ready" || profileBusy}
            className="rounded-lg bg-[var(--brand)] px-3 py-2 text-xs font-semibold text-white hover:brightness-95 disabled:opacity-50"
          >
            + New
          </button>

          {controlPoints.length > 0 && !drawing ? (
            <button
              type="button"
              onClick={continueDrawing}
              disabled={profileBusy}
              className="rounded-lg px-3 py-2 text-xs font-semibold text-white/90 hover:bg-white/10 disabled:opacity-50"
            >
              Add points
            </button>
          ) : null}

          <button
            type="button"
            onClick={undoLastPoint}
            disabled={controlPoints.length === 0 || profileBusy}
            className="rounded-lg px-3 py-2 text-xs font-semibold text-white/90 hover:bg-white/10 disabled:opacity-35"
          >
            Undo
          </button>

          <button
            type="button"
            onClick={() => void buildProfile()}
            disabled={controlPoints.length < 2 || profileBusy || sceneState !== "ready"}
            className="rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-xs font-semibold text-white hover:bg-white/20 disabled:opacity-35"
          >
            {profileBusy ? "Sampling…" : drawing ? "Finish & profile" : profile ? "Rebuild" : "Build profile"}
          </button>

          <button
            type="button"
            onClick={clearAll}
            disabled={controlPoints.length === 0 || profileBusy}
            className="rounded-lg px-2.5 py-2 text-xs font-semibold text-red-200 hover:bg-red-500/15 disabled:opacity-35"
            title="Clear cross section"
          >
            Clear
          </button>

          <div className="mx-1 h-5 w-px bg-white/20" />

          <div className="inline-flex overflow-hidden rounded-lg border border-white/20 text-xs font-semibold">
            <button
              type="button"
              onClick={() => setMetric(false)}
              className={`px-2.5 py-2 ${!metric ? "bg-white text-slate-900" : "text-white/80 hover:bg-white/10"}`}
            >
              US
            </button>
            <button
              type="button"
              onClick={() => setMetric(true)}
              className={`px-2.5 py-2 ${metric ? "bg-white text-slate-900" : "text-white/80 hover:bg-white/10"}`}
            >
              Metric
            </button>
          </div>
        </div>
      </div>

      {drawing ? (
        <div className="pointer-events-none absolute left-14 top-16 z-20 rounded-lg border border-white/15 bg-black/65 px-3 py-2 text-xs font-medium text-white shadow backdrop-blur-sm">
          Click terrain to place P{controlPoints.length + 1}
          {controlPoints.length >= 2 ? <span className="ml-2 text-white/65">Finish when the path is complete.</span> : null}
        </div>
      ) : null}

      <div className="absolute right-3 top-1/2 z-30 flex -translate-y-1/2 flex-col gap-1 rounded-xl border border-white/20 bg-slate-950/75 p-1.5 text-white shadow-lg backdrop-blur-md">
        <MapPanelButton label="Stats" active={activePanel === "details"} onClick={() => togglePanel("details")} />
        <MapPanelButton label={`Points ${controlPoints.length}`} active={activePanel === "points"} onClick={() => togglePanel("points")} />
        <MapPanelButton label="Setup" active={activePanel === "settings"} onClick={() => togglePanel("settings")} />
      </div>

      <aside
        className={`absolute bottom-20 right-16 top-20 z-30 w-[min(360px,calc(100%-5rem))] overflow-y-auto rounded-xl border border-[var(--line)] bg-[color:var(--panel)]/96 text-[var(--ink)] shadow-2xl backdrop-blur-md transition-all duration-200 ${activePanel ? "translate-x-0 opacity-100" : "pointer-events-none translate-x-5 opacity-0"}`}
        aria-hidden={!activePanel}
      >
        {activePanel ? (
          <>
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-[var(--line)] bg-[color:var(--panel)]/95 px-4 py-3 backdrop-blur-md">
              <div>
                <div className="text-sm font-semibold">
                  {activePanel === "details" ? "Cross-section statistics" : activePanel === "points" ? "Control points" : "Cross-section setup"}
                </div>
                <div className="mt-0.5 text-[11px] text-muted">
                  {activePanel === "details"
                    ? "DEM profile measurements"
                    : activePanel === "points"
                      ? `${controlPoints.length} selected point${controlPoints.length === 1 ? "" : "s"}`
                      : "Sampling and map display"}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setActivePanel(null)}
                className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--line)] bg-[var(--panel-soft)] text-sm font-semibold hover:bg-[var(--panel)]"
                aria-label="Close panel"
              >
                ×
              </button>
            </div>

            {activePanel === "details" ? (
              <div className="grid grid-cols-2 gap-px bg-[var(--line)]">
                <DrawerMetric label="Path" value={formatHorizontalDistance(displayedDistanceM, metric)} />
                <DrawerMetric label="Samples" value={profile ? profile.stats.sample_count.toLocaleString() : "—"} />
                <DrawerMetric label="Spacing" value={actualSpacingM == null ? "—" : `${actualSpacingM.toLocaleString()} m`} />
                <DrawerMetric label="Elevation range" value={profile ? formatElevation(profile.stats.elevation_range_m, metric) : "—"} />
                <DrawerMetric label="Minimum" value={profile ? formatElevation(profile.stats.min_elevation_m, metric) : "—"} />
                <DrawerMetric label="Maximum" value={profile ? formatElevation(profile.stats.max_elevation_m, metric) : "—"} />
                <DrawerMetric label="Gain" value={profile ? formatElevation(profile.stats.elevation_gain_m, metric) : "—"} />
                <DrawerMetric label="Loss" value={profile ? formatElevation(profile.stats.elevation_loss_m, metric) : "—"} />
                <DrawerMetric label="Start" value={profile ? formatElevation(profile.samples[0].elevation_m, metric) : "—"} />
                <DrawerMetric label="End" value={profile ? formatElevation(profile.samples[profile.samples.length - 1].elevation_m, metric) : "—"} />
              </div>
            ) : null}

            {activePanel === "points" ? (
              <div>
                {controlPoints.length === 0 ? (
                  <div className="p-5 text-sm text-muted">Start a cross section and click the terrain to place control points.</div>
                ) : (
                  profileControlRows.map(({ point, distance, elevation }, index) => (
                    <div key={pointKey(point)} className="border-b border-[var(--line)] px-4 py-3 last:border-b-0">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-semibold">P{index + 1}</div>
                        <div className="text-xs font-semibold tabular-nums text-[var(--brand)]">{formatHorizontalDistance(distance, metric)}</div>
                      </div>
                      <div className="mt-1 text-xs tabular-nums text-muted">{point.latitude.toFixed(6)}, {point.longitude.toFixed(6)}</div>
                      <div className="mt-1 text-xs text-muted">
                        Elevation <span className="font-medium text-[var(--ink)]">{elevation == null ? "Sample profile to resolve" : formatElevation(elevation, metric)}</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            ) : null}

            {activePanel === "settings" ? (
              <div className="space-y-5 p-4">
                <div>
                  <div className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted">DEM sample spacing</div>
                  <select
                    value={preferredSpacingM}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      setPreferredSpacingM(next);
                      if (profile && !drawing) void buildProfile(next);
                    }}
                    disabled={profileBusy}
                    className="w-full rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm"
                  >
                    <option value={5}>5 m — high detail</option>
                    <option value={10}>10 m — default</option>
                    <option value={25}>25 m — long transects</option>
                    <option value={50}>50 m — regional</option>
                  </select>
                  <div className="mt-2 text-xs leading-5 text-muted">
                    Long paths remain allowed. ERIS increases actual spacing only when needed to stay within approximately {MAX_RENDER_SAMPLES.toLocaleString()} render samples.
                  </div>
                </div>

                <div>
                  <div className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted">Basemap</div>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setBasemapMode("satellite")}
                      className={`rounded-md border px-3 py-2 text-sm font-medium ${basemapMode === "satellite" ? "border-[var(--brand)] bg-[color:color-mix(in_oklab,var(--brand)_10%,transparent)] text-[var(--brand)]" : "border-[var(--line)] bg-[var(--panel-soft)]"}`}
                    >
                      Imagery
                    </button>
                    <button
                      type="button"
                      onClick={() => setBasemapMode("topo-vector")}
                      className={`rounded-md border px-3 py-2 text-sm font-medium ${basemapMode === "topo-vector" ? "border-[var(--brand)] bg-[color:color-mix(in_oklab,var(--brand)_10%,transparent)] text-[var(--brand)]" : "border-[var(--line)] bg-[var(--panel-soft)]"}`}
                    >
                      Topographic
                    </button>
                  </div>
                </div>

                <div className="rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3 text-xs leading-5 text-muted">
                  This tool samples the ArcGIS ground elevation surface directly. No Incident or Submission is required.
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </aside>

      <div className="absolute bottom-3 left-3 z-20 flex overflow-hidden rounded-lg border border-white/20 bg-black/55 text-[11px] text-white backdrop-blur-sm">
        {(["satellite", "topo-vector"] as BasemapMode[]).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => setBasemapMode(mode)}
            className={`px-3 py-2 ${basemapMode === mode ? "bg-white/20 font-semibold" : "hover:bg-white/10"}`}
          >
            {mode === "satellite" ? "Imagery" : "Topographic"}
          </button>
        ))}
      </div>

      {!profileOpen ? <SceneDualScaleBar scale={sceneScale} /> : null}

      {profile ? (
        <button
          type="button"
          onClick={toggleProfile}
          className={`absolute bottom-3 left-1/2 z-30 -translate-x-1/2 rounded-xl border border-white/20 bg-slate-950/80 px-4 py-2.5 text-left text-white shadow-lg backdrop-blur-md transition-opacity ${profileOpen ? "pointer-events-none opacity-0" : "opacity-100"}`}
        >
          <div className="flex items-center gap-4 text-xs">
            <span className="font-semibold text-white">Profile ↑</span>
            <span><strong>{formatHorizontalDistance(profile.stats.total_distance_m, metric)}</strong> path</span>
            <span><strong>{profile.stats.sample_count.toLocaleString()}</strong> samples</span>
            <span><strong>{actualSpacingM == null ? "—" : `${actualSpacingM.toLocaleString()} m`}</strong> spacing</span>
            <span className="hidden xl:inline"><strong>{formatElevation(profile.stats.elevation_range_m, metric)}</strong> range</span>
          </div>
        </button>
      ) : controlPoints.length >= 2 && !drawing ? (
        <div className="pointer-events-none absolute bottom-3 left-1/2 z-20 -translate-x-1/2 rounded-lg border border-white/20 bg-black/60 px-3 py-2 text-xs text-white backdrop-blur-sm">
          {formatHorizontalDistance(draftDistanceM, metric)} path selected · Build profile to sample the DEM
        </div>
      ) : null}

      {profile && profileOpen ? (
        <section className="absolute inset-x-0 bottom-0 z-40 h-[44%] min-h-[330px] max-h-[470px] overflow-y-auto border-t border-[var(--line)] bg-[color:var(--panel)]/98 text-[var(--ink)] shadow-2xl backdrop-blur-md">
          <div className="sticky top-0 z-10 flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-[var(--line)] bg-[color:var(--panel)]/96 px-4 py-2.5 backdrop-blur-md">
            <button
              type="button"
              onClick={toggleProfile}
              className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--panel)]"
            >
              ↓ Profile
            </button>
            <CompactStat label="Path" value={formatHorizontalDistance(profile.stats.total_distance_m, metric)} />
            <CompactStat label="Samples" value={profile.stats.sample_count.toLocaleString()} />
            <CompactStat label="Spacing" value={actualSpacingM == null ? "—" : `${actualSpacingM.toLocaleString()} m`} />
            <CompactStat label="Min" value={formatElevation(profile.stats.min_elevation_m, metric)} />
            <CompactStat label="Max" value={formatElevation(profile.stats.max_elevation_m, metric)} />
            <CompactStat label="Gain / loss" value={`${formatElevation(profile.stats.elevation_gain_m, metric)} / ${formatElevation(profile.stats.elevation_loss_m, metric)}`} />
          </div>
          <div className="p-3">
            <CrossSectionProfileChart
              profile={profile}
              controlDistances={controlDistances}
              metric={metric}
              onHoverSample={showHoverSample}
            />
          </div>
        </section>
      ) : null}

      {profileError ? (
        <div role="alert" className="absolute left-1/2 top-20 z-40 max-w-xl -translate-x-1/2 rounded-lg border border-red-300/50 bg-red-950/85 px-4 py-3 text-sm text-red-50 shadow-xl backdrop-blur-md">
          {profileError}
        </div>
      ) : null}

      {sceneState === "loading" ? (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-[#0f172a]/80 text-sm text-white">Loading ArcGIS 3D terrain…</div>
      ) : null}

      {sceneState === "error" ? (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-[#0f172a]/90 p-8 text-center text-white">
          <div>
            <div className="text-base font-semibold">3D terrain unavailable</div>
            <div className="mt-2 max-w-lg text-sm text-white/75">{sceneError ?? "ArcGIS terrain could not be loaded."}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MapPanelButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`min-w-16 rounded-lg px-2.5 py-2 text-xs font-semibold transition-colors ${active ? "bg-white text-slate-900" : "text-white/85 hover:bg-white/10 hover:text-white"}`}
    >
      {label}
    </button>
  );
}

function DrawerMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[var(--panel)] p-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">{label}</div>
      <div className="mt-1 text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function CompactStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5 text-xs">
      <span className="text-muted">{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </div>
  );
}
