# Assessment Routing & Authority Model

This document describes the **Assessment** domain layer added on top of the
existing incident + GISA-backed submission workflow, the District → GeoTech
Office routing mechanism, the **two-path routing model** (routing v2), and the
"broad visibility, narrow authority" access model.

It is the source of truth for the Assessment concept. Where it conflicts with
older `*_VERIFIED.md` notes that use "GISA" as the product concept, this
document and the linked code win.

> **Routing v2 (migration `20260910_routing_v2`).** When triage sets
> `ASSESSMENT_REQUIRED` the assessment lands with the GeoTech office chief, who
> now has exactly **two mutually exclusive choices**: hand off to a branch chief,
> or assign a **GeoTech senior engineer** directly. **Review authority follows
> the assessment's routing path** — it is neither a job title nor an assignment.
> **Approval ends the assessment**: the sign-off step and the `FINALIZED` state
> are unreachable. On approval the district coordinator is notified **in-app and
> by email**.

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
| Reviewer role | `REVIEWER` global role (kept, deprecated) | no reviewer role and no reviewer assignment — review follows `assessments.routing_path` |

Another name kept for the same reason: `assessments.assigned_engineer_user_id`
holds **the assignee on both routes**. On a `routing_path = 'SENIOR_ENGINEER'`
row it names a senior engineer, not a Staff member. Renaming the column would
force a second branch into every reader (queue SQL, the submit identity check,
`idx_assessment_engineer`, `workflow_tree`, `incident_classification`, web and
mobile) for no gain, because `routing_path` already says which kind of person
the id names. The API exposes the route-neutral aliases `assigned_user_id` and
`assigned_user_kind` (`"STAFF" | "SENIOR_ENGINEER"`).

**Technical debt / staged migration:** a future phase may rename the `gisa`
tables/types behind a compatibility view. The legacy `REVIEWER` account role is
now deprecated — it keeps broad operational read and confers no authority — and
no new grants should be made.

---

## 2. Official incident-to-assessment workflow

Triage creates the assessment with `routing_path = NULL` — no route chosen. The
office chief then picks **one of two paths**, and the choice is not reversible.

```
Maintenance Field Worker         Maintenance Coordinator                GeoTech Office
  creates Incident Report ──►  triages (explicit disposition) ──(ASSESSMENT_REQUIRED)──► Office Chief
                                • ASSESSMENT_REQUIRED                          routes: one of two
                                • NO_ASSESSMENT_REQUIRED                                │
                                • NEEDS_REPORTER_INFORMATION ──► reporter resubmits     │
                                • DUPLICATE_OR_LINKED                                   │
                         ┌──────────────────────────────────────────────────────────────┴───────────┐
                         │ BRANCH route                                        SENIOR_ENGINEER route│
                         ▼                                                                          ▼
              Branch Chief assigns a Staff member                      Office Chief assigns a Senior Engineer
                         │                                                                          │
                         ▼                                                                          ▼
              Staff member fills the assessment (DRAFT)               Senior Engineer fills it (DRAFT)
                         │  submit                                                                  │  submit
                         ▼                                                                          ▼
              The NAMED Branch Chief reviews                          An OFFICE CHIEF of that office reviews
               • APPROVE → APPROVED (complete)                         • APPROVE → APPROVED (complete)
               • REQUEST_REVISION → assignee resubmits                 • REQUEST_REVISION → assignee resubmits
```

On the branch route **the office chief is out of the picture from the hand-off
onward** (except for re-delegation, §5). On the senior engineer route the work comes
back to the office chief, who approves it.

### Assessment states

```
PENDING_OFFICE_DELEGATION      created by coordinator triage; routing_path IS NULL — no route chosen
PENDING_ENGINEER_ASSIGNMENT    BRANCH route only: awaiting the branch chief's Staff assignment
DRAFT                          the assignee (Staff member or senior engineer) is filling the technical form
SUBMITTED                      awaiting the route's reviewer
REVISION_REQUESTED             returned to the assignee with the reviewer's note
APPROVED                       TERMINAL — complete; approved_at set; nothing further is required
FINALIZED                      LEGACY history only: unreachable after routing v2, still readable/filterable
```

No state code was added, removed or renamed, and `chk_assessment_state` is
untouched — every existing row stays valid and `?state=FINALIZED` still filters
history.

The legacy incident `current_stage` machine
(`COORDINATOR_REVIEW → OFFICE_CHIEF_REVIEW → BRANCH_CHIEF_REVIEW →
ENGINEER_ASSIGNED → RESOLVED`) is kept in sync by the Assessment endpoints so
existing incident views keep working. The senior engineer route reuses the
`ENGINEER_ASSIGNED` stage and the `ENGINEER` assignment stage — the senior
engineer holds the same incident assignment row a Staff member would.

### The route discriminator

`assessments.routing_path VARCHAR(24) NULL`, with
`CHECK (routing_path IS NULL OR routing_path IN ('BRANCH','SENIOR_ENGINEER'))`.

- `NULL` means **not yet chosen** — the honest state of a fresh assessment.
- It is stamped in the same statement as the first assignment.
- It is **not reversible**: `delegate-branch` returns `409` when the route is
  already `SENIOR_ENGINEER`, and `assign-senior-engineer` returns `409` when it is
  already `BRANCH`.
- Swapping *people* stays legal: re-delegate a branch chief (§5), reassign the
  senior engineer from `DRAFT`/`REVISION_REQUESTED`, reassign the Staff member.

---

## 3. Roles and permission matrix

### Organization roles

Canonical roles (new) alias to legacy roles (kept) via `app/roles.py`. Either
name satisfies an authority check.

| Canonical | Legacy alias | Notes |
| --- | --- | --- |
| `MAINTENANCE_FIELD_WORKER` | `MAINTENANCE` | reporter; narrow visibility |
| `MAINTENANCE_COORDINATOR` | `MAINT_COORDINATOR` | triage + routing; notified on approval (in-app + email) |
| `GEOTECH_OFFICE_CHIEF` | `OFFICE_CHIEF` | routes: hands off **or** assigns a senior engineer; reviews senior-engineer-route work of their office |
| `GEOTECH_BRANCH_CHIEF` | `BRANCH_CHIEF` | assigns the Staff member and **reviews** the assessments handed to them |
| `GEOTECH_ENGINEER` (label "Staff") | `FIELD_WORKER` | completes the technical form |
| `GEOTECH_SENIOR_ENGINEER` | **none — the role is new** | completes the technical form on the senior engineer route; office-scoped |
| `ADMIN` | `ADMIN` | full authority, including the review bypass |

> Note: legacy `FIELD_WORKER` historically denotes the **Staff member**, and legacy
> `MAINTENANCE` denotes the **field-worker reporter**. The alias table preserves
> that meaning.

`GEOTECH_SENIOR_ENGINEER` deliberately has **no legacy alias**: inventing one
would make `expand_roles()` accept a name no database contains. It is in
`OPERATIONAL_ROLES`, so a senior engineer has the same broad read every other
operational role has.

`REVIEWER` is **deprecated**. It is retained for backward compatibility, keeps
broad operational read (it stays in `OPERATIONAL_ROLES`), and **grants no review
authority**: `POST /submissions/{id}/review|approve|reject` no longer accept it.
No new grants should be made.

### The new role: GeoTech senior engineer

| Property | Value |
| --- | --- |
| Code / label | `GEOTECH_SENIOR_ENGINEER` / "GeoTech Senior Engineer" |
| Scoping | Office, via `users.metadata_json.$.office_code`, normalized by `normalize_office_code`. Matching-office candidates are preferred; legacy branch chiefs and senior engineers created without an `office_code` remain assignable so pre-scoping accounts cannot strand the workflow. A candidate explicitly scoped to another office is never offered. Office chiefs still require an office because their authority covers the office rather than one named assignment. |
| Operational read | Yes — in `OPERATIONAL_ROLES`, so `is_operational_user()` is true and `is_maintenance_only()` false. |

**May**: be assigned by an office chief of their own office; own and edit the
linked GISA technical form and supplementals; submit and resubmit; read all
operational records; file an incident report; resolve the incident they were
assigned. **May not**: review or approve anything, including their own work; be
assigned by a branch chief; occupy a Staff slot on a branch-route assessment
(the database refuses — §7); route or assign anyone.

Because a senior engineer fills the form exactly as assessment authors under a branch chief do, the GISA write guards
that were `require_roles(["FIELD_WORKER", "ADMIN"])` now use a single export:

```python
GISA_AUTHOR_ROLES = expand_roles(GEOTECH_ENGINEER, GEOTECH_SENIOR_ENGINEER) + [ADMIN]
# ["ADMIN", "FIELD_WORKER", "GEOTECH_ENGINEER", "GEOTECH_SENIOR_ENGINEER"]
```

That covers twelve guards in `app/main.py`, two in `app/photos.py`, and
`POST /incidents/{id}/resolve`. It also unblocks accounts holding only the
canonical `GEOTECH_ENGINEER` name, which could not edit before.

Four literal role lists do **not** consult `OPERATIONAL_ROLES` and were widened
by hand with `GEOTECH_SENIOR_ENGINEER`: `GET /arcgis/runtime-config`
(`routes/arcgis.py`) — without it a senior-engineer-only account is 403'd from the map
*and* the 3D terrain — and `GET /incidents`, `GET /incidents/{id}`,
`GET /mission-center/incidents` (`routes/incidents.py`).

### Authority matrix

| Action | Authorized | Endpoint |
| --- | --- | --- |
| Create incident report | Field Worker, Coordinator, Admin | `POST /incidents` |
| Triage / decide assessment required | Coordinator, Admin | `POST /incidents/{id}/triage` |
| Route to GeoTech Office | Coordinator, Admin (auto by district; override audited) | triage |
| **Route the assessment — choice 1:** hand off to a Branch Chief | Office Chief, Admin | `POST /assessments/{id}/delegate-branch` |
| **Route the assessment — choice 2:** assign a Senior Engineer | Office Chief, Admin | `POST /assessments/{id}/assign-senior-engineer` |
| Assign/reassign a Staff member (BRANCH route only) | **the named** `branch_chief_user_id`, Admin | `POST /assessments/{id}/assign-engineer` |
| Reassign the Senior Engineer (SENIOR_ENGINEER route only) | Office Chief, Admin | `POST /assessments/{id}/assign-senior-engineer` |
| Re-delegate to a different Branch Chief (BRANCH route, non-terminal) | Office Chief, Admin | `POST /assessments/{id}/delegate-branch` |
| Edit Assessment (technical form) | the assignee (Staff member **or** senior engineer), Admin | `PATCH /submissions/{id}/gisa` (editor grant) |
| Submit assessment | the assignee, Admin | `POST /assessments/{id}/submit` |
| Attach someone **for information** (`CONSULTED`) | Office Chief, Branch Chief, Admin | `POST /assessments/{id}/assignments` |
| **Review / approve / request revisions** | **the route's reviewer** (§4), Admin | `POST /assessments/{id}/review` |
| Assign a reviewer/approver | **nobody — retired** (`400`) | `POST /assessments/{id}/assignments` |
| Finalize / sign off | **nobody — retired** (`410`) | `POST /assessments/{id}/finalize` |
| Resolve the incident | the incident's assignee, Admin | `POST /incidents/{id}/resolve` |
| Decide a **legacy, unlinked** submission | Admin only (`409` when the form is assessment-linked) | `POST /submissions/{id}/review\|approve\|reject` |
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
  for review, by the assessment's **routing path** (`_review_authority`).
- **Read shortcuts no longer key on `REVIEWER`.** Five call sites used
  `is_reviewer()` to grant read the role model did not otherwise give (the
  submission list scope, listing every submission, two attachment fetches, and
  the photo index). They now call `is_operational_user()`, which already
  includes `REVIEWER` — so an office chief reviewing on the senior engineer route has
  the same reach a legacy `REVIEWER` had. `permissions.is_reviewer()` is
  deprecated; new code must not call it.

---

## 4. Review authority follows the routing path

Review is **not a job and not an assignment**. `_review_authority(db, assessment,
user) -> (allowed, reason)` in `routes/assessments.py` is the single rule; the
reason is both the `403` body and the serialized `can_review` hint, so the two
cannot drift apart.

| `routing_path` | Who may review | Rule |
| --- | --- | --- |
| `BRANCH` | The **named** branch chief | `branch_chief_user_id == user.id` **and** the caller holds `GEOTECH_BRANCH_CHIEF` (canonical or legacy) |
| `SENIOR_ENGINEER` | **An office chief of that assessment's office** | caller holds `GEOTECH_OFFICE_CHIEF` (canonical or legacy) **and** their `metadata.office_code` is non-blank **and** equals the assessment's non-blank `office_code` |
| `NULL` | Nobody | "This assessment has not been routed yet" |
| any | `ADMIN` | Admin keeps the review bypass |

The senior engineer route binds to the **office**, not to the individual chief who
made the assignment: offices have more than one chief, binding to a person would
strand the assessment whenever that person is away, and no column records the
assigner. Who assigned is preserved in the `SENIOR_ENGINEER_ASSIGNED` event metadata
(`{senior_engineer_user_id, assigned_by_user_id}`).

The office comparison is an **explicit falsy guard on both sides**, not a chained
`!= ''`: `normalize_office_code` returns `None` (never `''`) for blank input, so
`a == b != ''` would be satisfied by `None == None` and would hand review of an
office-less assessment to any unscoped chief.

Two consequences worth stating:

- **Review is office-scoped for the first time.** A chief with a `NULL`
  `office_code` can review nothing — which is why the admin users page gained an
  **Office** field and the seed gained an office-scoped senior engineer.
- **`_scope_office` is strict for the review queues.** An unscoped chief sees an
  empty review queue, never every office's.

### What replaced the old mechanisms

| Old | v2 |
| --- | --- |
| Active `REVIEWER`/`APPROVER` assignment row | **No authority.** Rows are never deactivated or deleted — rewriting an audit trail to change a permission is not acceptable. They serialize with `"is_authority": false` and render *"Former reviewer — historical, no approval authority."* |
| `POST /assessments/{id}/assignments` with `REVIEWER`/`APPROVER` | `400 "Reviewer assignment was retired. Review authority follows the assessment's routing path."` The request schema narrows to `CONSULTED`. |
| `?queue=reviewer` | Kept as a **permanent alias**, resolved per path (§6). `MyWorkPage` requests it for every role inside one `Promise.all`, so removing it would blank My Work. |
| `REVIEWER` role on `POST /submissions/{id}/review\|approve\|reject` | Admin, or §4 authority on the linked assessment. If the submission **is** assessment-linked: `409 "Decide this on the assessment: POST /assessments/{aid}/review"`. Unlinked legacy submissions stay admin-only. |
| `POST /submissions/{id}/submit` on a linked form | `409 "Send this for review on the assessment: POST /assessments/{aid}/submit"`. **B1 is the only writer of a linked form's status.** Unlinked legacy submissions keep the endpoint unchanged. |
| `canReview` derived from account roles in the web client | Reads `submission.can_review` / `assessment.can_review` from the server, never role strings. |

`CONSULTED` survives as the **only writable assignment role**: it never granted
authority. `ASSIGN_REVIEWER_ROLES` was renamed `ASSIGN_CONSULTED_ROLES` with the
same membership, and `DELETE /assessments/{id}/assignments/{aid}` refuses to
detach `ENGINEER` **or** `SENIOR_ENGINEER` rows (the assignee is changed
through the assignment endpoints, never here).

---

## 5. Re-delegation: a first-class transition, not an escape hatch

`fk_assessment_branch_chief ... ON DELETE SET NULL` means deleting a branch chief
NULLs `branch_chief_user_id` while the state stays wherever it was; deactivation
and departure do the same in practice. Because review binds to that one id, a
`SUBMITTED` assessment whose branch chief is gone would be reviewable by admin
only, with no supported repair.

`POST /assessments/{id}/delegate-branch` therefore accepts **any non-terminal
branch-route state** (`PENDING_OFFICE_DELEGATION`, `PENDING_ENGINEER_ASSIGNMENT`,
`DRAFT`, `SUBMITTED`, `REVISION_REQUESTED`) and rewrites the branch chief in
place:

- **First hand-off** (source `PENDING_OFFICE_DELEGATION`) advances the workflow:
  it stamps `routing_path='BRANCH'`, `branch_chief_user_id`,
  `office_delegated_at`, moves the state to `PENDING_ENGINEER_ASSIGNMENT`, sets
  the incident stage to `BRANCH_CHIEF_REVIEW` and writes the `BRANCH_CHIEF`
  stage assignment.
- **Re-delegation** (any later non-terminal state) changes **only**
  `branch_chief_user_id` and re-stamps `office_delegated_at` with the moment of
  the swap. The state, the assignee, the linked submission, the incident stage
  and every other timestamp are untouched. An `OFFICE_DELEGATED` event records
  the swap with both ids in its metadata
  (`{branch_chief_user_id, previous_branch_chief_user_id, routing_path}`), and
  the new chief is notified (`ASSESSMENT_BRANCH_DELEGATION`).
- `409` from `APPROVED`/`FINALIZED`; `409` if the senior engineer route was taken.

Re-delegating from `SUBMITTED` hands the pending decision to the new chief, which
is the point. The office chief regains reach over a branch-route assessment
**only** for this one act — they still cannot assign the Staff member, review, or
approve.

`engineer_user_id` on this request is **rejected, not ignored**: it stays on
`AssessmentDelegateBranchRequest` so an old client gets
`400 "The office chief cannot assign Staff directly. Hand off to a branch chief,
or assign a senior engineer."` instead of a silent behaviour change.

---

## 6. Endpoints, queues and the linked technical form

### Added

- `POST /assessments/{id}/assign-senior-engineer` — office chief, admin. Stamps
  `routing_path='SENIOR_ENGINEER'` **first**, then runs the shared assignment
  machinery with assignment role `SENIOR_ENGINEER`; writes the
  `SENIOR_ENGINEER_ASSIGNED` event. `409` if the branch route was taken;
  `400 "Selected user is not a senior engineer for this office"`.
- `GET /assessments/{id}/senior-engineer-options` — office chief, admin; office access
  enforced. Returns `{assessment_id, office_code, items[]}`.
- `GET /admin/notifications/undelivered` — admin. The EMAIL outbox backlog, so a
  silent SMTP failure is visible (§8).

### Retired

- `POST /assessments/{id}/finalize` → **`410 Gone`**, route still mounted so old
  clients get the sentence, not a 404.
- `POST /assessments/{id}/assignments` with `REVIEWER`/`APPROVER` → `400`.
- `GET /admin/assessment-assignment-options/{id}?kind=REVIEWER` → `400
  "kind=REVIEWER was retired; use CONSULTED"`. `REVIEWER` stays in the query
  pattern on purpose: dropping it would make FastAPI answer a bare `422` before
  the handler could explain. The pattern is now
  `^(ENGINEER|SENIOR_ENGINEER|CONSULTED|REVIEWER)$`.
- `POST /incidents/{id}/office-chief/assign-branch` and
  `POST /incidents/{id}/branch-chief/assign-engineer` → **`410 Gone`**, pointing
  at the assessment endpoints. They moved incident stages and created `ENGINEER`
  assignments without touching `assessments.state` or `routing_path` — exactly
  the bypass that could put a Staff member on a senior-engineer-route assessment.
  `GET /incidents/{id}/office-chief/branch-options` **stays live and unchanged**:
  it is a read, it enforces office access, and it is the branch half of the
  two-choice picker on mobile.
- `POST /incidents/{id}/assign` stays as an admin recovery tool but returns `409`
  when the incident's assessment has `routing_path='SENIOR_ENGINEER'`.

### Queues — `GET /assessments?queue=`

| Value | Rows | Office scoping |
| --- | --- | --- |
| `office_chief` | `state='PENDING_OFFICE_DELEGATION'` | permissive |
| `office_chief_review` **(new)** | `state='SUBMITTED' AND routing_path='SENIOR_ENGINEER'` | **strict** — an unscoped chief gets zero rows |
| `branch_chief` | `state='PENDING_ENGINEER_ASSIGNMENT' AND routing_path='BRANCH' AND branch_chief_user_id=me` | permissive |
| `branch_chief_review` **(new)** | `state='SUBMITTED' AND routing_path='BRANCH' AND branch_chief_user_id=me` | permissive (identity narrows it) |
| `assignee` **(new)**, `engineer` (alias) | `assigned_engineer_user_id=me`, no state filter | none |
| `reviewer` (**permanent alias**) | `SUBMITTED` and (branch route + named chief) or (senior engineer route + my office) | strict on the senior engineer half |

`_scope_office(..., strict=True)` appends `1=0` when the caller has no
`office_code`, instead of returning an unscoped result. The `branch_chief` queue
dropped its old `OR branch_chief_user_id IS NULL` clause — a NULL branch chief
now means the senior engineer route or an unrouted assessment, neither of which
belongs in a branch chief's assignment queue.

### Keeping the linked technical form in step (B1)

`assessments.state` and `submissions.status` used to be two independent machines,
which is why a Staff member could be told to fix a form the server had locked and a
reviewer saw two Approve buttons. `submit` and `review` now drive both **in the
same transaction**, through the existing concurrency-safe helper, so the
`rowcount == 1 or 409` guarantee survives:

| Assessment action | Submission source | Target | `event_type` |
| --- | --- | --- | --- |
| `submit` | `DRAFT` | `SUBMITTED` | `SUBMIT` |
| `submit` (revision cycle) | `REJECTED` | `SUBMITTED` | `RESUBMIT` |
| `review APPROVE` | `SUBMITTED` | `APPROVED` | `APPROVE` |
| `review REQUEST_REVISION` | `SUBMITTED` | `REJECTED` | `REJECT` |

A row already in the target state is skipped (re-entry is idempotent); a row in
any other state — an unsubmitted supplemental draft, an `APPROVED` supplemental
from a previous round — is skipped too and never blocks the assessment. Both
kinds are reported: the response carries `submissions_transitioned` and
`submissions_skipped` (`{submission_id, status}`), so a desync is visible in the
API instead of inferred from the database. `submit_assessment` and
`review_assessment` are wrapped in the same
`try / except HTTPException: rollback; raise / except Exception: rollback; 400`
shape `delegate_branch` uses, so a mid-loop `409` rolls the assessment change
back with it.

### Payload additions

`GET /assessments`, `GET /assessments/{id}` and `GET /incidents/{id}/assessment`
now carry `routing_path`, `assigned_user_id`, `assigned_user_kind`, `can_review`
and `review_owner` (`{kind, user_id, office_code}` — `user_id` is null on the
senior engineer route, where the reviewer is an office **function**). Assignments
carry `is_authority`, which is always `false`. `GET /submissions/{id}` gains
`can_review` beside `can_edit`, and its workflow `context` gains
`assessment_routing_path`.

---

## 7. Database enforcement

The read model and the API are not the only guards; the database refuses the
shapes the model forbids (`20260910_routing_v2`).

- **Route-aware assignee eligibility.** The six eligibility triggers from
  `20260817_engineer_assignment_eligibility` are dropped and re-created: when the
  assessment's `routing_path` is `SENIOR_ENGINEER` the target must hold
  `GEOTECH_SENIOR_ENGINEER` or `ADMIN`; otherwise the original
  `GEOTECH_ENGINEER`/`FIELD_WORKER`/`ADMIN` rule applies, **with its message
  verbatim**. `trg_incident_engineer_elig_bi/bu` consults
  `EXISTS (SELECT 1 FROM assessments a WHERE a.incident_id = NEW.incident_id AND
  a.routing_path='SENIOR_ENGINEER')`; that is single-valued because
  `uk_assessment_incident` allows at most one assessment per incident, and it is
  correct because `assign-senior-engineer` stamps `routing_path` **before** the shared
  machinery writes the incident assignment.
- **`FINALIZED` is closed.** New trigger `trg_assessment_no_new_finalize` (BEFORE
  UPDATE, `FOLLOWS trg_assessment_engineer_elig_bu`) signals `45000` when
  `NEW.state='FINALIZED' AND OLD.state<>'FINALIZED'` — closing the retired
  endpoint, old clients and direct SQL alike. Already-`FINALIZED` rows update
  freely.
- **Assignment vocabulary.** `assessment_assignments.assignment_role` is widened
  to `VARCHAR(24)` **before** the CHECK is replaced, and the CHECK is now
  `('ENGINEER','SENIOR_ENGINEER','REVIEWER','APPROVER','CONSULTED')` — the two
  retired values stay listed so historical rows remain valid. `'SENIOR_ENGINEER'`
  is 15 characters and would have fitted the original `VARCHAR(16)`; the widening
  is kept as written because the migration and its down-path were reviewed
  against the wider column, and it leaves headroom for later values.
- **Untouched on purpose:** `chk_assessment_state`, `chk_incidents_stage`,
  `chk_inc_assign_stage`, `chk_inc_route_assignment_type` and
  `trg_incident_identity_bu` (which gates `incidents.incident_type` on
  `state IN ('APPROVED','FINALIZED')` and so already accepts terminal approval).

### Backfill

Every non-terminal assessment must end up with exactly one identifiable
reviewer, or the migration refuses to complete:

- a recorded branch chief, **or** `state = 'PENDING_ENGINEER_ASSIGNMENT'` (only
  `delegate-branch` puts a row there) → `routing_path='BRANCH'`;
- past office delegation, no branch chief, with an `office_code` →
  `routing_path='SENIOR_ENGINEER'` (only an office chief can review these);
- still `PENDING_OFFICE_DELEGATION` → `routing_path` stays `NULL`; the chief has
  not chosen, and v2 asks them to.

Anything left with `routing_path IS NULL AND state <> 'PENDING_OFFICE_DELEGATION'`
**raises**, listing the ids and the repair SQL. Reporting and continuing would
leave rows nobody but admin could act on. Existing `REVIEWER`/`APPROVER`
assignment rows are **not** touched — no `is_active=0` sweep, no deletion.

The re-created eligibility triggers fire only when
`assigned_engineer_user_id` changes, so a backfilled `SENIOR_ENGINEER`-route
row that still holds a legacy `FIELD_WORKER` Staff member keeps advancing through
submit and review untouched. That is the single reason the backfill is
non-destructive, and a test pins it.

---

## 8. Notifications

Notification rows are written into `incident_notifications` **inside the caller's
transaction**, so the intent to notify is atomic with the state change that
caused it. `_queue_incident_notifications` takes a `channels` tuple (default
`("IN_APP",)`), writes one row per (recipient, channel), and returns the new ids.

| Event | Template code | Recipients | Channels |
| --- | --- | --- | --- |
| Senior engineer assigned | `ASSESSMENT_SENIOR_ENGINEER_ASSIGNMENT` | the senior engineer | IN_APP |
| Submitted | `ASSESSMENT_SUBMITTED_FOR_REVIEW` | branch route: `branch_chief_user_id`; senior engineer route: the office's chiefs | IN_APP |
| **Approved** | **`ASSESSMENT_APPROVED_COORDINATOR`** | the district's coordinators ∪ `incidents.triage_decided_by_user_id` | **IN_APP + EMAIL** |
| Approved | `ASSESSMENT_APPROVED_AUTHOR` | the assignee | IN_APP |
| Revision requested | `ASSESSMENT_REVISION_REQUESTED` | the assignee | IN_APP |

The triaging coordinator is included on approval because resolving by district
alone can resolve to nobody — and, in tests, would make a "coordinator was
notified" assertion pass vacuously.

`_routing_users_for` now matches the canonical role name **and** its legacy alias
(`_ROUTING_ROLE_NAMES`, one set per assignment type). Matching only the legacy
name made a user holding just `MAINTENANCE_COORDINATOR`, `GEOTECH_OFFICE_CHIEF`
or `GEOTECH_BRANCH_CHIEF` invisible to routing and to every notification it
drives. **This retroactively widens existing notifications and pickers** — see
the rollout note in §11.

### Email: a durable outbox flushed after commit

`backend/app/services/notifications.py` provides `render()`, `send_email()`
(smtplib; raises), `deliver_pending()`, `flush_after_commit()` and
`sweep_startup()`.

- The EMAIL row is written in the approval transaction. Delivery is handed to
  FastAPI `BackgroundTasks` **once `db.commit()` returns**, so the reviewer's
  Approve response is never held by the relay.
- The task body can never surface into the request. Success stamps
  `delivered_at`; failure increments `delivery_attempts`, records
  `last_error` (`str(exc)[:255]`) and stamps `last_attempt_at`.
- One flush is bounded by `SMTP_MAX_RECIPIENTS_PER_FLUSH` (25) and
  `SMTP_FLUSH_BUDGET_S` (30s); whatever is left stays in the outbox.
- The sweeper `deliver_pending()` retries undelivered rows with a
  `min(2 ** attempts, 60)`-minute back-off measured from `last_attempt_at`. It
  runs at FastAPI startup (`sweep_startup()`, never raises) and is exposed as
  `python -m app.tools.flush_email_outbox` for a cron entry.
- After `SMTP_MAX_ATTEMPTS` a row stops being retried, appears in
  `GET /admin/notifications/undelivered` and logs a `WARNING` with incident id,
  template code and recipient id — never the message body. A recipient with no
  `users.email` is skipped with `last_error='no recipient address'`.
- **Email is disabled whenever `SMTP_HOST` is unset** — the dev and CI default.
  The EMAIL row is still written (the audit record that a notice was due) and
  left undelivered; `SMTP_BACKLOG_MAX_AGE_HOURS` (24) stops a relay enabled
  months later from flooding inboxes with history. With `MAIL_DEV_DUMP_DIR` set,
  each message is written as an `.eml` file, which makes the send path testable
  without a mail server.

Settings live in `backend/app/config.py` and are documented with defaults in
`backend/.env.example`. `SMTP_SSL` and `SMTP_STARTTLS` are mutually exclusive and
validated at startup rather than silently resolved.

Schema support (same migration): `incident_notifications` gains
`delivery_attempts INT NOT NULL DEFAULT 0`, `last_error VARCHAR(255) NULL`,
`last_attempt_at DATETIME NULL` and
`INDEX idx_inc_notify_outbox (channel, delivered_at, last_attempt_at, id)`.
`chk_inc_notify_channel` already permitted `EMAIL`, so the channel needed no
migration.

---

## 9. District → GeoTech Office routing

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

The resolved `office_code` is now **load-bearing for authority**, not just for
queues: it is what makes an office chief the reviewer on the senior engineer route.

---

## 10. Data model changes & migration notes

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
- Inserts the five canonical roles (idempotent `ON DUPLICATE KEY`).

Migration `0009_incident_triage_fields` (additive, reversible) adds dedicated
triage columns to `incidents` so the coordinator's decision is first-class and
never overwrites the location-review JSON:

- `triage_disposition` (CHECK on the four dispositions), `triage_decided_by_user_id`
  (FK users), `triage_decided_at`, `triage_notes`.
- `duplicate_of_incident_id` (self FK) and `duplicate_of_location_id` (FK
  incident_locations) for `DUPLICATE_OR_LINKED`. All FKs `ON DELETE SET NULL`.

Migration `20260910_routing_v2` (routing v2; raw `op.execute` SQL, idempotent,
**creates no new table**):

- inserts the `GEOTECH_SENIOR_ENGINEER` role row (the upgrade path;
  `020_seed.sql` is the fresh-install path — the migration never seeds *users*);
- adds `assessments.routing_path`, `chk_assessment_routing_path` and
  `idx_assessment_routing (routing_path, state)`;
- widens `assessment_assignments.assignment_role` to `VARCHAR(24)` and replaces
  `chk_assessment_assign_role`;
- adds the outbox columns and `idx_inc_notify_outbox` to
  `incident_notifications`;
- re-creates the six eligibility triggers route-aware and adds
  `trg_assessment_no_new_finalize`;
- backfills `routing_path` and **raises** if any non-terminal assessment cannot
  be routed (§7).

`downgrade()` reverses all of it: it drops the finalize trigger, restores the six
original trigger bodies verbatim, restores the narrower assignment CHECK — which
fails loudly if a `SENIOR_ENGINEER` row exists, correctly, because downgrading
over senior engineer assignments is data loss — and only then narrows the column back
to `VARCHAR(16)`, drops `routing_path` with its index and CHECK, drops the outbox
columns and index, and deletes the role row (relying on `user_roles ON DELETE
CASCADE`).

Triage handling (see `routes/assessments.py`):

- The disposition is written to the triage columns, **not** to
  `location_match_metadata`. `ASSESSMENT_REQUIRED` / `NO_ASSESSMENT_REQUIRED` /
  `DUPLICATE_OR_LINKED` do not touch `location_match_metadata` at all.
- `NEEDS_REPORTER_INFORMATION` **merges** the revision request into the existing
  `location_match_metadata` (preserving prior location-review fields) so the
  reporter-resubmit flow keeps working.
- `_serialize_incident` parses `location_match_metadata` to a JSON object.

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
alembic upgrade head        # applies 0001 .. 20260910_routing_v2
alembic current             # -> 20260910_routing_v2 (head)
# review without a DB:
alembic upgrade 20260904_assessment_subs:20260910_routing_v2 --sql
```

`database/init/020_seed.sql` also registers the new role for fresh dev DBs, and
seeds `seniorengineer@local` (office `WEST`) and `coordinator04@local`
(district `04`). **Re-run the seed on every already-initialised dev, CI and
Proxmox database after upgrading** — the migration deliberately seeds only the
role row, so those two accounts otherwise exist only on a fresh volume.

---

## 11. Rollout

**One release, no backend feature flag.** A flag would leave two authority models
live at once — an assessment approvable by a branch chief *and* an assigned
reviewer, or by neither — which is exactly what is being removed. The change is
atomic by construction: `check_migration_head()` refuses to start a backend whose
database is behind head, so a code deploy ahead of the migration fails loudly at
boot rather than 500-ing on a missing column.

**Order.** (1) `alembic upgrade head` everywhere, then re-run
`database/init/020_seed.sql`. (2) Backend authority and routing, including B1, in
one deploy. (3) Email code shipped with `SMTP_HOST` **unset** everywhere; enable
per environment once the relay is confirmed. (4) Web in the same release as (2).
(5) Mobile immediately after. (6) Docs.

**The email half of the owner's decision has an explicit acceptance gate.**
Routing v2 may ship with `SMTP_HOST` unset, but the release is **not accepted
against the "notify the coordinator by email" decision** until, in production:
(a) `users.email` is confirmed to be a deliverable mailbox (or a `work_email`
column is added) and the relay host/port/auth/`From` domain are known; (b)
`SMTP_HOST` is set and one real approval produces a `delivered_at` on the
coordinator's EMAIL row; and (c) `GET /admin/notifications/undelivered` returns
an empty list for the first week. Until (a) is answered, setting `SMTP_HOST` is
premature, not merely optional — mail to a login that is not a mailbox bounces
silently. The IN_APP half ships and is accepted with the release.

**Backward compatibility.** Record URLs and ids unchanged. Every `FINALIZED`
assessment stays readable, filterable, classified as confirmed and rendered
complete. `REVIEWER` accounts keep all read access. `?queue=reviewer` keeps
working. Assignment history is never rewritten. Retired endpoints answer with an
explanatory `400`/`409`/`410`, never a 404 and never a silent no-op.

**Two operational notes.**

1. `trg_assessment_no_new_finalize` has **no in-band escape**. If a row must be
   moved to `FINALIZED` after this release — a mis-set row, or a legacy client
   discovered mid-window — the only repair is
   `DROP TRIGGER trg_assessment_no_new_finalize;`, apply the fix, then re-create
   it from the migration body. Put it in the runbook rather than discovering it
   at 2 a.m.
2. The `_routing_users_for` fix **retroactively widens every existing
   notification and picker** to canonical-role holders. A user who holds only
   `MAINTENANCE_COORDINATOR`, `GEOTECH_OFFICE_CHIEF` or `GEOTECH_BRANCH_CHIEF`
   is invisible to routing today and becomes visible on release day. Some people
   will start receiving notices they have never received and will appear in
   pickers where they never appeared — which looks exactly like a bug unless it
   is announced.

**What to tell users.** *Office chiefs*: "You now choose one of two paths and
cannot assign Staff yourself. On the branch route the case leaves you for good;
on the senior engineer route it comes back to you to approve." *Branch
chiefs*: "You approve the assessments you were handed — no reviewer to assign, no
sign-off afterwards, and you can only act on cases handed to you." *Anyone
holding REVIEWER*: "Review is decided by the branch chief or office chief who
owns the assessment. You keep access to read everything." *Coordinators*: "When a
GeoTech assessment is approved you get a notice in ERIS and an email."
*Staff*: "Nothing changes, except that the person who returns your work is now
always the branch chief."

---

## 12. Local development & test instructions

Backend:

```bash
cd backend
# no-DB unit tests (role aliasing, routing fallback, notification templates, app import):
.venv/Scripts/python -m pytest -m "not db"
# DB-backed integration tests (requires MariaDB seeded + stamped at head):
.venv/Scripts/python -m pytest -m db
```

Web:

```bash
cd web
npm install
npm test           # node --test unit suite (assessment model, role model, ...)
npm run build      # tsc typecheck + vite build
```

Mobile:

```bash
cd mobile
npx tsc --noEmit   # typecheck
npm run lint       # expo lint
```

The authority/lifecycle matrix maps 1:1 to these files:

| File | Covers |
| --- | --- |
| `backend/tests/test_assessment_flow.py` | Both lifecycles end-to-end (`TestBranchRoute`, `TestSeniorEngineerRoute`), field-worker isolation, triage + routing, supplementals, broad read (including that `REVIEWER` keeps it), the timeline, legacy compatibility |
| `backend/tests/test_routing_v2_authority.py` | The negative matrix: wrong chief, wrong route, wrong office, unscoped chief, historical `REVIEWER`/`APPROVER` rows, retired endpoints (`400`/`409`/`410`), the linked-submission `409`s, and re-delegation from `SUBMITTED` |
| `backend/tests/test_routing_v2_eligibility.py` | The database boundary: route-aware eligibility triggers, the `FINALIZED` refusal, the untruncated assignment role, and a backfilled senior-engineer-route row with a legacy Staff member still completing |
| `backend/tests/test_routing_v2_notifications.py` | IN_APP + EMAIL rows on approval, the triaging coordinator as a recipient, per-route submit notices, and `.eml` dev delivery |
| `backend/tests/test_routing_v2_transactions.py` | B1's all-or-nothing behaviour across the linked submissions |
| `backend/tests/test_notification_templates.py` | `render()` (no DB) |
| `backend/tests/test_workflow_tree.py` | The derived read model per route, including `RESOLUTION` on an `APPROVED` assessment |
| `backend/tests/test_roles_and_routing.py` | The new role's aliasing/operational status and `GISA_AUTHOR_ROLES` |
| `web/src/features/assessments/assessmentModel.test.ts`, `web/src/utils/roleModel.test.ts` | The two client pipelines, per-route labels, and the client permission model |

---

## 13. Assumptions & unresolved policy decisions

1. **One assessment per incident** (`uk_assessment_incident`). Triage is a single
   decision point (only allowed in `COORDINATOR_REVIEW`); a routed/closed incident
   cannot be re-triaged. The route-aware `trg_incident_engineer_elig_*` triggers
   **depend** on this: their `EXISTS` over `assessments` is single-valued only
   because of that unique key.
2. **Closure policy — settled.** `APPROVED` is the terminal Assessment state and
   is set by the route's reviewer. There is no sign-off: `FINALIZED` is legacy
   history, `POST /assessments/{id}/finalize` returns `410`, and the database
   refuses new `FINALIZED` rows. **Approval does not close the incident**: the
   incident stays open until `POST /incidents/{id}/resolve`, performed by the
   assignee or an admin. Whether approval should *auto-resolve* the incident
   remains an open business decision (item 9 below).
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
7. **Office scoping is now load-bearing.** A chief or senior engineer with no
   `metadata.office_code` can neither review nor be assigned. The admin users
   page has an Office field for exactly this reason.
8. **The senior engineer route binds review to the office, not to the assigning
   chief.** The decision names "the office chief" as a function; offices have
   more than one chief, binding to a person would strand the assessment whenever
   that person is away, and no column records the assigner. This is the one place
   the implementation interprets rather than implements the decision, and it
   should be confirmed in one line.
9. **Open:** does approval auto-resolve the incident? **Open:** is `users.email`
   a deliverable mailbox, and what are the Caltrans relay facts (host, port,
   auth, accepted `From` domain)? Both gate enabling SMTP (§11).

---

## 14. Recommended next implementation phase

1. Admin UI for `geotech_office_routing` and office/branch chief eligibility.
2. Staged rename of `gisa` storage behind a compatibility view.
3. Answer the two SMTP questions and enable email per environment against the
   §11 acceptance gate.
4. Decide the approval ↔ incident-resolution coupling.
5. Bring the two-choice route step to mobile, and collapse
   `GET /incidents/{id}/office-chief/branch-options` into the assessment-scoped
   `GET /assessments/{id}/senior-engineer-options` pair.
6. Attachment access hardening parity check for assessment-linked attachments.
7. An in-app inbox that reads `incident_notifications` — nothing renders the
   IN_APP rows today.
