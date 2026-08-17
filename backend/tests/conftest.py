import os
import re
import sys
import uuid
from unittest.mock import patch

import pytest
from sqlalchemy import text
from starlette.testclient import TestClient

# JWT_SECRET has no default in Settings; set a fallback for CI/no-DB runs.
# In CI the no-DB job also sets this as a step-level env var; the setdefault
# here is a belt-and-suspenders guard so pytest can import app.config at all.
# DB_PASS is intentionally NOT defaulted here — local runs read it from
# backend/.env, and CI jobs set it explicitly via their env: block.
os.environ.setdefault("JWT_SECRET", "ci_placeholder_secret")

# Ensure backend/ is on sys.path so `from app.X import Y` resolves correctly
# when pytest is run from the backend/ directory.
_backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _backend_dir not in sys.path:
    sys.path.insert(0, _backend_dir)


@pytest.fixture(autouse=True)
def package_reference_fixture(monkeypatch):
    from app.services import road_inventory_packages as packages

    point = {
        "object_id": 1,
        "district_code": "03",
        "county_code": "PLA",
        "route_name": "80",
        "route_suffix_code": None,
        "pm_route_id": "PLA080",
        "pm_prefix_code": None,
        "postmile": 1.0,
        "pm_suffix_code": None,
        "postmile_compound": "1.0",
        "odometer": 1.0,
        "pm_interval": 0.1,
        "highway_segment": "A",
        "align_code": "C",
        "direction": "E",
        "latitude": 38.8,
        "longitude": -121.2,
    }
    monkeypatch.setattr(packages, "fetch_postmile_reference_points", lambda: [point])


def _ensure_test_project(incident_id: int) -> None:
    """Explicitly satisfy the Project prerequisite for legacy DB test fixtures.

    Older integration tests were written before Project existed and are testing
    downstream routing, assessment, terrain, or package behavior rather than the
    coordinator's Project decision. The production application must never create
    a Project implicitly. This helper is confined to the DB test client and makes
    that prerequisite explicit in test setup without weakening production rules.
    """
    from app.db import engine

    with engine.begin() as conn:
        incident = conn.execute(
            text(
                """
                SELECT
                  id, project_id, location_id, latitude, longitude,
                  district, county, route, post_mile, reporter_user_id,
                  created_at, updated_at
                FROM incidents
                WHERE id = :iid
                LIMIT 1
                """
            ),
            {"iid": incident_id},
        ).mappings().first()
        if not incident or incident["project_id"] is not None:
            return

        result = conn.execute(
            text(
                """
                INSERT INTO projects (
                  project_uuid, title, description, status,
                  anchor_location_id, anchor_latitude, anchor_longitude,
                  district, county, route, post_mile,
                  created_from_incident_id, created_by_user_id, source,
                  created_at, updated_at
                ) VALUES (
                  :uuid, :title, :description, 'OPEN',
                  :location_id, :latitude, :longitude,
                  :district, :county, :route, :post_mile,
                  :iid, :created_by, 'ADMIN_CREATED',
                  :created_at, :updated_at
                )
                """
            ),
            {
                "uuid": str(uuid.uuid4()),
                "title": f"DB test Project for Incident #{incident_id}",
                "description": "Test-only prerequisite for a legacy downstream workflow fixture.",
                "location_id": incident["location_id"],
                "latitude": incident["latitude"],
                "longitude": incident["longitude"],
                "district": incident["district"],
                "county": incident["county"],
                "route": incident["route"],
                "post_mile": incident["post_mile"],
                "iid": incident_id,
                "created_by": int(incident["reporter_user_id"]),
                "created_at": incident["created_at"],
                "updated_at": incident["updated_at"],
            },
        )
        project_id = int(result.lastrowid)
        conn.execute(
            text("UPDATE incidents SET project_id = :pid WHERE id = :iid"),
            {"pid": project_id, "iid": incident_id},
        )
        conn.execute(
            text(
                """
                INSERT INTO project_events
                  (project_id, incident_id, actor_user_id, event_type, notes, metadata_json)
                VALUES
                  (:pid, :iid, :actor, 'PROJECT_CREATED', :notes,
                   JSON_OBJECT('test_fixture', TRUE))
                """
            ),
            {
                "pid": project_id,
                "iid": incident_id,
                "actor": int(incident["reporter_user_id"]),
                "notes": "DB test fixture explicitly satisfied the Project prerequisite.",
            },
        )


def _install_project_aware_db_client(client: TestClient) -> None:
    """Modernize pre-Project DB tests at the shared client boundary.

    Tests that specifically need a projectless Incident can set the internal
    `X-ERIS-Test-Preserve-Projectless: 1` header. The adapter strips that header
    before the request reaches FastAPI.
    """
    raw_post = client.post
    advancement = re.compile(r"^/incidents/(\d+)/(?:triage|coordinator/forward|assign)$")

    def project_aware_post(url, *args, **kwargs):
        url_text = str(url)
        headers = dict(kwargs.get("headers") or {})
        preserve_projectless = headers.pop("X-ERIS-Test-Preserve-Projectless", None) is not None
        if headers or "headers" in kwargs:
            kwargs["headers"] = headers

        match = advancement.match(url_text.split("?", 1)[0])
        if match and not preserve_projectless:
            payload = kwargs.get("json") or {}
            # Reporter-information correction stays in COORDINATOR_REVIEW and is
            # intentionally allowed before the coordinator chooses a Project.
            needs_reporter_info = (
                url_text.endswith("/triage")
                and str(payload.get("disposition") or "").upper() == "NEEDS_REPORTER_INFORMATION"
            )
            if not needs_reporter_info:
                _ensure_test_project(int(match.group(1)))

        return raw_post(url, *args, **kwargs)

    client.post = project_aware_post  # type: ignore[method-assign]


@pytest.fixture(scope="session")
def client():
    """
    TestClient with startup hooks mocked.
    No database and no MinIO required — safe for CI.
    """
    with patch("app.main.check_migration_head"):
        from app.main import app
        with TestClient(app) as c:
            yield c


@pytest.fixture(scope="session")
def client_db():
    """
    TestClient with real startup — requires a live MariaDB stamped at Alembic head.
    MinIO is not required; startup warns and continues in dev mode.
    Run only with: pytest -m db
    """
    from app.main import app
    with TestClient(app) as c:
        _install_project_aware_db_client(c)
        yield c


@pytest.fixture(scope="session")
def admin_token(client_db):
    """JWT token for admin@local (password: 'password'). Acquired once per session."""
    resp = client_db.post(
        "/auth/login",
        json={"email": "admin@local", "password": "password"},
    )
    assert resp.status_code == 200, f"Admin login failed: {resp.status_code} {resp.text}"
    return resp.json()["access_token"]
