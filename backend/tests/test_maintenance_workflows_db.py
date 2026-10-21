"""Real MariaDB + HTTP integration for configurable maintenance routing.

Use a migrated test database. Identity is overridden for the test accounts;
the real role, district, duty, SQL, notification and assessment checks all run.
"""
import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.db import SessionLocal
from app.deps import get_current_user
from app.routes import assessments, auth, event_groups, incident_approval, incidents, maintenance_workflows

pytestmark = pytest.mark.db


def test_real_district_workflow_to_maintenance_and_geotech():
    suffix = uuid.uuid4().hex[:8]
    ids, actor_roles, incident_ids = [], {}, []
    with SessionLocal() as db:
        occupied = set(db.execute(text("SELECT district FROM maintenance_workflows")).scalars())
        district = next((f"{n:02d}" for n in range(1, 13) if f"{n:02d}" not in occupied), None)
        if not district:
            pytest.skip("Integration fixture needs a district without a configured workflow")
        for i, role in enumerate(["ADMIN", "GUEST", "GUEST", "GUEST", "GUEST", "GUEST", "STAFF", "MAINTENANCE_COORDINATOR"]):
            result = db.execute(text("INSERT INTO users (email, full_name, is_active) VALUES (:e, :n, 1)"),
                                {"e": f"workflow-{suffix}-{i}@example.test", "n": f"Workflow test {i}"})
            uid = int(result.lastrowid)
            ids.append(uid); actor_roles[uid] = [role]
            db.execute(text("INSERT INTO user_roles (user_id, role_id) SELECT :u, id FROM roles WHERE name = :r"), {"u": uid, "r": role})
        db.commit()

    app = FastAPI()
    for module in [maintenance_workflows, incidents, assessments, event_groups, incident_approval, auth]:
        app.include_router(module.router)

    def identity(request: Request):
        uid = int(request.headers["x-test-user"])
        return {"id": uid, "roles": actor_roles[uid], "email": f"workflow-{uid}@example.test", "metadata": {}}

    app.dependency_overrides[get_current_user] = identity
    definition = {
        "manager_user_ids": [ids[0]],
        "duties": [
            {"id": "report", "name": "Reporters", "user_ids": [ids[1]], "report": True},
            {"id": "review", "name": "Reviewers", "user_ids": [ids[2]]},
            {"id": "decide", "name": "Decision makers", "user_ids": [ids[3], ids[4]]},
            {"id": "watch", "name": "Notify", "user_ids": [ids[5]]},
        ],
        "notify_duty_ids": ["watch"],
        "steps": [
            {"name": "First review", "kind": "REVIEW", "duty_ids": ["review"]},
            {"name": "Final decision", "kind": "DECISION", "duty_ids": ["decide"], "rule": "ALL", "allow_maintenance": True, "allow_geotech": True},
        ],
    }
    payload = {"description": "Field report", "first_observed_at": "2026-10-21T09:00:00", "latitude": 38.8,
               "longitude": -121.2, "district": district, "county": "PLA", "route": "80", "post_mile": "1.000"}
    try:
        with TestClient(app) as client:
            def call(method, path, index, body=None):
                return client.request(method, path, headers={"x-test-user": str(ids[index])}, json=body)

            response = call("PUT", f"/maintenance-workflows/{district}", 0, {"revision": 0, "definition": definition})
            assert response.status_code == 200, response.text
            assert call("POST", "/incidents", 6, payload).status_code == 403  # Staff title is not a reporting duty.

            for outcome in ["MAINTENANCE", "GEOTECH"]:
                response = call("POST", "/incidents", 1, payload)
                assert response.status_code == 200, response.text
                iid = response.json()["incident"]["id"]; incident_ids.append(iid)
                assert call("GET", f"/incidents/{iid}", 5).status_code == 200  # Notify-only may read.
                assert call("GET", f"/incidents/{iid}", 6).status_code == 403  # Unassigned Staff may not.
                assert call("POST", f"/incidents/{iid}/triage", 7, {"disposition": "NO_ASSESSMENT_REQUIRED"}).status_code == 409
                initial = call("GET", f"/maintenance-work/incidents/{iid}", 2).json()
                version = initial["version"]
                response = call("POST", f"/maintenance-work/incidents/{iid}/actions", 2,
                                {"version": version, "action": "APPROVE", "notes": "Reviewed"})
                assert response.status_code == 200, response.text
                version = response.json()["version"]
                remaining = [3, 4]
                if outcome == "GEOTECH":
                    # Two people act on the same rendered version at once. The
                    # MariaDB row lock serializes them; one must reload to vote.
                    barrier = Barrier(2)
                    def vote(index):
                        barrier.wait(timeout=5)
                        return index, call("POST", f"/maintenance-work/incidents/{iid}/actions", index,
                            {"version": version, "action": outcome, "notes": "Concurrent vote", "new_group_title": "Workflow test group"})
                    with ThreadPoolExecutor(max_workers=2) as pool:
                        results = list(pool.map(vote, [3, 4]))
                    assert sorted(r.status_code for _, r in results) == [200, 409], [(r.status_code, r.text) for _, r in results]
                    winner = next(r for _, r in results if r.status_code == 200)
                    assert winner.json()["outcome"] is None
                    version = winner.json()["version"]
                    remaining = [index for index, r in results if r.status_code == 409]
                for position, person in enumerate(remaining):
                    response = call("POST", f"/maintenance-work/incidents/{iid}/actions", person,
                                    {"version": version, "action": outcome, "notes": "Agree on repair route", "new_group_title": "Workflow test group" if outcome == "GEOTECH" else None})
                    assert response.status_code == 200, response.text
                    if position < len(remaining) - 1:
                        assert response.json()["outcome"] is None
                    version = response.json()["version"]
                assert response.json()["outcome"] == outcome
                assert call("POST", f"/maintenance-work/incidents/{iid}/actions", 4,
                            {"version": version, "action": outcome, "notes": "Duplicate"}).status_code == 409
                with SessionLocal() as db:
                    assessment = db.execute(text("SELECT state FROM assessments WHERE incident_id = :i"), {"i": iid}).scalar()
                    assert assessment == ("PENDING_OFFICE_DELEGATION" if outcome == "GEOTECH" else None)
                    assert db.execute(text("SELECT COUNT(*) FROM user_notifications WHERE incident_id = :i AND user_id = :u"), {"i": iid, "u": ids[5]}).scalar() >= 4
    finally:
        with SessionLocal() as db:
            db.execute(text("DELETE FROM maintenance_workflows WHERE district = :d AND updated_by_user_id = :u"), {"d": district, "u": ids[0]})
            for uid in ids:
                db.execute(text("UPDATE users SET is_active = 0 WHERE id = :u"), {"u": uid})
            db.commit()
