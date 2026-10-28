"""Generate docs/reference/api.md from the FastAPI application itself: every
endpoint, its purpose (the handler's docstring) and who may call it (read from
the route's actual role guards), so the API reference cannot drift.

    backend/.venv/bin/python scripts/docs/generate_api_reference.py [--check]

Run from the repository root with the backend's dependencies installed. CI
(.github/workflows/docs.yml) runs it with --check.
"""
from __future__ import annotations

import argparse
import inspect as pyinspect
import os
import sys
from collections import defaultdict
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "docs" / "reference" / "api.md"
sys.path.insert(0, str(ROOT / "backend"))
for key, value in {"JWT_SECRET": "docs-generator-placeholder-secret", "DB_PASS": "x",
                   "S3_ACCESS_KEY": "x", "S3_SECRET_KEY": "x", "ENV": "dev"}.items():
    os.environ.setdefault(key, value)

AREAS = {
    "auth": "Sign-in and sessions", "admin": "Administration", "incidents": "Incidents",
    "incident-locations": "Incidents", "mission-center": "Mission center", "assessments": "Assessments",
    "submissions": "Submissions (GISA)", "attachments": "Attachments and photos", "photos": "Attachments and photos",
    "notifications": "Notifications", "maintenance-work": "Maintenance work", "maintenance-workflows": "Maintenance work",
    "road-inventory": "Road inventory", "org": "Organization", "projects": "Projects", "event-groups": "Event groups",
    "terrain-cross-sections": "Terrain", "arcgis": "Maps", "gisa": "Submissions (GISA)", "health": "Health",
}


def access(route, deps, viewer_routes) -> str:
    """Who may call the route, from its dependency tree."""
    found_roles: list[str] = []
    authenticated = False
    deny_guest = False
    stack = list(route.dependant.dependencies)
    while stack:
        dependency = stack.pop()
        call = dependency.call
        name = getattr(call, "__qualname__", "")
        if call is deps.deny_public_only:
            deny_guest = True
        if call in (deps.get_current_user, deps.current_session):
            authenticated = True
        if name.startswith("require_roles."):
            authenticated = True
            for cell in getattr(call, "__closure__", None) or ():
                value = cell.cell_contents
                if isinstance(value, (list, tuple, set)) and all(isinstance(v, str) for v in value):
                    found_roles.extend(value)
        stack.extend(dependency.dependencies)
    if found_roles:
        return "Roles: " + ", ".join(sorted(set(found_roles)))
    if deny_guest:
        return "Signed in, not Guest-only"
    if authenticated:
        return "Signed in (record rules apply)"
    return "Public"


def summary(route) -> str:
    doc = pyinspect.getdoc(route.endpoint) or ""
    first = doc.strip().split("\n\n")[0].replace("\n", " ").strip()
    if first:
        return first.replace("|", "\\|")
    return route.name.replace("_", " ").capitalize()


def render() -> str:
    with patch("app.main.check_migration_head"):
        from app.main import app
    from app import deps
    from app.services.public_visibility import VIEWER_READABLE_ROUTES
    from tests.route_table import api_routes

    rows = defaultdict(list)
    for route in api_routes(app):
        first = route.path.strip("/").split("/")[0] or "health"
        area = AREAS.get(first, first.replace("-", " ").capitalize())
        for method in sorted(route.methods - {"HEAD", "OPTIONS"}):
            rows[area].append((route.path, method, access(route, deps, VIEWER_READABLE_ROUTES), summary(route)))
    total = sum(len(v) for v in rows.values())
    lines = [
        "# API reference",
        "",
        "> **Generated** by `scripts/docs/generate_api_reference.py` from the FastAPI application. "
        "Do not edit by hand; CI fails when this file is stale.",
        "",
        f"ERIS exposes **{total} operations** under `https://<web-host>/api`. Request and response "
        "schemas are in the live OpenAPI document (`/api/openapi.json`, served only when "
        "`API_DOCS_ENABLED=true`, so normally on development servers).",
        "",
        "**Access** is read from each route's guards:",
        "",
        "- **Public**: no session needed (sign-in, health, configuration).",
        "- **Signed in (record rules apply)**: any signed-in user; the handler then limits what that "
        "person may see (for example a Guest sees approved records only). See "
        "[roles and permissions](../security/roles-and-permissions.md).",
        "- **Signed in, not Guest-only**: any role except an account whose only role is Guest.",
        "- **Roles: …**: only those roles.",
        "",
        "Authentication: the web sends its HttpOnly session cookie plus `X-CSRF-Token` on writes; "
        "native clients send `Authorization: Bearer <session>`. Tokens are never accepted in URLs. "
        "See [authentication and sessions](../security/authentication-and-sessions.md).",
        "",
        "## Contents",
        "",
    ]
    lines += [f"- [{area}](#{area.lower().replace(' ', '-').replace('(', '').replace(')', '')}) ({len(rows[area])})"
              for area in sorted(rows)]
    lines.append("")
    for area in sorted(rows):
        lines += [f"## {area}", "", "| Method | Path | Access | Purpose |", "| --- | --- | --- | --- |"]
        for path, method, who, purpose in sorted(rows[area]):
            lines.append(f"| `{method}` | `{path}` | {who} | {purpose} |")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="fail if docs/reference/api.md is stale")
    args = parser.parse_args()
    content = render()
    current = OUTPUT.read_text(encoding="utf-8") if OUTPUT.exists() else ""
    if current == content:
        print("docs/reference/api.md is up to date")
        return 0
    if args.check:
        print("docs/reference/api.md is stale: run scripts/docs/generate_api_reference.py and commit", file=sys.stderr)
        return 1
    OUTPUT.write_text(content, encoding="utf-8", newline="\n")
    print("wrote docs/reference/api.md")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
