import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { api } from "../api/client";
import type { SubmissionDetail } from "../api/types";
import SubmissionPhotoEvidencePanel from "../features/submissions/SubmissionPhotoEvidencePanel";
import AppShell from "../ui/AppShell";
import { buildSubmissionDisplayTitle } from "../utils/submissionLabel";

export default function SubmissionPhotoEvidencePage() {
  const { id } = useParams();
  const submissionId = Number(id);
  const invalid = !id || !Number.isInteger(submissionId) || submissionId <= 0;
  const [submission, setSubmission] = useState<SubmissionDetail | null>(null);

  useEffect(() => {
    if (invalid) {
      setSubmission(null);
      return;
    }
    let cancelled = false;
    api<SubmissionDetail>(`/submissions/${submissionId}`)
      .then((data) => {
        if (!cancelled) setSubmission(data);
      })
      .catch(() => {
        if (!cancelled) setSubmission(null);
      });
    return () => {
      cancelled = true;
    };
  }, [invalid, submissionId]);

  const title = useMemo(() => {
    if (invalid) return "Photo Evidence";
    if (!submission) return `Photo Evidence — Submission #${submissionId}`;
    return `Photo Evidence — ${buildSubmissionDisplayTitle({
      id: submission.submission.id,
      created_at: submission.submission.created_at,
      district: submission.gisa?.district,
      county: submission.gisa?.county,
      route: submission.gisa?.route,
      post_mile: submission.gisa?.post_mile,
    })}`;
  }, [invalid, submission, submissionId]);

  return (
    <AppShell title={title}>
      <div className="p-4 md:p-5">
        <div className="mb-4">
          <Link to={invalid ? "/submissions" : `/submissions/${submissionId}`} className="text-sm font-medium text-muted hover:text-[var(--ink)]">
            ← Back to submission
          </Link>
        </div>
        <SubmissionPhotoEvidencePanel submissionId={submissionId} />
      </div>
    </AppShell>
  );
}
