import { useMemo, useState } from "react";
import { Check, Loader2, Route as RouteIcon, TriangleAlert } from "lucide-react";

import { api } from "../../api/client";
import {
  buildRoadModel,
  FT_PER_M,
  measureEncroachment,
  offsetLine,
  roadEdges,
  roadOutlines,
  roadwayFieldValues,
  type CenterLine,
  type CrossSection,
  type Encroachment,
  type LonLat,
  type RoadModel,
} from "./roadwayModel";

export type RoadIdentity = { county: string | null; route: string; postMile: string; district: string };
type RoadwayField = "measure_roadway_length_ft" | "measure_roadway_width_ft";

type Context = {
  cross_section: (CrossSection & { begin_pm: number; end_pm: number; extract_date: string | null }) | null;
  centerline: { source: string; provenance: string | null; lines: CenterLine[] };
  centerline_error: string | null;
};

type Result = { areaKey: string; context: Context; road: RoadModel; encroachment: Encroachment | null };

const fmtFt = (m: number, digits = 0) => `${(m * FT_PER_M).toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits })} ft`;

/**
 * Rebuilds the roadway from the highway centerline and the road inventory, and
 * measures where the slide outline covers it: Lr along the road, Wr across it.
 */
export default function RoadwayEncroachment({
  area,
  areaKey,
  road,
  values,
  canEdit,
  onProposal,
  onFill,
}: {
  area: LonLat[][];
  areaKey: string;
  road: RoadIdentity;
  values: Record<RoadwayField, string>;
  canEdit: boolean;
  onProposal: (proposal: Partial<Record<RoadwayField, string>>) => void;
  onFill: (patch: Partial<Record<RoadwayField, string>>) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [filled, setFilled] = useState(false);
  const stale = result != null && result.areaKey !== areaKey;
  const postMile = Number.parseFloat(road.postMile.replace(/[^\d.]/g, ""));
  const missing = !road.county || !road.route || !Number.isFinite(postMile);
  const routeLabel = road.route.replace(/^0+(?=\d)/, "");

  async function measure() {
    setBusy(true);
    setError(null);
    setFilled(false);
    try {
      const lons = area[0].map((p) => p[0]);
      const lats = area[0].map((p) => p[1]);
      // Room for the centerline to run past the slide on both ends (~150 m).
      const pad = 0.0017;
      const bbox = [Math.min(...lons) - pad, Math.min(...lats) - pad, Math.max(...lons) + pad, Math.max(...lats) + pad];
      if (bbox[2] - bbox[0] > 0.05 || bbox[3] - bbox[1] > 0.05) {
        throw new Error("The area is larger than a site. Draw the slide itself to measure the roadway.");
      }
      const params = new URLSearchParams({
        county: road.county!,
        route: road.route,
        postmile: String(postMile),
        bbox: bbox.map((v) => v.toFixed(6)).join(","),
      });
      if (road.district) params.set("district", road.district.padStart(2, "0"));
      const context = await api<Context>(`/road-inventory/roadway-context?${params}`);
      if (!context.centerline.lines.length) {
        throw new Error(context.centerline_error ?? `No Route ${routeLabel} centerline near this area.`);
      }
      const model = buildRoadModel(context.cross_section, context.centerline.lines);
      const encroachment = measureEncroachment(area, model);
      setResult({ areaKey, context, road: model, encroachment });
      onProposal(encroachment ? roadwayFieldValues(encroachment) : {});
    } catch (e: any) {
      setError(e?.message ?? "Could not measure the roadway.");
      onProposal({});
    } finally {
      setBusy(false);
    }
  }

  const live = result && !stale ? result : null;
  const e = live?.encroachment ?? null;
  const proposal = e ? roadwayFieldValues(e) : null;
  const differs = proposal ? (Object.keys(proposal) as RoadwayField[]).filter((k) => Number(values[k]) !== Number(proposal[k]) || !values[k]?.trim()) : [];
  const section = live?.context.cross_section ?? null;

  return (
    <div className="rounded-xl border border-[color:color-mix(in_oklab,var(--brand)_40%,var(--line))] bg-[color:color-mix(in_oklab,var(--brand)_5%,var(--panel))] p-3">
      <div className="flex flex-wrap items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--brand)] text-white" aria-hidden>
          <RouteIcon size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">Roadway encroachment</div>
          <p className="text-xs text-muted">
            {missing
              ? "Fill the county, route and postmile in the report header to measure how far the slide reaches onto the road."
              : `Rebuilds Route ${routeLabel} from its centerline and the road inventory, and measures where the slide covers it.`}
          </p>
        </div>
        {!missing ? (
          <button
            type="button"
            onClick={measure}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--brand)] px-3 py-1.5 text-xs font-semibold text-white hover:brightness-110 disabled:opacity-60"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <RouteIcon size={14} />}
            {result ? "Measure again" : "Measure road"}
          </button>
        ) : null}
      </div>

      {error ? <p className="mt-2 text-xs text-[var(--bad)]">{error}</p> : null}
      {stale ? <p className="mt-2 text-xs text-[var(--warn-text)]">The area changed since it was measured. Measure it again.</p> : null}

      {live ? (
        <>
          <RoadSketch area={area} road={live.road} encroachment={e} />
          {e ? (
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
              <Metric label="Length on the road" value={fmtFt(e.lengthM)} note="Along the centerline" />
              <Metric
                label="Width on the road"
                value={fmtFt(e.widthM, 1)}
                note={`${Math.round((e.widthM / e.roadwayWidthM) * 100)}% of the ${fmtFt(e.roadwayWidthM)} roadway`}
              />
              <Metric
                label="Reaches"
                value={e.shoulderOnly ? "Shoulder only" : `${e.lanesHit} of ${e.lanesTotal} lanes`}
                note={e.bandsHit.join(", ")}
              />
              <Metric
                label="Road"
                value={section ? crossSectionSummary(section) : "Assumed"}
                note={
                  section
                    ? `Inventory PM ${section.begin_pm}–${section.end_pm}${section.extract_date ? ` · ${section.extract_date}` : ""}`
                    : "No inventory row"
                }
              />
            </dl>
          ) : (
            <p className="mt-2 text-xs font-medium text-[var(--good)]">The slide does not reach the roadway.</p>
          )}
          {live.road.notes.length ? (
            <ul className={`mt-2 space-y-0.5 text-[11px] ${live.road.assumed ? "text-[var(--warn-text)]" : "text-muted"}`}>
              {live.road.notes.map((note) => (
                <li key={note} className="flex gap-1">
                  {live.road.assumed ? <TriangleAlert size={12} className="mt-0.5 shrink-0" aria-hidden /> : null}
                  {note}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="mt-1 text-[11px] text-muted">Centerline: {live.context.centerline.provenance ?? live.context.centerline.source}</p>
          {e && canEdit ? (
            differs.length ? (
              <button
                type="button"
                onClick={() => {
                  onFill(Object.fromEntries(differs.map((k) => [k, proposal![k]])));
                  setFilled(true);
                }}
                className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-[var(--brand)] px-3 py-1.5 text-xs font-semibold text-white hover:brightness-110"
              >
                <Check size={14} />
                <span>Fill L<sub>r</sub> and W<sub>r</sub></span>
              </button>
            ) : (
              <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-[var(--good)]">
                <Check size={14} />
                {filled ? "Filled. Save the draft to keep them." : "The fields match the roadway measurement."}
              </p>
            )
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function crossSectionSummary(s: CrossSection): string {
  const lanes = (s.left.lanes ?? 0) + (s.right.lanes ?? 0);
  const tw = (s.left.traveled_way_ft ?? 0) + (s.right.traveled_way_ft ?? 0);
  const laneWidth = lanes && tw ? `${Math.round((tw / lanes) * 10) / 10} ft lanes` : "lane width not recorded";
  return `${lanes || "?"} lanes · ${laneWidth}`;
}

function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
      <dd className="text-[11px] text-muted">{note}</dd>
    </div>
  );
}

/**
 * Plan view, turned so the road runs across: the rebuilt roadway (shoulders, lanes,
 * lane lines, centre line), the slide outline, and where it covers the road.
 */
function RoadSketch({ area, road, encroachment }: { area: LonLat[][]; road: RoadModel; encroachment: Encroachment | null }) {
  const view = useMemo(() => {
    const ring = area[0];
    const lon0 = ring.reduce((s, p) => s + p[0], 0) / ring.length;
    const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
    const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
    const ky = 110_540;
    // Road direction at the slide: the nearest segment of the first centerline.
    const line = road.carriageways[0]?.line.coordinates ?? [];
    let angle = 0;
    let best = Infinity;
    for (let i = 1; i < line.length; i += 1) {
      const mx = ((line[i][0] + line[i - 1][0]) / 2 - lon0) * kx;
      const my = ((line[i][1] + line[i - 1][1]) / 2 - lat0) * ky;
      const d = Math.hypot(mx, my);
      if (d < best) {
        best = d;
        angle = Math.atan2((line[i][1] - line[i - 1][1]) * ky, (line[i][0] - line[i - 1][0]) * kx);
      }
    }
    const cos = Math.cos(-angle);
    const sin = Math.sin(-angle);
    // Metres, turned so the road runs left to right; SVG y grows downwards.
    const to = ([lon, lat]: LonLat): [number, number] => {
      const x = (lon - lon0) * kx;
      const y = (lat - lat0) * ky;
      return [x * cos - y * sin, -(x * sin + y * cos)];
    };
    const pts = ring.map(to);
    const outline = road.carriageways.flatMap((c) => c.bands.map((b) => Math.max(Math.abs(b.from), Math.abs(b.to))));
    const halfRoad = Math.max(8, ...outline);
    const xs = pts.map((p) => p[0]);
    const ys = [...pts.map((p) => p[1]), -halfRoad, halfRoad];
    const pad = 8;
    const box = [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
    const path = (coords: LonLat[]) => coords.map((c, i) => `${i ? "L" : "M"}${to(c)[0].toFixed(2)},${to(c)[1].toFixed(2)}`).join("");
    return { to, box, path, northAngle: (-angle * 180) / Math.PI };
  }, [area, road]);

  const [x0, y0, x1, y1] = view.box;
  const width = x1 - x0;
  const height = y1 - y0;
  const stroke = Math.max(width, height) / 400;
  return (
    <figure className="mt-3 overflow-hidden rounded-lg border border-[var(--line)] bg-[color:color-mix(in_oklab,var(--line)_35%,var(--panel))]">
      <svg viewBox={`${x0} ${y0} ${width} ${height}`} className="block h-56 w-full" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Plan view of the slide over the rebuilt roadway">
        {roadOutlines(road).map((outline, i) => (
          <path key={`o${i}`} d={`${view.path(outline)}Z`} fill="#6b7280" fillOpacity={0.55} />
        ))}
        {road.carriageways.map((c, i) =>
          c.bands
            .filter((b) => b.kind === "lane")
            .map((b, j) => (
              <path
                key={`l${i}-${j}`}
                d={`${view.path(offsetLine(c.line.coordinates, b.from))}${view.path(offsetLine(c.line.coordinates, b.to).reverse()).replace(/^M/, "L")}Z`}
                fill="#374151"
                fillOpacity={0.85}
              />
            )),
        )}
        {roadEdges(road).map((edge, i) => (
          <path
            key={`e${i}`}
            d={view.path(edge.path)}
            fill="none"
            stroke={edge.kind === "centre" ? "#facc15" : "#ffffff"}
            strokeWidth={edge.kind === "edge" ? stroke * 1.4 : stroke}
            strokeDasharray={edge.kind === "lane" ? `${stroke * 8} ${stroke * 8}` : undefined}
            opacity={0.9}
          />
        ))}
        {encroachment?.cells.map((cell, i) => {
          const [x, y] = view.to(cell);
          const s = Math.max(encroachment.spacingM, stroke * 2);
          return <rect key={`c${i}`} x={x - s / 2} y={y - s / 2} width={s} height={s} fill="#dc2626" fillOpacity={0.55} />;
        })}
        {area.map((ring, i) => (
          <path key={`a${i}`} d={`${view.path(ring)}Z`} fill="#dc2626" fillOpacity={0.12} stroke="#dc2626" strokeWidth={stroke * 1.6} strokeDasharray={`${stroke * 6} ${stroke * 3}`} />
        ))}
        <g transform={`translate(${x1 - width * 0.06} ${y0 + height * 0.14}) rotate(${view.northAngle})`}>
          <path d={`M0,${-height * 0.07} L${height * 0.025},${height * 0.03} L0,${height * 0.01} L${-height * 0.025},${height * 0.03}Z`} fill="#111827" stroke="#ffffff" strokeWidth={stroke} />
        </g>
      </svg>
      <figcaption className="flex flex-wrap gap-x-3 gap-y-1 px-2 py-1.5 text-[11px] text-muted">
        <span className="inline-flex items-center gap-1"><i className="inline-block h-2.5 w-3 rounded-sm bg-[#374151]" /> Lanes</span>
        <span className="inline-flex items-center gap-1"><i className="inline-block h-2.5 w-3 rounded-sm bg-[#6b7280]/60" /> Shoulders</span>
        <span className="inline-flex items-center gap-1"><i className="inline-block h-2.5 w-3 rounded-sm bg-[#dc2626]/60" /> Slide on the road</span>
        <span className="ml-auto">North arrow top right · road turned to run across</span>
      </figcaption>
    </figure>
  );
}
