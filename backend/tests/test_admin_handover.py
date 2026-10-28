"""Administrator handover cannot lock the deployment out, and its end state is checkable."""
import pytest
from fastapi import HTTPException

from app import admin_users
from app.services import org_tree
from app.tools.handover_status import Snapshot, evaluate
from tests.test_session_security import FakeDb

ACTOR = {"id": 1, "roles": ["ADMIN"]}


def _target(user_id=2, roles=("ADMIN",), other_admins=1):
    return FakeDb([
        ("FROM users WHERE id", [{"id": user_id, "email": "b@dot.ca.gov", "full_name": "B",
                                  "is_active": 1, "metadata_json": None}]),
        ("WHERE r.name = 'ADMIN' AND u.is_active = 1 AND u.id <>", [other_admins]),
        ("FROM user_roles ur JOIN roles r", list(roles)),
    ])


def test_an_administrator_cannot_disable_their_own_account():
    with pytest.raises(HTTPException) as error:
        admin_users.update_user(user_id=1, body=admin_users.UpdateUserIn(is_active=False),
                                db=_target(user_id=1), _admin=ACTOR)
    assert error.value.status_code == 409


def test_the_last_active_administrator_cannot_be_disabled():
    with pytest.raises(HTTPException) as error:
        admin_users.update_user(user_id=2, body=admin_users.UpdateUserIn(is_active=False),
                                db=_target(other_admins=0), _admin=ACTOR)
    assert error.value.status_code == 409
    assert "last administrator" in error.value.detail


def test_guard_last_admin_allows_a_change_when_another_admin_remains():
    org_tree.guard_last_admin(_target(other_admins=1), 2)
    with pytest.raises(org_tree.OrgTreeError):
        org_tree.guard_last_admin(_target(other_admins=0), 2)


def test_disabling_an_account_ends_its_sessions(monkeypatch):
    db = _target(other_admins=1)
    monkeypatch.setattr(org_tree, "guard_leaving", lambda *_a, **_k: None)
    monkeypatch.setattr(admin_users, "_user_with_roles", lambda *_a, **_k: {"id": 2})
    admin_users.update_user(user_id=2, body=admin_users.UpdateUserIn(is_active=False), db=db, _admin=ACTOR)
    assert db.committed
    assert any("UPDATE user_sessions SET revoked_at" in sql for sql, _ in db.statements)


def test_password_reset_ends_existing_sessions(monkeypatch):
    monkeypatch.setattr(admin_users.settings, "LOCAL_LOGIN_ENABLED", True)
    db = _target()
    admin_users.reset_password(user_id=2, body=admin_users.ResetPasswordIn(password="a-long-new-password-1"),
                               db=db, _admin=ACTOR)
    assert any("UPDATE user_sessions SET revoked_at" in sql for sql, _ in db.statements)


def test_admin_can_revoke_sessions_without_disabling():
    db = _target()
    assert admin_users.revoke_sessions(user_id=2, db=db, _admin=ACTOR) == {"ok": True}
    assert not any("is_active" in sql and sql.startswith("UPDATE") for sql, _ in db.statements)
    assert any("UPDATE user_sessions SET revoked_at" in sql for sql, _ in db.statements)


def test_sso_only_deployments_refuse_to_set_passwords(monkeypatch):
    monkeypatch.setattr(admin_users.settings, "LOCAL_LOGIN_ENABLED", False)
    with pytest.raises(HTTPException) as error:
        admin_users.reset_password(user_id=2, body=admin_users.ResetPasswordIn(password="a-long-new-password-1"),
                                   db=_target(), _admin=ACTOR)
    assert error.value.status_code == 409
    body = admin_users.CreateUserIn(email="new@dot.ca.gov", full_name="New", password="a-long-new-password-1")
    with pytest.raises(HTTPException) as error:
        admin_users.create_user(body=body, db=FakeDb([]), _admin=ACTOR)
    assert error.value.status_code == 422


def test_sso_only_bootstrap_refuses_a_password():
    from app.tools.bootstrap_initial_admin import AdminSetupError, bootstrap

    with pytest.raises(AdminSetupError):
        bootstrap(FakeDb([]), email="a@dot.ca.gov", name="A", password="a-long-password-1",
                  tenant_id=None, object_id=None, allow_password=False)


# ---------------------------------------------------------------------------
# handover_status
# ---------------------------------------------------------------------------

def _admin(user_id, *, entra=True, signed_in=True, password=False, active=True):
    return {"id": user_id, "is_active": active, "has_password": password, "entra_linked": entra,
            "entra_signed_in": signed_in, "is_admin": True}


def _complete():
    return Snapshot(local_login_enabled=False, entra_enabled=True, admins=[_admin(2), _admin(3)],
                    bootstrap_admin=_admin(1, entra=False, password=True, active=False), bootstrap_marker=True)


def test_completed_handover_has_nothing_outstanding():
    assert evaluate(_complete()) == []


def test_a_fresh_install_lists_every_outstanding_step():
    fresh = Snapshot(local_login_enabled=True, entra_enabled=True,
                     admins=[_admin(1, entra=False, password=True)],
                     bootstrap_admin=_admin(1, entra=False, password=True), bootstrap_marker=True)
    text = "\n".join(evaluate(fresh))
    assert "at least 2" in text
    assert "Bootstrap administrator (user ID 1)" in text
    assert "still hold a password: user IDs [1]" in text
    assert "LOCAL_LOGIN_ENABLED is true" in text


def test_one_entra_admin_is_not_enough():
    snapshot = _complete()
    snapshot.admins = [_admin(2)]
    assert any("at least 2" in item for item in evaluate(snapshot))


def test_entra_admins_must_have_proved_their_object_id():
    snapshot = _complete()
    snapshot.admins = [_admin(2), _admin(3, signed_in=False)]
    assert any("never signed in" in item and "[3]" in item for item in evaluate(snapshot))


def test_an_sso_only_bootstrap_admin_may_stay_active():
    snapshot = _complete()
    snapshot.bootstrap_admin = _admin(1)
    snapshot.admins.append(_admin(1))
    assert evaluate(snapshot) == []


def test_password_sign_in_left_on_is_outstanding():
    snapshot = _complete()
    snapshot.local_login_enabled = True
    assert evaluate(snapshot) == ["LOCAL_LOGIN_ENABLED is true: set it false in app.env and recreate the API container."]


# ---------------------------------------------------------------------------
# create_admin: recovery without passwords
# ---------------------------------------------------------------------------

TENANT = "11111111-1111-4111-8111-111111111111"
OBJECT = "33333333-3333-4333-8333-333333333333"


def test_create_admin_links_an_entra_identity_for_recovery():
    from app.tools.create_admin import ensure_admin

    # An existing account (the usual recovery case) with no Entra link yet.
    db = FakeDb([("SELECT id FROM users WHERE email", [(5,)]), ("SELECT 1 FROM user_roles", [(1,)])])
    assert ensure_admin(db, email="b@dot.ca.gov", full_name=None, password_hash=None, entra=(TENANT, OBJECT)) == (5, False)
    link = db.ran("INSERT INTO user_external_identities")[0]
    assert (link["t"], link["o"]) == (TENANT, OBJECT)


def test_create_admin_refuses_to_relink_a_different_entra_identity():
    from app.tools.create_admin import AdminSetupError, ensure_admin

    db = FakeDb([
        ("SELECT id FROM users WHERE email", [(5,)]),
        ("FROM user_external_identities WHERE user_id", [(TENANT, "44444444-4444-4444-8444-444444444444")]),
    ])
    with pytest.raises(AdminSetupError):
        ensure_admin(db, email="b@dot.ca.gov", full_name=None, password_hash=None, entra=(TENANT, OBJECT))


def test_create_admin_refuses_a_password_when_sign_in_is_entra_only(monkeypatch, capsys):
    from app.tools import create_admin

    monkeypatch.setattr(create_admin.settings, "LOCAL_LOGIN_ENABLED", False)
    monkeypatch.setenv("ERIS_ADMIN_PASSWORD", "a-long-enough-password")
    assert create_admin.main(["--email", "b@dot.ca.gov", "--name", "B"]) == 2
    assert "LOCAL_LOGIN_ENABLED is false" in capsys.readouterr().err
