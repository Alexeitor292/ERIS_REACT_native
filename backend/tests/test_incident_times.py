"""Times a client sends for an incident are stored on the server's clock (no database).

DATETIME columns carry no zone and the server runs in Pacific time, so a zoned
time (the iPhone sends UTC) must become the Pacific clock reading; a naive one
(the web's datetime-local) is already Pacific and stays as sent.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.schemas.common import IncidentCreate
from app.timezones import server_naive

FIELDS = dict(latitude=37.6, longitude=-121.9, district="04", county="ALA", route="84", post_mile="5.2")


def test_a_utc_time_is_stored_as_the_pacific_clock(monkeypatch):
    monkeypatch.setenv("TZ", "America/Los_Angeles")
    incident = IncidentCreate(first_observed_at="2026-10-28T06:30:00Z", first_occurred_at="2026-07-01T19:00:00+00:00", **FIELDS)
    assert incident.first_observed_at == datetime(2026, 10, 27, 23, 30)  # PDT, UTC-7
    assert incident.first_occurred_at == datetime(2026, 7, 1, 12, 0)
    winter = IncidentCreate(first_observed_at="2026-12-01T18:00:00Z", **FIELDS)
    assert winter.first_observed_at == datetime(2026, 12, 1, 10, 0)  # PST, UTC-8


def test_a_time_without_a_zone_is_kept_as_sent(monkeypatch):
    monkeypatch.setenv("TZ", "America/Los_Angeles")
    incident = IncidentCreate(first_observed_at="2026-10-28T06:30", **FIELDS)
    assert incident.first_observed_at == datetime(2026, 10, 28, 6, 30)
    assert incident.first_occurred_at is None


def test_the_deploy_zone_is_used_and_a_bad_one_falls_back(monkeypatch):
    sent = datetime(2026, 10, 28, 6, 30, tzinfo=timezone.utc)
    monkeypatch.setenv("TZ", "America/New_York")
    assert server_naive(sent) == datetime(2026, 10, 28, 2, 30)
    monkeypatch.setenv("TZ", "Not/AZone")
    assert server_naive(sent) == datetime(2026, 10, 27, 23, 30)
    assert server_naive(datetime(2026, 1, 1, tzinfo=timezone(timedelta(hours=-8)))) == datetime(2026, 1, 1)
