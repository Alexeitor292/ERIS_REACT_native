from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from .config import settings
from .db import get_db
from .deps import require_roles

router = APIRouter(prefix="/dev", tags=["dev"])


def _require_dev():
    if settings.ENV.lower() != "dev":
        raise HTTPException(status_code=404, detail="Not found")


@router.post("/seed-test-submission")
def seed_test_submission(
    db: Session = Depends(get_db),
    user=Depends(require_roles(["ADMIN", "REVIEWER"])),
):
    """
    DEV ONLY:
    Creates a single submission with a workflow event.
    Restricted to ADMIN/REVIEWER in dev.
    """
    _require_dev()

    created_by = user["id"]

    client_uuid = str(uuid.uuid4())
    status = "SUBMITTED"
    now = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")

    res = db.execute(
        text(
            """
            INSERT INTO submissions
              (status, created_by_user_id, client_submission_uuid, created_at, updated_at, submitted_at)
            VALUES
              (:status, :created_by, :client_uuid, :created_at, :updated_at, :submitted_at)
            """
        ),
        {
            "status": status,
            "created_by": created_by,
            "client_uuid": client_uuid,
            "created_at": now,
            "updated_at": now,
            "submitted_at": now,
        },
    )
    submission_id = res.lastrowid

    # Insert workflow event if table exists (don’t fail if schema differs)
    try:
        db.execute(
            text(
                """
                INSERT INTO workflow_events
                  (submission_id, event_type, from_status, to_status, actor_user_id, comment, created_at)
                VALUES
                  (:sid, 'SUBMITTED', NULL, :to_status, :actor, 'Seeded test submission', :created_at)
                """
            ),
            {"sid": submission_id, "to_status": status, "actor": created_by, "created_at": now},
        )
    except Exception:
        pass

    db.commit()

    return {"id": submission_id, "status": status, "client_submission_uuid": client_uuid}


