import { lazy, Suspense, useState } from "react";

import { api } from "../../api/client";
import type { Gisa, GisaTerrainGrid } from "../../api/types";

const InteractiveTerrainScene = lazy(() => import("../../components/InteractiveTerrainScene"));
import type { Guide } from "./measurements/measurementGuides";
import { useDroneSurveys } from "./drone/DroneSurveyContext";

/** Samples the USGS grid that the 3D view's terrain extent and road bearing overlays read. */
export function TerrainSamplesControl({
  submissionId,
  gisa,
  onReload,
}: {
  submissionId: number;
  gisa: Gisa | null;
  onReload: () => Promise<void>;
}) {
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const terrain = gisa?.elevation_terrain ?? null;

  async function sample() {
    setFetching(true);
    setError(null);
    try {
      await api<{ terrain: GisaTerrainGrid }>(`/submissions/${submissionId}/gisa/terrain-grid`, {
        method: "POST",
        body: JSON.stringify({ force: true, road_bearing_deg: null }),
      });
      await onReload();
    } catch (e: any) {
      setError(e?.message ?? "Terrain sampling failed");
    } finally {
      setFetching(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <button
        type="button"
        disabled={fetching}
        onClick={sample}
        className="min-h-11 rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50"
      >
        {fetching ? "Sampling…" : terrain ? "Refresh terrain samples" : "Sample terrain"}
      </button>
      {terrain?.checked_at ? <span className="text-muted">Sampled {terrain.checked_at.slice(0, 10)}</span> : null}
      {error ? <span className="text-[var(--bad)]">{error}</span> : null}
      {terrain?.error ? <span className="text-[var(--bad)]">{terrain.error}</span> : null}
    </div>
  );
}

/** The 3D terrain with the drone survey laid over it and the measurements drawn on it. */
export default function SubmissionMeasurementContext({
  submissionId,
  gisa,
  geometryJson,
  height = 460,
  guides,
  guideFitKey,
}: {
  submissionId: number;
  gisa: Gisa | null;
  /** The areas as currently drawn on the location map; defaults to the saved geometry. */
  geometryJson?: unknown;
  height?: number;
  guides?: Array<Guide & { hot: boolean }>;
  guideFitKey?: string;
}) {
  const terrain = gisa?.elevation_terrain ?? null;
  const drone = useDroneSurveys();
  const active = drone?.active ?? null;
  // "Before" shows the earlier survey when the active one is compared with one, else the terrain model.
  const shown = active && !drone!.showSurface && drone!.baseline ? drone!.baseline : active;
  const droneScene = active && shown
    ? {
        key: `${shown.survey.id}:${shown.survey.vertical_offset_m}`,
        grid: shown.grid,
        offsetM: shown.survey.vertical_offset_m,
        overlayUrl: shown.overlayUrl,
        corners: shown.survey.overlay_corners,
        show: drone!.showSurface || shown !== active,
        later: shown !== active ? active.grid : null,
        points: active.survey.points,
      }
    : null;
  const [pickError, setPickError] = useState<string | null>(null);
  // A click on the ground adds to the section line being drawn, or captures a point.
  const onPick = drone?.section.drawing
    ? (lon: number, lat: number) => drone.addSectionPoint(lon, lat)
    : drone?.capturing && active
      ? (lon: number, lat: number) => {
          setPickError(null);
          drone.addPoint(lon, lat).catch((e: unknown) => setPickError(e instanceof Error ? e.message : "Could not capture the point."));
        }
      : null;
  const drawn = !!drone && (drone.section.points.length > 0 || drone.section.drawing);
  const section = drone && (drawn || drone.fallLine || drone.sectionHover)
    ? drawn
      ? { points: drone.section.points, drawing: drone.section.drawing, hover: drone.sectionHover }
      : { points: drone.fallLine ?? [], drawing: false, hover: drone.sectionHover, fallLine: true }
    : null;


  return (
    <div id="terrain-3d-section">
      <div className="map-stack-guard">
        <Suspense
          fallback={
            <div
              className="flex items-center justify-center rounded-lg border border-[var(--line)] bg-[#0f172a]/80 text-center"
              style={{ height }}
            >
              <div className="text-xs text-white/85">
                <div className="mx-auto mb-2 h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                Loading 3D terrain & imagery…
              </div>
            </div>
          }
        >
          <InteractiveTerrainScene
            location={{ latitude: gisa?.latitude ?? null, longitude: gisa?.longitude ?? null }}
            terrain={terrain}
            geometryJson={((geometryJson !== undefined ? geometryJson : gisa?.geometry_json) as Record<string, unknown> | null) ?? null}
            height={height}
            route={gisa?.route ?? null}
            postMile={gisa?.post_mile ?? null}
            county={gisa?.county ?? null}
            incidentLabel={`Submission #${submissionId}`}
            drone={droneScene}
            onPick={onPick}
            section={section}
            guides={guides}
            guideFitKey={guideFitKey}
            embedded
          />
        </Suspense>
      </div>

      {pickError ? <div className="mt-1 text-[10px] text-[var(--bad)]">{pickError}</div> : null}
    </div>
  );
}
