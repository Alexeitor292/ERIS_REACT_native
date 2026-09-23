"""Incidents are named District-County-Route-PostMile - MM/DD/YY, never by a typed title."""
from __future__ import annotations

import importlib.util
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

from app.services.incident_name import incident_name


def test_the_name_is_where_and_the_day_it_was_first_seen():
    name = incident_name(district="04", county="MRN", route="1", post_mile="12.3", observed_at=datetime(2026, 9, 22, 6, 40))
    assert name == "04-MRN-001-12.300 - 09/22/26"


def test_stored_forms_come_out_the_same():
    assert incident_name(district="District 4", county="Marin County", route="SR-101", post_mile="R2.1", observed_at="2026-09-22T06:40:00") == "04-MRN-101-R2.1 - 09/22/26"
    assert incident_name(district="11", county="san luis obispo", route="1", post_mile="3", observed_at=None) == "11-SLO-001-3.000"
    assert incident_name(district="11", county="sd", route="94", post_mile="45", observed_at=None) == "11-SD-094-45.000"


def test_the_migration_names_existing_incidents_the_same_way():
    path = Path(__file__).resolve().parents[1] / "migrations" / "versions" / "20260927_incident_names.py"
    spec = importlib.util.spec_from_file_location("incident_names_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    cases = [
        dict(district="04", county="MRN", route="1", post_mile="12.3", first_observed_at=datetime(2026, 9, 22, 6, 40)),
        dict(district="District 4", county="Marin County", route="SR-101", post_mile="R2.1", first_observed_at="2026-09-22"),
        dict(district="11", county="sd", route="94", post_mile="45", first_observed_at=None),
    ]
    for case in cases:
        expected = incident_name(district=case["district"], county=case["county"], route=case["route"], post_mile=case["post_mile"], observed_at=case["first_observed_at"])
        assert migration._name(SimpleNamespace(**case)) == expected
