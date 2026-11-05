"""One Maintenance role: what someone may do comes from their district's workflow.

The Maintenance Crew and Maintenance Coordinator roles become MAINTENANCE. On its
own that role reads only the person's own reports; everything more comes from what
the district's workflow assigns them. Holding it follows from being in a workflow,
as GeoTech roles follow from a place in an office tree.

So that no district is left without a path, a district with people on its old lists
and no workflow gets one: its crew report (its coordinators, if it had no crew) and
its coordinators decide and manage it. Reports waiting on a coordinator wait at that
workflow's final decision instead. The old list rows stay, inactive, as history.
"""
from __future__ import annotations

import json
import re

import sqlalchemy as sa
from alembic import op

revision = "20261105_one_maintenance_role"
down_revision = "20261104_district_contact"
branch_labels = None
depends_on = None

FINAL_STEP = "Maintenance or GeoTech decision"


def _district(value) -> str | None:
    match = re.search(r"\d+", str(value or ""))
    return f"{int(match.group()):02d}" if match and 1 <= int(match.group()) <= 12 else None


def _definition(reporters: list[int], deciders: list[int]) -> dict:
    def duty(duty_id: str, name: str, users: list[int], **flags) -> dict:
        return {"id": duty_id, "name": name, "user_ids": users, "report": False, "view_district": False,
                "edit_report": False, **flags}

    return {
        "manager_user_ids": deciders,
        "duties": [
            duty("reporters", "Incident reporters", reporters, report=True),
            duty("decision", "Final decision makers", deciders, view_district=True),
        ],
        "steps": [{
            "name": FINAL_STEP, "kind": "DECISION", "duty_ids": ["decision"], "notify_duty_ids": [], "rule": "ANY",
            "request_information": True, "allow_maintenance": True, "allow_geotech": True,
        }],
        "notify_duty_ids": [],
    }


def _participants(definition: dict) -> set[int]:
    users = {int(uid) for uid in definition.get("manager_user_ids", [])}
    for duty in definition.get("duties", []):
        users.update(int(uid) for uid in duty.get("user_ids", []))
    return users


def _parse(value) -> dict:
    return value if isinstance(value, dict) else json.loads(value)


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text(
        "INSERT INTO roles (name, description) SELECT 'MAINTENANCE', "
        "'Maintenance: own reports, plus what their district''s workflow assigns them' "
        "WHERE NOT EXISTS (SELECT 1 FROM roles WHERE name = 'MAINTENANCE')"
    ))
    maintenance = bind.execute(sa.text("SELECT id FROM roles WHERE name = 'MAINTENANCE'")).scalar()

    # Everyone still on a list, by district.
    lists: dict[str, dict[str, list[int]]] = {}
    for table, kind in (("org_coordinator_coverage", "deciders"), ("org_district_crew", "reporters")):
        for row in bind.execute(sa.text(
            f"SELECT t.district, t.user_id FROM {table} t JOIN users u ON u.id = t.user_id "
            "WHERE t.is_active = 1 AND u.is_active = 1 ORDER BY t.user_id"
        )).mappings():
            district = _district(row["district"])
            if district:
                lists.setdefault(district, {"deciders": [], "reporters": []})[kind].append(int(row["user_id"]))

    existing = {row["district"]: _parse(row["definition_json"]) for row in bind.execute(sa.text(
        "SELECT district, definition_json FROM maintenance_workflows"
    )).mappings()}
    for district, people in sorted(lists.items()):
        if district in existing:
            continue
        deciders = people["deciders"] or people["reporters"]
        reporters = people["reporters"] or people["deciders"]
        definition = _definition(reporters, deciders)
        bind.execute(sa.text(
            "INSERT INTO maintenance_workflows (district, revision, definition_json, updated_by_user_id) "
            "VALUES (:d, 1, :p, :u)"
        ), {"d": district, "p": json.dumps(definition), "u": deciders[0]})
        bind.execute(sa.text(
            "INSERT INTO maintenance_workflow_events (district, actor_user_id, action, metadata_json) "
            "VALUES (:d, :u, 'WORKFLOW_PUBLISHED', :m)"
        ), {"d": district, "u": deciders[0], "m": json.dumps({"revision": 1, "definition": definition, "migrated": True})})
        existing[district] = definition

    # Reports waiting on a coordinator now wait at their district's final decision.
    revisions = {row["district"]: row["revision"] for row in bind.execute(sa.text(
        "SELECT district, revision FROM maintenance_workflows"
    )).mappings()}
    for row in bind.execute(sa.text(
        "SELECT i.id, i.district, i.location_match_status FROM incidents i "
        "WHERE i.current_stage = 'COORDINATOR_REVIEW' AND i.status <> 'RESOLVED' "
        "AND NOT EXISTS (SELECT 1 FROM maintenance_workflow_runs r WHERE r.incident_id = i.id)"
    )).mappings().all():
        district = _district(row["district"])
        definition = existing.get(district or "")
        if not definition:
            continue
        state = {"step_index": len(definition["steps"]) - 1, "approved_user_ids": [],
                 "waiting_reporter": str(row["location_match_status"] or "").upper() == "NEEDS_REVISION"}
        bind.execute(sa.text(
            "INSERT INTO maintenance_workflow_runs (incident_id, district, revision, definition_json, state_json, version) "
            "VALUES (:i, :d, :r, :p, :s, 1)"
        ), {"i": row["id"], "d": district, "r": revisions[district], "p": json.dumps(definition), "s": json.dumps(state)})

    # Roles: anyone in a workflow holds MAINTENANCE, and nobody holds the old two.
    in_workflows: set[int] = set()
    for definition in existing.values():
        in_workflows |= _participants(definition)
    for row in bind.execute(sa.text(
        "SELECT definition_json FROM maintenance_workflow_runs WHERE outcome IS NULL"
    )).mappings():
        in_workflows |= _participants(_parse(row["definition_json"]))
    old = [int(x) for x in bind.execute(sa.text(
        "SELECT id FROM roles WHERE name IN ('MAINTENANCE_CREW', 'MAINTENANCE_COORDINATOR')"
    )).scalars()]
    guest = bind.execute(sa.text("SELECT id FROM roles WHERE name = 'GUEST'")).scalar()
    if old:
        holders = [int(x) for x in bind.execute(
            sa.text("SELECT DISTINCT user_id FROM user_roles WHERE role_id IN :ids").bindparams(sa.bindparam("ids", expanding=True)),
            {"ids": old},
        ).scalars()]
        bind.execute(sa.text("DELETE FROM user_roles WHERE role_id IN :ids").bindparams(sa.bindparam("ids", expanding=True)), {"ids": old})
        bind.execute(sa.text("DELETE FROM roles WHERE id IN :ids").bindparams(sa.bindparam("ids", expanding=True)), {"ids": old})
    else:
        holders = []
    active = {int(x) for x in bind.execute(sa.text("SELECT id FROM users")).scalars()}
    for uid in sorted(in_workflows & active):
        bind.execute(sa.text("INSERT IGNORE INTO user_roles (user_id, role_id) VALUES (:u, :r)"), {"u": uid, "r": maintenance})
        if guest is not None:
            bind.execute(sa.text("DELETE FROM user_roles WHERE user_id = :u AND role_id = :r"), {"u": uid, "r": guest})
    # Nobody is left holding nothing: a former holder in no workflow reads as a guest.
    for uid in holders:
        if not bind.execute(sa.text("SELECT 1 FROM user_roles WHERE user_id = :u LIMIT 1"), {"u": uid}).scalar() and guest is not None:
            bind.execute(sa.text("INSERT INTO user_roles (user_id, role_id) VALUES (:u, :r)"), {"u": uid, "r": guest})

    bind.execute(sa.text("UPDATE org_coordinator_coverage SET is_active = 0 WHERE is_active = 1"))
    bind.execute(sa.text("UPDATE org_district_crew SET is_active = 0 WHERE is_active = 1"))


def downgrade() -> None:
    # The workflows and the runs stay; the two old roles come back, and the people
    # holding the new one read as crew, the narrower of the two.
    bind = op.get_bind()
    bind.execute(sa.text(
        "INSERT INTO roles (name, description) VALUES "
        "('MAINTENANCE_CREW', 'Maintenance Crew: files field reports and follows their own'), "
        "('MAINTENANCE_COORDINATOR', 'Maintenance Coordinator: triages field reports for their district')"
    ))
    bind.execute(sa.text(
        "UPDATE user_roles ur JOIN roles r ON r.id = ur.role_id "
        "JOIN roles crew ON crew.name = 'MAINTENANCE_CREW' SET ur.role_id = crew.id WHERE r.name = 'MAINTENANCE'"
    ))
    bind.execute(sa.text("DELETE FROM roles WHERE name = 'MAINTENANCE'"))
