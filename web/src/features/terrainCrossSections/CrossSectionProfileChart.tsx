import { useMemo, useState, type PointerEvent } from "react";

import type { CrossSectionProfile } from "./terrainCrossSectionModel";
import {
  feetFromMeters,
  formatElevation,
  formatHorizontalDistance,
} from "./terrainCrossSectionModel";

const WIDTH = 1000;
const HEIGHT = 300;
const MARGIN = { left: 66, right: 22, top: 24, bottom: 48 };

export default function CrossSectionProfileChart({
  profile,
  controlDistances,
  metric,
  onHoverSample,
}: {
  profile: CrossSectionProfile;
  controlDistances: number[];
  metric: boolean;
  onHoverSample: (sampleIndex: number | null) => void;
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const plotWidth = WIDTH - MARGIN.left - MARGIN.right;
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const maxDistance = Math.max(profile.stats.total_distance_m, 1);
  const rawMin = profile.stats.min_elevation_m;
  const rawMax = profile.stats.max_elevation_m;
  const elevationPadding = Math.max((rawMax - rawMin) * 0.12, 3);
  const minElevation = rawMin - elevationPadding;
  const maxElevation = rawMax + elevationPadding;
  const elevationSpan = Math.max(maxElevation - minElevation, 1);

  const xForDistance = (distanceM: number) => MARGIN.left + distanceM / maxDistance * plotWidth;
  const yForElevation = (elevationM: number) => MARGIN.top + (maxElevation - elevationM) / elevationSpan * plotHeight;

  const linePoints = useMemo(
    () => profile.samples.map((sample) => `${xForDistance(sample.distance_m)},${yForElevation(sample.elevation_m)}`).join(" "),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [profile, metric],
  );

  const areaPoints = `${MARGIN.left},${MARGIN.top + plotHeight} ${linePoints} ${MARGIN.left + plotWidth},${MARGIN.top + plotHeight}`;
  const hovered = hoverIndex == null ? null : profile.samples[hoverIndex] ?? null;

  const horizontalTicks = Array.from({ length: 6 }, (_, index) => maxDistance * index / 5);
  const verticalTicks = Array.from({ length: 5 }, (_, index) => minElevation + elevationSpan * index / 4).reverse();

  function updateHover(event: PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const svgX = (event.clientX - rect.left) / Math.max(rect.width, 1) * WIDTH;
    const clamped = Math.min(MARGIN.left + plotWidth, Math.max(MARGIN.left, svgX));
    const targetDistance = (clamped - MARGIN.left) / plotWidth * maxDistance;

    let bestIndex = 0;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const sample of profile.samples) {
      const delta = Math.abs(sample.distance_m - targetDistance);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestIndex = sample.index;
      }
    }
    if (bestIndex !== hoverIndex) {
      setHoverIndex(bestIndex);
      onHoverSample(bestIndex);
    }
  }

  function clearHover() {
    setHoverIndex(null);
    onHoverSample(null);
  }

  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-3">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">DEM cross-section profile</div>
          <div className="mt-0.5 text-xs text-muted">Move across the profile to identify the corresponding sampled terrain point in the 3D scene.</div>
        </div>
        {hovered ? (
          <div className="rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-2 text-right text-xs tabular-nums">
            <div className="font-semibold">{formatHorizontalDistance(hovered.distance_m, metric)}</div>
            <div className="text-muted">Elevation {formatElevation(hovered.elevation_m, metric)}</div>
            <div className="text-muted">{hovered.latitude.toFixed(6)}, {hovered.longitude.toFixed(6)}</div>
            {hovered.grade_percent != null ? <div className="text-muted">Segment grade {hovered.grade_percent.toFixed(1)}%</div> : null}
          </div>
        ) : null}
      </div>

      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="min-w-[520px] w-full select-none"
          role="img"
          aria-label="Elevation profile along the selected cross-section path"
          onPointerMove={updateHover}
          onPointerLeave={clearHover}
        >
          <rect x={MARGIN.left} y={MARGIN.top} width={plotWidth} height={plotHeight} fill="var(--panel-soft)" rx="8" />

          {verticalTicks.map((elevation, index) => {
            const y = yForElevation(elevation);
            const display = metric ? elevation : feetFromMeters(elevation);
            return (
              <g key={`y-${index}`}>
                <line x1={MARGIN.left} y1={y} x2={MARGIN.left + plotWidth} y2={y} stroke="var(--line)" strokeWidth="1" />
                <text x={MARGIN.left - 8} y={y + 4} textAnchor="end" fontSize="11" fill="var(--muted)">{display.toFixed(0)}</text>
              </g>
            );
          })}

          {horizontalTicks.map((distance, index) => {
            const x = xForDistance(distance);
            const display = metric
              ? (maxDistance >= 1000 ? distance / 1000 : distance)
              : (maxDistance >= 1609.344 ? distance / 1609.344 : feetFromMeters(distance));
            return (
              <g key={`x-${index}`}>
                <line x1={x} y1={MARGIN.top} x2={x} y2={MARGIN.top + plotHeight} stroke="var(--line)" strokeWidth="1" />
                <text x={x} y={MARGIN.top + plotHeight + 20} textAnchor="middle" fontSize="11" fill="var(--muted)">{display.toFixed(index === 0 ? 0 : 1)}</text>
              </g>
            );
          })}

          <polygon points={areaPoints} fill="color-mix(in oklab, var(--brand) 14%, transparent)" />
          <polyline points={linePoints} fill="none" stroke="var(--brand)" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />

          {controlDistances.map((distance, index) => {
            const x = xForDistance(distance);
            return (
              <g key={`control-${index}`}>
                <line x1={x} y1={MARGIN.top} x2={x} y2={MARGIN.top + plotHeight} stroke="var(--ink)" strokeOpacity="0.45" strokeDasharray="5 5" />
                <circle cx={x} cy={MARGIN.top + plotHeight} r="5" fill="var(--ink)" />
                <text x={x} y={MARGIN.top + plotHeight - 8} textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--ink)">P{index + 1}</text>
              </g>
            );
          })}

          {hovered ? (
            <g pointerEvents="none">
              <line x1={xForDistance(hovered.distance_m)} y1={MARGIN.top} x2={xForDistance(hovered.distance_m)} y2={MARGIN.top + plotHeight} stroke="var(--bad)" strokeWidth="1.5" />
              <circle cx={xForDistance(hovered.distance_m)} cy={yForElevation(hovered.elevation_m)} r="6" fill="var(--bad)" stroke="white" strokeWidth="2" />
            </g>
          ) : null}

          <text x={MARGIN.left + plotWidth / 2} y={HEIGHT - 8} textAnchor="middle" fontSize="12" fontWeight="600" fill="var(--ink)">
            Distance along cross section ({metric ? (maxDistance >= 1000 ? "km" : "m") : (maxDistance >= 1609.344 ? "mi" : "ft")})
          </text>
          <text transform={`translate(16 ${MARGIN.top + plotHeight / 2}) rotate(-90)`} textAnchor="middle" fontSize="12" fontWeight="600" fill="var(--ink)">
            Elevation ({metric ? "m" : "ft"})
          </text>
        </svg>
      </div>
    </div>
  );
}
