import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { api } from "../../api/client";
import { triageIncident } from "../../api/assessments";
import type { AdminUser, Incident, IncidentStatus } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import { WorkflowTreeModal } from "../../components/WorkflowTree";
import AppShell from "../../ui/AppShell";
import { formatCoordinate, normalizeCoordinateValue, normalizePostMileValue, normalizeRouteValue } from "../../utils/precision";
import { canTriage } from "../../utils/roleModel";
import IncidentCreatePanel from "./IncidentCreatePanel";
import type { IncidentClassification, IncidentClassificationQueryResponse } from "./incidentClassification";
import { classificationLabel, classificationStateLabel } from "./incidentClassification";
import {
  IncidentResolveDialog,
  IncidentTriageDialog,
  type ResolveDialogState,
  type TriageDialogState,
} from "./IncidentDecisionDialogs";
import {
  EMPTY_INCIDENT_FORM,
  incidentStatusBadgeClass,
  incidentStatusLabel,
  inferIncidentAttachmentKind,
  type IncidentCreateForm,
  type PendingIncidentUpload,
} from "./incidentUiModel";

function IncidentStatusBadge({ status }: { status: IncidentStatus }) {
  return (
    <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${incidentStatusBadgeClass(status)}`}>
      {incidentStatusLabel(status)}
    </span>
  );
}

function IncidentClassificationText({ classification }: { classification: IncidentClassification | undefined }) {
  const stateLabel = classificationStateLabel(classification);
  return (
    <div>
      <div className="text-xs text-muted">{classificationLabel(classification)}</div>
      {stateLabel ? <div className={`mt-0.5 text-[11px] font-semibold ${classification?.confirmed ? "text-[var(--good)]" : "text-[var(--brand)]"}`}>{stateLabel}</div> : null}
    </div>
  );
}

export default function IncidentsOperationsPage() {
  const { me } = useAuth();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const isAdmin = !!me?.roles?.includes("ADMIN");

  const [items, setItems] = useState<Incident[]>([]);
  const [classifications, setClassifications] = useState<Record<number, IncidentClassification>>({});
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [assignByIncidentId, setAssignByIncidentId] = useState<Record<number, string>>({});
  const [statusFilter, setStatusFilter] = useState<"ALL" | IncidentStatus>("ALL");
  const [unclaimedOnly, setUnclaimedOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState<IncidentCreateForm>(EMPTY_INCIDENT_FORM);
  const [pendingFiles, setPendingFiles] = useState<PendingIncidentUpload[]>([]);
  const [workflowIncidentId, setWorkflowIncidentId] = useState<number | null>(null);
  const [createPanelOpen, setCreatePanelOpen] = useState(false);
  const [triageDialog, setTriageDialog] = useState<TriageDialogState | null>(null);
  const [resolveDialog, setResolveDialog] = useState<ResolveDialogState | null>(null);

  async function load() {
    setBusy(true);
    setError(null);
    try {
      const query = new URLSearchParams();
      if (statusFilter !== "ALL") query.set("status", statusFilter);
      if (unclaimedOnly) query.set("unclaimed_only", "true");
      const suffix = query.toString() ? `?${query.toString()}` : "";
      const response = await api<{ items: Incident[] }>(`/incidents${suffix}`);
      const nextItems = response.items ?? [];

      const [classificationResponse, usersResponse] = await Promise.all([
        api<IncidentClassificationQueryResponse>("/incident-classifications/query", {
          method: "POST",
          body: JSON.stringify({ incident_ids: nextItems.map((incident) => incident.id) }),
        }),
        isAdmin ? api<{ items: AdminUser[] }>("/admin/users") : Promise.resolve(null),
      ]);

      setItems(nextItems);
      setClassifications(
        Object.fromEntries((classificationResponse.items ?? []).map((classification) => [classification.incident_id, classification]))
      );
      if (usersResponse) setUsers(usersResponse.items ?? []);
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
    () => users.filter((user) => user.is_active && (user.roles.includes("FIELD_WORKER") || user.roles.includes("ADMIN"))),
    [users]
  );

  function addPendingFiles(files: FileList | null) {
    if (!files?.length) return;
    const next = Array.from(files).map((file) => ({
      file,
      kind: inferIncidentAttachmentKind(file.name, file.type),
    }));
    setPendingFiles((previous) => [...previous, ...next]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function resetCreateIncidentForm() {
    setForm(EMPTY_INCIDENT_FORM);
    setPendingFiles([]);
    setCreatePanelOpen(false);
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
    const latitude = normalizeCoordinateValue(form.latitude);
    const longitude = normalizeCoordinateValue(form.longitude);
    if (latitude == null || longitude == null) {
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
          description: form.description.trim() || null,
          first_observed_at: form.first_observed_at,
          first_occurred_at: form.first_occurred_at.trim() || null,
          latitude,
          longitude,
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
      const response = await api<{ linked_submission_id: number }>(`/incidents/${incidentId}/assign`, {
        method: "POST",
        body: JSON.stringify({ assignee_user_id: assignee }),
      });
      await load();
      if (response.linked_submission_id) navigate(`/submissions/${response.linked_submission_id}`);
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

  async function confirmResolveIncident() {
    if (!resolveDialog) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api(`/incidents/${resolveDialog.incidentId}/resolve`, {
        method: "POST",
        body: JSON.stringify({ comment: resolveDialog.comment.trim() || null }),
      });
      setNotice(`Incident #${resolveDialog.incidentId} resolved.`);
      setResolveDialog(null);
      await load();
    } catch (e: any) {
      setError(e?.message ?? "Resolve failed.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmTriageIncident() {
    if (!triageDialog) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await triageIncident(triageDialog.incidentId, {
        disposition: triageDialog.disposition,
        notes: triageDialog.notes.trim() || undefined,
      });
      setNotice(`Triage recorded for incident #${triageDialog.incidentId}.`);
      setTriageDialog(null);
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
        <div className="flex flex-col gap-3 rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] p-4 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-sm font-semibold">Incident operations</div>
            <div className="mt-1 text-sm text-muted">Create, triage, assign, and resolve emergency incidents without leaving ERIS.</div>
          </div>
          <button
            type="button"
            onClick={() => setCreatePanelOpen((open) => !open)}
            className="self-start rounded-md bg-[var(--brand)] px-3 py-2 text-sm font-semibold text-white hover:brightness-95 md:self-auto"
          >
            {createPanelOpen ? "Close new incident" : "New incident"}
          </button>
        </div>

        {createPanelOpen ? (
          <IncidentCreatePanel
            form={form}
            pendingFiles={pendingFiles}
            busy={busy}
            fileInputRef={fileInputRef}
            onFormChange={setForm}
            onFiles={addPendingFiles}
            onRemoveFile={(index) => setPendingFiles((previous) => previous.filter((_, itemIndex) => itemIndex !== index))}
            onCancel={resetCreateIncidentForm}
            onCreate={createIncident}
          />
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as "ALL" | IncidentStatus)}
            className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm"
          >
            <option value="ALL">All statuses</option>
            <option value="NEW">New</option>
            <option value="IN_PROGRESS">In progress</option>
            <option value="RESOLVED">Resolved</option>
          </select>
          <label className="inline-flex items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm">
            <input type="checkbox" checked={unclaimedOnly} onChange={(event) => setUnclaimedOnly(event.target.checked)} />
            Unclaimed only
          </label>
          <button
            type="button"
            onClick={load}
            disabled={busy}
            className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50"
          >
            {busy ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        {error ? (
          <div className="rounded-md border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-3 py-2 text-sm text-[var(--bad)]">{error}</div>
        ) : null}
        {notice ? (
          <div className="rounded-md border border-[color:color-mix(in_oklab,var(--good)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--good)_10%,transparent)] px-3 py-2 text-sm text-[var(--good)]">{notice}</div>
        ) : null}

        <div className="flex-1 overflow-auto rounded-xl border border-[var(--line)] bg-[var(--panel)]">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-[var(--line)] bg-[var(--panel-soft)] text-left text-xs font-semibold uppercase tracking-wide text-muted">
                <th className="px-3 py-3">ID</th>
                <th className="px-3 py-3">Incident</th>
                <th className="px-3 py-3">Location</th>
                <th className="px-3 py-3">Status</th>
                <th className="px-3 py-3">Assignment</th>
                <th className="px-3 py-3">Linked Submission</th>
                <th className="px-3 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td className="px-3 py-8 text-sm text-muted" colSpan={7}>{busy ? "Loading incidents…" : "No incidents match the current filters."}</td>
                </tr>
              ) : (
                items.map((incident) => (
                  <tr key={incident.id} className="border-b border-[var(--line)]/60 align-top last:border-b-0 hover:bg-[var(--panel-soft)]">
                    <td className="px-3 py-3 text-sm font-semibold tabular-nums">#{incident.id}</td>
                    <td className="px-3 py-3 text-sm">
                      <div className="font-semibold">{incident.title || `Incident #${incident.id}`}</div>
                      <IncidentClassificationText classification={classifications[incident.id]} />
                    </td>
                    <td className="px-3 py-3 text-sm text-muted tabular-nums">{formatCoordinate(incident.latitude)}, {formatCoordinate(incident.longitude)}</td>
                    <td className="px-3 py-3 text-sm"><IncidentStatusBadge status={incident.status} /></td>
                    <td className="px-3 py-3 text-sm text-muted">{incident.assignment ? incident.assignment.assignee_name || incident.assignment.assignee_email : "Unassigned"}</td>
                    <td className="px-3 py-3 text-sm">
                      {incident.linked_submission_id ? (
                        <button type="button" onClick={() => navigate(`/submissions/${incident.linked_submission_id}`)} className="font-semibold text-[var(--brand)] hover:underline">#{incident.linked_submission_id}</button>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right">
                      <div className="inline-flex flex-wrap justify-end gap-1.5">
                        <button type="button" onClick={() => setWorkflowIncidentId(incident.id)} className="rounded border border-[var(--line)] bg-[var(--panel)] px-2 py-1 text-xs font-semibold hover:bg-[var(--panel-soft)]">Workflow</button>
                        {canTriage(me?.roles) && incident.current_stage === "COORDINATOR_REVIEW" ? (
                          <button
                            type="button"
                            onClick={() => setTriageDialog({ incidentId: incident.id, disposition: "ASSESSMENT_REQUIRED", notes: "" })}
                            className="rounded border border-[color:color-mix(in_oklab,var(--brand)_48%,transparent)] bg-[color:color-mix(in_oklab,var(--brand)_10%,transparent)] px-2 py-1 text-xs font-semibold text-[var(--brand)] hover:brightness-95"
                          >
                            Triage
                          </button>
                        ) : null}
                        {isAdmin ? (
                          <>
                            <select
                              value={assignByIncidentId[incident.id] ?? ""}
                              onChange={(event) => setAssignByIncidentId((previous) => ({ ...previous, [incident.id]: event.target.value }))}
                              className="rounded border border-[var(--line)] bg-[var(--panel)] px-2 py-1 text-xs"
                            >
                              <option value="">Assign user…</option>
                              {assignableUsers.map((user) => <option key={user.id} value={String(user.id)}>{user.full_name}</option>)}
                            </select>
                            <button
                              type="button"
                              onClick={() => assignIncident(incident.id)}
                              disabled={!assignByIncidentId[incident.id] || busy}
                              className="rounded border border-[var(--line)] bg-[var(--panel)] px-2 py-1 text-xs font-medium hover:bg-[var(--panel-soft)] disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              Assign
                            </button>
                            {incident.assignment ? (
                              <button type="button" onClick={() => unassignIncident(incident.id)} disabled={busy} className="rounded border border-[var(--line)] bg-[var(--panel)] px-2 py-1 text-xs font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50">Unassign</button>
                            ) : null}
                          </>
                        ) : null}
                        {incident.status !== "RESOLVED" ? (
                          <button
                            type="button"
                            onClick={() => setResolveDialog({ incidentId: incident.id, comment: "" })}
                            className="rounded border border-[color:color-mix(in_oklab,var(--good)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--good)_9%,transparent)] px-2 py-1 text-xs font-semibold text-[var(--good)] hover:brightness-95"
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

      {workflowIncidentId != null ? <WorkflowTreeModal incidentId={workflowIncidentId} onClose={() => setWorkflowIncidentId(null)} /> : null}
      {triageDialog ? (
        <IncidentTriageDialog
          state={triageDialog}
          busy={busy}
          onChange={setTriageDialog}
          onClose={() => setTriageDialog(null)}
          onConfirm={confirmTriageIncident}
        />
      ) : null}
      {resolveDialog ? (
        <IncidentResolveDialog
          state={resolveDialog}
          busy={busy}
          onChange={setResolveDialog}
          onClose={() => setResolveDialog(null)}
          onConfirm={confirmResolveIncident}
        />
      ) : null}
    </AppShell>
  );
}
