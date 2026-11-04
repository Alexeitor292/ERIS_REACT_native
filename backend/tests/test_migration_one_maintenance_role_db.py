"""``20261105_one_maintenance_role`` on data shaped like a real server's.

Each case runs the revision inside a transaction that is rolled back, as
``test_migration_org_model`` does. Requires a live MariaDB at head: pytest -m db
"""

from __future__ import annotations

import importlib.util
import json
import uuid
from contextlib import contextmanager
from pathlib import Path

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import text

pytestmark = pytest.mark.db

_RUN = uuid.uuid4().hex[:8]
_PATH = Path(__file__).resolve().parents[1] / "migrations" / "versions" / "20261105_one_maintenance_role.py"


def _load():
    spec = importlib.util.spec_from_file_location("one_maintenance_role", _PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@contextmanager
def before_the_revision():
    """A connection holding the two old roles again, and the revision bound to it."""
    from app.db import engine

    revision = _load()
    connection = engine.connect()
    transaction = connection.begin()
    revision.op = Operations(MigrationContext.configure(connection))
    try:
        connection.execute(text(
            "INSERT INTO roles (name, description) VALUES ('MAINTENANCE_CREW', 'old'), ('MAINTENANCE_COORDINATOR', 'old')"
        ))
        yield connection, revision
    finally:
        transaction.rollback()
        connection.close()


def _person(connection, key: str, role: str | None = None) -> int:
    result = connection.execute(text(
        "INSERT INTO users (email, full_name, password_hash, is_active) VALUES (:e, :n, 'x', 1)"
    ), {"e": f"m-{key}-{_RUN}@example.test", "n": f"Migrated {key}"})
    uid = int(result.lastrowid)
    if role:
        connection.execute(text(
            "INSERT INTO user_roles (user_id, role_id) SELECT :u, id FROM roles WHERE name = :r"
        ), {"u": uid, "r": role})
    return uid


def _roles(connection, uid: int) -> set[str]:
    return set(connection.execute(text(
        "SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = :u"
    ), {"u": uid}).scalars())


def _free_district(connection) -> str:
    taken = set(connection.execute(text("SELECT TRIM(district) FROM maintenance_workflows")).scalars())
    return next(f"{n:02d}" for n in range(12, 0, -1) if f"{n:02d}" not in taken)


def _on_lists(connection, district: str, coordinator: int | None, crew: int | None) -> None:
    if coordinator:
        connection.execute(text(
            "INSERT INTO org_coordinator_coverage (district, user_id, is_primary, is_active) VALUES (:d, :u, 1, 1)"
        ), {"d": district, "u": coordinator})
    if crew:
        connection.execute(text(
            "INSERT INTO org_district_crew (district, user_id, is_active) VALUES (:d, :u, 1)"
        ), {"d": district, "u": crew})


def _waiting_report(connection, district: str, reporter: int, status: str = "PENDING_REVIEW") -> int:
    result = connection.execute(text(
        "INSERT INTO incidents (title, incident_type, description, first_observed_at, latitude, longitude, district, "
        "county, route, post_mile, current_stage, location_match_status, reporter_user_id) "
        "VALUES ('Waiting', 'ROCK_FALL', 'x', NOW(), 37.5, -122.0, :d, 'ALA', '84', '5.20', 'COORDINATOR_REVIEW', :s, :u)"
    ), {"d": district, "s": status, "u": reporter})
    return int(result.lastrowid)


def _district_definition(connection, district: str) -> dict:
    return json.loads(connection.execute(text(
        "SELECT definition_json FROM maintenance_workflows WHERE district = :d"
    ), {"d": district}).scalar())


def test_a_district_on_the_old_lists_gets_a_workflow_and_keeps_its_people(client_db):
    with before_the_revision() as (connection, revision):
        district = _free_district(connection)
        coordinator = _person(connection, "coordinator", "MAINTENANCE_COORDINATOR")
        crew = _person(connection, "crew", "MAINTENANCE_CREW")
        _on_lists(connection, district, coordinator, crew)

        revision.upgrade()

        definition = _district_definition(connection, district)
        duties = {duty["id"]: duty for duty in definition["duties"]}
        assert duties["reporters"]["user_ids"] == [crew] and duties["reporters"]["report"] is True
        assert duties["decision"]["user_ids"] == [coordinator]
        assert definition["manager_user_ids"] == [coordinator]
        assert _roles(connection, coordinator) == {"MAINTENANCE"}
        assert _roles(connection, crew) == {"MAINTENANCE"}
        assert not connection.execute(text(
            "SELECT 1 FROM roles WHERE name IN ('MAINTENANCE_CREW', 'MAINTENANCE_COORDINATOR')"
        )).scalar()
        for table in ("org_coordinator_coverage", "org_district_crew"):
            assert not connection.execute(text(f"SELECT 1 FROM {table} WHERE is_active = 1 LIMIT 1")).scalar()


def test_the_starter_workflow_is_one_the_server_would_publish(client_db):
    from app.services.maintenance_workflows import Definition

    with before_the_revision() as (connection, revision):
        district = _free_district(connection)
        coordinator = _person(connection, "valid", "MAINTENANCE_COORDINATOR")
        _on_lists(connection, district, coordinator, None)
        revision.upgrade()
        definition = _district_definition(connection, district)
        # Nobody on the crew list: the coordinators report as well as decide.
        assert definition["duties"][0]["user_ids"] == [coordinator]
        Definition.model_validate(definition)


def test_a_report_waiting_on_a_coordinator_waits_at_the_final_decision(client_db):
    with before_the_revision() as (connection, revision):
        district = _free_district(connection)
        coordinator = _person(connection, "decider", "MAINTENANCE_COORDINATOR")
        crew = _person(connection, "reporter", "MAINTENANCE_CREW")
        _on_lists(connection, district, coordinator, crew)
        waiting = _waiting_report(connection, district, crew)
        returned = _waiting_report(connection, district, crew, "NEEDS_REVISION")

        revision.upgrade()

        rows = {row["incident_id"]: row for row in connection.execute(text(
            "SELECT incident_id, district, state_json FROM maintenance_workflow_runs WHERE incident_id IN (:a, :b)"
        ), {"a": waiting, "b": returned}).mappings()}
        assert json.loads(rows[waiting]["state_json"]) == {"step_index": 0, "approved_user_ids": [], "waiting_reporter": False}
        assert json.loads(rows[returned]["state_json"])["waiting_reporter"] is True


def test_someone_in_no_workflow_is_left_a_guest_and_an_existing_workflow_is_untouched(client_db):
    with before_the_revision() as (connection, revision):
        leaver = _person(connection, "leaver", "MAINTENANCE_CREW")
        kept = {row["district"]: row["definition_json"] for row in connection.execute(text(
            "SELECT district, definition_json FROM maintenance_workflows"
        )).mappings()}

        revision.upgrade()

        assert _roles(connection, leaver) == {"GUEST"}
        for district, definition in kept.items():
            assert connection.execute(text(
                "SELECT definition_json FROM maintenance_workflows WHERE district = :d"
            ), {"d": district}).scalar() == definition


def test_downgrade_brings_the_old_roles_back(client_db):
    with before_the_revision() as (connection, revision):
        district = _free_district(connection)
        crew = _person(connection, "back", "MAINTENANCE_CREW")
        _on_lists(connection, district, crew, crew)
        revision.upgrade()
        assert _roles(connection, crew) == {"MAINTENANCE"}
        revision.downgrade()
        assert _roles(connection, crew) == {"MAINTENANCE_CREW"}
