from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import get_current_user
from ..storage import get_object_bytes

router = APIRouter()

_ROAD_INVENTORY_BUCKET = "road-inventory"


@router.get("/mobile-package/download")
def download_current_mobile_package(
    db: Session = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Download the current published road-inventory package through ERIS.

    Mobile clients must not depend on anonymous/direct MinIO access. The object
    store remains private; ERIS authenticates the caller and streams the package
    bytes from the server-side storage connection.
    """
    row = db.execute(text("""
        SELECT
          d.id AS dataset_version_id,
          d.version_tag,
          p.storage_key,
          p.file_size_bytes,
          p.sha256
        FROM road_inventory_datasets d
        JOIN road_inventory_packages p
          ON p.dataset_version_id = d.id
         AND p.package_type = 'json_gz'
        WHERE d.status = 'published'
        ORDER BY d.published_at DESC, d.id DESC
        LIMIT 1
    """)).mappings().first()

    if not row:
        raise HTTPException(status_code=404, detail="No generated package exists for the published road inventory dataset")

    try:
        data, content_type = get_object_bytes(
            object_key=str(row["storage_key"]),
            bucket=_ROAD_INVENTORY_BUCKET,
        )
    except Exception:
        raise HTTPException(status_code=503, detail="Road inventory package storage is unavailable")

    expected_size = int(row["file_size_bytes"] or 0)
    if expected_size > 0 and len(data) != expected_size:
        raise HTTPException(status_code=503, detail="Road inventory package size does not match the catalog")

    version_tag = str(row["version_tag"] or row["dataset_version_id"]).replace('"', "")
    return Response(
        content=data,
        media_type=content_type or "application/gzip",
        headers={
            "Content-Disposition": f'attachment; filename="road_inventory_{version_tag}.json.gz"',
            "X-ERIS-Package-SHA256": str(row["sha256"]),
            "Cache-Control": "private, no-store",
        },
    )
