import { lazy, Suspense, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { api } from "../../api/client";
import type { Gisa, GisaElevationProfile, GisaTerrainGrid } from "../../api/types";
import { TerrainRelief } from "../../components/TerrainRelief";
import {
  fieldDescription,
  friendlyFieldLabel,
  friendlyFieldValue,
  terrainLabel,
} from "../../utils/roadInventoryGlossary";
import {
  bearingDisplayNote,
  elevationClassificationReasonNote,
  parseRoadBearingInput,
} from "./submissionMeasurementContextModel";

const InteractiveTerrainScene = lazy(() => import("../../components/InteractiveTerrainScene"));

export default function SubmissionMeasurementContext({
  submissionId,
  gisa,
  onReload,
}: {
  submissionId: number;
  gisa: Gisa | null;
  onReload: () => Promise<void>;
}) {
  const [elevFetching, setElevFetching] = useState(false);
  const [elevError, setElevError] = useState<string | null>(null);
  const [bearingInput, setBearingInput] = useState("");
  const [terrainView, setTerrainView] = useState<"profile" | "terrain">("profile");
  const [terrainFetching, setTerrainFetching] = useState(false);
  const [terrainError, setTerrainError] = useState<string | null>(null);
  const [riDetailsOpen, setRiDetailsOpen] = useState(false);
  const [searchParams] = useSearchParams();
  const deepLinkTerrain = searchParams.get("section") === "terrain";

  const snapshotBearing = gisa?.road_inventory_context?.snapshot?.road_bearing_deg;

  useEffect(() => {
    if (!deepLinkTerrain) return;
    setTerrainView("terrain");
    const timer = window.setTimeout(() => {
      document.getElementById("terrain-3d-section")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [deepLinkTerrain]);

  useEffect(() => {
    if (snapshotBearing == null) return;
    setBearingInput((current) => current === "" ? String(snapshotBearing) : current);
  }, [snapshotBearing]);

  async function fetchElevation(force: boolean) {
    const road_bearing_deg = parseRoadBearingInput(bearingInput);
    setElevFetching(true);
    setElevError(null);
    try {
      await api<{ elevation_profile: GisaElevationProfile }>(
        `/submissions/${submissionId}/gisa/elevation-profile`,
        { method: "POST", body: JSON.stringify({ force, road_bearing_deg }) },
      );
      await onReload();
    } catch (error: any) {
      setElevError(error?.message ?? "Elevation fetch failed");
    } finally {
      setElevFetching(false);
    }
  }

  async function fetchTerrain(force: boolean) {
    const road_bearing_deg = parseRoadBearingInput(bearingInput);
    setTerrainFetching(true);
    setTerrainError(null);
    try {
      await api<{ terrain: GisaTerrainGrid }>(
        `/submissions/${submissionId}/gisa/terrain-grid`,
        { method: "POST", body: JSON.stringify({ force, road_bearing_deg }) },
      );
      await onReload();
    } catch (error: any) {
      setTerrainError(error?.message ?? "Terrain build failed");
    } finally {
      setTerrainFetching(false);
    }
  }

  const roadInventory = gisa?.road_inventory_context ?? null;
  const snapshot = roadInventory?.snapshot ?? {};
  const terrainCode = (snapshot.terrain_code ?? snapshot.THY_TERRAIN_CODE) as string | null | undefined;
  const elevationProfile = gisa?.elevation_profile ?? null;

  return (
    <>
      {roadInventory ? (
        <div className="mb-2 rounded border border-[color:color-mix(in_oklab,var(--good)_32%,transparent)] bg-[color:color-mix(in_oklab,var(--good)_8%,transparent)] px-2.5 py-2 text-xs">
          <div className="mb-1 font-semibold text-[var(--good)]">Road inventory context</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-muted">
            {snapshot.county_code != null ? (
              <span>County: <span className="text-[var(--ink)]">{String(snapshot.county_code)}</span></span>
            ) : null}
            {snapshot.route_name != null ? (
              <span>Route: <span className="text-[var(--ink)]">{String(snapshot.route_name)}</span></span>
            ) : null}
            {snapshot.begin_pm != null || snapshot.end_pm != null ? (
              <span className="col-span-2">
                Postmile: <span className="text-[var(--ink)]">{String(snapshot.begin_pm ?? "?")} – {String(snapshot.end_pm ?? "?")} mi</span>
              </span>
            ) : null}
            {terrainCode ? (
              <span className="col-span-2">Terrain: <span className="text-[var(--ink)]">{terrainLabel(terrainCode)}</span></span>
            ) : null}
            {snapshot.left_lanes != null || snapshot.right_lanes != null ? (
              <span>
                Lanes: <span className="text-[var(--ink)]">{snapshot.left_lanes != null ? `${snapshot.left_lanes} LT` : "?"} / {snapshot.right_lanes != null ? `${snapshot.right_lanes} RT` : "?"}</span>
              </span>
            ) : null}
            <span>Match: <span className="text-[var(--ink)]">{roadInventory.match_method ?? "—"}</span></span>
            {roadInventory.checked_at ? (
              <span>Checked: <span className="text-[var(--ink)]">{roadInventory.checked_at.slice(0, 10)}</span></span>
            ) : null}
          </div>

          <button
            type="button"
            onClick={() => setRiDetailsOpen((open) => !open)}
            className="mt-1.5 text-[10px] font-medium text-[var(--good)] hover:opacity-80"
          >
            {riDetailsOpen ? "▲ Hide field details" : "▼ Field meanings & raw values"}
          </button>

          {riDetailsOpen && Object.keys(snapshot).length > 0 ? (
            <div className="mt-2 border-t border-[color:color-mix(in_oklab,var(--good)_20%,transparent)] pt-2">
              <div className="mb-1 text-[9px] italic text-[var(--good)]">
                CA Highways (HICOMP) dataset — v{roadInventory.dataset_version_id}, segment {roadInventory.segment_id}. Raw field names shown for traceability.
              </div>
              <div className="grid grid-cols-1 gap-y-1">
                {Object.entries(snapshot).map(([key, value]) => (
                  <div key={key} className="text-[10px]">
                    <span className="font-medium text-[var(--ink)]">{friendlyFieldLabel(key)}: </span>
                    <span className="text-[var(--ink)]">{friendlyFieldValue(key, value)}</span>
                    <span className="ml-1 text-[var(--muted)] opacity-60">({key})</span>
                    {fieldDescription(key) ? (
                      <div className="pl-2 text-[9px] italic text-muted">{fieldDescription(key)}</div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="mt-1 text-[10px] italic text-[var(--good)]">
            Road inventory values from the published CA Highways dataset.
          </div>
        </div>
      ) : (
        <div className="mb-2 text-xs italic text-muted">
          No road inventory context. Diagram uses form / default roadway assumptions.
        </div>
      )}

      <div className="mb-2 inline-flex overflow-hidden rounded border border-[var(--line)] text-[11px]">
        {(["profile", "terrain"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => setTerrainView(mode)}
            className={`px-2.5 py-1 font-medium ${terrainView === mode ? "bg-[var(--brand)] text-white" : "bg-[var(--panel-soft)] text-[var(--ink)] hover:brightness-95"}`}
          >
            {mode === "profile" ? "Elevation Profile" : "3D Terrain"}
          </button>
        ))}
      </div>

      {terrainView === "terrain" ? (
        <div className="mb-2" id="terrain-3d-section">
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
              terrain={gisa?.elevation_terrain ?? null}
              geometryJson={(gisa?.geometry_json as Record<string, unknown> | null) ?? null}
              route={gisa?.route ?? null}
              postMile={gisa?.post_mile ?? null}
              county={gisa?.county ?? null}
              incidentLabel={`Submission #${submissionId}`}
            />
          </Suspense>

          <details className="mt-2 rounded border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-1.5">
            <summary className="cursor-pointer text-[11px] font-medium text-[var(--ink)]">
              USGS sampled relief (diagnostic)
            </summary>
            <div className="mt-2">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={terrainFetching}
                  onClick={() => fetchTerrain(true)}
                  className="rounded bg-[var(--brand)] px-2 py-0.5 text-[10px] font-medium text-white opacity-90 hover:opacity-100 disabled:opacity-40"
                >
                  {terrainFetching ? "Building…" : gisa?.elevation_terrain ? "Rebuild terrain" : "Build terrain"}
                </button>
                <span className="text-[9px] italic text-muted">
                  Samples an 11×11 USGS 3DEP grid (~200×200 m), road-aligned. Cached; feeds the classification and the scene&apos;s sample-extent overlay.
                </span>
              </div>
              <TerrainRelief terrain={gisa?.elevation_terrain ?? null} />
              {terrainError ? <div className="mt-1 text-[10px] text-[var(--error)]">{terrainError}</div> : null}
            </div>
          </details>
        </div>
      ) : null}

      {terrainView === "profile" ? (
        <ElevationProfilePanel
          profile={elevationProfile}
          bearingInput={bearingInput}
          elevFetching={elevFetching}
          elevError={elevError}
          onBearingInputChange={setBearingInput}
          onFetch={fetchElevation}
        />
      ) : null}
    </>
  );
}

function ElevationProfilePanel({
  profile,
  bearingInput,
  elevFetching,
  elevError,
  onBearingInputChange,
  onFetch,
}: {
  profile: GisaElevationProfile | null;
  bearingInput: string;
  elevFetching: boolean;
  elevError: string | null;
  onBearingInputChange: (value: string) => void;
  onFetch: (force: boolean) => void;
}) {
  const metadata = (profile?.profile as Record<string, unknown> | null | undefined)?.metadata as Record<string, unknown> | null | undefined;
  const bearingUsed = metadata?.road_bearing_deg_used as number | null | undefined;
  const bearingSource = metadata?.road_bearing_source as string | null | undefined;
  const classReason = (profile?.classification_reason ?? metadata?.classification_reason) as string | null | undefined;
  const reasonNote = elevationClassificationReasonNote(
    classReason,
    metadata?.classification_note as string | null | undefined,
  );

  if (profile) {
    return (
      <div className="mb-2 rounded border border-[color:color-mix(in_oklab,var(--brand)_28%,transparent)] bg-[color:color-mix(in_oklab,var(--brand)_6%,transparent)] px-2.5 py-2 text-xs">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="font-semibold text-[var(--brand)]">Elevation profile</span>
          <button
            type="button"
            disabled={elevFetching}
            onClick={() => onFetch(true)}
            className="rounded bg-[var(--brand)] px-2 py-0.5 text-[10px] font-medium text-white opacity-80 hover:opacity-100 disabled:opacity-40"
          >
            {elevFetching ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        <BearingInput value={bearingInput} onChange={onBearingInputChange} />
        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-muted">
          <span>Source: <span className="text-[var(--ink)]">{profile.source ?? "—"}</span></span>
          <span>Classification: <span className="text-[var(--ink)]">{profile.classification ?? "—"}</span></span>
          {profile.confidence != null ? (
            <span>Confidence: <span className="text-[var(--ink)]">{(profile.confidence * 100).toFixed(0)}%</span></span>
          ) : null}
          {profile.checked_at ? (
            <span>Checked: <span className="text-[var(--ink)]">{profile.checked_at.slice(0, 10)}</span></span>
          ) : null}
          <span className="col-span-2">
            Bearing: <span className={bearingUsed != null ? "text-[var(--ink)]" : "text-[var(--muted)] italic"}>{bearingDisplayNote(bearingUsed, bearingSource)}</span>
          </span>
          {profile.classification === "UNKNOWN" && reasonNote ? (
            <span className="col-span-2">Why UNKNOWN: <span className="text-[var(--ink)]">{reasonNote}</span></span>
          ) : null}
        </div>
        {profile.error ? <div className="mt-1 text-[10px] text-[var(--error)]">{profile.error}</div> : null}
        {elevError ? <div className="mt-1 text-[10px] text-[var(--error)]">{elevError}</div> : null}
      </div>
    );
  }

  return (
    <div className="mb-2 rounded border border-[color:color-mix(in_oklab,var(--brand)_15%,transparent)] bg-[color:color-mix(in_oklab,var(--brand)_4%,transparent)] px-2.5 py-2 text-xs">
      <div className="mb-1.5 font-semibold text-[var(--brand)]">Elevation profile</div>
      <BearingInput value={bearingInput} onChange={onBearingInputChange} />
      <div className="flex items-center gap-2">
        <span className="text-xs italic text-muted">No elevation profile fetched.</span>
        <button
          type="button"
          disabled={elevFetching}
          onClick={() => onFetch(false)}
          className="rounded bg-[var(--brand)] px-2 py-0.5 text-[10px] font-medium text-white opacity-80 hover:opacity-100 disabled:opacity-40"
        >
          {elevFetching ? "Fetching…" : "Fetch Elevation Profile"}
        </button>
      </div>
      {elevError ? <div className="mt-1 text-[10px] text-[var(--error)]">{elevError}</div> : null}
    </div>
  );
}

function BearingInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="mb-1.5 flex items-center gap-2">
      <label className="shrink-0 text-[10px] text-muted">Road bearing (deg):</label>
      <input
        type="number"
        min="0"
        max="359"
        step="1"
        placeholder="0–359"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-20 rounded border border-[var(--line)] bg-[var(--panel)] px-1.5 py-0.5 text-[10px] text-[var(--ink)]"
      />
      <span className="text-[9px] italic text-muted">
        Optional. Leave blank to auto-derive from postmile geometry when available.
      </span>
    </div>
  );
}
