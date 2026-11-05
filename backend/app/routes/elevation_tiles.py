"""USGS elevation tiles for measuring a site (``services/elevation_tiles.py``)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Path, Response

from ..deps import require_roles
from ..roles import ALL_ROLE_NAMES
from ..services import elevation_tiles

router = APIRouter(tags=["elevation-tiles"])


@router.get("/elevation-tiles/{row}/{col}")
def get_elevation_tile(
    row: int = Path(..., ge=0),
    col: int = Path(..., ge=0),
    # Every role: anyone who can open a form can see it measured. These are public
    # USGS heights, and the answer holds no record data.
    _user=Depends(require_roles(ALL_ROLE_NAMES)),
):
    if not elevation_tiles.covers(row, col):
        raise HTTPException(status_code=404, detail="ERIS has no elevation for that place")
    try:
        data = elevation_tiles.tile(row, col)
    except elevation_tiles.TileUnavailable as exc:
        raise HTTPException(status_code=503, detail="The USGS elevation service is unavailable. Try again shortly.") from exc
    return Response(content=data, media_type="application/octet-stream",
                    headers={"Cache-Control": "private, max-age=604800"})
