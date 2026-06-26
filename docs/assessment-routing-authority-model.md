# Assessment Routing & Authority Model

This document describes the **Assessment** domain layer added on top of the
existing incident + GISA-backed submission workflow, the District → GeoTech
Office routing mechanism, and the "broad visibility, narrow authority" access
model.

It is the source of truth for the Assessment concept. Where it conflicts with
older `*_VERIFIED.md` notes that use "GISA" as the product concept, this
document and the linked code win.

---

## 1. Terminology transition: GISA (legacy) → Assessment (product)

ERIS is **not** an "incident-to-GISA" system.

- **GISA** is the legacy name of the deep technical submission form. It survives
  only as the *implementation* underneath the Assessment concept. The database
  tables (`submission_gisa`, `submission_gisa_*`), Python helpers, mobile/web
  types, and PDF template that contain `gisa` are **intentionally not renamed**
  — renaming them would be a dangerous, wide-blast-radius change.
- **Assessment** is the official product concept: the comprehensive technical
  work product generated after an incident report is approved for technical
  work. All **new** user-facing UI text, API docs, workflow labels, and domain
  objects use "Assessment".

| Layer | Legacy (kept) | New (user-facing) |
| --- | --- | --- |
| Technical form storage | `submissions`, `submission_gisa*` | "Assessment technical form" |
| Workflow wrapper | — | `assessments`, `assessment_assignments`, `assessment_events` |
| Reviewer role | `REVIEWER` global role (kept) | assessment-level `REVIEWER`/`APPROVER` assignment |

**Technical debt / staged migration:** a future phase may rename the `gisa`
tables/types behind a compatibility view and migrate `REVIEWER`-role users to
assessment assignments. Until then the adapter in `app/roles.py` and the
Assessment tables provide the new concept without touching legacy structures.

---

## 2. Official incident-to-assessment workflow

```
Maintenance Field Worker            Maintenance Coordinator                 GeoTech Office
  creates Incident Report  ───►  triages (explicit disposition)  ──(ASSESSMENT_REQUIRED)──►  Office Chief
                                   • ASSESSMENT_REQUIRED                                       delegates to
                                   • NO_ASSESSMENT_REQUIRED                                     Branch Chief
                                   • NEEDS_REPORTER_INFORMATION  ──► reporter updates/resubmits      │
                                   • DUPLICATE_OR_LINKED                                              ▼
                                                                                            Branch Chief assigns
                                                                                                Engineer
                                                                                                    │
                                                                                                    ▼
                                                                            Engineer completes Assessment (DRAFT)
                                                                                                    │  submit
                                                                                                    ▼
                                                                            Assigned Reviewer/Approver reviews
                                                                              • APPROVE → APPROVED → FINALIZED
                                                                              • REQUEST_REVISION → engineer resubmits
```

### Assessment states

```
PENDING_OFFICE_DELEGATION      created by coordinator triage (ASSESSMENT_REQUIRED)
PENDING_ENGINEER_ASSIGNMENT    office chief delegated to a branch chief
DRAFT                          branch chief assigned an engineer; technical form editable
SUBMITTED                      engineer submitted for review
REVISION_REQUESTED             reviewer/approver requested changes
APPROVED                       reviewer/approver approved
FINALIZED                      office chief finalized (closure)
```

The legacy incident `current_stage` machine
(`COORDINATOR_REVIEW → OFFICE_CHIEF_REVIEW → BRANCH_CHIEF_REVIEW →
ENGINEER_ASSIGNED → RESOLVED`) is kept in sync by the Assessment endpoints so
existing incident views keep working.

---

## 3. Roles and permission matrix

### Organization roles

Canonical roles (new) alias to legacy roles (kept) via `app/roles.py`. Either
name satisfies an authority check.

| Canonical | Legacy alias | Notes |
| --- | --- | --- |
| `MAINTENANCE_FIELD_WORKER` | `MAINTENANCE` | reporter; narrow visibility |
| `MAINTENANCE_COORDINATOR` | `MAINT_COORDINATOR` | triage + routing |
| `GEOTECH_OFFICE_CHIEF` | `OFFICE_CHIEF` | delegates to branch chief |
| `GEOTECH_BRANCH_CHIEF` | `BRANCH_CHIEF` | assigns engineer |
| `GEOTECH_ENGINEER` | `FIELD_WORKER` | completes the technical form |
| `ADMIN` | `ADMIN` | full authority |

> Note: legacy `FIELD_WORKER` historically denotes the **engineer**, and legacy
> `MAINTENANCE` denotes the **field-worker reporter**. The alias table preserves
> that meaning.

`REVIEWER` is retained for backward compatibility but is **not** required to
review. Review authority is an assessment-level assignment.

### Authority matrix

| Action | Authorized | Endpoint |
| --- | --- | --- |
| Create incident report | Field Worker, Coordinator, Admin | `POST /incidents` |
| Triage / decide assessment required | Coordinator, Admin | `POST /incidents/{id}/triage` |
| Route to GeoTech Office | Coordinator, Admin (auto by district; override audited) | triage |
| Delegate to Branch Chief | Office Chief, Admin | `POST /assessments/{id}/delegate-branch` |
| Assign/reassign Engineer | Branch Chief, Admin | `POST /assessments/{id}/assign-engineer` |
| Edit Assessment (technical form) | Assigned Engineer, Admin | `PATCH /submissions/{id}/gisa` (editor grant) |
| Submit assessment | Assigned Engineer, Admin | `POST /assessments/{id}/submit` |
| Assign reviewer/approver | Office Chief, Branch Chief, Admin | `POST /assessments/{id}/assignments` |
| Review/approve/request revisions | **Assigned** Reviewer/Approver, Admin | `POST /assessments/{id}/review` |
| Finalize | Office Chief, Admin | `POST /assessments/{id}/finalize` |
| View all operational data | All non-maintenance operational roles | `GET /assessments`, `GET /incidents`, `GET /submissions/{id}` |
| View own reports only | Maintenance Field Worker | `GET /incidents` (auto-scoped) |

### Broad visibility, narrow authority

- **Broad read:** any non-maintenance operational user (`is_operational_user`)
  can read all incidents, assessments, and technical forms via the WebUI APIs.
  Enforced server-side (`can_view_submission`, `GET /assessments` guard).
- **Narrow visibility exception:** maintenance field workers are scoped to their
  own reports server-side in `list_incidents`, `get_incident`, and
  `mission_center_incident_feed`, and are blocked from `GET /assessments`. This
  is enforced in the backend, not just hidden in the UI.
- **Narrow authority:** every write action is gated by organization role and,
  for review, by an active assessment-level `REVIEWER`/`APPROVER` assignment
  (`_has_active_review_authority`).

---

## 4. Assessment-level review assignments

`assessment_assignments` rows carry `assignment_role ∈ {ENGINEER, REVIEWER,
APPROVER, CONSULTED}`.

- The engineer assignment is created automatically when a branch chief assigns
  an engineer.
- An Office/Branch Chief (or Admin) may assign **any eligible non-maintenance
  operational user** as `REVIEWER`/`APPROVER`/`CONSULTED` for a specific
  assessment — no permanent reviewer role needed.
- `POST /assessments/{id}/review` verifies the caller holds an active
  `REVIEWER`/`APPROVER` assignment for *that* assessment (or is Admin). An
  unassigned user — even the assigned engineer — receives `403`.

---

## 5. District → GeoTech Office routing

Routing is data-backed by the `geotech_office_routing` table (district →
`office_code`, with an optional `office_name`), seeded by migration 0008 from
the legacy `OFFICE_BY_DISTRICT` map. Resolution lives in
`app/services/office_routing.py`:

1. look up the active routing row for the normalized district;
2. fall back to the legacy constant `LEGACY_OFFICE_BY_DISTRICT` if no row exists.

Coordinators can preview the calculated office via
`GET /assessments/routing/preview?district=NN` and may override the office at
triage time with a required `override_reason` (audited on the assessment and in
the timeline). The table is editable, giving a clear path to an administration
UI without hardcoding the mapping inside route handlers.

---

## 6. Data model changes & migration notes

Migration `0008_assessment_domain` (additive, reversible):

- `geotech_office_routing` — district routing table (seeded).
- `assessments` — one per incident (`uk_assessment_incident`); links incident +
  technical `submission_id`; carries `office_code`, `branch_chief_user_id`,
  `assigned_engineer_user_id`, `state` (CHECK-constrained), decision timestamps,
  `triage_disposition`, `office_override_reason`.
- `assessment_assignments` — assessment-level role assignments (CHECK on role).
- `assessment_events` — append-only timeline (actor, prior/next state,
  disposition, notes, target incident/location). No `updated_at`; immutable by
  convention.
- Inserts the five new canonical roles (idempotent `ON DUPLICATE KEY`).

Migration `0009_incident_triage_fields` (additive, reversible) adds dedicated
triage columns to `incidents` so the coordinator's decision is first-class and
never overwrites the location-review JSON:

- `triage_disposition` (CHECK on the four dispositions), `triage_decided_by_user_id`
  (FK users), `triage_decided_at`, `triage_notes`.
- `duplicate_of_incident_id` (self FK) and `duplicate_of_location_id` (FK
  incident_locations) for `DUPLICATE_OR_LINKED`. All FKs `ON DELETE SET NULL`.

Triage handling (see `routes/assessments.py`):

- The disposition is written to these triage columns, **not** to
  `location_match_metadata`. `ASSESSMENT_REQUIRED` / `NO_ASSESSMENT_REQUIRED` /
  `DUPLICATE_OR_LINKED` do not touch `location_match_metadata` at all.
- `NEEDS_REPORTER_INFORMATION` **merges** the revision request into the existing
  `location_match_metadata` (preserving prior location-review fields) so the
  reporter-resubmit flow keeps working.
- `_serialize_incident` now parses `location_match_metadata` to a JSON object.

Non-assessment outcomes (explicit, auditable; no Assessment is created):

- `NO_ASSESSMENT_REQUIRED` and `DUPLICATE_OR_LINKED` close the incident
  (`status=RESOLVED`, `current_stage=RESOLVED`, `resolved_by`/`resolution_comment`
  set, active assignments deactivated), so it leaves the coordinator-review queue
  while the report and history are fully preserved. `DUPLICATE_OR_LINKED` also
  records the link target in `duplicate_of_incident_id` / `duplicate_of_location_id`.
- Triage is only permitted while the incident is in `COORDINATOR_REVIEW` (a single
  decision point); a triaged/closed/routed incident cannot be re-triaged.

Nothing is renamed or dropped. Each `downgrade()` reverses its own migration.

Run the chain:

```bash
cd backend
alembic upgrade head        # applies 0001 .. 0009
alembic current             # -> 0009_incident_triage_fields (head)
# review without a DB:
alembic upgrade 0008_assessment_domain:0009_incident_triage_fields --sql
```

`database/init/020_seed.sql` also registers the new roles for fresh dev DBs.

---

## 7. Local development & test instructions

Backend:

```bash
cd backend
# no-DB unit tests (role aliasing, routing fallback, app import, smoke):
.venv/Scripts/python -m pytest -m "not db"
# DB-backed integration tests (requires MariaDB seeded + stamped at head):
.venv/Scripts/python -m pytest -m db        # includes test_assessment_flow.py
```

Web:

```bash
cd web
npm install
npm run build      # tsc typecheck + vite build
```

Mobile:

```bash
cd mobile
npx tsc --noEmit   # typecheck
npm run lint       # expo lint
```

Key test file `backend/tests/test_assessment_flow.py` maps 1:1 to the required
authority/lifecycle matrix (field-worker isolation, triage+routing, office/branch
delegation, engineer assignment, assignment-based review, broad read, timeline,
legacy compatibility).

---

## 8. Assumptions & unresolved policy decisions

1. **One assessment per incident** (`uk_assessment_incident`). Triage is a single
   decision point (only allowed in `COORDINATOR_REVIEW`); a routed/closed incident
   cannot be re-triaged.
2. **Closure policy.** `FINALIZED` is a terminal Assessment state set by an Office
   Chief/Admin after `APPROVED`. Coupling assessment finalization to the legacy
   incident `RESOLVED`/`resolve` flow is still an open business decision.
3. **`NO_ASSESSMENT_REQUIRED`** closes the incident at triage (`status=RESOLVED`,
   `current_stage=RESOLVED`, `resolution_comment` set) with the disposition in the
   dedicated triage columns. The report and history are preserved; no Assessment
   is created; the incident leaves the coordinator-review queue.
4. **`NEEDS_REPORTER_INFORMATION`** keeps the incident in coordinator review and
   reuses the reporter-revision channel (`location_match_status = NEEDS_REVISION` +
   `PATCH /incidents/{id}`), merging the revision request into existing metadata so
   prior location-review fields are preserved. Whether needs-info should also be
   expressible after an assessment exists is an open question.
5. **`DUPLICATE_OR_LINKED`** closes the incident at triage and links it to the
   target via `duplicate_of_incident_id` / `duplicate_of_location_id`. The original
   report is preserved; records are linked, not merged.
6. **Triage never overwrites `location_match_metadata`** — the disposition lives in
   dedicated triage columns (migration 0009). Only the needs-info path writes
   metadata, and it merges rather than overwrites.
7. **Office/branch chief eligibility** is derived from user metadata
   (`office_code`) + role via the existing `incident_routing_assignments`
   helpers, not from `geotech_office_routing` (which maps district→office only).
8. **Legacy `REVIEWER` role** is retained; migrating those users to per-assessment
   assignments is deferred.

---

## 9. Recommended next implementation phase

1. Admin UI for `geotech_office_routing` and office/branch chief eligibility.
2. Staged rename of `gisa` storage behind a compatibility view; migrate
   `REVIEWER`-role users to assessment assignments and retire the global role.
3. Decide and implement the assessment-finalization ↔ incident-closure coupling.
4. Attachment access hardening parity check for assessment-linked attachments.
5. Replace the mobile reviewer/engineer user-id text inputs with searchable
   pickers (the coordinator triage picker and routing display already ship).
