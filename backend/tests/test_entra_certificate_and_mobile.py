"""Entra certificate credential (no client secret) and the mobile token exchange."""
import base64
import hashlib
import json
import time
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.x509.oid import NameOID
from fastapi import HTTPException
import jwt

from app import entra, entra_credential
from app.config import Settings, settings
from tests.test_session_security import FakeDb, _request

TENANT = "11111111-1111-4111-8111-111111111111"
CLIENT = "22222222-2222-4222-8222-222222222222"
MOBILE = "55555555-5555-4555-8555-555555555555"
OBJECT = "33333333-3333-4333-8333-333333333333"
TOKEN_ENDPOINT = f"https://login.microsoftonline.com/{TENANT}/oauth2/v2.0/token"


def _b64url_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _certificate(tmp_path, *, bits=2048, days=365, other_key=False, name="eris"):
    key = rsa.generate_private_key(public_exponent=65537, key_size=bits)
    cert_key = rsa.generate_private_key(public_exponent=65537, key_size=2048) if other_key else key
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "ERIS Entra client")])
    now = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject)
            .public_key(cert_key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(days=2)).not_valid_after(now + timedelta(days=days))
            .sign(cert_key, hashes.SHA256()))
    cert_file, key_file = tmp_path / f"{name}.crt", tmp_path / f"{name}.key"
    cert_file.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_file.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                           serialization.NoEncryption()))
    return str(cert_file), str(key_file), cert


# ---------------------------------------------------------------------------
# The client assertion
# ---------------------------------------------------------------------------

def test_the_assertion_is_a_ps256_jwt_microsoft_can_verify(tmp_path):
    cert_file, key_file, cert = _certificate(tmp_path)
    credential = entra_credential.load_credential(cert_file, key_file)
    assertion = entra_credential.client_assertion(credential, client_id=CLIENT, token_endpoint=TOKEN_ENDPOINT,
                                                  now=1_900_000_000)
    header_b64, claims_b64, signature_b64 = assertion.split(".")
    header = json.loads(_b64url_decode(header_b64))
    claims = json.loads(_b64url_decode(claims_b64))
    assert header == {"alg": "PS256", "typ": "JWT",
                      "x5t#S256": base64.urlsafe_b64encode(cert.fingerprint(hashes.SHA256())).rstrip(b"=").decode()}
    assert claims["aud"] == TOKEN_ENDPOINT and claims["iss"] == claims["sub"] == CLIENT
    assert claims["exp"] - claims["iat"] == 300 and claims["nbf"] == claims["iat"] == 1_900_000_000
    cert.public_key().verify(
        _b64url_decode(signature_b64), f"{header_b64}.{claims_b64}".encode(),
        padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=32), hashes.SHA256(),
    )


def test_each_assertion_is_unique(tmp_path):
    credential = entra_credential.load_credential(*_certificate(tmp_path)[:2])
    first, second = (json.loads(_b64url_decode(entra_credential.client_assertion(
        credential, client_id=CLIENT, token_endpoint=TOKEN_ENDPOINT).split(".")[1]))["jti"] for _ in range(2))
    assert first != second


def test_a_key_that_does_not_match_the_certificate_is_refused(tmp_path):
    with pytest.raises(entra_credential.CredentialError, match="does not match"):
        entra_credential.load_credential(*_certificate(tmp_path, other_key=True)[:2])


def test_a_weak_key_is_refused(tmp_path):
    with pytest.raises(entra_credential.CredentialError, match="2048"):
        entra_credential.load_credential(*_certificate(tmp_path, bits=1024)[:2])


def test_an_expired_certificate_cannot_sign(tmp_path):
    credential = entra_credential.load_credential(*_certificate(tmp_path, days=-1)[:2])
    assert "expired" in entra_credential.problems(credential)[0]
    with pytest.raises(entra_credential.CredentialError):
        entra_credential.client_assertion(credential, client_id=CLIENT, token_endpoint=TOKEN_ENDPOINT)


def test_a_certificate_near_expiry_is_reported(tmp_path):
    credential = entra_credential.load_credential(*_certificate(tmp_path, days=10)[:2])
    assert "renew" in entra_credential.problems(credential)[0]
    healthy = entra_credential.load_credential(*_certificate(tmp_path, days=200, name="ok")[:2])
    assert entra_credential.problems(healthy) == []


def test_a_missing_file_is_reported_without_a_traceback(tmp_path):
    with pytest.raises(entra_credential.CredentialError, match="cannot read"):
        entra_credential.load_credential(str(tmp_path / "none.crt"), str(tmp_path / "none.key"))


# ---------------------------------------------------------------------------
# Which credential the web flow sends
# ---------------------------------------------------------------------------

@pytest.fixture
def entra_on(monkeypatch):
    for name, value in {
        "ENTRA_ENABLED": True, "ENTRA_TENANT_ID": TENANT, "ENTRA_CLIENT_ID": CLIENT,
        "ENTRA_CLIENT_SECRET": None, "ENTRA_CLIENT_CERT_FILE": None, "ENTRA_CLIENT_KEY_FILE": None,
        "ENTRA_AUTHORITY_HOST": "login.microsoftonline.com", "ENV": "dev",
        "WEB_BASE_URL": "https://eris.example.test",
        "ENTRA_REDIRECT_URI": "https://eris.example.test/api/auth/entra/callback",
        "ENTRA_MOBILE_CLIENT_ID": MOBILE, "ENTRA_API_SCOPE": None,
    }.items():
        monkeypatch.setattr(settings, name, value)


def test_the_certificate_is_used_instead_of_a_secret(entra_on, monkeypatch, tmp_path):
    cert_file, key_file, _ = _certificate(tmp_path)
    monkeypatch.setattr(settings, "ENTRA_CLIENT_CERT_FILE", cert_file)
    monkeypatch.setattr(settings, "ENTRA_CLIENT_KEY_FILE", key_file)
    monkeypatch.setattr(settings, "ENTRA_CLIENT_SECRET", "also-set-in-dev")
    params = entra._client_credential(TENANT, CLIENT)
    assert set(params) == {"client_assertion_type", "client_assertion"}
    assert params["client_assertion_type"] == "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"


def test_production_never_sends_a_client_secret(entra_on, monkeypatch):
    monkeypatch.setattr(settings, "ENTRA_CLIENT_SECRET", "a-secret")
    monkeypatch.setattr(settings, "ENV", "prod")
    with pytest.raises(HTTPException) as error:
        entra._client_credential(TENANT, CLIENT)
    assert error.value.status_code == 503
    monkeypatch.setattr(settings, "ENV", "dev")
    assert entra._client_credential(TENANT, CLIENT) == {"client_secret": "a-secret"}


def test_an_unusable_certificate_sends_people_back_to_login(entra_on, monkeypatch, tmp_path):
    cert_file, key_file, _ = _certificate(tmp_path, days=-1)
    monkeypatch.setattr(settings, "ENTRA_CLIENT_CERT_FILE", cert_file)
    monkeypatch.setattr(settings, "ENTRA_CLIENT_KEY_FILE", key_file)
    response = entra.start()
    assert response.status_code == 303 and response.headers["location"].endswith("/login?entra=unavailable")


def test_the_token_request_carries_the_assertion(entra_on, monkeypatch, tmp_path):
    cert_file, key_file, _ = _certificate(tmp_path)
    monkeypatch.setattr(settings, "ENTRA_CLIENT_CERT_FILE", cert_file)
    monkeypatch.setattr(settings, "ENTRA_CLIENT_KEY_FILE", key_file)
    sent = {}

    class TokenEndpoint:
        def __init__(self, **_): pass
        def __enter__(self): return self
        def __exit__(self, *_): pass

        def post(self, url, data):
            sent.update(data, url=url)
            return SimpleNamespace(raise_for_status=lambda: None, json=lambda: {"id_token": "id"})

    monkeypatch.setattr(entra.httpx, "Client", TokenEndpoint)
    monkeypatch.setattr(entra, "_validate_id_token", lambda *_a, **_k: {"oid": OBJECT})
    monkeypatch.setattr(entra, "SessionLocal", lambda: FakeDb([("user_external_identities i", [])]))
    state = jwt.encode({"state": "s", "nonce": "n", "verifier": "v" * 43, "exp": 4102444800},
                       settings.JWT_SECRET, algorithm="HS256")
    entra.callback(_request(headers={"sec-fetch-mode": "navigate"}), code="c", state="s", error=None,
                   eris_entra_state=state)
    assert sent["url"] == TOKEN_ENDPOINT
    assert "client_secret" not in sent and sent["client_assertion"].count(".") == 2


def _prod(**overrides):
    values = {"DB_PASS": "x", "S3_ACCESS_KEY": "x", "S3_SECRET_KEY": "x", "ENV": "prod", "JWT_SECRET": "a" * 64,
              "WEB_BASE_URL": "https://eris.example.test", "ENTRA_ENABLED": True,
              "ENTRA_CLIENT_CERT_FILE": "/run/secrets/eris/entra-client.crt",
              "ENTRA_CLIENT_KEY_FILE": "/run/secrets/eris/entra-client.key"}
    values.update(overrides)
    return Settings(**values)


def test_production_entra_needs_a_certificate_and_no_secret():
    assert _prod().ENTRA_CLIENT_CERT_FILE
    with pytest.raises(ValueError, match="CERT_FILE"):
        _prod(ENTRA_CLIENT_CERT_FILE=None)
    with pytest.raises(ValueError, match="remove ENTRA_CLIENT_SECRET"):
        _prod(ENTRA_CLIENT_SECRET="a-secret")


# ---------------------------------------------------------------------------
# Mobile: Entra access token -> ERIS bearer session
# ---------------------------------------------------------------------------

@pytest.fixture
def signing_key(monkeypatch):
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    numbers = private.public_key().public_numbers()

    def b64(value):
        return base64.urlsafe_b64encode(value.to_bytes((value.bit_length() + 7) // 8, "big")).rstrip(b"=").decode()

    issuer = f"https://login.microsoftonline.com/{TENANT}/v2.0"
    jwks = {"keys": [{"kid": "k1", "kty": "RSA", "n": b64(numbers.n), "e": b64(numbers.e)}]}

    class Keys:
        def __init__(self, **_): pass
        def __enter__(self): return self
        def __exit__(self, *_): pass

        def get(self, url):
            data = {"issuer": issuer, "jwks_uri": f"https://login.microsoftonline.com/{TENANT}/discovery/v2.0/keys"} \
                if url.endswith("openid-configuration") else jwks
            return SimpleNamespace(raise_for_status=lambda: None, json=lambda: data)

    monkeypatch.setattr(entra.httpx, "Client", Keys)
    pem = private.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                serialization.NoEncryption()).decode()

    def token(**overrides):
        claims = {"iss": issuer, "aud": CLIENT, "tid": TENANT, "oid": OBJECT, "azp": MOBILE,
                  "scp": "access_as_user", "exp": int(time.time()) + 300, "iat": int(time.time())}
        claims.update(overrides)
        return jwt.encode(claims, pem, algorithm="RS256", headers={"kid": "k1"})

    return token


def _native(token, db, monkeypatch, headers=None):
    monkeypatch.setattr(entra, "SessionLocal", lambda: db)
    return entra.native(entra.NativeSignIn(access_token=token), _request("POST", headers=headers))


def test_a_mobile_token_for_a_linked_account_becomes_an_eris_bearer_session(entra_on, signing_key, monkeypatch):
    db = FakeDb([("user_external_identities i", [{"id": 7, "is_active": 1}])])
    body = _native(signing_key(), db, monkeypatch)
    assert body["token_type"] == "bearer" and len(body["access_token"]) >= 43
    stored = db.ran("INSERT INTO user_sessions")[0]
    assert stored["client"] == "bearer" and stored["method"] == "entra"
    assert stored["hash"] == hashlib.sha256(body["access_token"].encode()).hexdigest()


def test_the_application_id_uri_audience_is_accepted(entra_on, signing_key, monkeypatch):
    db = FakeDb([("user_external_identities i", [{"id": 7, "is_active": 1}])])
    assert _native(signing_key(aud=f"api://{CLIENT}"), db, monkeypatch)["token_type"] == "bearer"


@pytest.mark.parametrize("overrides", [
    {"azp": "66666666-6666-4666-8666-666666666666"},  # another app's token for ERIS
    {"scp": "User.Read"},                               # not the ERIS API scope
    {"aud": "00000003-0000-0000-c000-000000000000"},    # a Microsoft Graph token
    {"tid": "44444444-4444-4444-8444-444444444444"},    # another tenant
    {"exp": int(time.time()) - 60},                      # expired
])
def test_tokens_not_meant_for_the_eris_mobile_app_are_refused(entra_on, signing_key, monkeypatch, overrides):
    db = FakeDb([("user_external_identities i", [{"id": 7, "is_active": 1}])])
    with pytest.raises(HTTPException) as error:
        _native(signing_key(**overrides), db, monkeypatch)
    assert error.value.status_code == 401
    assert not db.ran("INSERT INTO user_sessions")


def test_an_unlinked_mobile_identity_is_refused(entra_on, signing_key, monkeypatch):
    with pytest.raises(HTTPException) as error:
        _native(signing_key(), FakeDb([]), monkeypatch)
    assert error.value.status_code == 403


def test_browsers_cannot_obtain_a_bearer_session(entra_on, signing_key, monkeypatch):
    db = FakeDb([("user_external_identities i", [{"id": 7, "is_active": 1}])])
    with pytest.raises(HTTPException) as error:
        _native(signing_key(), db, monkeypatch, headers={"sec-fetch-mode": "cors"})
    assert error.value.status_code == 403


def test_the_mobile_app_learns_its_public_settings_from_the_api(entra_on):
    assert entra.mobile_configuration() == {
        "authority": f"https://login.microsoftonline.com/{TENANT}",
        "client_id": MOBILE,
        "scopes": [f"api://{CLIENT}/access_as_user"],
    }


def test_no_mobile_settings_without_a_mobile_client(entra_on, monkeypatch):
    monkeypatch.setattr(settings, "ENTRA_MOBILE_CLIENT_ID", None)
    assert entra.mobile_configuration() is None


# ---------------------------------------------------------------------------
# entra_credential_check
# ---------------------------------------------------------------------------

def test_credential_check_reports_the_portal_thumbprint(entra_on, monkeypatch, tmp_path, capsys):
    from app.tools import entra_credential_check

    cert_file, key_file, cert = _certificate(tmp_path)
    monkeypatch.setattr(settings, "ENTRA_CLIENT_CERT_FILE", cert_file)
    monkeypatch.setattr(settings, "ENTRA_CLIENT_KEY_FILE", key_file)
    assert entra_credential_check.main() == 0
    out = capsys.readouterr().out
    assert cert.fingerprint(hashes.SHA1()).hex().upper() in out
    assert "PRIVATE KEY" not in out


@pytest.mark.parametrize("days,code", [(10, 1), (-1, 2)])
def test_credential_check_flags_expiry(entra_on, monkeypatch, tmp_path, days, code):
    from app.tools import entra_credential_check

    cert_file, key_file, _ = _certificate(tmp_path, days=days)
    monkeypatch.setattr(settings, "ENTRA_CLIENT_CERT_FILE", cert_file)
    monkeypatch.setattr(settings, "ENTRA_CLIENT_KEY_FILE", key_file)
    assert entra_credential_check.main() == code


def test_credential_check_fails_without_a_certificate_in_production(entra_on, monkeypatch):
    from app.tools import entra_credential_check

    monkeypatch.setattr(settings, "ENV", "prod")
    assert entra_credential_check.main() == 2
