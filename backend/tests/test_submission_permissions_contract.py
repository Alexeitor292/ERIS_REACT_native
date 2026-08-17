from uuid import uuid4

import pytest

pytestmark = pytest.mark.db


def test_submission_owner_can_manage_scoped_sharing_without_admin_directory(client_db, admin_token):
    admin_headers = {"Authorization": f"Bearer {admin_token}"}
    unique = uuid4().hex
    password = "sharing-contract-password"
    owner_id = None
    candidate_id = None
    submission_id = None

    try:
        owner = client_db.post(
            "/admin/users",
            headers=admin_headers,
            json={
                "email": f"sharing-owner-{unique}@example.test",
                "full_name": "Sharing Contract Owner",
                "password": password,
                "roles": ["FIELD_WORKER"],
            },
        )
        assert owner.status_code == 201
        owner_id = int(owner.json()["id"])

        candidate = client_db.post(
            "/admin/users",
            headers=admin_headers,
            json={
                "email": f"sharing-reader-{unique}@example.test",
                "full_name": "Sharing Contract Reader",
                "password": password,
                "roles": ["MAINTENANCE"],
            },
        )
        assert candidate.status_code == 201
        candidate_id = int(candidate.json()["id"])

        login = client_db.post(
            "/auth/login",
            json={"email": owner.json()["email"], "password": password},
        )
        assert login.status_code == 200
        owner_headers = {"Authorization": f"Bearer {login.json()['access_token']}"}

        created = client_db.post(
            "/submissions",
            headers=owner_headers,
            json={"title": f"sharing-contract-{unique}"},
        )
        assert created.status_code == 200
        submission_id = int(created.json()["submission_id"])

        detail = client_db.get(f"/submissions/{submission_id}", headers=owner_headers)
        assert detail.status_code == 200
        assert detail.json()["submission"]["can_manage_permissions"] is True

        # Submission ownership does not grant global admin-directory access.
        admin_directory = client_db.get("/admin/users?limit=5", headers=owner_headers)
        assert admin_directory.status_code == 403

        permissions = client_db.get(f"/submissions/{submission_id}/permissions", headers=owner_headers)
        assert permissions.status_code == 200
        permission_data = permissions.json()
        assert permission_data["can_manage"] is True
        available_ids = {int(user["id"]) for user in permission_data["available_users"]}
        assert candidate_id in available_ids

        granted = client_db.post(
            f"/submissions/{submission_id}/share",
            headers=owner_headers,
            json={"user_id": candidate_id},
        )
        assert granted.status_code == 200

        permissions_after_grant = client_db.get(
            f"/submissions/{submission_id}/permissions",
            headers=owner_headers,
        )
        assert permissions_after_grant.status_code == 200
        reader_ids = {int(user["user_id"]) for user in permissions_after_grant.json()["readers"]}
        assert candidate_id in reader_ids

        revoked = client_db.delete(
            f"/submissions/{submission_id}/share/{candidate_id}",
            headers=owner_headers,
        )
        assert revoked.status_code == 200

        permissions_after_revoke = client_db.get(
            f"/submissions/{submission_id}/permissions",
            headers=owner_headers,
        )
        assert permissions_after_revoke.status_code == 200
        reader_ids = {int(user["user_id"]) for user in permissions_after_revoke.json()["readers"]}
        assert candidate_id not in reader_ids

        deleted = client_db.delete(f"/submissions/{submission_id}", headers=owner_headers)
        assert deleted.status_code == 200
        submission_id = None
    finally:
        if submission_id is not None and owner_id is not None:
            # Admin can clean up a draft if an earlier assertion interrupted the owner path.
            client_db.delete(f"/submissions/{submission_id}", headers=admin_headers)
        for user_id in (owner_id, candidate_id):
            if user_id is not None:
                client_db.patch(
                    f"/admin/users/{user_id}",
                    headers=admin_headers,
                    json={"is_active": False},
                )
