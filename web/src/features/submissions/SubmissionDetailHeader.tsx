import { Link, useParams } from "react-router-dom";
import { useEffect, useState } from "react";
import type { SubmissionWorkflowContext } from "../../api/types";
import { SubmissionStatusBadge } from "./SubmissionDetailPrimitives";
import { getSubmissionPhotoEvidence, type PhotoEvidenceSummary } from "./photoEvidenceApi";

type Props = {
  status?: string;
  descriptor?: string;
  ownerLabel?: string;
  context?: SubmissionWorkflowContext | null;
  invalid: boolean;
  busy: boolean;
  canAct: boolean;
  canEdit: boolean;
  canDelete: boolean;
  /**
   * The form belongs to an assessment, so both the send-for-review and the
   * approve/return decisions happen there — the server refuses them here.
   */
  assessmentLinked?: boolean;
  submitLabel?: string;
  onRefresh: () => void;
  onSaveDraft: () => void;
  onSubmitDraft: () => void;
  onApprove: () => void;
  onReject: () => void;
  onDelete: () => void;
};

const btn = "rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Detail header: status + context (assessment / incident links), photo-evidence count,
 * and the actions available on this form — Save draft / Submit for review for the
 * assignee, Approve / Return for correction for whoever may decide it.
 *
 * On an assessment-linked form neither decision belongs here: the send-for-review
 * and approve/return controls are replaced by links to the assessment, so the
 * header never offers a button the server answers with a 409.
 */
export default function SubmissionDetailHeader({
  status,
  descriptor,
  ownerLabel,
  context,
  invalid,
  busy,
  canAct,
  canEdit,
  canDelete,
  assessmentLinked = false,
  submitLabel = "Submit for review",
  onRefresh,
  onSaveDraft,
  onSubmitDraft,
  onApprove,
  onReject,
  onDelete,
}: Props) {
  const { id } = useParams();
  const submissionId = Number(id);
  const [menuOpen, setMenuOpen] = useState(false);
  const [evidenceSummary, setEvidenceSummary] = useState<PhotoEvidenceSummary | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);

  useEffect(() => {
    if (invalid || !Number.isInteger(submissionId) || submissionId <= 0) {
      setEvidenceSummary(null);
      return;
    }
    let cancelled = false;
    setEvidenceLoading(true);
    getSubmissionPhotoEvidence(submissionId)
      .then((response) => { if (!cancelled) setEvidenceSummary(response.summary); })
      .catch(() => { if (!cancelled) setEvidenceSummary(null); })
      .finally(() => { if (!cancelled) setEvidenceLoading(false); });
    return () => { cancelled = true; };
  }, [invalid, submissionId]);

  const evidenceLabel = evidenceLoading
    ? "Checking evidence…"
    : evidenceSummary
      ? `${evidenceSummary.photos_total} photo${evidenceSummary.photos_total === 1 ? "" : "s"} · ${evidenceSummary.photos_geotagged} mapped`
      : "Photo evidence";

  // Technical forms are reached through their assessment; standalone forms fall back to the worklist.
  const backTo = context?.assessment_id != null ? `/assessments/${context.assessment_id}` : "/submissions";
  const backLabel = context?.assessment_id != null ? `Assessment #${context.assessment_id}` : "Submissions";
  const assessmentHref = context?.assessment_id != null ? `/assessments/${context.assessment_id}` : null;

  /**
   * Who is holding a SUBMITTED form. The route decides, and a legacy form with
   * no linked assessment has no route — so it gets the neutral sentence rather
   * than a reviewer it cannot name.
   */
  const submittedHint = context?.assessment_routing_path === "BRANCH"
    ? "Awaiting branch chief review"
    : context?.assessment_routing_path === "SENIOR_ENGINEER"
      ? "Awaiting office chief review"
      : "Sent for review";

  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <Link className="inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-[var(--ink)]" to={backTo}>
            <span aria-hidden>←</span>
            <span>{backLabel}</span>
          </Link>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {status ? <SubmissionStatusBadge status={status} /> : null}
            {status === "SUBMITTED" ? (
              <span className="text-xs text-muted">{submittedHint}</span>
            ) : status === "DRAFT" ? (
              <span className="text-xs text-muted">Editable field record</span>
            ) : status === "REJECTED" ? (
              <span className="text-xs text-muted">Returned for correction and resubmission</span>
            ) : status === "APPROVED" ? (
              <span className="text-xs text-muted">Review complete</span>
            ) : null}
            {evidenceSummary && evidenceSummary.photos_unmapped > 0 ? (
              <span className="inline-flex rounded-full border border-[color:color-mix(in_oklab,var(--bad)_35%,var(--line))] bg-[color:color-mix(in_oklab,var(--bad)_7%,transparent)] px-2 py-0.5 text-[11px] font-semibold text-[var(--bad)]">
                {evidenceSummary.photos_unmapped} unmapped
              </span>
            ) : null}
            {descriptor ? <span className="text-xs text-muted">· {descriptor}{ownerLabel ? ` · owner ${ownerLabel}` : ""}</span> : null}
            {context?.incident_id != null ? (
              <Link to={`/incidents/${context.incident_id}`} className="inline-flex rounded-full border border-[color:color-mix(in_oklab,var(--brand)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--brand)_10%,transparent)] px-2 py-0.5 text-[11px] font-semibold text-[var(--brand)] hover:brightness-95">
                Incident #{context.incident_id}
              </Link>
            ) : null}
            {context?.event_group_id != null && context?.incident_id != null ? (
              <Link to={`/mission-center/${context.event_group_id}/${context.incident_id}`} className="text-[11px] font-semibold text-[var(--brand)] hover:underline">View on map</Link>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!invalid && id ? (
            <Link to={`/submissions/${id}/photo-evidence`} className={`${btn} font-semibold`} title={evidenceSummary ? `${evidenceSummary.photos_with_heading} photos include usable camera heading` : undefined}>
              {evidenceLabel}
            </Link>
          ) : null}

          <button type="button" onClick={onRefresh} disabled={busy || invalid} className={btn}>{busy ? "Working…" : "Refresh"}</button>

          {canEdit ? (
            <>
              <button type="button" onClick={onSaveDraft} disabled={busy || invalid} className={btn}>Save draft</button>
              {assessmentLinked && assessmentHref ? (
                <Link to={assessmentHref} className="rounded-md border border-[color:color-mix(in_oklab,var(--brand)_50%,var(--line))] bg-[var(--panel)] px-3 py-2 text-sm font-semibold text-[var(--brand)] hover:bg-[color:color-mix(in_oklab,var(--brand)_8%,var(--panel))]">
                  Send this for review on the assessment
                </Link>
              ) : (
                <button type="button" onClick={onSubmitDraft} disabled={busy || invalid} className="rounded-md bg-[var(--brand)] px-3 py-2 text-sm font-semibold text-white hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50">{submitLabel}</button>
              )}
            </>
          ) : null}

          {assessmentLinked && assessmentHref ? (
            status === "SUBMITTED" ? (
              <Link to={assessmentHref} className="rounded-md border border-[color:color-mix(in_oklab,var(--brand)_50%,var(--line))] bg-[var(--panel)] px-3 py-2 text-sm font-semibold text-[var(--brand)] hover:bg-[color:color-mix(in_oklab,var(--brand)_8%,var(--panel))]">
                Decide this on the assessment
              </Link>
            ) : null
          ) : canAct ? (
            <>
              <button type="button" onClick={onReject} disabled={busy || invalid} className="rounded-md border border-[color:color-mix(in_oklab,var(--bad)_50%,var(--line))] bg-[var(--panel)] px-3 py-2 text-sm font-semibold text-[var(--bad)] hover:bg-[color:color-mix(in_oklab,var(--bad)_8%,var(--panel))] disabled:cursor-not-allowed disabled:opacity-50">
                Return for correction
              </button>
              <button type="button" onClick={onApprove} disabled={busy || invalid} className="rounded-md bg-[var(--brand)] px-3 py-2 text-sm font-semibold text-white hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50">
                Approve submission
              </button>
            </>
          ) : null}

          {canDelete ? (
            <div className="relative">
              <button type="button" aria-label="More submission actions" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)} disabled={invalid} className={`${btn} font-semibold`}>
                •••
              </button>
              {menuOpen ? (
                <div className="absolute right-0 top-11 z-30 min-w-52 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-1.5 shadow-xl">
                  <button type="button" onClick={() => { setMenuOpen(false); onDelete(); }} className="block w-full rounded-md px-3 py-2 text-left text-sm font-medium text-[var(--bad)] hover:bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)]">
                    Delete submission
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
