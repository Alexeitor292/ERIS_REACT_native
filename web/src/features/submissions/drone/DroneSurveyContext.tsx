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
  /** What the active survey is compared with: another survey, or null for the terrain model. */
  baseline: LoadedSurvey | null;
  baselineId: number | null;
  setBaselineId: (id: number | null) => void;
  /** Make the baseline the survey shown, and the survey shown the baseline. */
  swapBaseline: () => void;
  /** The baseline survey's height at a point, lined up with the terrain model (null without one, or outside it). */
  baselineAt: (lon: number, lat: number) => number | null;
  /** The ground before at each point: the baseline survey, or the terrain model when there is none. */
  beforeHeights: (points: LonLat[]) => Promise<Array<number | null>>;
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
/** Load survey `id` (from `surveys`) into `set`; the returned function stops a load that is no longer wanted. */
function follow(
  id: number | null,
  surveys: DroneSurvey[],
  load: (survey: DroneSurvey) => Promise<{ grid: DroneGrid; overlayUrl: string | null }>,
  set: (value: LoadedSurvey | null) => void,
  onError: (message: string) => void,
): (() => void) | undefined {
  const survey = surveys.find((s) => s.id === id) ?? null;
  if (!survey) {
    set(null);
    return undefined;
  }
  let cancelled = false;
  load(survey).then(
    (entry) => { if (!cancelled) set({ survey, ...entry }); },
    (e) => { if (!cancelled) onError(e instanceof Error ? e.message : "Could not load the drone survey."); },
  );
  return () => { cancelled = true; };
}

export function DroneSurveyProvider({ submissionId, canEdit, geojson, enabled = true, children }: { submissionId: number; canEdit: boolean; geojson: unknown; enabled?: boolean; children: ReactNode }) {
  const [surveys, setSurveys] = useState<DroneSurvey[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [active, setActive] = useState<LoadedSurvey | null>(null);
  const [baselineId, setBaselineIdState] = useState<number | null>(null);
  const [baseline, setBaseline] = useState<LoadedSurvey | null>(null);
  const [showSurface, setShowSurface] = useState(true);
  const [capturing, setCapturing] = useState(false);
  const loaded = useRef(new Map<number, { grid: DroneGrid; overlayUrl: string | null }>());
  const inflight = useRef(new Map<number, Promise<{ grid: DroneGrid; overlayUrl: string | null }>>());
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

  // A survey's patch and image are fetched once and kept for the page.
  const loadSurvey = useCallback((survey: DroneSurvey) => {
    const cached = loaded.current.get(survey.id);
    if (cached) return Promise.resolve(cached);
    let pending = inflight.current.get(survey.id);
    if (!pending) {
      pending = (async () => {
        const grid = decodeGrid(await fetchPatch(submissionId, survey.id));
        const overlayUrl = survey.has_overlay ? URL.createObjectURL(await fetchOverlay(submissionId, survey.id)) : null;
        const entry = { grid, overlayUrl };
        loaded.current.set(survey.id, entry);
        return entry;
      })().finally(() => inflight.current.delete(survey.id));
      inflight.current.set(survey.id, pending);
    }
    return pending;
  }, [submissionId]);

  useEffect(() => follow(activeId, surveys, loadSurvey, setActive, setError), [activeId, surveys, loadSurvey]);
  useEffect(() => follow(baselineId, surveys, loadSurvey, setBaseline, setError), [baselineId, surveys, loadSurvey]);
  // A survey is never compared with itself.
  const liveBaseline = baseline && baseline.survey.id !== activeId ? baseline : null;

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

  const baselineAt = useCallback(
    (lon: number, lat: number) => {
      if (!liveBaseline) return null;
      const raw = sampleGrid(liveBaseline.grid, lon, lat);
      return raw == null ? null : raw + liveBaseline.survey.vertical_offset_m;
    },
    [liveBaseline],
  );

  const beforeHeights = useCallback(
    async (points: LonLat[]) => (liveBaseline ? points.map(([lon, lat]) => baselineAt(lon, lat)) : (await sampleElevations(points)).z),
    [liveBaseline, baselineAt],
  );

  // What a survey is compared with is kept on the survey, so everybody who opens
  // the form sees the comparison its author chose. Whoever cannot edit the form
  // may still switch it for themselves.
  const remember = useCallback(
    (surveyId: number, compareWith: number | null) => {
      if (!canEdit) return;
      updateSurvey(submissionId, surveyId, { compare_with_survey_id: compareWith })
        .then((saved) => setSurveys((current) => current.map((s) => (s.id === saved.id ? saved : s))))
        .catch(() => {
          // The choice still applies on this page; it is just not kept.
        });
    },
    [canEdit, submissionId],
  );

  const setBaselineId = useCallback(
    (id: number | null) => {
      setBaselineIdState(id);
      if (activeId != null) remember(activeId, id);
    },
    [activeId, remember],
  );

  // A survey shown as now brings back what it was last compared with.
  const appliedFor = useRef<number | null>(null);
  useEffect(() => {
    if (activeId == null || appliedFor.current === activeId) return;
    const survey = surveys.find((s) => s.id === activeId);
    if (!survey) return;
    appliedFor.current = activeId;
    const other = survey.compare_with_survey_id ?? null;
    setBaselineIdState(other != null && other !== activeId && surveys.some((s) => s.id === other) ? other : null);
  }, [activeId, surveys]);

  const swapBaseline = useCallback(() => {
    if (baselineId == null || activeId == null) return;
    appliedFor.current = baselineId;
    setActiveId(baselineId);
    setBaselineIdState(activeId);
    remember(baselineId, activeId);
  }, [activeId, baselineId, remember]);

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
    setBaselineIdState((current) => (current === id ? null : current));
    const cached = loaded.current.get(id);
    if (cached?.overlayUrl) URL.revokeObjectURL(cached.overlayUrl);
    loaded.current.delete(id);
    await reload();
  }, [reload, submissionId]);

  const realign = useCallback(async () => {
    if (!active) return null;
    const offset = await offsetFor(active.grid, geojsonRef.current);
    if (!offset) return null;
    replace(
      await updateSurvey(submissionId, active.survey.id, {
        vertical_offset_m: Math.round(offset.offsetM * 1000) / 1000,
        offset_mode: "AUTO",
        alignment_spread_m: offset.spreadM,
        alignment_points: offset.count,
      }),
    );
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
      submissionId, canEdit, surveys, loading, error, active, activeId, setActiveId,
      baseline: liveBaseline, baselineId: baselineId !== activeId ? baselineId : null, setBaselineId, swapBaseline, baselineAt, beforeHeights,
      showSurface, setShowSurface, capturing, setCapturing, actualAt, upload, update, remove, realign, addPoint, removePoint, saveComparison,
    }),
    [submissionId, canEdit, surveys, loading, error, active, activeId, liveBaseline, baselineId, swapBaseline, baselineAt, beforeHeights,
      showSurface, capturing, actualAt, upload, update, remove, realign, addPoint, removePoint, saveComparison],
  );
  return <Context.Provider value={enabled ? value : null}>{children}</Context.Provider>;
}
