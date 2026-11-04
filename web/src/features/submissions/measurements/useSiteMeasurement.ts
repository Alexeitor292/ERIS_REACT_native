import { useEffect, useMemo, useState } from "react";

import type { SavedComparison } from "../../../api/droneSurveys";
import { areasFromGeoJson } from "../../../components/siteAreasModel";
import { useTerrainSource } from "../../../components/terrainSource";
import { useDroneSurveys } from "../drone/DroneSurveyContext";
import type { ProfilePoint } from "../drone/SlopeProfileDiagram";
import { surveyTitle } from "../drone/surveyLabels";
import {
  buildSamplePlan,
  compareSurfaces,
  comparisonFieldValues,
  FT_PER_M,
  measureSiteArea,
  measurementFieldValues,
  pointsAlong,
  pointsAlongPath,
  profileLine,
  scarpSuggestion,
  type LonLat,
  type MeasurementField,
  type Sample,
  type ScarpSuggestion,
  type SiteMeasurement,
  type SurfaceComparison,
} from "../siteTerrainModel";
import { sampleElevations } from "../terrainElevation";
import { buildGuides, type Guide } from "./measurementGuides";

export type DroneMeasure = {
  comparison: SurfaceComparison;
  /** The survey that is the ground now, and what the ground before is: "terrain model" or an earlier survey. */
  nowTitle: string;
  /** When the survey that is the ground now was flown (ISO), to set against the terrain model's date. */
  nowDate: string | null;
  beforeTitle: string;
  beforeIsSurvey: boolean;
  offsetM: number;
  /** Share of the compared area the earlier survey saw as sea: compared from sea level, so gains there are a lower bound. */
  seaShare: number;
  /** What was saved with the survey, to save again when only the section line changes. */
  saved: SavedComparison | null;
};

export type MeasureResult = {
  /** The area, the drone survey and what it is compared with (each with its offset). */
  key: string;
  measurement: SiteMeasurement;
  proposed: Partial<Record<MeasurementField, string>>;
  resolution: { min: number; max: number } | null;
  missing: number;
  bufferM: number;
  /** The direction the slope falls, which the default section follows. */
  bearingDeg: number;
  profile: ProfilePoint[];
  /** The drawn line the section follows (null: down the fall line), as a key to notice when it changes. */
  sectionLine: LonLat[] | null;
  sectionKey: string;
  /** With a drone survey: a suggestion for Hs, only ever a suggestion. */
  scarp: ScarpSuggestion | null;
  drone: DroneMeasure | null;
  /** A drone survey is loaded but covers too little of the area (with what it is compared with) to measure it. */
  droneCoverage: number | null;
};

/** The drone survey must cover at least this share of the area to measure the ground now. */
const MIN_DRONE_COVERAGE = 0.5;

/**
 * Measuring the area drawn on the map from the terrain model and any drone
 * survey. It lives above the form and the workspace, so what was measured
 * in one is there in the other.
 */
export function useSiteMeasurement({ geojson, canEdit, auto }: { geojson: unknown; canEdit: boolean; auto: boolean }) {
  const areas = useMemo(() => areasFromGeoJson(geojson), [geojson]);
  const [areaIndex, setAreaIndex] = useState(0);
  const index = Math.min(areaIndex, Math.max(0, areas.length - 1));
  const area = areas[index] ?? null;
  const areaKey = area ? JSON.stringify(area) : "";
  // Where the terrain model under the area comes from, and when it was flown.
  const areaCentre = useMemo((): [number, number] | null => {
    const ring = area?.[0];
    if (!ring?.length) return null;
    return [ring.reduce((sum, p) => sum + p[0], 0) / ring.length, ring.reduce((sum, p) => sum + p[1], 0) / ring.length];
  }, [areaKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const terrain = useTerrainSource(areaCentre);
  const drone = useDroneSurveys();
  const survey = drone?.active ?? null;
  const baseline = drone?.baseline ?? null;
  const measureKey = [
    areaKey,
    survey ? `${survey.survey.id}:${survey.survey.vertical_offset_m}` : "",
    baseline ? `${baseline.survey.id}:${baseline.survey.vertical_offset_m}` : "terrain",
  ].join("|");

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MeasureResult | null>(null);
  const stale = result != null && result.key !== measureKey;
  const current = result && !stale ? result : null;

  // The section follows a line someone drew in the 3D view, else the fall line.
  const drawnLine = drone && !drone.section.drawing && drone.section.points.length >= 2 ? drone.section.points : null;
  const drawnKey = drawnLine ? JSON.stringify(drawnLine) : "";

  async function sectionProfile(rings: LonLat[][], bearingDeg: number, bufferM: number, line: LonLat[] | null): Promise<ProfilePoint[]> {
    if (!drone) return [];
    const along = line
      ? pointsAlongPath(line, 160)
      : (() => {
          const [top, bottom] = profileLine(rings, bearingDeg, Math.max(10, bufferM));
          return pointsAlong(top, bottom, 90);
        })();
    // Compared with an earlier survey, the ground before is its height, or sea level where it saw the sea.
    const beforeLine = drone.baseline
      ? along.map((a) => drone.baselineGroundAt(a.point[0], a.point[1]))
      : (await drone.beforeHeights(along.map((a) => a.point))).map((z) => (z == null ? null : { z, sea: false }));
    return along.map((a, i) => ({
      distanceM: a.distanceM,
      point: a.point,
      historical: beforeLine[i]?.z ?? null,
      historicalSea: beforeLine[i]?.sea ?? false,
      actual: drone.actualAt(a.point[0], a.point[1]),
    }));
  }

  // The line Measure used by default, for the maps: down the fall line through the area,
  // as long as nobody drew their own and the measurement is current.
  const fallLineKey = current && !drawnLine && area ? `${current.key}|${current.bearingDeg}` : "";
  useEffect(() => {
    if (!drone) return;
    if (!fallLineKey || !current || !area) {
      drone.setFallLine(null);
      return;
    }
    const [top, bottom] = profileLine(area, current.bearingDeg, Math.max(10, current.bufferM));
    drone.setFallLine([top, bottom]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fallLineKey]);

  // A new section line redraws the section (and is kept with the comparison) without measuring again.
  useEffect(() => {
    if (!current || !area || current.sectionKey === drawnKey) return;
    let cancelled = false;
    sectionProfile(area, current.bearingDeg, current.bufferM, drawnLine).then((profile) => {
      if (cancelled) return;
      setResult((prev) => (prev ? { ...prev, profile, sectionLine: drawnLine, sectionKey: drawnKey } : prev));
      if (canEdit && current.drone?.saved) {
        drone?.saveComparison({ ...current.drone.saved, measured_at: new Date().toISOString(), section_line: drawnLine }).catch(() => undefined);
      }
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawnKey, current?.sectionKey, stale]);

  /** `keep`: save the comparison with the survey. Only when someone asked to measure, not on opening the workspace. */
  async function measure({ keep = true }: { keep?: boolean } = {}) {
    if (!area) return;
    setError(null);
    const plan = buildSamplePlan(area);
    setBusy(`Sampling the terrain at ${(plan.inside.length + plan.around.length).toLocaleString("en-US")} points…`);
    try {
      const { z, resolution } = await sampleElevations([...plan.inside, ...plan.around]);
      const toSamples = (points: LonLat[], offset: number) =>
        points.flatMap(([lon, lat], i): Sample[] => (z[offset + i] == null ? [] : [{ lon, lat, z: z[offset + i]! }]));
      const inside = toSamples(plan.inside, 0);
      const around = toSamples(plan.around, plan.inside.length);
      const measurement = measureSiteArea(area, inside, around);
      if (!measurement) throw new Error("The terrain model has no usable data under this area.");

      // A drone survey over the area: the same points on the ground now, compared with the
      // ground before (the terrain model, or an earlier survey), and a section down the slope.
      let measured: DroneMeasure | null = null;
      let droneCoverage: number | null = null;
      if (drone && survey) {
        const all = [...plan.inside, ...plan.around];
        const actual = all.map(([lon, lat]) => drone.actualAt(lon, lat));
        // An earlier survey's sea counts as sea level: the material now in the water is counted
        // from the surface (the seabed under it is unknown, so those gains are a lower bound).
        const beforeGround = baseline ? all.map(([lon, lat]) => drone.baselineGroundAt(lon, lat)) : null;
        const historical = beforeGround ? beforeGround.map((g) => g?.z ?? null) : z;
        const withSea = compareSurfaces(area, plan, historical, actual);
        // The slope, its height and its length describe ground: water is not slope, so they come
        // from what the earlier survey mapped; the volumes and the change count the sea as its surface.
        const onLand = beforeGround ? compareSurfaces(area, plan, beforeGround.map((g) => (g && !g.sea ? g.z : null)), actual) : null;
        const comparison = withSea && onLand ? { ...withSea, original: onLand.original } : withSea;
        const seaInside = beforeGround ? plan.inside.filter((_, i) => beforeGround[i]?.sea && actual[i] != null).length : 0;
        const seaShare = comparison?.paired ? seaInside / comparison.paired : 0;
        droneCoverage = comparison?.coverage ?? plan.inside.filter((_, i) => actual[i] != null && historical[i] != null).length / Math.max(1, plan.inside.length);
        if (comparison && comparison.coverage >= MIN_DRONE_COVERAGE) {
          const heights = (m: SiteMeasurement) => ({ slope_deg: m.landslideSlopeDeg, height_m: m.slopeHeightM, low_m: m.lowElevationM, high_m: m.highElevationM });
          const saved: SavedComparison = {
            area_key: areaKey,
            measured_at: new Date().toISOString(),
            offset_m: survey.survey.vertical_offset_m,
            baseline: baseline
              ? { kind: "survey", survey_id: baseline.survey.id, title: surveyTitle(baseline.survey), offset_m: baseline.survey.vertical_offset_m }
              : { kind: "terrain" },
            original: heights(comparison.original),
            updated: heights(comparison.updated),
            coverage: comparison.coverage,
            max_loss_m: comparison.maxLossM,
            max_gain_m: comparison.maxGainM,
            mean_change_m: comparison.meanChangeM,
            loss_m3: comparison.lossVolumeM3,
            gain_m3: comparison.gainVolumeM3,
            net_m3: comparison.netVolumeM3,
            section_line: drawnLine,
            sea_share: seaShare,
          };
          measured = {
            comparison,
            nowTitle: surveyTitle(survey.survey),
            nowDate: survey.survey.captured_on,
            beforeTitle: baseline ? surveyTitle(baseline.survey) : "terrain model",
            beforeIsSurvey: !!baseline,
            offsetM: survey.survey.vertical_offset_m,
            seaShare,
            saved,
          };
          if (canEdit && keep) {
            drone.saveComparison(saved).catch(() => {
              // The comparison shows either way; keeping it with the survey is a convenience.
            });
          }
        }
      }

      const bearingDeg = measured ? measured.comparison.original.downslopeBearingDeg : measurement.downslopeBearingDeg;
      setBusy(drawnLine ? "Drawing the section along your line…" : "Drawing the section down the slope…");
      // The scarp is looked for down the fall line, whichever line the graph follows.
      const fallProfile = await sectionProfile(area, bearingDeg, plan.bufferM, null);
      const profile = drawnLine ? await sectionProfile(area, bearingDeg, plan.bufferM, drawnLine) : fallProfile;
      setResult({
        key: measureKey,
        measurement,
        proposed: measured ? comparisonFieldValues(measured.comparison) : measurementFieldValues(measurement),
        resolution,
        missing: plan.inside.length + plan.around.length - inside.length - around.length,
        bufferM: plan.bufferM,
        bearingDeg,
        profile,
        sectionLine: drawnLine,
        sectionKey: drawnKey,
        scarp: measured ? scarpSuggestion(area, fallProfile) : null,
        drone: measured,
        droneCoverage,
      });
    } catch (e: any) {
      setError(e?.message ? `Could not measure the terrain: ${e.message}` : "Could not measure the terrain.");
    } finally {
      setBusy(null);
    }
  }

  // In the workspace a measurement is what everything else shows, so it is there
  // on arrival and follows the surveys chosen. Waits for those to load.
  const surveysReady = !!drone && !drone.loading && (!drone.surveys.length || !!survey) && (drone.baselineId == null || !!baseline);
  useEffect(() => {
    if (!auto || !area || !surveysReady || busy || error || current) return;
    void measure({ keep: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, measureKey, surveysReady, !!current, !!busy, !!error]);

  const scarpFt = current?.scarp ? (current.scarp.heightM * FT_PER_M).toFixed(1) : null;
  const guides: Guide[] = useMemo(() => {
    if (!current) return [];
    const { proposed, drone: measured, measurement } = current;
    const ft = (key: MeasurementField, symbol: string) => (proposed[key] ? `${symbol} ${Number(proposed[key]).toLocaleString("en-US")} ft` : undefined);
    const deg = (key: MeasurementField, symbol: string) => (proposed[key] ? `${symbol} ${proposed[key]}°` : undefined);
    return buildGuides({
      before: measured?.comparison.original ?? measurement,
      now: measured?.comparison.updated ?? measurement,
      hasDrone: !!measured,
      scarp: current.scarp,
      text: {
        H: ft("measure_slope_height_ft", "H"),
        A: deg("measure_original_slope_deg", "α"),
        W: ft("measure_landslide_width_ft", "Wd"),
        L: ft("measure_landslide_length_ft", "Ld"),
        B: deg("measure_landslide_slope_deg", "β"),
        S: scarpFt ? `Hs ${scarpFt} ft, suggested` : undefined,
      },
    });
  }, [current, scarpFt]);

  return {
    areas, index, setAreaIndex, area, areaKey, terrain, drone, survey, baseline,
    busy, error, result, stale, current, measure, scarpFt, guides,
  };
}

export type SiteMeasurementState = ReturnType<typeof useSiteMeasurement>;
