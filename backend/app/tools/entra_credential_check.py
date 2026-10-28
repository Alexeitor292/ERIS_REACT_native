"""Check the Entra certificate credential the running API would use. Read-only.

    podman exec eris-api python -m app.tools.entra_credential_check

Prints the certificate subject, expiry and the thumbprint the Entra admin
center lists (to confirm the uploaded certificate matches), never key material.
Exit 0: usable. Exit 1: usable but expiring within 30 days, or a client secret
outside production. Exit 2: unusable or missing where production needs it.
"""
from __future__ import annotations

import sys

from .. import entra_credential
from ..config import settings


def main() -> int:
    if not settings.ENTRA_ENABLED:
        print("Entra sign-in is disabled; no credential needed.")
        return 0
    if not (settings.ENTRA_CLIENT_CERT_FILE and settings.ENTRA_CLIENT_KEY_FILE):
        if settings.ENTRA_CLIENT_SECRET and settings.ENV.strip().lower() != "prod":
            print("Entra uses a client secret (allowed outside ENV=prod only). Use a certificate.")
            return 1
        print("entra_credential_check: ENTRA_CLIENT_CERT_FILE and ENTRA_CLIENT_KEY_FILE are not set", file=sys.stderr)
        return 2
    try:
        credential = entra_credential.load_credential(settings.ENTRA_CLIENT_CERT_FILE, settings.ENTRA_CLIENT_KEY_FILE)
    except entra_credential.CredentialError as exc:
        print(f"entra_credential_check: {exc}", file=sys.stderr)
        return 2
    print(f"Certificate subject: {credential.subject}")
    print(f"Thumbprint (as shown in Entra): {credential.thumbprint_sha1_hex}")
    print(f"Expires: {credential.not_after:%Y-%m-%d %H:%M} UTC")
    issues = entra_credential.problems(credential)
    if not issues:
        print("Entra certificate credential: OK")
        return 0
    for issue in issues:
        print(f"  - {issue}")
    return 2 if "expired" in issues[0] else 1


if __name__ == "__main__":
    raise SystemExit(main())
