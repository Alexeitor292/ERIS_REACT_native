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

Nothing is renamed or dropped. `downgrade()` drops the four new tables and the
new role rows.

Run the chain:

```bash
cd backend
alembic upgrade head        # applies 0001 .. 0008
alembic current             # -> 0008_assessment_domain (head)
# review without a DB:
alembic upgrade 0007_gisa_elevation_profile:0008_assessment_domain --sql
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

1. **One assessment per incident** (`uk_assessment_incident`). Re-triaging
   `ASSESSMENT_REQUIRED` reactivates the existing assessment rather than creating
   a second one.
2. **Closure policy is intentionally minimal.** `FINALIZED` is a terminal
   Assessment state set by an Office Chief/Admin after `APPROVED`. The legacy
   incident `RESOLVED`/`resolve` behavior is preserved and **not** automatically
   coupled to assessment finalization — coupling them is an open business
   decision.
3. **`NO_ASSESSMENT_REQUIRED`** records a disposition + timeline event and keeps
   the report; it does not auto-close or hide the incident.
4. **`NEEDS_REPORTER_INFORMATION`** reuses the existing reporter-revision channel
   (`location_match_status = NEEDS_REVISION` + `PATCH /incidents/{id}`), so the
   reporter sees and can resubmit. Whether needs-info should also be expressible
   after an assessment exists is an open question.
5. **`DUPLICATE_OR_LINKED`** records the link target (incident/location) in the
   timeline + incident metadata; it does not merge records.
6. **Office/branch chief eligibility** is derived from user metadata
   (`office_code`) + role via the existing `incident_routing_assignments`
   helpers, not from `geotech_office_routing` (which maps district→office only).
7. **Legacy `REVIEWER` role** is retained; migrating those users to per-assessment
   assignments is deferred.
8. **Mobile coordinator triage UI:** the mobile client ships the `triageIncident`
   API and the operational Assessments screen; the existing mobile
   coordinator *forward*/*request-revision* actions remain functional. Surfacing
   the full 4-disposition triage picker on the mobile incident detail is the
   recommended next phase (the WebUI already has it).

---

## 9. Recommended next implementation phase

1. Mobile incident-detail triage picker (all four dispositions) replacing the
   legacy forward/request-revision buttons.
2. Admin UI for `geotech_office_routing` and office/branch chief eligibility.
3. Staged rename of `gisa` storage behind a compatibility view; migrate
   `REVIEWER`-role users to assessment assignments and retire the global role.
4. Decide and implement the assessment-finalization ↔ incident-closure coupling.
5. Attachment access hardening parity check for assessment-linked attachments.
