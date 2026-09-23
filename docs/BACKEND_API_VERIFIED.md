# Backend API (Verified)

Source files:

- `backend/app/main.py`
- `backend/app/routes/*.py`
- `backend/app/admin_users.py`
- `backend/app/photos.py`
- `backend/app/dev_routes.py`

## Public/Auth

- `POST /auth/login`
- `GET /auth/me` — own identity, plus an **`org` block** resolved by
  `org_directory.resolve_user_org`: `office_id`, `office_code`, `office_name`,
  `office_short_name`, `office_unit_number`, `office_is_active`, `branch_id`,
  `branch_letter`, `branch_name`, `branch_is_active`, `home_city`,
  `home_district`, `classification_code`, `classification_marker`,
  `position_number`, `job_title`, `level_code`, `availability`,
  `available_from`, `available_until`. The legacy `metadata` block stays beside
  it, unchanged, as the mirror.
- `GET /health`

## GISA Lookups

- `GET /gisa/lookups` (authenticated)

## ArcGIS Runtime Config

- `GET /arcgis/runtime-config` (every role) — the guest included, because the
  base map is what renders an approved record's location; the config grants no
  data by itself.

## Organization APIs

- `GET /org/offices` (any authenticated account, guest included) — offices and
  their branches for **labels only**: no personnel, no counts.
- `GET /org/districts/{district}/office` — table-backed resolution with a
  `source` of `routing_table` | `legacy_fallback` | `none`.

The district→office map is `org_office_districts`. It used to live in three
places: `incidents.OFFICE_BY_DISTRICT` (deleted, with `_office_for_district` and
the four call sites that bypassed the service), the constant in
`services/office_routing.py` (now re-exported from `org_directory` and reached
only as the fallback that makes the upgrade safe before the seed is re-run), and
the `0008` seed. `services/org_directory` is the **only** writer of
`geotech_office_routing`, which it mirrors for one release so a rollback still
routes correctly; a later revision drops that table.

### Assignment pickers — grouped, annotated, never preselected

`GET /assessments/{id}/branch-options`,
`GET /assessments/{id}/senior-engineer-options` and
`GET /admin/assessment-assignment-options/{id}?kind=ENGINEER` return
`{..., groups[], items[]}` with a shared item shape. Grouping is by **branch**
for the hand-off picker, by **home city and district** for senior engineers
(a `(Spec)` position has no branch), and by branch with the **caller's own branch
first** for Staff.

Each item carries `id`, `full_name`, `email`, `office_code`, `office_name`,
`branch_id`, `branch_letter`, `branch_name`, `home_city`, `home_district`,
`group_key`, `availability`, `available_from`, `available_until`, and two counts:
`open_assessment_count` (every non-terminal assessment they own as branch chief
or assignee) and `awaiting_action_count` (the subset whose next action is
theirs). Rendered as "4 open · 2 waiting on them".

Contractual, and asserted by `tests/test_pickers_db.py`:

- items are ordered by group, then by name — **never by load**;
- no response carries a default, a `selected` flag or a recommendation;
- groups come from the office's branch **rows**, so an empty branch still
  appears; a branch deactivated since someone was placed in it is appended, never
  dropped; a NULL-branch chief lands in a trailing `UNASSIGNED` group labelled
  "Branch not recorded";
- `accepts_assignments = 0` is returned **with the flag**, not omitted, so the
  client can disable the branch with its reason;
- `availability` is returned for rendering and is **never** used to filter or
  reorder.

## Guest (`GUEST`, read-only)

Roles as of `20260923_roles_consolidated`; see [roles-and-identity.md](roles-and-identity.md).

A third role category, deliberately outside `OPERATIONAL_ROLES` (that set is
state-blind and would hand a guest every DRAFT). An account whose ONLY role is
`GUEST` reads the **approved record** — an assessment in `APPROVED` or
`FINALIZED`, statewide, whole: incident, assessment, technical form, photos,
site, history — and nothing else. A non-public record answers **404, not 403**,
so ids cannot be probed; `/assessments?queue=` answers
`400 "Guests have no work queue"`. Every route carries `require_roles`,
`deny_public_only`, or an entry in
`services/public_visibility.VIEWER_READABLE_ROUTES` naming the in-body
predicate; `tests/test_route_guards.py` walks the live route table to keep that
true. A chief who ALSO holds `GUEST` keeps full chief access.

## Terrain Cross Sections (`/terrain-cross-sections/*`)

All six routes require an operational role (`require_roles(OPERATIONAL_ROLES)`),
matching the client gate on that page. Three of them — `POST /projects`,
`POST ""` and `PUT /{cross_section_id}` — previously authorized nothing beyond
being logged in.

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
  **admin only**.
- `POST /submissions/{submission_id}/approve` — as above
- `POST /submissions/{submission_id}/reject` — as above

The GISA write guards (`POST /submissions`, title/geometry/gisa/incident-types/
actions patches, delete, share/unshare, permissions, notify-coordinator, submit)
use `GISA_AUTHOR_ROLES` = `STAFF|SENIOR_SPECIALIST|ADMIN`: the two roles that
fill a technical assessment, and the administrator.

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
- `GET /admin/users/{user_id}/org` **(new)** — the membership record plus a
  `role_suggestion` derived from the stored `org_classifications` rules
- `PUT /admin/users/{user_id}/org` **(new)** — office, branch, classification,
  location and availability as a **per-field merge** (omitted fields untouched).
  Writes `org_user_profiles` and re-renders the `users.metadata_json` mirror in
  one transaction, and **never writes `user_roles`**: the classification rules
  produce a suggestion the admin acts on, not a grant.
- `GET /admin/org/offices` · `POST /admin/org/offices` ·
  `PATCH /admin/org/offices/{id}` · `POST /admin/org/offices/{id}/deactivate` ·
  `PUT /admin/org/offices/{id}/districts` **(new)** — `PATCH` answers `422` for a
  `code` field (the code is immutable: assessments and incidents join on it), the
  districts `PUT` answers `409` **naming** the office that already serves a
  district, and deactivate is never a delete.
- `GET /admin/org/branches` · `POST /admin/org/branches` ·
  `PATCH /admin/org/branches/{id}` · `PUT /admin/org/branches/{id}/districts`
  **(new)** — `409` on a duplicate active branch letter in one office; each
  district row carries `source` (`CHART|INFERRED|ADMIN`).
- `GET /admin/org/classifications` · `PUT /admin/org/classifications/{id}`
  **(new)** — the classification → role rules as data (14 `CLASS` rows + 2
  `PATTERN` rules), addressed by id because a `PATTERN` rule has no class code.
- `GET /admin/org/coverage` · `POST /admin/org/coverage` ·
  `DELETE /admin/org/coverage/{id}` **(new)** — coordinator coverage, with
  `uncovered_districts`; the DELETE deactivates the row rather than removing it.
- `PATCH /admin/users/{user_id}` — for the cutover release this still accepts
  `metadata.office_code` / `metadata.district` and **writes through** to
  `org_user_profiles` in the same transaction, answering `422` for a code that
  resolves to no office.
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

Routing/admin for incident ownership — **retired by the organization model**.
All three answer `410 Gone` with
`"Routing assignments moved to /admin/org/coverage in the organization model
release"`. The table and its rows are kept as history; coordinator coverage is
now `org_coordinator_coverage`, edited through `/admin/org/coverage`:

- `GET /incidents/routing/assignments` (ADMIN) — **410**
- `POST /incidents/routing/assignments` (ADMIN) — **410**
- `DELETE /incidents/routing/assignments/{assignment_id}` (ADMIN) — **410**

## Mobile-Scoped Filtering

`/incidents` and `/mission-center/incidents` support `scope=mobile` and apply
role-based filtering in backend (`_mobile_scope_filters`; incident detail
applies the same narrowing in `_ensure_incident_scope_access`). Several roles
union rather than override, and a role with no district or office recorded
reads nothing:

- `MAINTENANCE_COORDINATOR`: district-scoped incidents (from `org_coordinator_coverage`)
- `OFFICE_CHIEF`: office incidents not at coordinator-review stage
- `BRANCH_CHIEF`: office incidents at branch/`ENGINEER_ASSIGNED`/resolved stages
- `STAFF` / `SENIOR_SPECIALIST`: only incidents where an `ENGINEER`-stage
  assignment is active for the user. The Senior Specialist holds the same
  assignment row a Staff member would.
- `MAINTENANCE_CREW`: incidents reported by user
- `GUEST` (only role): no mobile surface — the mobile client shows a read-only
  notice instead of a feed
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
  otherwise. `409` unless `routing_path='BRANCH'`. The **target** is now
  validated too, which it never was before the organization model:
  `400 "Selected Staff member belongs to another GeoTech office"` (a hard refusal
  matching its two siblings; a Staff member with no recorded office is still
  allowed while the picker's blank-office fallback survives), and
  `400 "This Staff member is in another branch. Record why in notes to assign
  them anyway."` — out-of-branch is **allowed with a reason**, recorded on the
  `ENGINEER_ASSIGNED` event as `out_of_branch`. No new request field: the reason
  travels in the existing `notes`.
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

They also carry the **routing snapshot** — `routed_office_id`,
`routed_office_name`, `routed_branch_id`, `routed_branch_name`,
`routed_branch_letter` — written at triage and at `delegate-branch`. Clients
render the office and branch from these, never from a hard-coded map; the frozen
names are what stop a later rename or a retired branch from rewriting an existing
record.

`GET /submissions/{submission_id}` additionally returns `context` (`incident_id`,
`incident_title`, `event_group_id`, `assessment_id`, `assessment_state`,
`assessment_routing_path`, `can_review`) when the technical form belongs to an
incident workflow, and `submission.can_review` beside `can_edit` for every
submission (a legacy unlinked form has no `context` at all).
