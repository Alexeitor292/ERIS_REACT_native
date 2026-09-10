# Workflows (As Implemented / Target)

> **Updated (routing v2):** The incident-to-technical-work flow is modeled as an
> **Assessment** (the official product concept). The "GISA submission" described
> below is the legacy *implementation* of the Assessment technical form and is
> kept for backward compatibility. The office chief now has exactly **two
> mutually exclusive routing choices** — hand off to a branch chief, or assign a
> **GeoTech senior engineer** directly — **review authority follows the
> assessment's routing path**, and **approval is terminal** (there is no
> sign-off). For the current workflow, role/permission matrix, District→GeoTech
> Office routing, and notifications, see
> [assessment-routing-authority-model.md](assessment-routing-authority-model.md).

> **Updated (organization model).** Offices, branches, membership, district
> coverage and the classification → role rules are **admin-editable data**
> (migration `20260911_org_model`): the district → GeoTech office map is no
> longer hard-coded, coordinator coverage is a table rather than a JSON key, and
> each assessment freezes the office and branch **names** it was routed to. A
> read-only **Viewer** role (`CALTRANS_VIEWER`) reads approved records and takes
> part in no workflow step at all. Operator guide:
> [org-model.md](org-model.md).

## Submission Workflow

Status progression (submission record):

- `DRAFT` -> `SUBMITTED` -> `APPROVED` or `REJECTED`

Key behavior:

- backend enforces edit/review permissions
- workflow events persisted in `workflow_events`
- GISA content + attachments can be updated while draft/rejected (based on permissions)
- **an assessment-linked technical form's status is written only by the
  assessment.** `POST /assessments/{id}/submit` and `/review` move the assessment
  and every linked submission in the **same transaction**
  (`DRAFT|REJECTED → SUBMITTED`, `SUBMITTED → APPROVED|REJECTED`), reporting
  `submissions_transitioned` and `submissions_skipped`. The form-level
  `POST /submissions/{id}/submit|review|approve|reject` return `409` on a linked
  form and point at the assessment, so there is exactly one Submit and exactly
  one Approve per piece of work. Unlinked legacy submissions are unchanged
  (admin-only decisions).

## Incident Workflow

### Current Incident Workflow (implemented)

Incident status/current stage fields:

- `status`: `NEW | IN_PROGRESS | RESOLVED`
- `current_stage`: `COORDINATOR_REVIEW | OFFICE_CHIEF_REVIEW | BRANCH_CHIEF_REVIEW | ENGINEER_ASSIGNED | RESOLVED`

Assessment states (the workflow that actually drives the stages above):

- `PENDING_OFFICE_DELEGATION` (`routing_path IS NULL`) → then **one of two
  routes** → `DRAFT` → `SUBMITTED` → `APPROVED` (**terminal**), with
  `REVISION_REQUESTED` looping back to the assignee.
- `PENDING_ENGINEER_ASSIGNMENT` exists on the **branch route only**.
- `FINALIZED` is **legacy history**: unreachable after routing v2 (the endpoint
  returns `410` and `trg_assessment_no_new_finalize` refuses the UPDATE), still
  readable and filterable.

Lifecycle (implemented endpoints):

1. Maintenance creates incident: `POST /incidents`
2. Coordinator reviews candidates: `GET /incidents/{id}/location-candidates`
3. Coordinator links location: `POST /incidents/{id}/location-link`
4. Coordinator forwards: `POST /incidents/{id}/coordinator/forward` (blocked until location is linked)
5. Coordinator triages: `POST /incidents/{id}/triage`. `ASSESSMENT_REQUIRED`
   creates the assessment with `routing_path = NULL`, resolves the GeoTech office
   from `org_office_districts` (the legacy constant is the fallback, not the
   source), **writes the routing snapshot** `routed_office_id` /
   `routed_office_name`, and moves the incident to `OFFICE_CHIEF_REVIEW`.
6. Office chief **routes**, choosing exactly one of:
   - `POST /assessments/{id}/delegate-branch` — hand off to a branch chief
     (`routing_path='BRANCH'`, incident → `BRANCH_CHIEF_REVIEW`), which also
     freezes `routed_branch_id` / `routed_branch_name` / `routed_branch_letter`
     from the chief's branch, then `POST /assessments/{id}/assign-engineer` by
     **that named branch chief** (incident → `ENGINEER_ASSIGNED`). The chosen
     Staff member is now validated: **out of office is refused** (`400`), **out
     of branch is allowed with a reason in `notes`** (`400` when it is missing),
     recorded on the `ENGINEER_ASSIGNED` event as `out_of_branch`; or
   - `POST /assessments/{id}/assign-senior-engineer` — assign a GeoTech senior
     engineer directly (`routing_path='SENIOR_ENGINEER'`, incident →
     `ENGINEER_ASSIGNED`, reusing the `ENGINEER` assignment stage).
7. The assignee fills and sends the technical form:
   `POST /assessments/{id}/submit`.
8. The route's reviewer decides: `POST /assessments/{id}/review`. `APPROVE` ends
   the assessment.
9. The assignee/admin resolves the incident: `POST /incidents/{id}/resolve`.
   Approval does **not** close the incident.

**Retired (`410 Gone`):** `POST /incidents/{id}/office-chief/assign-branch` and
`POST /incidents/{id}/branch-chief/assign-engineer`. They moved incident stages
and created `ENGINEER` assignments without touching `assessments.state` or
`routing_path`. `GET /incidents/{id}/office-chief/branch-options` stays live.

Supporting behavior:

- claim endpoint exists but now returns a disabled error.
- assignment (either route) creates/links the technical submission draft and the
  editor grant via `incident_submission_links` / `assessment_submissions`.
- **who a district's coordinators are is a table now.** `_routing_users_for`
  reads `org_coordinator_coverage WHERE is_active = 1`, ordered
  `is_primary DESC, full_name`, instead of
  `JSON_EXTRACT(metadata_json,'$.district')`. One coordinator may cover several
  districts and one district may have several coordinators; a district with no
  active coordinator is a query, surfaced on Administration › Organization ›
  Coverage.
- **the three assignment pickers group and annotate, and never choose.**
  Hand-off groups branch chiefs by branch, the senior-engineer picker groups by
  home city and district, and the Staff picker orders the caller's own branch
  first. Every person carries an open count and an "awaiting action" count, and
  an availability marking (`ROTATION_OUT` and friends) that is **rendered, never
  filtered and never sorted on**. No response carries a default or a preselected
  candidate.
- incident notifications are queued in `incident_notifications`. **The approval
  notice to the district coordinator is written on both the `IN_APP` and `EMAIL`
  channels**; every other notice is in-app only. EMAIL rows are a durable outbox:
  written inside the approval transaction, flushed after commit via
  `BackgroundTasks`, retried by a startup sweeper and by
  `python -m app.tools.flush_email_outbox`, and surfaced when they fail through
  `GET /admin/notifications/undelivered`. **With `SMTP_HOST` unset (the dev and
  CI default) nothing is sent** and the row simply stays undelivered.

### Target Workflow (maintenance-first, object-first incident model)

Requested flow for implementation:

1. Maintenance creates an incident with a minimal schema:
   - Location: `District`, `Country`, `Route`, `PM` (required)
   - `first_observed_at` (required)
   - `first_occurred_at` (optional)
   - Description (optional)
   - Media (photos/videos, optional)
2. Maintenance submits; item enters coordinator review.
3. Worker-created incident cannot be forwarded until location is reviewed and attached to a location record.
4. Coordinator sees nearby location candidates and chooses:
   - existing location record (`EXISTING`) to append this incident to history
   - `CREATE_NEW` to establish a new location object and append this incident there
5. If approved, incident is routed by location to the correct Maintenance Coordinator.
6. Once coordinator approves, it routes to the matching Office Chief. Which
   office serves which district is `org_office_districts`, edited in
   Administration › Organization › Offices — not a constant in the code.
7. Office Chief is notified (in-app today; email infrastructure now exists and is
   used for the approval notice).
8. Office Chief routes: hands off to a Branch Chief **or** assigns a GeoTech
   Senior Engineer. There is no third option — the office chief cannot assign
   Staff directly.
9. Branch Chief assigns a Staff member (branch route only).
10. Coordinator is notified when the assignment is made, and again **in-app and
    by email** when the assessment is approved.
11. Mobile surface remains role-minimal, showing only the views needed for each role.

Additional target data behavior:

- Keep location as a first-class object.
- Each incident is treated as an event/issue attached to a location.
- Multiple incidents can be logged against the same location over time.
- Historical incident timeline is queryable from a location-centric view.

### Location-match review by coordinator (new implementation hook)

- Incident create stores location context and initializes `location_match_status` as `PENDING_REVIEW`.
- Coordinator uses `/incidents/{incident_id}/location-candidates` to review nearby/existing object records.
- Coordinator uses `/incidents/{incident_id}/location-link` with:
  - `mode: EXISTING` + `location_id`, or
  - `mode: CREATE_NEW`.
- Coordinator forward remains blocked until a location is selected/created, ensuring history linkage before routing.

- `incident_locations` table stores canonical location records.
- `incidents` now carries `location_id`, `location_match_status`, and match-audit fields.

## Role-Based Mobile Visibility

When `scope=mobile`:

- Maintenance reporter sees own incidents.
- Coordinator sees district-scoped incidents.
- Office chief sees office-scoped incidents after coordinator review.
- Branch chief sees office incidents at branch/`ENGINEER_ASSIGNED`/resolved stages.
- Staff **and senior engineers** see only incidents assigned to them — both
  hold the same active `ENGINEER`-stage assignment row.
- A **Viewer** gets no mobile surface: the Incidents tab renders "ERIS Mobile is
  for field and office staff. Your account has read-only access — please use ERIS
  on the web," rather than the empty list a viewer used to land on.

Every one of those branches now matches **canonical role names as well as legacy
ones** (`roles.has_canonical_role`). Before the organization model, an account
holding only `MAINTENANCE_COORDINATOR`, `GEOTECH_OFFICE_CHIEF` or
`GEOTECH_BRANCH_CHIEF` matched no branch of `_mobile_scope_filters`, fell through
to `1=0`, and got an **empty feed** — and got no district or office narrowing at
all on incident detail.

## Read-Only Viewer (`CALTRANS_VIEWER`)

A viewer has **no workflow step**: nothing is ever assigned to them, they appear
in no picker and in no notification recipient list, and they hold no authority
anywhere. What they read is the **approved record** — an assessment in
`APPROVED` or `FINALIZED`, statewide, whole: incident, assessment, technical
form, photos, site and history.

- Anything in flight — new, in triage, `DRAFT`, `SUBMITTED`,
  `REVISION_REQUESTED` — answers **404, not 403**, so ids cannot be probed.
- `GET /assessments?queue=` answers `400 "Viewers have no work queue"`.
- Incidents closed at triage with **no** assessment are not public by default
  (`PUBLIC_INCLUDES_CLOSED_WITHOUT_ASSESSMENT = False`), so a viewer's incident
  count is legitimately smaller than the operational one.
- A chief who is *also* granted Viewer keeps full chief access: the narrowing
  applies only when Viewer is the account's only role.

Web navigation for a viewer is **one destination plus Settings** — Records,
opening on Incidents. No Home, no queues, no Map, no Terrain, no admin.

### Target Role Visibility (minimum-screen approach)

- MAINTENANCE: only two tabs
  - Create Incident
  - Track Incidents
- Other roles should only receive role-specific tabs/actions needed for their step in workflow.
- The goal is to avoid exposing unnecessary tabs and actions, especially on mobile.

## Offline Submission Sync (Mobile)

- user edits local draft
- queue ops persisted in chunked SecureStore
- sync loop attempts ordered replay when token/network available
- first failed op is retained with incremented attempt count and error message
