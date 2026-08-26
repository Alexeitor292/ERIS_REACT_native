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

import type { SavedCrossSectionDetail } from "../../api/terrainCrossSections";
import AerialCaptureDialog from "./AerialCaptureDialog";
import CrossSectionProfileChart from "./CrossSectionProfileChart";
import CrossSectionSaveDialog from "./CrossSectionSaveDialog";
import {
  createDemResolutionCoverageLayer,
  refreshDemResolutionCoverageLayer,
  summarizeDemCoverageAlongProfile,
} from "./DemResolutionCoverageLayer";
import { DEM_COVERAGE_LEGEND } from "./demResolutionCoverageModel";
import SceneDualScaleBar from "./SceneDualScaleBar";
import TerrainSlice3D from "./TerrainSlice3D";
import {
  adaptiveSampleSpacingMeters,
  controlPointDistances,
  demResolutionModeLabel,
  demResolutionQueryValue,
  formatDemResolution,
  formatElevation,
  formatHorizontalDistance,
  formatTerrainSamplingResolution,
  pathLengthMeters,
  profileFromPath,
  summarizeDemResolution,
  withDemSourceCoverage,
  type CrossSectionControlPoint,
  type CrossSectionDemMetadata,
  type CrossSectionProfile,
  type DemResolutionMode,
} from "./terrainCrossSectionModel";

type SceneState = "loading" | "ready" | "error";
type BasemapMode = "satellite" | "topo-vector";
type WorkspacePanel = "profile" | "details" | "points" | "settings";
type ProfileView = "profile" | "slice";

const WGS84 = SpatialReference.WGS84;
const CALIFORNIA_CENTER: [number, number] = [-119.4179, 36.7783];
const MAX_RENDER_SAMPLES = 1800;
// The sampled profile and its hover marker must share the exact same world-space Z.
// In a close, tilted SceneView, even a one-metre mismatch can project many pixels apart.
const PROFILE_RENDER_OFFSET_M = 1;

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

function demQualityNote(metadata: CrossSectionDemMetadata | null | undefined) {
  if (!metadata) return "No DEM provenance metadata is available for this profile.";

  const sourceCoverage = metadata.source_coverage;
  const sourceResolution = formatDemResolution(metadata);
  const terrainSampling = formatTerrainSamplingResolution(metadata);

  if (!sourceCoverage || sourceCoverage.min_pixel_size_m == null || sourceCoverage.max_pixel_size_m == null) {
    return `Esri source-footprint coverage could not be resolved for this profile. Terrain3D sampling resolution was ${terrainSampling}; that value is not native source DEM cell size.`;
  }

  const coverage = sourceCoverage.covered_sample_count === sourceCoverage.total_sample_count
    ? "all sampled profile coordinates"
    : `${sourceCoverage.covered_sample_count.toLocaleString()} of ${sourceCoverage.total_sample_count.toLocaleString()} sampled profile coordinates`;

  return sourceCoverage.mixed_resolution
    ? `Esri's Data Extents catalog resolves multiple native source pixel sizes (${sourceResolution}) across ${coverage}. Terrain3D sampled the elevation surface at ${terrainSampling}; sampling resolution is reported separately and is not source accuracy or native cell size.`
    : `Esri's Data Extents catalog resolves ${sourceResolution} native source coverage across ${coverage}. Terrain3D sampled the elevation surface at ${terrainSampling}; sampling resolution is reported separately and is not source accuracy or native cell size.`;
}

export default function TerrainCrossSectionWorkspace() {
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<SceneView | null>(null);
  const mapRef = useRef<Map | null>(null);
  const demCoverageLayerRef = useRef<ReturnType<typeof createDemResolutionCoverageLayer> | null>(null);
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
  const [preferredSpacingM, setPreferredSpacingM] = useState(1);
  const [actualSpacingM, setActualSpacingM] = useState<number | null>(null);
  const [demResolutionMode, setDemResolutionMode] = useState<DemResolutionMode>("best-available");
  const [demCoverageVisible, setDemCoverageVisible] = useState(false);
  const [basemapMode, setBasemapMode] = useState<BasemapMode>("satellite");
  const [sceneScale, setSceneScale] = useState<number | null>(null);
  const [activePanel, setActivePanel] = useState<WorkspacePanel | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  const [profileView, setProfileView] = useState<ProfileView>("profile");
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [captureDialogOpen, setCaptureDialogOpen] = useState(false);
  const [savedCrossSection, setSavedCrossSection] = useState<SavedCrossSectionDetail | null>(null);

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
        z: sample.elevation_m + PROFILE_RENDER_OFFSET_M,
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
    const syncFullscreenState = () => {
      const workspace = workspaceRef.current;
      if (!workspace) return;
      if (document.fullscreenElement === workspace) {
        setFocusMode(true);
      } else if (document.fullscreenElement == null) {
        setFocusMode(false);
      }
    };

    document.addEventListener("fullscreenchange", syncFullscreenState);
    return () => document.removeEventListener("fullscreenchange", syncFullscreenState);
  }, []);

  useEffect(() => {
    if (!focusMode) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && document.fullscreenElement !== workspaceRef.current) {
        setFocusMode(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [focusMode]);

  async function toggleFullScreen() {
    const workspace = workspaceRef.current;
    if (!workspace) return;

    if (focusMode && document.fullscreenElement !== workspace) {
      setFocusMode(false);
      return;
    }

    if (document.fullscreenElement === workspace) {
      await document.exitFullscreen();
      return;
    }

    if (document.fullscreenElement) {
      await document.exitFullscreen();
    }

    if (document.fullscreenEnabled && typeof workspace.requestFullscreen === "function") {
      try {
        await workspace.requestFullscreen();
        return;
      } catch {
        // Fall back to the existing viewport takeover if browser fullscreen is blocked.
      }
    }

    setFocusMode(true);
  }

  useEffect(() => {
    if (!containerRef.current) return;

    esriConfig.assetsPath = "/assets";
    const apiKey = import.meta.env.VITE_ARCGIS_API_KEY;
    if (apiKey) esriConfig.apiKey = String(apiKey);

    setSceneState("loading");
    setSceneError(null);

    const demCoverageLayer = createDemResolutionCoverageLayer();
    const controlLayer = new GraphicsLayer({ title: "Cross-section control points" });
    const profileLayer = new GraphicsLayer({ title: "DEM cross-section profile" });
    const hoverLayer = new GraphicsLayer({ title: "Cross-section cursor" });
    (controlLayer as unknown as { elevationInfo: unknown }).elevationInfo = { mode: "on-the-ground" };
    (profileLayer as unknown as { elevationInfo: unknown }).elevationInfo = { mode: "absolute-height" };
    (hoverLayer as unknown as { elevationInfo: unknown }).elevationInfo = { mode: "absolute-height" };

    demCoverageLayerRef.current = demCoverageLayer;
    controlLayerRef.current = controlLayer;
    profileLayerRef.current = profileLayer;
    hoverLayerRef.current = hoverLayer;

    const map = new Map({
      basemap: "satellite",
      ground: "world-elevation",
      layers: [demCoverageLayer, controlLayer, profileLayer, hoverLayer],
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
        setActivePanel(null);
        setProfileView("profile");
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
      demCoverageLayerRef.current = null;
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
        paths: [profile.samples.map((sample) => [sample.longitude, sample.latitude, sample.elevation_m + PROFILE_RENDER_OFFSET_M])],
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
    setProfileView("profile");
    setSavedCrossSection(null);
    setDrawing(true);
  }

  function continueDrawing() {
    clearHover();
    setProfile(null);
    setActualSpacingM(null);
    setProfileError(null);
    setActivePanel(null);
    setProfileView("profile");
    setDrawing(true);
  }

  function undoLastPoint() {
    clearHover();
    setControlPoints((current) => current.slice(0, -1));
    setProfile(null);
    setActualSpacingM(null);
    setProfileError(null);
    setActivePanel(null);
    setProfileView("profile");
  }

  function clearAll() {
    clearHover();
    setDrawing(false);
    setControlPoints([]);
    setProfile(null);
    setActualSpacingM(null);
    setProfileError(null);
    setActivePanel(null);
    setProfileView("profile");
    setSavedCrossSection(null);
  }

  function togglePanel(panel: WorkspacePanel) {
    setActivePanel((current) => current === panel ? null : panel);
  }

  function toggleDemCoverage() {
    setDemCoverageVisible((current) => {
      const next = !current;
      const layer = demCoverageLayerRef.current;
      if (layer) {
        layer.visible = next;
        if (next) refreshDemResolutionCoverageLayer(layer);
      }
      return next;
    });
  }

  async function buildProfile(spacingOverride?: number, demResolutionOverride?: DemResolutionMode) {
    const map = mapRef.current;
    const view = viewRef.current;
    if (!map || !view || controlPoints.length < 2 || profileBusy) return;

    const requestedDemMode = demResolutionOverride ?? demResolutionMode;
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
        demResolution: demResolutionQueryValue(requestedDemMode),
        returnSampleInfo: true,
      });
      const sampled = elevation.geometry as Polyline;
      const path = sampled.paths?.[0] ?? [];
      const terrainSampling = summarizeDemResolution(elevation.sampleInfo, requestedDemMode);
      let nextProfile = profileFromPath(path, elevation.noDataValue, terrainSampling);
      if (!nextProfile) throw new Error("No usable DEM elevation samples were returned for this path.");

      const coverageLayer = demCoverageLayerRef.current;
      if (coverageLayer) {
        try {
          const sourceCoverage = await summarizeDemCoverageAlongProfile(coverageLayer, nextProfile.samples);
          nextProfile = {
            ...nextProfile,
            dem: withDemSourceCoverage(terrainSampling, sourceCoverage),
          };
        } catch (coverageError) {
          console.warn("Unable to resolve Esri DEM source-footprint coverage for profile", coverageError);
        }
      }

      setProfile(nextProfile);
      setProfileView("profile");
      setActivePanel("profile");

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
      setActivePanel(null);
      setProfileView("profile");
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
  const savePoints = profileControlRows.map(({ point, distance, elevation }) => ({
    latitude: point.latitude,
    longitude: point.longitude,
    distance_m: distance,
    elevation_m: elevation,
  }));

  const displayedDistanceM = profile?.stats.total_distance_m ?? draftDistanceM;
  const panelWide = activePanel === "profile";
  const panelTitle = activePanel === "profile"
    ? "Elevation analysis"
    : activePanel === "details"
      ? "Cross-section statistics"
      : activePanel === "points"
        ? "Control points"
        : "Cross-section setup";
  const panelSubtitle = activePanel === "profile"
    ? profile
      ? profileView === "slice"
        ? `3D DEM slice along ${formatHorizontalDistance(profile.stats.total_distance_m, false)} of selected terrain`
        : `${formatHorizontalDistance(profile.stats.total_distance_m, false)} · ${profile.stats.sample_count.toLocaleString()} samples · ${formatDemResolution(profile.dem)} source coverage`
      : "Build a profile to inspect terrain elevation"
    : activePanel === "details"
      ? "DEM profile measurements, source coverage, and Terrain3D sampling"
      : activePanel === "points"
        ? `${controlPoints.length} selected point${controlPoints.length === 1 ? "" : "s"}`
        : "Sampling, DEM source coverage, and map display";

  return (
    <div
      ref={workspaceRef}
      className={`relative overflow-hidden bg-[#0f172a] ${focusMode
        ? "fixed inset-0 z-[100] h-[100dvh] min-h-0 w-screen"
        : "h-full min-h-[620px]"}`}
    >
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
            onClick={() => setSaveDialogOpen(true)}
            disabled={controlPoints.length < 2 || profileBusy}
            className="rounded-lg border border-emerald-300/40 bg-emerald-500/15 px-3 py-2 text-xs font-semibold text-emerald-50 hover:bg-emerald-500/25 disabled:opacity-35"
          >
            {savedCrossSection ? "Save changes" : "Save"}
          </button>

          <button
            type="button"
            onClick={() => setCaptureDialogOpen(true)}
            disabled={controlPoints.length < 2 || profileBusy}
            className="rounded-lg border border-sky-300/40 bg-sky-500/15 px-3 py-2 text-xs font-semibold text-sky-50 hover:bg-sky-500/25 disabled:opacity-35"
          >
            Capture
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

          <button
            type="button"
            onClick={toggleDemCoverage}
            aria-pressed={demCoverageVisible}
            disabled={sceneState !== "ready"}
            className={`rounded-lg px-3 py-2 text-xs font-semibold disabled:opacity-50 ${demCoverageVisible ? "bg-white text-slate-900" : "text-white/90 hover:bg-white/10"}`}
            title="Show the finest cataloged Esri source-resolution footprint at each location"
          >
            DEM coverage
          </button>

          <button
            type="button"
            onClick={() => void toggleFullScreen()}
            aria-pressed={focusMode}
            className="rounded-lg px-3 py-2 text-xs font-semibold text-white/90 hover:bg-white/10"
            title={focusMode ? "Exit the full-screen terrain workspace" : "Expand the terrain workspace and keep all tools available"}
          >
            {focusMode ? "Exit full screen" : "Full screen"}
          </button>
        </div>
        {savedCrossSection?.project ? (
          <div className="pointer-events-auto mt-1 inline-flex rounded-lg border border-emerald-300/30 bg-slate-950/75 px-3 py-1.5 text-[11px] text-emerald-100 backdrop-blur-md">
            Saved to {savedCrossSection.project.project_number ? `${savedCrossSection.project.project_number} · ` : ""}{savedCrossSection.project.title}
          </div>
        ) : null}
      </div>

      {drawing ? (
        <div className="pointer-events-none absolute left-14 top-16 z-20 rounded-lg border border-white/15 bg-black/65 px-3 py-2 text-xs font-medium text-white shadow backdrop-blur-sm">
          Click terrain to place P{controlPoints.length + 1}
          {controlPoints.length >= 2 ? <span className="ml-2 text-white/65">Finish when the path is complete.</span> : null}
        </div>
      ) : null}

      <div className="absolute right-3 top-1/2 z-30 flex -translate-y-1/2 flex-col gap-1 rounded-xl border border-white/20 bg-slate-950/75 p-1.5 text-white shadow-lg backdrop-blur-md">
        {profile ? <MapPanelButton label="Profile" active={activePanel === "profile"} onClick={() => togglePanel("profile")} /> : null}
        <MapPanelButton label="Stats" active={activePanel === "details"} onClick={() => togglePanel("details")} />
        <MapPanelButton label={`Points ${controlPoints.length}`} active={activePanel === "points"} onClick={() => togglePanel("points")} />
        <MapPanelButton label="Setup" active={activePanel === "settings"} onClick={() => togglePanel("settings")} />
      </div>

      <aside
        className={`absolute bottom-3 right-20 top-16 z-30 overflow-y-auto rounded-xl border border-[var(--line)] bg-[color:var(--panel)]/97 text-[var(--ink)] shadow-2xl backdrop-blur-md transition-[width,transform,opacity] duration-200 ${panelWide
          ? "w-[min(720px,calc(100%-6rem))]"
          : "w-[min(360px,calc(100%-6rem))]"} ${activePanel
          ? "translate-x-0 opacity-100"
          : "pointer-events-none translate-x-5 opacity-0"}`}
        aria-hidden={!activePanel}
      >
        {activePanel ? (
          <>
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-[var(--line)] bg-[color:var(--panel)]/96 px-4 py-3 backdrop-blur-md">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{panelTitle}</div>
                <div className="mt-0.5 truncate text-[11px] text-muted">{panelSubtitle}</div>
              </div>
              <button
                type="button"
                onClick={() => setActivePanel(null)}
                className="ml-3 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--line)] bg-[var(--panel-soft)] text-sm font-semibold hover:bg-[var(--panel)]"
                aria-label="Close panel"
              >
                ×
              </button>
            </div>

            {activePanel === "profile" && profile ? (
              <div>
                <div className="flex border-b border-[var(--line)] bg-[var(--panel-soft)] p-1.5">
                  <button
                    type="button"
                    onClick={() => setProfileView("profile")}
                    className={`flex-1 rounded-md px-3 py-2 text-xs font-semibold ${profileView === "profile"
                      ? "bg-[var(--panel)] text-[var(--ink)] shadow-sm"
                      : "text-muted hover:text-[var(--ink)]"}`}
                  >
                    Elevation Profile
                  </button>
                  <button
                    type="button"
                    onClick={() => setProfileView("slice")}
                    className={`flex-1 rounded-md px-3 py-2 text-xs font-semibold ${profileView === "slice"
                      ? "bg-[var(--panel)] text-[var(--ink)] shadow-sm"
                      : "text-muted hover:text-[var(--ink)]"}`}
                  >
                    3D Terrain Slice
                  </button>
                </div>

                <div className="grid grid-cols-4 gap-px border-b border-[var(--line)] bg-[var(--line)]">
                  <DrawerMetric label="Path" value={formatHorizontalDistance(profile.stats.total_distance_m, false)} />
                  <DrawerMetric label="Samples" value={profile.stats.sample_count.toLocaleString()} />
                  <DrawerMetric label="Spacing" value={actualSpacingM == null ? "—" : `${actualSpacingM.toLocaleString()} m`} />
                  <DrawerMetric label="Source coverage" value={formatDemResolution(profile.dem)} />
                </div>

                <div className="border-b border-[var(--line)] bg-[var(--panel-soft)] px-4 py-3 text-xs leading-5 text-muted">
                  <div className="font-semibold text-[var(--ink)]">
                    ArcGIS World Elevation · {demResolutionModeLabel(profile.dem?.requested_mode ?? demResolutionMode)}
                  </div>
                  <div className="mt-1">{demQualityNote(profile.dem)}</div>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
                    <div>Source footprint: <span className="font-semibold text-[var(--ink)]">{formatDemResolution(profile.dem)}</span></div>
                    <div>Terrain3D sampling: <span className="font-semibold text-[var(--ink)]">{formatTerrainSamplingResolution(profile.dem)}</span></div>
                  </div>
                </div>

                {profileView === "profile" ? (
                  <>
                    <div className="p-3">
                      <CrossSectionProfileChart
                        profile={profile}
                        controlDistances={controlDistances}
                        onHoverSample={showHoverSample}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-px border-t border-[var(--line)] bg-[var(--line)]">
                      <DrawerMetric label="Minimum" value={formatElevation(profile.stats.min_elevation_m, false)} />
                      <DrawerMetric label="Maximum" value={formatElevation(profile.stats.max_elevation_m, false)} />
                      <DrawerMetric label="Gain" value={formatElevation(profile.stats.elevation_gain_m, false)} />
                      <DrawerMetric label="Loss" value={formatElevation(profile.stats.elevation_loss_m, false)} />
                    </div>
                  </>
                ) : (
                  <div className="p-3">
                    <TerrainSlice3D
                      profile={profile}
                      metric={false}
                      controlPoints={controlPoints}
                      basemapMode={basemapMode}
                      sceneScale={sceneScale}
                    />
                  </div>
                )}
              </div>
            ) : null}

            {activePanel === "details" ? (
              <div className="grid grid-cols-2 gap-px bg-[var(--line)]">
                <DrawerMetric label="Path" value={formatHorizontalDistance(displayedDistanceM, false)} />
                <DrawerMetric label="Samples" value={profile ? profile.stats.sample_count.toLocaleString() : "—"} />
                <DrawerMetric label="Spacing" value={actualSpacingM == null ? "—" : `${actualSpacingM.toLocaleString()} m`} />
                <DrawerMetric label="DEM request" value={profile ? demResolutionModeLabel(profile.dem?.requested_mode ?? demResolutionMode) : demResolutionModeLabel(demResolutionMode)} />
                <DrawerMetric label="Source coverage" value={profile ? formatDemResolution(profile.dem) : "—"} />
                <DrawerMetric label="Terrain3D sampling" value={profile ? formatTerrainSamplingResolution(profile.dem) : "—"} />
                <DrawerMetric label="Coverage samples" value={profile?.dem?.source_coverage ? `${profile.dem.source_coverage.covered_sample_count.toLocaleString()} / ${profile.dem.source_coverage.total_sample_count.toLocaleString()}` : "—"} />
                <DrawerMetric label="Terrain metadata" value={profile?.dem ? profile.dem.resolution_sample_count.toLocaleString() : "—"} />
                <DrawerMetric label="Elevation range" value={profile ? formatElevation(profile.stats.elevation_range_m, false) : "—"} />
                <DrawerMetric label="Minimum" value={profile ? formatElevation(profile.stats.min_elevation_m, false) : "—"} />
                <DrawerMetric label="Maximum" value={profile ? formatElevation(profile.stats.max_elevation_m, false) : "—"} />
                <DrawerMetric label="Gain" value={profile ? formatElevation(profile.stats.elevation_gain_m, false) : "—"} />
                <DrawerMetric label="Loss" value={profile ? formatElevation(profile.stats.elevation_loss_m, false) : "—"} />
                <DrawerMetric label="Start" value={profile ? formatElevation(profile.samples[0].elevation_m, false) : "—"} />
                <DrawerMetric label="End" value={profile ? formatElevation(profile.samples[profile.samples.length - 1].elevation_m, false) : "—"} />
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
                        <div className="text-xs font-semibold tabular-nums text-[var(--brand)]">{formatHorizontalDistance(distance, false)}</div>
                      </div>
                      <div className="mt-1 text-xs tabular-nums text-muted">{point.latitude.toFixed(6)}, {point.longitude.toFixed(6)}</div>
                      <div className="mt-1 text-xs text-muted">
                        Elevation <span className="font-medium text-[var(--ink)]">{elevation == null ? "Sample profile to resolve" : formatElevation(elevation, false)}</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            ) : null}

            {activePanel === "settings" ? (
              <div className="space-y-5 p-4">
                <div>
                  <div className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted">Profile sample spacing</div>
                  <select
                    value={preferredSpacingM}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      setPreferredSpacingM(next);
                      if (profile && !drawing) void buildProfile(next, demResolutionMode);
                    }}
                    disabled={profileBusy}
                    className="w-full rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm"
                  >
                    <option value={1}>1 m — maximum detail</option>
                    <option value={2}>2 m — very high detail</option>
                    <option value={5}>5 m — high detail</option>
                    <option value={10}>10 m — standard</option>
                    <option value={25}>25 m — long transects</option>
                    <option value={50}>50 m — regional</option>
                  </select>
                  <div className="mt-2 text-xs leading-5 text-muted">
                    This controls profile vertex spacing, not source DEM resolution. Long paths remain allowed; ERIS increases actual spacing only when needed to stay within approximately {MAX_RENDER_SAMPLES.toLocaleString()} render samples.
                  </div>
                </div>

                <div>
                  <div className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted">Terrain3D elevation query</div>
                  <select
                    value={demResolutionMode}
                    onChange={(event) => {
                      const next = event.target.value as DemResolutionMode;
                      setDemResolutionMode(next);
                      if (profile && !drawing) void buildProfile(undefined, next);
                    }}
                    disabled={profileBusy}
                    className="w-full rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm"
                  >
                    <option value="best-available">Best available — finest contiguous sampling</option>
                    <option value="auto">Automatic — may mix sampling resolutions</option>
                    <option value="target-1m">Target 1 m sampling</option>
                    <option value="target-3m">Target 3 m sampling</option>
                    <option value="target-10m">Target 10 m sampling</option>
                  </select>
                  <div className="mt-2 text-xs leading-5 text-muted">
                    This controls the ArcGIS Terrain3D elevation query. The returned Terrain3D sampling resolution can reflect a cached terrain level of detail and is not used as proof of native DEM cell size. ERIS resolves source coverage separately from the same live Data Extents PixelSize footprints used by the map overlay.
                  </div>
                  {profile ? (
                    <div className="mt-3 space-y-2 rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3 text-xs leading-5">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-muted">Source footprint resolution</span>
                        <span className="font-semibold tabular-nums text-[var(--ink)]">{formatDemResolution(profile.dem)}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-muted">Terrain3D sampling resolution</span>
                        <span className="font-semibold tabular-nums text-[var(--ink)]">{formatTerrainSamplingResolution(profile.dem)}</span>
                      </div>
                      <div className="pt-1 text-muted">{demQualityNote(profile.dem)}</div>
                    </div>
                  ) : null}
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
                  Terrain distances and elevations are displayed in feet. Profile interval, source pixel size, and Terrain3D sampling resolution remain in meters because those values describe sampling and raster grids.
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

      {demCoverageVisible ? (
        <div className="pointer-events-none absolute bottom-14 left-3 z-20 w-64 rounded-lg border border-white/20 bg-slate-950/85 p-3 text-white shadow-lg backdrop-blur-md">
          <div className="text-xs font-semibold">DEM source coverage</div>
          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5">
            {DEM_COVERAGE_LEGEND.map((item) => (
              <div key={item.id} className="flex items-center gap-2 text-[10px]">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-[2px] border border-white/30"
                  style={{ backgroundColor: item.cssColor }}
                />
                <span>{item.label}</span>
              </div>
            ))}
          </div>
          <div className="mt-2 border-t border-white/15 pt-2 text-[9px] leading-4 text-white/70">
            Color = finest cataloged Esri PixelSize footprint at that location. Profile source coverage uses the same footprints. Terrain3D sampling resolution is reported separately.
          </div>
        </div>
      ) : null}

      <SceneDualScaleBar scale={sceneScale} />

      {profile ? (
        <button
          type="button"
          onClick={() => togglePanel("profile")}
          className="absolute bottom-3 left-1/2 z-20 -translate-x-1/2 rounded-lg border border-white/20 bg-black/60 px-3 py-2 text-xs text-white shadow backdrop-blur-sm"
        >
          <span className="font-semibold">Elevation analysis</span>
          <span className="ml-2 text-white/75">Profile + 3D slice · {formatHorizontalDistance(profile.stats.total_distance_m, false)} · {formatDemResolution(profile.dem)} source coverage</span>
        </button>
      ) : controlPoints.length >= 2 && !drawing ? (
        <div className="pointer-events-none absolute bottom-3 left-1/2 z-20 -translate-x-1/2 rounded-lg border border-white/20 bg-black/60 px-3 py-2 text-xs text-white backdrop-blur-sm">
          {formatHorizontalDistance(draftDistanceM, false)} path selected · Build profile to sample the DEM
        </div>
      ) : null}

      {focusMode ? (
        <div className={`pointer-events-none absolute bottom-14 z-20 rounded-md bg-black/45 px-2.5 py-1.5 text-[10px] text-white/70 backdrop-blur-sm ${demCoverageVisible ? "left-[17.5rem]" : "left-3"}`}>
          Terrain workspace full screen · all tools remain available · Esc to exit
        </div>
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

      {saveDialogOpen ? (
        <CrossSectionSaveDialog
          draftPoints={savePoints}
          profile={profile}
          preferredSpacingM={preferredSpacingM}
          actualSpacingM={actualSpacingM}
          currentSaved={savedCrossSection}
          onClose={() => setSaveDialogOpen(false)}
          onSaved={setSavedCrossSection}
        />
      ) : null}

      {captureDialogOpen ? (
        <AerialCaptureDialog
          points={controlPoints}
          onClose={() => setCaptureDialogOpen(false)}
        />
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
