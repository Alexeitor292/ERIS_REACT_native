import type { Attachment, WorkflowEvent } from "../../api/types";
import { Section } from "./SubmissionDetailPrimitives";
import {
  attachmentActionLabel,
  attachmentTypeLabel,
  formatFileSize,
  formatWorkflowTimestamp,
  workflowEventLabel,
  workflowTransitionLabel,
} from "./submissionReviewerSupportModel";

export default function SubmissionReviewerSupport({
  reviewNote,
  canReview,
  busy,
  attachments,
  workflowEvents,
  downloadingAttachmentId,
  onReviewNoteChange,
  onOpenAttachment,
}: {
  reviewNote: string;
  canReview: boolean;
  busy: boolean;
  attachments: Attachment[];
  workflowEvents: WorkflowEvent[];
  downloadingAttachmentId: number | null;
  onReviewNoteChange: (value: string) => void;
  onOpenAttachment: (attachmentId: number) => void;
}) {
  return (
    <>
      <Section title="Reviewer Note" open>
        <label className="block">
          <span className="sr-only">Reviewer note</span>
          <textarea
            value={reviewNote}
            onChange={(event) => onReviewNoteChange(event.target.value)}
            rows={3}
            disabled={busy || !canReview}
            placeholder={canReview ? "Add context for the approval or return decision." : "No reviewer note recorded."}
            className="w-full rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-70"
          />
        </label>
        {!canReview ? (
          <p className="mt-2 text-xs text-muted">Reviewer notes are read-only for your current role.</p>
        ) : null}
      </Section>

      <Section title={`Attachments (${attachments.length})`}>
        {attachments.length === 0 ? (
          <div className="text-sm text-muted">No attachments are associated with this submission.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-[var(--line)] text-left text-xs font-semibold uppercase tracking-wide text-muted">
                  <th scope="col" className="px-2 py-2">ID</th>
                  <th scope="col" className="px-2 py-2">File</th>
                  <th scope="col" className="px-2 py-2">Type</th>
                  <th scope="col" className="px-2 py-2">Size</th>
                  <th scope="col" className="px-2 py-2 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {attachments.map((attachment) => {
                  const opening = downloadingAttachmentId === attachment.id;
                  return (
                    <tr key={attachment.id} className="border-b border-[var(--line)]/50 last:border-b-0">
                      <td className="px-2 py-2 text-sm tabular-nums">{attachment.id}</td>
                      <td className="px-2 py-2 text-sm font-medium">{attachment.file_name}</td>
                      <td className="px-2 py-2 text-sm">
                        <div>{attachmentTypeLabel(attachment)}</div>
                        <div className="text-xs text-muted">{attachment.mime_type || "Unknown MIME type"}</div>
                      </td>
                      <td className="px-2 py-2 text-sm tabular-nums" title={`${attachment.file_size_bytes.toLocaleString()} bytes`}>
                        {formatFileSize(attachment.file_size_bytes)}
                      </td>
                      <td className="px-2 py-2 text-right text-sm">
                        <button
                          type="button"
                          onClick={() => onOpenAttachment(attachment.id)}
                          disabled={opening}
                          className="rounded border border-[var(--line)] bg-[var(--panel)] px-2.5 py-1.5 text-xs font-medium hover:bg-[var(--panel-soft)] disabled:opacity-60"
                        >
                          {opening ? "Opening…" : attachmentActionLabel(attachment)}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title={`Workflow History (${workflowEvents.length})`}>
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
      </Section>
    </>
  );
}
