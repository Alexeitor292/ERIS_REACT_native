import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import {
  type Assessment,
  type AssessmentDetail,
  type AssessmentQueue,
  type AssessmentState,
  type AssignmentUserOption,
  type RoutingUserOption,
  addAssignment,
  assessmentAssignmentOptions,
  assignEngineer,
  branchOptions,
  delegateBranch,
  finalizeAssessment,
  getAssessment,
  listAssessments,
  removeAssignment,
  reviewAssessment,
  submitAssessment,
} from "../../api/assessments";
import { useAuth } from "../../auth/AuthContext";
import AppShell from "../../ui/AppShell";
import {
  assessmentStateLabel,
  canAssignEngineer,
  canAssignReviewer,
  canDelegateBranch,
  isAdmin,
} from "../../utils/roleModel";

const TABS: Array<{ key: AssessmentQueue | "all"; label: string }> = [
  { key: "all", label: "All" },
  { key: "office_chief", label: "Office delegation" },
  { key: "branch_chief", label: "Branch assignment" },
  { key: "engineer", label: "My engineering" },
  { key: "reviewer", label: "My reviews" },
];

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function formatTimestamp(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : dateTimeFormatter.format(parsed);
}

function humanize(value: string | null | undefined) {
  if (!value) return "—";
  return value.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (letter: string) => letter.toUpperCase());
}

function stateBadgeClass(state: AssessmentState | string): string {
  if (state === "APPROVED" || state === "FINALIZED") return "border-[color:color-mix(in_oklab,var(--good)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--good)_10%,transparent)] text-[var(--good)]";
  if (state === "REVISION_REQUESTED") return "border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] text-[var(--bad)]";
  if (state === "SUBMITTED") return "border-[color:color-mix(in_oklab,var(--brand)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--brand)_10%,transparent)] text-[var(--brand)]";
  return "border-[var(--line)] bg-[var(--panel-soft)] text-[var(--ink)]";
}

function AssessmentStateBadge({ state }: { state: AssessmentState | string }) {
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${stateBadgeClass(state)}`}>{assessmentStateLabel(state)}</span>;
}

export default function AssessmentWorkspacePage() {
  const { me } = useAuth();
  const roles = me?.roles;
  const [tab, setTab] = useState<AssessmentQueue | "all">("all");
  const [items, setItems] = useState<Assessment[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<AssessmentDetail | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const loadList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await listAssessments(tab === "all" ? {} : { queue: tab });
      const next = response.items ?? [];
      setItems(next);
      setSelectedId((current) => current != null && next.some((item) => item.id === current) ? current : next[0]?.id ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load assessments.");
    } finally {
      setLoading(false);
    }
  }, [tab]);

  const loadDetail = useCallback(async (id: number) => {
    setError(null);
    try {
      setDetail(await getAssessment(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load assessment.");
    }
  }, []);

  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => {
    if (selectedId == null) setDetail(null);
    else loadDetail(selectedId);
  }, [loadDetail, selectedId]);

  const refreshBoth = useCallback(async () => {
    await loadList();
    if (selectedId != null) await loadDetail(selectedId);
  }, [loadDetail, loadList, selectedId]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return items;
    return items.filter((assessment) =>
      String(assessment.id).includes(normalized) ||
      String(assessment.incident_id).includes(normalized) ||
      String(assessment.district ?? "").toLowerCase().includes(normalized) ||
      String(assessment.office_code ?? "").toLowerCase().includes(normalized) ||
      assessmentStateLabel(assessment.state).toLowerCase().includes(normalized)
    );
  }, [items, query]);

  return (
    <AppShell title="Assessments">
      <div className="flex h-full flex-col gap-4 p-4 md:p-5">
        <div className="flex flex-wrap gap-2">
          {TABS.map((item) => (
            <button key={item.key} type="button" onClick={() => setTab(item.key)} className={`rounded-lg border px-3 py-2 text-sm font-medium ${tab === item.key ? "border-[var(--brand)] bg-[color:color-mix(in_oklab,var(--brand)_9%,var(--panel))] text-[var(--brand)]" : "border-[var(--line)] bg-[var(--panel-soft)]"}`}>{item.label}</button>
          ))}
        </div>

        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search assessment, incident, office, district, or state" className="w-full rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--brand)] md:max-w-xl" />
          <button type="button" onClick={loadList} disabled={loading} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50">{loading ? "Refreshing…" : "Refresh queue"}</button>
        </div>

        {error ? <div className="rounded-md border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-3 py-2 text-sm text-[var(--bad)]">{error}</div> : null}

        <div className="grid min-h-[680px] flex-1 gap-4 xl:grid-cols-[minmax(340px,0.8fr)_minmax(560px,1.7fr)]">
          <section className="overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)]">
            <div className="border-b border-[var(--line)] bg-[var(--panel-soft)] px-4 py-3 text-sm text-muted">{filtered.length} of {items.length} assessments</div>
            <div className="max-h-[760px] overflow-auto p-2">
              {filtered.length === 0 ? <div className="p-4 text-sm text-muted">{loading ? "Loading assessments…" : "No assessments match this queue."}</div> : (
                <div className="space-y-2">{filtered.map((assessment) => (
                  <button key={assessment.id} type="button" onClick={() => setSelectedId(assessment.id)} className={`block w-full rounded-lg border p-3 text-left ${selectedId === assessment.id ? "border-[var(--brand)] bg-[color:color-mix(in_oklab,var(--brand)_7%,var(--panel))]" : "border-[var(--line)] hover:bg-[var(--panel-soft)]"}`}>
                    <div className="flex items-start justify-between gap-3"><div><div className="font-semibold">Assessment #{assessment.id}</div><div className="mt-1 text-xs text-muted">Incident #{assessment.incident_id}</div></div><AssessmentStateBadge state={assessment.state} /></div>
                    <div className="mt-3 text-xs text-muted">Office {assessment.office_code ?? "—"} · District {assessment.district ?? "—"}</div>
                  </button>
                ))}</div>
              )}
            </div>
          </section>

          <section className="min-w-0">
            {detail ? <AssessmentDetailPanel detail={detail} roles={roles} meId={me?.id} onChanged={refreshBoth} onError={setError} /> : <div className="rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] p-6 text-sm text-muted">Select an assessment to view assignments, actions, and history.</div>}
          </section>
        </div>
      </div>
    </AppShell>
  );
}

function AssessmentDetailPanel({ detail, roles, meId, onChanged, onError }: { detail: AssessmentDetail; roles: string[] | undefined; meId: number | undefined; onChanged: () => Promise<void>; onError: (message: string) => void }) {
  const { assessment, assignments, events } = detail;
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState("");
  const [branchOptionsList, setBranchOptionsList] = useState<RoutingUserOption[]>([]);
  const [engineerOptions, setEngineerOptions] = useState<AssignmentUserOption[]>([]);
  const [reviewerOptions, setReviewerOptions] = useState<AssignmentUserOption[]>([]);
  const [branchChiefId, setBranchChiefId] = useState("");
  const [engineerId, setEngineerId] = useState("");
  const [reviewerId, setReviewerId] = useState("");

  const admin = isAdmin(roles);
  const isAssignedEngineer = meId != null && assessment.assigned_engineer_user_id === meId;
  const isAssignedReviewer = assignments.some((assignment) => assignment.user_id === meId && (assignment.assignment_role === "REVIEWER" || assignment.assignment_role === "APPROVER"));
  const showDelegate = assessment.state === "PENDING_OFFICE_DELEGATION" && canDelegateBranch(roles);
  const showAssignEngineer = assessment.state === "PENDING_ENGINEER_ASSIGNMENT" && canAssignEngineer(roles);
  const showReviewerAssignment = canAssignReviewer(roles) && assessment.state !== "FINALIZED";
  const showSubmit = (assessment.state === "DRAFT" || assessment.state === "REVISION_REQUESTED") && (isAssignedEngineer || admin);
  const showReview = assessment.state === "SUBMITTED" && (isAssignedReviewer || admin);
  const showFinalize = assessment.state === "APPROVED" && canDelegateBranch(roles);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      setNotes(""); setBranchChiefId(""); setEngineerId(""); setReviewerId("");
      await onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Action failed.");
    } finally { setBusy(false); }
  };

  useEffect(() => {
    let cancelled = false;
    const requests: Array<Promise<void>> = [];
    if (showDelegate) requests.push(branchOptions(assessment.id).then((response) => { if (!cancelled) setBranchOptionsList(response.items ?? []); }));
    else setBranchOptionsList([]);
    if (showAssignEngineer) requests.push(assessmentAssignmentOptions(assessment.id, "ENGINEER").then((response) => { if (!cancelled) setEngineerOptions(response.items ?? []); }));
    else setEngineerOptions([]);
    if (showReviewerAssignment) requests.push(assessmentAssignmentOptions(assessment.id, "REVIEWER").then((response) => { if (!cancelled) setReviewerOptions(response.items ?? []); }));
    else setReviewerOptions([]);
    Promise.all(requests).catch((e) => { if (!cancelled) onError(e instanceof Error ? e.message : "Failed to load assignment options."); });
    return () => { cancelled = true; };
  }, [assessment.id, onError, showAssignEngineer, showDelegate, showReviewerAssignment]);

  const assignedReviewerIds = new Set(assignments.filter((assignment) => assignment.assignment_role === "REVIEWER" || assignment.assignment_role === "APPROVER").map((assignment) => assignment.user_id));
  const availableReviewers = reviewerOptions.filter((option) => !assignedReviewerIds.has(option.id));

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4 md:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="text-xs font-semibold uppercase tracking-wide text-muted">Assessment #{assessment.id}</div><h2 className="mt-1 text-xl font-semibold">Incident #{assessment.incident_id} technical assessment</h2><div className="mt-2 text-sm text-muted">Office {assessment.office_code ?? "—"} · District {assessment.district ?? "—"} · Updated {formatTimestamp(assessment.updated_at)}</div></div><AssessmentStateBadge state={assessment.state} /></div>
        <div className="mt-4 flex flex-wrap gap-2"><Link to="/incidents" className="rounded-md border border-[var(--line)] px-3 py-2 text-sm font-semibold hover:bg-[var(--panel-soft)]">Open incidents</Link>{assessment.submission_id != null ? <Link to={`/submissions/${assessment.submission_id}`} className="rounded-md bg-[var(--brand)] px-3 py-2 text-sm font-semibold text-white">Open technical form</Link> : null}</div>
        {assessment.office_override_reason ? <div className="mt-4 rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3 text-sm"><div className="text-xs font-semibold uppercase tracking-wide text-muted">Routing override</div><div className="mt-1">{assessment.office_override_reason}</div></div> : null}
      </section>

      <section className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4 md:p-5">
        <h3 className="font-semibold">Assignments</h3><p className="mt-1 text-sm text-muted">People currently responsible for engineering, review, or approval.</p>
        <div className="mt-4 grid gap-2">{assignments.length === 0 ? <div className="rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3 text-sm text-muted">No active assignments yet.</div> : assignments.map((assignment) => <div key={assignment.id} className="flex flex-col gap-2 rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3 sm:flex-row sm:items-center sm:justify-between"><div><div className="font-semibold">{assignment.full_name}</div><div className="mt-1 text-xs text-muted">{humanize(assignment.assignment_role)} · {assignment.email}</div></div>{assignment.assignment_role !== "ENGINEER" && canAssignReviewer(roles) ? <button type="button" disabled={busy} onClick={() => run(() => removeAssignment(assessment.id, assignment.id))} className="rounded-md border border-[var(--line)] px-2.5 py-1.5 text-xs font-semibold text-[var(--bad)] disabled:opacity-50">Remove</button> : null}</div>)}</div>
      </section>

      {(showDelegate || showAssignEngineer || showReviewerAssignment || showSubmit || showReview || showFinalize) ? <section className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4 md:p-5">
        <h3 className="font-semibold">Available actions</h3><p className="mt-1 text-sm text-muted">Only actions allowed by your role and this assessment state are shown.</p>
        <textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Optional workflow notes" className="mt-4 w-full rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" />
        <div className="mt-4 grid gap-3">
          {showDelegate ? <ActionRow title="Delegate to branch chief"><select value={branchChiefId} onChange={(event) => setBranchChiefId(event.target.value)} className="min-w-72 flex-1 rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm"><option value="">Select branch chief…</option>{branchOptionsList.map((option) => <option key={option.id} value={option.id}>{option.full_name} · {option.email}</option>)}</select><button type="button" disabled={busy || !branchChiefId} onClick={() => run(() => delegateBranch(assessment.id, Number(branchChiefId), notes))} className="rounded-md bg-[var(--brand)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">Delegate</button></ActionRow> : null}
          {showAssignEngineer ? <ActionRow title="Assign engineer"><select value={engineerId} onChange={(event) => setEngineerId(event.target.value)} className="min-w-72 flex-1 rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm"><option value="">Select engineer…</option>{engineerOptions.map((option) => <option key={option.id} value={option.id}>{option.full_name} · {option.email}</option>)}</select><button type="button" disabled={busy || !engineerId} onClick={() => run(() => assignEngineer(assessment.id, Number(engineerId), notes))} className="rounded-md bg-[var(--brand)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">Assign engineer</button></ActionRow> : null}
          {showReviewerAssignment ? <ActionRow title="Add reviewer"><select value={reviewerId} onChange={(event) => setReviewerId(event.target.value)} className="min-w-72 flex-1 rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm"><option value="">Select reviewer…</option>{availableReviewers.map((option) => <option key={option.id} value={option.id}>{option.full_name} · {option.email}</option>)}</select><button type="button" disabled={busy || !reviewerId} onClick={() => run(() => addAssignment(assessment.id, { user_id: Number(reviewerId), assignment_role: "REVIEWER", notes }))} className="rounded-md border border-[var(--brand)] px-3 py-2 text-sm font-semibold text-[var(--brand)] disabled:opacity-50">Add reviewer</button></ActionRow> : null}
          {showSubmit ? <ActionRow title="Submit for review"><button type="button" disabled={busy} onClick={() => run(() => submitAssessment(assessment.id, notes))} className="rounded-md bg-[var(--brand)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">Submit for review</button></ActionRow> : null}
          {showReview ? <ActionRow title="Reviewer decision"><button type="button" disabled={busy} onClick={() => run(() => reviewAssessment(assessment.id, "REQUEST_REVISION", notes))} className="rounded-md border border-[var(--line)] px-3 py-2 text-sm font-semibold text-[var(--bad)] disabled:opacity-50">Request revision</button><button type="button" disabled={busy} onClick={() => run(() => reviewAssessment(assessment.id, "APPROVE", notes))} className="rounded-md bg-[var(--good)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">Approve assessment</button></ActionRow> : null}
          {showFinalize ? <ActionRow title="Finalize assessment"><button type="button" disabled={busy} onClick={() => run(() => finalizeAssessment(assessment.id, notes))} className="rounded-md bg-[var(--good)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">Finalize</button></ActionRow> : null}
        </div>
      </section> : null}

      <section className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4 md:p-5"><h3 className="font-semibold">Assessment history</h3><p className="mt-1 text-sm text-muted">Routing and review events recorded for this assessment.</p><ol className="mt-4 space-y-2">{events.length === 0 ? <li className="rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3 text-sm text-muted">No assessment events recorded yet.</li> : events.map((event) => <li key={event.id} className="rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3 text-sm"><div className="flex flex-wrap items-start justify-between gap-2"><div><div className="font-semibold">{humanize(event.event_type)}{event.disposition ? ` · ${humanize(event.disposition)}` : ""}</div><div className="mt-1 text-xs text-muted">by {event.actor_name || event.actor_email || `User #${event.actor_user_id}`}</div></div><div className="text-xs text-muted">{formatTimestamp(event.created_at)}</div></div>{event.from_state || event.to_state ? <div className="mt-2 text-xs text-muted">{event.from_state ? assessmentStateLabel(event.from_state) : "—"} → {event.to_state ? assessmentStateLabel(event.to_state) : "—"}</div> : null}{event.notes ? <div className="mt-2 rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2">{event.notes}</div> : null}</li>)}</ol></section>
    </div>
  );
}

function ActionRow({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3"><div className="font-semibold">{title}</div><div className="mt-3 flex flex-wrap items-center gap-2">{children}</div></div>;
}
