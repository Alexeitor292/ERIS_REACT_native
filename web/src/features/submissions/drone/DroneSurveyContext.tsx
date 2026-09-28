import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  archiveOriginal,
  createSurvey,
  deleteSurvey,
  fetchOverlay,
  fetchPatch,
  listSurveys,
  updateSurvey,
  type DroneSurvey,
  type SavedComparison,
  type SurveyPoint,
} from "../../../api/droneSurveys";
import { areasFromGeoJson } from "../../../components/siteAreasModel";
import { sampleElevations } from "../terrainElevation";
import { alignmentPoints, decodeGrid, encodeGrid, sampleGrid, verticalOffset, type DroneGrid, type LonLat } from "./droneGrid";
import { readElevation, readOrthomosaic, type Progress, type VerticalUnit } from "./readDroneFiles";

/** Files larger than this are not archived as attachments (the public connection refuses bigger uploads). */
export const MAX_ARCHIVED_BYTES = 95 * 1024 * 1024;

export type LoadedSurvey = { survey: DroneSurvey; grid: DroneGrid; overlayUrl: string | null };

export type NewSurvey = {
  dsm: File;
  ortho: File | null;
  label: string;
  capturedOn: string | null;
  source: string;
  verticalUnit?: VerticalUnit;
  alignment: "AUTO" | "NONE";
};

type DroneSurveyState = {
  submissionId: number;
  canEdit: boolean;
  surveys: DroneSurvey[];
  loading: boolean;
  error: string | null;
  /** The survey shown and measured against, loaded (patch and image). */
  active: LoadedSurvey | null;
  activeId: number | null;
  setActiveId: (id: number | null) => void;
  /** Show the drone surface (now) or the terrain model (before) in the 3D view. */
  showSurface: boolean;
  setShowSurface: (show: boolean) => void;
  /** Clicking the 3D view captures points on both surfaces. */
  capturing: boolean;
  setCapturing: (on: boolean) => void;
  /** The drone height at a point, lined up with the terrain model (null outside the survey). */
  actualAt: (lon: number, lat: number) => number | null;
  upload: (input: NewSurvey, onProgress: Progress) => Promise<void>;
  update: (id: number, patch: Parameters<typeof updateSurvey>[2]) => Promise<void>;
  remove: (id: number) => Promise<void>;
  realign: () => Promise<{ offsetM: number; spreadM: number } | null>;
  addPoint: (lon: number, lat: number) => Promise<void>;
  removePoint: (id: string) => Promise<void>;
  saveComparison: (comparison: SavedComparison) => Promise<void>;
};

const Context = createContext<DroneSurveyState | null>(null);

export function useDroneSurveys(): DroneSurveyState | null {
  return useContext(Context);
}

/** Areas drawn on the form (the affected ground), as outer rings, to keep out of the alignment. */
function affectedRings(geojson: unknown): LonLat[][] {
  return areasFromGeoJson(geojson).map((rings) => rings[0] as LonLat[]);
}

async function offsetFor(grid: DroneGrid, geojson: unknown): Promise<{ offsetM: number; spreadM: number; count: number } | null> {
  const points = alignmentPoints(grid, affectedRings(geojson), 400);
  if (points.length < 8) return null;
  const { z } = await sampleElevations(points);
  return verticalOffset(points.map(([lon, lat], i) => ({ terrain: z[i], drone: sampleGrid(grid, lon, lat) })));
}

/**
 * The drone surveys of one technical form. With `enabled` false (public
 * viewers, who cannot see them) nothing loads and `useDroneSurveys()` is null.
 */
export function DroneSurveyProvider({ submissionId, canEdit, geojson, enabled = true, children }: { submissionId: number; canEdit: boolean; geojson: unknown; enabled?: boolean; children: ReactNode }) {
  const [surveys, setSurveys] = useState<DroneSurvey[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [active, setActive] = useState<LoadedSurvey | null>(null);
  const [showSurface, setShowSurface] = useState(true);
  const [capturing, setCapturing] = useState(false);
  const loaded = useRef(new Map<number, { grid: DroneGrid; overlayUrl: string | null }>());
  const geojsonRef = useRef(geojson);
  geojsonRef.current = geojson;

  const reload = useCallback(async (select?: number) => {
    setLoading(true);
    setError(null);
    try {
      const items = (await listSurveys(submissionId)).items;
      setSurveys(items);
      setActiveId((current) => select ?? (current != null && items.some((s) => s.id === current) ? current : items[0]?.id ?? null));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the drone surveys.");
    } finally {
      setLoading(false);
    }
  }, [submissionId]);

  useEffect(() => { if (enabled) void reload(); }, [enabled, reload]);

  // Load the active survey's patch and image once; keep them for the page.
  useEffect(() => {
    const survey = surveys.find((s) => s.id === activeId) ?? null;
    if (!survey) { setActive(null); return; }
    const cached = loaded.current.get(survey.id);
    if (cached) { setActive({ survey, ...cached }); return; }
    let cancelled = false;
    (async () => {
      try {
        const grid = decodeGrid(await fetchPatch(submissionId, survey.id));
        const overlayUrl = survey.has_overlay ? URL.createObjectURL(await fetchOverlay(submissionId, survey.id)) : null;
        loaded.current.set(survey.id, { grid, overlayUrl });
        if (!cancelled) setActive({ survey, grid, overlayUrl });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load the drone survey.");
      }
    })();
    return () => { cancelled = true; };
  }, [activeId, surveys, submissionId]);

  useEffect(() => () => {
    for (const { overlayUrl } of loaded.current.values()) if (overlayUrl) URL.revokeObjectURL(overlayUrl);
  }, []);

  const actualAt = useCallback(
    (lon: number, lat: number) => {
      if (!active) return null;
      const raw = sampleGrid(active.grid, lon, lat);
      return raw == null ? null : raw + active.survey.vertical_offset_m;
    },
    [active],
  );

  const upload = useCallback(async (input: NewSurvey, onProgress: Progress) => {
    const step = (from: number, to: number): Progress => (fraction, message) => onProgress(from + (to - from) * fraction, message);
    const elevation = await readElevation(input.dsm, { verticalUnit: input.verticalUnit, onProgress: step(0, input.ortho ? 0.5 : 0.75) });
    const ortho = input.ortho ? await readOrthomosaic(input.ortho, { onProgress: step(0.5, 0.75) }) : null;
    let offset: { offsetM: number; spreadM: number; count: number } | null = null;
    if (input.alignment === "AUTO") {
      onProgress(0.78, "Lining the drone heights up with the terrain model…");
      offset = await offsetFor(elevation.grid, geojsonRef.current);
    }
    const archived: { dsm: number | null; ortho: number | null } = { dsm: null, ortho: null };
    for (const [key, file] of [["dsm", input.dsm], ["ortho", input.ortho]] as const) {
      if (!file || file.size > MAX_ARCHIVED_BYTES) continue;
      onProgress(0.84, `Keeping the original ${key === "dsm" ? "elevation file" : "orthomosaic"} with the form…`);
      try {
        archived[key] = (await archiveOriginal(submissionId, file)).attachment_id;
      } catch {
        // The survey does not depend on the archived original.
      }
    }
    onProgress(0.94, "Saving the survey…");
    const created = await createSurvey(
      submissionId,
      {
        label: input.label.trim() || null,
        source: input.source.trim() || null,
        captured_on: input.capturedOn,
        dsm_filename: input.dsm.name,
        ortho_filename: input.ortho?.name ?? null,
        dsm_attachment_id: archived.dsm,
        ortho_attachment_id: archived.ortho,
        source_crs: elevation.sourceCrs,
        resolution_m: elevation.cellM,
        vertical_offset_m: offset ? Math.round(offset.offsetM * 1000) / 1000 : 0,
        offset_mode: offset ? "AUTO" : "NONE",
        overlay_corners: ortho ? (ortho.corners as Array<[number, number]>) : null,
        stats: {
          min_m: elevation.stats.min,
          max_m: elevation.stats.max,
          valid_cells: elevation.stats.validCells,
          native_resolution_m: elevation.nativeResolutionM,
          vertical_unit: elevation.verticalUnit,
          declared_vertical_unit: elevation.declaredVerticalUnit,
          alignment_spread_m: offset?.spreadM ?? null,
          alignment_points: offset?.count ?? 0,
          dsm_size_bytes: input.dsm.size,
          ortho_size_bytes: input.ortho?.size ?? null,
        },
      },
      encodeGrid(elevation.grid),
      ortho ? { blob: ortho.image, mime: ortho.mime } : null,
    );
    loaded.current.set(created.id, { grid: elevation.grid, overlayUrl: ortho ? URL.createObjectURL(ortho.image) : null });
    onProgress(1, "Done");
    setShowSurface(true);
    await reload(created.id);
  }, [reload, submissionId]);

  const replace = (survey: DroneSurvey) => setSurveys((current) => current.map((s) => (s.id === survey.id ? survey : s)));

  const update = useCallback(async (id: number, patch: Parameters<typeof updateSurvey>[2]) => {
    replace(await updateSurvey(submissionId, id, patch));
  }, [submissionId]);

  const remove = useCallback(async (id: number) => {
    await deleteSurvey(submissionId, id);
    const cached = loaded.current.get(id);
    if (cached?.overlayUrl) URL.revokeObjectURL(cached.overlayUrl);
    loaded.current.delete(id);
    await reload();
  }, [reload, submissionId]);

  const realign = useCallback(async () => {
    if (!active) return null;
    const offset = await offsetFor(active.grid, geojsonRef.current);
    if (!offset) return null;
    replace(await updateSurvey(submissionId, active.survey.id, { vertical_offset_m: Math.round(offset.offsetM * 1000) / 1000, offset_mode: "AUTO" }));
    return offset;
  }, [active, submissionId]);

  const addPoint = useCallback(async (lon: number, lat: number) => {
    if (!active) return;
    const { z } = await sampleElevations([[lon, lat]]);
    const point: SurveyPoint = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      lon: Math.round(lon * 1e7) / 1e7,
      lat: Math.round(lat * 1e7) / 1e7,
      historical_m: z[0] ?? null,
      actual_m: actualAt(lon, lat),
      label: `P${active.survey.points.length + 1}`,
      captured_at: new Date().toISOString(),
    };
    replace(await updateSurvey(submissionId, active.survey.id, { points: [...active.survey.points, point] }));
  }, [active, actualAt, submissionId]);

  const removePoint = useCallback(async (id: string) => {
    if (!active) return;
    replace(await updateSurvey(submissionId, active.survey.id, { points: active.survey.points.filter((p) => p.id !== id) }));
  }, [active, submissionId]);

  const saveComparison = useCallback(async (comparison: SavedComparison) => {
    if (!active || !canEdit) return;
    replace(await updateSurvey(submissionId, active.survey.id, { comparison }));
  }, [active, canEdit, submissionId]);

  // Keep the loaded survey in step with its record (offset, points, comparison).
  useEffect(() => {
    setActive((current) => {
      if (!current) return current;
      const fresh = surveys.find((s) => s.id === current.survey.id);
      return fresh && fresh !== current.survey ? { ...current, survey: fresh } : current;
    });
  }, [surveys]);

  const value = useMemo<DroneSurveyState>(
    () => ({
      submissionId, canEdit, surveys, loading, error, active, activeId, setActiveId, showSurface, setShowSurface,
      capturing, setCapturing, actualAt, upload, update, remove, realign, addPoint, removePoint, saveComparison,
    }),
    [submissionId, canEdit, surveys, loading, error, active, activeId, showSurface, capturing, actualAt, upload, update, remove, realign, addPoint, removePoint, saveComparison],
  );
  return <Context.Provider value={enabled ? value : null}>{children}</Context.Provider>;
}
