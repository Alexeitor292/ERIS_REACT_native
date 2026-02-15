from sqlalchemy import text
from sqlalchemy.orm import Session

from .config import settings
from .auth import hash_password  # NOTE: your auth.py defines hash_password()


def seed_admin(db: Session) -> None:
    """
    Safe behavior:
    - Only seeds if ENV=dev AND SEED_ADMIN=true
    - Requires SEED_ADMIN_PASSWORD (no default)
    """

    if settings.ENV.lower() != "dev":
        return
    if not settings.SEED_ADMIN:
        return

    if not settings.SEED_ADMIN_PASSWORD:
        raise RuntimeError("SEED_ADMIN=true but SEED_ADMIN_PASSWORD is missing in backend/.env")

    email = settings.SEED_ADMIN_EMAIL.strip().lower()

    existing = db.execute(
        text("SELECT id FROM users WHERE email = :email LIMIT 1"),
        {"email": email},
    ).scalar()

    pw_hash = hash_password(settings.SEED_ADMIN_PASSWORD)

    if existing:
        db.execute(
            text(
                """
                UPDATE users
                SET password_hash = :pw, is_active = 1
                WHERE email = :email
                """
            ),
            {"email": email, "pw": pw_hash},
        )
        db.commit()
        return

    db.execute(
        text(
            """
            INSERT INTO users (email, password_hash, is_active, full_name, created_at)
            VALUES (:email, :pw, 1, 'Admin', NOW())
            """
        ),
        {"email": email, "pw": pw_hash},
    )
    db.commit()
