from datetime import datetime, timedelta, timezone
from jose import jwt, JWTError
from passlib.context import CryptContext
from passlib.exc import UnknownHashError

# Prefer argon2; allow verifying existing bcrypt hashes too
pwd_context = CryptContext(
    schemes=["argon2", "bcrypt"],
    deprecated="auto",
)

def hash_password(password: str) -> str:
    # Optional: enforce max length for safety
    if len(password.encode("utf-8")) > 256:
        raise ValueError("Password too long")
    return pwd_context.hash(password)

def verify_password(password: str, password_hash: str) -> bool:
    try:
        return pwd_context.verify(password, password_hash)
    except UnknownHashError:
        return False
    except Exception:
        # if bcrypt backend is broken, don't crash login
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
