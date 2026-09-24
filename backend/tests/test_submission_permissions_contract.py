from uuid import uuid4

import pytest

from tests.org_people import People

pytestmark = pytest.mark.db


def test_submission_owner_can_manage_scoped_sharing_without_admin_directory(client_db, admin_token):
    admin_headers = {"Authorization": f"Bearer {admin_token}"}
    unique = uuid4().hex
    password = "sharing-contract-password"
    owner_id = None
    candidate_id = None
    submission_id = None

    people = People(client_db, admin_token)
    try:
        # The candidate works in the owner's branch, so the share needs nobody's
        # approval (their branch chief is only told).
        owner_user = people.make("STAFF", "sharing-owner", full_name="Sharing Contract Owner")
        candidate_user = people.make("STAFF", "sharing-reader", full_name="Sharing Contract Reader")
        owner_id, candidate_id = owner_user["id"], candidate_user["id"]
        owner_headers = people.login(owner_user)

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
        people.cleanup()
