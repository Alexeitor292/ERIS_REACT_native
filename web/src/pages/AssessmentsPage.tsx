import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import {
  Assessment,
  AssessmentDetail,
  AssessmentQueue,
  RoutingUserOption,
  addAssignment,
  assignEngineer,
  branchOptions,
  delegateBranch,
  finalizeAssessment,
  getAssessment,
  listAssessments,
  removeAssignment,
  reviewAssessment,
  submitAssessment,
} from "../api/assessments";
import { useAuth } from "../auth/AuthContext";
import AppShell from "../ui/AppShell";
import {
  assessmentStateLabel,
  canAssignEngineer,
  canAssignReviewer,
  canDelegateBranch,
  isAdmin,
} from "../utils/roleModel";

function stateBadgeClass(state: string): string {
  switch (state) {
    case "PENDING_OFFICE_DELEGATION":
    case "PENDING_ENGINEER_ASSIGNMENT":
      return "border-amber-500/50 bg-amber-500/15 text-amber-300";
    case "DRAFT":
      return "border-slate-400/40 bg-slate-400/15 text-slate-200";
    case "SUBMITTED":
      return "border-sky-500/50 bg-sky-500/15 text-sky-300";
    case "REVISION_REQUESTED":
      return "border-red-500/40 bg-red-500/15 text-red-300";
    case "APPROVED":
    case "FINALIZED":
      return "border-emerald-500/40 bg-emerald-500/15 text-emerald-300";
    default:
      return "border-slate-400/40 bg-slate-400/15 text-slate-200";
  }
}

type QueueTab = { key: AssessmentQueue | "all"; label: string };

const TABS: QueueTab[] = [
  { key: "all", label: "All assessments" },
  { key: "office_chief", label: "Office delegation" },
  { key: "branch_chief", label: "Branch assignment" },
  { key: "engineer", label: "My engineering" },
  { key: "reviewer", label: "My reviews" },
];

export default function AssessmentsPage() {
  const { me } = useAuth();
  const roles = me?.roles;

  const [tab, setTab] = useState<AssessmentQueue | "all">("all");
  const [items, setItems] = useState<Assessment[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<AssessmentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const loadList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listAssessments(tab === "all" ? {} : { queue: tab });
      setItems(res.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load assessments");
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => {
    loadList();
  }, [loadList]);

  const loadDetail = useCallback(async (id: number) => {
    setError(null);
    try {
      setDetail(await getAssessment(id));
      setSelectedId(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load assessment");
    }
  }, []);

  const refreshBoth = useCallback(async () => {
    await loadList();
    if (selectedId) await loadDetail(selectedId);
  }, [loadList, loadDetail, selectedId]);

  return (
    <AppShell title="Assessments">
      <div className="flex flex-col gap-4 p-4 lg:flex-row">
        <div className="lg:w-1/2">
          <div className="mb-3 flex flex-wrap gap-1.5">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                  tab === t.key
                    ? "bg-[var(--brand)] text-white"
                    : "bg-[var(--panel-soft)] text-[var(--ink)] hover:brightness-95"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {error && <div className="mb-3 rounded-md border border-red-500/40 bg-red-500/10 p-2 text-sm text-red-300">{error}</div>}
          {loading && <div className="text-sm text-muted">Loading…</div>}

          <div className="space-y-2">
            {items.length === 0 && !loading && (
              <div className="text-sm text-muted">No assessments in this queue.</div>
            )}
            {items.map((a) => (
              <button
                key={a.id}
                onClick={() => loadDetail(a.id)}
                className={`block w-full rounded-lg border p-3 text-left transition ${
                  selectedId === a.id ? "border-[var(--brand)]" : "border-[var(--line)] hover:brightness-95"
                } bg-[var(--panel-soft)]`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium">Assessment #{a.id}</div>
                  <span className={`rounded-full border px-2 py-0.5 text-xs ${stateBadgeClass(a.state)}`}>
                    {assessmentStateLabel(a.state)}
                  </span>
                </div>
                <div className="mt-1 text-xs text-muted">
                  Incident #{a.incident_id} · Office {a.office_code ?? "—"} · District {a.district ?? "—"}
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="lg:w-1/2">
          {detail ? (
            <AssessmentDetailPanel detail={detail} roles={roles} onChanged={refreshBoth} onError={setError} />
          ) : (
            <div className="rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-6 text-sm text-muted">
              Select an assessment to view its timeline and available actions.
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}

function AssessmentDetailPanel({
  detail,
  roles,
  onChanged,
  onError,
}: {
  detail: AssessmentDetail;
  roles: string[] | undefined;
  onChanged: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const { assessment, assignments, events } = detail;
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState("");
  const [branchOpts, setBranchOpts] = useState<RoutingUserOption[]>([]);
  const [engineerId, setEngineerId] = useState("");
  const [reviewerId, setReviewerId] = useState("");

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      setNotes("");
      await onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (assessment.state === "PENDING_OFFICE_DELEGATION" && canDelegateBranch(roles)) {
      branchOptions(assessment.id)
        .then((r) => setBranchOpts(r.items))
        .catch(() => setBranchOpts([]));
    }
  }, [assessment.id, assessment.state, roles]);

  const isAssignedEngineer = assessment.assigned_engineer_user_id != null; // server enforces identity
  const showDelegate = assessment.state === "PENDING_OFFICE_DELEGATION" && canDelegateBranch(roles);
  const showAssignEngineer = assessment.state === "PENDING_ENGINEER_ASSIGNMENT" && canAssignEngineer(roles);
  const showSubmit = (assessment.state === "DRAFT" || assessment.state === "REVISION_REQUESTED");
  const showReview = assessment.state === "SUBMITTED";
  const showFinalize = assessment.state === "APPROVED" && canDelegateBranch(roles);

  return (
    <div className="rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Assessment #{assessment.id}</h2>
        <span className={`rounded-full border px-2 py-0.5 text-xs ${stateBadgeClass(assessment.state)}`}>
          {assessmentStateLabel(assessment.state)}
        </span>
      </div>
      <div className="mt-1 text-sm text-muted">
        Incident{" "}
        <Link className="underline" to="/incidents">
          #{assessment.incident_id}
        </Link>{" "}
        · Office {assessment.office_code ?? "—"} · District {assessment.district ?? "—"}
        {assessment.submission_id != null && (
          <>
            {" "}
            ·{" "}
            <Link className="underline" to={`/submissions/${assessment.submission_id}`}>
              Technical form
            </Link>
          </>
        )}
      </div>
      {assessment.office_override_reason && (
        <div className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-300">
          Routing override: {assessment.office_override_reason}
        </div>
      )}

      {/* Assignments */}
      <div className="mt-4">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted">Assignments</div>
        {assignments.length === 0 ? (
          <div className="text-sm text-muted">No assignments yet.</div>
        ) : (
          <ul className="mt-1 space-y-1">
            {assignments.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-2 text-sm">
                <span>
                  <span className="font-medium">{a.assignment_role}</span> — {a.full_name} ({a.email})
                </span>
                {a.assignment_role !== "ENGINEER" && canAssignReviewer(roles) && (
                  <button
                    disabled={busy}
                    onClick={() => run(() => removeAssignment(assessment.id, a.id))}
                    className="rounded border border-[var(--line)] px-2 py-0.5 text-xs hover:brightness-95"
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Actions */}
      <div className="mt-4 space-y-3">
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Notes (optional)"
          className="w-full rounded border border-[var(--line)] bg-[var(--panel)] p-2 text-sm"
          rows={2}
        />

        {showDelegate && (
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="rounded border border-[var(--line)] bg-[var(--panel)] p-2 text-sm"
              defaultValue=""
              onChange={(e) => {
                const id = Number(e.target.value);
                if (id) run(() => delegateBranch(assessment.id, id, notes));
              }}
            >
              <option value="" disabled>
                Delegate to branch chief…
              </option>
              {branchOpts.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.full_name} ({o.email})
                </option>
              ))}
            </select>
          </div>
        )}

        {showAssignEngineer && (
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={engineerId}
              onChange={(e) => setEngineerId(e.target.value)}
              placeholder="Engineer user id"
              className="w-40 rounded border border-[var(--line)] bg-[var(--panel)] p-2 text-sm"
            />
            <button
              disabled={busy || !engineerId}
              onClick={() => run(() => assignEngineer(assessment.id, Number(engineerId), notes))}
              className="rounded bg-[var(--brand)] px-3 py-2 text-sm text-white disabled:opacity-50"
            >
              Assign engineer
            </button>
          </div>
        )}

        {canAssignReviewer(roles) && (
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={reviewerId}
              onChange={(e) => setReviewerId(e.target.value)}
              placeholder="Reviewer user id"
              className="w-40 rounded border border-[var(--line)] bg-[var(--panel)] p-2 text-sm"
            />
            <button
              disabled={busy || !reviewerId}
              onClick={() =>
                run(() => addAssignment(assessment.id, { user_id: Number(reviewerId), assignment_role: "REVIEWER", notes }))
              }
              className="rounded border border-[var(--line)] px-3 py-2 text-sm hover:brightness-95 disabled:opacity-50"
            >
              Assign reviewer
            </button>
          </div>
        )}

        {showSubmit && isAssignedEngineer && (
          <button
            disabled={busy}
            onClick={() => run(() => submitAssessment(assessment.id, notes))}
            className="rounded bg-[var(--brand)] px-3 py-2 text-sm text-white disabled:opacity-50"
          >
            Submit for review
          </button>
        )}

        {showReview && (
          <div className="flex gap-2">
            <button
              disabled={busy}
              onClick={() => run(() => reviewAssessment(assessment.id, "APPROVE", notes))}
              className="rounded bg-emerald-600 px-3 py-2 text-sm text-white disabled:opacity-50"
            >
              Approve
            </button>
            <button
              disabled={busy}
              onClick={() => run(() => reviewAssessment(assessment.id, "REQUEST_REVISION", notes))}
              className="rounded bg-amber-600 px-3 py-2 text-sm text-white disabled:opacity-50"
            >
              Request revision
            </button>
            <span className="self-center text-xs text-muted">(assigned reviewers/approvers only)</span>
          </div>
        )}

        {showFinalize && (
          <button
            disabled={busy}
            onClick={() => run(() => finalizeAssessment(assessment.id, notes))}
            className="rounded bg-emerald-700 px-3 py-2 text-sm text-white disabled:opacity-50"
          >
            Finalize
          </button>
        )}
      </div>

      {/* Timeline */}
      <div className="mt-5">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted">Timeline</div>
        <ol className="mt-2 space-y-2">
          {events.map((ev) => (
            <li key={ev.id} className="rounded border border-[var(--line)] bg-[var(--panel)] p-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">
                  {ev.event_type}
                  {ev.disposition ? ` · ${ev.disposition}` : ""}
                </span>
                <span className="text-xs text-muted">{new Date(ev.created_at).toLocaleString()}</span>
              </div>
              {(ev.from_state || ev.to_state) && (
                <div className="text-xs text-muted">
                  {ev.from_state ?? "—"} → {ev.to_state ?? "—"}
                </div>
              )}
              {ev.notes && <div className="mt-1">{ev.notes}</div>}
              <div className="mt-1 text-xs text-muted">by {ev.actor_name ?? `user #${ev.actor_user_id}`}</div>
            </li>
          ))}
        </ol>
      </div>

      <div className="mt-3 text-xs text-muted">
        {isAdmin(roles) ? "Admin: all actions available." : "Actions are limited by your role and assignment; the server enforces authority."}
      </div>
    </div>
  );
}
