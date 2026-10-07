"""Two people in one technical form (services/form_saves.py, services/form_presence.py).

Requires a live MariaDB at Alembic head. Run with: pytest -m db
"""

import uuid

import pytest

from tests.org_people import People

pytestmark = pytest.mark.db


@pytest.fixture(scope="module")
def pair(client_db, admin_token):
    placed = People(client_db, admin_token, prefix="Zzz Collab")
    owner = placed.make("STAFF", "collab-owner")
    colleague = placed.make("STAFF", "collab-colleague")
    for person in (owner, colleague):
        person["headers"] = placed.login(person)
    yield {"owner": owner, "colleague": colleague}
    placed.cleanup()


@pytest.fixture()
def form(client_db, pair):
    """A fresh draft, saved once, shared with the colleague (inside one branch: at once)."""
    owner, colleague = pair["owner"], pair["colleague"]
    sid = client_db.post("/submissions", json={"title": f"Collab {uuid.uuid4().hex[:6]}"}, headers=owner["headers"]).json()["submission_id"]
    first = client_db.patch(
        f"/submissions/{sid}/gisa",
        json={"ea": "0A1234", "crack_length_ft": 3, "material_soil": True, "est_soil_pct": 40, "water_dry": True},
        headers=owner["headers"],
    )
    assert first.status_code == 200, first.text
    shared = client_db.post(f"/submissions/{sid}/share", json={"user_id": colleague["id"]}, headers=owner["headers"])
    assert shared.status_code == 200 and shared.json()["share"]["status"] == "ACTIVE", shared.text
    return sid


def _gisa(client_db, sid, person):
    return client_db.get(f"/submissions/{sid}", headers=person["headers"]).json()["gisa"]


def _save(client_db, sid, person, changes: dict, opened: dict):
    return client_db.patch(
        f"/submissions/{sid}/gisa",
        json={**changes, "base": {key: opened.get(key) for key in changes}},
        headers=person["headers"],
    )


def test_a_field_changed_since_you_opened_it_is_refused_and_the_rest_saves(client_db, pair, form):
    owner, colleague = pair["owner"], pair["colleague"]
    opened_by_owner = _gisa(client_db, form, owner)
    opened_by_colleague = _gisa(client_db, form, colleague)
    revision = opened_by_owner["revision"]

    assert _save(client_db, form, colleague, {"crack_length_ft": 5}, opened_by_colleague).status_code == 200

    clash = _save(client_db, form, owner, {"crack_length_ft": 7}, opened_by_owner)
    assert clash.status_code == 409, clash.text
    detail = clash.json()["detail"]
    assert [c["field"] for c in detail["conflicts"]] == ["crack_length_ft"] and float(detail["conflicts"][0]["theirs"]) == 5
    assert detail["saved_by"] and detail["revision"] == revision + 1

    # A field nobody else touched saves, and leaves the colleague's change alone.
    assert _save(client_db, form, owner, {"ea": "0B5678"}, opened_by_owner).status_code == 200
    now = _gisa(client_db, form, owner)
    assert now["ea"] == "0B5678" and float(now["crack_length_ft"]) == 5 and now["revision"] == revision + 2

    # Keeping theirs out of the way: saving over it from what they saved goes through.
    assert _save(client_db, form, owner, {"crack_length_ft": 7}, now).status_code == 200


def test_a_save_of_one_linked_field_keeps_the_others(client_db, pair, form):
    owner = pair["owner"]
    opened = _gisa(client_db, form, owner)
    # Rock alone: the soil percentage stays while soil is still selected.
    assert _save(client_db, form, owner, {"material_rock": True}, opened).status_code == 200
    after = _gisa(client_db, form, owner)
    assert after["material_rock"] and after["material_soil"] and float(after["est_soil_pct"]) == 40
    # One water content: the choice sent wins over the one saved.
    assert _save(client_db, form, owner, {"water_moist": True}, after).status_code == 200
    water = _gisa(client_db, form, owner)
    assert water["water_moist"] and not water["water_dry"]


def test_lists_are_refused_when_they_moved_since(client_db, pair, form):
    owner, colleague = pair["owner"], pair["colleague"]
    ok = client_db.put(f"/submissions/{form}/gisa/actions", json={"immediate": [], "follow_up": [], "base_immediate": [], "base_follow_up": []}, headers=colleague["headers"])
    assert ok.status_code == 200, ok.text
    clash = client_db.put(f"/submissions/{form}/gisa/incident-types", json={"items": [], "base": ["NOT_THERE"]}, headers=owner["headers"])
    assert clash.status_code == 409 and clash.json()["detail"]["conflicts"][0]["field"] == "incident_types"


def test_a_save_without_base_behaves_as_before(client_db, pair, form):
    owner, colleague = pair["owner"], pair["colleague"]
    _save(client_db, form, colleague, {"ea": "0C0000"}, _gisa(client_db, form, colleague))
    plain = client_db.patch(f"/submissions/{form}/gisa", json={"ea": "0D0000"}, headers=owner["headers"])
    assert plain.status_code == 200 and plain.json()["gisa"]["ea"] == "0D0000"


def test_presence_and_the_memo_being_written(client_db, pair, form):
    owner, colleague = pair["owner"], pair["colleague"]
    mine, theirs = f"owner-{uuid.uuid4().hex[:8]}", f"colleague-{uuid.uuid4().hex[:8]}"
    url = f"/submissions/{form}/presence"

    first = client_db.post(url, json={"session_id": mine, "area": "memo:recommendations_notes", "memos": ["recommendations_notes"], "typing": True}, headers=owner["headers"])
    assert first.status_code == 200, first.text
    assert first.json()["granted"] == ["recommendations_notes"]

    seen = client_db.post(url, json={"session_id": theirs, "area": "card:report-header", "field": "EA", "memos": ["recommendations_notes"], "typing": True}, headers=colleague["headers"])
    body = seen.json()
    assert body["granted"] == [] and body["denied"]["recommendations_notes"]["user_id"] == owner["id"]
    other = next(o for o in body["others"] if o["session_id"] == mine)
    assert other["area"] == "memo:recommendations_notes" and other["memos"] == ["recommendations_notes"] and other["name"]

    # The owner sees where the colleague is.
    where = client_db.post(url, json={"session_id": mine, "area": "memo:recommendations_notes", "memos": ["recommendations_notes"]}, headers=owner["headers"]).json()
    assert any(o["area"] == "card:report-header" and o["field"] == "EA" for o in where["others"])

    # The colleague cannot save the memo the owner is writing.
    opened = _gisa(client_db, form, colleague)
    refused = _save(client_db, form, colleague, {"recommendations_notes_html": "<p>Mine</p>"}, opened)
    assert refused.status_code == 409 and "recommendations_notes" in refused.json()["detail"]["locked"]

    # Once the owner leaves, it is free.
    assert client_db.delete(f"{url}/{mine}", headers=owner["headers"]).status_code == 200
    free = client_db.post(url, json={"session_id": theirs, "memos": ["recommendations_notes"], "typing": True}, headers=colleague["headers"]).json()
    assert free["granted"] == ["recommendations_notes"] and not any(o["session_id"] == mine for o in free["others"])
    assert _save(client_db, form, colleague, {"recommendations_notes_html": "<p>Mine</p>"}, opened).status_code == 200
    client_db.delete(f"{url}/{theirs}", headers=colleague["headers"])


def test_people_it_is_shared_with_add_photos_videos_and_documents_to_sections(client_db, pair, form, monkeypatch):
    from app import photos
    from app.config import settings

    stored: dict[str, bytes] = {}
    monkeypatch.setattr(photos, "put_object_bytes", lambda *, object_key, data, content_type, bucket=None: stored.__setitem__(object_key, data))
    colleague = pair["colleague"]
    video = client_db.post(
        f"/submissions/{form}/attachments?section_key=water_drainage&kind=VIDEO",
        files={"file": ("culvert.mp4", b"\x00\x00\x00\x18ftypmp42", "video/mp4")},
        headers=colleague["headers"],
    )
    assert video.status_code == 200, video.text
    assert video.json()["kind"] == "VIDEO" and video.json()["section_key"] == "water_drainage"
    doc = client_db.post(
        f"/submissions/{form}/attachments?section_key=material",
        files={"file": ("lab-results.pdf", b"%PDF-1.4 test", "application/pdf")},
        headers=colleague["headers"],
    )
    assert doc.status_code == 200 and doc.json()["kind"] == "DOC"
    listed = client_db.get(f"/submissions/{form}", headers=pair["owner"]["headers"]).json()["attachments"]
    assert {(a["section_key"], a["kind"]) for a in listed} >= {("water_drainage", "VIDEO"), ("material", "DOC")}

    # Too large: a clear refusal, nothing stored.
    monkeypatch.setattr(settings, "MAX_UPLOAD_MB", 1)
    before = len(stored)
    big = client_db.post(
        f"/submissions/{form}/attachments?section_key=distribution&kind=VIDEO",
        files={"file": ("long.mp4", b"0" * (1024 * 1024 + 10), "video/mp4")},
        headers=colleague["headers"],
    )
    assert big.status_code == 413 and "larger than 1 MB" in big.json()["detail"]
    assert len(stored) == before
