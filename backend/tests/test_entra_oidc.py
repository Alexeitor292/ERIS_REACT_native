"""The Entra trust boundary rejects token substitutions and wrong tenants."""
import base64
import time

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException
from jose import jwt

from app import entra

TENANT = "11111111-1111-4111-8111-111111111111"
CLIENT = "22222222-2222-4222-8222-222222222222"
OBJECT = "33333333-3333-4333-8333-333333333333"


def test_authority_is_limited_to_microsoft_cloud_hosts(monkeypatch):
    monkeypatch.setattr(entra.settings, "ENTRA_AUTHORITY_HOST", "login.microsoftonline.us")
    assert entra._authority_host() == "login.microsoftonline.us"
    monkeypatch.setattr(entra.settings, "ENTRA_AUTHORITY_HOST", "example.com")
    with pytest.raises(HTTPException) as error:
        entra._authority_host()
    assert error.value.status_code == 503


def _b64(value: int) -> str:
    raw = value.to_bytes((value.bit_length() + 7) // 8, "big")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def test_id_token_checks_signature_issuer_audience_tenant_nonce_and_object_id(monkeypatch):
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public = private.public_key().public_numbers()
    issuer = f"https://login.microsoftonline.com/{TENANT}/v2.0"
    jwks = {"keys": [{"kid": "test-key", "kty": "RSA", "n": _b64(public.n), "e": _b64(public.e)}]}

    class Response:
        def __init__(self, data): self.data = data
        def raise_for_status(self): pass
        def json(self): return self.data

    class Client:
        def __init__(self, **_): pass
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def get(self, url):
            if url.endswith("/.well-known/openid-configuration"):
                return Response({"issuer": issuer, "jwks_uri": f"{issuer}/discovery/v2.0/keys"})
            return Response(jwks)

    monkeypatch.setattr(entra.httpx, "Client", Client)
    pem = private.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                serialization.NoEncryption()).decode()

    def token(**overrides):
        payload = {"iss": issuer, "aud": CLIENT, "tid": TENANT, "oid": OBJECT,
                   "nonce": "expected", "exp": int(time.time()) + 300}
        payload.update(overrides)
        return jwt.encode(payload, pem, algorithm="RS256", headers={"kid": "test-key"})

    assert entra._validate_id_token(token(), tenant=TENANT, client=CLIENT, nonce="expected")["oid"] == OBJECT
    for changed in ({"aud": "other"}, {"iss": "https://evil.example"},
                    {"tid": "44444444-4444-4444-8444-444444444444"}, {"nonce": "wrong"},
                    {"oid": "not-a-uuid"}):
        with pytest.raises(HTTPException) as error:
            entra._validate_id_token(token(**changed), tenant=TENANT, client=CLIENT, nonce="expected")
        assert error.value.status_code == 401
