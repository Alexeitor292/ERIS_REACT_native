"""Seven roles, one code each: retire every legacy and alias role code.

Revision ID: 20260923_roles_consolidated
Revises: 20260922_triage_close_ungrouped
Create Date: 2026-09-23

The owner's role set (2026-09-22): Maintenance Crew, Maintenance Coordinator,
Office Chief, Branch Chief, Senior Specialist, Staff and Guest — plus the
Administrator, which is not a workflow role. Until now most of these existed
twice (a canonical code and a legacy alias, matched by app/roles.py) and some
three times; the application now accepts exactly one code per role.

    old code(s)                                  new code
    MAINTENANCE, MAINTENANCE_FIELD_WORKER    ->  MAINTENANCE_CREW
    MAINT_COORDINATOR                        ->  MAINTENANCE_COORDINATOR
    GEOTECH_OFFICE_CHIEF                     ->  OFFICE_CHIEF
    GEOTECH_BRANCH_CHIEF                     ->  BRANCH_CHIEF
    GEOTECH_SENIOR_ENGINEER                  ->  SENIOR_SPECIALIST
    GEOTECH_ENGINEER, FIELD_WORKER           ->  STAFF
    CALTRANS_VIEWER                          ->  GUEST
    REVIEWER                                 ->  GUEST, for an account left
                                                 with no other role; otherwise
                                                 simply dropped (it conferred
                                                 no authority since routing v2)

Every grant an account held is copied to ``role_consolidation_audit`` before
the old roles are deleted, so the change can be traced and the downgrade can
put back exactly what was there.

Also moved onto the new codes:
  * ``org_classifications.eris_role`` — the role an org position class suggests;
  * the six assignment-eligibility triggers, whose role lists name the codes
    directly (20260910_routing_v2 wrote them). Each trigger is re-created in
    place, in its original order on its table, with only the role list and the
    error message changed.

Idempotent: on a fresh install the seed already holds the new codes and the
older migrations add a few old ones, which this maps and removes the same way.
"""

from alembic import op
from sqlalchemy import text

revision = "20260923_roles_consolidated"
down_revision = "20260922_triage_close_ungrouped"
branch_labels = None
depends_on = None

NEW_ROLES: dict[str, str] = {
    "MAINTENANCE_CREW": "Maintenance Crew: files field reports and follows their own",
    "MAINTENANCE_COORDINATOR": "Maintenance Coordinator: triages field reports for their district",
    "OFFICE_CHIEF": "Office Chief: routes their GeoTech office's assessments and reviews the Senior Specialist route",
    "BRANCH_CHIEF": "Branch Chief: assigns Staff and reviews the branch route",
    "SENIOR_SPECIALIST": "Senior Specialist: fills assessments the office chief assigns directly",
    "STAFF": "Staff: fills the assessments a branch chief assigns",
    "GUEST": "Guest: read-only access to approved records",
    "ADMIN": "Administrator: accounts, organization and configuration",
}

ROLE_MAP: dict[str, str] = {
    "MAINTENANCE": "MAINTENANCE_CREW",
    "MAINTENANCE_FIELD_WORKER": "MAINTENANCE_CREW",
    "MAINT_COORDINATOR": "MAINTENANCE_COORDINATOR",
    "GEOTECH_OFFICE_CHIEF": "OFFICE_CHIEF",
    "GEOTECH_BRANCH_CHIEF": "BRANCH_CHIEF",
    "GEOTECH_SENIOR_ENGINEER": "SENIOR_SPECIALIST",
    "GEOTECH_ENGINEER": "STAFF",
    "FIELD_WORKER": "STAFF",
    "CALTRANS_VIEWER": "GUEST",
}
RETIRED = sorted(set(ROLE_MAP) | {"REVIEWER"})

# The downgrade's way back: each new code to the code the previous release
# treated as canonical (it still accepted OFFICE_CHIEF, BRANCH_CHIEF and
# MAINTENANCE_COORDINATOR as they are).
REVERSE_MAP: dict[str, str] = {
    "MAINTENANCE_CREW": "MAINTENANCE_FIELD_WORKER",
    "SENIOR_SPECIALIST": "GEOTECH_SENIOR_ENGINEER",
    "STAFF": "GEOTECH_ENGINEER",
    "GUEST": "CALTRANS_VIEWER",
}
OLD_DESCRIPTIONS: dict[str, str] = {
    "FIELD_WORKER": "Can create and submit field reports",
    "MAINTENANCE": "Can create maintenance incident reports",
    "MAINT_COORDINATOR": "Can triage maintenance incidents and forward to office chiefs",
    "REVIEWER": "Can review submitted reports",
    "MAINTENANCE_FIELD_WORKER": "Maintenance field worker: creates and follows own incident reports",
    "GEOTECH_OFFICE_CHIEF": "GeoTech office chief: delegates assessments to branch chiefs",
    "GEOTECH_BRANCH_CHIEF": "GeoTech branch chief: assigns Staff to assessments",
    "GEOTECH_ENGINEER": "GeoTech Staff: completes assessments / technical form",
    "GEOTECH_SENIOR_ENGINEER": "GeoTech senior engineer: fills assessments assigned directly by the office chief",
    "CALTRANS_VIEWER": "Viewer: read-only access to approved records",
}

# The two role lists and messages 20260910_routing_v2 wrote into the triggers.
TRIGGER_REWRITES: list[tuple[str, str]] = [
    ("('GEOTECH_ENGINEER','FIELD_WORKER','ADMIN')", "('STAFF','ADMIN')"),
    ("('GEOTECH_SENIOR_ENGINEER','ADMIN')", "('SENIOR_SPECIALIST','ADMIN')"),
    ("must be an active GeoTech engineer or admin", "must be an active Staff member or administrator"),
    ("must be an active GeoTech senior engineer or admin", "must be an active Senior Specialist or administrator"),
]


def _rewrite_triggers(bind, rewrites: list[tuple[str, str]]) -> None:
    """Re-create every trigger whose body contains an ``old`` string.

    A table's triggers for one timing and event run in ACTION_ORDER, and
    ``trg_assessment_no_new_finalize`` FOLLOWS an eligibility trigger — so the
    whole group is dropped and re-created in its original order, not just the
    trigger being rewritten.
    """
    rows = bind.execute(
        text(
            """
            SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION,
                   ACTION_ORDER, ACTION_STATEMENT
              FROM information_schema.TRIGGERS
             WHERE TRIGGER_SCHEMA = DATABASE()
             ORDER BY EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION, ACTION_ORDER
            """
        )
    ).mappings().all()
    groups: dict[tuple[str, str, str], list[dict]] = {}
    for row in rows:
        groups.setdefault((row["EVENT_OBJECT_TABLE"], row["ACTION_TIMING"], row["EVENT_MANIPULATION"]), []).append(dict(row))
    for (table, timing, event), members in groups.items():
        if not any(old in m["ACTION_STATEMENT"] for m in members for old, _ in rewrites):
            continue
        for member in members:
            op.execute(f"DROP TRIGGER IF EXISTS {member['TRIGGER_NAME']}")
        for member in members:
            body = member["ACTION_STATEMENT"]
            for old, new in rewrites:
                body = body.replace(old, new)
            op.execute(f"CREATE TRIGGER {member['TRIGGER_NAME']} {timing} {event} ON {table} FOR EACH ROW {body}")


def upgrade() -> None:
    bind = op.get_bind()

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS role_consolidation_audit (
          user_id BIGINT NOT NULL,
          old_role VARCHAR(64) NOT NULL,
          assigned_at DATETIME NULL,
          recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (user_id, old_role)
        ) ENGINE=InnoDB
        """
    )

    for name, description in NEW_ROLES.items():
        bind.execute(
            text("INSERT INTO roles (name, description) VALUES (:n, :d) ON DUPLICATE KEY UPDATE description = VALUES(description)"),
            {"n": name, "d": description},
        )

    retired_params = {f"r{i}": name for i, name in enumerate(RETIRED)}
    retired_sql = ", ".join(f":r{i}" for i in range(len(RETIRED)))
    bind.execute(
        text(
            f"""
            INSERT IGNORE INTO role_consolidation_audit (user_id, old_role, assigned_at)
            SELECT ur.user_id, r.name, ur.assigned_at
              FROM user_roles ur JOIN roles r ON r.id = ur.role_id
             WHERE r.name IN ({retired_sql})
            """
        ),
        retired_params,
    )

    for old, new in ROLE_MAP.items():
        bind.execute(
            text(
                """
                INSERT IGNORE INTO user_roles (user_id, role_id, assigned_at)
                SELECT ur.user_id, nr.id, ur.assigned_at
                  FROM user_roles ur
                  JOIN roles o ON o.id = ur.role_id AND o.name = :old
                  JOIN roles nr ON nr.name = :new
                """
            ),
            {"old": old, "new": new},
        )

    new_params = {f"n{i}": name for i, name in enumerate(NEW_ROLES)}
    new_sql = ", ".join(f":n{i}" for i in range(len(NEW_ROLES)))
    bind.execute(
        text(
            f"""
            INSERT IGNORE INTO user_roles (user_id, role_id, assigned_at)
            SELECT ur.user_id, g.id, ur.assigned_at
              FROM user_roles ur
              JOIN roles r ON r.id = ur.role_id AND r.name = 'REVIEWER'
              JOIN roles g ON g.name = 'GUEST'
             WHERE NOT EXISTS (
               SELECT 1 FROM user_roles other
                 JOIN roles o ON o.id = other.role_id
                WHERE other.user_id = ur.user_id AND o.name IN ({new_sql})
             )
            """
        ),
        new_params,
    )

    # user_roles rows go with their role (ON DELETE CASCADE).
    bind.execute(text(f"DELETE FROM roles WHERE name IN ({retired_sql})"), retired_params)

    if bind.execute(text("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'org_classifications'")).scalar():
        for old, new in ROLE_MAP.items():
            bind.execute(text("UPDATE org_classifications SET eris_role = :new WHERE eris_role = :old"), {"old": old, "new": new})
        bind.execute(text("UPDATE org_classifications SET eris_role = NULL WHERE eris_role = 'REVIEWER'"))

    _rewrite_triggers(bind, TRIGGER_REWRITES)


def downgrade() -> None:
    bind = op.get_bind()
    _rewrite_triggers(bind, [(new, old) for old, new in TRIGGER_REWRITES])

    for name, description in OLD_DESCRIPTIONS.items():
        bind.execute(
            text("INSERT INTO roles (name, description) VALUES (:n, :d) ON DUPLICATE KEY UPDATE description = VALUES(description)"),
            {"n": name, "d": description},
        )

    # Grants made since the upgrade move to the previous canonical code...
    for new, old in REVERSE_MAP.items():
        bind.execute(
            text(
                """
                INSERT IGNORE INTO user_roles (user_id, role_id, assigned_at)
                SELECT ur.user_id, o.id, ur.assigned_at
                  FROM user_roles ur
                  JOIN roles nr ON nr.id = ur.role_id AND nr.name = :new
                  JOIN roles o ON o.name = :old
                """
            ),
            {"new": new, "old": old},
        )
    # ...and every grant held before it comes back exactly.
    bind.execute(
        text(
            """
            INSERT IGNORE INTO user_roles (user_id, role_id, assigned_at)
            SELECT a.user_id, r.id, COALESCE(a.assigned_at, NOW())
              FROM role_consolidation_audit a
              JOIN roles r ON r.name = a.old_role
              JOIN users u ON u.id = a.user_id
            """
        )
    )
    # GUEST was also given to former REVIEWER-only accounts; the audit restored
    # their REVIEWER, and CALTRANS_VIEWER replaces GUEST for everyone else.
    names = list(REVERSE_MAP)
    bind.execute(
        text(f"DELETE FROM roles WHERE name IN ({', '.join(f':x{i}' for i in range(len(names)))})"),
        {f"x{i}": name for i, name in enumerate(names)},
    )
    bind.execute(text("UPDATE roles SET description = 'Can route incidents to branch chiefs' WHERE name = 'OFFICE_CHIEF'"))
    bind.execute(text("UPDATE roles SET description = 'Can assign incidents to Staff' WHERE name = 'BRANCH_CHIEF'"))

    if bind.execute(text("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'org_classifications'")).scalar():
        for new, old in REVERSE_MAP.items():
            bind.execute(text("UPDATE org_classifications SET eris_role = :old WHERE eris_role = :new"), {"old": old, "new": new})
        bind.execute(text("UPDATE org_classifications SET eris_role = 'GEOTECH_OFFICE_CHIEF' WHERE eris_role = 'OFFICE_CHIEF'"))
        bind.execute(text("UPDATE org_classifications SET eris_role = 'GEOTECH_BRANCH_CHIEF' WHERE eris_role = 'BRANCH_CHIEF'"))

    op.execute("DROP TABLE IF EXISTS role_consolidation_audit")
