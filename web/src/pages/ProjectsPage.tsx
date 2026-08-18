import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { api } from "../api/client";
import AppShell from "../ui/AppShell";
import type { ProjectStatus, ProjectSummary } from "../features/projects/projectTypes";
import { projectLocationLabel, projectStatusLabel } from "../features/projects/projectTypes";

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function StatusBadge({ status }: { status: ProjectStatus }) {
  const className = status === "OPEN"
    ? "border-[color:color-mix(in_oklab,var(--good)_42%,transparent)] bg-[color:color-mix(in_oklab,var(--good)_9%,transparent)] text-[var(--good)]"
    : status === "CLOSED"
      ? "border-[color:color-mix(in_oklab,var(--brand)_35%,transparent)] bg-[color:color-mix(in_oklab,var(--brand)_8%,transparent)] text-[var(--brand)]"
      : "border-[var(--line)] bg-[var(--panel-soft)] text-muted";
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${className}`}>{projectStatusLabel(status)}</span>;
}

export default function ProjectsPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<ProjectSummary[]>([]);
  const [status, setStatus] = useState<"ALL" | ProjectStatus>("OPEN");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setBusy(true);
    setError(null);
    try {
      const query = new URLSearchParams({ status, limit: "500" });
      if (search.trim()) query.set("q", search.trim());
      const response = await api<{ items: ProjectSummary[] }>(`/projects?${query.toString()}`);
      setItems(response.items ?? []);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load Projects.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const handle = window.setTimeout(load, search.trim() ? 250 : 0);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, search]);

  const summary = useMemo(() => ({
    projects: items.length,
    incidents: items.reduce((total, project) => total + project.incident_count, 0),
    activeIncidents: items.reduce((total, project) => total + project.open_incident_count, 0),
  }), [items]);

  return (
    <AppShell title="Projects">
      <div className="flex h-full flex-col gap-4 p-4 md:p-5">
        <div className="flex flex-col gap-3 rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] p-4 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-sm font-semibold">Project operations</div>
            <div className="mt-1 max-w-3xl text-sm text-muted">Projects are the operational parent of Incidents. A Project can contain multiple reports from the same response area while each Incident keeps its own assessment and classification history.</div>
          </div>
          <button type="button" onClick={load} disabled={busy} className="self-start rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50 md:self-auto">{busy ? "Refreshing…" : "Refresh"}</button>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4"><div className="text-xs font-semibold uppercase tracking-wide text-muted">Projects shown</div><div className="mt-1 text-2xl font-semibold tabular-nums">{summary.projects}</div></div>
          <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4"><div className="text-xs font-semibold uppercase tracking-wide text-muted">Incidents in Projects</div><div className="mt-1 text-2xl font-semibold tabular-nums">{summary.incidents}</div></div>
          <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4"><div className="text-xs font-semibold uppercase tracking-wide text-muted">Active incidents</div><div className="mt-1 text-2xl font-semibold tabular-nums">{summary.activeIncidents}</div></div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search title, county, route, or description" className="min-w-[280px] flex-1 rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--brand)]" />
          <select value={status} onChange={(event) => setStatus(event.target.value as "ALL" | ProjectStatus)} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm">
            <option value="OPEN">Open Projects</option>
            <option value="CLOSED">Closed Projects</option>
            <option value="ARCHIVED">Archived Projects</option>
            <option value="ALL">All Projects</option>
          </select>
        </div>

        {error ? <div className="rounded-md border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-3 py-2 text-sm text-[var(--bad)]">{error}</div> : null}

        <div className="flex-1 overflow-auto rounded-xl border border-[var(--line)] bg-[var(--panel)]">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-[var(--line)] bg-[var(--panel-soft)] text-left text-xs font-semibold uppercase tracking-wide text-muted">
                <th className="px-3 py-3">Project</th>
                <th className="px-3 py-3">Location</th>
                <th className="px-3 py-3">Incidents</th>
                <th className="px-3 py-3">Status</th>
                <th className="px-3 py-3">Last activity</th>
                <th className="px-3 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr><td colSpan={6} className="px-3 py-10 text-center text-sm text-muted">{busy ? "Loading Projects…" : "No Projects match the current filters."}</td></tr>
              ) : items.map((project) => (
                <tr key={project.id} className="border-b border-[var(--line)]/60 align-top last:border-b-0 hover:bg-[var(--panel-soft)]">
                  <td className="px-3 py-3">
                    <button type="button" onClick={() => navigate(`/projects/${project.id}`)} className="text-left">
                      <div className="text-sm font-semibold text-[var(--ink)] hover:text-[var(--brand)]">{project.title}</div>
                      <div className="mt-0.5 text-xs text-muted">Project #{project.id}</div>
                    </button>
                  </td>
                  <td className="px-3 py-3 text-sm text-muted">{projectLocationLabel(project)}</td>
                  <td className="px-3 py-3 text-sm"><span className="font-semibold tabular-nums">{project.incident_count}</span><span className="text-muted"> total · {project.open_incident_count} active</span></td>
                  <td className="px-3 py-3"><StatusBadge status={project.status} /></td>
                  <td className="px-3 py-3 text-sm text-muted">{formatDate(project.latest_incident_activity_at ?? project.updated_at)}</td>
                  <td className="px-3 py-3 text-right"><button type="button" onClick={() => navigate(`/projects/${project.id}`)} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--panel-soft)]">Open Project</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
