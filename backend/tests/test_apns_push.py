"""APNs push for the native iOS app: provider token, request shape, outcomes, routing."""
import json
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
import jwt

from app.config import Settings, settings
from app.services import apns, push
from tests.test_session_security import FakeDb

DEVICE = "a" * 64
TEAM, KEY_ID, TOPIC = "TEAM123456", "KEY1234567", "gov.ca.dot.eris"


@pytest.fixture
def apns_on(monkeypatch, tmp_path):
    key = ec.generate_private_key(ec.SECP256R1())
    path = tmp_path / "apns-auth-key.p8"
    path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                       serialization.NoEncryption()))
    for name, value in {"APNS_ENABLED": True, "APNS_KEY_FILE": str(path), "APNS_KEY_ID": KEY_ID,
                        "APNS_TEAM_ID": TEAM, "APNS_TOPIC": TOPIC}.items():
        monkeypatch.setattr(settings, name, value)
    apns.forget_provider_token()
    yield key
    apns.forget_provider_token()


class FakeApple:
    """Records requests; answers each device token from `answers` (default 200)."""

    def __init__(self, answers=None):
        self.answers = answers or {}
        self.requests = []

    def __call__(self):
        return self

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def post(self, url, content, headers):
        self.requests.append(SimpleNamespace(url=url, body=json.loads(content), headers=headers))
        status, reason = self.answers.get(url.rsplit("/", 1)[1], (200, ""))
        return SimpleNamespace(status_code=status, json=lambda: {"reason": reason})


def test_the_provider_token_is_an_es256_jwt_for_the_team(apns_on):
    token = apns.provider_token(now=1_900_000_000)
    assert jwt.get_unverified_header(token) == {"alg": "ES256", "kid": KEY_ID, "typ": "JWT"}
    public = apns_on.public_key().public_bytes(serialization.Encoding.PEM,
                                               serialization.PublicFormat.SubjectPublicKeyInfo).decode()
    assert jwt.decode(token, public, algorithms=["ES256"], options={"verify_iat": False}) == \
        {"iss": TEAM, "iat": 1_900_000_000}


def test_the_provider_token_is_reused_then_renewed(apns_on):
    first = apns.provider_token(now=1_900_000_000)
    assert apns.provider_token(now=1_900_000_000 + 30 * 60) == first
    assert apns.provider_token(now=1_900_000_000 + 46 * 60) != first


def test_a_push_is_an_alert_to_the_app_topic(apns_on, monkeypatch):
    apple = FakeApple()
    monkeypatch.setattr(apns, "_client", apple)
    body = apns.payload("Assigned", "Incident 12", "/incidents/12", 99)
    assert apns.send([("apns", DEVICE, body), ("apns-sandbox", DEVICE, body)])[0].delivered
    production, sandbox = apple.requests
    assert production.url == f"https://api.push.apple.com/3/device/{DEVICE}"
    assert sandbox.url.startswith("https://api.sandbox.push.apple.com/")
    assert production.headers["apns-topic"] == TOPIC and production.headers["apns-push-type"] == "alert"
    assert production.headers["authorization"].startswith("bearer ")
    assert production.body == {"aps": {"alert": {"title": "Assigned", "body": "Incident 12"}, "sound": "default"},
                               "link": "/incidents/12", "id": 99}


@pytest.mark.parametrize("answer,expected", [
    ((410, "Unregistered"), {"retire_token": True}),
    ((400, "BadDeviceToken"), {"retire_token": True}),
    ((429, "TooManyRequests"), {"retry_later": True}),
    ((503, "ServiceUnavailable"), {"retry_later": True}),
    ((400, "PayloadTooLarge"), {}),
])
def test_apple_answers_decide_retire_retry_or_fail(apns_on, monkeypatch, answer, expected):
    monkeypatch.setattr(apns, "_client", FakeApple({DEVICE: answer}))
    [result] = apns.send([("apns", DEVICE, b"{}")])
    assert not result.delivered
    assert result.retire_token == expected.get("retire_token", False)
    assert result.retry_later == expected.get("retry_later", False)


def test_an_expired_provider_token_is_minted_again(apns_on, monkeypatch):
    first = apns.provider_token()
    monkeypatch.setattr(apns, "_client", FakeApple({DEVICE: (403, "ExpiredProviderToken")}))
    [result] = apns.send([("apns", DEVICE, b"{}")])
    assert result.retry_later
    assert apns._cached is None or apns._cached[0] != first


def test_apns_unavailable_never_raises(apns_on, monkeypatch):
    def broken():
        raise ImportError("h2")

    monkeypatch.setattr(apns, "_client", broken)
    assert apns.send([("apns", DEVICE, b"{}")])[0].retry_later


# ---------------------------------------------------------------------------
# Routing in push.send_pending
# ---------------------------------------------------------------------------

GONE = "b" * 64


def _feed_db(devices):
    return FakeDb([
        ("FROM user_notifications", [{"id": 5, "user_id": 7, "title": "Assigned", "body": "Incident 12", "link": "/incidents/12"}]),
        ("FROM push_devices", devices),
    ])


def test_ios_devices_go_to_apns_and_expo_devices_to_expo(apns_on, monkeypatch):
    apple = FakeApple()
    monkeypatch.setattr(apns, "_client", apple)
    expo = []
    monkeypatch.setattr(push, "_post", lambda messages: expo.extend(messages) or [{"status": "ok"} for _ in messages])
    db = _feed_db([(7, DEVICE, "apns"), (7, "ExponentPushToken[legacy]", "ios")])
    assert push.send_pending(db) == {"sent": 1, "none": 0, "failed": 0}
    assert [r.url.rsplit("/", 1)[1] for r in apple.requests] == [DEVICE]
    assert [m["to"] for m in expo] == ["ExponentPushToken[legacy]"]


def test_a_dead_apns_token_is_retired(apns_on, monkeypatch):
    monkeypatch.setattr(apns, "_client", FakeApple({GONE: (410, "Unregistered")}))
    db = _feed_db([(7, GONE, "apns")])
    assert push.send_pending(db)["failed"] == 1
    assert db.ran("UPDATE push_devices SET is_active = 0")[0]["tokens"] == [GONE]


def test_an_apple_outage_leaves_the_notification_for_the_next_round(apns_on, monkeypatch):
    monkeypatch.setattr(apns, "_client", FakeApple({DEVICE: (503, "ServiceUnavailable")}))
    db = _feed_db([(7, DEVICE, "apns")])
    push.send_pending(db)
    assert not db.ran("SET push_state")


def test_ios_devices_are_skipped_while_apns_is_off(monkeypatch):
    monkeypatch.setattr(settings, "APNS_ENABLED", False)
    db = _feed_db([(7, DEVICE, "apns")])
    assert push.send_pending(db) == {"sent": 0, "none": 1, "failed": 0}


def test_production_apns_needs_its_whole_configuration():
    base = {"DB_PASS": "x", "S3_ACCESS_KEY": "x", "S3_SECRET_KEY": "x", "ENV": "prod", "JWT_SECRET": "a" * 64,
            "WEB_BASE_URL": "https://eris.example.test", "APNS_ENABLED": True}
    with pytest.raises(ValueError, match="APNS"):
        Settings(**base)
    assert Settings(**base, APNS_KEY_FILE="/run/secrets/eris/apns-auth-key.p8", APNS_KEY_ID=KEY_ID,
                    APNS_TEAM_ID=TEAM, APNS_TOPIC=TOPIC).APNS_ENABLED


def test_device_registration_checks_apns_token_format(monkeypatch):
    from fastapi import HTTPException

    from app.routes import notifications

    with pytest.raises(HTTPException) as error:
        notifications.register_device(notifications.DeviceIn(token="ExponentPushToken[x]", platform="apns"),
                                      db=FakeDb([]), user={"id": 7})
    assert error.value.status_code == 422
    db = FakeDb([])
    assert notifications.register_device(notifications.DeviceIn(token=DEVICE, platform="apns"), db=db,
                                         user={"id": 7}) == {"registered": True}
    assert db.ran("INSERT INTO push_devices")[0]["platform"] == "apns"
