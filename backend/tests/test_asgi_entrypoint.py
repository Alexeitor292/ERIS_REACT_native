import json
import os
from pathlib import Path
import subprocess
import sys


BACKEND_DIR = Path(__file__).resolve().parents[1]
PROBE = r'''
import json
from app.asgi import app
print(json.dumps({
    "title": app.title,
    "paths": sorted({getattr(route, "path", "") for route in app.routes}),
}))
'''


def _probe(*, env_name: str, docs_enabled: str | None):
    env = os.environ.copy()
    env["ENV"] = env_name
    if docs_enabled is None:
        env.pop("API_DOCS_ENABLED", None)
    else:
        env["API_DOCS_ENABLED"] = docs_enabled

    result = subprocess.run(
        [sys.executable, "-c", PROBE],
        cwd=BACKEND_DIR,
        env=env,
        text=True,
        capture_output=True,
        check=True,
    )
    return json.loads(result.stdout.strip().splitlines()[-1])


def test_production_entrypoint_uses_product_identity_and_hides_docs():
    data = _probe(env_name="prod", docs_enabled=None)
    assert data["title"] == "Emergency Response Information System API"
    assert "/docs" not in data["paths"]
    assert "/docs/oauth2-redirect" not in data["paths"]
    assert "/redoc" not in data["paths"]
    assert "/openapi.json" not in data["paths"]


def test_development_entrypoint_keeps_interactive_docs():
    data = _probe(env_name="dev", docs_enabled=None)
    assert data["title"] == "Emergency Response Information System API"
    assert "/docs" in data["paths"]
    assert "/redoc" in data["paths"]
    assert "/openapi.json" in data["paths"]


def test_production_docs_can_be_explicitly_enabled():
    data = _probe(env_name="prod", docs_enabled="true")
    assert "/docs" in data["paths"]
    assert "/openapi.json" in data["paths"]
