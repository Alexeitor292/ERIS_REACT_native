"""The ERIS elevation patch format (routes/drone_surveys.parse_patch_header)."""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.routes.drone_surveys import parse_patch_header
from tests.test_drone_surveys_db import patch_bytes


def test_a_valid_patch_reads_its_bounds_and_size():
    assert parse_patch_header(patch_bytes()) == {"west": -122.5, "south": 37.8, "east": -122.499, "north": 37.801, "cols": 4, "rows": 3}


@pytest.mark.parametrize(
    "data",
    [
        b"",
        b"GEOTIFF!" + b"\0" * 40,
        patch_bytes()[:-1],
        patch_bytes() + b"\0\0\0\0",
        patch_bytes(west=-122.4, east=-122.5),
        patch_bytes(south=91.0, north=92.0),
        patch_bytes(west=-123.0, east=-122.0),
        patch_bytes(cols=1, rows=1, values=[1.0]),
    ],
)
def test_anything_else_is_refused(data):
    with pytest.raises(HTTPException) as info:
        parse_patch_header(data)
    assert info.value.status_code == 422
