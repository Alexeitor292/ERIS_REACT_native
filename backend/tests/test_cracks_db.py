"""Cracks as their own records (routes/cracks.py, Alembic 20261029_submission_cracks).

Requires a live MariaDB at Alembic head. Run with: pytest -m db
"""

import importlib.util
import uuid
from pathlib import Path

import pytest
from sqlalchemy import text

from tests.org_people import People

pytestmark = pytest.mark.db

MIGRATION = Path(__file__).resolve().parents[1] / "migrations" / "versions" / "20261029_submission_cracks.py"


@pytest.fixture(scope="module")
def people(client_db, admin_token):
    placed = People(client_db, admin_token, prefix="Zzz Cracks")
    owner = placed.make("STAFF", "cracks-owner")
    outsider = placed.make("STAFF", "cracks-outsider")
    for person in (owner, outsider):
        person["headers"] = placed.login(person)
    yield {"owner": owner, "outsider": outsider}
    placed.cleanup()


@pytest.fixture()
def form(client_db, people):
    created = client_db.post("/submissions", json={"title": f"Cracks {uuid.uuid4().hex[:6]}"},
                             headers=people["owner"]["headers"])
    assert created.status_code in (200, 201), created.text
    return created.json()["submission_id"]


def _db(sql: str, **params):
    from app.db import engine

    with engine.begin() as conn:
        return conn.execute(text(sql), params)


def _attach(submission_id: int, owner_id: int, kind: str = "PHOTO") -> int:
    """A file on the form, straight into the tables (the upload path is not what this is about)."""
    from app.db import engine

    with engine.begin() as conn:
        attachment_id = conn.execute(text("""
            INSERT INTO attachments (created_by_user_id, storage_provider, storage_bucket, storage_key, file_name, mime_type, file_size_bytes)
            VALUES (:uid, 'minio', 'eris', :key, 'crack.jpg', 'image/jpeg', 8)
        """), {"uid": owner_id, "key": f"uploads/crack-{uuid.uuid4().hex}.jpg"}).lastrowid
        conn.execute(text("INSERT INTO attachment_links (submission_id, attachment_id, kind) VALUES (:sid, :aid, :kind)"),
                     {"sid": submission_id, "aid": attachment_id, "kind": kind})
    return int(attachment_id)


def _create(client_db, sid, person, **fields):
    return client_db.post(f"/submissions/{sid}/cracks", json={"client_uuid": str(uuid.uuid4()), **fields},
                          headers=person["headers"])


def test_each_crack_is_its_own_record_with_the_same_fields(client_db, people, form):
    owner = people["owner"]
    photo = _attach(form, owner["id"])
    first = _create(client_db, form, owner, label="NB shoulder", length_ft=12.5, width_in=0.75,
                    horizontal_disp_in=1, vertical_disp_in=2.25, depth_in=6, trend_deg=215, orientation="TRANSVERSE",
                    latitude=37.7312, longitude=-122.1975, location_source="PHOTO", photo_attachment_id=photo,
                    annotations_json={"shapes": [{"type": "label", "at": [0.5, 0.4], "measure": "length_ft"}]})
    assert first.status_code == 201, first.text
    crack = first.json()["crack"]
    assert crack["sort_order"] == 1 and crack["revision"] == 1
    assert crack["length_ft"] == 12.5 and crack["width_in"] == 0.75 and crack["trend_deg"] == 35.0
    assert crack["photo_attachment_id"] == photo
    assert crack["annotations_json"]["shapes"][0]["measure"] == "length_ft"

    second = _create(client_db, form, owner, label="Toe of slope", length_ft=4)
    assert second.status_code == 201, second.text
    assert second.json()["crack"]["sort_order"] == 2

    listed = client_db.get(f"/submissions/{form}/cracks", headers=owner["headers"]).json()["items"]
    assert [c["label"] for c in listed] == ["NB shoulder", "Toe of slope"]
    detail = client_db.get(f"/submissions/{form}", headers=owner["headers"]).json()
    assert [c["id"] for c in detail["cracks"]] == [c["id"] for c in listed]
    # A recorded crack answers "Pavement/Ground Cracks" with Yes.
    assert detail["gisa"]["pavement_ground_cracks"] in (1, True)
    assert "crack_length_ft" not in detail["gisa"]


def test_sending_the_same_crack_again_does_not_make_a_second_one(client_db, people, form):
    owner = people["owner"]
    client_uuid = str(uuid.uuid4())
    body = {"client_uuid": client_uuid, "length_ft": 3}
    first = client_db.post(f"/submissions/{form}/cracks", json=body, headers=owner["headers"])
    again = client_db.post(f"/submissions/{form}/cracks", json=body, headers=owner["headers"])
    assert first.status_code == 201 and again.json()["idempotent_replay"] is True
    assert again.json()["crack"]["id"] == first.json()["crack"]["id"]
    assert len(client_db.get(f"/submissions/{form}/cracks", headers=owner["headers"]).json()["items"]) == 1


def test_an_edit_on_a_stale_copy_is_refused_with_the_saved_crack(client_db, people, form):
    owner = people["owner"]
    crack = _create(client_db, form, owner, length_ft=3).json()["crack"]
    url = f"/submissions/{form}/cracks/{crack['id']}"
    saved = client_db.patch(url, json={"revision": 1, "depth_in": 4}, headers=owner["headers"])
    assert saved.status_code == 200 and saved.json()["crack"]["revision"] == 2, saved.text
    stale = client_db.patch(url, json={"revision": 1, "depth_in": 9}, headers=owner["headers"])
    assert stale.status_code == 409, stale.text
    assert stale.json()["detail"]["crack"]["depth_in"] == 4.0
    missing = client_db.patch(url, json={"depth_in": 9}, headers=owner["headers"])
    assert missing.status_code == 422


def test_a_crack_photo_must_be_a_photo_of_the_same_form(client_db, people, form):
    owner = people["owner"]
    other_form = client_db.post("/submissions", json={"title": "Other"}, headers=owner["headers"]).json()["submission_id"]
    elsewhere = _attach(other_form, owner["id"])
    document = _attach(form, owner["id"], kind="DOC")
    for attachment in (elsewhere, document):
        refused = _create(client_db, form, owner, photo_attachment_id=attachment)
        assert refused.status_code == 422, refused.text


def test_deleting_a_crack_keeps_its_photo_on_the_form(client_db, people, form):
    owner = people["owner"]
    photo = _attach(form, owner["id"])
    crack = _create(client_db, form, owner, photo_attachment_id=photo).json()["crack"]
    deleted = client_db.delete(f"/submissions/{form}/cracks/{crack['id']}", headers=owner["headers"])
    assert deleted.status_code == 200, deleted.text
    assert client_db.get(f"/submissions/{form}/cracks", headers=owner["headers"]).json()["items"] == []
    photos = [p["id"] for p in client_db.get(f"/submissions/{form}", headers=owner["headers"]).json()["photos"]]
    assert photo in photos


def test_only_those_who_may_edit_the_draft_change_its_cracks(client_db, people, form):
    owner, outsider = people["owner"], people["outsider"]
    crack = _create(client_db, form, owner, length_ft=3).json()["crack"]
    assert _create(client_db, form, outsider, length_ft=1).status_code == 403
    assert client_db.delete(f"/submissions/{form}/cracks/{crack['id']}", headers=outsider["headers"]).status_code == 403
    # Once submitted, the form and its cracks are fixed.
    _db("UPDATE submissions SET status = 'SUBMITTED' WHERE id = :sid", sid=form)
    try:
        assert _create(client_db, form, owner, length_ft=1).status_code == 409
        patched = client_db.patch(f"/submissions/{form}/cracks/{crack['id']}", json={"revision": 1, "depth_in": 2},
                                  headers=owner["headers"])
        assert patched.status_code == 409
    finally:
        _db("UPDATE submissions SET status = 'DRAFT' WHERE id = :sid", sid=form)


def test_the_upgrade_turns_a_forms_single_crack_into_its_crack_1(client_db, people, form):
    """Runs the migration's move against the old columns, put back for the test."""
    spec = importlib.util.spec_from_file_location("cracks_migration", MIGRATION)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    from app.db import engine

    owner = people["owner"]
    assert client_db.patch(f"/submissions/{form}/gisa", json={"ea": "0A1234"}, headers=owner["headers"]).status_code == 200
    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE submission_gisa " + ", ".join(
            f"ADD COLUMN IF NOT EXISTS {column} DECIMAL(10,2) NULL" for column in migration.OLD_COLUMNS)))
    try:
        _db("""UPDATE submission_gisa SET crack_length_ft = 8.5, crack_horizontal_in = 1.25, crack_depth_in = 3,
               pavement_ground_cracks = 0 WHERE submission_id = :sid""", sid=form)
        with engine.begin() as conn:
            migration.move_old_crack_columns(conn)
        cracks = client_db.get(f"/submissions/{form}/cracks", headers=owner["headers"]).json()["items"]
        assert len(cracks) == 1
        assert (cracks[0]["sort_order"], cracks[0]["length_ft"], cracks[0]["horizontal_disp_in"],
                cracks[0]["vertical_disp_in"], cracks[0]["depth_in"]) == (1, 8.5, 1.25, None, 3.0)
        assert cracks[0]["created_by_user_id"] == owner["id"]
        gisa = client_db.get(f"/submissions/{form}", headers=owner["headers"]).json()["gisa"]
        assert gisa["pavement_ground_cracks"] in (1, True) and "crack_length_ft" not in gisa
        # Running it again moves nothing twice.
        with engine.begin() as conn:
            migration.move_old_crack_columns(conn)
        assert len(client_db.get(f"/submissions/{form}/cracks", headers=owner["headers"]).json()["items"]) == 1
    finally:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE submission_gisa " + ", ".join(
                f"DROP COLUMN IF EXISTS {column}" for column in migration.OLD_COLUMNS)))
