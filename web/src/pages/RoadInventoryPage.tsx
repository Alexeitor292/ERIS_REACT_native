import { useEffect, useRef, useState } from "react";
import AppShell from "../ui/AppShell";
import { useAuth } from "../auth/AuthContext";
import {
  getRoadInventoryManifest,
  listRoadInventoryVersions,
  lookupRoadSegments,
  publishRoadInventoryVersion,
  rollbackRoadInventoryVersion,
  uploadRoadInventory,
  type RoadInventoryDataset,
  type RoadInventoryManifest,
  type RoadSegment,
  type UploadResult,
} from "../api/roadInventory";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function fmt(dt: string | null) {
  if (!dt) return "—";
  return new Date(dt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function StatusBadge({ status }: { status: RoadInventoryDataset["status"] }) {
  const map: Record<string, string> = {
    published: "bg-[var(--good)] text-white",
    pending: "bg-[var(--panel-soft)] text-[var(--ink)] border border-[var(--line)]",
    superseded: "bg-[color:color-mix(in_srgb,var(--bad)_15%,transparent)] text-[var(--bad)]",
  };
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-semibold ${map[status] ?? ""}`}>
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Upload section
// ---------------------------------------------------------------------------

function UploadSection({ onUploaded }: { onUploaded: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [tag, setTag] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showWarnings, setShowWarnings] = useState(false);

  async function handleUpload() {
    if (!file) return;
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const r = await uploadRoadInventory(file, tag.trim() || undefined);
      setResult(r);
      setShowWarnings(false);
      onUploaded();
    } catch (e: any) {
      setErr(e.message ?? "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h2 className="text-sm font-semibold mb-3">Upload New Dataset</h2>
      <div className="flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-xs text-muted mb-1">Excel file (.xlsx)</label>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="text-sm"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setFile(f);
              setResult(null);
              setErr(null);
            }}
          />
        </div>
        <div>
          <label className="block text-xs text-muted mb-1">Version tag (optional)</label>
          <input
            type="text"
            placeholder="e.g. 2025-06-08"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            className="rounded border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-1.5 text-sm w-40"
          />
        </div>
        <button
          disabled={!file || busy}
          onClick={handleUpload}
          className="rounded bg-[var(--brand)] px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40 hover:brightness-110"
        >
          {busy ? "Uploading…" : "Upload"}
        </button>
      </div>

      {err && (
        <p className="mt-3 text-sm text-[var(--bad)]">{err}</p>
      )}

      {result && (
        <div className="mt-4 rounded border border-[var(--line)] bg-[var(--panel-soft)] p-4 text-sm space-y-1">
          <div className="font-semibold text-[var(--good)] mb-2">Upload complete</div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 max-w-sm">
            <span className="text-muted">Version ID</span><span>{result.version_id}</span>
            <span className="text-muted">Tag</span><span>{result.version_tag}</span>
            <span className="text-muted">Rows imported</span><span>{result.row_count.toLocaleString()}</span>
            <span className="text-muted">Rows skipped</span><span>{result.skipped_count}</span>
            <span className="text-muted">Status</span><span><StatusBadge status={result.status as RoadInventoryDataset["status"]} /></span>
          </div>
          {result.warnings.length > 0 && (
            <div className="mt-3">
              <button
                className="text-xs underline text-muted"
                onClick={() => setShowWarnings((v) => !v)}
              >
                {showWarnings ? "Hide" : "Show"} {result.warnings.length} warning(s)
              </button>
              {showWarnings && (
                <pre className="mt-2 max-h-48 overflow-auto rounded border border-[var(--line)] bg-[var(--bg)] p-2 text-xs text-[var(--bad)]">
                  {result.warnings.join("\n")}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Published manifest banner
// ---------------------------------------------------------------------------

function ManifestBanner() {
  const [manifest, setManifest] = useState<RoadInventoryManifest | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    getRoadInventoryManifest()
      .then(setManifest)
      .catch(() => setMissing(true));
  }, []);

  if (missing) {
    return (
      <p className="text-sm text-muted italic">No published dataset. Upload and publish a version to make it active.</p>
    );
  }
  if (!manifest) return <p className="text-sm text-muted">Loading…</p>;

  return (
    <div className="rounded border border-[var(--good)] bg-[color:color-mix(in_srgb,var(--good)_8%,transparent)] px-4 py-3 text-sm">
      <span className="font-semibold text-[var(--good)]">Published:</span>{" "}
      <span className="font-medium">{manifest.version_tag}</span>
      <span className="text-muted ml-4">
        {manifest.row_count.toLocaleString()} segments · extract {fmt(manifest.extract_date)} · published {fmt(manifest.published_at)}
      </span>
      {!manifest.package.available && (
        <span className="ml-4 text-xs text-muted italic">(mobile package not yet generated)</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Versions table
// ---------------------------------------------------------------------------

function VersionsTable({
  versions,
  busy,
  onPublish,
  onRollback,
}: {
  versions: RoadInventoryDataset[];
  busy: number | null;
  onPublish: (id: number) => void;
  onRollback: (id: number) => void;
}) {
  if (versions.length === 0) {
    return <p className="text-sm text-muted py-4">No datasets uploaded yet.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-[var(--line)] text-left text-xs text-muted">
            <th className="py-2 pr-4 font-medium">ID</th>
            <th className="py-2 pr-4 font-medium">Tag</th>
            <th className="py-2 pr-4 font-medium">File</th>
            <th className="py-2 pr-4 font-medium">Rows</th>
            <th className="py-2 pr-4 font-medium">Skip</th>
            <th className="py-2 pr-4 font-medium">Status</th>
            <th className="py-2 pr-4 font-medium">Extract</th>
            <th className="py-2 pr-4 font-medium">Uploaded</th>
            <th className="py-2 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {versions.map((v) => (
            <tr key={v.id} className="border-b border-[var(--line)] hover:bg-[var(--panel-soft)]">
              <td className="py-2 pr-4 tabular-nums text-muted">{v.id}</td>
              <td className="py-2 pr-4 font-medium">{v.version_tag}</td>
              <td className="py-2 pr-4 max-w-[200px] truncate text-muted" title={v.upload_filename}>
                {v.upload_filename}
              </td>
              <td className="py-2 pr-4 tabular-nums">{v.row_count.toLocaleString()}</td>
              <td className="py-2 pr-4 tabular-nums text-muted">{v.skipped_count}</td>
              <td className="py-2 pr-4"><StatusBadge status={v.status} /></td>
              <td className="py-2 pr-4 text-muted">{fmt(v.extract_date)}</td>
              <td className="py-2 pr-4 text-muted">{fmt(v.created_at)}</td>
              <td className="py-2">
                <div className="flex gap-2">
                  {(v.status === "pending" || v.status === "superseded") && (
                    <button
                      disabled={busy === v.id}
                      onClick={() => onPublish(v.id)}
                      className="rounded border border-[var(--good)] px-2 py-0.5 text-xs text-[var(--good)] hover:bg-[color:color-mix(in_srgb,var(--good)_10%,transparent)] disabled:opacity-40"
                    >
                      {busy === v.id ? "…" : "Publish"}
                    </button>
                  )}
                  {v.status === "superseded" && (
                    <button
                      disabled={busy === v.id}
                      onClick={() => onRollback(v.id)}
                      className="rounded border border-[var(--line)] px-2 py-0.5 text-xs text-muted hover:bg-[var(--panel-soft)] disabled:opacity-40"
                    >
                      {busy === v.id ? "…" : "Rollback"}
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lookup tester
// ---------------------------------------------------------------------------

function LookupTester() {
  const [county, setCounty] = useState("");
  const [route, setRoute] = useState("");
  const [postmile, setPostmile] = useState("");
  const [district, setDistrict] = useState("");
  const [busy, setBusy] = useState(false);
  const [segments, setSegments] = useState<RoadSegment[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function handleLookup() {
    const pm = parseFloat(postmile);
    if (!county.trim() || !route.trim() || isNaN(pm)) {
      setErr("County, route, and a numeric postmile are required.");
      return;
    }
    setBusy(true);
    setErr(null);
    setSegments(null);
    try {
      const segs = await lookupRoadSegments(
        county.trim().toUpperCase(),
        route.trim(),
        pm,
        district.trim() || undefined,
      );
      setSegments(segs);
    } catch (e: any) {
      setErr(e.message ?? "Lookup failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h2 className="text-sm font-semibold mb-3">Lookup Tester</h2>
      <div className="flex flex-wrap gap-3 items-end mb-4">
        <div>
          <label className="block text-xs text-muted mb-1">County code</label>
          <input
            type="text"
            placeholder="SAC"
            value={county}
            maxLength={8}
            onChange={(e) => setCounty(e.target.value)}
            className="rounded border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-1.5 text-sm w-24"
          />
        </div>
        <div>
          <label className="block text-xs text-muted mb-1">Route</label>
          <input
            type="text"
            placeholder="50"
            value={route}
            onChange={(e) => setRoute(e.target.value)}
            className="rounded border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-1.5 text-sm w-24"
          />
        </div>
        <div>
          <label className="block text-xs text-muted mb-1">Postmile</label>
          <input
            type="number"
            step="0.001"
            placeholder="12.5"
            value={postmile}
            onChange={(e) => setPostmile(e.target.value)}
            className="rounded border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-1.5 text-sm w-28"
          />
        </div>
        <div>
          <label className="block text-xs text-muted mb-1">District (optional)</label>
          <input
            type="text"
            placeholder="03"
            value={district}
            maxLength={4}
            onChange={(e) => setDistrict(e.target.value)}
            className="rounded border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-1.5 text-sm w-24"
          />
        </div>
        <button
          disabled={busy}
          onClick={handleLookup}
          className="rounded bg-[var(--brand)] px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40 hover:brightness-110"
        >
          {busy ? "Looking up…" : "Lookup"}
        </button>
      </div>

      {err && <p className="text-sm text-[var(--bad)] mb-3">{err}</p>}

      {segments !== null && segments.length === 0 && (
        <p className="text-sm text-muted">No matching segments found.</p>
      )}

      {segments !== null && segments.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-[var(--line)] text-left text-muted">
                {[
                  "Dist", "County", "Route", "PM prefix", "Begin PM", "End PM",
                  "Len mi", "L lanes", "R lanes", "L surf", "R surf",
                  "Median", "Med W", "Terrain", "Speed", "ADT", "Landmark",
                ].map((h) => (
                  <th key={h} className="py-1.5 pr-3 font-medium whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {segments.map((s) => (
                <tr key={s.id} className="border-b border-[var(--line)] hover:bg-[var(--panel-soft)]">
                  <td className="py-1.5 pr-3 tabular-nums">{s.district_code ?? "—"}</td>
                  <td className="py-1.5 pr-3">{s.county_code}</td>
                  <td className="py-1.5 pr-3 font-medium">{s.route_name}{s.route_suffix_code ?? ""}</td>
                  <td className="py-1.5 pr-3 text-muted">{s.pm_prefix_code ?? "—"}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{s.begin_pm}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{s.end_pm}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{s.length_miles ?? "—"}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{s.left_lanes ?? "—"}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{s.right_lanes ?? "—"}</td>
                  <td className="py-1.5 pr-3">{s.left_surface_type ?? "—"}</td>
                  <td className="py-1.5 pr-3">{s.right_surface_type ?? "—"}</td>
                  <td className="py-1.5 pr-3">{s.median_type ?? "—"}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{s.median_width ?? "—"}</td>
                  <td className="py-1.5 pr-3">{s.terrain_code ?? "—"}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{s.design_speed ?? "—"}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{s.adt?.toLocaleString() ?? "—"}</td>
                  <td className="py-1.5 pr-3 max-w-[160px] truncate" title={s.landmark_short_desc ?? undefined}>
                    {s.landmark_short_desc ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function RoadInventoryPage() {
  const { me } = useAuth();
  const isAdmin = !!me?.roles?.includes("ADMIN");

  const [versions, setVersions] = useState<RoadInventoryDataset[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [manifestKey, setManifestKey] = useState(0);

  async function loadVersions() {
    setLoadErr(null);
    try {
      const v = await listRoadInventoryVersions();
      setVersions(v);
    } catch (e: any) {
      setLoadErr(e.message ?? "Failed to load versions");
    }
  }

  useEffect(() => {
    if (isAdmin) loadVersions();
  }, [isAdmin]);

  async function handlePublish(id: number) {
    setBusyId(id);
    setActionErr(null);
    try {
      await publishRoadInventoryVersion(id);
      setManifestKey((k) => k + 1);
      await loadVersions();
    } catch (e: any) {
      setActionErr(e.message ?? "Publish failed");
    } finally {
      setBusyId(null);
    }
  }

  async function handleRollback(id: number) {
    setBusyId(id);
    setActionErr(null);
    try {
      await rollbackRoadInventoryVersion(id);
      setManifestKey((k) => k + 1);
      await loadVersions();
    } catch (e: any) {
      setActionErr(e.message ?? "Rollback failed");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <AppShell title="Road Inventory">
      {!isAdmin ? (
        <div className="p-6 text-sm text-[var(--bad)]">
          Admin access required to manage road inventory datasets.
        </div>
      ) : (
        <div className="p-6 space-y-8">

          {/* Published version banner */}
          <section>
            <h2 className="text-sm font-semibold mb-2">Current Published Version</h2>
            <ManifestBanner key={manifestKey} />
          </section>

          <hr className="border-[var(--line)]" />

          {/* Upload */}
          <section>
            <UploadSection onUploaded={loadVersions} />
          </section>

          <hr className="border-[var(--line)]" />

          {/* Versions list */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold">Dataset Versions</h2>
              <button
                onClick={loadVersions}
                className="text-xs text-muted underline hover:text-[var(--ink)]"
              >
                Refresh
              </button>
            </div>
            {loadErr && <p className="text-sm text-[var(--bad)] mb-2">{loadErr}</p>}
            {actionErr && <p className="text-sm text-[var(--bad)] mb-2">{actionErr}</p>}
            <VersionsTable
              versions={versions}
              busy={busyId}
              onPublish={handlePublish}
              onRollback={handleRollback}
            />
          </section>

          <hr className="border-[var(--line)]" />

          {/* Lookup tester */}
          <section>
            <LookupTester />
          </section>

        </div>
      )}
    </AppShell>
  );
}
