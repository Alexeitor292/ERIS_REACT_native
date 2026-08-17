import { useCallback, useEffect, useMemo, useState } from "react";

import {
  generateRoadInventoryPackage,
  getRoadInventoryManifest,
  listRoadInventoryVersions,
  publishRoadInventoryVersion,
  rollbackRoadInventoryVersion,
  type RoadInventoryDataset,
  type RoadInventoryManifest,
} from "../../api/roadInventory";
import AppShell from "../../ui/AppShell";
import RoadInventoryImportPanel from "./RoadInventoryImportPanel";
import RoadInventoryLookupPanel from "./RoadInventoryLookupPanel";
import RoadInventoryVersionActionDialog, { type RoadInventoryVersionAction } from "./RoadInventoryVersionActionDialog";

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(parsed);
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function DatasetStatusBadge({ status }: { status: RoadInventoryDataset["status"] }) {
  const className =
    status === "published"
      ? "border-[color:color-mix(in_oklab,var(--good)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--good)_10%,transparent)] text-[var(--good)]"
      : status === "superseded"
        ? "border-[var(--line)] bg-[var(--panel-soft)] text-muted"
        : "border-[color:color-mix(in_oklab,var(--brand)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--brand)_10%,transparent)] text-[var(--brand)]";
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold capitalize ${className}`}>{status}</span>;
}

export default function RoadInventoryWorkspacePage() {
  const [versions, setVersions] = useState<RoadInventoryDataset[]>([]);
  const [manifest, setManifest] = useState<RoadInventoryManifest | null>(null);
  const [manifestMissing, setManifestMissing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [packageBusy, setPackageBusy] = useState(false);
  const [versionBusyId, setVersionBusyId] = useState<number | null>(null);
  const [action, setAction] = useState<RoadInventoryVersionAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadWorkspace = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextVersions = await listRoadInventoryVersions();
      setVersions(nextVersions);
      try {
        setManifest(await getRoadInventoryManifest());
        setManifestMissing(false);
      } catch {
        setManifest(null);
        setManifestMissing(true);
      }
    } catch (e: any) {
      setError(e?.message ?? "Failed to load road inventory state.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadWorkspace();
  }, [loadWorkspace]);

  const currentPublished = useMemo(() => versions.find((version) => version.status === "published") ?? null, [versions]);
  const pendingCount = useMemo(() => versions.filter((version) => version.status === "pending").length, [versions]);
  const supersededCount = useMemo(() => versions.filter((version) => version.status === "superseded").length, [versions]);

  async function generatePackage() {
    if (!manifest) return;
    setPackageBusy(true);
    setError(null);
    setNotice(null);
    try {
      await generateRoadInventoryPackage(manifest.version_id);
      setNotice(`Mobile package generated for authoritative version ${manifest.version_tag}.`);
      await loadWorkspace();
    } catch (e: any) {
      setError(e?.message ?? "Mobile package generation failed.");
    } finally {
      setPackageBusy(false);
    }
  }

  async function confirmVersionAction() {
    if (!action) return;
    const target = action.dataset;
    setVersionBusyId(target.id);
    setError(null);
    setNotice(null);
    try {
      if (action.kind === "publish") {
        await publishRoadInventoryVersion(target.id);
        setNotice(`Published road inventory version ${target.version_tag}.`);
      } else {
        await rollbackRoadInventoryVersion(target.id);
        setNotice(`Rolled back authoritative road inventory to version ${target.version_tag}.`);
      }
      setAction(null);
      await loadWorkspace();
    } catch (e: any) {
      setError(e?.message ?? `${action.kind === "publish" ? "Publish" : "Rollback"} failed.`);
    } finally {
      setVersionBusyId(null);
    }
  }

  const packageReady = !!manifest?.package.available;

  return (
    <AppShell title="Road Inventory">
      <div className="flex h-full flex-col gap-4 p-4 md:p-5">
        <section className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4 md:p-5">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">Authoritative roadway reference</div>
              <h2 className="mt-1 text-xl font-semibold">Road inventory operations</h2>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">Manage the version ERIS uses for roadway matching and the package distributed to field devices. Publication and rollback are explicit authoritative-state changes.</p>
            </div>
            <button type="button" onClick={loadWorkspace} disabled={loading} className="self-start rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50">
              {loading ? "Refreshing…" : "Refresh state"}
            </button>
          </div>
        </section>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <SummaryCard label="Authoritative version" value={currentPublished?.version_tag ?? "None"} hint={currentPublished ? `${currentPublished.row_count.toLocaleString()} segments` : "No published dataset"} />
          <SummaryCard label="Mobile package" value={packageReady ? "Ready" : "Not ready"} hint={packageReady ? `Generated ${formatDate(manifest?.package.available ? manifest.package.generated_at : null)}` : "Field sync package unavailable"} tone={packageReady ? "good" : "warn"} />
          <SummaryCard label="Pending versions" value={String(pendingCount)} hint="Imported, not authoritative" />
          <SummaryCard label="Superseded" value={String(supersededCount)} hint="Available for rollback" />
        </div>

        {error ? <div className="rounded-md border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-3 py-2 text-sm text-[var(--bad)]">{error}</div> : null}
        {notice ? <div className="rounded-md border border-[color:color-mix(in_oklab,var(--good)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--good)_10%,transparent)] px-3 py-2 text-sm text-[var(--good)]">{notice}</div> : null}

        <section className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4 md:p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h2 className="font-semibold">Current authoritative dataset</h2>
              {manifestMissing ? (
                <div className="mt-2 text-sm text-muted">No published road inventory exists. Import a dataset and explicitly publish the version ERIS should use.</div>
              ) : !manifest ? (
                <div className="mt-2 text-sm text-muted">Loading authoritative manifest…</div>
              ) : (
                <dl className="mt-3 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
                  <Metric label="Version" value={manifest.version_tag} />
                  <Metric label="Segments" value={manifest.row_count.toLocaleString()} />
                  <Metric label="Extract date" value={formatDate(manifest.extract_date)} />
                  <Metric label="Published" value={formatDate(manifest.published_at)} />
                </dl>
              )}
            </div>

            {manifest ? (
              <div className="min-w-72 rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] p-4 text-sm">
                <div className="flex items-center justify-between gap-3"><span className="font-semibold">Mobile package</span><span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${packageReady ? "border-[color:color-mix(in_oklab,var(--good)_45%,transparent)] text-[var(--good)]" : "border-[var(--line)] text-muted"}`}>{packageReady ? "Ready" : "Not generated"}</span></div>
                {manifest.package.available ? (
                  <div className="mt-3 space-y-1 text-xs text-muted">
                    <div>Size: <span className="font-medium text-[var(--ink)]">{formatBytes(manifest.package.size_bytes)}</span></div>
                    <div>Generated: <span className="font-medium text-[var(--ink)]">{formatDate(manifest.package.generated_at)}</span></div>
                    <div>SHA-256: <span className="font-mono text-[var(--ink)]">{manifest.package.sha256.slice(0, 16)}…</span></div>
                    {manifest.package.download_url ? <a href={manifest.package.download_url} target="_blank" rel="noreferrer" className="mt-2 inline-block font-semibold text-[var(--brand)] hover:underline">Download package</a> : null}
                  </div>
                ) : <p className="mt-3 text-xs leading-5 text-muted">Field devices cannot synchronize this road inventory until a mobile package is generated.</p>}
                <button type="button" onClick={generatePackage} disabled={packageBusy} className="mt-3 w-full rounded-md bg-[var(--brand)] px-3 py-2 text-sm font-semibold text-white hover:brightness-95 disabled:opacity-50">{packageBusy ? "Generating…" : packageReady ? "Regenerate package" : "Generate mobile package"}</button>
              </div>
            ) : null}
          </div>
        </section>

        <RoadInventoryImportPanel onDatasetChanged={loadWorkspace} />

        <section className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4 md:p-5">
          <div>
            <h2 className="font-semibold">Dataset versions</h2>
            <p className="mt-1 text-sm text-muted">Only one version is authoritative at a time. Publishing or rolling back changes the dataset used by ERIS roadway matching.</p>
          </div>

          {versions.length === 0 ? <div className="mt-4 text-sm text-muted">No road inventory versions have been imported.</div> : (
            <div className="mt-4 overflow-x-auto rounded-lg border border-[var(--line)]">
              <table className="w-full border-collapse text-sm">
                <thead><tr className="border-b border-[var(--line)] bg-[var(--panel-soft)] text-left text-xs font-semibold uppercase tracking-wide text-muted"><th className="px-3 py-3">ID</th><th className="px-3 py-3">Version</th><th className="px-3 py-3">Source file</th><th className="px-3 py-3">Rows</th><th className="px-3 py-3">Skipped</th><th className="px-3 py-3">Status</th><th className="px-3 py-3">Extract</th><th className="px-3 py-3">Uploaded</th><th className="px-3 py-3 text-right">Actions</th></tr></thead>
                <tbody>{versions.map((version) => (
                  <tr key={version.id} className={`border-b border-[var(--line)]/60 last:border-b-0 ${version.status === "published" ? "bg-[color:color-mix(in_oklab,var(--good)_5%,var(--panel))]" : ""}`}>
                    <td className="px-3 py-3 tabular-nums text-muted">#{version.id}</td><td className="px-3 py-3 font-semibold">{version.version_tag}</td><td className="max-w-64 truncate px-3 py-3 text-muted" title={version.upload_filename}>{version.upload_filename}</td><td className="px-3 py-3 tabular-nums">{version.row_count.toLocaleString()}</td><td className="px-3 py-3 tabular-nums text-muted">{version.skipped_count}</td><td className="px-3 py-3"><DatasetStatusBadge status={version.status} /></td><td className="px-3 py-3 text-muted">{formatDate(version.extract_date)}</td><td className="px-3 py-3 text-muted">{formatDate(version.created_at)}</td>
                    <td className="px-3 py-3 text-right"><div className="inline-flex gap-2">{version.status === "pending" ? <button type="button" disabled={versionBusyId === version.id} onClick={() => setAction({ kind: "publish", dataset: version })} className="rounded-md border border-[var(--brand)] px-2.5 py-1.5 text-xs font-semibold text-[var(--brand)] disabled:opacity-50">Publish</button> : null}{version.status === "superseded" ? <button type="button" disabled={versionBusyId === version.id} onClick={() => setAction({ kind: "rollback", dataset: version })} className="rounded-md border border-[color:color-mix(in_oklab,var(--bad)_45%,var(--line))] px-2.5 py-1.5 text-xs font-semibold text-[var(--bad)] disabled:opacity-50">Rollback</button> : null}{version.status === "published" ? <span className="text-xs font-semibold text-[var(--good)]">Authoritative</span> : null}</div></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </section>

        <RoadInventoryLookupPanel />
      </div>

      {action ? <RoadInventoryVersionActionDialog action={action} currentPublished={currentPublished} busy={versionBusyId === action.dataset.id} onClose={() => setAction(null)} onConfirm={confirmVersionAction} /> : null}
    </AppShell>
  );
}

function SummaryCard({ label, value, hint, tone = "neutral" }: { label: string; value: string; hint: string; tone?: "neutral" | "good" | "warn" }) {
  return <div className={`rounded-xl border p-3 ${tone === "good" ? "border-[color:color-mix(in_oklab,var(--good)_35%,var(--line))] bg-[color:color-mix(in_oklab,var(--good)_6%,var(--panel))]" : tone === "warn" ? "border-[color:color-mix(in_oklab,var(--bad)_30%,var(--line))] bg-[color:color-mix(in_oklab,var(--bad)_5%,var(--panel))]" : "border-[var(--line)] bg-[var(--panel-soft)]"}`}><div className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</div><div className="mt-2 truncate text-xl font-semibold" title={value}>{value}</div><div className="mt-1 text-xs text-muted">{hint}</div></div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</dt><dd className="mt-1 font-semibold">{value}</dd></div>;
}
