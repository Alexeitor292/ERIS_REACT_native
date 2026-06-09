import os
import sys
from unittest.mock import patch

import pytest
from starlette.testclient import TestClient

# Set required env vars before any app module is imported.
# In CI there is no backend/.env; locally the .env overrides these at runtime.
os.environ.setdefault("DB_PASS", "ci_placeholder")
os.environ.setdefault("JWT_SECRET", "ci_placeholder_secret")

# Ensure backend/ is on sys.path so `from app.X import Y` resolves correctly
# when pytest is run from the backend/ directory.
_backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _backend_dir not in sys.path:
    sys.path.insert(0, _backend_dir)


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
