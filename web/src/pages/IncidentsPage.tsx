import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { api } from "../api/client";
import { triageIncident, type TriageDisposition } from "../api/assessments";
import { WorkflowTreeModal } from "../components/WorkflowTree";
import type { AdminUser, Incident, IncidentStatus } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { canTriage } from "../utils/roleModel";
import AppShell from "../ui/AppShell";
import { formatCoordinate, normalizeCoordinateValue, normalizePostMileInput, normalizePostMileValue, normalizeRouteInput, normalizeRouteValue } from "../utils/precision";

type IncidentCreateForm = {
  title: string;
  incident_type: string;
  description: string;
  first_observed_at: string;
  first_occurred_at: string;
  latitude: string;
  longitude: string;
  district: string;
  county: string;
  route: string;
  post_mile: string;
};

const EMPTY_FORM: IncidentCreateForm = {
  title: "",
  incident_type: "",
  description: "",
  first_observed_at: "",
  first_occurred_at: "",
  latitude: "",
  longitude: "",
  district: "",
  county: "",
  route: "",
  post_mile: "",
};

type IncidentAttachmentKind = "PHOTO" | "VIDEO" | "DOC" | "SKETCH";

type PendingIncidentUpload = {
  file: File;
  kind: IncidentAttachmentKind;
};

function inferIncidentAttachmentKind(name: string, mimeType: string): IncidentAttachmentKind {
  const mime = (mimeType || "").toLowerCase();
  if (mime === "image/png" && /sketch/i.test(name)) return "SKETCH";
  if (mime.startsWith("image/")) return "PHOTO";
  if (mime.startsWith("video/")) return "VIDEO";
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (ext === "png" && /sketch/i.test(name)) return "SKETCH";
  if (["jpg", "jpeg", "png", "heic", "heif", "gif", "webp"].includes(ext)) return "PHOTO";
  if (["mp4", "mov", "m4v", "avi", "mkv", "webm"].includes(ext)) return "VIDEO";
  return "DOC";
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function statusBadgeClass(status: IncidentStatus) {
  if (status === "NEW") return "border-red-500/40 bg-red-500/15 text-red-300";
  if (status === "IN_PROGRESS") return "border-amber-500/50 bg-amber-500/15 text-amber-300";
  return "border-emerald-500/40 bg-emerald-500/15 text-emerald-300";
}

export default function IncidentsPage() {
  const { me } = useAuth();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const isAdmin = !!me?.roles?.includes("ADMIN");

  const [items, setItems] = useState<Incident[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [assignByIncidentId, setAssignByIncidentId] = useState<Record<number, string>>({});
  const [statusFilter, setStatusFilter] = useState<"ALL" | IncidentStatus>("ALL");
  const [unclaimedOnly, setUnclaimedOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState<IncidentCreateForm>(EMPTY_FORM);
  const [pendingFiles, setPendingFiles] = useState<PendingIncidentUpload[]>([]);
  const [workflowIncidentId, setWorkflowIncidentId] = useState<number | null>(null);

  async function load() {
    setBusy(true);
    setError(null);
    try {
      const query = new URLSearchParams();
      if (statusFilter !== "ALL") query.set("status", statusFilter);
      if (unclaimedOnly) query.set("unclaimed_only", "true");
      const suffix = query.toString() ? `?${query.toString()}` : "";
      const res = await api<{ items: Incident[] }>(`/incidents${suffix}`);
      setItems(res.items ?? []);

      if (isAdmin) {
        const usersRes = await api<{ items: AdminUser[] }>("/admin/users");
        setUsers(usersRes.items ?? []);
      }
    } catch (e: any) {
      setError(e?.message ?? "Failed to load incidents.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, unclaimedOnly]);

  const assignableUsers = useMemo(
    () => users.filter((u) => u.is_active && (u.roles.includes("FIELD_WORKER") || u.roles.includes("ADMIN"))),
    [users]
  );

  function addPendingFiles(files: FileList | null) {
    if (!files?.length) return;
    const next = Array.from(files).map((file) => ({
      file,
      kind: inferIncidentAttachmentKind(file.name, file.type),
    }));
    setPendingFiles((prev) => [...prev, ...next]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removePendingFile(index: number) {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function resetCreateIncidentForm() {
    setForm(EMPTY_FORM);
    setPendingFiles([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function uploadPendingIncidentFiles(incidentId: number) {
    const failures: string[] = [];
    for (const pending of pendingFiles) {
      const formData = new FormData();
      formData.append("file", pending.file, pending.file.name);
      const query = new URLSearchParams({ kind: pending.kind }).toString();
      try {
        await api(`/incidents/${incidentId}/attachments?${query}`, {
          method: "POST",
          body: formData,
        });
      } catch (e: any) {
        failures.push(`${pending.file.name}: ${e?.message ?? "Upload failed"}`);
      }
    }
    return failures;
  }

  async function createIncident() {
    setNotice(null);
    if (!form.title.trim()) {
      setError("Incident title is required.");
      return;
    }
    if (!form.first_observed_at.trim()) {
      setError("First observed date/time is required.");
      return;
    }
    const lat = normalizeCoordinateValue(form.latitude);
    const lon = normalizeCoordinateValue(form.longitude);
    if (lat == null || lon == null) {
      setError("Latitude and longitude must be valid numbers.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const selectedFileCount = pendingFiles.length;
      const created = await api<{ incident: Incident }>("/incidents", {
        method: "POST",
        body: JSON.stringify({
          title: form.title.trim(),
          incident_type: form.incident_type.trim() || null,
          description: form.description.trim() || null,
          first_observed_at: form.first_observed_at,
          first_occurred_at: form.first_occurred_at.trim() || null,
          latitude: lat,
          longitude: lon,
          district: form.district.trim() || null,
          county: form.county.trim() || null,
          route: normalizeRouteValue(form.route),
          post_mile: normalizePostMileValue(form.post_mile),
        }),
      });
      const uploadFailures = await uploadPendingIncidentFiles(created.incident.id);
      resetCreateIncidentForm();
      await load();
      if (selectedFileCount > 0) {
        const uploadedCount = selectedFileCount - uploadFailures.length;
        setNotice(
          uploadFailures.length
            ? `Incident created. ${uploadedCount} of ${selectedFileCount} files uploaded. ${uploadFailures.slice(0, 2).join(" ")}`
            : `Incident created with ${selectedFileCount} attached file${selectedFileCount === 1 ? "" : "s"}.`
        );
      } else {
        setNotice("Incident created.");
      }
    } catch (e: any) {
      setError(e?.message ?? "Failed to create incident.");
    } finally {
      setBusy(false);
    }
  }

  async function assignIncident(incidentId: number) {
    const assignee = Number(assignByIncidentId[incidentId]);
    if (!assignee) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ linked_submission_id: number }>(`/incidents/${incidentId}/assign`, {
        method: "POST",
        body: JSON.stringify({ assignee_user_id: assignee }),
      });
      await load();
      if (res.linked_submission_id) navigate(`/submissions/${res.linked_submission_id}`);
    } catch (e: any) {
      setError(e?.message ?? "Assign failed.");
    } finally {
      setBusy(false);
    }
  }

  async function unassignIncident(incidentId: number) {
    setBusy(true);
    setError(null);
    try {
      await api(`/incidents/${incidentId}/unassign`, { method: "POST" });
      await load();
    } catch (e: any) {
      setError(e?.message ?? "Unassign failed.");
    } finally {
      setBusy(false);
    }
  }

  async function resolveIncident(incidentId: number) {
    const comment = prompt("Resolution comment (optional):") ?? "";
    setBusy(true);
    setError(null);
    try {
      await api(`/incidents/${incidentId}/resolve`, {
        method: "POST",
        body: JSON.stringify({ comment: comment.trim() || null }),
      });
      await load();
    } catch (e: any) {
      setError(e?.message ?? "Resolve failed.");
    } finally {
      setBusy(false);
    }
  }

  async function triageIncidentAction(incidentId: number) {
    // Coordinator triage. The backend records an immutable timeline event and,
    // for ASSESSMENT_REQUIRED, routes by district and creates the Assessment.
    const raw = prompt(
      "Triage disposition:\n1 = ASSESSMENT_REQUIRED\n2 = NO_ASSESSMENT_REQUIRED\n3 = NEEDS_REPORTER_INFORMATION\n4 = DUPLICATE_OR_LINKED",
      "1"
    );
    if (!raw) return;
    const map: Record<string, TriageDisposition> = {
      "1": "ASSESSMENT_REQUIRED",
      "2": "NO_ASSESSMENT_REQUIRED",
      "3": "NEEDS_REPORTER_INFORMATION",
      "4": "DUPLICATE_OR_LINKED",
    };
    const disposition = map[raw.trim()];
    if (!disposition) {
      setError("Invalid triage disposition.");
      return;
    }
    const notes = prompt("Decision notes (recorded in the timeline):") ?? "";
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await triageIncident(incidentId, { disposition, notes: notes.trim() || undefined });
      setNotice(`Triage recorded: ${disposition}.`);
      await load();
    } catch (e: any) {
      setError(e?.message ?? "Triage failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell title="Incidents">
      <div className="flex h-full flex-col gap-4 p-4 md:p-5">
        <div className="grid gap-3 rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] p-3 md:grid-cols-3">
          <input
            className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm"
            placeholder="Title *"
            value={form.title}
            onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
          />
          <input
            className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm"
            placeholder="Incident Type"
            value={form.incident_type}
            onChange={(e) => setForm((prev) => ({ ...prev, incident_type: e.target.value }))}
          />
          <input
            className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm"
            placeholder="Description"
            value={form.description}
            onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
          />
          <input
            type="datetime-local"
            className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm"
            value={form.first_observed_at}
            onChange={(e) => setForm((prev) => ({ ...prev, first_observed_at: e.target.value }))}
          />
          <input
            type="datetime-local"
            className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm"
            value={form.first_occurred_at}
            onChange={(e) => setForm((prev) => ({ ...prev, first_occurred_at: e.target.value }))}
          />
          <input
            type="number"
            step="0.000001"
            inputMode="decimal"
            className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm"
            placeholder="Latitude *"
            value={form.latitude}
            onChange={(e) => setForm((prev) => ({ ...prev, latitude: e.target.value }))}
            onBlur={() => setForm((prev) => ({ ...prev, latitude: formatCoordinate(prev.latitude) }))}
          />
          <input
            type="number"
            step="0.000001"
            inputMode="decimal"
            className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm"
            placeholder="Longitude *"
            value={form.longitude}
            onChange={(e) => setForm((prev) => ({ ...prev, longitude: e.target.value }))}
            onBlur={() => setForm((prev) => ({ ...prev, longitude: formatCoordinate(prev.longitude) }))}
          />
          <input
            className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm"
            placeholder="District"
            value={form.district}
            onChange={(e) => setForm((prev) => ({ ...prev, district: e.target.value }))}
          />
          <input
            className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm"
            placeholder="County"
            value={form.county}
            onChange={(e) => setForm((prev) => ({ ...prev, county: e.target.value }))}
          />
          <input
            className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm"
            placeholder="Route"
            value={form.route}
            onChange={(e) => setForm((prev) => ({ ...prev, route: e.target.value }))}
            onBlur={() => setForm((prev) => ({ ...prev, route: normalizeRouteInput(prev.route) }))}
          />
          <input
            className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm"
            placeholder="Post Mile"
            value={form.post_mile}
            onChange={(e) => setForm((prev) => ({ ...prev, post_mile: e.target.value }))}
            onBlur={() => setForm((prev) => ({ ...prev, post_mile: normalizePostMileInput(prev.post_mile) }))}
          />
          <div className="grid gap-2 md:col-span-3">
            <label className="text-xs font-semibold uppercase text-muted">Supporting Files</label>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              disabled={busy}
              onChange={(e) => addPendingFiles(e.currentTarget.files)}
              className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-[var(--panel-soft)] file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-[var(--ink)]"
            />
            <div className="text-xs text-muted">
              Add photos, videos, PDFs, CAD, or other supporting files. They upload after the incident is created.
            </div>
            {pendingFiles.length > 0 ? (
              <div className="grid gap-1.5">
                {pendingFiles.map((pending, index) => {
                  const sizeLabel = formatFileSize(pending.file.size);
                  return (
                    <div
                      key={`${pending.file.name}-${pending.file.lastModified}-${index}`}
                      className="flex items-center justify-between gap-3 rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-semibold">{pending.file.name}</div>
                        <div className="text-xs text-muted">
                          {sizeLabel ? `${pending.kind} - ${sizeLabel}` : pending.kind}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => removePendingFile(index)}
                        disabled={busy}
                        className="rounded border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-1 text-xs hover:brightness-95 disabled:opacity-60"
                      >
                        Remove
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
          <button
            onClick={createIncident}
            disabled={busy}
            className="rounded-md bg-[var(--brand)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-60 md:col-span-3"
          >
            Create Incident
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as any)}
            className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm"
          >
            <option value="ALL">All Statuses</option>
            <option value="NEW">NEW</option>
            <option value="IN_PROGRESS">IN_PROGRESS</option>
            <option value="RESOLVED">RESOLVED</option>
          </select>
          <label className="inline-flex items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm">
            <input type="checkbox" checked={unclaimedOnly} onChange={(e) => setUnclaimedOnly(e.target.checked)} />
            Unclaimed Only
          </label>
          <button
            onClick={load}
            className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm hover:brightness-95"
          >
            Refresh
          </button>
        </div>

        {error ? (
          <div className="rounded-md border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm text-red-200">{error}</div>
        ) : null}

        {notice ? (
          <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">{notice}</div>
        ) : null}

        <div className="flex-1 overflow-auto rounded-xl border border-[var(--line)] bg-[var(--panel)]">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-[var(--line)] text-left text-xs font-semibold uppercase tracking-wide text-muted">
                <th className="px-3 py-2">ID</th>
                <th className="px-3 py-2">Incident</th>
                <th className="px-3 py-2">Location</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Assignment</th>
                <th className="px-3 py-2">Linked Draft</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td className="px-3 py-6 text-sm text-muted" colSpan={7}>
                    {busy ? "Loading incidents..." : "No incidents yet."}
                  </td>
                </tr>
              ) : (
                items.map((incident) => (
                  <tr key={incident.id} className="border-b border-[var(--line)]/60 align-top">
                    <td className="px-3 py-3 text-sm font-semibold">{incident.id}</td>
                    <td className="px-3 py-3 text-sm">
                      <div className="font-semibold">{incident.title}</div>
                      <div className="text-xs text-muted">{incident.incident_type || "-"}</div>
                    </td>
                    <td className="px-3 py-3 text-sm text-muted">
                      {formatCoordinate(incident.latitude)}, {formatCoordinate(incident.longitude)}
                    </td>
                    <td className="px-3 py-3 text-sm">
                      <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${statusBadgeClass(incident.status)}`}>
                        {incident.status}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-sm text-muted">
                      {incident.assignment ? incident.assignment.assignee_name || incident.assignment.assignee_email : "Unassigned"}
                    </td>
                    <td className="px-3 py-3 text-sm">
                      {incident.linked_submission_id ? (
                        <button
                          onClick={() => navigate(`/submissions/${incident.linked_submission_id}`)}
                          className="rounded border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-1 text-xs hover:brightness-95"
                        >
                          Open #{incident.linked_submission_id}
                        </button>
                      ) : (
                        <span className="text-muted">-</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right">
                      <div className="inline-flex flex-wrap justify-end gap-1.5">
                        <button
                          onClick={() => setWorkflowIncidentId(incident.id)}
                          className="rounded border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-1 text-xs font-semibold hover:brightness-95"
                          title="View workflow"
                        >
                          Workflow
                        </button>
                        {canTriage(me?.roles) && incident.current_stage === "COORDINATOR_REVIEW" ? (
                          <button
                            onClick={() => triageIncidentAction(incident.id)}
                            className="rounded border border-sky-500/50 bg-sky-500/15 px-2 py-1 text-xs font-semibold text-sky-200 hover:brightness-95"
                          >
                            Triage
                          </button>
                        ) : null}
                        {isAdmin ? (
                          <>
                            <select
                              value={assignByIncidentId[incident.id] ?? ""}
                              onChange={(e) =>
                                setAssignByIncidentId((prev) => ({ ...prev, [incident.id]: e.target.value }))
                              }
                              className="rounded border border-[var(--line)] bg-[var(--panel)] px-2 py-1 text-xs"
                            >
                              <option value="">Assign user...</option>
                              {assignableUsers.map((u) => (
                                <option key={u.id} value={String(u.id)}>
                                  {u.full_name}
                                </option>
                              ))}
                            </select>
                            <button
                              onClick={() => assignIncident(incident.id)}
                              className="rounded border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-1 text-xs hover:brightness-95"
                            >
                              Assign
                            </button>
                            <button
                              onClick={() => unassignIncident(incident.id)}
                              className="rounded border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-1 text-xs hover:brightness-95"
                            >
                              Unassign
                            </button>
                          </>
                        ) : null}
                        {incident.status !== "RESOLVED" ? (
                          <button
                            onClick={() => resolveIncident(incident.id)}
                            className="rounded border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-1 text-xs hover:brightness-95"
                          >
                            Resolve
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      {workflowIncidentId != null ? (
        <WorkflowTreeModal incidentId={workflowIncidentId} onClose={() => setWorkflowIncidentId(null)} />
      ) : null}
    </AppShell>
  );
}
