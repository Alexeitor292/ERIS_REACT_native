"""Assessment routing v2: senior-specialist route, route discriminator, email outbox.

Revision ID: 20260910_routing_v2
Revises: 20260904_assessment_subs
Create Date: 2026-09-10

Routing v2 gives the GeoTech office chief exactly two mutually exclusive
choices when an assessment lands with them: hand off to a branch chief (who
assigns a GeoTech engineer and reviews the result), or assign a GeoTech Senior
Specialist directly (who fills the form and reports back to the office chief).
Approval ends the assessment; ``FINALIZED`` becomes history-only.

This revision is additive and idempotent (the clean base->head CI job re-runs
it) and creates no new table:

  1. the ``GEOTECH_SENIOR_SPECIALIST`` role row (the upgrade path;
     ``database/init/020_seed.sql`` is the fresh-install path — the migration
     never seeds users, because the clean base->head CI job never loads the
     seed);
  2. ``assessments.routing_path`` — the route discriminator (design §3.2);
  3. ``assessment_assignments.assignment_role`` widened to VARCHAR(24) BEFORE
     the CHECK that admits ``SENIOR_SPECIALIST`` (design §7.2 step 3);
  4. the email outbox columns on ``incident_notifications`` (design §6.3);
  5. the six engineer-eligibility triggers re-created route-aware and the new
     ``trg_assessment_no_new_finalize`` guard (design §7.3);
  6. the backfill that gives every non-terminal assessment exactly one
     identifiable reviewer, or refuses to complete (design §7.4).

NOT TOUCHED, deliberately (design §3.1, §3.4, §7.3) — do not "clean these up":
  * ``chk_assessment_state`` (0008_assessment_domain.py:147-155). No state code
    is added, removed or renamed, so every existing row stays valid and
    ``?state=FINALIZED`` still filters history.
  * ``chk_incidents_stage`` / ``chk_inc_assign_stage`` /
    ``chk_inc_route_assignment_type`` (database/init/010_schema.sql:232-233,
    274-277, 292-293). The senior-specialist route reuses incident stage
    ``ENGINEER`` and transition ``ENGINEER_ASSIGNED``; specialists are resolved
    from ``user_roles`` + ``metadata_json`` like every other routing lookup,
    not from the decorative ``incident_routing_assignments`` table.
  * ``chk_inc_notify_channel`` — it already permits ``EMAIL``.
  * ``trg_incident_identity_bu``
    (20260818_event_group_approval_provenance.py:75-85). Its
    ``state IN ('APPROVED','FINALIZED')`` predicate stays correct: v2 stops at
    ``APPROVED``, which that list already accepts.
  * ``_OFFICIAL_STATES`` / ``_CONFIRMED_STATES`` in incident_classification.py
    already accept ``APPROVED``, so a v2 approved assessment classifies exactly
    as a finalized one did.
"""

from alembic import op
from sqlalchemy import text

revision = "20260910_routing_v2"
down_revision = "20260904_assessment_subs"
branch_labels = None
depends_on = None


# --------------------------------------------------------------------------
# Eligibility predicates (design §7.3)
# --------------------------------------------------------------------------
# The engineer role list and the engineer message text are copied verbatim from
# 20260817_engineer_assignment_eligibility.py — that file is never edited (it is
# already applied on dev, CI and Proxmox) and backend/tests/test_db_smoke.py
# asserts on 'active GeoTech engineer or admin'.
_ENGINEER_ROLE_SQL = "('GEOTECH_ENGINEER','FIELD_WORKER','ADMIN')"
_SPECIALIST_ROLE_SQL = "('GEOTECH_SENIOR_SPECIALIST','ADMIN')"

_ENGINEER_INCIDENT_MSG = "Engineer assignment target must be an active GeoTech engineer or admin"
_ENGINEER_ASSESSMENT_MSG = "Assessment engineer target must be an active GeoTech engineer or admin"
_SPECIALIST_MSG = "Senior specialist assignment target must be an active GeoTech senior specialist or admin"


def _eligible(user_expr: str, role_sql: str) -> str:
    return f"""
      EXISTS (
        SELECT 1
        FROM users u
        JOIN user_roles ur ON ur.user_id = u.id
        JOIN roles r ON r.id = ur.role_id
        WHERE u.id = {user_expr}
          AND u.is_active = 1
          AND r.name IN {role_sql}
      )
    """


def _engineer_eligible(user_expr: str) -> str:
    return _eligible(user_expr, _ENGINEER_ROLE_SQL)


def _specialist_eligible(user_expr: str) -> str:
    return _eligible(user_expr, _SPECIALIST_ROLE_SQL)


# The original (pre-v2) predicate, used by downgrade() to restore the six
# triggers exactly as 20260817_engineer_assignment_eligibility.py wrote them.
def _legacy_eligibility_predicate(user_expr: str) -> str:
    return _eligible(user_expr, _ENGINEER_ROLE_SQL)


# --------------------------------------------------------------------------
# Upgrade
# --------------------------------------------------------------------------


def upgrade() -> None:
    # ---- 1. Role row (design §7.2 step 1) --------------------------------
    op.execute(
        """
        INSERT INTO roles (name, description) VALUES
          ('GEOTECH_SENIOR_SPECIALIST',
           'GeoTech senior specialist: fills assessments assigned directly by the office chief')
        ON DUPLICATE KEY UPDATE description = VALUES(description)
        """
    )

    # ---- 2. Route discriminator (design §3.2, §7.2 step 2) ---------------
    # NULL means "not yet chosen" — the honest state of a fresh assessment. It
    # is not spelled 'UNDECIDED' because a magic string would have to be
    # filtered out of every query.
    op.execute(
        """
        ALTER TABLE assessments
          ADD COLUMN IF NOT EXISTS routing_path VARCHAR(24) NULL AFTER office_override_reason
        """
    )
    # MariaDB has no transactional DDL, so each DROP CONSTRAINT is paired with
    # its ADD CONSTRAINT in one batch and the revision stays re-runnable if it
    # dies between them (docs/MIGRATIONS.md).
    op.execute("ALTER TABLE assessments DROP CONSTRAINT IF EXISTS chk_assessment_routing_path")
    op.execute(
        """
        ALTER TABLE assessments
          ADD CONSTRAINT chk_assessment_routing_path
          CHECK (routing_path IS NULL OR routing_path IN ('BRANCH','SENIOR_SPECIALIST'))
        """
    )
    op.execute(
        """
        ALTER TABLE assessments
          ADD INDEX IF NOT EXISTS idx_assessment_routing (routing_path, state)
        """
    )

    # ---- 3. Assignment role vocabulary (design §7.2 step 3) --------------
    # The column is VARCHAR(16) (0008_assessment_domain.py:174) and
    # 'SENIOR_SPECIALIST' is 17 characters, so the widening MUST come first: in
    # strict mode the first specialist assignment would raise 'Data too long for
    # column', and without strict mode it would truncate to 'SENIOR_SPECIALIS'
    # and then fail the new CHECK. assessment_assignments is created only by
    # migration 0008 (it is absent from database/init/010_schema.sql), so there
    # is no second definition to keep in step. MODIFY COLUMN to the same width
    # is a no-op, so the step is re-runnable as a unit.
    op.execute("ALTER TABLE assessment_assignments MODIFY COLUMN assignment_role VARCHAR(24) NOT NULL")
    op.execute("ALTER TABLE assessment_assignments DROP CONSTRAINT IF EXISTS chk_assessment_assign_role")
    op.execute(
        """
        ALTER TABLE assessment_assignments
          ADD CONSTRAINT chk_assessment_assign_role
          CHECK (assignment_role IN ('ENGINEER','SENIOR_SPECIALIST','REVIEWER','APPROVER','CONSULTED'))
        """
    )

    # ---- 4. Email outbox support (design §6.3, §7.2 step 4) --------------
    # last_attempt_at is new because incident_notifications has NO updated_at
    # (database/init/010_schema.sql:296-312 is exactly id, incident_id,
    # recipient_user_id, channel, template_code, payload_json, delivered_at,
    # created_at) and the retry back-off min(2 ** attempts, 60) minutes had no
    # timestamp to read. It is in the index because the sweeper filters on it
    # after channel/delivered_at.
    op.execute(
        """
        ALTER TABLE incident_notifications
          ADD COLUMN IF NOT EXISTS delivery_attempts INT NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS last_error VARCHAR(255) NULL,
          ADD COLUMN IF NOT EXISTS last_attempt_at DATETIME NULL,
          ADD INDEX IF NOT EXISTS idx_inc_notify_outbox (channel, delivered_at, last_attempt_at, id)
        """
    )

    # ---- 5. Route-aware eligibility triggers (design §7.3) ---------------
    # Dropped first so that re-creating trg_assessment_engineer_elig_bu below
    # cannot land after it in BEFORE UPDATE order; it is re-created last, with
    # an explicit FOLLOWS.
    op.execute("DROP TRIGGER IF EXISTS trg_assessment_no_new_finalize")
    _create_route_aware_triggers()

    # ---- 6. trg_assessment_no_new_finalize (design §3.4, §7.3) -----------
    # A MariaDB CHECK is row-level and cannot forbid a *transition*, so the
    # "approval ends the assessment" rule needs a trigger to close the legacy
    # endpoints and direct SQL too. Already-FINALIZED rows still update freely.
    #
    # FOLLOWS trg_assessment_engineer_elig_bu: MariaDB 10.2.4+ permits two
    # BEFORE UPDATE triggers on one table but leaves their order unspecified
    # without FOLLOWS/PRECEDES. Pinning it means an operator always sees the
    # eligibility message first, and the same message every time.
    #
    # This is a one-way door with no in-band escape: if a row is mis-set or a
    # legacy client turns up mid-window, the only repair is
    #   DROP TRIGGER trg_assessment_no_new_finalize;  -- fix the row
    # then re-create it from the body below (see the rollout notes).
    op.execute(
        """
        CREATE TRIGGER trg_assessment_no_new_finalize
        BEFORE UPDATE ON assessments
        FOR EACH ROW FOLLOWS trg_assessment_engineer_elig_bu
        BEGIN
          IF NEW.state = 'FINALIZED' AND OLD.state <> 'FINALIZED' THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = 'Assessment finalization was retired; approval completes the assessment';
          END IF;
        END
        """
    )

    # ---- 7. Backfill (design §7.4) ---------------------------------------
    _backfill_routing_path()


def _create_route_aware_triggers() -> None:
    """Re-create the six eligibility triggers, route-aware.

    The bodies come from 20260817_engineer_assignment_eligibility.py:41-164 with
    a parallel SENIOR_SPECIALIST rule added. That file is never edited — it is
    already applied on dev, CI and Proxmox.
    """
    # -- incident_assignments (stage ENGINEER) -----------------------------
    # The specialist route reuses incident stage ENGINEER, so the incident-level
    # trigger cannot read a role off the row: it consults the incident's
    # assessment instead. Two facts make that sound, and BOTH are load-bearing —
    # a later change to either would silently mis-classify a target:
    #   (a) assign-specialist stamps assessments.routing_path='SENIOR_SPECIALIST'
    #       BEFORE the shared assignment machinery runs (design §3.3 T4), and
    #       _assign_incident (routes/incidents.py) is that machinery's first
    #       write — so the EXISTS below is already true when this trigger fires;
    #   (b) the EXISTS is single-valued only because
    #       UNIQUE KEY uk_assessment_incident (incident_id)
    #       (0008_assessment_domain.py:140) allows at most one assessment per
    #       incident. If ERIS ever allows more than one assessment per incident,
    #       this trigger must be revisited first.
    incident_route_is_specialist = """
      EXISTS (
        SELECT 1 FROM assessments a
        WHERE a.incident_id = NEW.incident_id
          AND a.routing_path = 'SENIOR_SPECIALIST'
      )
    """

    op.execute("DROP TRIGGER IF EXISTS trg_incident_engineer_elig_bi")
    op.execute(
        f"""
        CREATE TRIGGER trg_incident_engineer_elig_bi
        BEFORE INSERT ON incident_assignments
        FOR EACH ROW
        BEGIN
          IF NEW.assignment_stage = 'ENGINEER' AND NEW.is_active = 1 THEN
            IF {incident_route_is_specialist} THEN
              IF NOT ({_specialist_eligible('NEW.assignee_user_id')}) THEN
                SIGNAL SQLSTATE '45000'
                  SET MESSAGE_TEXT = '{_SPECIALIST_MSG}';
              END IF;
            ELSE
              IF NOT ({_engineer_eligible('NEW.assignee_user_id')}) THEN
                SIGNAL SQLSTATE '45000'
                  SET MESSAGE_TEXT = '{_ENGINEER_INCIDENT_MSG}';
              END IF;
            END IF;
          END IF;
        END
        """
    )

    op.execute("DROP TRIGGER IF EXISTS trg_incident_engineer_elig_bu")
    op.execute(
        f"""
        CREATE TRIGGER trg_incident_engineer_elig_bu
        BEFORE UPDATE ON incident_assignments
        FOR EACH ROW
        BEGIN
          IF NEW.assignment_stage = 'ENGINEER'
             AND NEW.is_active = 1
             AND (
               OLD.assignment_stage <> 'ENGINEER'
               OR OLD.is_active <> 1
               OR NOT (NEW.assignee_user_id <=> OLD.assignee_user_id)
             )
          THEN
            IF {incident_route_is_specialist} THEN
              IF NOT ({_specialist_eligible('NEW.assignee_user_id')}) THEN
                SIGNAL SQLSTATE '45000'
                  SET MESSAGE_TEXT = '{_SPECIALIST_MSG}';
              END IF;
            ELSE
              IF NOT ({_engineer_eligible('NEW.assignee_user_id')}) THEN
                SIGNAL SQLSTATE '45000'
                  SET MESSAGE_TEXT = '{_ENGINEER_INCIDENT_MSG}';
              END IF;
            END IF;
          END IF;
        END
        """
    )

    # -- assessment_assignments -------------------------------------------
    # The ENGINEER rule is unchanged; the SENIOR_SPECIALIST rule is parallel.
    op.execute("DROP TRIGGER IF EXISTS trg_assessment_assignment_engineer_elig_bi")
    op.execute(
        f"""
        CREATE TRIGGER trg_assessment_assignment_engineer_elig_bi
        BEFORE INSERT ON assessment_assignments
        FOR EACH ROW
        BEGIN
          IF NEW.assignment_role = 'ENGINEER'
             AND NEW.is_active = 1
             AND NOT ({_engineer_eligible('NEW.user_id')})
          THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = '{_ENGINEER_ASSESSMENT_MSG}';
          END IF;
          IF NEW.assignment_role = 'SENIOR_SPECIALIST'
             AND NEW.is_active = 1
             AND NOT ({_specialist_eligible('NEW.user_id')})
          THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = '{_SPECIALIST_MSG}';
          END IF;
        END
        """
    )

    op.execute("DROP TRIGGER IF EXISTS trg_assessment_assignment_engineer_elig_bu")
    op.execute(
        f"""
        CREATE TRIGGER trg_assessment_assignment_engineer_elig_bu
        BEFORE UPDATE ON assessment_assignments
        FOR EACH ROW
        BEGIN
          IF NEW.assignment_role = 'ENGINEER'
             AND NEW.is_active = 1
             AND (
               OLD.assignment_role <> 'ENGINEER'
               OR OLD.is_active <> 1
               OR NOT (NEW.user_id <=> OLD.user_id)
             )
             AND NOT ({_engineer_eligible('NEW.user_id')})
          THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = '{_ENGINEER_ASSESSMENT_MSG}';
          END IF;
          IF NEW.assignment_role = 'SENIOR_SPECIALIST'
             AND NEW.is_active = 1
             AND (
               OLD.assignment_role <> 'SENIOR_SPECIALIST'
               OR OLD.is_active <> 1
               OR NOT (NEW.user_id <=> OLD.user_id)
             )
             AND NOT ({_specialist_eligible('NEW.user_id')})
          THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = '{_SPECIALIST_MSG}';
          END IF;
        END
        """
    )

    # -- assessments.assigned_engineer_user_id ------------------------------
    # Both routes store the assignee in assigned_engineer_user_id (design §3.2),
    # so routing_path decides which rule applies. A NULL routing_path falls to
    # the engineer rule, which is the pre-v2 behaviour.
    #
    # These fire ONLY when assigned_engineer_user_id actually changes, which is
    # exactly why the §7.4 backfill is non-destructive: a backfilled
    # SENIOR_SPECIALIST-route row still holding a legacy FIELD_WORKER engineer
    # keeps advancing through submit and review untouched.
    op.execute("DROP TRIGGER IF EXISTS trg_assessment_engineer_elig_bi")
    op.execute(
        f"""
        CREATE TRIGGER trg_assessment_engineer_elig_bi
        BEFORE INSERT ON assessments
        FOR EACH ROW
        BEGIN
          IF NEW.assigned_engineer_user_id IS NOT NULL THEN
            IF NEW.routing_path = 'SENIOR_SPECIALIST' THEN
              IF NOT ({_specialist_eligible('NEW.assigned_engineer_user_id')}) THEN
                SIGNAL SQLSTATE '45000'
                  SET MESSAGE_TEXT = '{_SPECIALIST_MSG}';
              END IF;
            ELSE
              IF NOT ({_engineer_eligible('NEW.assigned_engineer_user_id')}) THEN
                SIGNAL SQLSTATE '45000'
                  SET MESSAGE_TEXT = '{_ENGINEER_ASSESSMENT_MSG}';
              END IF;
            END IF;
          END IF;
        END
        """
    )

    op.execute("DROP TRIGGER IF EXISTS trg_assessment_engineer_elig_bu")
    op.execute(
        f"""
        CREATE TRIGGER trg_assessment_engineer_elig_bu
        BEFORE UPDATE ON assessments
        FOR EACH ROW
        BEGIN
          IF NEW.assigned_engineer_user_id IS NOT NULL
             AND NOT (NEW.assigned_engineer_user_id <=> OLD.assigned_engineer_user_id)
          THEN
            IF NEW.routing_path = 'SENIOR_SPECIALIST' THEN
              IF NOT ({_specialist_eligible('NEW.assigned_engineer_user_id')}) THEN
                SIGNAL SQLSTATE '45000'
                  SET MESSAGE_TEXT = '{_SPECIALIST_MSG}';
              END IF;
            ELSE
              IF NOT ({_engineer_eligible('NEW.assigned_engineer_user_id')}) THEN
                SIGNAL SQLSTATE '45000'
                  SET MESSAGE_TEXT = '{_ENGINEER_ASSESSMENT_MSG}';
              END IF;
            END IF;
          END IF;
        END
        """
    )


def _backfill_routing_path() -> None:
    """Give every non-terminal assessment exactly one identifiable reviewer.

    Existing REVIEWER/APPROVER assessment_assignments rows are NOT touched: no
    is_active = 0 sweep, no deletion. They lose authority and become history —
    rewriting an audit trail to change a permission is not acceptable.
    """
    # (a) A recorded branch chief means the branch route — including legacy rows
    #     made with the office chief's engineer shortcut, whose branch chief is
    #     recorded and is the natural reviewer. state='PENDING_ENGINEER_ASSIGNMENT'
    #     is included because a row in that state was, by construction, branch-
    #     routed: only delegate-branch puts an assessment there. Its branch chief
    #     may since have been NULLed by fk_assessment_branch_chief ON DELETE SET
    #     NULL (0008_assessment_domain.py:133-134); without this clause backfill
    #     (b) would stamp it SENIOR_SPECIALIST and it would then be refused by
    #     delegate-branch (specialist route), assign-engineer (not BRANCH) and
    #     assign-specialist alike. Stamped BRANCH it is repairable in the
    #     product: re-delegation names a new branch chief from
    #     PENDING_ENGINEER_ASSIGNMENT with routing_path IN (NULL,'BRANCH').
    op.execute(
        """
        UPDATE assessments SET routing_path = 'BRANCH'
         WHERE routing_path IS NULL
           AND (branch_chief_user_id IS NOT NULL OR state = 'PENDING_ENGINEER_ASSIGNMENT')
        """
    )

    # (b) Orphans: past office delegation with no branch chief (legacy
    #     /incidents endpoints, or an admin assign-engineer straight from
    #     PENDING_OFFICE_DELEGATION). Only an office chief can review these, so
    #     the specialist route is the only path that leaves them approvable.
    op.execute(
        """
        UPDATE assessments SET routing_path = 'SENIOR_SPECIALIST'
         WHERE routing_path IS NULL
           AND state <> 'PENDING_OFFICE_DELEGATION'
           AND branch_chief_user_id IS NULL
           AND office_code IS NOT NULL AND office_code <> ''
        """
    )

    # (c) Rows still PENDING_OFFICE_DELEGATION keep routing_path NULL: the chief
    #     has not chosen, and v2 asks them to.

    # The property that matters: after the backfill every non-terminal
    # assessment has exactly one identifiable reviewer, or this migration
    # refuses to complete — so nothing in flight becomes un-approvable.
    # Reporting and continuing would leave rows nobody but admin can act on.
    unroutable = (
        op.get_bind()
        .execute(
            text(
                """
                SELECT id FROM assessments
                 WHERE routing_path IS NULL AND state <> 'PENDING_OFFICE_DELEGATION'
                 ORDER BY id
                """
            )
        )
        .scalars()
        .all()
    )
    if unroutable:
        ids = ", ".join(str(int(x)) for x in unroutable)
        raise RuntimeError(
            f"Routing v2 cannot route {len(unroutable)} assessment(s): id in ({ids}). "
            "Each has no branch chief and no office_code, so no v2 reviewer can be "
            "derived. Repair them first, e.g.\n"
            f"  UPDATE assessments SET office_code = '<office>' WHERE id IN ({ids});\n"
            "(office_code drives the senior-specialist route: an office chief of that "
            "office reviews) or set branch_chief_user_id to the chief who should own "
            "it, then re-run `alembic upgrade head`."
        )


# --------------------------------------------------------------------------
# Downgrade
# --------------------------------------------------------------------------


def downgrade() -> None:
    # Order matters (design §7.6).
    op.execute("DROP TRIGGER IF EXISTS trg_assessment_no_new_finalize")
    _restore_legacy_triggers()

    # Restore the four-value CHECK FIRST. It fails loudly if any
    # SENIOR_SPECIALIST assignment row survives — correctly, since downgrading
    # over specialist assignments is data loss and must not be silent. Only
    # after that CHECK has proved none survive is it safe to narrow the column
    # back: the reverse order would truncate the very rows the CHECK refuses.
    op.execute("ALTER TABLE assessment_assignments DROP CONSTRAINT IF EXISTS chk_assessment_assign_role")
    op.execute(
        """
        ALTER TABLE assessment_assignments
          ADD CONSTRAINT chk_assessment_assign_role
          CHECK (assignment_role IN ('ENGINEER','REVIEWER','APPROVER','CONSULTED'))
        """
    )
    op.execute("ALTER TABLE assessment_assignments MODIFY COLUMN assignment_role VARCHAR(16) NOT NULL")

    op.execute("ALTER TABLE assessments DROP INDEX IF EXISTS idx_assessment_routing")
    op.execute("ALTER TABLE assessments DROP CONSTRAINT IF EXISTS chk_assessment_routing_path")
    op.execute("ALTER TABLE assessments DROP COLUMN IF EXISTS routing_path")

    op.execute("ALTER TABLE incident_notifications DROP INDEX IF EXISTS idx_inc_notify_outbox")
    op.execute("ALTER TABLE incident_notifications DROP COLUMN IF EXISTS last_attempt_at")
    op.execute("ALTER TABLE incident_notifications DROP COLUMN IF EXISTS last_error")
    op.execute("ALTER TABLE incident_notifications DROP COLUMN IF EXISTS delivery_attempts")

    # user_roles rows referencing the role are removed via ON DELETE CASCADE,
    # exactly as 0008_assessment_domain.py:253-261 does for its new roles.
    op.execute("DELETE FROM roles WHERE name = 'GEOTECH_SENIOR_SPECIALIST'")


def _restore_legacy_triggers() -> None:
    """Re-create the six eligibility triggers with the exact pre-v2 bodies from
    20260817_engineer_assignment_eligibility.py."""
    op.execute("DROP TRIGGER IF EXISTS trg_incident_engineer_elig_bi")
    op.execute(
        f"""
        CREATE TRIGGER trg_incident_engineer_elig_bi
        BEFORE INSERT ON incident_assignments
        FOR EACH ROW
        BEGIN
          IF NEW.assignment_stage = 'ENGINEER'
             AND NEW.is_active = 1
             AND NOT ({_legacy_eligibility_predicate('NEW.assignee_user_id')})
          THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = '{_ENGINEER_INCIDENT_MSG}';
          END IF;
        END
        """
    )

    op.execute("DROP TRIGGER IF EXISTS trg_incident_engineer_elig_bu")
    op.execute(
        f"""
        CREATE TRIGGER trg_incident_engineer_elig_bu
        BEFORE UPDATE ON incident_assignments
        FOR EACH ROW
        BEGIN
          IF NEW.assignment_stage = 'ENGINEER'
             AND NEW.is_active = 1
             AND (
               OLD.assignment_stage <> 'ENGINEER'
               OR OLD.is_active <> 1
               OR NOT (NEW.assignee_user_id <=> OLD.assignee_user_id)
             )
             AND NOT ({_legacy_eligibility_predicate('NEW.assignee_user_id')})
          THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = '{_ENGINEER_INCIDENT_MSG}';
          END IF;
        END
        """
    )

    op.execute("DROP TRIGGER IF EXISTS trg_assessment_assignment_engineer_elig_bi")
    op.execute(
        f"""
        CREATE TRIGGER trg_assessment_assignment_engineer_elig_bi
        BEFORE INSERT ON assessment_assignments
        FOR EACH ROW
        BEGIN
          IF NEW.assignment_role = 'ENGINEER'
             AND NEW.is_active = 1
             AND NOT ({_legacy_eligibility_predicate('NEW.user_id')})
          THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = '{_ENGINEER_ASSESSMENT_MSG}';
          END IF;
        END
        """
    )

    op.execute("DROP TRIGGER IF EXISTS trg_assessment_assignment_engineer_elig_bu")
    op.execute(
        f"""
        CREATE TRIGGER trg_assessment_assignment_engineer_elig_bu
        BEFORE UPDATE ON assessment_assignments
        FOR EACH ROW
        BEGIN
          IF NEW.assignment_role = 'ENGINEER'
             AND NEW.is_active = 1
             AND (
               OLD.assignment_role <> 'ENGINEER'
               OR OLD.is_active <> 1
               OR NOT (NEW.user_id <=> OLD.user_id)
             )
             AND NOT ({_legacy_eligibility_predicate('NEW.user_id')})
          THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = '{_ENGINEER_ASSESSMENT_MSG}';
          END IF;
        END
        """
    )

    op.execute("DROP TRIGGER IF EXISTS trg_assessment_engineer_elig_bi")
    op.execute(
        f"""
        CREATE TRIGGER trg_assessment_engineer_elig_bi
        BEFORE INSERT ON assessments
        FOR EACH ROW
        BEGIN
          IF NEW.assigned_engineer_user_id IS NOT NULL
             AND NOT ({_legacy_eligibility_predicate('NEW.assigned_engineer_user_id')})
          THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = '{_ENGINEER_ASSESSMENT_MSG}';
          END IF;
        END
        """
    )

    op.execute("DROP TRIGGER IF EXISTS trg_assessment_engineer_elig_bu")
    op.execute(
        f"""
        CREATE TRIGGER trg_assessment_engineer_elig_bu
        BEFORE UPDATE ON assessments
        FOR EACH ROW
        BEGIN
          IF NEW.assigned_engineer_user_id IS NOT NULL
             AND NOT (NEW.assigned_engineer_user_id <=> OLD.assigned_engineer_user_id)
             AND NOT ({_legacy_eligibility_predicate('NEW.assigned_engineer_user_id')})
          THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = '{_ENGINEER_ASSESSMENT_MSG}';
          END IF;
        END
        """
    )
