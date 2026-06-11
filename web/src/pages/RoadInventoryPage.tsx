import { useEffect, useRef, useState } from "react";
import AppShell from "../ui/AppShell";
import { useAuth } from "../auth/AuthContext";
import {
  createRoadInventoryImportJob,
  generateRoadInventoryPackage,
  getRoadInventoryImportJob,
  getRoadInventoryManifest,
  listRoadInventoryImportJobs,
  listRoadInventoryVersions,
  lookupRoadSegments,
  publishRoadInventoryVersion,
  rollbackRoadInventoryVersion,
  type RoadInventoryDataset,
  type RoadInventoryImportJob,
  type RoadInventoryManifest,
  type RoadSegment,
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

function JobStatusBadge({ status }: { status: RoadInventoryImportJob["status"] }) {
  const map: Record<string, string> = {
    queued: "bg-[var(--panel-soft)] text-[var(--ink)] border border-[var(--line)]",
    processing: "bg-[color:color-mix(in_srgb,var(--brand)_15%,transparent)] text-[var(--brand)]",
    succeeded: "bg-[var(--good)] text-white",
    failed: "bg-[var(--bad)] text-white",
  };
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-semibold ${map[status] ?? ""}`}>
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Job progress card
// ---------------------------------------------------------------------------

function JobProgressCard({ job }: { job: RoadInventoryImportJob }) {
  const isActive = job.status === "queued" || job.status === "processing";
  const isSuccess = job.status === "succeeded";
  const isFailed = job.status === "failed";

  return (
    <div
      className={`rounded border p-4 text-sm space-y-2 ${
        isFailed
          ? "border-[var(--bad)] bg-[color:color-mix(in_srgb,var(--bad)_8%,transparent)]"
          : isSuccess
          ? "border-[var(--good)] bg-[color:color-mix(in_srgb,var(--good)_8%,transparent)]"
          : "border-[var(--line)] bg-[var(--panel-soft)]"
      }`}
    >
      <div className="flex items-center gap-3">
        {isActive && (
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-[var(--brand)] animate-pulse shrink-0" />
        )}
        <span className="font-semibold">
          {isSuccess
            ? "Import complete"
            : isFailed
            ? "Import failed"
            : "Import in progress…"}
        </span>
        <span className="text-xs text-muted ml-auto font-mono">{job.stage}</span>
      </div>

      {job.message && <p className="text-xs text-muted">{job.message}</p>}

      {isSuccess && (
        <>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 max-w-xs pt-1">
            <span className="text-muted">Dataset ID</span>
            <span>{job.dataset_version_id}</span>
            <span className="text-muted">Rows imported</span>
            <span>{job.row_count.toLocaleString()}</span>
            <span className="text-muted">Rows skipped</span>
            <span>{job.skipped_count}</span>
          </div>
          <p className="text-xs font-medium text-[var(--good)]">
            Dataset is pending — click Publish in the versions table to make it active.
          </p>
          {job.warnings.length > 0 && (
            <details>
              <summary className="text-xs cursor-pointer text-muted">
                {job.warnings.length} warning(s)
              </summary>
              <pre className="mt-1 max-h-32 overflow-auto rounded border border-[var(--line)] bg-[var(--bg)] p-2 text-xs">
                {job.warnings.join("\n")}
              </pre>
            </details>
          )}
        </>
      )}

      {isFailed && job.error_message && (
        <pre className="mt-1 max-h-32 overflow-auto rounded border border-[var(--bad)] bg-[var(--bg)] p-2 text-xs text-[var(--bad)]">
          {job.error_message}
        </pre>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Upload section (async — calls POST /import-jobs, polls for progress)
// ---------------------------------------------------------------------------

function UploadSection({
  onJobCreated,
  onJobSucceeded,
}: {
  onJobCreated: () => void;
  onJobSucceeded: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [tag, setTag] = useState("");
  const [busy, setBusy] = useState(false);
  const [currentJob, setCurrentJob] = useState<RoadInventoryImportJob | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  function startPolling(jobUuid: string) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const updated = await getRoadInventoryImportJob(jobUuid);
        setCurrentJob(updated);
        if (updated.status === "succeeded" || updated.status === "failed") {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          if (updated.status === "succeeded") {
            onJobSucceeded();
          }
        }
      } catch {
        // ignore transient poll errors
      }
    }, 2000);
  }

  async function handleUpload() {
    if (!file) return;
    setBusy(true);
    setErr(null);
    setCurrentJob(null);
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    try {
      const job = await createRoadInventoryImportJob(file, tag.trim() || undefined);
      setCurrentJob(job);
      onJobCreated();
      if (job.status === "queued" || job.status === "processing") {
        startPolling(job.job_uuid);
      } else if (job.status === "succeeded") {
        onJobSucceeded();
      }
    } catch (e: any) {
      setErr(e.message ?? "Failed to create import job");
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
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="text-sm"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setCurrentJob(null);
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
          {busy ? "Submitting…" : "Upload"}
        </button>
      </div>

      {err && <p className="mt-3 text-sm text-[var(--bad)]">{err}</p>}

      {currentJob && (
        <div className="mt-4">
          <JobProgressCard job={currentJob} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Published manifest banner
// ---------------------------------------------------------------------------

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function ManifestBanner({
  refreshKey,
  isAdmin,
  onPackageGenerated,
}: {
  refreshKey: number;
  isAdmin: boolean;
  onPackageGenerated: () => void;
}) {
  const [manifest, setManifest] = useState<RoadInventoryManifest | null>(null);
  const [missing, setMissing] = useState(false);
  const [generatingPkg, setGeneratingPkg] = useState(false);
  const [pkgErr, setPkgErr] = useState<string | null>(null);

  useEffect(() => {
    setMissing(false);
    setManifest(null);
    setPkgErr(null);
    getRoadInventoryManifest()
      .then(setManifest)
      .catch(() => setMissing(true));
  }, [refreshKey]);

  async function handleGeneratePackage() {
    if (!manifest) return;
    setGeneratingPkg(true);
    setPkgErr(null);
    try {
      await generateRoadInventoryPackage(manifest.version_id);
      onPackageGenerated();
    } catch (e: any) {
      setPkgErr(e.message ?? "Package generation failed");
    } finally {
      setGeneratingPkg(false);
    }
  }

  if (missing) {
    return (
      <p className="text-sm text-muted italic">
        No published dataset. Upload and publish a version to make it active.
      </p>
    );
  }
  if (!manifest) return <p className="text-sm text-muted">Loading…</p>;

  const pkg = manifest.package;

  return (
    <div className="space-y-3">
      <div className="rounded border border-[var(--good)] bg-[color:color-mix(in_srgb,var(--good)_8%,transparent)] px-4 py-3 text-sm">
        <span className="font-semibold text-[var(--good)]">Published:</span>{" "}
        <span className="font-medium">{manifest.version_tag}</span>
        <span className="text-muted ml-4">
          {manifest.row_count.toLocaleString()} segments · extract {fmt(manifest.extract_date)} ·
          published {fmt(manifest.published_at)}
        </span>
      </div>

      {/* Package section */}
      <div className="rounded border border-[var(--line)] px-4 py-3 text-sm">
        {pkg.available ? (
          <div className="space-y-1">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="font-semibold text-[var(--good)]">Mobile package ready</span>
              {pkg.download_url && (
                <a
                  href={pkg.download_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-[var(--brand)] underline hover:brightness-110"
                >
                  Download
                </a>
              )}
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-0.5 max-w-sm text-xs mt-1">
              <span className="text-muted">Size</span>
              <span>{fmtBytes(pkg.size_bytes)}</span>
              <span className="text-muted">Generated</span>
              <span>{fmt(pkg.generated_at)}</span>
              <span className="text-muted">SHA-256</span>
              <span className="font-mono">{pkg.sha256.slice(0, 12)}…</span>
            </div>
            {isAdmin && (
              <button
                disabled={generatingPkg}
                onClick={handleGeneratePackage}
                className="mt-2 rounded border border-[var(--line)] px-3 py-1 text-xs text-muted hover:bg-[var(--panel-soft)] disabled:opacity-40"
              >
                {generatingPkg ? "Regenerating…" : "Regenerate Package"}
              </button>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-4 flex-wrap">
            <span className="text-muted italic">Mobile package not generated — field devices cannot sync until a package is built</span>
            {isAdmin && (
              <button
                disabled={generatingPkg}
                onClick={handleGeneratePackage}
                className="rounded bg-[var(--brand)] px-3 py-1 text-xs font-medium text-white disabled:opacity-40 hover:brightness-110"
              >
                {generatingPkg ? "Generating…" : "Generate Mobile Package"}
              </button>
            )}
          </div>
        )}
        {pkgErr && <p className="mt-2 text-xs text-[var(--bad)]">{pkgErr}</p>}
      </div>
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
              <td
                className="py-2 pr-4 max-w-[200px] truncate text-muted"
                title={v.upload_filename}
              >
                {v.upload_filename}
              </td>
              <td className="py-2 pr-4 tabular-nums">{v.row_count.toLocaleString()}</td>
              <td className="py-2 pr-4 tabular-nums text-muted">{v.skipped_count}</td>
              <td className="py-2 pr-4">
                <StatusBadge status={v.status} />
              </td>
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
// Recent import jobs table
// ---------------------------------------------------------------------------

function RecentImportJobs({ refreshKey }: { refreshKey: number }) {
  const [jobs, setJobs] = useState<RoadInventoryImportJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setErr(null);
    listRoadInventoryImportJobs()
      .then(setJobs)
      .catch((e: any) => setErr(e.message ?? "Failed to load jobs"))
      .finally(() => setLoading(false));
  }, [refreshKey]);

  if (loading) return <p className="text-sm text-muted">Loading…</p>;
  if (err) return <p className="text-sm text-[var(--bad)]">{err}</p>;
  if (jobs.length === 0) return <p className="text-sm text-muted">No import jobs yet.</p>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-[var(--line)] text-left text-xs text-muted">
            <th className="py-2 pr-4 font-medium">UUID</th>
            <th className="py-2 pr-4 font-medium">Status</th>
            <th className="py-2 pr-4 font-medium">File</th>
            <th className="py-2 pr-4 font-medium">Rows</th>
            <th className="py-2 pr-4 font-medium">Dataset ID</th>
            <th className="py-2 pr-4 font-medium">Created</th>
            <th className="py-2 pr-4 font-medium">Finished</th>
            <th className="py-2 font-medium">Error</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr
              key={j.id}
              className="border-b border-[var(--line)] hover:bg-[var(--panel-soft)]"
            >
              <td className="py-2 pr-4 font-mono text-xs text-muted">
                {j.job_uuid.slice(0, 8)}…
              </td>
              <td className="py-2 pr-4">
                <JobStatusBadge status={j.status} />
              </td>
              <td
                className="py-2 pr-4 max-w-[160px] truncate text-muted text-xs"
                title={j.upload_filename}
              >
                {j.upload_filename}
              </td>
              <td className="py-2 pr-4 tabular-nums text-xs">
                {j.row_count > 0 ? j.row_count.toLocaleString() : "—"}
              </td>
              <td className="py-2 pr-4 tabular-nums text-xs">
                {j.dataset_version_id ?? "—"}
              </td>
              <td className="py-2 pr-4 text-muted text-xs">{fmt(j.created_at)}</td>
              <td className="py-2 pr-4 text-muted text-xs">{fmt(j.finished_at)}</td>
              <td
                className="py-2 max-w-[200px] truncate text-xs text-[var(--bad)]"
                title={j.error_message ?? undefined}
              >
                {j.error_message ?? "—"}
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
                  "Dist",
                  "County",
                  "Route",
                  "PM prefix",
                  "Begin PM",
                  "End PM",
                  "Len mi",
                  "L lanes",
                  "R lanes",
                  "L surf",
                  "R surf",
                  "Median",
                  "Med W",
                  "Terrain",
                  "Speed",
                  "ADT",
                  "Landmark",
                ].map((h) => (
                  <th key={h} className="py-1.5 pr-3 font-medium whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {segments.map((s) => (
                <tr
                  key={s.id}
                  className="border-b border-[var(--line)] hover:bg-[var(--panel-soft)]"
                >
                  <td className="py-1.5 pr-3 tabular-nums">{s.district_code ?? "—"}</td>
                  <td className="py-1.5 pr-3">{s.county_code}</td>
                  <td className="py-1.5 pr-3 font-medium">
                    {s.route_name}
                    {s.route_suffix_code ?? ""}
                  </td>
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
                  <td className="py-1.5 pr-3 tabular-nums">
                    {s.adt?.toLocaleString() ?? "—"}
                  </td>
                  <td
                    className="py-1.5 pr-3 max-w-[160px] truncate"
                    title={s.landmark_short_desc ?? undefined}
                  >
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
  const [jobsKey, setJobsKey] = useState(0);

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
            <ManifestBanner
              refreshKey={manifestKey}
              isAdmin={isAdmin}
              onPackageGenerated={() => setManifestKey((k) => k + 1)}
            />
          </section>

          <hr className="border-[var(--line)]" />

          {/* Upload */}
          <section>
            <UploadSection
              onJobCreated={() => setJobsKey((k) => k + 1)}
              onJobSucceeded={() => {
                setJobsKey((k) => k + 1);
                setManifestKey((k) => k + 1);
                loadVersions();
              }}
            />
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

          {/* Recent import jobs */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold">Recent Import Jobs</h2>
              <button
                onClick={() => setJobsKey((k) => k + 1)}
                className="text-xs text-muted underline hover:text-[var(--ink)]"
              >
                Refresh
              </button>
            </div>
            <RecentImportJobs refreshKey={jobsKey} />
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
