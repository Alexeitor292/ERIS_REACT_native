import type { Attachment, WorkflowEvent } from "../../api/types";
import { Section } from "./SubmissionDetailPrimitives";

const WORKFLOW_EVENT_LABELS: Record<string, string> = {
  CREATE: "Submission created",
  SUBMIT: "Submitted for review",
  RESUBMIT: "Resubmitted for review",
  APPROVE: "Approved",
  REJECT: "Returned for correction",
  COORDINATOR_NOTIFIED: "Coordinator notified",
};

function humanizeCode(value: string) {
  return value
    .trim()
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function workflowEventLabel(eventType: string) {
  const code = eventType.trim().toUpperCase();
  return WORKFLOW_EVENT_LABELS[code] ?? humanizeCode(code);
}

function formatTimestamp(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return String(bytes);
  if (bytes < 1024) return `${bytes.toLocaleString()} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb).toLocaleString()} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : mb.toFixed(0)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

function attachmentTypeLabel(attachment: Attachment) {
  const kind = String(attachment.kind || "").trim().toUpperCase();
  const mime = String(attachment.mime_type || "").trim().toLowerCase();

  if (kind === "PHOTO" || mime.startsWith("image/")) return "Photo";
  if (mime === "application/pdf") return "PDF";
  if (kind === "DOC") return "Document";
  if (mime.startsWith("video/")) return "Video";
  if (mime.startsWith("audio/")) return "Audio";
  return kind ? humanizeCode(kind) : (attachment.mime_type || "File");
}

function attachmentActionLabel(attachment: Attachment) {
  const type = attachmentTypeLabel(attachment);
  if (type === "Photo") return "Open photo";
  if (type === "PDF") return "Open PDF";
  return "Open file";
}

function transitionLabel(event: WorkflowEvent) {
  if (!event.from_status && !event.to_status) return null;
  if (!event.from_status && event.to_status) return `Status set to ${humanizeCode(event.to_status)}`;
  if (event.from_status && !event.to_status) return `Previous status: ${humanizeCode(event.from_status)}`;
  if (event.from_status === event.to_status) return `Status remained ${humanizeCode(event.to_status ?? "")}`;
  return `${humanizeCode(event.from_status ?? "")} → ${humanizeCode(event.to_status ?? "")}`;
}

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
              const transition = transitionLabel(event);
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
                      {formatTimestamp(event.created_at)}
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
