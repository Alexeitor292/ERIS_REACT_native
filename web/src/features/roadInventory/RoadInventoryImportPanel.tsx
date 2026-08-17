import { useEffect, useRef, useState } from "react";

import {
  createRoadInventoryImportJob,
  getRoadInventoryImportJob,
  listRoadInventoryImportJobs,
  type RoadInventoryImportJob,
} from "../../api/roadInventory";

function formatDateTime(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

function formatBytes(bytes: number | null | undefined) {
  if (!bytes || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function JobBadge({ status }: { status: RoadInventoryImportJob["status"] }) {
  const className =
    status === "succeeded"
      ? "border-[color:color-mix(in_oklab,var(--good)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--good)_10%,transparent)] text-[var(--good)]"
      : status === "failed"
        ? "border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] text-[var(--bad)]"
        : status === "processing"
          ? "border-[color:color-mix(in_oklab,var(--brand)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--brand)_10%,transparent)] text-[var(--brand)]"
          : "border-[var(--line)] bg-[var(--panel-soft)] text-muted";
  return <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold capitalize ${className}`}>{status}</span>;
}

export default function RoadInventoryImportPanel({ onDatasetChanged }: { onDatasetChanged: () => void }) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [versionTag, setVersionTag] = useState("");
  const [currentJob, setCurrentJob] = useState<RoadInventoryImportJob | null>(null);
  const [jobs, setJobs] = useState<RoadInventoryImportJob[]>([]);
  const [busy, setBusy] = useState(false);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadJobs() {
    setJobsLoading(true);
    try {
      setJobs(await listRoadInventoryImportJobs());
    } catch (e: any) {
      setError(e?.message ?? "Failed to load import history.");
    } finally {
      setJobsLoading(false);
    }
  }

  useEffect(() => {
    loadJobs();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  function beginPolling(jobUuid: string) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const next = await getRoadInventoryImportJob(jobUuid);
        setCurrentJob(next);
        if (next.status === "succeeded" || next.status === "failed") {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          await loadJobs();
          if (next.status === "succeeded") onDatasetChanged();
        }
      } catch {
        // Keep the last known state and allow the next poll to retry.
      }
    }, 2000);
  }

  async function submitImport() {
    if (!file) return;
    setBusy(true);
    setError(null);
    setCurrentJob(null);
    try {
      const job = await createRoadInventoryImportJob(file, versionTag.trim() || undefined);
      setCurrentJob(job);
      setFile(null);
      setVersionTag("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      await loadJobs();
      if (job.status === "queued" || job.status === "processing") beginPolling(job.job_uuid);
      else if (job.status === "succeeded") onDatasetChanged();
    } catch (e: any) {
      setError(e?.message ?? "Failed to create road-inventory import job.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4 md:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Import road inventory</h2>
          <p className="mt-1 text-sm text-muted">Upload an authoritative Excel extract. Successful imports remain pending until an administrator explicitly publishes a version.</p>
        </div>
        <button type="button" onClick={loadJobs} disabled={jobsLoading} className="rounded-md border border-[var(--line)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50">
          {jobsLoading ? "Refreshing…" : "Refresh history"}
        </button>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-[minmax(260px,1fr)_220px_auto] md:items-end">
        <label className="grid gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted">Excel file (.xlsx)</span>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            disabled={busy}
            onChange={(event) => {
              setFile(event.currentTarget.files?.[0] ?? null);
              setCurrentJob(null);
              setError(null);
            }}
            className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-[var(--panel)] file:px-3 file:py-1.5 file:text-sm file:font-semibold"
          />
        </label>
        <label className="grid gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted">Version tag</span>
          <input value={versionTag} onChange={(event) => setVersionTag(event.target.value)} placeholder="Optional, e.g. 2026-08-17" className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-2 text-sm" />
        </label>
        <button type="button" onClick={submitImport} disabled={!file || busy} className="rounded-md bg-[var(--brand)] px-4 py-2 text-sm font-semibold text-white hover:brightness-95 disabled:opacity-50">
          {busy ? "Submitting…" : "Start import"}
        </button>
      </div>

      {file ? <div className="mt-2 text-xs text-muted">Selected: {file.name} · {formatBytes(file.size)}</div> : null}
      {error ? <div className="mt-4 rounded-md border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-3 py-2 text-sm text-[var(--bad)]">{error}</div> : null}

      {currentJob ? (
        <div className="mt-4 rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] p-4">
          <div className="flex flex-wrap items-center gap-2"><JobBadge status={currentJob.status} /><span className="font-semibold">{currentJob.upload_filename}</span><span className="ml-auto text-xs font-mono text-muted">{currentJob.stage}</span></div>
          {currentJob.message ? <div className="mt-2 text-sm text-muted">{currentJob.message}</div> : null}
          {currentJob.status === "succeeded" ? <div className="mt-3 text-sm"><strong>{currentJob.row_count.toLocaleString()}</strong> rows imported; <strong>{currentJob.skipped_count}</strong> skipped. Dataset #{currentJob.dataset_version_id} is pending publication.</div> : null}
          {currentJob.status === "failed" && currentJob.error_message ? <div className="mt-3 text-sm text-[var(--bad)]">{currentJob.error_message}</div> : null}
        </div>
      ) : null}

      <div className="mt-6 border-t border-[var(--line)] pt-4">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted">Recent import history</div>
        {jobsLoading && jobs.length === 0 ? <div className="mt-3 text-sm text-muted">Loading import history…</div> : jobs.length === 0 ? <div className="mt-3 text-sm text-muted">No import jobs recorded.</div> : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead><tr className="border-b border-[var(--line)] bg-[var(--panel-soft)] text-left text-xs font-semibold uppercase tracking-wide text-muted"><th className="px-3 py-2">Job</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">File</th><th className="px-3 py-2">Rows</th><th className="px-3 py-2">Dataset</th><th className="px-3 py-2">Created</th><th className="px-3 py-2">Finished</th></tr></thead>
              <tbody>{jobs.map((job) => <tr key={job.id} className="border-b border-[var(--line)]/60 last:border-b-0"><td className="px-3 py-2 font-mono text-xs text-muted" title={job.job_uuid}>{job.job_uuid.slice(0, 8)}…</td><td className="px-3 py-2"><JobBadge status={job.status} /></td><td className="max-w-60 truncate px-3 py-2" title={job.upload_filename}>{job.upload_filename}</td><td className="px-3 py-2 tabular-nums">{job.row_count > 0 ? job.row_count.toLocaleString() : "—"}</td><td className="px-3 py-2 tabular-nums">{job.dataset_version_id ?? "—"}</td><td className="px-3 py-2 text-muted">{formatDateTime(job.created_at)}</td><td className="px-3 py-2 text-muted">{formatDateTime(job.finished_at)}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
