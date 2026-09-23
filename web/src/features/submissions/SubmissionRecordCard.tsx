import { Check, FilePenLine, Send, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";

import { SubmissionDetailCard, SubmissionStatusBadge } from "./SubmissionDetailPrimitives";
import { formatWorkflowTimestamp } from "./submissionReviewerSupportModel";

type Props = {
  descriptor: string;
  submissionId: number;
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
};

/** The form's identity and where it is in its life: created, submitted, reviewed. */
export default function SubmissionRecordCard({ descriptor, submissionId, status, createdAt, updatedAt, submittedAt, reviewedAt }: Props) {
  const steps: Array<{ label: string; at: string | null; icon: ReactNode }> = [
    { label: "Created", at: createdAt, icon: <FilePenLine size={14} /> },
    { label: "Submitted", at: submittedAt, icon: <Send size={14} /> },
    { label: status === "REJECTED" ? "Returned" : "Reviewed", at: reviewedAt, icon: <ShieldCheck size={14} /> },
  ];
  const reached = steps.filter((step) => step.at).length;

  return (
    <SubmissionDetailCard title="Record" subtitle="This form's identity and where it stands." actions={<SubmissionStatusBadge status={status} />}>
      <div className="mb-4">
        <div className="text-base font-semibold leading-snug">{descriptor}</div>
        <div className="mt-0.5 text-xs text-muted">
          Form #{submissionId}
          {updatedAt ? ` · last changed ${formatWorkflowTimestamp(updatedAt)}` : ""}
        </div>
      </div>
      <ol className="grid grid-cols-3 gap-2" aria-label="Progress">
        {steps.map((step, index) => {
          const done = Boolean(step.at);
          return (
            <li key={step.label} className="relative flex flex-col items-center text-center">
              {index > 0 ? (
                <span
                  className="absolute right-1/2 top-4 h-0.5 w-full -translate-y-1/2"
                  style={{ background: index < reached ? "var(--accent)" : "var(--line)" }}
                  aria-hidden
                />
              ) : null}
              <span
                className={`relative z-10 flex h-8 w-8 items-center justify-center rounded-full border-2 ${
                  done ? "border-[var(--accent)] bg-[var(--accent)] text-white" : "border-[var(--line)] bg-[var(--panel)] text-muted"
                }`}
                aria-hidden
              >
                {done ? <Check size={14} strokeWidth={3} /> : step.icon}
              </span>
              <span className={`mt-1.5 text-xs font-semibold ${done ? "" : "text-muted"}`}>{step.label}</span>
              <span className="text-[11px] text-muted">{step.at ? formatWorkflowTimestamp(step.at) : "Not yet"}</span>
            </li>
          );
        })}
      </ol>
    </SubmissionDetailCard>
  );
}
