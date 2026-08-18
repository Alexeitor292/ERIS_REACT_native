import { useEffect, useMemo, useState } from "react";

import {
  createCrossSectionProject,
  createSavedCrossSection,
  updateSavedCrossSection,
  listCrossSectionProjects,
  type CrossSectionProject,
  type SavedCrossSectionDetail,
} from "../../api/terrainCrossSections";
import type { CrossSectionProfile } from "./terrainCrossSectionModel";

type DraftPoint = {
  latitude: number;
  longitude: number;
  distance_m: number | null;
  elevation_m: number | null;
};

type Props = {
  draftPoints: DraftPoint[];
  profile: CrossSectionProfile | null;
  preferredSpacingM: number;
  actualSpacingM: number | null;
  currentSaved: SavedCrossSectionDetail | null;
  onClose: () => void;
  onSaved: (crossSection: SavedCrossSectionDetail) => void;
};

function projectLabel(project: CrossSectionProject) {
  return project.project_number ? `${project.project_number} · ${project.title}` : project.title;
}

export default function CrossSectionSaveDialog({
  draftPoints,
  profile,
  preferredSpacingM,
  actualSpacingM,
  currentSaved,
  onClose,
  onSaved,
}: Props) {
  const [projects, setProjects] = useState<CrossSectionProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(currentSaved?.project_id ?? null);
  const [name, setName] = useState(currentSaved?.name ?? "Cross Section");
  const [notes, setNotes] = useState(currentSaved?.notes ?? "");
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [projectNumber, setProjectNumber] = useState("");
  const [projectTitle, setProjectTitle] = useState("");
  const [projectDistrict, setProjectDistrict] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    listCrossSectionProjects()
      .then((response) => {
        if (cancelled) return;
        setProjects(response.items);
        setSelectedProjectId((current) => current ?? response.items[0]?.id ?? null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load Projects.");
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? currentSaved?.project ?? null,
    [currentSaved?.project, projects, selectedProjectId],
  );

  async function createProject() {
    if (!projectTitle.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const response = await createCrossSectionProject({
        project_number: projectNumber.trim() || null,
        title: projectTitle.trim(),
        district: projectDistrict.trim() || null,
      });
      setProjects((current) => [response.project, ...current]);
      setSelectedProjectId(response.project.id);
      setShowCreateProject(false);
      setProjectNumber("");
      setProjectTitle("");
      setProjectDistrict("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create Project.");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (selectedProjectId == null || draftPoints.length < 2 || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const payload = {
        project_id: selectedProjectId,
        name: name.trim(),
        notes: notes.trim() || null,
        preferred_spacing_m: preferredSpacingM,
        actual_spacing_m: actualSpacingM,
        dem_source: "ARCGIS_WORLD_ELEVATION",
        control_points: draftPoints,
        profile_snapshot: profile,
      };
      const response = currentSaved
        ? await updateSavedCrossSection(currentSaved.id, payload)
        : await createSavedCrossSection(payload);
      onSaved(response.cross_section);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save cross section.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[140] flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm" role="dialog" aria-modal="true">
      <div className="w-full max-w-3xl overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--panel)] text-[var(--ink)] shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-[var(--line)] px-5 py-4">
          <div>
            <div className="text-base font-semibold">{currentSaved ? "Update cross section" : "Save cross section"}</div>
            <div className="mt-1 text-xs text-muted">Choose the Project this cross section belongs to.</div>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm font-semibold">Close</button>
        </div>

        <div className="grid gap-5 p-5 md:grid-cols-2">
          <section>
            <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Project</div>
            <select
              value={selectedProjectId ?? ""}
              onChange={(event) => setSelectedProjectId(event.target.value ? Number(event.target.value) : null)}
              className="mt-2 w-full rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-2.5 text-sm"
            >
              <option value="">Choose a Project</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{projectLabel(project)}</option>)}
            </select>

            <button type="button" onClick={() => setShowCreateProject((current) => !current)} className="mt-3 text-sm font-semibold text-[var(--brand)]">
              {showCreateProject ? "Cancel new Project" : "+ Create Project"}
            </button>

            {showCreateProject ? (
              <div className="mt-3 space-y-2 rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3">
                <input value={projectNumber} onChange={(event) => setProjectNumber(event.target.value)} placeholder="Project number" className="w-full rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" />
                <input value={projectTitle} onChange={(event) => setProjectTitle(event.target.value)} placeholder="Project title" className="w-full rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" />
                <input value={projectDistrict} onChange={(event) => setProjectDistrict(event.target.value)} placeholder="District" className="w-full rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" />
                <button type="button" disabled={busy || !projectTitle.trim()} onClick={() => void createProject()} className="w-full rounded-md bg-[var(--brand)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">Create and select</button>
              </div>
            ) : null}

            {selectedProject ? <div className="mt-4 rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3 text-sm"><div className="font-semibold">{projectLabel(selectedProject)}</div>{selectedProject.district ? <div className="mt-1 text-xs text-muted">District {selectedProject.district}</div> : null}</div> : null}
          </section>

          <section className="space-y-4">
            {error ? <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">{error}</div> : null}
            <div>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Name</label>
              <input value={name} onChange={(event) => setName(event.target.value)} className="mt-2 w-full rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-2.5 text-sm" />
            </div>
            <div>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Notes</label>
              <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={4} className="mt-2 w-full resize-none rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-2.5 text-sm" />
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <Metric label="Points" value={String(draftPoints.length)} />
              <Metric label="Samples" value={profile ? String(profile.stats.sample_count) : "—"} />
              <Metric label="Spacing" value={actualSpacingM == null ? `${preferredSpacingM} m` : `${actualSpacingM} m`} />
            </div>
            <button type="button" disabled={busy || selectedProjectId == null || draftPoints.length < 2 || !name.trim()} onClick={() => void save()} className="w-full rounded-lg bg-[var(--brand)] px-4 py-3 text-sm font-semibold text-white disabled:opacity-50">
              {busy ? "Saving…" : currentSaved ? "Update cross section" : "Save to Project"}
            </button>
          </section>
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-2"><div className="text-[10px] uppercase tracking-[0.1em] text-muted">{label}</div><div className="mt-1 text-sm font-semibold">{value}</div></div>;
}
