import type { WorkflowEvent } from "../../api/types";
import { SubmissionDetailCard } from "./SubmissionDetailPrimitives";
import { formatWorkflowTimestamp, workflowEventLabel, workflowTransitionLabel } from "./submissionReviewerSupportModel";

/**
 * Reviewer Note and Workflow History cards. Both render always-open inside the review
 * context grid; the old attachments table is replaced by the Submission library.
 */
export default function SubmissionReviewerSupport({
  reviewNote,
  canReview,
  busy,
  workflowEvents,
  onReviewNoteChange,
}: {
  reviewNote: string;
  canReview: boolean;
  busy: boolean;
  workflowEvents: WorkflowEvent[];
  onReviewNoteChange: (value: string) => void;
}) {
  return (
    <>
      <SubmissionDetailCard title="Reviewer Note" subtitle={canReview ? "Recorded with the approval or return decision." : "Read-only for your current role."}>
        <label className="block">
          <span className="sr-only">Reviewer note</span>
          <textarea
            value={reviewNote}
            onChange={(event) => onReviewNoteChange(event.target.value)}
            rows={4}
            disabled={busy || !canReview}
            placeholder={canReview ? "Add context for the approval or return decision." : "No reviewer note recorded."}
            className="w-full rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-70"
          />
        </label>
      </SubmissionDetailCard>

      <SubmissionDetailCard title={`Workflow History (${workflowEvents.length})`} subtitle="Every status transition recorded for this submission.">
        {workflowEvents.length === 0 ? (
          <div className="text-sm text-muted">No workflow events have been recorded.</div>
        ) : (
          <ol className="space-y-2">
            {workflowEvents.map((event) => {
              const transition = workflowTransitionLabel(event);
              const rawEventType = event.event_type.trim().toUpperCase();
              return (
                <li key={event.id} className="rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                    <div>
                      <div className="font-semibold">{workflowEventLabel(rawEventType)}</div>
                      <div className="mt-0.5 text-xs text-muted">
                        Event <span className="font-mono">{rawEventType}</span> · Actor user #{event.actor_user_id}
                      </div>
                    </div>
                    <time dateTime={event.created_at} title={event.created_at} className="text-xs text-muted">
                      {formatWorkflowTimestamp(event.created_at)}
                    </time>
                  </div>
                  {transition ? <div className="mt-2 text-sm">{transition}</div> : null}
                  {event.comment ? (
                    <div className="mt-2 rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm leading-5">
                      {event.comment}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </SubmissionDetailCard>
    </>
  );
}
