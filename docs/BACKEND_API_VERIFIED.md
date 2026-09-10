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

- `GET /arcgis/runtime-config`
  (`MAINTENANCE|FIELD_WORKER|MAINT_COORDINATOR|OFFICE_CHIEF|BRANCH_CHIEF|REVIEWER|GEOTECH_SENIOR_ENGINEER|ADMIN`)
  — the literal list does not consult `OPERATIONAL_ROLES`, so
  `GEOTECH_SENIOR_ENGINEER` is enumerated by hand; without it a
  senior-engineer-only account cannot load the map or the 3D terrain.

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
- `POST /submissions/{submission_id}/submit` — **`409` when the form is attached
  to an assessment**, pointing at `POST /assessments/{aid}/submit`. Only the
  assessment writes a linked form's status (routing v2 B1), so there is exactly
  one Submit per piece of work. Unlinked legacy submissions are unchanged.
- `POST /submissions/{submission_id}/review` — **`409` when the form is attached
  to an assessment**, pointing at `POST /assessments/{aid}/review`; otherwise
  **admin only**. The legacy `REVIEWER` account role no longer decides anything
  here.
- `POST /submissions/{submission_id}/approve` — as above
- `POST /submissions/{submission_id}/reject` — as above

The GISA write guards (`POST /submissions`, title/geometry/gisa/incident-types/
actions patches, delete, share/unshare, permissions, notify-coordinator, submit)
use `GISA_AUTHOR_ROLES` = `ADMIN|FIELD_WORKER|GEOTECH_ENGINEER|GEOTECH_SENIOR_ENGINEER`
instead of the old literal `FIELD_WORKER|ADMIN`. This lets a senior engineer
fill the form and unblocks accounts holding only the canonical
`GEOTECH_ENGINEER` name.

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
- `GET /admin/assessment-assignment-options/{assessment_id}?kind=` —
  `ENGINEER|SENIOR_ENGINEER|CONSULTED|REVIEWER`. `SENIOR_ENGINEER` filters
  **strictly** on the assessment's office (no blank-office fallback, unlike
  `ENGINEER`), with `ADMIN` exempt. `kind=REVIEWER` returns
  `400 "kind=REVIEWER was retired; use CONSULTED"` — it stays in the query
  pattern on purpose, because dropping it would make FastAPI answer a bare `422`
  before the handler could explain.
- `GET /admin/notifications/undelivered` — the EMAIL outbox backlog
  (`channel='EMAIL' AND delivered_at IS NULL`), with `delivery_attempts`,
  `last_error`, `last_attempt_at` and an `is_exhausted` flag for rows past
  `SMTP_MAX_ATTEMPTS`. `IN_APP` rows are excluded (nothing delivers them). This
  is the acceptance signal for the approval email: it should be empty.

## Incident APIs

- `POST /incidents`
- `GET /incidents`
- `GET /incidents/{incident_id}`
- `POST /incidents/{incident_id}/claim` (currently disabled; returns workflow-required error)
- `POST /incidents/{incident_id}/assign` (ADMIN) — admin recovery tool; **`409`
  when the incident's assessment has `routing_path='SENIOR_ENGINEER'`**
- `POST /incidents/{incident_id}/coordinator/forward`
- `GET /incidents/{incident_id}/location-candidates` (coordinator/admin)
- `POST /incidents/{incident_id}/location-link` (coordinator/admin)
- `GET /incidents/{incident_id}/office-chief/branch-options` — **still live**
  (a read, office access enforced; the branch half of the mobile picker)
- `POST /incidents/{incident_id}/office-chief/assign-branch` — **`410 Gone`
  (retired):** *"Routing moved to the assessment: POST
  /assessments/{aid}/delegate-branch or /assign-senior-engineer"*
- `POST /incidents/{incident_id}/branch-chief/assign-engineer` — **`410 Gone`
  (retired)**, same detail. Both moved incident stages and created `ENGINEER`
  assignments without touching `assessments.state`/`routing_path` — the bypass
  that could put a Staff member on a senior-engineer-route assessment. They stay
  mounted so an old client gets the explanation, not a 404.
- `POST /incidents/{incident_id}/unassign` (ADMIN)
- `POST /incidents/{incident_id}/resolve` — role guard widened to
  `GISA_AUTHOR_ROLES`; the real gate is unchanged (`assignee_user_id == user.id`),
  and on the senior engineer route the senior engineer *is* the active
  `ENGINEER`-stage assignee
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
- `BRANCH_CHIEF`: office incidents at branch/`ENGINEER_ASSIGNED`/resolved stages
- `FIELD_WORKER` / `GEOTECH_ENGINEER` / `GEOTECH_SENIOR_ENGINEER`: only
  incidents where an `ENGINEER`-stage assignment is active for the user. The
  senior engineer holds the same assignment row a Staff member would, so only
  the role guard in front of the `EXISTS` had to widen.
- `MAINTENANCE`: incidents reported by user
- `ADMIN`: unrestricted

## Dev API (only when `ENV=dev`)

- `POST /dev/seed-test-submission`

## Assessment APIs (`/assessments/*`, operational roles)

Routing v2: the office chief has exactly two mutually exclusive routing choices,
and **review authority is derived from `assessments.routing_path`** — never from
an account role or an assignment row. See
[assessment-routing-authority-model.md](assessment-routing-authority-model.md).

- `GET /assessments` (`state`, `office_code`,
  `queue=office_chief|office_chief_review|branch_chief|branch_chief_review|assignee|engineer|reviewer`)
  — every item carries `submission_id` (latest technical form) and
  `submission_ids[]` (all attached forms, oldest first). `office_chief_review` is
  **strictly** office-scoped (an unscoped chief gets zero rows); `engineer` is an
  alias of `assignee`; `reviewer` is a **permanent** alias resolved per routing
  path, so no client 400s.
- `GET /assessments/{assessment_id}`
- `GET /incidents/{incident_id}/assessment`
- `POST /incidents/{incident_id}/triage` (coordinator) — creates the assessment
  with `routing_path = NULL`
- `GET /assessments/{assessment_id}/branch-options`
- `POST /assessments/{assessment_id}/delegate-branch` (office chief) — **choice
  1.** Stamps `routing_path='BRANCH'`. `engineer_user_id` is **rejected with
  `400`**, not ignored: office chiefs assign senior engineers only, branch
  chiefs assign Staff only. Accepts **re-delegation** from any non-terminal
  branch-route state (it then rewrites only `branch_chief_user_id`, leaving the
  state, the assignee, the linked form and the incident stage alone). `409` from
  `APPROVED`/`FINALIZED`, and `409` if the senior engineer route was taken.
- `GET /assessments/{assessment_id}/senior-engineer-options` **(new)** (office chief;
  office access enforced) — `{assessment_id, office_code, items[]}`
- `POST /assessments/{assessment_id}/assign-senior-engineer` **(new)** (office chief)
  — **choice 2.** Stamps `routing_path='SENIOR_ENGINEER'`, assigns the senior
  engineer, opens the linked GISA draft. `409` if the branch route was taken;
  `400 "Selected user is not a senior engineer for this office"`.
- `POST /assessments/{assessment_id}/assign-engineer` — **only the branch chief
  the assessment was handed to** (`branch_chief_user_id`), or admin: `403`
  otherwise. `409` unless `routing_path='BRANCH'`.
- `POST /assessments/{assessment_id}/submissions` (the assignee — Staff member
  **or** senior engineer; creates a supplemental DRAFT technical submission pre-filled
  from the incident and attaches it via `assessment_submissions`)
- `POST /assessments/{assessment_id}/assignments` — `assignment_role` narrows to
  **`CONSULTED`** (for information only). `REVIEWER`/`APPROVER` →
  `400 "Reviewer assignment was retired. Review authority follows the
  assessment's routing path."`
- `DELETE /assessments/{assessment_id}/assignments/{assignment_id}` — refuses to
  detach `ENGINEER` **or** `SENIOR_ENGINEER` rows
- `POST /assessments/{assessment_id}/submit` (the assignee; requires at least one
  attached technical submission) — also drives the linked submissions
  `DRAFT`/`REJECTED` → `SUBMITTED` in the same transaction and notifies the
  route's reviewer. Response gains `submissions_transitioned` and
  `submissions_skipped[{submission_id, status}]`.
- `POST /assessments/{assessment_id}/review` — **the route's reviewer** (the named
  branch chief, or an office chief of the assessment's office), or admin.
  `notes` required for `REQUEST_REVISION`. Drives the linked submissions
  (`SUBMITTED` → `APPROVED`/`REJECTED`). **`APPROVE` is terminal.** Response:
  `{assessment, state, submissions_transitioned, submissions_skipped, notified}`,
  where `notified` reports the coordinators, the channels (`IN_APP` + `EMAIL`)
  and the author.
- `POST /assessments/{assessment_id}/finalize` — **`410 Gone` (retired):**
  *"Assessment finalization was retired: approval by the branch chief (branch
  route) or the office chief (senior engineer route) completes the
  assessment."* The route stays mounted so old clients get the sentence, not a
  404, and the database refuses new `FINALIZED` rows via
  `trg_assessment_no_new_finalize`.

Assessment payloads (`GET /assessments`, `GET /assessments/{id}`,
`GET /incidents/{id}/assessment`) carry `routing_path`
(`null|"BRANCH"|"SENIOR_ENGINEER"`), the route-neutral aliases
`assigned_user_id` / `assigned_user_kind` (`"STAFF"|"SENIOR_ENGINEER"`) over
`assigned_engineer_user_id`, `can_review`, and `review_owner`
(`{kind: "BRANCH_CHIEF"|"OFFICE_CHIEF", user_id, office_code}` — `user_id` is
`null` on the senior engineer route, where the reviewer is an office *function*).
Assignment rows carry `is_authority`, which is **always `false`**: historical
`REVIEWER`/`APPROVER` rows are kept as audit history and render as *"Former
reviewer — no approval authority."*

`GET /submissions/{submission_id}` additionally returns `context` (`incident_id`,
`incident_title`, `event_group_id`, `assessment_id`, `assessment_state`,
`assessment_routing_path`, `can_review`) when the technical form belongs to an
incident workflow, and `submission.can_review` beside `can_edit` for every
submission (a legacy unlinked form has no `context` at all).
