import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { api } from "../api/client";
import ProjectDetailMap from "../features/projects/ProjectDetailMap";
import type { ProjectDetailResponse } from "../features/projects/projectTypes";
import { projectLocationLabel, projectStatusLabel } from "../features/projects/projectTypes";
import AppShell from "../ui/AppShell";

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function eventLabel(value: string): string {
  return value.toLowerCase().replace(/_/g, " ").replace(/(^|\s)\S/g, (match) => match.toUpperCase());
}

export default function ProjectDetailPage() {
  const params = useParams();
  const navigate = useNavigate();
  const projectId = Number(params.id);
  const [detail, setDetail] = useState<ProjectDetailResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!Number.isFinite(projectId) || projectId <= 0) {
      setError("Invalid Project ID.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setDetail(await api<ProjectDetailResponse>(`/projects/${projectId}`));
    } catch (e: any) {
      setError(e?.message ?? "Failed to load Project.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  return (
    <AppShell title={detail?.project.title || `Project #${Number.isFinite(projectId) ? projectId : ""}`}>
      <div className="flex h-full flex-col gap-4 p-4 md:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => navigate("/projects")} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)]">← Projects</button>
            <button type="button" onClick={load} disabled={busy} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50">{busy ? "Refreshing…" : "Refresh"}</button>
          </div>
        </div>

        {error ? <div className="rounded-md border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-3 py-2 text-sm text-[var(--bad)]">{error}</div> : null}

        {!detail ? (
          <div className="py-16 text-center text-sm text-muted">{busy ? "Loading Project…" : "Project unavailable."}</div>
        ) : (
          <>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
              <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4 xl:col-span-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted">Project</div>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <div className="text-lg font-semibold">{detail.project.title}</div>
                  <span className="rounded-full border border-[var(--line)] bg-[var(--panel-soft)] px-2.5 py-1 text-xs font-semibold">{projectStatusLabel(detail.project.status)}</span>
                </div>
                <div className="mt-1 text-sm text-muted">{projectLocationLabel(detail.project)}</div>
                {detail.project.description ? <p className="mt-3 text-sm text-muted">{detail.project.description}</p> : null}
              </div>
              <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4"><div className="text-xs font-semibold uppercase tracking-wide text-muted">Incidents</div><div className="mt-1 text-2xl font-semibold tabular-nums">{detail.project.incident_count}</div><div className="mt-1 text-xs text-muted">{detail.project.open_incident_count} active</div></div>
              <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4"><div className="text-xs font-semibold uppercase tracking-wide text-muted">Created</div><div className="mt-1 text-sm font-semibold">{formatDate(detail.project.created_at)}</div><div className="mt-1 text-xs text-muted">Project #{detail.project.id}</div></div>
              <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4"><div className="text-xs font-semibold uppercase tracking-wide text-muted">Latest incident activity</div><div className="mt-1 text-sm font-semibold">{formatDate(detail.project.latest_incident_activity_at)}</div></div>
            </div>

            <ProjectDetailMap project={detail.project} incidents={detail.incidents} />

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(320px,0.8fr)]">
              <section className="overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)]">
                <div className="border-b border-[var(--line)] bg-[var(--panel-soft)] px-4 py-3"><h2 className="text-sm font-semibold">Project incidents</h2><p className="mt-0.5 text-xs text-muted">Each Incident retains its own assessment, classification, evidence, and workflow.</p></div>
                <div className="overflow-auto">
                  <table className="w-full border-collapse">
                    <thead><tr className="border-b border-[var(--line)] text-left text-xs font-semibold uppercase tracking-wide text-muted"><th className="px-3 py-2.5">Incident</th><th className="px-3 py-2.5">Location</th><th className="px-3 py-2.5">Classification</th><th className="px-3 py-2.5">Status</th><th className="px-3 py-2.5 text-right">Action</th></tr></thead>
                    <tbody>
                      {detail.incidents.length === 0 ? <tr><td colSpan={5} className="px-3 py-8 text-center text-sm text-muted">No incidents are currently associated with this Project.</td></tr> : detail.incidents.map((incident) => (
                        <tr key={incident.id} className="border-b border-[var(--line)]/60 last:border-b-0 hover:bg-[var(--panel-soft)]">
                          <td className="px-3 py-3"><div className="text-sm font-semibold">#{incident.id} {incident.title || "Incident"}</div><div className="mt-0.5 text-xs text-muted">Observed {formatDate(incident.first_observed_at)}</div></td>
                          <td className="px-3 py-3 text-sm text-muted">{projectLocationLabel({ district: incident.district, county: incident.county, route: incident.route, post_mile: incident.post_mile })}</td>
                          <td className="px-3 py-3 text-sm"><span className={incident.incident_type ? "font-medium" : "text-muted"}>{incident.incident_type || "Unclassified · pending assessment"}</span></td>
                          <td className="px-3 py-3 text-sm text-muted">{incident.status}</td>
                          <td className="px-3 py-3 text-right"><button type="button" onClick={() => navigate(`/incidents`)} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-2.5 py-1.5 text-xs font-semibold hover:bg-[var(--panel-soft)]">Open in Incidents</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)]">
                <div className="border-b border-[var(--line)] bg-[var(--panel-soft)] px-4 py-3"><h2 className="text-sm font-semibold">Project history</h2><p className="mt-0.5 text-xs text-muted">Audited Project and Incident association activity.</p></div>
                <div className="max-h-[480px] overflow-auto p-4">
                  {detail.events.length === 0 ? <div className="text-sm text-muted">No Project history has been recorded.</div> : (
                    <ol className="space-y-3">
                      {detail.events.slice().reverse().map((event) => (
                        <li key={event.id} className="border-l-2 border-[var(--line)] pl-3">
                          <div className="text-sm font-semibold">{eventLabel(event.event_type)}</div>
                          <div className="mt-0.5 text-xs text-muted">{formatDate(event.created_at)}{event.actor_name || event.actor_email ? ` · ${event.actor_name || event.actor_email}` : ""}</div>
                          {event.incident_id ? <div className="mt-1 text-xs text-muted">Incident #{event.incident_id}</div> : null}
                          {event.notes ? <p className="mt-1 text-sm text-muted">{event.notes}</p> : null}
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              </section>
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
