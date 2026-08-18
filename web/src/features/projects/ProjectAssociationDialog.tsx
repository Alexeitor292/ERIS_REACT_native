import { useEffect, useMemo, useState } from "react";

import { api } from "../../api/client";
import ProjectAssociationMap from "./ProjectAssociationMap";
import type {
  IncidentProjectContext,
  NearbyProject,
  NearbyProjectsResponse,
  ProjectAssociationResponse,
  ProjectSummary,
} from "./projectTypes";
import { milesFromMeters, projectLocationLabel } from "./projectTypes";

type Props = {
  incidentId: number;
  onClose: () => void;
  onContinueToTriage: (incidentId: number) => void;
  onAssociated?: (project: ProjectSummary) => void;
};

const inputClass = "w-full rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--brand)]";

function generatedTitle(context: IncidentProjectContext | null): string {
  const incident = context?.incident;
  if (!incident) return "";
  const parts = [
    incident.route ? `Route ${incident.route}` : null,
    incident.post_mile ? `PM ${incident.post_mile}` : null,
    incident.county || null,
  ].filter(Boolean);
  return parts.length ? `${parts.join(" · ")} Project` : `Incident #${incident.id} Project`;
}

export default function ProjectAssociationDialog({ incidentId, onClose, onContinueToTriage, onAssociated }: Props) {
  const [context, setContext] = useState<IncidentProjectContext | null>(null);
  const [projects, setProjects] = useState<NearbyProject[]>([]);
  const [radiusMiles, setRadiusMiles] = useState(5);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [mode, setMode] = useState<"EXISTING" | "CREATE_NEW">("EXISTING");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load(nextRadiusMiles = radiusMiles) {
    setBusy(true);
    setError(null);
    try {
      const [contextResponse, nearbyResponse] = await Promise.all([
        api<IncidentProjectContext>(`/incidents/${incidentId}/project-context`),
        api<NearbyProjectsResponse>(
          `/incidents/${incidentId}/nearby-projects?radius_m=${Math.round(nextRadiusMiles * 1609.344)}&limit=50`
        ),
      ]);
      setContext(contextResponse);
      setProjects(nearbyResponse.items ?? []);
      if (contextResponse.project) {
        setMode("EXISTING");
        setSelectedProjectId(contextResponse.project.id);
      } else if (nearbyResponse.items?.length) {
        setMode("EXISTING");
        setSelectedProjectId((current) => current ?? nearbyResponse.items[0].id);
      } else {
        setMode("CREATE_NEW");
        setSelectedProjectId(null);
      }
      setTitle((current) => current || generatedTitle(contextResponse));
    } catch (e: any) {
      setError(e?.message ?? "Failed to load Project context.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    load(5);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incidentId]);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? (context?.project?.id === selectedProjectId ? context.project : null),
    [context?.project, projects, selectedProjectId]
  );

  async function associate() {
    if (!context?.can_change_association) return;
    if (mode === "EXISTING" && !selectedProjectId) {
      setError("Select an existing Project first.");
      return;
    }
    if (mode === "CREATE_NEW" && !title.trim()) {
      setError("Project title is required.");
      return;
    }

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await api<ProjectAssociationResponse>(`/incidents/${incidentId}/project-association`, {
        method: "POST",
        body: JSON.stringify(
          mode === "EXISTING"
            ? {
                mode,
                project_id: selectedProjectId,
                notes: notes.trim() || null,
              }
            : {
                mode,
                title: title.trim(),
                description: description.trim() || null,
                notes: notes.trim() || null,
              }
        ),
      });
      onAssociated?.(response.project);
      setSelectedProjectId(response.project.id);
      setMode("EXISTING");
      setNotice(response.created ? "Project created and incident associated." : "Incident associated with the selected Project.");
      await load(radiusMiles);
    } catch (e: any) {
      setError(e?.message ?? "Failed to associate Project.");
    } finally {
      setBusy(false);
    }
  }

  const currentProjectId = context?.project?.id ?? null;
  const associationChanged = mode === "CREATE_NEW" || (mode === "EXISTING" && selectedProjectId != null && selectedProjectId !== currentProjectId);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-3 md:p-6" role="dialog" aria-modal="true" aria-label={`Project association for incident ${incidentId}`}>
      <div className="flex max-h-[94vh] w-full max-w-[1500px] flex-col overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--panel)] shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-[var(--line)] px-5 py-4">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Coordinator review</div>
            <h2 className="mt-1 text-xl font-semibold">Choose the Project for Incident #{incidentId}</h2>
            <p className="mt-1 max-w-4xl text-sm text-muted">
              Compare the reported location with nearby Projects and their existing incidents. Incident classification remains unassigned until the on-site assessment is completed.
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)]">Close</button>
        </div>

        <div className="flex-1 overflow-auto p-4 md:p-5">
          {error ? <div className="mb-4 rounded-md border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-3 py-2 text-sm text-[var(--bad)]">{error}</div> : null}
          {notice ? <div className="mb-4 rounded-md border border-[color:color-mix(in_oklab,var(--good)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--good)_10%,transparent)] px-3 py-2 text-sm text-[var(--good)]">{notice}</div> : null}

          {!context ? (
            <div className="py-16 text-center text-sm text-muted">{busy ? "Loading Project context…" : "Project context unavailable."}</div>
          ) : (
            <div className="grid gap-5 xl:grid-cols-[minmax(0,1.7fr)_minmax(360px,0.8fr)]">
              <div className="space-y-4">
                <div className="grid gap-3 md:grid-cols-4">
                  <div className="rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3">
                    <div className="text-xs uppercase tracking-wide text-muted">Reported location</div>
                    <div className="mt-1 text-sm font-semibold">{projectLocationLabel({ district: context.incident.district, county: context.incident.county, route: context.incident.route, post_mile: context.incident.post_mile })}</div>
                  </div>
                  <div className="rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3">
                    <div className="text-xs uppercase tracking-wide text-muted">Coordinates</div>
                    <div className="mt-1 text-sm font-semibold tabular-nums">{context.incident.latitude.toFixed(6)}, {context.incident.longitude.toFixed(6)}</div>
                  </div>
                  <div className="rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3">
                    <div className="text-xs uppercase tracking-wide text-muted">Classification</div>
                    <div className="mt-1 text-sm font-semibold">Unclassified</div>
                    <div className="mt-0.5 text-xs text-muted">Set after field assessment</div>
                  </div>
                  <div className="rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3">
                    <div className="text-xs uppercase tracking-wide text-muted">Current Project</div>
                    <div className="mt-1 truncate text-sm font-semibold">{context.project?.title ?? "Not assigned"}</div>
                  </div>
                </div>

                <ProjectAssociationMap
                  incident={context.incident}
                  projects={projects}
                  selectedProjectId={mode === "EXISTING" ? selectedProjectId : null}
                  onSelectProject={(projectId) => {
                    setMode("EXISTING");
                    setSelectedProjectId(projectId);
                  }}
                />
              </div>

              <div className="space-y-4">
                <div className="rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold">Nearby Projects</div>
                      <div className="mt-0.5 text-xs text-muted">Open Projects ranked by nearest existing incident.</div>
                    </div>
                    <select
                      value={radiusMiles}
                      disabled={busy}
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        setRadiusMiles(next);
                        load(next);
                      }}
                      className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-2 py-1.5 text-xs"
                    >
                      <option value={5}>5 miles</option>
                      <option value={10}>10 miles</option>
                      <option value={25}>25 miles</option>
                      <option value={50}>50 miles</option>
                    </select>
                  </div>

                  <div className="mt-3 max-h-72 space-y-2 overflow-auto pr-1">
                    {projects.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-[var(--line)] bg-[var(--panel)] px-3 py-5 text-sm text-muted">No open Projects were found in this search radius.</div>
                    ) : (
                      projects.map((project) => (
                        <button
                          key={project.id}
                          type="button"
                          onClick={() => {
                            setMode("EXISTING");
                            setSelectedProjectId(project.id);
                          }}
                          className={`w-full rounded-lg border p-3 text-left transition ${mode === "EXISTING" && selectedProjectId === project.id ? "border-[var(--brand)] bg-[color:color-mix(in_oklab,var(--brand)_10%,var(--panel))]" : "border-[var(--line)] bg-[var(--panel)] hover:bg-[var(--panel-soft)]"}`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-semibold">{project.title}</div>
                              <div className="mt-1 text-xs text-muted">{projectLocationLabel(project)}</div>
                            </div>
                            <div className="shrink-0 text-xs font-semibold text-[var(--brand)]">{milesFromMeters(project.nearest_distance_m)}</div>
                          </div>
                          <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted">
                            <span>{project.incident_count} incident{project.incident_count === 1 ? "" : "s"}</span>
                            <span>·</span>
                            <span>{project.open_incident_count} active</span>
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                </div>

                <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">
                  <div className="grid grid-cols-2 gap-2 rounded-lg bg-[var(--panel-soft)] p-1">
                    <button type="button" onClick={() => setMode("EXISTING")} className={`rounded-md px-3 py-2 text-sm font-semibold ${mode === "EXISTING" ? "bg-[var(--panel)] shadow-sm" : "text-muted"}`}>Existing Project</button>
                    <button type="button" onClick={() => setMode("CREATE_NEW")} className={`rounded-md px-3 py-2 text-sm font-semibold ${mode === "CREATE_NEW" ? "bg-[var(--panel)] shadow-sm" : "text-muted"}`}>Create new</button>
                  </div>

                  {mode === "EXISTING" ? (
                    <div className="mt-4">
                      {selectedProject ? (
                        <div className="rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3">
                          <div className="text-sm font-semibold">{selectedProject.title}</div>
                          <div className="mt-1 text-xs text-muted">{projectLocationLabel(selectedProject)}</div>
                          {selectedProject.description ? <p className="mt-2 text-sm text-muted">{selectedProject.description}</p> : null}
                        </div>
                      ) : (
                        <div className="rounded-lg border border-dashed border-[var(--line)] p-4 text-sm text-muted">Select a Project from the map or nearby list.</div>
                      )}
                    </div>
                  ) : (
                    <div className="mt-4 grid gap-3">
                      <label className="grid gap-1.5 text-sm">
                        <span className="text-xs font-semibold uppercase tracking-wide text-muted">Project title *</span>
                        <input className={inputClass} value={title} onChange={(event) => setTitle(event.target.value)} />
                      </label>
                      <label className="grid gap-1.5 text-sm">
                        <span className="text-xs font-semibold uppercase tracking-wide text-muted">Description</span>
                        <textarea className={`${inputClass} min-h-20`} value={description} onChange={(event) => setDescription(event.target.value)} />
                      </label>
                    </div>
                  )}

                  <label className="mt-3 grid gap-1.5 text-sm">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted">Coordinator note</span>
                    <textarea className={`${inputClass} min-h-16`} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Why this Project matches the incident (optional)" />
                  </label>

                  {context.can_change_association ? (
                    <button
                      type="button"
                      onClick={associate}
                      disabled={busy || !associationChanged || (mode === "EXISTING" && !selectedProjectId) || (mode === "CREATE_NEW" && !title.trim())}
                      className="mt-4 w-full rounded-md bg-[var(--brand)] px-4 py-2.5 text-sm font-semibold text-white hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {busy ? "Saving…" : mode === "CREATE_NEW" ? "Create Project and associate" : currentProjectId === selectedProjectId ? "Project already assigned" : "Associate with selected Project"}
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--line)] bg-[var(--panel-soft)] px-5 py-4">
          <div className="text-sm text-muted">
            {context?.project ? `Incident belongs to ${context.project.title}.` : "A Project association is required before triage can advance this incident."}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)]">Close</button>
            <button
              type="button"
              onClick={() => onContinueToTriage(incidentId)}
              disabled={!context?.project || busy}
              className="rounded-md bg-[var(--brand)] px-4 py-2 text-sm font-semibold text-white hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Continue to triage
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
