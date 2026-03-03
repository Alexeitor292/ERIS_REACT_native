from datetime import datetime, timedelta, timezone
from jose import jwt, JWTError
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

_argon2 = PasswordHasher()

def hash_password(password: str) -> str:
    # Keep a strict cap to avoid abuse and unexpected memory/cpu costs.
    if len(password.encode("utf-8")) > 256:
        raise ValueError("Password too long")
    return _argon2.hash(password)

def verify_password(password: str, password_hash: str) -> bool:
    try:
        return _argon2.verify(password_hash, password)
    except (VerifyMismatchError, InvalidHashError):
        return False
    except VerificationError:
        return False
    except Exception:
        return False

def create_access_token(*, subject: str, secret: str, alg: str, expires_minutes: int) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": subject,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=expires_minutes)).timestamp()),
    }
    return jwt.encode(payload, secret, algorithm=alg)

def decode_token(token: str, secret: str, alg: str) -> dict:
    try:
        return jwt.decode(token, secret, algorithms=[alg])
    except JWTError as e:
        raise ValueError(str(e))
