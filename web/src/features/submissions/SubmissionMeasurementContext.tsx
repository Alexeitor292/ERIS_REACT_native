import { lazy, Suspense, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { api } from "../../api/client";
import type { Gisa, GisaTerrainGrid } from "../../api/types";

const InteractiveTerrainScene = lazy(() => import("../../components/InteractiveTerrainScene"));

/**
 * Measurement context = the 3D terrain scene only. The elevation-profile block, the
 * road-inventory context block, and the USGS sampled-relief diagnostic were removed
 * from the submission detail view (backend endpoints and stored data are untouched).
 *
 * The compact "Sample terrain" action is kept because the scene's terrain-extent and
 * road-bearing overlays read the cached USGS grid produced by that endpoint.
 */
export default function SubmissionMeasurementContext({
  submissionId,
  gisa,
  onReload,
}: {
  submissionId: number;
  gisa: Gisa | null;
  onReload: () => Promise<void>;
}) {
  const [terrainFetching, setTerrainFetching] = useState(false);
  const [terrainError, setTerrainError] = useState<string | null>(null);
  const [searchParams] = useSearchParams();
  const deepLinkTerrain = searchParams.get("section") === "terrain";

  useEffect(() => {
    if (!deepLinkTerrain) return;
    const timer = window.setTimeout(() => {
      document.getElementById("terrain-3d-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [deepLinkTerrain]);

  async function sampleTerrain(force: boolean) {
    setTerrainFetching(true);
    setTerrainError(null);
    try {
      await api<{ terrain: GisaTerrainGrid }>(`/submissions/${submissionId}/gisa/terrain-grid`, {
        method: "POST",
        body: JSON.stringify({ force, road_bearing_deg: null }),
      });
      await onReload();
    } catch (error: any) {
      setTerrainError(error?.message ?? "Terrain sampling failed");
    } finally {
      setTerrainFetching(false);
    }
  }

  const terrain = gisa?.elevation_terrain ?? null;

  return (
    <div id="terrain-3d-section" className="mb-2">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">3D terrain</div>
        <div className="flex flex-wrap items-center gap-2">
          {terrain?.checked_at ? (
            <span className="text-[10px] text-muted" title="USGS 3DEP grid sampled around the submission point">
              Terrain samples {terrain.checked_at.slice(0, 10)}
            </span>
          ) : null}
          <button
            type="button"
            disabled={terrainFetching}
            onClick={() => sampleTerrain(true)}
            className="rounded border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-0.5 text-[10px] font-medium hover:brightness-95 disabled:opacity-40"
          >
            {terrainFetching ? "Sampling…" : terrain ? "Refresh terrain samples" : "Sample terrain"}
          </button>
        </div>
      </div>

      <div className="map-stack-guard">
        <Suspense
          fallback={
            <div
              className="flex items-center justify-center rounded-lg border border-[var(--line)] bg-[#0f172a]/80 text-center"
              style={{ height: 460 }}
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
            geometryJson={(gisa?.geometry_json as Record<string, unknown> | null) ?? null}
            route={gisa?.route ?? null}
            postMile={gisa?.post_mile ?? null}
            county={gisa?.county ?? null}
            incidentLabel={`Submission #${submissionId}`}
          />
        </Suspense>
      </div>

      {terrainError ? <div className="mt-1 text-[10px] text-[var(--bad)]">{terrainError}</div> : null}
      {terrain?.error ? <div className="mt-1 text-[10px] text-[var(--bad)]">{terrain.error}</div> : null}
    </div>
  );
}
