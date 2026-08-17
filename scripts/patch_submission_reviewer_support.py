from pathlib import Path

path = Path("web/src/pages/SubmissionDetailPage.tsx")
text = path.read_text(encoding="utf-8")

old_import = 'import SubmissionDetailHeader from "../features/submissions/SubmissionDetailHeader";\n'
new_import = old_import + 'import SubmissionReviewerSupport from "../features/submissions/SubmissionReviewerSupport";\n'

if text.count(old_import) != 1:
    raise SystemExit(f"Expected exactly one SubmissionDetailHeader import, found {text.count(old_import)}")
if 'SubmissionReviewerSupport from "../features/submissions/SubmissionReviewerSupport"' not in text:
    text = text.replace(old_import, new_import, 1)

start_marker = '            <Section title="Reviewer Note" open>\n'
end_marker = '            {canManageSharing && (\n'
start_count = text.count(start_marker)
end_count = text.count(end_marker)
if start_count != 1 or end_count != 1:
    raise SystemExit(f"Expected one reviewer block boundary; found start={start_count}, end={end_count}")

start = text.index(start_marker)
end = text.index(end_marker, start)
existing = text[start:end]
required_fragments = [
    '<Section title="Attachments">',
    '<Section title="Workflow Events">',
    '"Open Photo"',
]
missing = [fragment for fragment in required_fragments if fragment not in existing]
if missing:
    raise SystemExit(f"Reviewer block no longer matches expected legacy structure: missing {missing}")

replacement = '''            <SubmissionReviewerSupport
              reviewNote={reviewNote}
              canReview={canReview}
              busy={busy}
              attachments={data.attachments}
              workflowEvents={data.workflow_events}
              downloadingAttachmentId={downloading}
              onReviewNoteChange={setReviewNote}
              onOpenAttachment={openDownloadUrl}
            />

'''
text = text[:start] + replacement + text[end:]

if text.count("<SubmissionReviewerSupport") != 1:
    raise SystemExit("Reviewer support component was not inserted exactly once")
if '<Section title="Workflow Events">' in text:
    raise SystemExit("Legacy Workflow Events section is still present")
if '"Open Photo"' in text:
    raise SystemExit('Legacy generic "Open Photo" action is still present')

path.write_text(text, encoding="utf-8")
