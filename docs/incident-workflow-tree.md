# Incident Workflow Tree

> **Role codes.** This document predates `20260923_roles_consolidated` and uses the
> role codes of its time (`GEOTECH_*`, `CALTRANS_VIEWER`, "senior engineer", ...).
> The current roles, and how each retired code maps to one, are in
> [roles-and-identity.md](roles-and-identity.md).

A visual, auditable workflow map for every incident. It lets a user open an
incident and immediately see where it is in the process, who has completed their
part, who currently owns the next action, who is assigned but has not acted, what
happened at each prior step, and whether the incident took a normal **Assessment**
path or ended through a disposition.

It is a **derived read model** built entirely from existing audit data — no new
tables. It sits on top of the Assessment Routing & Authority Model
([assessment-routing-authority-model.md](assessment-routing-authority-model.md))
and reuses its records:

* `incidents` (stage, status, triage disposition + decision fields, duplicate
  link fields, resolution fields, linked submission)
* `incident_assignments` (active per-stage assignees)
* `assessments` (lifecycle state, **`routing_path`**, decision timestamps, the
  branch chief and the assignee)
* `assessment_assignments` (kept in the builder's signature for callers and
  future nodes; **since routing v2 it grants nothing** — the review step's owner
  comes from the routing path, not from a `REVIEWER`/`APPROVER` row)
* `assessment_events` (who performed each transition + when + notes)

**Routing v2 shapes the tree.** The office chief's step is a *routing* step with
two outcomes; `BRANCH_ASSIGNMENT` is `SKIPPED` on the senior engineer route;
the assignee node is labelled and role-coded per route; the review node is owned
by the route's reviewer; and `FINALIZATION` is emitted **only** for legacy rows
that were signed off before routing v2.

User-facing wording is **Assessment / Workflow / Current owner / Pending action /
Assessment review / Revision requested / No assessment required / Linked or
duplicate report** — never legacy "GISA".

---

## API contract

```
GET /incidents/{incident_id}/workflow-tree
```

Access (server-enforced, broad visibility / narrow authority):

* Maintenance field workers: only for their **own** reports (403 otherwise).
* Non-maintenance operational users (coordinator, office/branch chief, Staff,
  senior engineer, legacy reviewer): any incident.
* Admin: all.

Response:

```jsonc
{
  "incident_id": 123,
  "path_type": "ASSESSMENT_REQUIRED",      // see Path types
  "overall_status": "CURRENT",             // status of the active bottleneck node
  "current_owner": {                       // null when terminal/closed
    "role": "GEOTECH_BRANCH_CHIEF",
    "role_title": "GeoTech Branch Chief",
    "user_id": 45,
    "full_name": "Example Person",
    "email": "example@caltrans.ca.gov",
    "node_key": "BRANCH_ASSIGNMENT"
  },
  "assessment": {                          // null until an Assessment exists
    "id": 9, "state": "PENDING_ENGINEER_ASSIGNMENT",
    "routing_path": "BRANCH",              // null | "BRANCH" | "SENIOR_ENGINEER"
    "office_code": "WEST",
    // holds the assignee on BOTH routes; routing_path says which kind of person
    "assigned_engineer_user_id": null, "branch_chief_user_id": 45
  },
  "linked_incident_id": null,              // DUPLICATE_OR_LINKED target
  "linked_location_id": null,
  "nodes": [
    {
      "key": "REPORTER_SUBMISSION",
      "role": "MAINTENANCE_FIELD_WORKER",
      "role_title": "Maintenance Field Worker",
      "label": "Incident report submitted",
      "status": "COMPLETED",
      "user": { "user_id": 7, "full_name": "...", "email": "..." },
      "completed_at": "2026-06-25T10:00:00",
      "notes": null,
      "event_type": "INCIDENT_CREATED"
    }
    // ... more nodes
  ]
}
```

---

## Workflow nodes (fixed order)

| key | role | normal label |
| --- | --- | --- |
| `REPORTER_SUBMISSION` | `MAINTENANCE_FIELD_WORKER` | Incident report submitted |
| `COORDINATOR_TRIAGE` | `MAINTENANCE_COORDINATOR` | Coordinator triage |
| `OFFICE_DELEGATION` | `GEOTECH_OFFICE_CHIEF` | Office chief routing |
| `BRANCH_ASSIGNMENT` | `GEOTECH_BRANCH_CHIEF` | Branch chief Staff assignment |
| `ENGINEER_ASSESSMENT` | `GEOTECH_ENGINEER` **or** `GEOTECH_SENIOR_ENGINEER` | Staff / Senior engineer assessment work |
| `ASSESSMENT_REVIEW` | `GEOTECH_BRANCH_CHIEF` **or** `GEOTECH_OFFICE_CHIEF` (`ASSESSMENT_REVIEWER` while unrouted) | Assessment review |
| `FINALIZATION` | `GEOTECH_OFFICE_CHIEF` | Assessment signed off (legacy) — **emitted only when `finalized_at` is set** |
| `RESOLUTION` | (system / owner) | Incident resolution |

Role codes render through `_ROLE_TITLES`, which labels `GEOTECH_ENGINEER` as
`"GeoTech Staff"`, gained `GEOTECH_SENIOR_ENGINEER: "GeoTech Senior Engineer"` and
replaced `REVIEWER_APPROVER: "Assigned Reviewer / Approver"` with the pseudo-role
`ASSESSMENT_REVIEWER: "The assessment's reviewer"` — used only where no route has
been chosen yet and there is nobody to name.

## Statuses

`COMPLETED` · `CURRENT` · `PENDING` · `WAITING_ON_REPORTER` ·
`REVISION_REQUESTED` · `SKIPPED` · `TERMINAL` · `UNASSIGNED`

## Path types

* `PENDING_TRIAGE` — report created, not yet triaged.
* `ASSESSMENT_REQUIRED` — assessment exists / was required.
* `NEEDS_REPORTER_INFORMATION` — coordinator requested info; loop active.
* `NO_ASSESSMENT_REQUIRED` — terminal disposition.
* `DUPLICATE_OR_LINKED` — terminal disposition with a linked target.

---

## Node derivation rules

The tree is **not** inferred from incident stage alone — it combines events,
assignments, assessment state, and triage fields. The actor who *performed* a step
comes from the immutable `assessment_events` log; the *currently assigned* person
comes from the live assignment.

* **REPORTER_SUBMISSION** — always `COMPLETED`; actor = reporter, time = created_at.
* **COORDINATOR_TRIAGE**
  * not triaged yet → `CURRENT` (auto-assigned district coordinator) or `UNASSIGNED`.
  * needs-info + `location_match_status = NEEDS_REVISION` → `WAITING_ON_REPORTER`
    (current owner = the reporter who must update).
  * needs-info + reporter resubmitted → `CURRENT` (triage resumes).
  * a real disposition recorded → `COMPLETED`; actor = triage decider.
* **OFFICE_DELEGATION** (the *routing* step, two outcomes)
  * `COMPLETED` once `office_delegated_at` is set — the branch route (actor =
    `OFFICE_DELEGATED` event office chief).
  * `COMPLETED` with label "Assigned to a senior engineer" when
    `routing_path='SENIOR_ENGINEER'` — that route has no hand-off, so
    `office_delegated_at` stays NULL and the `SENIOR_ENGINEER_ASSIGNED` event
    is what completed the step (`completed_at` = `engineer_assigned_at`).
  * else `CURRENT`/`UNASSIGNED` while state is `PENDING_OFFICE_DELEGATION`, with
    the note *"Office chief must route this assessment: hand it off to a branch
    chief, or assign a senior engineer."*; else `PENDING`.
* **BRANCH_ASSIGNMENT** — `COMPLETED` once `engineer_assigned_at` is set (actor =
  `ENGINEER_ASSIGNED` event branch chief); **`SKIPPED` on the senior engineer
  route** ("the office chief assigned the assessment directly"), so it never
  reads as an open bottleneck; else `CURRENT`/`UNASSIGNED` while state
  is `PENDING_ENGINEER_ASSIGNMENT` (assigned person = the delegated branch chief).
* **ENGINEER_ASSESSMENT** — the assignee's node. Its role code and wording follow
  the route: `GEOTECH_ENGINEER`/"Staff" on `BRANCH`,
  `GEOTECH_SENIOR_ENGINEER`/"Senior engineer" on `SENIOR_ENGINEER`. Both
  live in `assigned_engineer_user_id`.
  * state `REVISION_REQUESTED` → `REVISION_REQUESTED` (the assignee must revise).
  * state `SUBMITTED/APPROVED/FINALIZED` → `COMPLETED`; actor = `SUBMITTED` event
    assignee (**the original submitter**, preserved even if the assignee is later
    reassigned).
  * state `DRAFT` → `CURRENT` (assignee working).
* **ASSESSMENT_REVIEW** — owned by **the route's reviewer**, never by an
  assignment row: `GEOTECH_BRANCH_CHIEF` = `branch_chief_user_id` on the branch
  route, `GEOTECH_OFFICE_CHIEF` = the assessment's office chief on the senior
  engineer route, `ASSESSMENT_REVIEWER` (nobody) while `routing_path IS NULL`.
  "Awaiting reviewer assignment" is no longer a state the workflow can be in.
  * `APPROVED/FINALIZED` → `COMPLETED`; actor = `APPROVED` event reviewer.
  * `SUBMITTED` → `CURRENT` on the senior engineer route (the **office** owns the
    step, so it is never unassigned); `CURRENT` on the branch route when a branch
    chief is named, else `UNASSIGNED`; `UNASSIGNED` while unrouted.
  * `REVISION_REQUESTED` → `PENDING` (paused; **never** `COMPLETED` while a
    revision is outstanding).
* **FINALIZATION** — **legacy only.** Emitted as `COMPLETED` ("Assessment signed
  off (legacy)") if and only if `finalized_at` is set. Approval is terminal in
  routing v2 and the database refuses new `FINALIZED` rows, so rendering a
  permanently-`PENDING` step on every new assessment would tell everyone the
  workflow is unfinished when it is done.
* **RESOLUTION** — `TERMINAL` when the incident is `RESOLVED` (label reflects the
  disposition: "No assessment required" / "Linked / duplicate report" /
  **"Assessment approved & incident resolved"** / "Assessment finalized &
  incident resolved" (legacy) / "Incident resolved"); `CURRENT` when the
  assessment is **`APPROVED` (or legacy `FINALIZED`)** but the incident is not yet
  resolved, owned by the **assignee** — Staff member *or* senior engineer — with
  the note "Assessment approved; awaiting incident resolution."; else `PENDING`.
  Keying this on `FINALIZED` alone would leave `RESOLUTION` permanently `PENDING`
  and unowned for every v2 assessment, so nobody would ever be told to close the
  incident out and the "Ready to close out" Home group would be permanently
  empty.

For terminal dispositions (`NO_ASSESSMENT_REQUIRED`, `DUPLICATE_OR_LINKED`) the
intermediate assessment nodes are `SKIPPED` and `RESOLUTION` is `TERMINAL`.

**Current owner** is the first node (in order) whose status is one of `CURRENT`,
`WAITING_ON_REPORTER`, `REVISION_REQUESTED`, or `UNASSIGNED`. For
`WAITING_ON_REPORTER` the owner is the reporter; for `UNASSIGNED` the owner has a
role but no person.

---

## WebUI

`web/src/components/WorkflowTree.tsx` renders a responsive map — vertical on
narrow screens, horizontal on `xl` — with connectors between nodes, a status
glyph **and** text label per node (never color alone), a prominent ring on the
current node, a compact current-owner + assessment-state summary, expandable
per-node details, and the linked/duplicate target. Opened from a per-incident
**Workflow** button on the Incidents page.

## Mobile

`mobile/src/components/IncidentWorkflowTree.tsx` renders a compact vertical rail
on the incident detail screen: a current-owner/status banner readable without
expanding, status-dot nodes, and tappable nodes that reveal notes, timestamps,
and assignment details. It renders nothing when access is denied, keeping the
detail screen usable for maintenance field workers viewing their own reports.

---

## Assumptions / unresolved policy

1. **Approval ↔ resolution** is still decoupled (see the assessment model doc).
   When an assessment is `APPROVED` (or legacy `FINALIZED`) but the incident is
   not yet `RESOLVED`, the `RESOLUTION` node is shown as `CURRENT` with the
   assignee as owner, reflecting the existing resolve permission. Whether
   approval should auto-resolve the incident remains an open business decision.
   There is no longer a sign-off step in between.
2. **One assessment per incident** — the tree assumes the single-assessment model
   enforced by the Assessment layer. Routing v2's
   `trg_incident_engineer_elig_*` triggers depend on the same uniqueness, so
   relaxing it is a change to both.
3. **Assignment rows are history, not authority.** `assessment_assignments` is
   still passed to `build_workflow_tree` for callers and future nodes, but no
   node derives ownership from it. A `REVIEWER`/`APPROVER` row never makes
   anybody the review node's owner.
4. The read model derives everything live; it adds **no** new persisted state.
