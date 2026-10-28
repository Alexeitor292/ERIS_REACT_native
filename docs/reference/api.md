# API reference

> **Generated** by `scripts/docs/generate_api_reference.py` from the FastAPI application. Do not edit by hand; CI fails when this file is stale.

ERIS exposes **208 operations** under `https://<web-host>/api`. Request and response schemas are in the live OpenAPI document (`/api/openapi.json`, served only when `API_DOCS_ENABLED=true`, so normally on development servers).

**Access** is read from each route's guards:

- **Public**: no session needed (sign-in, health, configuration).
- **Signed in (record rules apply)**: any signed-in user; the handler then limits what that person may see (for example a Guest sees approved records only). See [roles and permissions](../security/roles-and-permissions.md).
- **Signed in, not Guest-only**: any role except an account whose only role is Guest.
- **Roles: …**: only those roles.

Authentication: the web sends its HttpOnly session cookie plus `X-CSRF-Token` on writes; native clients send `Authorization: Bearer <session>`. Tokens are never accepted in URLs. See [authentication and sessions](../security/authentication-and-sessions.md).

## Contents

- [Administration](#administration) (28)
- [Assessments](#assessments) (14)
- [Attachments and photos](#attachments-and-photos) (4)
- [Dev](#dev) (1)
- [Event groups](#event-groups) (5)
- [Geo](#geo) (1)
- [Health](#health) (1)
- [Incident classifications](#incident-classifications) (1)
- [Incidents](#incidents) (33)
- [Maintenance work](#maintenance-work) (6)
- [Maps](#maps) (1)
- [Me](#me) (4)
- [Mission center](#mission-center) (4)
- [Notifications](#notifications) (5)
- [Ops](#ops) (1)
- [Organization](#organization) (18)
- [Projects](#projects) (5)
- [Road inventory](#road-inventory) (13)
- [Shares](#shares) (2)
- [Sign-in and sessions](#sign-in-and-sessions) (8)
- [Submissions (GISA)](#submissions-gisa) (47)
- [Terrain](#terrain) (6)

## Administration

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/admin/assessment-assignment-options/{assessment_id}` | Roles: ADMIN, BRANCH_CHIEF, OFFICE_CHIEF | Return active identities eligible for assessment assignment UI. |
| `GET` | `/admin/notifications/undelivered` | Roles: ADMIN | The EMAIL outbox backlog — every notice that was due and never sent. |
| `POST` | `/admin/offline-scene-packages` | Roles: ADMIN | ADMIN-only registration of an operator-uploaded .mspk. |
| `GET` | `/admin/org/branches` | Roles: ADMIN | Admin list branches |
| `POST` | `/admin/org/branches` | Roles: ADMIN | Admin create branch |
| `PATCH` | `/admin/org/branches/{branch_id}` | Roles: ADMIN | Per-field merge; deactivation is one of the fields. |
| `PUT` | `/admin/org/branches/{branch_id}/districts` | Roles: ADMIN | Replace the districts a branch covers, each row carrying its provenance. |
| `GET` | `/admin/org/classifications` | Roles: ADMIN | The derivation table as data: fourteen CLASS rows and two PATTERN rules. |
| `PUT` | `/admin/org/classifications/{classification_id}` | Roles: ADMIN | Edit one rule, addressed BY ID. |
| `GET` | `/admin/org/coverage` | Roles: ADMIN | Who covers each district — and which districts nobody covers. |
| `POST` | `/admin/org/coverage` | Roles: ADMIN | Admin create coverage |
| `DELETE` | `/admin/org/coverage/{coverage_id}` | Roles: ADMIN | Deactivate a coverage row. The row stays: it is who was told, and when. |
| `GET` | `/admin/org/offices` | Roles: ADMIN | Admin list offices |
| `POST` | `/admin/org/offices` | Roles: ADMIN | Admin create office |
| `PATCH` | `/admin/org/offices/{office_id}` | Roles: ADMIN | Per-field merge. The office CODE is not editable, and says so. |
| `POST` | `/admin/org/offices/{office_id}/deactivate` | Roles: ADMIN | Retire an office. Never a delete, and never a revocation. |
| `PUT` | `/admin/org/offices/{office_id}/districts` | Roles: ADMIN | Replace the districts an office serves. |
| `GET` | `/admin/roles` | Roles: ADMIN | List roles |
| `GET` | `/admin/users` | Roles: ADMIN | List users |
| `POST` | `/admin/users` | Roles: ADMIN | Create user |
| `GET` | `/admin/users/{user_id}` | Roles: ADMIN | Get user |
| `PATCH` | `/admin/users/{user_id}` | Roles: ADMIN | Update user |
| `PUT` | `/admin/users/{user_id}/admin` | Roles: ADMIN | The one role granted directly. Everything else follows from where people sit. |
| `GET` | `/admin/users/{user_id}/org` | Roles: ADMIN | Admin get user org |
| `PUT` | `/admin/users/{user_id}/org` | Roles: ADMIN | Where this person sits, as a PER-FIELD MERGE. Grants nothing. |
| `POST` | `/admin/users/{user_id}/reset-password` | Roles: ADMIN | Reset password |
| `POST` | `/admin/users/{user_id}/revoke-sessions` | Roles: ADMIN | End every ERIS session the account holds, without disabling it. |
| `PUT` | `/admin/users/{user_id}/roles` | Roles: ADMIN | Replace roles |

## Assessments

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/assessments` | Roles: ADMIN, BRANCH_CHIEF, GUEST, MAINTENANCE_COORDINATOR, OFFICE_CHIEF, SENIOR_SPECIALIST, STAFF | Broad read for non-maintenance operational users, plus the public record. |
| `GET` | `/assessments/routing/preview` | Roles: ADMIN, MAINTENANCE_COORDINATOR | Coordinator-facing preview of the destination GeoTech office for a district, so the calculated routing is visible before triage. |
| `GET` | `/assessments/{assessment_id}` | Roles: ADMIN, BRANCH_CHIEF, GUEST, MAINTENANCE_COORDINATOR, OFFICE_CHIEF, SENIOR_SPECIALIST, STAFF | Get assessment |
| `POST` | `/assessments/{assessment_id}/assign-engineer` | Roles: ADMIN, BRANCH_CHIEF | Assign engineer |
| `POST` | `/assessments/{assessment_id}/assign-senior-engineer` | Roles: ADMIN, OFFICE_CHIEF | Assign a Senior Specialist directly — transition T4 (design §3.3). |
| `POST` | `/assessments/{assessment_id}/assignments` | Roles: ADMIN, BRANCH_CHIEF, OFFICE_CHIEF | Attach someone to the assessment FOR INFORMATION (CONSULTED). |
| `DELETE` | `/assessments/{assessment_id}/assignments/{assignment_id}` | Roles: ADMIN, BRANCH_CHIEF, OFFICE_CHIEF | Remove assignment |
| `GET` | `/assessments/{assessment_id}/branch-options` | Roles: ADMIN, OFFICE_CHIEF | The branch chiefs this office chief may hand the assessment to. |
| `POST` | `/assessments/{assessment_id}/delegate-branch` | Roles: ADMIN, OFFICE_CHIEF | Hand the assessment off to a branch chief, and stamp the branch route. |
| `POST` | `/assessments/{assessment_id}/finalize` | Roles: ADMIN, OFFICE_CHIEF | 410 Gone. |
| `POST` | `/assessments/{assessment_id}/review` | Roles: ADMIN, BRANCH_CHIEF, MAINTENANCE_COORDINATOR, OFFICE_CHIEF, SENIOR_SPECIALIST, STAFF | Approve (T6 — terminal) or request a revision (T7). Design §3.3. |
| `GET` | `/assessments/{assessment_id}/senior-engineer-options` | Roles: ADMIN, OFFICE_CHIEF | The Senior Specialists this office chief may assign (design §5.1). |
| `POST` | `/assessments/{assessment_id}/submissions` | Roles: ADMIN, SENIOR_SPECIALIST, STAFF | Create another DRAFT technical submission for this assessment. |
| `POST` | `/assessments/{assessment_id}/submit` | Roles: ADMIN, SENIOR_SPECIALIST, STAFF | Send the assessment for review — transition T5 (design §3.3). |

## Attachments and photos

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/attachments/{attachment_id}/content` | Signed in (record rules apply) | Attachment content |
| `GET` | `/attachments/{attachment_id}/download-url` | Signed in (record rules apply) | Attachment download url |
| `GET` | `/photos/{photo_id}/content` | Public | Photo content |
| `GET` | `/photos/{photo_id}/download` | Signed in (record rules apply) | Photo download |

## Dev

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `POST` | `/dev/seed-test-submission` | Roles: ADMIN | DEV ONLY: Creates a single submission with a workflow event. Restricted to ADMIN in dev. |

## Event groups

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/event-groups` | Roles: ADMIN, BRANCH_CHIEF, MAINTENANCE_COORDINATOR, OFFICE_CHIEF, SENIOR_SPECIALIST, STAFF | List event groups |
| `GET` | `/event-groups/{event_group_id}` | Roles: ADMIN, BRANCH_CHIEF, MAINTENANCE_COORDINATOR, OFFICE_CHIEF, SENIOR_SPECIALIST, STAFF | Get event group |
| `PATCH` | `/event-groups/{event_group_id}` | Roles: ADMIN, MAINTENANCE_COORDINATOR | Update event group |
| `POST` | `/event-groups/{event_group_id}/close` | Roles: ADMIN, MAINTENANCE_COORDINATOR | Close event group |
| `POST` | `/event-groups/{event_group_id}/reopen` | Roles: ADMIN, MAINTENANCE_COORDINATOR | Reopen event group |

## Geo

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/geo/enrich-point` | Signed in, not Guest-only | Enrich point |

## Health

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | Public | Health |

## Incident classifications

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `POST` | `/incident-classifications/query` | Roles: ADMIN, BRANCH_CHIEF, GUEST, MAINTENANCE_COORDINATOR, MAINTENANCE_CREW, OFFICE_CHIEF, SENIOR_SPECIALIST, STAFF | Return assessment-derived classifications for up to 500 Incidents in one scoped query. This is the list/detail API for Project workspaces and avoids an N+1 request pattern as Projects accumulate many Incidents. |

## Incidents

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/incident-locations/{location_id}/timeline` | Roles: ADMIN, BRANCH_CHIEF, GUEST, MAINTENANCE_COORDINATOR, OFFICE_CHIEF | Get incident location timeline |
| `GET` | `/incidents` | Roles: ADMIN, BRANCH_CHIEF, GUEST, MAINTENANCE_COORDINATOR, MAINTENANCE_CREW, OFFICE_CHIEF, SENIOR_SPECIALIST, STAFF | List incidents |
| `POST` | `/incidents` | Roles: ADMIN, BRANCH_CHIEF, GUEST, MAINTENANCE_COORDINATOR, MAINTENANCE_CREW, OFFICE_CHIEF, SENIOR_SPECIALIST, STAFF | Create incident |
| `GET` | `/incidents/routing/assignments` | Roles: ADMIN | 410 Gone — coordinator coverage now lives at /admin/org/coverage. |
| `POST` | `/incidents/routing/assignments` | Roles: ADMIN | 410 Gone — POST /admin/org/coverage. |
| `DELETE` | `/incidents/routing/assignments/{assignment_id}` | Roles: ADMIN | 410 Gone — DELETE /admin/org/coverage/{id}. |
| `GET` | `/incidents/{incident_id}` | Roles: ADMIN, BRANCH_CHIEF, GUEST, MAINTENANCE_COORDINATOR, MAINTENANCE_CREW, OFFICE_CHIEF, SENIOR_SPECIALIST, STAFF | Get incident |
| `PATCH` | `/incidents/{incident_id}` | Roles: ADMIN, MAINTENANCE_CREW, STAFF | Maintenance resubmit incident |
| `GET` | `/incidents/{incident_id}/assessment` | Roles: ADMIN, BRANCH_CHIEF, GUEST, MAINTENANCE_COORDINATOR, OFFICE_CHIEF, SENIOR_SPECIALIST, STAFF | Get assessment for incident |
| `POST` | `/incidents/{incident_id}/assign` | Roles: ADMIN | Assign incident |
| `GET` | `/incidents/{incident_id}/attachments` | Roles: ADMIN, BRANCH_CHIEF, GUEST, MAINTENANCE_COORDINATOR, MAINTENANCE_CREW, OFFICE_CHIEF, SENIOR_SPECIALIST, STAFF | Everything the reporter attached to a field report, with access URLs. |
| `POST` | `/incidents/{incident_id}/attachments` | Roles: ADMIN, BRANCH_CHIEF, GUEST, MAINTENANCE_COORDINATOR, MAINTENANCE_CREW, OFFICE_CHIEF, SENIOR_SPECIALIST, STAFF | Upload incident attachment |
| `POST` | `/incidents/{incident_id}/branch-chief/assign-engineer` | Roles: ADMIN, BRANCH_CHIEF | 410 Gone — assign the Staff member on the assessment (design §5.3). |
| `POST` | `/incidents/{incident_id}/claim` | Roles: ADMIN, MAINTENANCE_CREW, STAFF | Claim incident |
| `GET` | `/incidents/{incident_id}/classification` | Roles: ADMIN, BRANCH_CHIEF, GUEST, MAINTENANCE_COORDINATOR, MAINTENANCE_CREW, OFFICE_CHIEF, SENIOR_SPECIALIST, STAFF | Get incident classification |
| `POST` | `/incidents/{incident_id}/coordinator/approve` | Roles: ADMIN, MAINTENANCE_COORDINATOR | Coordinator approve incident |
| `POST` | `/incidents/{incident_id}/coordinator/forward` | Roles: ADMIN, MAINTENANCE_COORDINATOR | Coordinator forward incident |
| `POST` | `/incidents/{incident_id}/coordinator/request-revision` | Roles: ADMIN, MAINTENANCE_COORDINATOR | Coordinator request revision |
| `POST` | `/incidents/{incident_id}/event-group-association` | Roles: ADMIN, MAINTENANCE_COORDINATOR | Associate incident event group |
| `GET` | `/incidents/{incident_id}/event-group-context` | Roles: ADMIN, MAINTENANCE_COORDINATOR | Incident event group context |
| `GET` | `/incidents/{incident_id}/location-candidates` | Roles: ADMIN, MAINTENANCE_COORDINATOR | List incident location candidates |
| `POST` | `/incidents/{incident_id}/location-link` | Roles: ADMIN, MAINTENANCE_COORDINATOR | Link incident location |
| `GET` | `/incidents/{incident_id}/nearby-event-groups` | Roles: ADMIN, MAINTENANCE_COORDINATOR | Nearby event groups for incident |
| `GET` | `/incidents/{incident_id}/nearby-projects` | Roles: ADMIN, MAINTENANCE_COORDINATOR | Nearby projects for incident |
| `POST` | `/incidents/{incident_id}/office-chief/assign-branch` | Roles: ADMIN, OFFICE_CHIEF | 410 Gone — hand off on the assessment (design §5.3). |
| `GET` | `/incidents/{incident_id}/office-chief/branch-options` | Roles: ADMIN, OFFICE_CHIEF | Office chief branch options |
| `POST` | `/incidents/{incident_id}/project-association` | Roles: ADMIN, MAINTENANCE_COORDINATOR | Associate incident project |
| `GET` | `/incidents/{incident_id}/project-context` | Roles: ADMIN, MAINTENANCE_COORDINATOR | Incident project context |
| `DELETE` | `/incidents/{incident_id}/provisional` | Roles: ADMIN, MAINTENANCE_COORDINATOR, MAINTENANCE_CREW, STAFF | Discard provisional incident |
| `POST` | `/incidents/{incident_id}/resolve` | Roles: ADMIN, SENIOR_SPECIALIST, STAFF | Resolve incident |
| `POST` | `/incidents/{incident_id}/triage` | Roles: ADMIN, MAINTENANCE_COORDINATOR | Triage incident |
| `POST` | `/incidents/{incident_id}/unassign` | Roles: ADMIN | Unassign incident |
| `GET` | `/incidents/{incident_id}/workflow-tree` | Signed in (record rules apply) | Get incident workflow tree |

## Maintenance work

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/maintenance-work/incidents` | Roles: ADMIN, BRANCH_CHIEF, GUEST, MAINTENANCE_COORDINATOR, MAINTENANCE_CREW, OFFICE_CHIEF, SENIOR_SPECIALIST, STAFF | Work |
| `GET` | `/maintenance-work/incidents/{incident_id}` | Roles: ADMIN, BRANCH_CHIEF, GUEST, MAINTENANCE_COORDINATOR, MAINTENANCE_CREW, OFFICE_CHIEF, SENIOR_SPECIALIST, STAFF | Detail |
| `POST` | `/maintenance-work/incidents/{incident_id}/actions` | Roles: ADMIN, BRANCH_CHIEF, GUEST, MAINTENANCE_COORDINATOR, MAINTENANCE_CREW, OFFICE_CHIEF, SENIOR_SPECIALIST, STAFF | Act |
| `GET` | `/maintenance-workflows` | Roles: ADMIN, BRANCH_CHIEF, GUEST, MAINTENANCE_COORDINATOR, MAINTENANCE_CREW, OFFICE_CHIEF, SENIOR_SPECIALIST, STAFF | Configurations |
| `PUT` | `/maintenance-workflows/{district}` | Roles: ADMIN, BRANCH_CHIEF, GUEST, MAINTENANCE_COORDINATOR, MAINTENANCE_CREW, OFFICE_CHIEF, SENIOR_SPECIALIST, STAFF | Publish |
| `GET` | `/maintenance-workflows/{district}/people` | Roles: ADMIN, BRANCH_CHIEF, GUEST, MAINTENANCE_COORDINATOR, MAINTENANCE_CREW, OFFICE_CHIEF, SENIOR_SPECIALIST, STAFF | People |

## Maps

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/arcgis/runtime-config` | Roles: ADMIN, BRANCH_CHIEF, GUEST, MAINTENANCE_COORDINATOR, MAINTENANCE_CREW, OFFICE_CHIEF, SENIOR_SPECIALIST, STAFF | Get arcgis runtime config |

## Me

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/me/layouts` | Signed in, not Guest-only | List my layouts |
| `POST` | `/me/layouts` | Signed in, not Guest-only | Create my layout |
| `DELETE` | `/me/layouts/{layout_id}` | Signed in, not Guest-only | Delete my layout |
| `PUT` | `/me/layouts/{layout_id}` | Signed in, not Guest-only | Update my layout |

## Mission center

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/mission-center/event-groups` | Roles: ADMIN, BRANCH_CHIEF, MAINTENANCE_COORDINATOR, OFFICE_CHIEF, SENIOR_SPECIALIST, STAFF | Mission center event groups |
| `GET` | `/mission-center/incidents` | Roles: ADMIN, BRANCH_CHIEF, GUEST, MAINTENANCE_COORDINATOR, MAINTENANCE_CREW, OFFICE_CHIEF, SENIOR_SPECIALIST, STAFF | Mission center incident feed |
| `GET` | `/mission-center/incidents/{incident_id}/gis` | Roles: ADMIN, BRANCH_CHIEF, MAINTENANCE_COORDINATOR, OFFICE_CHIEF, SENIOR_SPECIALIST, STAFF | Return GIS evidence needed for the Mission Center Incident drill-down. |
| `GET` | `/mission-center/projects` | Roles: ADMIN, BRANCH_CHIEF, MAINTENANCE_COORDINATOR, OFFICE_CHIEF, SENIOR_SPECIALIST, STAFF | Return lightweight statewide Project points using cursor pagination. |

## Notifications

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/notifications` | Roles: ADMIN, BRANCH_CHIEF, GUEST, MAINTENANCE_COORDINATOR, MAINTENANCE_CREW, OFFICE_CHIEF, SENIOR_SPECIALIST, STAFF | List notifications |
| `POST` | `/notifications/devices` | Roles: ADMIN, BRANCH_CHIEF, GUEST, MAINTENANCE_COORDINATOR, MAINTENANCE_CREW, OFFICE_CHIEF, SENIOR_SPECIALIST, STAFF | Register device |
| `POST` | `/notifications/devices/unregister` | Roles: ADMIN, BRANCH_CHIEF, GUEST, MAINTENANCE_COORDINATOR, MAINTENANCE_CREW, OFFICE_CHIEF, SENIOR_SPECIALIST, STAFF | Unregister device |
| `POST` | `/notifications/read` | Roles: ADMIN, BRANCH_CHIEF, GUEST, MAINTENANCE_COORDINATOR, MAINTENANCE_CREW, OFFICE_CHIEF, SENIOR_SPECIALIST, STAFF | Mark read |
| `GET` | `/notifications/unread` | Roles: ADMIN, BRANCH_CHIEF, GUEST, MAINTENANCE_COORDINATOR, MAINTENANCE_CREW, OFFICE_CHIEF, SENIOR_SPECIALIST, STAFF | Unread |

## Ops

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/ops/offline-scene/health` | Roles: ADMIN | ADMIN ops health for the offline-scene pipeline: queue depth, live workers, unresolved orphaned objects, and private-bucket posture. Sanitized — no S3 storage credentials, endpoints, or unbounded internals are returned. |

## Organization

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `PATCH` | `/org/branches/{branch_id}` | Roles: ADMIN, BRANCH_CHIEF, OFFICE_CHIEF | Edit branch |
| `POST` | `/org/branches/{branch_id}/chief` | Roles: ADMIN, BRANCH_CHIEF, OFFICE_CHIEF | Set branch chief |
| `POST` | `/org/branches/{branch_id}/retire` | Roles: ADMIN, BRANCH_CHIEF, OFFICE_CHIEF | Retire branch |
| `POST` | `/org/branches/{branch_id}/staff` | Roles: ADMIN, BRANCH_CHIEF, OFFICE_CHIEF | Add staff |
| `GET` | `/org/districts/{district}/office` | Signed in, not Guest-only | Which office serves this district, and WHERE THAT ANSWER CAME FROM. |
| `GET` | `/org/maintenance` | Signed in (record rules apply) | Every district's coordinators and crew, for everyone; each district says what this person may change. |
| `POST` | `/org/maintenance/{district}/coordinators/{user_id}/primary` | Roles: ADMIN, MAINTENANCE_COORDINATOR, OFFICE_CHIEF | Make primary |
| `POST` | `/org/maintenance/{district}/{kind}` | Roles: ADMIN, MAINTENANCE_COORDINATOR, OFFICE_CHIEF | Add maintenance |
| `DELETE` | `/org/maintenance/{district}/{kind}/{user_id}` | Roles: ADMIN, MAINTENANCE_COORDINATOR, OFFICE_CHIEF | Remove maintenance |
| `GET` | `/org/offices` | Signed in (record rules apply) | Offices and their branches, for LABELS. No personnel, no counts. |
| `POST` | `/org/offices/{office_id}/branches` | Roles: ADMIN, BRANCH_CHIEF, OFFICE_CHIEF | Add branch |
| `POST` | `/org/offices/{office_id}/chiefs` | Roles: ADMIN | Add office chief |
| `POST` | `/org/offices/{office_id}/specialists` | Roles: ADMIN, BRANCH_CHIEF, OFFICE_CHIEF | Add specialist |
| `GET` | `/org/people` | Roles: ADMIN, BRANCH_CHIEF, MAINTENANCE_COORDINATOR, OFFICE_CHIEF | Registered users to place, with where each one sits today. |
| `GET` | `/org/tree` | Signed in (record rules apply) | Every office's tree, for everyone; each office and branch says whether this person may change it. |
| `DELETE` | `/org/tree/people/{user_id}` | Roles: ADMIN, BRANCH_CHIEF, OFFICE_CHIEF | Remove person |
| `GET` | `/org/tree/people/{user_id}/details` | Roles: ADMIN, BRANCH_CHIEF, OFFICE_CHIEF | Get details |
| `PUT` | `/org/tree/people/{user_id}/details` | Roles: ADMIN, BRANCH_CHIEF, OFFICE_CHIEF | Classification, position, home and availability. Never a place, never a role. |

## Projects

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/projects` | Roles: ADMIN, BRANCH_CHIEF, MAINTENANCE_COORDINATOR, OFFICE_CHIEF, SENIOR_SPECIALIST, STAFF | List projects |
| `GET` | `/projects/{project_id}` | Roles: ADMIN, BRANCH_CHIEF, MAINTENANCE_COORDINATOR, OFFICE_CHIEF, SENIOR_SPECIALIST, STAFF | Get project |
| `PATCH` | `/projects/{project_id}` | Roles: ADMIN, MAINTENANCE_COORDINATOR | Update project |
| `POST` | `/projects/{project_id}/close` | Roles: ADMIN, MAINTENANCE_COORDINATOR | Close project |
| `POST` | `/projects/{project_id}/reopen` | Roles: ADMIN, MAINTENANCE_COORDINATOR | Reopen project |

## Road inventory

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/road-inventory/import-jobs` | Roles: ADMIN | Return the latest 25 import jobs, newest first. |
| `POST` | `/road-inventory/import-jobs` | Roles: ADMIN | Store Excel in S3 storage, create a queued import job, return 202. |
| `GET` | `/road-inventory/import-jobs/{job_uuid}` | Roles: ADMIN | Return a single import job by UUID. |
| `GET` | `/road-inventory/lookup` | Signed in, not Guest-only | Return road segments matching county + route + postmile range. |
| `GET` | `/road-inventory/manifest` | Signed in, not Guest-only | Return the latest published dataset version metadata. |
| `GET` | `/road-inventory/mobile-package/download` | Signed in, not Guest-only | Download the current published road-inventory package through ERIS. |
| `GET` | `/road-inventory/package` | Signed in, not Guest-only | Return the mobile package for the currently published dataset. |
| `GET` | `/road-inventory/roadway-context` | Signed in, not Guest-only | What the web needs to measure a slide's encroachment on the roadway: the road inventory cross-section at the site and the highway's centerline around it. |
| `POST` | `/road-inventory/upload` | Roles: ADMIN | Upload a Caltrans TSN highway inventory Excel file. |
| `GET` | `/road-inventory/versions` | Roles: ADMIN | List versions |
| `POST` | `/road-inventory/versions/{dataset_version_id}/package` | Roles: ADMIN | Generate (or regenerate) a gzip-compressed JSON mobile package. |
| `POST` | `/road-inventory/versions/{version_id}/publish` | Roles: ADMIN | Publish a pending or superseded dataset version. |
| `POST` | `/road-inventory/versions/{version_id}/rollback` | Roles: ADMIN | Re-publish a superseded version, superseding the current published one. |

## Shares

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/shares/reviews` | Roles: ADMIN, BRANCH_CHIEF, OFFICE_CHIEF | Share reviews |
| `POST` | `/shares/{share_id}/reviews/{review_id}` | Roles: ADMIN, BRANCH_CHIEF, OFFICE_CHIEF | Decide share |

## Sign-in and sessions

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/auth/config` | Public | Which sign-in methods this deployment offers. Public, and secret-free. |
| `GET` | `/auth/entra/callback` | Public | Callback |
| `POST` | `/auth/entra/native` | Public | Exchange the mobile app's Entra access token for an ERIS bearer session. |
| `GET` | `/auth/entra/start` | Public | Start |
| `POST` | `/auth/login` | Public | Password sign-in, for development and the Campos Labs rehearsal only. |
| `POST` | `/auth/logout` | Signed in (record rules apply) | End this session only; the account's other devices stay signed in. |
| `GET` | `/auth/me` | Signed in (record rules apply) | Own identity, plus where this person sits in the organization. |
| `POST` | `/auth/sessions/revoke-all` | Signed in (record rules apply) | Sign out everywhere: every browser and device this account is signed in on. |

## Submissions (GISA)

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/gisa/lookups` | Signed in (record rules apply) | Get gisa lookups |
| `GET` | `/submissions` | Signed in (record rules apply) | List submissions |
| `POST` | `/submissions` | Roles: ADMIN, SENIOR_SPECIALIST, STAFF | Create submission |
| `GET` | `/submissions/page` | Signed in, not Guest-only | Cursor-paginated submission worklist: the forms this person may open. |
| `DELETE` | `/submissions/{submission_id}` | Roles: ADMIN, SENIOR_SPECIALIST, STAFF | Delete submission |
| `GET` | `/submissions/{submission_id}` | Signed in (record rules apply) | Get submission |
| `POST` | `/submissions/{submission_id}/approve` | Roles: ADMIN, BRANCH_CHIEF, MAINTENANCE_COORDINATOR, OFFICE_CHIEF, SENIOR_SPECIALIST, STAFF | Approve |
| `POST` | `/submissions/{submission_id}/attachments` | Roles: ADMIN, SENIOR_SPECIALIST, STAFF | Upload submission attachment |
| `GET` | `/submissions/{submission_id}/drone-surveys` | Signed in, not Guest-only | List surveys |
| `POST` | `/submissions/{submission_id}/drone-surveys` | Roles: ADMIN, SENIOR_SPECIALIST, STAFF | Create survey |
| `DELETE` | `/submissions/{submission_id}/drone-surveys/{survey_id}` | Roles: ADMIN, SENIOR_SPECIALIST, STAFF | Delete survey |
| `PATCH` | `/submissions/{submission_id}/drone-surveys/{survey_id}` | Roles: ADMIN, SENIOR_SPECIALIST, STAFF | Update survey |
| `GET` | `/submissions/{submission_id}/drone-surveys/{survey_id}/overlay` | Signed in, not Guest-only | Get overlay |
| `GET` | `/submissions/{submission_id}/drone-surveys/{survey_id}/patch` | Signed in, not Guest-only | Get patch |
| `GET` | `/submissions/{submission_id}/geometry` | Signed in (record rules apply) | Get submission geometry |
| `PUT` | `/submissions/{submission_id}/geometry` | Roles: ADMIN, SENIOR_SPECIALIST, STAFF | Put submission geometry |
| `PATCH` | `/submissions/{submission_id}/gisa` | Roles: ADMIN, SENIOR_SPECIALIST, STAFF | Patch gisa |
| `PUT` | `/submissions/{submission_id}/gisa/actions` | Roles: ADMIN, SENIOR_SPECIALIST, STAFF | Replace actions |
| `POST` | `/submissions/{submission_id}/gisa/elevation-profile` | Signed in, not Guest-only | Enrich gisa elevation profile |
| `PUT` | `/submissions/{submission_id}/gisa/incident-types` | Roles: ADMIN, SENIOR_SPECIALIST, STAFF | Replace incident types |
| `GET` | `/submissions/{submission_id}/gisa/offline-scene-package` | Signed in, not Guest-only | Offline 3D scene-package descriptor for the mobile native viewer. |
| `GET` | `/submissions/{submission_id}/gisa/offline-scene-package/download` | Signed in, not Guest-only | Mint a SHORT-LIVED presigned URL for the newest READY package, only after a role/access check. Mobile never receives S3 storage credentials; the bucket stays private. On expiry the app re-requests this to resume/retry the download. |
| `POST` | `/submissions/{submission_id}/gisa/offline-scene-package/generate` | Signed in, not Guest-only | Request AUTOMATIC generation of a bounded offline 3D package. |
| `GET` | `/submissions/{submission_id}/gisa/offline-scene-package/job` | Signed in, not Guest-only | Latest generation job for the submission (for mobile progress polling). |
| `POST` | `/submissions/{submission_id}/gisa/offline-scene-package/job/cancel` | Signed in, not Guest-only | Cancel offline scene package job |
| `POST` | `/submissions/{submission_id}/gisa/offline-scene-package/job/retry` | Signed in, not Guest-only | Retry offline scene package job |
| `GET` | `/submissions/{submission_id}/gisa/pdf` | Signed in (record rules apply) | Get submission gisa pdf |
| `POST` | `/submissions/{submission_id}/gisa/pdf` | Signed in, not Guest-only | Generate submission gisa pdf |
| `POST` | `/submissions/{submission_id}/gisa/terrain-grid` | Signed in, not Guest-only | Build (and cache) the road-aligned USGS 3DEP terrain elevation grid for the '3D Terrain' view. Mirrors the elevation-profile refresh: the grid is cached on submission_gisa and only re-queried from USGS when force=true. |
| `POST` | `/submissions/{submission_id}/notify-coordinator` | Roles: ADMIN, SENIOR_SPECIALIST, STAFF | Notify coordinator |
| `GET` | `/submissions/{submission_id}/permissions` | Signed in, not Guest-only | Get submission permissions |
| `PUT` | `/submissions/{submission_id}/permissions` | Roles: ADMIN, SENIOR_SPECIALIST, STAFF | Replace submission permissions |
| `GET` | `/submissions/{submission_id}/photo-map` | Signed in (record rules apply) | Submission photo map |
| `GET` | `/submissions/{submission_id}/photo-map/photos/{attachment_id}/corrected-export` | Signed in (record rules apply) | Return a derived JPEG with the current ERIS map metadata embedded in EXIF. |
| `PUT` | `/submissions/{submission_id}/photo-map/photos/{attachment_id}/correction` | Signed in, not Guest-only | Put photo correction |
| `POST` | `/submissions/{submission_id}/photos` | Roles: ADMIN, SENIOR_SPECIALIST, STAFF | Upload submission photo |
| `POST` | `/submissions/{submission_id}/presence` | Signed in, not Guest-only | Presence heartbeat |
| `DELETE` | `/submissions/{submission_id}/presence/{session_id}` | Signed in, not Guest-only | Presence leave |
| `POST` | `/submissions/{submission_id}/reject` | Roles: ADMIN, BRANCH_CHIEF, MAINTENANCE_COORDINATOR, OFFICE_CHIEF, SENIOR_SPECIALIST, STAFF | Reject |
| `POST` | `/submissions/{submission_id}/review` | Roles: ADMIN, BRANCH_CHIEF, MAINTENANCE_COORDINATOR, OFFICE_CHIEF, SENIOR_SPECIALIST, STAFF | Decide a LEGACY, unlinked submission. Admin only. |
| `POST` | `/submissions/{submission_id}/share` | Roles: ADMIN, SENIOR_SPECIALIST, STAFF | Share submission |
| `DELETE` | `/submissions/{submission_id}/share/{user_id}` | Roles: ADMIN, SENIOR_SPECIALIST, STAFF | Unshare submission |
| `GET` | `/submissions/{submission_id}/shared-with` | Signed in, not Guest-only | List shared with |
| `GET` | `/submissions/{submission_id}/shares` | Roles: ADMIN, SENIOR_SPECIALIST, STAFF | Submission shares |
| `GET` | `/submissions/{submission_id}/site-history` | Roles: ADMIN, BRANCH_CHIEF, MAINTENANCE_COORDINATOR, OFFICE_CHIEF, SENIOR_SPECIALIST, STAFF | Site history |
| `POST` | `/submissions/{submission_id}/submit` | Roles: ADMIN, SENIOR_SPECIALIST, STAFF | Submit |
| `PATCH` | `/submissions/{submission_id}/title` | Roles: ADMIN, SENIOR_SPECIALIST, STAFF | Patch submission title |

## Terrain

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `POST` | `/terrain-cross-sections` | Roles: ADMIN, BRANCH_CHIEF, MAINTENANCE_COORDINATOR, OFFICE_CHIEF, SENIOR_SPECIALIST, STAFF | Create cross section |
| `GET` | `/terrain-cross-sections/projects` | Roles: ADMIN, BRANCH_CHIEF, MAINTENANCE_COORDINATOR, OFFICE_CHIEF, SENIOR_SPECIALIST, STAFF | List cross section projects |
| `POST` | `/terrain-cross-sections/projects` | Roles: ADMIN, BRANCH_CHIEF, MAINTENANCE_COORDINATOR, OFFICE_CHIEF, SENIOR_SPECIALIST, STAFF | Create manual cross section project |
| `GET` | `/terrain-cross-sections/projects/{project_id}/cross-sections` | Roles: ADMIN, BRANCH_CHIEF, MAINTENANCE_COORDINATOR, OFFICE_CHIEF, SENIOR_SPECIALIST, STAFF | List project cross sections |
| `GET` | `/terrain-cross-sections/{cross_section_id}` | Roles: ADMIN, BRANCH_CHIEF, MAINTENANCE_COORDINATOR, OFFICE_CHIEF, SENIOR_SPECIALIST, STAFF | Get cross section |
| `PUT` | `/terrain-cross-sections/{cross_section_id}` | Roles: ADMIN, BRANCH_CHIEF, MAINTENANCE_COORDINATOR, OFFICE_CHIEF, SENIOR_SPECIALIST, STAFF | Update cross section |
