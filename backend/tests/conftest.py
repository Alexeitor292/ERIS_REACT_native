import os
import sys
from unittest.mock import patch

import pytest
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
