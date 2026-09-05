import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { listAssessments, type Assessment } from "../../api/assessments";
import { api } from "../../api/client";
import type { Incident, IncidentStatus } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import AppShell from "../../ui/AppShell";
import { formatCoordinate, normalizeCoordinateValue, normalizePostMileValue, normalizeRouteValue } from "../../utils/precision";
import { canReportIncident, isOperationalUser } from "../../utils/roleModel";
import { AssessmentStateBadge } from "../assessments/AssessmentDetailPanel";
import { submissionIdsOf } from "../assessments/assessmentModel";
import { eventGroupLocationLabel } from "../eventGroups/eventGroupTypes";
import IncidentCreatePanel from "./IncidentCreatePanel";
import type { IncidentClassification, IncidentClassificationQueryResponse } from "./incidentClassification";
import { classificationLabel, classificationStateLabel } from "./incidentClassification";
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
    <span className={`inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold ${incidentStatusBadgeClass(status)}`}>
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

type Tab = "records" | "intake";

/**
 * Incidents: read-only record view.
 *   "Incident records"  — reports accepted into ERIS (coordinator-approved).
 *   "Awaiting intake"   — field reports not yet part of the record (triage pending).
 * Triage, routing, and assignment actions live in My Work. Filing a new report is
 * intake, not workflow, so reporting roles keep the "New incident" panel.
 */
export default function IncidentsOperationsPage() {
  const { me } = useAuth();
  const params = useParams();
  const highlightId = params.id ? Number(params.id) : null;
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const rowRefs = useRef<Record<number, HTMLTableRowElement | null>>({});
  const operational = isOperationalUser(me?.roles);

  const [items, setItems] = useState<Incident[]>([]);
  const [classifications, setClassifications] = useState<Record<number, IncidentClassification>>({});
  const [assessmentsByIncident, setAssessmentsByIncident] = useState<Record<number, Assessment>>({});
  const [tab, setTab] = useState<Tab>("records");
  const [statusFilter, setStatusFilter] = useState<"ALL" | IncidentStatus>("ALL");
  const [unclaimedOnly, setUnclaimedOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState<IncidentCreateForm>(EMPTY_INCIDENT_FORM);
  const [pendingFiles, setPendingFiles] = useState<PendingIncidentUpload[]>([]);
  const [createPanelOpen, setCreatePanelOpen] = useState(false);

  async function load() {
    setBusy(true);
    setError(null);
    try {
      const response = await api<{ items: Incident[] }>("/incidents?limit=1000");
      const nextItems = response.items ?? [];
      const [classificationResponse, assessmentResponse] = await Promise.all([
        nextItems.length
          ? api<IncidentClassificationQueryResponse>("/incident-classifications/query", { method: "POST", body: JSON.stringify({ incident_ids: nextItems.map((incident) => incident.id) }) })
          : Promise.resolve({ items: [] } as IncidentClassificationQueryResponse),
        operational ? listAssessments({ limit: 1000 }).catch(() => ({ items: [] as Assessment[] })) : Promise.resolve({ items: [] as Assessment[] }),
      ]);
      setItems(nextItems);
      setClassifications(Object.fromEntries((classificationResponse.items ?? []).map((classification) => [classification.incident_id, classification])));
      setAssessmentsByIncident(Object.fromEntries((assessmentResponse.items ?? []).map((assessment) => [assessment.incident_id, assessment])));
    } catch (e: any) {
      setError(e?.message ?? "Failed to load incidents.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Deep link: /incidents/:id highlights and scrolls to the row (switching tab if needed).
  useEffect(() => {
    if (highlightId == null) return;
    const target = items.find((incident) => incident.id === highlightId);
    if (!target) return;
    setTab(target.current_stage === "COORDINATOR_REVIEW" ? "intake" : "records");
    const timer = window.setTimeout(() => {
      rowRefs.current[highlightId]?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [highlightId, items]);

  const intakeCount = useMemo(() => items.filter((incident) => incident.current_stage === "COORDINATOR_REVIEW").length, [items]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((incident) => {
      const intake = incident.current_stage === "COORDINATOR_REVIEW";
      if (tab === "intake" ? !intake : intake) return false;
      if (statusFilter !== "ALL" && incident.status !== statusFilter) return false;
      if (unclaimedOnly && incident.assignment) return false;
      if (!needle) return true;
      return [incident.id, incident.title, incident.description, incident.district, incident.county, incident.route, incident.post_mile]
        .filter((value) => value != null)
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [items, query, statusFilter, tab, unclaimedOnly]);

  function addPendingFiles(files: FileList | null) {
    if (!files?.length) return;
    const next = Array.from(files).map((file) => ({ file, kind: inferIncidentAttachmentKind(file.name, file.type) }));
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
      const suffix = new URLSearchParams({ kind: pending.kind }).toString();
      try {
        await api(`/incidents/${incidentId}/attachments?${suffix}`, { method: "POST", body: formData });
      } catch (e: any) {
        failures.push(`${pending.file.name}: ${e?.message ?? "Upload failed"}`);
      }
    }
    return failures;
  }

  async function createIncident() {
    setNotice(null);
    if (!form.title.trim()) { setError("Incident title is required."); return; }
    if (!form.first_observed_at.trim()) { setError("First observed date/time is required."); return; }
    const latitude = normalizeCoordinateValue(form.latitude);
    const longitude = normalizeCoordinateValue(form.longitude);
    if (latitude == null || longitude == null) { setError("Latitude and longitude must be valid numbers."); return; }

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
      setTab("intake");
      if (selectedFileCount > 0) {
        const uploadedCount = selectedFileCount - uploadFailures.length;
        setNotice(uploadFailures.length
          ? `Incident reported. ${uploadedCount} of ${selectedFileCount} files uploaded. ${uploadFailures.slice(0, 2).join(" ")}`
          : `Incident reported with ${selectedFileCount} attached file${selectedFileCount === 1 ? "" : "s"}. It is awaiting coordinator intake.`);
      } else {
        setNotice("Incident reported. It is awaiting coordinator intake.");
      }
    } catch (e: any) {
      setError(e?.message ?? "Failed to create incident.");
    } finally {
      setBusy(false);
    }
  }

  const tabButton = (key: Tab, label: string) => (
    <button
      type="button"
      onClick={() => setTab(key)}
      className={`whitespace-nowrap px-4 py-2 text-sm font-semibold ${key === "intake" ? "border-l border-[var(--line)]" : ""} ${tab === key ? "bg-[var(--brand)] text-white" : "bg-[var(--panel)] text-[var(--ink)] hover:bg-[var(--panel-soft)]"}`}
    >
      {label}
    </button>
  );

  return (
    <AppShell title="Incidents">
      <div className="grid gap-4 p-4 md:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex shrink-0 overflow-hidden rounded-lg border border-[var(--line)]">
            {tabButton("records", `Incident records (${items.length - intakeCount})`)}
            {tabButton("intake", `Awaiting intake (${intakeCount})`)}
          </div>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search title, county, route, or description" className="min-w-[220px] flex-1 rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--brand)]" />
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as "ALL" | IncidentStatus)} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm">
            <option value="ALL">All statuses</option>
            <option value="NEW">New</option>
            <option value="IN_PROGRESS">In progress</option>
            <option value="RESOLVED">Resolved</option>
          </select>
          <label className="inline-flex items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm">
            <input type="checkbox" checked={unclaimedOnly} onChange={(event) => setUnclaimedOnly(event.target.checked)} />
            Unclaimed only
          </label>
          <span className="text-xs text-muted">{visible.length} of {items.length} incidents</span>
          <div className="ml-auto flex gap-2">
            {canReportIncident(me?.roles) ? (
              <button type="button" onClick={() => setCreatePanelOpen((open) => !open)} className="rounded-md bg-[var(--brand)] px-3 py-2 text-sm font-semibold text-white hover:brightness-95">
                {createPanelOpen ? "Close report" : "New incident"}
              </button>
            ) : null}
            <button type="button" onClick={load} disabled={busy} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50">{busy ? "Refreshing…" : "Refresh"}</button>
          </div>
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

        {tab === "intake" ? (
          <div className="rounded-md border border-[color:color-mix(in_oklab,var(--brand)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--brand)_8%,transparent)] px-3 py-2 text-sm">
            <b>These field reports are not yet part of the ERIS incident record.</b> They were reported from the field and are waiting for a Maintenance Coordinator to review them, decide their Event Group, and accept them into the system — done from the coordinator's <Link to="/my-work" className="font-medium text-[var(--brand)] hover:underline">My Work</Link> queue.
          </div>
        ) : (
          <div className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-2 text-sm text-muted">
            Read-only record view. Triage, routing, and assignment actions live in <Link to="/my-work" className="font-medium text-[var(--brand)] hover:underline">My Work</Link>, gated by your role.
          </div>
        )}

        {error ? <div className="rounded-md border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-3 py-2 text-sm text-[var(--bad)]">{error}</div> : null}
        {notice ? <div className="rounded-md border border-[color:color-mix(in_oklab,var(--good)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--good)_10%,transparent)] px-3 py-2 text-sm text-[var(--good)]">{notice}</div> : null}

        <div className="overflow-x-auto rounded-xl border border-[var(--line)] bg-[var(--panel)]">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-[var(--line)] bg-[var(--panel-soft)] text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">
                <th className="px-3 py-3">ID</th>
                <th className="px-3 py-3">Incident</th>
                <th className="px-3 py-3">Location</th>
                <th className="px-3 py-3">Status</th>
                <th className="px-3 py-3">Assignment</th>
                <th className="px-3 py-3">Assessment / Submission</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr><td className="px-3 py-8 text-center text-sm text-muted" colSpan={6}>{busy ? "Loading incidents…" : "No incidents match the current filters."}</td></tr>
              ) : visible.map((incident) => {
                const assessment = assessmentsByIncident[incident.id];
                const submissionIds = assessment ? submissionIdsOf(assessment) : (incident.linked_submission_id ? [incident.linked_submission_id] : []);
                const highlighted = highlightId === incident.id;
                return (
                  <tr
                    key={incident.id}
                    ref={(element) => { rowRefs.current[incident.id] = element; }}
                    className="border-b border-[var(--line)]/60 align-top last:border-b-0"
                    style={highlighted ? { background: "color-mix(in oklab, var(--brand) 7%, var(--panel))", boxShadow: "inset 3px 0 0 var(--brand)" } : undefined}
                  >
                    <td className="px-3 py-3 text-sm font-semibold tabular-nums">#{incident.id}</td>
                    <td className="px-3 py-3 text-sm">
                      <div className="font-semibold">{incident.title || `Incident #${incident.id}`}</div>
                      <IncidentClassificationText classification={classifications[incident.id]} />
                      {incident.event_group_id != null ? <div className="mt-1 text-[11px]"><Link to={`/event-groups/${incident.event_group_id}`} className="text-[var(--brand)] hover:underline">Event Group #{incident.event_group_id}</Link></div> : null}
                    </td>
                    <td className="px-3 py-3 text-sm text-muted">
                      <div className="tabular-nums">{formatCoordinate(incident.latitude)}, {formatCoordinate(incident.longitude)}</div>
                      <div className="mt-0.5 text-xs">{eventGroupLocationLabel(incident)}</div>
                      {incident.event_group_id != null ? <div className="mt-1 text-xs"><Link to={`/mission-center/${incident.event_group_id}/${incident.id}`} className="text-[var(--brand)] hover:underline">View on map</Link></div> : null}
                    </td>
                    <td className="px-3 py-3 text-sm"><IncidentStatusBadge status={incident.status} /></td>
                    <td className="px-3 py-3 text-sm text-muted">{incident.assignment ? incident.assignment.assignee_name || incident.assignment.assignee_email : "Unassigned"}</td>
                    <td className="px-3 py-3 text-sm">
                      {assessment ? (
                        <div className="flex flex-wrap items-center gap-1.5"><Link to={`/assessments/${assessment.id}`} className="font-semibold text-[var(--brand)] hover:underline">AS #{assessment.id}</Link><AssessmentStateBadge state={assessment.state} mini /></div>
                      ) : <span className="text-muted">No assessment</span>}
                      {submissionIds.length ? (
                        <div className="mt-1 flex flex-wrap gap-2 text-xs">{submissionIds.map((submissionId) => <Link key={submissionId} to={`/submissions/${submissionId}`} className="text-[var(--brand)] hover:underline">Sub #{submissionId}</Link>)}</div>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
