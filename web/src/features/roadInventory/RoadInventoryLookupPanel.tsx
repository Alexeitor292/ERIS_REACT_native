import { useState } from "react";

import { lookupRoadSegments, type RoadSegment } from "../../api/roadInventory";

export default function RoadInventoryLookupPanel() {
  const [county, setCounty] = useState("");
  const [route, setRoute] = useState("");
  const [postmile, setPostmile] = useState("");
  const [district, setDistrict] = useState("");
  const [segments, setSegments] = useState<RoadSegment[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runLookup() {
    const pm = Number(postmile);
    if (!county.trim() || !route.trim() || !Number.isFinite(pm)) {
      setError("County, route, and a numeric post mile are required.");
      return;
    }
    setBusy(true);
    setError(null);
    setSegments(null);
    try {
      setSegments(await lookupRoadSegments(county.trim().toUpperCase(), route.trim(), pm, district.trim() || undefined));
    } catch (e: any) {
      setError(e?.message ?? "Road inventory lookup failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4 md:p-5">
      <div>
        <h2 className="font-semibold">Verify authoritative lookup</h2>
        <p className="mt-1 text-sm text-muted">Test how the currently published road inventory resolves an exact county, route, and post mile before relying on it in field workflows.</p>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-[140px_140px_160px_160px_auto] lg:items-end">
        <Field label="County code"><input value={county} onChange={(event) => setCounty(event.target.value)} placeholder="SAC" maxLength={8} className="w-full rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-2 text-sm" /></Field>
        <Field label="Route"><input value={route} onChange={(event) => setRoute(event.target.value)} placeholder="50" className="w-full rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-2 text-sm" /></Field>
        <Field label="Post mile"><input type="number" step="0.001" value={postmile} onChange={(event) => setPostmile(event.target.value)} placeholder="12.5" className="w-full rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-2 text-sm" /></Field>
        <Field label="District"><input value={district} onChange={(event) => setDistrict(event.target.value)} placeholder="Optional" maxLength={4} className="w-full rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-2 text-sm" /></Field>
        <button type="button" onClick={runLookup} disabled={busy} className="rounded-md bg-[var(--brand)] px-4 py-2 text-sm font-semibold text-white hover:brightness-95 disabled:opacity-50">{busy ? "Looking up…" : "Run lookup"}</button>
      </div>

      {error ? <div className="mt-4 rounded-md border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-3 py-2 text-sm text-[var(--bad)]">{error}</div> : null}
      {segments !== null && segments.length === 0 ? <div className="mt-4 rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-3 text-sm text-muted">No matching road segments were returned by the published dataset.</div> : null}

      {segments && segments.length > 0 ? (
        <div className="mt-4 overflow-x-auto rounded-lg border border-[var(--line)]">
          <table className="w-full border-collapse text-xs">
            <thead><tr className="border-b border-[var(--line)] bg-[var(--panel-soft)] text-left font-semibold uppercase tracking-wide text-muted">{["District","County","Route","PM Prefix","Begin PM","End PM","Length mi","Left Lanes","Right Lanes","Left Surface","Right Surface","Median","Median W","Terrain","Speed","ADT","Landmark"].map((label) => <th key={label} className="whitespace-nowrap px-3 py-2">{label}</th>)}</tr></thead>
            <tbody>{segments.map((segment) => <tr key={segment.id} className="border-b border-[var(--line)]/60 last:border-b-0"><td className="px-3 py-2 tabular-nums">{segment.district_code ?? "—"}</td><td className="px-3 py-2">{segment.county_code}</td><td className="px-3 py-2 font-semibold">{segment.route_name}{segment.route_suffix_code ?? ""}</td><td className="px-3 py-2">{segment.pm_prefix_code ?? "—"}</td><td className="px-3 py-2 tabular-nums">{segment.begin_pm}</td><td className="px-3 py-2 tabular-nums">{segment.end_pm}</td><td className="px-3 py-2 tabular-nums">{segment.length_miles ?? "—"}</td><td className="px-3 py-2 tabular-nums">{segment.left_lanes ?? "—"}</td><td className="px-3 py-2 tabular-nums">{segment.right_lanes ?? "—"}</td><td className="px-3 py-2">{segment.left_surface_type ?? "—"}</td><td className="px-3 py-2">{segment.right_surface_type ?? "—"}</td><td className="px-3 py-2">{segment.median_type ?? "—"}</td><td className="px-3 py-2 tabular-nums">{segment.median_width ?? "—"}</td><td className="px-3 py-2">{segment.terrain_code ?? "—"}</td><td className="px-3 py-2 tabular-nums">{segment.design_speed ?? "—"}</td><td className="px-3 py-2 tabular-nums">{segment.adt?.toLocaleString() ?? "—"}</td><td className="max-w-52 truncate px-3 py-2" title={segment.landmark_short_desc ?? undefined}>{segment.landmark_short_desc ?? "—"}</td></tr>)}</tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="grid gap-1.5"><span className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</span>{children}</label>;
}
