# ERIS Event Group domain

## Domain invariant

Incident is the durable operational record in ERIS. Event Group is a grouping attribute on an Incident, not a parent record.

- A newly submitted Incident is provisional while it remains in `COORDINATOR_REVIEW`.
- Provisional Incidents have no permanent `incident_key` and may be discarded.
- The Maintenance Coordinator decides whether the Incident belongs to an existing Event Group or starts a new Event Group.
- If no existing Event Group is selected at approval, ERIS creates one automatically.
- Coordinator forwarding atomically finalizes `event_group_id`, mints the permanent `incident_key`, records approval provenance, and advances the workflow.
- Once `incident_key` exists it is immutable and the Incident may not be hard-deleted.
- Reassigning an approved Incident to another Event Group never changes its Incident identity or historical key.

## Cardinality

```text
Event Group A  <--- Incident 1001.event_group_id
               <--- Incident 1002.event_group_id
               <--- Incident 1003.event_group_id
```

The Incident rows remain independent root records. Event Groups provide shared operational context only.

## Permanent identity boundary

`incidents.id` remains an internal database surrogate key and exists during intake.

`incidents.incident_key` is the external/historical identity:

- `NULL` = provisional/disposable
- non-`NULL` = coordinator-approved/permanent

Approved Incidents are retained historically even after resolution, cancellation, duplicate disposition, or Event Group reassignment.
