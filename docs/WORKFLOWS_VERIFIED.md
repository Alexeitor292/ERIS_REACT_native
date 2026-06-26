# Workflows (As Implemented / Target)

> **Updated:** The incident-to-technical-work flow is now modeled as an
> **Assessment** (the official product concept). The "GISA submission" described
> below is the legacy *implementation* of the Assessment technical form and is
> kept for backward compatibility. For the current workflow, role/permission
> matrix, District→GeoTech Office routing, and assessment-level review
> assignments, see [assessment-routing-authority-model.md](assessment-routing-authority-model.md).

## Submission Workflow

Status progression (submission record):

- `DRAFT` -> `SUBMITTED` -> `APPROVED` or `REJECTED`

Key behavior:

- backend enforces edit/review permissions
- workflow events persisted in `workflow_events`
- GISA content + attachments can be updated while draft/rejected (based on permissions)

## Incident Workflow

### Current Incident Workflow (implemented)

Incident status/current stage fields:

- `status`: `NEW | IN_PROGRESS | RESOLVED`
- `current_stage`: `COORDINATOR_REVIEW | OFFICE_CHIEF_REVIEW | BRANCH_CHIEF_REVIEW | ENGINEER_ASSIGNED | RESOLVED`

Lifecycle (implemented endpoints):

1. Maintenance creates incident: `POST /incidents`
2. Coordinator reviews candidates: `GET /incidents/{id}/location-candidates`
3. Coordinator links location: `POST /incidents/{id}/location-link`
4. Coordinator forwards: `POST /incidents/{id}/coordinator/forward` (blocked until location is linked)
5. Office chief assigns branch chief: `POST /incidents/{id}/office-chief/assign-branch`
6. Branch chief assigns engineer: `POST /incidents/{id}/branch-chief/assign-engineer`
7. Engineer/admin resolves: `POST /incidents/{id}/resolve`

Supporting behavior:

- claim endpoint exists but now returns a disabled error.
- engineer assignment can create/link submission draft via `incident_submission_links`.
- incident notifications are queued in `incident_notifications` (in-app channel currently).

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
6. Once coordinator approves, it routes to the matching Office Chief (California regions: North West, South, etc.).
7. Office Chief is notified via email/text.
8. Office Chief assigns Branch Chief.
9. Branch Chief assigns Engineer.
10. Coordinator is notified when engineer assignment is made.
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
- Branch chief sees office incidents at branch/engineer/resolved stages.
- Engineer sees only incidents assigned to them.

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
