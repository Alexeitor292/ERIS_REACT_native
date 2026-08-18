import { useEffect, useState } from "react";

import { api } from "../../api/client";
import type { ProjectSummary } from "./projectTypes";

type Props = {
  project: ProjectSummary;
  onChanged: () => Promise<void> | void;
};

const inputClass = "w-full rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--brand)]";

export default function ProjectManagementPanel({ project, onChanged }: Props) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(project.title);
  const [description, setDescription] = useState(project.description ?? "");
  const [lifecycleAction, setLifecycleAction] = useState<"CLOSE" | "REOPEN" | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setTitle(project.title);
    setDescription(project.description ?? "");
  }, [project.description, project.title]);

  async function saveDetails() {
    if (!title.trim()) {
      setError("Project title is required.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api(`/projects/${project.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title: title.trim(), description: description.trim() }),
      });
      setEditing(false);
      setNotice("Project details updated.");
      await onChanged();
    } catch (e: any) {
      setError(e?.message ?? "Failed to update Project.");
    } finally {
      setBusy(false);
    }
  }

  async function applyLifecycleAction() {
    if (!lifecycleAction) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const endpoint = lifecycleAction === "CLOSE" ? "close" : "reopen";
      const response = await api<{ project: ProjectSummary; changed: boolean }>(`/projects/${project.id}/${endpoint}`, {
        method: "POST",
        body: JSON.stringify({ notes: notes.trim() || null }),
      });
      setLifecycleAction(null);
      setNotes("");
      setNotice(response.changed
        ? lifecycleAction === "CLOSE" ? "Project closed." : "Project reopened."
        : `Project is already ${response.project.status.toLowerCase()}.`);
      await onChanged();
    } catch (e: any) {
      setError(e?.message ?? `Failed to ${lifecycleAction === "CLOSE" ? "close" : "reopen"} Project.`);
    } finally {
      setBusy(false);
    }
  }

  const closeBlocked = project.status === "OPEN" && project.open_incident_count > 0;

  return (
    <section className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Project management</h2>
          <p className="mt-1 text-xs text-muted">Maintenance Coordinators and administrators can maintain the operational Project record.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              setEditing((value) => !value);
              setLifecycleAction(null);
              setError(null);
            }}
            disabled={busy || project.status === "ARCHIVED"}
            className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50"
          >
            {editing ? "Cancel edit" : "Edit details"}
          </button>
          {project.status === "OPEN" ? (
            <button
              type="button"
              onClick={() => {
                setLifecycleAction("CLOSE");
                setEditing(false);
                setError(null);
              }}
              disabled={busy || closeBlocked}
              title={closeBlocked ? `${project.open_incident_count} active Incident${project.open_incident_count === 1 ? "" : "s"} must be resolved before closure.` : undefined}
              className="rounded-md border border-[color:color-mix(in_oklab,var(--good)_45%,var(--line))] bg-[color:color-mix(in_oklab,var(--good)_8%,var(--panel))] px-3 py-2 text-sm font-semibold text-[var(--good)] hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-45"
            >
              Close Project
            </button>
          ) : project.status === "CLOSED" ? (
            <button
              type="button"
              onClick={() => {
                setLifecycleAction("REOPEN");
                setEditing(false);
                setError(null);
              }}
              disabled={busy}
              className="rounded-md bg-[var(--brand)] px-3 py-2 text-sm font-semibold text-white hover:brightness-95 disabled:opacity-50"
            >
              Reopen Project
            </button>
          ) : null}
        </div>
      </div>

      {closeBlocked ? (
        <div className="mt-3 rounded-md border border-[color:color-mix(in_oklab,var(--brand)_35%,var(--line))] bg-[color:color-mix(in_oklab,var(--brand)_7%,var(--panel))] px-3 py-2 text-sm text-muted">
          This Project still has <strong className="text-[var(--ink)]">{project.open_incident_count} active Incident{project.open_incident_count === 1 ? "" : "s"}</strong>. Resolve those Incidents before closing the Project.
        </div>
      ) : null}
      {project.status === "ARCHIVED" ? (
        <div className="mt-3 rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-2 text-sm text-muted">Archived legacy Projects are retained for provenance and are not editable or reopenable.</div>
      ) : null}
      {error ? <div className="mt-3 rounded-md border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-3 py-2 text-sm text-[var(--bad)]">{error}</div> : null}
      {notice ? <div className="mt-3 rounded-md border border-[color:color-mix(in_oklab,var(--good)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--good)_10%,transparent)] px-3 py-2 text-sm text-[var(--good)]">{notice}</div> : null}

      {editing ? (
        <div className="mt-4 grid gap-3 border-t border-[var(--line)] pt-4">
          <label className="grid gap-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted">Project title *</span>
            <input className={inputClass} value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label className="grid gap-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted">Description</span>
            <textarea rows={3} className={inputClass} value={description} onChange={(event) => setDescription(event.target.value)} />
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setEditing(false)} disabled={busy} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50">Cancel</button>
            <button type="button" onClick={saveDetails} disabled={busy || !title.trim()} className="rounded-md bg-[var(--brand)] px-4 py-2 text-sm font-semibold text-white hover:brightness-95 disabled:opacity-50">{busy ? "Saving…" : "Save Project"}</button>
          </div>
        </div>
      ) : null}

      {lifecycleAction ? (
        <div className="mt-4 grid gap-3 border-t border-[var(--line)] pt-4">
          <div>
            <div className="text-sm font-semibold">{lifecycleAction === "CLOSE" ? "Close this Project?" : "Reopen this Project?"}</div>
            <p className="mt-1 text-sm text-muted">
              {lifecycleAction === "CLOSE"
                ? "Closing removes the Project from the default open-Project worklist and from nearby association candidates. Its Incidents and history remain available."
                : "Reopening returns the Project to active worklists and makes it eligible for related Incident association again."}
            </p>
          </div>
          <label className="grid gap-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted">Lifecycle note</span>
            <textarea rows={3} className={inputClass} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Optional operational context" />
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => { setLifecycleAction(null); setNotes(""); }} disabled={busy} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50">Cancel</button>
            <button type="button" onClick={applyLifecycleAction} disabled={busy} className={`rounded-md px-4 py-2 text-sm font-semibold text-white hover:brightness-95 disabled:opacity-50 ${lifecycleAction === "CLOSE" ? "bg-[var(--good)]" : "bg-[var(--brand)]"}`}>{busy ? "Saving…" : lifecycleAction === "CLOSE" ? "Confirm closure" : "Confirm reopen"}</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
