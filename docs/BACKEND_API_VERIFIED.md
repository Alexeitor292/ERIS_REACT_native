# Backend API (Verified)

Source files:

- `backend/app/main.py`
- `backend/app/routes/*.py`
- `backend/app/admin_users.py`
- `backend/app/photos.py`
- `backend/app/dev_routes.py`

## Public/Auth

- `POST /auth/login`
- `GET /auth/me`
- `GET /health`

## GISA Lookups

- `GET /gisa/lookups` (authenticated)

## ArcGIS Runtime Config

- `GET /arcgis/runtime-config` (`MAINTENANCE|FIELD_WORKER|REVIEWER|ADMIN`)

## Submission APIs

- `GET /geo/enrich-point`
- `POST /submissions`
- `GET /submissions`
- `GET /submissions/{submission_id}`
- `PATCH /submissions/{submission_id}/title`
- `DELETE /submissions/{submission_id}`
- `GET /submissions/{submission_id}/geometry`
- `PUT /submissions/{submission_id}/geometry`
- `PATCH /submissions/{submission_id}/gisa`
- `PUT /submissions/{submission_id}/gisa/incident-types`
- `PUT /submissions/{submission_id}/gisa/actions`
- `POST /submissions/{submission_id}/share`
- `DELETE /submissions/{submission_id}/share/{user_id}`
- `GET /submissions/{submission_id}/shared-with`
- `GET /submissions/{submission_id}/permissions`
- `PUT /submissions/{submission_id}/permissions`
- `POST /submissions/{submission_id}/gisa/pdf`
- `GET /submissions/{submission_id}/gisa/pdf`
- `POST /submissions/{submission_id}/submit`
- `POST /submissions/{submission_id}/review`
- `POST /submissions/{submission_id}/approve`
- `POST /submissions/{submission_id}/reject`

## Attachment APIs

- `POST /submissions/{submission_id}/photos`
- `POST /submissions/{submission_id}/attachments`
- `GET /attachments/{attachment_id}/download-url`
- `GET /attachments/{attachment_id}/content`
- `GET /photos/{photo_id}/download`
- `GET /photos/{photo_id}/content`

## Admin APIs (`/admin/*`, ADMIN role)

- `GET /admin/roles`
- `GET /admin/users`
- `GET /admin/users/{user_id}`
- `POST /admin/users`
- `PATCH /admin/users/{user_id}`
- `PUT /admin/users/{user_id}/roles`
- `POST /admin/users/{user_id}/reset-password`

## Incident APIs

- `POST /incidents`
- `GET /incidents`
- `GET /incidents/{incident_id}`
- `POST /incidents/{incident_id}/claim` (currently disabled; returns workflow-required error)
- `POST /incidents/{incident_id}/assign` (ADMIN)
- `POST /incidents/{incident_id}/coordinator/forward`
- `GET /incidents/{incident_id}/location-candidates` (coordinator/admin)
- `POST /incidents/{incident_id}/location-link` (coordinator/admin)
- `POST /incidents/{incident_id}/office-chief/assign-branch`
- `POST /incidents/{incident_id}/branch-chief/assign-engineer`
- `POST /incidents/{incident_id}/unassign` (ADMIN)
- `POST /incidents/{incident_id}/resolve`
- `POST /incidents/{incident_id}/attachments`
- `GET /mission-center/incidents`

Routing/admin for incident ownership:

- `GET /incidents/routing/assignments` (ADMIN)
- `POST /incidents/routing/assignments` (ADMIN)
- `DELETE /incidents/routing/assignments/{assignment_id}` (ADMIN)

## Mobile-Scoped Filtering

`/incidents` and `/mission-center/incidents` support `scope=mobile` and apply role-based filtering in backend:

- `MAINT_COORDINATOR`: district-scoped incidents (from routing assignments)
- `OFFICE_CHIEF`: office incidents not at coordinator-review stage
- `BRANCH_CHIEF`: office incidents at branch/engineer/resolved stages
- `FIELD_WORKER`: only incidents where engineer assignment is active for the user
- `MAINTENANCE`: incidents reported by user
- `ADMIN`: unrestricted

## Dev API (only when `ENV=dev`)

- `POST /dev/seed-test-submission`

## Assessment APIs (`/assessments/*`, operational roles)

- `GET /assessments` (`state`, `office_code`, `queue=office_chief|branch_chief|engineer|reviewer`) — every item carries `submission_id` (latest technical form) and `submission_ids[]` (all attached forms, oldest first)
- `GET /assessments/{assessment_id}`
- `GET /incidents/{incident_id}/assessment`
- `POST /incidents/{incident_id}/triage` (coordinator)
- `GET /assessments/{assessment_id}/branch-options`
- `POST /assessments/{assessment_id}/delegate-branch` (office chief; optional `engineer_user_id` assigns the engineer at delegation and moves the assessment straight to `DRAFT`)
- `POST /assessments/{assessment_id}/assign-engineer` (branch chief)
- `POST /assessments/{assessment_id}/submissions` (assigned engineer; creates a supplemental DRAFT technical submission pre-filled from the incident and attaches it via `assessment_submissions`)
- `POST /assessments/{assessment_id}/assignments` / `DELETE /assessments/{assessment_id}/assignments/{assignment_id}`
- `POST /assessments/{assessment_id}/submit` (requires at least one attached technical submission)
- `POST /assessments/{assessment_id}/review`
- `POST /assessments/{assessment_id}/finalize`

`GET /submissions/{submission_id}` additionally returns `context` (`incident_id`, `incident_title`, `event_group_id`, `assessment_id`, `assessment_state`) when the technical form belongs to an incident workflow.
