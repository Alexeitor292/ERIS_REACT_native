# Workflows (As Implemented)

## Submission Workflow

Status progression (submission record):

- `DRAFT` -> `SUBMITTED` -> `APPROVED` or `REJECTED`

Key behavior:

- backend enforces edit/review permissions
- workflow events persisted in `workflow_events`
- GISA content + attachments can be updated while draft/rejected (based on permissions)

## Incident Workflow

Incident status/current stage fields:

- `status`: `NEW | IN_PROGRESS | RESOLVED`
- `current_stage`: `COORDINATOR_REVIEW | OFFICE_CHIEF_REVIEW | BRANCH_CHIEF_REVIEW | ENGINEER_ASSIGNED | RESOLVED`

Lifecycle (implemented endpoints):

1. Maintenance creates incident: `POST /incidents`
2. Coordinator forwards: `POST /incidents/{id}/coordinator/forward`
3. Office chief assigns branch chief: `POST /incidents/{id}/office-chief/assign-branch`
4. Branch chief assigns engineer: `POST /incidents/{id}/branch-chief/assign-engineer`
5. Engineer/admin resolves: `POST /incidents/{id}/resolve`

Supporting behavior:

- claim endpoint exists but now returns a disabled error.
- engineer assignment can create/link submission draft via `incident_submission_links`.
- incident notifications are queued in `incident_notifications` (in-app channel currently).

## Role-Based Mobile Visibility

When `scope=mobile`:

- Maintenance reporter sees own incidents.
- Coordinator sees district-scoped incidents.
- Office chief sees office-scoped incidents after coordinator review.
- Branch chief sees office incidents at branch/engineer/resolved stages.
- Engineer sees only incidents assigned to them.

## Offline Submission Sync (Mobile)

- user edits local draft
- queue ops persisted in chunked SecureStore
- sync loop attempts ordered replay when token/network available
- first failed op is retained with incremented attempt count and error message
