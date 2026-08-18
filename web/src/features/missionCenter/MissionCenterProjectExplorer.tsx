import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { api } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import type { IncidentClassification, IncidentClassificationQueryResponse } from "../incidents/incidentClassification";
import { classificationLabel, classificationStateLabel } from "../incidents/incidentClassification";
import type { ProjectDetailResponse, ProjectStatus, ProjectSummary } from "../projects/projectTypes";
import { projectLocationLabel, projectStatusLabel } from "../projects/projectTypes";
import AppShell from "../../ui/AppShell";
import { formatCoordinate } from "../../utils/precision";
import { isOperationalUser } from "../../utils/roleModel";
import MissionCenterProjectGisMap from "./MissionCenterProjectGisMap";
import {
  projectSearchMatch,
  type MissionCenterIncidentGis,
  type MissionCenterMode,
  type MissionCenterProjectPage,
} from "./missionCenterGisModel";

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : dateTimeFormatter.format(parsed);
}

function StatusPill({ label, tone = "neutral" }: { label: string; tone?: "neutral" | "good" | "bad" | "brand" }) {
  const cls = tone === "good"
    ? "border-[color:color-mix(in_oklab,var(--good)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--good)_9%,transparent)] text-[var(--good)]"
    : tone === "bad"
      ? "border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_9%,transparent)] text-[var(--bad)]"
      : tone === "brand"
        ? "border-[color:color-mix(in_oklab,var(--brand)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--brand)_9%,transparent)] text-[var(--brand)]"
        : "border-[var(--line)] bg-[var(--panel-soft)] text-muted";
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${cls}`}>{label}</span>;
}

export default function MissionCenterProjectExplorer() {
  const navigate = useNavigate();
  const { me } = useAuth();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [projectDetail, setProjectDetail] = useState<ProjectDetailResponse | null>(null);
  const [classifications, setClassifications] = useState<Record<number, IncidentClassification>>({});
  const [selectedIncidentId, setSelectedIncidentId] = useState<number | null>(null);
  const [incidentGis, setIncidentGis] = useState<MissionCenterIncidentGis | null>(null);
  const [projectSearch, setProjectSearch] = useState("");
  const [projectStatus, setProjectStatus] = useState<"ALL" | ProjectStatus>("ALL");
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [loadingEvidence, setLoadingEvidence] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);

  const mode: MissionCenterMode = selectedIncidentId != null && incidentGis
    ? "INCIDENT"
    : selectedProjectId != null && projectDetail
      ? "PROJECT"
      : "PROJECTS";

  const loadProjects = useCallback(async () => {
    if (!isOperationalUser(me?.roles)) return;
    setLoadingProjects(true);
    setError(null);
    try {
      const all: ProjectSummary[] = [];
      let cursor: number | null = null;
      for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
        const query = new URLSearchParams({ limit: "1000" });
        if (cursor != null) query.set("after_id", String(cursor));
        const page = await api<MissionCenterProjectPage>(`/mission-center/projects?${query.toString()}`);
        all.push(...(page.items ?? []));
        if (!page.has_more || page.next_cursor == null) break;
        if (page.next_cursor === cursor) throw new Error("Project map pagination did not advance.");
        cursor = page.next_cursor;
      }
      setProjects(all);
      setLastUpdatedAt(new Date());
    } catch (e: any) {
      setError(e?.message ?? "Failed to load statewide Project GIS data.");
    } finally {
      setLoadingProjects(false);
    }
  }, [me?.roles]);

  const loadProject = useCallback(async (projectId: number) => {
    setLoadingDetail(true);
    setError(null);
    try {
      const detail = await api<ProjectDetailResponse>(`/projects/${projectId}`);
      setProjectDetail(detail);
      const ids = detail.incidents.map((incident) => incident.id);
      if (ids.length > 0) {
        const response = await api<IncidentClassificationQueryResponse>("/incident-classifications/query", {
          method: "POST",
          body: JSON.stringify({ incident_ids: ids }),
        });
        setClassifications(Object.fromEntries((response.items ?? []).map((classification) => [classification.incident_id, classification])));
      } else {
        setClassifications({});
      }
    } catch (e: any) {
      setError(e?.message ?? "Failed to load Project details.");
      setProjectDetail(null);
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  const selectProject = useCallback((projectId: number) => {
    setSelectedProjectId(projectId);
    setSelectedIncidentId(null);
    setIncidentGis(null);
    setProjectDetail(null);
    setClassifications({});
    loadProject(projectId).catch(() => {});
  }, [loadProject]);

  const selectIncident = useCallback(async (incidentId: number) => {
    setSelectedIncidentId(incidentId);
    setIncidentGis(null);
    setLoadingEvidence(true);
    setError(null);
    try {
      setIncidentGis(await api<MissionCenterIncidentGis>(`/mission-center/incidents/${incidentId}/gis`));
    } catch (e: any) {
      setError(e?.message ?? "Failed to load Incident GIS evidence.");
      setSelectedIncidentId(null);
    } finally {
      setLoadingEvidence(false);
    }
  }, []);

  useEffect(() => {
    loadProjects();
    const timer = window.setInterval(() => loadProjects().catch(() => {}), 60_000);
    return () => window.clearInterval(timer);
  }, [loadProjects]);

  const visibleProjects = useMemo(
    () => projects.filter((project) => (projectStatus === "ALL" || project.status === projectStatus) && projectSearchMatch(project, projectSearch)),
    [projectSearch, projectStatus, projects],
  );

  const statewideSummary = useMemo(() => ({
    projects: projects.length,
    openProjects: projects.filter((project) => project.status === "OPEN").length,
    incidents: projects.reduce((total, project) => total + project.incident_count, 0),
    activeIncidents: projects.reduce((total, project) => total + project.open_incident_count, 0),
  }), [projects]);

  const selectedProject = projectDetail?.project ?? projects.find((project) => project.id === selectedProjectId) ?? null;
  const selectedIncident = projectDetail?.incidents.find((incident) => incident.id === selectedIncidentId) ?? null;
  const selectedClassification = selectedIncidentId != null ? classifications[selectedIncidentId] : undefined;

  function backToProjects() {
    setSelectedProjectId(null);
    setProjectDetail(null);
    setClassifications({});
    setSelectedIncidentId(null);
    setIncidentGis(null);
  }

  function backToProject() {
    setSelectedIncidentId(null);
    setIncidentGis(null);
  }

  if (!isOperationalUser(me?.roles)) {
    return (
      <AppShell title="Mission Center">
        <div className="p-6">
          <div className="rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] p-5 text-sm text-muted">
            Mission Center Project GIS is available to ERIS operational engineering and coordination roles. Maintenance reporting accounts remain scoped to their own reports.
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell title="Mission Center">
      <div className="flex h-full flex-col gap-4 p-4 md:p-5">
        <div className="flex flex-col gap-3 rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] p-4 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <div className="text-sm font-semibold">California Project GIS</div>
            <div className="mt-1 max-w-4xl text-sm text-muted">
              Explore ERIS geographically: select a Project statewide, drill into its Incidents, then inspect saved field geometry and photo/camera evidence for an Incident.
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <span>{lastUpdatedAt ? `Project map updated ${dateTimeFormatter.format(lastUpdatedAt)}` : "Project map not refreshed yet"}</span>
            <button type="button" onClick={() => loadProjects()} disabled={loadingProjects} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium text-[var(--ink)] hover:bg-[var(--panel-soft)] disabled:opacity-50">
              {loadingProjects ? "Refreshing…" : "Refresh statewide map"}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {[
            ["Projects", statewideSummary.projects, "Statewide records"],
            ["Open Projects", statewideSummary.openProjects, "Active Project containers"],
            ["Incidents", statewideSummary.incidents, "Across all Projects"],
            ["Active Incidents", statewideSummary.activeIncidents, "Not resolved"],
          ].map(([label, value, hint]) => (
            <div key={String(label)} className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</div>
              <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
              <div className="mt-1 text-xs text-muted">{hint}</div>
            </div>
          ))}
        </div>

        {error ? <div role="alert" className="rounded-md border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-3 py-2 text-sm text-[var(--bad)]">{error}</div> : null}

        <div className="grid min-h-[680px] gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(340px,0.8fr)]">
          <MissionCenterProjectGisMap
            mode={mode}
            projects={visibleProjects}
            selectedProjectId={selectedProjectId}
            projectDetail={projectDetail}
            selectedIncidentId={selectedIncidentId}
            incidentGis={incidentGis}
            classifications={classifications}
            onSelectProject={selectProject}
            onSelectIncident={(incidentId) => { selectIncident(incidentId).catch(() => {}); }}
            height={680}
          />

          <aside className="overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)]">
            {mode === "PROJECTS" ? (
              <div className="flex h-full flex-col">
                <div className="border-b border-[var(--line)] bg-[var(--panel-soft)] p-4">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted">Statewide Project search</div>
                  <div className="mt-1 text-lg font-semibold">Select a Project</div>
                  <p className="mt-1 text-sm text-muted">Click a map marker or search the Project directory below.</p>
                  <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_auto] xl:grid-cols-1 2xl:grid-cols-[1fr_auto]">
                    <input value={projectSearch} onChange={(event) => setProjectSearch(event.target.value)} placeholder="Project, county, route, post mile…" className="min-w-0 rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--brand)]" />
                    <select value={projectStatus} onChange={(event) => setProjectStatus(event.target.value as "ALL" | ProjectStatus)} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm">
                      <option value="ALL">All statuses</option>
                      <option value="OPEN">Open</option>
                      <option value="CLOSED">Closed</option>
                      <option value="ARCHIVED">Archived</option>
                    </select>
                  </div>
                </div>
                <div className="flex-1 overflow-auto p-3">
                  <div className="mb-2 text-xs text-muted">{visibleProjects.length.toLocaleString()} Project{visibleProjects.length === 1 ? "" : "s"} shown on map</div>
                  <div className="space-y-2">
                    {visibleProjects.length === 0 ? <div className="rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-4 text-sm text-muted">{loadingProjects ? "Loading Projects…" : "No Projects match the current filters."}</div> : visibleProjects.map((project) => (
                      <button key={project.id} type="button" onClick={() => selectProject(project.id)} className="block w-full rounded-lg border border-[var(--line)] bg-[var(--panel)] p-3 text-left hover:border-[color:color-mix(in_oklab,var(--brand)_45%,var(--line))] hover:bg-[var(--panel-soft)]">
                        <div className="flex items-start justify-between gap-2"><div className="font-semibold leading-snug">{project.title}</div><StatusPill label={projectStatusLabel(project.status)} tone={project.status === "OPEN" ? "good" : "neutral"} /></div>
                        <div className="mt-1 text-xs text-muted">Project #{project.id} · {projectLocationLabel(project)}</div>
                        <div className="mt-2 text-xs text-muted">{project.incident_count} Incident{project.incident_count === 1 ? "" : "s"} · {project.open_incident_count} active</div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}

            {mode === "PROJECT" && selectedProject ? (
              <div className="flex h-full flex-col">
                <div className="border-b border-[var(--line)] bg-[var(--panel-soft)] p-4">
                  <button type="button" onClick={backToProjects} className="mb-3 rounded-md border border-[var(--line)] bg-[var(--panel)] px-2.5 py-1.5 text-xs font-semibold hover:bg-[var(--panel-soft)]">← All California Projects</button>
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted">Selected Project</div>
                  <div className="mt-1 text-lg font-semibold leading-snug">{selectedProject.title}</div>
                  <div className="mt-1 text-sm text-muted">Project #{selectedProject.id} · {projectLocationLabel(selectedProject)}</div>
                  <div className="mt-3 flex flex-wrap gap-2"><StatusPill label={projectStatusLabel(selectedProject.status)} tone={selectedProject.status === "OPEN" ? "good" : "neutral"} /><StatusPill label={`${selectedProject.incident_count} incidents`} /><StatusPill label={`${selectedProject.open_incident_count} active`} tone={selectedProject.open_incident_count > 0 ? "bad" : "good"} /></div>
                  {selectedProject.description ? <p className="mt-3 text-sm text-muted">{selectedProject.description}</p> : null}
                  <button type="button" onClick={() => navigate(`/projects/${selectedProject.id}`)} className="mt-4 w-full rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-semibold hover:bg-[var(--panel-soft)]">Open full Project workspace</button>
                </div>
                <div className="flex-1 overflow-auto p-3">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Project Incidents</div>
                  {loadingDetail ? <div className="text-sm text-muted">Loading Project Incidents…</div> : projectDetail?.incidents.length ? <div className="space-y-2">{projectDetail.incidents.map((incident) => {
                    const classification = classifications[incident.id];
                    return (
                      <button key={incident.id} type="button" onClick={() => { selectIncident(incident.id).catch(() => {}); }} className="block w-full rounded-lg border border-[var(--line)] bg-[var(--panel)] p-3 text-left hover:border-[color:color-mix(in_oklab,var(--brand)_45%,var(--line))] hover:bg-[var(--panel-soft)]">
                        <div className="flex items-start justify-between gap-2"><div className="font-semibold">#{incident.id} {incident.title || "Incident"}</div><StatusPill label={incident.status === "RESOLVED" ? "Resolved" : incident.status === "IN_PROGRESS" ? "In progress" : "New"} tone={incident.status === "RESOLVED" ? "good" : "bad"} /></div>
                        <div className="mt-1 text-xs text-muted">{projectLocationLabel({ district: incident.district, county: incident.county, route: incident.route, post_mile: incident.post_mile })}</div>
                        <div className="mt-2 text-xs font-medium">{classificationLabel(classification)}</div>
                      </button>
                    );
                  })}</div> : <div className="rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-4 text-sm text-muted">No Incidents are associated with this Project.</div>}
                </div>
              </div>
            ) : null}

            {mode === "INCIDENT" && selectedIncident && incidentGis ? (
              <div className="flex h-full flex-col">
                <div className="border-b border-[var(--line)] bg-[var(--panel-soft)] p-4">
                  <button type="button" onClick={backToProject} className="mb-3 rounded-md border border-[var(--line)] bg-[var(--panel)] px-2.5 py-1.5 text-xs font-semibold hover:bg-[var(--panel-soft)]">← Project Incidents</button>
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted">Incident GIS Evidence</div>
                  <div className="mt-1 text-lg font-semibold leading-snug">#{selectedIncident.id} {selectedIncident.title || "Incident"}</div>
                  <div className="mt-2 flex flex-wrap gap-2"><StatusPill label={selectedIncident.status === "RESOLVED" ? "Resolved" : selectedIncident.status === "IN_PROGRESS" ? "In progress" : "New"} tone={selectedIncident.status === "RESOLVED" ? "good" : "bad"} /><StatusPill label={classificationLabel(selectedClassification)} tone={selectedClassification?.confirmed ? "good" : "neutral"} /></div>
                  {classificationStateLabel(selectedClassification) ? <div className="mt-2 text-xs text-muted">{classificationStateLabel(selectedClassification)}</div> : null}
                </div>

                <div className="flex-1 overflow-auto p-4">
                  {loadingEvidence ? <div className="text-sm text-muted">Loading GIS evidence…</div> : null}
                  <dl className="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
                    <div><dt className="text-xs font-semibold uppercase tracking-wide text-muted">Incident location</dt><dd className="mt-1 font-medium tabular-nums">{formatCoordinate(incidentGis.incident.latitude)}, {formatCoordinate(incidentGis.incident.longitude)}</dd></div>
                    <div><dt className="text-xs font-semibold uppercase tracking-wide text-muted">Observed</dt><dd className="mt-1 font-medium">{formatTimestamp(incidentGis.incident.first_observed_at)}</dd></div>
                    <div><dt className="text-xs font-semibold uppercase tracking-wide text-muted">Saved geometry</dt><dd className="mt-1 font-medium">{incidentGis.geometry ? String((incidentGis.geometry as any).type || "Available") : "None recorded"}</dd></div>
                    <div><dt className="text-xs font-semibold uppercase tracking-wide text-muted">Linked submission</dt><dd className="mt-1 font-medium">{incidentGis.incident.linked_submission_id ? `#${incidentGis.incident.linked_submission_id}` : "Not created yet"}</dd></div>
                  </dl>

                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <div className="rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3"><div className="text-xs text-muted">Photos</div><div className="mt-1 text-xl font-semibold tabular-nums">{incidentGis.photo_summary.photos_total}</div></div>
                    <div className="rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3"><div className="text-xs text-muted">Mapped</div><div className="mt-1 text-xl font-semibold tabular-nums">{incidentGis.photo_summary.photos_geotagged}</div></div>
                    <div className="rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3"><div className="text-xs text-muted">Camera heading</div><div className="mt-1 text-xl font-semibold tabular-nums">{incidentGis.photo_summary.photos_with_heading}</div></div>
                    <div className="rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3"><div className="text-xs text-muted">Unmapped</div><div className="mt-1 text-xl font-semibold tabular-nums">{incidentGis.photo_summary.photos_unmapped}</div></div>
                  </div>

                  {incidentGis.incident.description ? <div className="mt-4 rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3"><div className="text-xs font-semibold uppercase tracking-wide text-muted">Report description</div><p className="mt-1 text-sm text-[var(--ink)]">{incidentGis.incident.description}</p></div> : null}

                  <div className="mt-5 flex flex-wrap gap-2">
                    {incidentGis.incident.linked_submission_id ? <button type="button" onClick={() => navigate(`/submissions/${incidentGis.incident.linked_submission_id}`)} className="rounded-md bg-[var(--brand)] px-3 py-2 text-sm font-semibold text-white hover:brightness-95">Open technical submission</button> : null}
                    {selectedProject ? <button type="button" onClick={() => navigate(`/projects/${selectedProject.id}`)} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-semibold hover:bg-[var(--panel-soft)]">Open Project</button> : null}
                  </div>

                  <div className="mt-5 border-t border-[var(--line)] pt-4">
                    <div className="text-xs font-semibold uppercase tracking-wide text-muted">Photo evidence</div>
                    {incidentGis.photos.length === 0 ? <div className="mt-2 text-sm text-muted">No field photo evidence is linked to this Incident.</div> : <div className="mt-3 space-y-3">{incidentGis.photos.map((photo) => {
                      const mapped = photo.latitude != null && photo.longitude != null;
                      return (
                        <a key={photo.attachment_id} href={photo.download_url} target="_blank" rel="noreferrer" className="flex gap-3 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-2.5 hover:bg-[var(--panel-soft)]">
                          {photo.mime_type.toLowerCase().startsWith("image/") ? <img src={photo.download_url} alt="" className="h-16 w-20 shrink-0 rounded object-cover" loading="lazy" /> : <div className="flex h-16 w-20 shrink-0 items-center justify-center rounded bg-[var(--panel-soft)] text-xs text-muted">FILE</div>}
                          <div className="min-w-0"><div className="truncate text-sm font-semibold">{photo.file_name}</div><div className="mt-1 text-xs text-muted">{mapped ? "Mapped" : "Unmapped"}{photo.camera_heading_deg != null ? ` · ${photo.camera_heading_deg.toFixed(1)}° camera heading` : " · No camera heading"}</div><div className="mt-1 text-xs text-muted">{formatTimestamp(photo.captured_at)}</div></div>
                        </a>
                      );
                    })}</div>}
                  </div>
                </div>
              </div>
            ) : null}
          </aside>
        </div>
      </div>
    </AppShell>
  );
}
