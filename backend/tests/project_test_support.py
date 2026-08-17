from __future__ import annotations

from uuid import uuid4


def associate_test_project(client, headers: dict[str, str], incident_id: int, *, title_prefix: str = "Test Project") -> dict:
    """Associate an intake Incident with a real coordinator-created Project.

    Existing DB integration tests created Incidents and then immediately exercised
    downstream assessment/offline-scene behavior. Project is now a required domain
    boundary before leaving coordinator review, so those helpers must explicitly
    establish Project ownership first. This goes through the production API rather
    than mutating project_id directly, preserving authorization and audit behavior.
    """
    response = client.post(
        f"/incidents/{int(incident_id)}/project-association",
        headers=headers,
        json={
            "mode": "CREATE_NEW",
            "title": f"{title_prefix} {incident_id} {uuid4().hex[:8]}",
            "notes": "DB integration fixture Project association.",
        },
    )
    assert response.status_code == 200, (
        f"Project association failed for incident {incident_id}: "
        f"{response.status_code} {response.text}"
    )
    return response.json()["project"]
