"""No-DB unit tests for the notification renderer (design §6.4, §6.5).

``render()`` builds every message from the payload recorded WITH the
notification row, so a coordinator's email describes the assessment as it was
at approval — not as it looks whenever the sweeper happens to run. Two
properties make that safe and are asserted here: the wording is exactly §6.5's,
and a payload with a hole in it degrades to an em dash instead of raising,
because one un-renderable row must never stall the outbox.

These run in the default (no-database) job.
"""

import pytest

from app.config import settings
from app.services import notifications


_PAYLOAD = {
    "assessment_id": 12,
    "incident_id": 24,
    "incident_key": "INC-2026-0042",
    "routing_path": "SENIOR_ENGINEER",
    "district": "07",
    "office_code": "SOUTH",
    "office_location": "South Office",
    "route_label": "District 7 · Los Angeles · Route 101 · PM 12.30",
    "approved_by_name": "Sofia Ruiz",
    "approved_by_role": "GeoTech Office Chief",
    "approved_at": "2026-09-10 14:02:11",
}


@pytest.fixture(autouse=True)
def fixed_web_base_url(monkeypatch):
    """Pin the deep-link base so the body assertions do not depend on the
    environment the test happens to run in."""
    monkeypatch.setattr(settings, "WEB_BASE_URL", "https://eris.test")


class TestApprovedCoordinatorTemplate:
    def test_subject_and_body_match_the_documented_wording(self):
        subject, body = notifications.render(
            "ASSESSMENT_APPROVED_COORDINATOR", _PAYLOAD, {"full_name": "Local Coordinator D04"}
        )
        assert subject == (
            "ERIS INC-2026-0042 — GeoTech assessment approved "
            "(District 7 · Los Angeles · Route 101 · PM 12.30)"
        )
        assert body == (
            "The GeoTech assessment for INC-2026-0042 has been approved.\n"
            "\n"
            "  Report          INC-2026-0042 — District 7 · Los Angeles · Route 101 · PM 12.30\n"
            "  District        07\n"
            "  GeoTech office  South Office (SOUTH)\n"
            "  Approved by     Sofia Ruiz, GeoTech Office Chief\n"
            "  Approved on     2026-09-10 14:02:11\n"
            "\n"
            "The assessment is complete. No further GeoTech action is required.\n"
            "Open it in ERIS: https://eris.test/assessments/12\n"
            "\n"
            "This is an automated message from ERIS. Do not reply.\n"
        )

    @pytest.mark.parametrize(
        "missing", ["office_location", "route_label", "district", "approved_by_role", "approved_at"]
    )
    def test_a_missing_optional_field_degrades_to_an_em_dash(self, missing):
        payload = {key: value for key, value in _PAYLOAD.items() if key != missing}
        subject, body = notifications.render("ASSESSMENT_APPROVED_COORDINATOR", payload)
        assert notifications.EM_DASH in (subject + body)
        # ...and never leaks the literal None or raises.
        assert "None" not in body

    def test_an_empty_string_is_treated_as_missing(self):
        payload = dict(_PAYLOAD, office_location="   ")
        _subject, body = notifications.render("ASSESSMENT_APPROVED_COORDINATOR", payload)
        assert f"GeoTech office  {notifications.EM_DASH} (SOUTH)" in body

    def test_an_empty_payload_still_renders(self):
        # The row a future template writes badly must still be deliverable.
        subject, body = notifications.render("ASSESSMENT_APPROVED_COORDINATOR", None)
        assert subject.startswith("ERIS ")
        assert notifications.EM_DASH in body
        # With no assessment_id the link degrades to the site root, not a
        # broken /assessments/None.
        assert "assessments/None" not in body

    def test_an_unknown_template_code_falls_back_instead_of_raising(self):
        subject, body = notifications.render("SOME_FUTURE_TEMPLATE", _PAYLOAD)
        assert subject == "ERIS INC-2026-0042 — notification"
        assert "SOME_FUTURE_TEMPLATE" in body
        assert "https://eris.test/assessments/12" in body


class TestDeliverySwitches:
    def test_smtp_host_is_the_master_switch(self, monkeypatch):
        monkeypatch.setattr(settings, "SMTP_HOST", None)
        monkeypatch.setattr(settings, "MAIL_DEV_DUMP_DIR", None)
        assert notifications.email_enabled() is False
        assert notifications.delivery_configured() is False

        monkeypatch.setattr(settings, "SMTP_HOST", "   ")
        assert notifications.email_enabled() is False, "a blank host is still unset"

        monkeypatch.setattr(settings, "SMTP_HOST", "relay.example.test")
        assert notifications.email_enabled() is True
        assert notifications.delivery_configured() is True

    def test_a_dump_dir_makes_the_path_runnable_without_a_relay(self, monkeypatch, tmp_path):
        monkeypatch.setattr(settings, "SMTP_HOST", None)
        monkeypatch.setattr(settings, "MAIL_DEV_DUMP_DIR", str(tmp_path))
        assert notifications.email_enabled() is False
        assert notifications.delivery_configured() is True

        subject, body = notifications.render("ASSESSMENT_APPROVED_COORDINATOR", _PAYLOAD)
        notifications.send_email("coordinator04@local", subject, body)
        written = list(tmp_path.glob("*.eml"))
        assert len(written) == 1
        raw = written[0].read_bytes()
        assert b"To: coordinator04@local" in raw
        assert b"Auto-Submitted: auto-generated" in raw

    def test_sending_with_no_relay_and_no_dump_dir_raises(self, monkeypatch):
        # send_email RAISES on failure by design: deliver_pending is the only
        # caller and it is what records the attempt.
        monkeypatch.setattr(settings, "SMTP_HOST", None)
        monkeypatch.setattr(settings, "MAIL_DEV_DUMP_DIR", None)
        with pytest.raises(RuntimeError):
            notifications.send_email("someone@example.test", "subject", "body")

    def test_a_recipient_with_no_address_raises_before_any_connection(self, monkeypatch):
        monkeypatch.setattr(settings, "SMTP_HOST", "relay.example.test")
        with pytest.raises(ValueError):
            notifications.send_email("   ", "subject", "body")

    def test_flush_after_commit_never_raises(self, monkeypatch):
        monkeypatch.setattr(settings, "SMTP_HOST", None)
        monkeypatch.setattr(settings, "MAIL_DEV_DUMP_DIR", None)
        # Disabled: returns without touching the database at all.
        assert notifications.flush_after_commit([1, 2, 3]) is None

        monkeypatch.setattr(settings, "SMTP_HOST", "relay.example.test")

        def _explode():
            raise RuntimeError("no database here")

        monkeypatch.setattr("app.db.SessionLocal", _explode)
        # A background task must never surface, whatever goes wrong inside it.
        assert notifications.flush_after_commit([1]) is None
        assert notifications.sweep_startup()["attempted"] == 0
