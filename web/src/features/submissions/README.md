# Submission reviewer support

`SubmissionReviewerSupport` owns the reviewer-facing note, attachment list, and workflow-history presentation extracted from `SubmissionDetailPage`.

The parent page remains responsible for data loading, authorization-derived capability flags, review submission, and attachment download URL requests. This boundary is intentionally presentation-focused so reviewer UX can evolve without coupling it to the GISA/map/terrain editing surface.

Source-backed values remain traceable: raw MIME types, workflow event codes, user IDs, and exact timestamps are still exposed alongside friendlier labels and formatting.
