# Assessment Routing & Authority Model

This document describes the **Assessment** domain layer added on top of the
existing incident + GISA-backed submission workflow, the District → GeoTech
Office routing mechanism, the **two-path routing model** (routing v2), and the
"broad visibility, narrow authority" access model.

It is the source of truth for the Assessment concept. Where it conflicts with
older `*_VERIFIED.md` notes that use "GISA" as the product concept, this
document and the linked code win.

> **Organization model (migration `20260911_org_model`).** Offices, branches,
> membership, district coverage and the classification → role rules are now
> **admin-editable data**, not hard-coded maps and JSON keys (§9). Assessments
> carry a **routing snapshot** of the office and branch names, so a later rename
> cannot rewrite history. A read-only **Viewer** role (`CALTRANS_VIEWER`) reads
> approved records and nothing else (§3.1). `/incidents/routing/assignments` is
> retired to `410`; coordinator coverage lives at `/admin/org/coverage`.
> Operator guide: [org-model.md](org-model.md).

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
| `CALTRANS_VIEWER` | **none — the role is new** | read-only access to approved records; **not** an operational role (§3.1) |
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
No new grants should be made. The organization model does **not** migrate
`REVIEWER` accounts to `CALTRANS_VIEWER`: that would *narrow* them, since drafts
they can read today would disappear. They stay as they are (§13.10).

### 3.1 The read-only role: Viewer

`CALTRANS_VIEWER` is a **third role category** — neither operational nor
maintenance — added by the organization model (migration `20260911_org_model`)
for everyone else at Caltrans.

| Property | Value |
| --- | --- |
| Code / label | `CALTRANS_VIEWER` / "Viewer" |
| Legacy alias | **none.** Inventing one would make `expand_roles()` accept a name no database contains — the same reasoning as `GEOTECH_SENIOR_ENGINEER`. |
| Membership of `OPERATIONAL_ROLES` | **No, deliberately.** That set is *state-blind*: `can_view_submission` returns `True` for any operational user, and `list_submissions` returns `DRAFT` rows to them. A viewer inside it would read every draft technical form in the state. |
| Scope | **Statewide**, and the whole record. Not district- or office-scoped (design open question 3, default taken). |
| What is public | An assessment in **`APPROVED` or `FINALIZED`**, with its incident, technical form, photos, site and history. `('APPROVED','FINALIZED')` is already the repo's meaning of "official" (`incident_classification._CONFIRMED_STATES`); `FINALIZED` is legacy-only because `trg_assessment_no_new_finalize` refuses new entries. |
| What is not | Anything in flight — new, in triage, `DRAFT`, `SUBMITTED`, `REVISION_REQUESTED` — and, by default, incidents closed at triage with no assessment (`NO_ASSESSMENT_REQUIRED`, `DUPLICATE_OR_LINKED`). That default is the setting `PUBLIC_INCLUDES_CLOSED_WITHOUT_ASSESSMENT`, default `False`, so changing it is a settings change rather than a code change. |

Three predicates in `app/roles.py` carry it:

```python
CALTRANS_VIEWER = "CALTRANS_VIEWER"
PUBLIC_VIEW_ROLES: set[str] = {CALTRANS_VIEWER}

def is_public_viewer(user) -> bool: ...
def is_public_only(user) -> bool:
    """Viewer with no operational or maintenance role — mirrors is_maintenance_only."""
```

`is_public_only` answers the composition question explicitly: **a chief who is
also granted Viewer keeps their chief access**, because `require_roles` is a
union and the most permissive role wins. The narrowing predicate fires only when
Viewer is the account's only role. `CALTRANS_VIEWER` is **not** in
`GISA_AUTHOR_ROLES`; `test_gisa_author_roles_holds_exactly_four_names` fails
loudly if anyone adds it.

**How the gate is built**, because "approved only" cannot be expressed by adding
a name to `require_roles` (a flat any-of set with no notion of record state):

1. **A positive predicate per handler**, in `app/services/public_visibility.py`:
   `scope_public` / `scope_public_incidents` (row filters), `ensure_public_assessment`,
   `ensure_public_incident`, `viewer_can_read_public_submission`,
   `viewer_can_read_public_attachment`. A non-public record answers **404, not
   403** — a viewer must not be able to enumerate in-flight work by probing ids.
   `GET /assessments?queue=` answers `400 "Viewers have no work queue"`.
2. **An explicit refusal**, `deps.deny_public_only`, on every authenticated route
   that is not on the allow list.
3. **A CI census.** `backend/tests/test_route_guards.py` walks the live route
   table; every `APIRoute` must carry `require_roles`, `deny_public_only`, or an
   entry in `public_visibility.VIEWER_READABLE_ROUTES` naming the in-body
   predicate. A new route with no guard fails the build. Before the org model,
   39 of 137 routes carried no `require_roles` and three writes authorized
   nothing beyond being logged in (the `terrain-cross-sections` writes, now
   `require_roles(OPERATIONAL_ROLES)`).

`can_view_submission` was **not** widened. It has fourteen call sites across
`main.py`, `routes/photo_map.py` and `routes/photo_exports.py`, and three of them
must not be granted to a viewer: `POST /submissions/{id}/gisa/pdf` (a write
behind a read gate), `GET /submissions/{id}/shared-with` and
`/permissions` (personnel data, not the record). A separate predicate,
`viewer_can_read_public_submission`, is called only by the read endpoints on the
allow list; every other site additionally carries `deny_public_only`.

**A viewer is never a notification recipient**, and the mechanism is named so a
later recipient query cannot quietly break it: every list resolves through
`_routing_users_for`, whose candidate roles come from `_ROUTING_ROLE_NAMES`
(coordinator / office chief / branch chief / senior engineer), and
`_approval_coordinator_recipients` adds only coordinators.
`tests/test_viewer_visibility_db.py` asserts a viewer-only account appears in no
recipient list.

### The new role: GeoTech senior engineer

| Property | Value |
| --- | --- |
| Code / label | `GEOTECH_SENIOR_ENGINEER` / "GeoTech Senior Engineer" |
| Scoping | Office, via `users.metadata_json.$.office_code`, normalized by `normalize_office_code` — identical to chiefs. A senior engineer with **no** `office_code` is **not assignable**: the picker filters strictly (unlike the ENGINEER kind, which admits blank offices). |
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
| View **approved records only**, statewide | Viewer | `GET /incidents`, `GET /assessments`, `GET /submissions/{id}` (row-filtered; 404 on anything in flight) |

### Broad visibility, narrow authority

- **Broad read:** any non-maintenance operational user (`is_operational_user`)
  can read all incidents, assessments, and technical forms via the WebUI APIs.
  Enforced server-side (`can_view_submission`, `GET /assessments` guard).
- **Narrow visibility exception:** maintenance field workers are scoped to their
  own reports server-side in `list_incidents`, `get_incident`, and
  `mission_center_incident_feed`, and are blocked from `GET /assessments`. This
  is enforced in the backend, not just hidden in the UI.
- **Second narrow exception — the viewer:** an account holding only
  `CALTRANS_VIEWER` is filtered to records with an `APPROVED`/`FINALIZED`
  assessment on every read it is allowed, refused everywhere else, and answers
  404 rather than 403 on a record it may not see (§3.1).
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

Added by the organization model (`routes/org.py`, `admin_users.py`):

- `GET /org/offices`, `GET /org/districts/{district}/office` — any authenticated
  account, viewer included; labels and district resolution, no personnel.
- `GET|POST /admin/org/offices`, `PATCH /admin/org/offices/{id}`,
  `POST /admin/org/offices/{id}/deactivate`,
  `PUT /admin/org/offices/{id}/districts` — admin. `PATCH` answers `422` for a
  `code` field (the code is immutable; assessments and incidents join on it), and
  the districts `PUT` answers `409` **naming** the office that already serves a
  district.
- `GET|POST /admin/org/branches`, `PATCH /admin/org/branches/{id}`,
  `PUT /admin/org/branches/{id}/districts` — admin. `409` on a duplicate active
  branch letter in one office; each district row carries `source`
  (`CHART|INFERRED|ADMIN`).
- `GET /admin/org/classifications`, `PUT /admin/org/classifications/{id}` — the
  classification → role rules as data (14 `CLASS` rows + 2 `PATTERN` rules).
- `GET|POST /admin/org/coverage`, `DELETE /admin/org/coverage/{id}` — coordinator
  coverage, with `uncovered_districts`. The `DELETE` deactivates rather than
  removes.
- `GET|PUT /admin/users/{id}/org` — membership, classification, location and
  availability as a per-field merge, plus a `role_suggestion`. It **never writes
  `user_roles`** (§9.3).

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
- `GET`, `POST /incidents/routing/assignments` and
  `DELETE /incidents/routing/assignments/{id}` → **`410 Gone`**, retired by the
  organization model: *"Routing assignments moved to /admin/org/coverage in the
  organization model release"*. They were the only org CRUD ERIS had, and they
  wrote a table nothing routed on. Coordinator coverage is now
  `org_coordinator_coverage`, edited through `/admin/org/coverage` and read by
  `_routing_users_for`. `incident_routing_assignments` and its rows are **kept as
  history** — nothing is dropped, and the routes stay mounted so an old client
  gets the sentence rather than a 404.

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

`GET /auth/me` gains an **`org` block** — `office_id`, `office_code`,
`office_name`, `office_short_name`, `office_unit_number`, `office_is_active`,
`branch_id`, `branch_letter`, `branch_name`, `branch_is_active`, `home_city`,
`home_district`, `classification_code`, `classification_marker`,
`position_number`, `job_title`, `level_code`, `availability`, `available_from`,
`available_until` — resolved by `org_directory.resolve_user_org`. The legacy
`metadata` block stays beside it unchanged as the mirror.

The assessment payloads gain the **routing snapshot**: `routed_office_id`,
`routed_office_name`, `routed_branch_id`, `routed_branch_name`,
`routed_branch_letter`, frozen at triage and at `delegate-branch`. Clients render
the office and branch from these, never from a hard-coded map — which is what
makes a later rename or a retired branch unable to rewrite an existing record.

### Picker payloads — inform, never choose

All three assignment pickers return the same item shape and a `groups[]` list,
and none of them carries a default, a recommendation, a `selected` flag or a
ranking sort key.

| Endpoint | Grouped by | Why |
| --- | --- | --- |
| `GET /assessments/{id}/branch-options` | **branch** (`_picker_payload_by_branch`), each group headed with its home city and district | The hand-off names a branch chief, and the branch is the thing being chosen |
| `GET /assessments/{id}/senior-engineer-options` | **home city and district** (`_picker_payload_by_location`) | A `(Spec)` position has no branch and sits away from the office home city more often than not, so a branch heading would be empty for every one of them |
| `GET /admin/assessment-assignment-options/{id}?kind=ENGINEER` | branch, **the caller's own branch first**, then the rest of the office, then a trailing "Office not recorded" group | A branch chief assigns out of their own branch most of the time; the blank-office fallback survives one release so pickers do not empty in deployments whose accounts predate the org model |

Each item carries `id`, `full_name`, `email`, `office_code`, `office_name`,
`branch_id`, `branch_letter`, `branch_name`, `home_city`, `home_district`,
`group_key`, `availability`, `available_from`, `available_until`, and **two**
counts:

- `open_assessment_count` — every non-terminal assessment this person owns as
  branch chief or assignee;
- `awaiting_action_count` — the subset whose next action is theirs
  (`PENDING_ENGINEER_ASSIGNMENT` for a chief, `SUBMITTED` for their review).

The client renders "4 open · 2 waiting on them". One number cannot answer the
question, so both are returned and **neither is sorted on**: items are ordered by
group, then by name. Three further rules are contractual, not incidental:

- **Groups come from the office's branch rows, not from the people present**, so
  an empty branch still appears. A branch referenced by a person but deactivated
  since is appended rather than dropped — an item must never point at a group the
  client was not given. A chief whose `branch_id` is NULL lands in a trailing
  `UNASSIGNED` group labelled "Branch not recorded".
- **`accepts_assignments = 0` is returned with the flag set**, never omitted, so
  the client can render the branch disabled *with its reason*.
- **Availability is rendered, never filtered and never sorted on.** Someone
  marked `ROTATION_OUT` until 2/5/27 is returned like anyone else, with
  `availability` and `available_until` so the client can show "Rotation out —
  back 2/5/27". Filtering would be the picker choosing.

**Coordinator resolution** moved with them:
`_routing_users_for(assignment_type="DISTRICT_COORDINATOR")` reads
`org_coordinator_coverage WHERE is_active = 1`, ordered `is_primary DESC,
full_name`, instead of `JSON_EXTRACT(metadata_json,'$.district')`. One
coordinator may cover several districts and one district may have several
coordinators; every notification recipient list flows through this one function,
so multi-district coverage reaches all of them at once.

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

## 9. The organization model, and District → GeoTech Office routing

### 9.1 Offices, branches and membership are data

Before the organization model (`20260911_org_model`) the district→office map
existed in **three** places — `incidents.OFFICE_BY_DISTRICT`,
`office_routing.LEGACY_OFFICE_BY_DISTRICT` and the `0008` seed — a branch could
not be expressed at all, and a person's office lived in a free-text JSON key that
the admin PATCH replaced wholesale on every save. Seven tables replace that:

| Table | Holds |
| --- | --- |
| `org_offices` | An office: immutable `code`, `org_type` (`GEOTECH`/`MAINTENANCE`), unit number, full `name`, `short_name`, home city/district, `is_routing_target`, `is_active` |
| `org_office_districts` | The districts an office serves — **rows, not JSON**, because `office_for_district` is on the incident-creation path and needs an index |
| `org_branches` | A branch (or, later, a maintenance `REGION`/`AREA`/`YARD`): office, optional parent, `letter`, printed `name`, home city/district, `chief_user_id`, `accepts_assignments`, `is_active` |
| `org_branch_districts` | Districts a branch covers, each row labelled `source` = `CHART` / `INFERRED` / `ADMIN`. **Seeded empty** — no org chart states branch coverage for any office |
| `org_user_profiles` | 1:1 with `users`: office, branch, home city/district, classification code and marker, position number, job title, level, supervisor, `availability` + `available_from/until`, `source` |
| `org_coordinator_coverage` | District → coordinator, many-to-many, with `is_primary` |
| `org_classifications` | The classification → role rules **as data**: 14 `CLASS` rows and 2 `PATTERN` rules |

`assessments` gains the **routing snapshot** — `routed_office_id`,
`routed_office_name`, `routed_branch_id`, `routed_branch_name`,
`routed_branch_letter` — written at triage and at `delegate-branch`. Renaming an
office, moving a district or retiring a branch afterwards cannot rewrite what an
existing record says.

**One resolution helper, two sources.** `org_directory.resolve_user_org(db, user)`
prefers the `org_user_profiles` row and falls back to the `users.metadata_json`
mirror when the row is missing **or** its `office_id IS NULL`. Both write paths —
`PUT /admin/users/{id}/org` and the legacy `PATCH /admin/users/{id}` — write the
profile and re-render the mirror in the same transaction, so no chief loses a
queue mid-migration. `resolve_user_org` deliberately applies **no `is_active`
filter**: deactivating an office in admin must not revoke review authority on
work already routed to it.

### 9.2 District → GeoTech Office routing

`org_office_districts` is now authoritative. Resolution lives in
`app/services/org_directory.py`:

1. look up the active `org_office_districts` row for the normalized district
   (`org_type='GEOTECH'`), returning the office's code **and** its names;
2. fall back to the legacy constant `LEGACY_OFFICE_BY_DISTRICT` if no row exists,
   which is what makes the upgrade safe on a database whose seed has not been
   re-run.

`services/office_routing.py` keeps its public surface and delegates. The three
hard-coded copies of the map are gone, together with the four call sites that
bypassed the service (`incidents.py` ×3, `incident_approval.py` ×1). For one
release `org_directory` is the **only** writer of `geotech_office_routing`,
mirroring each district change so a rollback to the previous backend still
routes correctly; that table is dropped in a later revision whose only job is the
drop.

Coordinators can still preview the calculated office via
`GET /assessments/routing/preview?district=NN`, and may still override the office
at triage with a required `override_reason` (audited on the assessment and in the
timeline). The difference is that the mapping is now editable in the admin
Organization pages (`/admin/org/offices`) instead of by SQL — see
[org-model.md](org-model.md).

The resolved `office_code` is **load-bearing for authority**, not just for
queues: it is what makes an office chief the reviewer on the senior engineer
route. The only change is *where the caller's office comes from* —
`resolve_user_org()` rather than `metadata.office_code`.

### 9.3 Classification → role is a suggestion, never a grant

`org_classifications` holds the mapping: `3155` → Office Chief, `3161`/`3751`
marked `SUP` → Branch Chief, `(Spec)`-marked seniors (3161, 3751, 3375, 3185) →
Senior Engineer, TE Civil / Engineering Geologist / TET / MREA → Staff, plus two
`PATTERN` rules for disciplines nobody has enumerated yet — *any
`Senior <discipline>` marked `(Spec)`*, and *any classification marked `(Sup)` at
level S09*. Marker parsing normalises case and whitespace and tolerates a missing
closing parenthesis, because the charts print `Senior TE(Sup)`,
`Senior TE (Sup)` and `Sr TE/Sr EG (SUP`. It is **suggested in
the admin UI and never enforced by the backend**: the charts themselves show
vacant positions filled out of class and multi-month acting assignments, so an
admin must be able to grant a role that contradicts a stored classification.
`PUT /admin/users/{id}/org` returns `role_suggestion` and never touches
`user_roles`; `tests/test_admin_org_api_db.py` asserts the row stays
byte-identical.

### 9.4 Two scoping bugs fixed in the same change

An org model that starts issuing canonical role names inherits any helper that
only knows the legacy ones:

- `_ensure_incident_scope_access` tested only `MAINT_COORDINATOR` /
  `OFFICE_CHIEF` / `BRANCH_CHIEF`, so a canonically-roled account got **no**
  district or office narrowing on incident detail;
- `_mobile_scope_filters` was half-fixed already — its Staff/senior-engineer
  branch accepted canonical names, but the coordinator, office-chief,
  branch-chief and reporter branches did not, so a canonical-named coordinator
  fell through to `['1=0']` and an **empty mobile feed**.

Both now go through `roles.has_canonical_role`.

And `POST /assessments/{id}/assign-engineer` — the one assignment endpoint that
validated state, route and the caller's identity but never its **target** — now
checks the Staff member it is given:

- **out of office: hard refusal**, `400 "Selected Staff member belongs to another
  GeoTech office"`, matching `delegate-branch` and `assign-senior-engineer`. A
  Staff member with no recorded office is still allowed while the picker's
  blank-office fallback survives;
- **out of branch: allowed with a reason**, `400 "This Staff member is in another
  branch. Record why in notes to assign them anyway."` when `notes` is empty. The
  reason is recorded on the `ENGINEER_ASSIGNED` event with `out_of_branch: true`.
  A chief covering a short-staffed branch is a real thing, and the org model must
  not be the first place ERIS says no to it.

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

Migration `20260911_org_model` (the organization model; raw `op.execute` SQL,
additive, idempotent — `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`,
`DROP … IF EXISTS` before every re-creatable object):

- creates the seven `org_*` tables of §9.1 and seeds the office/branch structure,
  the twelve `org_office_districts` rows migrated from `geotech_office_routing`,
  and the sixteen `org_classifications` rules — **structure only; no real
  person's name is seeded**;
- inserts the `CALTRANS_VIEWER` role row;
- adds the five `assessments.routed_*` snapshot columns plus
  `idx_assessment_routed_office` and the two foreign keys
  `fk_assessment_routed_office` / `fk_assessment_routed_branch`;
- backfills `org_user_profiles` from `users.metadata_json` and
  **raises `RuntimeError`** rather than guessing when an active user's
  `office_code` matches no office — see the pre-flight query in
  [MIGRATIONS.md](MIGRATIONS.md);
- scopes its uniqueness keys so a maintenance chart lands later without a schema
  change: `uk_org_office_code` is `(org_type, code)`; `org_office_districts`
  enforces "at most one active office **of a given org type** per district"
  through a stored generated column (MariaDB has no partial unique index); and
  `org_branches` carries **two** generated keys — `active_key` for the
  one-active-letter-per-office rule and `active_unit_key` for letterless units,
  so two yards in one office both insert.

`downgrade()` reverses it — but read the warning in
[MIGRATIONS.md](MIGRATIONS.md) first: dropping the `CALTRANS_VIEWER` role row
cascades to `user_roles` and **un-grants every viewer account an admin created**,
and a later `upgrade` does not restore them. `assessments.office_code` is
untouched, so routing and review authority survive a downgrade.

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
# run the org-model pre-flight query FIRST (docs/MIGRATIONS.md) — this is the one
# revision that can refuse to run
alembic upgrade head        # applies 0001 .. 20260911_org_model
alembic current             # -> 20260911_org_model (head)
# review without a DB:
alembic upgrade 20260910_routing_v2:20260911_org_model --sql
```

`database/init/020_seed.sql` also registers the new roles for fresh dev DBs —
`GEOTECH_SENIOR_ENGINEER` and `CALTRANS_VIEWER` — seeds the five offices and
seventeen branches, and seeds `seniorengineer@local` (office `WEST`),
`coordinator04@local` (district `04`) and `viewer@local`. **Re-run the seed on
every already-initialised dev, CI and Proxmox database after upgrading** — the
migrations deliberately seed only role rows and org *structure*, never demo
users, so those accounts otherwise exist only on a fresh volume. A fictional demo
roster is a separate, explicitly-flagged script
(`backend/scripts/seed_demo_org_roster.py`); no real person from any org chart is
seeded anywhere.

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

### The organization-model release, on top of the above

1. **Run the pre-flight query first** ([MIGRATIONS.md](MIGRATIONS.md)). It lists
   the accounts whose `metadata_json.office_code` matches no office. A non-empty
   result is work an operator must do *before* `alembic upgrade`; the migration
   otherwise aborts with `RuntimeError` rather than guessing what `W` meant and
   quietly misrouting a chief's queue. This is the only manual step.
2. **Migration first, readers second.** `20260911_org_model` is additive and
   idempotent; after it runs nothing behaves differently, because
   `resolve_user_org` still answers from the `metadata_json` mirror wherever a
   profile row has no office.
3. **One resolution helper, two writers, one release.** The moment any reader
   moves to `org_user_profiles`, both write paths must write it —
   `PUT /admin/users/{id}/org` and the legacy `PATCH /admin/users/{id}`
   write-through. Split across releases, this is the window in which a chief
   loses their queue.
4. **The two `assessments` foreign keys are the only statement that is not free
   to re-run.** MariaDB has no `ADD CONSTRAINT IF NOT EXISTS`, so each is a
   `DROP … IF EXISTS` + `ADD` pair taking a metadata lock on a large, hot table.
   Schedule the window accordingly.
5. **The viewer ships behind no flag and with no accounts.** The role row exists
   from the migration; nobody holds it until an admin grants it. Note in the
   release announcement that **a downgrade un-grants every viewer** and a later
   upgrade does not restore them.
6. **The mobile canonical-name fix ships with or before the first
   canonically-roled account**, or the organization model gets blamed for a
   mobile regression it merely exposed.
7. **Client order**: role model → route and nav gates → pickers → admin
   Organization pages → the users page. Each step is independently shippable.

**What to tell users.** *Admins*: "Offices, branches, who covers each district
and each person's place in the organization are now edited in Administration ›
Organization. `Who covers each district` moved there from incident routing."
*Office and branch chiefs*: "Your office comes from your account's organization
record now, not a text field. Pickers group people by branch and show how much
each person has open — they never choose for you." *Everyone else at Caltrans*:
"A read-only Viewer account shows approved records only."

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
| `backend/tests/test_roles_and_routing.py` | The new roles' aliasing/operational status and `GISA_AUTHOR_ROLES`, including that `CALTRANS_VIEWER` is neither operational nor maintenance-only |
| `backend/tests/test_org_model.py` (no DB) | Classification → role derivation over every marker spelling on the charts, the two `PATTERN` rules resolving after the `CLASS` rows, location parsing, and `resolve_user_org`'s fallback — both when no profile row exists and when the row exists with `office_id IS NULL` |
| `backend/tests/test_scope_helpers.py` (no DB) | The canonical-role fix in the incident and mobile scope helpers |
| `backend/tests/test_route_guards.py` (no DB) | The census, as CI: every route carries `require_roles`, `deny_public_only`, or a named entry in `VIEWER_READABLE_ROUTES` |
| `backend/tests/test_org_api_db.py` | Office/branch CRUD, the immutable code (`422`), the district move (`409` naming the other office), the scoped uniqueness keys, and deactivation leaving an existing snapshot alone |
| `backend/tests/test_admin_org_api_db.py` | The proposal rule: a classification suggests a role and leaves `user_roles` byte-identical; the legacy `PATCH` write-through |
| `backend/tests/test_pickers_db.py` | Grouping, the `UNASSIGNED` group, `accepts_assignments = 0` returned with its flag, a rotated-out person neither filtered nor moved, and own-branch-first ordering |
| `backend/tests/test_viewer_visibility_db.py` | The viewer reads an approved record whole, 404s on anything in flight, 400s on any queue, is refused every route on the deny list one assertion at a time, appears in no recipient list, and a chief-plus-viewer keeps full chief access |
| `backend/tests/test_seed_shape_db.py` | 5 offices, 17 branches, 12 office-district rows, 0 branch-district rows, 16 classification rules, one `CALTRANS_VIEWER` role |
| `backend/tests/test_migration_org_model.py` | Base→head on a clean DB, re-running the revision as a no-op even after an admin has deactivated a seeded branch, the backfill raising on an unresolvable `office_code`, and `downgrade()` leaving `users` and `assessments` readable |
| `web/src/features/assessments/assessmentModel.test.ts`, `web/src/utils/roleModel.test.ts`, `web/src/features/assessments/personPickerModel.test.ts`, `web/src/utils/orgDistricts.test.ts` | The client pipelines, per-route labels, the permission model including the viewer, and the picker's no-preselect contract |

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
7. **Office scoping is now load-bearing, and it is now real data.** A chief or
   senior engineer with no office can neither review nor be assigned. The office
   comes from `org_user_profiles.office_id` through `resolve_user_org`, with the
   `users.metadata_json` mirror as the fallback for one release; the admin users
   page has Office and Branch fields, and `/admin/org/*` keeps the offices
   themselves correct.
8. **The senior engineer route binds review to the office, not to the assigning
   chief.** The decision names "the office chief" as a function; offices have
   more than one chief, binding to a person would strand the assessment whenever
   that person is away, and no column records the assigner. This is the one place
   the implementation interprets rather than implements the decision, and it
   should be confirmed in one line.
9. **Open:** does approval auto-resolve the incident? **Open:** is `users.email`
   a deliverable mailbox, and what are the Caltrans relay facts (host, port,
   auth, accepted `From` domain)? Both gate enabling SMTP (§11).
10. **Legacy `REVIEWER` accounts are not migrated to Viewer** and this is a
    decision, not an omission. Viewer is *narrower*: a `REVIEWER` reads drafts
    today, a viewer reads only approved records. Migrating them would take
    access away. They keep operational read, deprecated as they already are.
    What to do with them long-term is open.
11. **Viewer defaults, taken from the organization-model design and shipped as
    written.** Read is **statewide**, not scoped. Incidents closed at triage
    with no assessment are **not** public
    (`PUBLIC_INCLUDES_CLOSED_WITHOUT_ASSESSMENT`, default `False`), so a viewer
    sees fewer incidents than the operational incident count — expected, not a
    bug. Viewers **may** fetch photo bytes and attachment content of approved
    assessments. Each is a settings- or allow-list change if the owner decides
    otherwise; the gates are per-file, so the photo answer moves four rows
    between the allow and deny tables and nothing else.
12. **Availability markings are rendered, never filtered or sorted on**, and a
    coordinator may cover several districts. Both are model decisions the
    pickers and notification queries depend on (§6).

---

## 14. Recommended next implementation phase

1. ~~Admin UI for `geotech_office_routing` and office/branch chief
   eligibility.~~ **Shipped** as `/admin/org/offices|branches|coverage`
   (§9, [org-model.md](org-model.md)). What remains is the follow-up revision
   `20260912_drop_geotech_office_routing`, whose only job is dropping the mirror
   table once no deployment can roll back past the organization model.
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
