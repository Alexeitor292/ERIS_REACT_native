"""USGS elevation tiles: which tile is asked for, what is kept, and what a failure does."""
from __future__ import annotations

import io
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi import HTTPException

from app.routes.elevation_tiles import get_elevation_tile
from app.services import elevation_tiles as tiles

TILE = b"CntZImage rest of the tile"
# The tile over Hayward, as the iPhone and website compute it.
ROW, COL = 50710, 21088


@pytest.fixture()
def kept(monkeypatch):
    store: dict[str, bytes] = {}

    def read(*, object_key, bucket=None):
        if object_key not in store:
            raise RuntimeError("NoSuchKey")
        return store[object_key], "application/octet-stream"

    def write(*, object_key, data, content_type, bucket=None):
        store[object_key] = data

    monkeypatch.setattr(tiles, "get_object_bytes", read)
    monkeypatch.setattr(tiles, "put_object_bytes", write)
    monkeypatch.setattr(tiles.time, "sleep", lambda _: None)
    return store


def _usgs(monkeypatch, *answers):
    asked: list[str] = []
    remaining = list(answers)

    def fake(url, timeout=None):
        asked.append(url)
        answer = remaining.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return io.BytesIO(answer)

    monkeypatch.setattr(tiles, "urlopen", fake)
    return asked


def test_the_request_puts_the_outer_heights_on_the_edges_of_the_square():
    query = parse_qs(urlparse(tiles.source_url(ROW, COL)).query)
    west, south, east, north = [float(v) for v in query["bbox"][0].split(",")]
    cell = tiles.RESOLUTION_M
    assert query["size"] == ["257,257"]
    assert query["format"] == ["lerc"]
    assert cell == pytest.approx(1.19432856), "fine enough for USGS's 1 m lidar everywhere in California"
    assert east - west == pytest.approx(257 * cell)
    assert north - south == pytest.approx(257 * cell)
    # The first cell's centre is the square's corner.
    assert west + cell / 2 == pytest.approx(-20037508.342787 + COL * tiles.TILE_SIZE_M)
    assert north - cell / 2 == pytest.approx(20037508.342787 - ROW * tiles.TILE_SIZE_M)


def test_only_california_is_served():
    assert tiles.covers(ROW, COL)
    assert not tiles.covers(ROW, COL + 5000), "Nevada and beyond"
    assert not tiles.covers(0, 0)
    with pytest.raises(HTTPException) as refused:
        get_elevation_tile(row=0, col=0, _user={})
    assert refused.value.status_code == 404


def test_a_tile_is_read_from_usgs_once_and_kept(kept, monkeypatch):
    asked = _usgs(monkeypatch, TILE)
    assert tiles.tile(ROW, COL) == TILE
    assert tiles.tile(ROW, COL) == TILE
    assert len(asked) == 1
    assert list(kept) == [f"elevation/usgs-3dep/v1/17/{ROW}/{COL}.lerc"]


def test_usgs_is_tried_again_and_an_error_answer_is_never_kept(kept, monkeypatch):
    asked = _usgs(monkeypatch, b'{"error":{"code":500}}', TILE)
    assert tiles.tile(ROW, COL) == TILE
    assert len(asked) == 2
    assert asked[0] != asked[1], "USGS repeats an error for the same address, so the retry must differ"

    _usgs(monkeypatch, b'{"error":{"code":500}}', OSError("no route"), OSError("no route"))
    with pytest.raises(tiles.TileUnavailable):
        tiles.tile(ROW, COL + 1)
    assert len(kept) == 1


def test_usgs_being_down_is_a_503_so_phones_fall_back(kept, monkeypatch):
    _usgs(monkeypatch, OSError("no route"), OSError("no route"), OSError("no route"))
    with pytest.raises(HTTPException) as refused:
        get_elevation_tile(row=ROW, col=COL, _user={})
    assert refused.value.status_code == 503


def test_storage_being_down_does_not_stop_a_tile(monkeypatch):
    def down(**_):
        raise RuntimeError("storage is down")

    monkeypatch.setattr(tiles, "get_object_bytes", down)
    monkeypatch.setattr(tiles, "put_object_bytes", down)
    _usgs(monkeypatch, TILE)
    assert tiles.tile(ROW, COL) == TILE
