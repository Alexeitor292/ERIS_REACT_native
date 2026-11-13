"""Authorization and bounded reads must precede optional photo metadata parsing."""
import asyncio
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import HTTPException

from app import main, photos
from app.config import settings
from app.services import field_media_ingest


class ProbeUpload:
    filename = "field.jpg"
    content_type = "image/jpeg"

    def __init__(self, content, events):
        self.content = content
        self.events = events
        self.read_sizes = []

    async def read(self, size=-1):
        self.events.append("read")
        self.read_sizes.append(size)
        assert size >= 0, "Photo uploads must never be read without a size limit"
        return self.content[:size]


def store(file, db):
    return asyncio.run(photos._store_submission_attachment(
        submission_id=42, file=file, section_key=None, kind="PHOTO",
        capture_metadata_json=None, db=db, user={"id": 7},
    ))


def test_unauthorized_photo_is_not_read_or_parsed(monkeypatch):
    events = []

    def refuse(*_):
        events.append("authorize")
        raise HTTPException(403, "No edit permission")

    monkeypatch.setattr(main, "require_can_edit_submission", refuse)
    extract = Mock(side_effect=AssertionError("Unauthorized EXIF parsing"))
    monkeypatch.setattr(field_media_ingest, "extract_embedded_photo_metadata", extract)
    file = ProbeUpload(b"photo", events)
    with pytest.raises(HTTPException) as error:
        store(file, None)
    assert error.value.status_code == 403
    assert events == ["authorize"]
    assert file.read_sizes == []
    extract.assert_not_called()


def test_oversized_photo_is_rejected_after_one_bounded_read_before_metadata(monkeypatch):
    events = []
    monkeypatch.setattr(settings, "MAX_UPLOAD_MB", 1)
    monkeypatch.setattr(main, "require_can_edit_submission", lambda *_: events.append("authorize"))
    extract = Mock(side_effect=AssertionError("Oversized EXIF parsing"))
    monkeypatch.setattr(field_media_ingest, "extract_embedded_photo_metadata", extract)
    file = ProbeUpload(b"x" * (1024 * 1024 + 2), events)
    with pytest.raises(HTTPException) as error:
        store(file, None)
    assert error.value.status_code == 413
    assert events == ["authorize", "read"]
    assert file.read_sizes == [1024 * 1024 + 1]
    extract.assert_not_called()


def test_authorized_photo_uses_the_same_bounded_bytes_for_metadata_and_storage(monkeypatch):
    events = []
    monkeypatch.setattr(main, "require_can_edit_submission", lambda *_: events.append("authorize"))

    def extract(content):
        assert content == b"photo"
        events.append("metadata")
        return {"latitude": 38.5, "longitude": -121.5, "location_source": "EXIF_GPS"}

    def save(**values):
        assert values["data"] == b"photo"
        events.append("store")

    monkeypatch.setattr(field_media_ingest, "extract_embedded_photo_metadata", extract)
    monkeypatch.setattr(photos, "put_object_bytes", save)
    monkeypatch.setattr(photos, "_store_capture_metadata", Mock())
    db = SimpleNamespace(execute=lambda *_: SimpleNamespace(scalar=lambda: 9), commit=Mock())
    file = ProbeUpload(b"photo", events)
    result = store(file, db)
    assert result["capture_metadata"]["latitude"] == 38.5
    assert result["capture_metadata"]["longitude"] == -121.5
    assert events == ["authorize", "read", "metadata", "store"]
    assert file.read_sizes == [settings.MAX_UPLOAD_MB * 1024 * 1024 + 1]
    db.commit.assert_called_once_with()
