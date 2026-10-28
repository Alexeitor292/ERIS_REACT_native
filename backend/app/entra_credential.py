"""Certificate credential for the ERIS Entra web app (no client secret).

Entra's "certificate credentials": the API proves it is the registered
confidential client by signing a short-lived JWT (a client assertion) with a
private key whose certificate is uploaded to the app registration. The key never
leaves the host; there is no shared secret to leak, phish or copy into a ticket.

The assertion follows Microsoft's format: header ``alg`` PS256 with ``x5t#S256``
(the certificate's SHA-256 thumbprint), and claims ``aud`` (the tenant token
endpoint), ``iss`` = ``sub`` = client ID, a unique ``jti``, and a lifetime of a
few minutes.
"""
from __future__ import annotations

import base64
import json
import os
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
ASSERTION_LIFETIME_SECONDS = 300
MIN_RSA_BITS = 2048
RENEW_WARNING_DAYS = 30


class CredentialError(Exception):
    """The configured certificate or key cannot be used."""


@dataclass(frozen=True)
class Credential:
    key: rsa.RSAPrivateKey
    thumbprint_s256: str
    # The SHA-1 hex thumbprint the Entra admin center lists under Certificates.
    thumbprint_sha1_hex: str
    not_after: datetime
    subject: str


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def load_credential(cert_file: str, key_file: str) -> Credential:
    try:
        stamps = (os.stat(cert_file).st_mtime_ns, os.stat(key_file).st_mtime_ns)
    except OSError as exc:
        raise CredentialError(f"cannot read the Entra certificate or key ({type(exc).__name__})") from exc
    # Re-read when either file is replaced (certificate rotation), else cached.
    return _load(cert_file, key_file, stamps)


@lru_cache(maxsize=4)
def _load(cert_file: str, key_file: str, _stamps: tuple[int, int]) -> Credential:
    try:
        with open(cert_file, "rb") as handle:
            certificate = x509.load_pem_x509_certificate(handle.read())
        with open(key_file, "rb") as handle:
            key = serialization.load_pem_private_key(handle.read(), password=None)
    except (OSError, ValueError, TypeError) as exc:
        raise CredentialError(f"the Entra certificate or key is not a readable PEM file ({type(exc).__name__})") from exc
    if not isinstance(key, rsa.RSAPrivateKey):
        raise CredentialError("the Entra key must be an RSA private key")
    if key.key_size < MIN_RSA_BITS:
        raise CredentialError(f"the Entra key must be at least {MIN_RSA_BITS} bits")
    if key.public_key().public_numbers() != certificate.public_key().public_numbers():
        raise CredentialError("the Entra private key does not match the certificate")
    thumbprint = certificate.fingerprint(hashes.SHA256())
    not_after = certificate.not_valid_after_utc
    return Credential(key=key, thumbprint_s256=_b64url(thumbprint),
                      thumbprint_sha1_hex=certificate.fingerprint(hashes.SHA1()).hex().upper(), not_after=not_after,
                      subject=certificate.subject.rfc4514_string())


def problems(credential: Credential, now: datetime | None = None) -> list[str]:
    """Reasons the credential cannot be used, or soon cannot; empty when healthy."""
    now = now or datetime.now(timezone.utc)
    if credential.not_after <= now:
        return [f"the Entra certificate expired on {credential.not_after:%Y-%m-%d}"]
    days = (credential.not_after - now).days
    if days < RENEW_WARNING_DAYS:
        return [f"the Entra certificate expires in {days} days ({credential.not_after:%Y-%m-%d}); renew it"]
    return []


def client_assertion(credential: Credential, *, client_id: str, token_endpoint: str,
                     now: float | None = None) -> str:
    """A signed client assertion for one token request."""
    if credential.not_after <= datetime.now(timezone.utc):
        raise CredentialError("the Entra certificate has expired")
    issued = int(now if now is not None else time.time())
    header = {"alg": "PS256", "typ": "JWT", "x5t#S256": credential.thumbprint_s256}
    claims = {"aud": token_endpoint, "iss": client_id, "sub": client_id, "jti": str(uuid.uuid4()),
              "nbf": issued, "iat": issued, "exp": issued + ASSERTION_LIFETIME_SECONDS}
    signing_input = ".".join(_b64url(json.dumps(part, separators=(",", ":")).encode()) for part in (header, claims))
    signature = credential.key.sign(
        signing_input.encode("ascii"),
        padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=padding.PSS.DIGEST_LENGTH),
        hashes.SHA256(),
    )
    return f"{signing_input}.{_b64url(signature)}"
