"""Adversarial regressions for dynamic SQL reviewed in the handoff audit.

These exercise the real builders at their database boundary. SQL-looking input
must remain bound data; client-supplied object keys must never become identifiers.
"""

from importlib import import_module

import pytest
from fastapi import HTTPException
from sqlalchemy.dialects import mysql


PAYLOADS = (
    "' OR 1=1 --",
    "'; DROP TABLE users; --",
    "\\' UNION SELECT password_hash FROM users #",
)


class CaptureDatabase:
    def __init__(self):
        self.calls = []

    def execute(self, statement, params):
        self.calls.append((statement, dict(params)))
        return self

    def mappings(self):
        return self

    def all(self):
        return []


@pytest.mark.parametrize("payload", PAYLOADS)
@pytest.mark.parametrize("route", ("projects", "event_groups", "terrain_cross_sections"))
def test_search_values_remain_bound_at_mysql_boundary(route, payload):
    module = import_module(f"app.routes.{route}")
    db = CaptureDatabase()
    if route == "terrain_cross_sections":
        result = module.list_cross_section_projects(
            q=payload, status_filter="ACTIVE", limit=20, db=db, _user={"id": 1}
        )
    else:
        function = module.list_projects if route == "projects" else module.list_event_groups
        result = function(status="OPEN", q=payload, limit=20, db=db, _user={"id": 1})
    assert result == {"items": []}
    assert len(db.calls) == 1
    statement, params = db.calls[0]
    compiled = str(statement.compile(dialect=mysql.dialect()))
    assert payload not in compiled
    assert params["q"] == f"%{payload}%"
    assert "LIKE %s" in compiled


@pytest.mark.parametrize("payload", PAYLOADS)
@pytest.mark.parametrize("route", ("projects", "event_groups"))
def test_invalid_status_cannot_introduce_a_sql_clause(route, payload):
    module = import_module(f"app.routes.{route}")
    function = module.list_projects if route == "projects" else module.list_event_groups
    db = CaptureDatabase()
    with pytest.raises(HTTPException) as caught:
        function(status=payload, q=None, limit=20, db=db, _user={"id": 1})
    assert caught.value.status_code == 400
    assert db.calls == []


@pytest.mark.parametrize("key", ("label = NULL; DROP TABLE users; --", "id", "submission_id"))
def test_crack_write_rejects_unapproved_column_names(key):
    from app.routes.cracks import normalize_fields

    with pytest.raises(HTTPException) as caught:
        normalize_fields({key: "injected"})
    assert caught.value.status_code == 422


def test_gisa_schema_does_not_forward_client_identifiers():
    from app.schemas.common import GisaDraftPatch

    fields = GisaDraftPatch.model_validate(
        {"county": PAYLOADS[1], "county = NULL; DROP TABLE users; --": "injected", "revision": 500}
    ).model_dump(exclude_unset=True)
    assert fields == {"county": PAYLOADS[1]}
