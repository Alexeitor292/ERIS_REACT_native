"""Only a report sent for assessment enters the incident record.

Revision ID: 20260922_triage_close_ungrouped
Revises: 20260911_org_model
Create Date: 2026-09-22

The owner's rule: a field report enters ERIS — gets its permanent ERIS number,
joins an Event Group, appears in the incident record, the Event Groups and the
Mission Center — only when the Maintenance Coordinator decides it needs a
GeoTech assessment. Every other decision keeps it out:

  * "No assessment required" and "Duplicate or linked" close the report at
    triage. It is kept, with the decision and its history, but it never enters
    the record: no ERIS number, no Event Group.
  * "Needs more from the reporter" keeps it as a temporary field report in
    coordinator review until the reporter answers and the coordinator decides.

``trg_incident_identity_bu`` used to mint the ERIS number, and demand an Event
Group, on every exit from coordinator review. It now does that for every exit
EXCEPT a close at triage, which leaves ungrouped and unnumbered — and a report
closed at triage is refused an Event Group outright.

Existing data is brought under the rule once: every report closed at triage,
and every report still in coordinator review without an ERIS number (placed in
a group by the old triage flow before any decision), is taken out of its Event
Group. Each move is recorded as an INCIDENT_MOVED_OUT event carrying
``MIGRATION_MARKER``, and a group left with no reports is archived, so the Event
Groups page and the Mission Center stop showing them. Numbers already minted
for reports closed at triage are left in place: an ERIS number is permanent and
may already have gone out in a notification; the application no longer shows
it for those reports.
"""

import json

from alembic import op
from sqlalchemy import text

revision = "20260922_triage_close_ungrouped"
down_revision = "20260911_org_model"
branch_labels = None
depends_on = None

MIGRATION_MARKER = "20260922_triage_outside_record"

# The one exemption, spelled once so every check below agrees on it.
_CLOSED_AT_TRIAGE = (
    "(NEW.current_stage = 'RESOLVED' "
    "AND NEW.triage_disposition IN ('NO_ASSESSMENT_REQUIRED', 'DUPLICATE_OR_LINKED'))"
)


def _trigger_sql(*, triage_can_close_outside_record: bool) -> str:
    closed = _CLOSED_AT_TRIAGE if triage_can_close_outside_record else "FALSE"
    closed_check = (
        f"""
          IF {closed} AND NEW.event_group_id IS NOT NULL THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = 'A report closed at triage does not enter the incident record or an Event Group';
          END IF;
"""
        if triage_can_close_outside_record
        else ""
    )
    return f"""
        CREATE TRIGGER trg_incident_identity_bu
        BEFORE UPDATE ON incidents
        FOR EACH ROW
        BEGIN
          IF OLD.incident_key IS NOT NULL
             AND NOT (NEW.incident_key <=> OLD.incident_key)
          THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = 'Permanent Incident key is immutable';
          END IF;

          IF OLD.current_stage = 'COORDINATOR_REVIEW'
             AND NEW.current_stage <> 'COORDINATOR_REVIEW'
             AND OLD.incident_key IS NULL
             AND NOT {closed}
          THEN
            IF NEW.event_group_id IS NULL THEN
              SIGNAL SQLSTATE '45000'
                SET MESSAGE_TEXT = 'Coordinator must determine the Event Group before approval';
            END IF;
            SET NEW.incident_key = COALESCE(NEW.incident_key, UUID());
            SET NEW.approved_at = COALESCE(NEW.approved_at, NOW());
            SET NEW.approved_by_user_id = COALESCE(
              NEW.approved_by_user_id,
              NEW.triage_decided_by_user_id,
              NEW.resolved_by_user_id
            );
          END IF;

          /* Assessment-required triage advances current_stage before the legacy
             route writes triage_decided_by_user_id. Backfill actor on that
             second update while preserving the already-minted immutable key. */
          IF NEW.incident_key IS NOT NULL
             AND NEW.approved_by_user_id IS NULL
             AND NEW.triage_decided_by_user_id IS NOT NULL
          THEN
            SET NEW.approved_by_user_id = NEW.triage_decided_by_user_id;
          END IF;

          IF NEW.current_stage <> 'COORDINATOR_REVIEW'
             AND NOT {closed}
             AND (NEW.event_group_id IS NULL OR NEW.incident_key IS NULL)
          THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = 'Incident must be coordinator-approved and grouped before leaving coordinator review';
          END IF;
{closed_check}
          IF NEW.incident_key IS NOT NULL AND NEW.approved_at IS NULL THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = 'Permanent Incident identity requires approval provenance';
          END IF;

          IF NOT (NEW.incident_type <=> OLD.incident_type)
             AND NEW.incident_type IS NOT NULL
             AND NOT EXISTS (
               SELECT 1
               FROM assessments a
               WHERE a.incident_id = NEW.id
                 AND a.state IN ('APPROVED', 'FINALIZED')
             )
          THEN
            SET NEW.incident_type = OLD.incident_type;
          END IF;
        END
        """


def upgrade() -> None:
    bind = op.get_bind()
    op.execute("DROP TRIGGER IF EXISTS trg_incident_identity_bu")
    op.execute(_trigger_sql(triage_can_close_outside_record=True))

    rows = bind.execute(
        text(
            """
            SELECT id, event_group_id, current_stage
            FROM incidents
            WHERE event_group_id IS NOT NULL
              AND (
                (current_stage = 'RESOLVED' AND triage_disposition IN ('NO_ASSESSMENT_REQUIRED', 'DUPLICATE_OR_LINKED'))
                OR (current_stage = 'COORDINATOR_REVIEW' AND incident_key IS NULL)
              )
            """
        )
    ).mappings().all()

    emptied: set[int] = set()
    for row in rows:
        closed = str(row["current_stage"]) == "RESOLVED"
        bind.execute(
            text(
                """
                INSERT INTO event_group_events
                  (event_group_id, incident_id, actor_user_id, event_type, notes, metadata_json, created_at)
                VALUES
                  (:egid, :iid, NULL, 'INCIDENT_MOVED_OUT', :notes, :metadata, NOW())
                """
            ),
            {
                "egid": int(row["event_group_id"]),
                "iid": int(row["id"]),
                "notes": (
                    "Closed at triage, so it is not part of the incident record."
                    if closed
                    else "Not accepted yet: a report joins an Event Group when it is sent for assessment."
                ),
                "metadata": json.dumps({"migration": MIGRATION_MARKER, "to_event_group_id": None}),
            },
        )
        # updated_at is carried over explicitly: the column refreshes itself on
        # UPDATE, and this is housekeeping, not activity on the report.
        bind.execute(
            text("UPDATE incidents SET event_group_id = NULL, updated_at = updated_at WHERE id = :iid"),
            {"iid": int(row["id"])},
        )
        emptied.add(int(row["event_group_id"]))

    for group_id in sorted(emptied):
        archived = bind.execute(
            text(
                """
                UPDATE event_groups eg
                SET eg.status = 'ARCHIVED', eg.updated_at = NOW()
                WHERE eg.id = :egid
                  AND eg.status <> 'ARCHIVED'
                  AND NOT EXISTS (SELECT 1 FROM incidents i WHERE i.event_group_id = eg.id)
                """
            ),
            {"egid": group_id},
        )
        if archived.rowcount:
            bind.execute(
                text(
                    """
                    INSERT INTO event_group_events
                      (event_group_id, incident_id, actor_user_id, event_type, notes, metadata_json, created_at)
                    VALUES
                      (:egid, NULL, NULL, 'EVENT_GROUP_UPDATED', :notes, :metadata, NOW())
                    """
                ),
                {
                    "egid": group_id,
                    "notes": "Archived: no reports in the incident record remain in this Event Group.",
                    "metadata": json.dumps({"migration": MIGRATION_MARKER, "status": "ARCHIVED"}),
                },
            )


def downgrade() -> None:
    """Restore the old trigger and put back what upgrade moved.

    A report closed at triage AFTER the upgrade has no ERIS number and no Event
    Group; the restored trigger refuses any later UPDATE to such a report until
    it is given both.
    """
    bind = op.get_bind()
    op.execute("DROP TRIGGER IF EXISTS trg_incident_identity_bu")
    op.execute(_trigger_sql(triage_can_close_outside_record=False))

    reopened = bind.execute(
        text(
            """
            SELECT DISTINCT event_group_id
            FROM event_group_events
            WHERE event_type = 'EVENT_GROUP_UPDATED'
              AND JSON_VALUE(metadata_json, '$.migration') = :marker
            """
        ),
        {"marker": MIGRATION_MARKER},
    ).scalars().all()
    for group_id in reopened:
        bind.execute(text("UPDATE event_groups SET status = 'OPEN' WHERE id = :egid AND status = 'ARCHIVED'"), {"egid": int(group_id)})

    moved = bind.execute(
        text(
            """
            SELECT incident_id, event_group_id
            FROM event_group_events
            WHERE event_type = 'INCIDENT_MOVED_OUT'
              AND JSON_VALUE(metadata_json, '$.migration') = :marker
            """
        ),
        {"marker": MIGRATION_MARKER},
    ).mappings().all()
    for row in moved:
        bind.execute(
            text("UPDATE incidents SET event_group_id = :egid, updated_at = updated_at WHERE id = :iid AND event_group_id IS NULL"),
            {"egid": int(row["event_group_id"]), "iid": int(row["incident_id"])},
        )

    bind.execute(
        text("DELETE FROM event_group_events WHERE JSON_VALUE(metadata_json, '$.migration') = :marker"),
        {"marker": MIGRATION_MARKER},
    )
