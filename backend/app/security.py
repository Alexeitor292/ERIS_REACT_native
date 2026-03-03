from __future__ import annotations

from .auth import hash_password as _hash_password
from .auth import verify_password as _verify_password

def hash_password(password: str) -> str:
    return _hash_password(password)

def verify_password(password: str, password_hash: str) -> bool:
    return _verify_password(password, password_hash)
