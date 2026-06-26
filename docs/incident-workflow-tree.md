# Incident Workflow Tree

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
* `assessments` (lifecycle state + decision timestamps + branch/engineer)
* `assessment_assignments` (engineer / reviewer / approver)
* `assessment_events` (who performed each transition + when + notes)

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
* Non-maintenance operational users (coordinator, office/branch chief, engineer,
  reviewer): any incident.
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
    "office_code": "WEST",
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
| `OFFICE_DELEGATION` | `GEOTECH_OFFICE_CHIEF` | Office chief delegation |
| `BRANCH_ASSIGNMENT` | `GEOTECH_BRANCH_CHIEF` | Branch chief engineer assignment |
| `ENGINEER_ASSESSMENT` | `GEOTECH_ENGINEER` | Engineer assessment work |
| `ASSESSMENT_REVIEW` | `REVIEWER_APPROVER` | Assessment review |
| `FINALIZATION` | `GEOTECH_OFFICE_CHIEF` | Finalization |
| `RESOLUTION` | (system / owner) | Incident resolution |

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
* **OFFICE_DELEGATION** — `COMPLETED` once `office_delegated_at` is set (actor =
  `OFFICE_DELEGATED` event office chief); else `CURRENT`/`UNASSIGNED` while state
  is `PENDING_OFFICE_DELEGATION`; else `PENDING`.
* **BRANCH_ASSIGNMENT** — `COMPLETED` once `engineer_assigned_at` is set (actor =
  `ENGINEER_ASSIGNED` event branch chief); else `CURRENT`/`UNASSIGNED` while state
  is `PENDING_ENGINEER_ASSIGNMENT` (assigned person = the delegated branch chief).
* **ENGINEER_ASSESSMENT**
  * state `REVISION_REQUESTED` → `REVISION_REQUESTED` (engineer must revise).
  * state `SUBMITTED/APPROVED/FINALIZED` → `COMPLETED`; actor = `SUBMITTED` event
    engineer (**the original submitter**, preserved even if the engineer is later
    reassigned).
  * state `DRAFT` → `CURRENT` (assigned engineer working).
* **ASSESSMENT_REVIEW**
  * `APPROVED/FINALIZED` → `COMPLETED`; actor = `APPROVED` event reviewer/approver.
  * `SUBMITTED` → `CURRENT` if an active reviewer/approver assignment exists, else
    `UNASSIGNED` (awaiting reviewer assignment).
  * `REVISION_REQUESTED` → `PENDING` (paused; **never** `COMPLETED` while a
    revision is outstanding).
* **FINALIZATION** — `COMPLETED` when `FINALIZED`; `CURRENT`/`UNASSIGNED` when
  `APPROVED`; else `PENDING`.
* **RESOLUTION** — `TERMINAL` when the incident is `RESOLVED` (label reflects the
  disposition: "No assessment required" / "Linked / duplicate report" /
  "Assessment finalized & incident resolved" / "Incident resolved"); `CURRENT`
  when the assessment is `FINALIZED` but not yet resolved; else `PENDING`.

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

1. **Finalization ↔ resolution** is still decoupled (see the assessment model
   doc). When an assessment is `FINALIZED` but the incident is not yet `RESOLVED`,
   the `RESOLUTION` node is shown as `CURRENT` with the assigned engineer as owner,
   reflecting the existing resolve permission. Whether finalization should
   auto-resolve the incident remains an open business decision.
2. **One assessment per incident** — the tree assumes the single-assessment model
   enforced by the Assessment layer.
3. The read model derives everything live; it adds **no** new persisted state.
