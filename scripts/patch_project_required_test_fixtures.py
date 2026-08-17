from __future__ import annotations

from pathlib import Path
import re


def add_helper(text: str) -> str:
    marker = "pytestmark = pytest.mark.db\n"
    helper = '''pytestmark = pytest.mark.db


def _associate_project(client_db, headers: dict[str, str], incident_id: int) -> None:
    response = client_db.post(
        f"/incidents/{incident_id}/project-association",
        headers=headers,
        json={
            "mode": "CREATE_NEW",
            "title": f"Integration Project {incident_id}",
            "notes": "Legacy DB fixture Project association.",
        },
    )
    assert response.status_code == 200, f"Project association failed: {response.status_code} {response.text}"
'''
    if "def _associate_project(" in text:
        return text
    if text.count(marker) != 1:
        raise RuntimeError("Could not uniquely locate pytestmark")
    return text.replace(marker, helper, 1)


def patch_forward_helper(path: str, auth_expr: str) -> None:
    p = Path(path)
    text = add_helper(p.read_text(encoding="utf-8"))
    marker = "    incident_id = resp.json()[\"incident\"][\"id\"]\n"
    if text.count(marker) != 1:
        raise RuntimeError(f"{path}: expected one incident-id helper marker, found {text.count(marker)}")
    replacement = marker + f"    _associate_project(client_db, {auth_expr}, int(incident_id))\n"
    text = text.replace(marker, replacement, 1)
    p.write_text(text, encoding="utf-8")


for path in [
    "backend/tests/test_elevation_profile.py",
    "backend/tests/test_offline_scene.py",
    "backend/tests/test_offline_scene_generation.py",
    "backend/tests/test_terrain_grid.py",
]:
    patch_forward_helper(path, '{"Authorization": f"Bearer {admin_token}"}')


# Road Inventory central forwarding helper receives admin_token and incident_id.
p = Path("backend/tests/test_road_inventory.py")
text = add_helper(p.read_text(encoding="utf-8"))
marker = '''    def _link_location_and_forward(self, client_db, admin_token, incident_id: int) -> int:
        """Link a new location and forward the incident so a submission is created."""
'''
if text.count(marker) != 1:
    raise RuntimeError("road inventory forwarding helper marker drifted")
text = text.replace(
    marker,
    marker + '        _associate_project(client_db, {"Authorization": f"Bearer {admin_token}"}, int(incident_id))\n',
    1,
)
p.write_text(text, encoding="utf-8")


# DB smoke has two direct assignment tests. Establish Project ownership before
# testing the engineer-role invariant so Project is not the first rejection.
p = Path("backend/tests/test_db_smoke.py")
text = add_helper(p.read_text(encoding="utf-8"))
marker = '        incident_id = int(incident.json()["incident"]["id"])\n\n        assigned = client_db.post(\n'
count = text.count(marker)
if count != 2:
    raise RuntimeError(f"db smoke assignment markers drifted: {count}")
text = text.replace(
    marker,
    '        incident_id = int(incident.json()["incident"]["id"])\n        _associate_project(client_db, headers, incident_id)\n\n        assigned = client_db.post(\n',
)
p.write_text(text, encoding="utf-8")


# Assessment-flow tests may create incidents for visibility-only checks. Only
# associate immediately before an actual triage request.
p = Path("backend/tests/test_assessment_flow.py")
text = add_helper(p.read_text(encoding="utf-8"))
pattern = re.compile(r'(?P<indent>\s*)resp = client_db\.post\(\n(?P=indent)    f"/incidents/\{incident_id\}/triage",')
text, count = pattern.subn(
    lambda m: f'{m.group("indent")}_associate_project(client_db, _auth(tokens["admin"] if "admin" in tokens else tokens["coordinator"]), incident_id)\n{m.group("indent")}resp = client_db.post(\n{m.group("indent")}    f"/incidents/{{incident_id}}/triage",',
    text,
)
# The generic substitution above is too broad in token choice for coordinator
# district tests; normalize those explicit cases below after preserving syntax.
if count < 1:
    raise RuntimeError("assessment-flow triage markers not found")
# Admin may create Project in any district, so using admin here is deterministic
# and does not change the role being tested for the subsequent triage request.
text = text.replace(
    '_associate_project(client_db, _auth(tokens["admin"] if "admin" in tokens else tokens["coordinator"]), incident_id)',
    '_associate_project(client_db, _auth(tokens["admin"]), incident_id)',
)
p.write_text(text, encoding="utf-8")


# Workflow-tree tests likewise preserve the pending-triage test projectless and
# associate only when a test is about to perform a triage transition.
p = Path("backend/tests/test_workflow_tree.py")
text = add_helper(p.read_text(encoding="utf-8"))
pattern = re.compile(r'(?P<indent>\s*)(?P<var>[a-zA-Z_][a-zA-Z0-9_]*) = client_db\.post\(\n(?P=indent)    f"/incidents/\{incident_id\}/triage",')
text, count = pattern.subn(
    lambda m: f'{m.group("indent")}_associate_project(client_db, _auth(tokens["admin"]), incident_id)\n{m.group("indent")}{m.group("var")} = client_db.post(\n{m.group("indent")}    f"/incidents/{{incident_id}}/triage",',
    text,
)
if count < 1:
    raise RuntimeError("workflow-tree triage markers not found")
p.write_text(text, encoding="utf-8")


for path in [
    "backend/tests/test_assessment_flow.py",
    "backend/tests/test_db_smoke.py",
    "backend/tests/test_elevation_profile.py",
    "backend/tests/test_offline_scene.py",
    "backend/tests/test_offline_scene_generation.py",
    "backend/tests/test_road_inventory.py",
    "backend/tests/test_terrain_grid.py",
    "backend/tests/test_workflow_tree.py",
]:
    compile(Path(path).read_text(encoding="utf-8"), path, "exec")
