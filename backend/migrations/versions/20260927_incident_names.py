"""Incidents are named by where and when they were seen, not by a typed title.

Revision ID: 20260927_incident_names
Revises: 20260926_org_tree
Create Date: 2026-09-27

Reporters no longer type a title. Every incident's ``title`` becomes
District-County-Route-PostMile - MM/DD/YY (the day it was first observed), the
same name ``services/incident_name.py`` gives new reports, e.g.
"04-MRN-001-12.300 - 09/22/26". Typed titles are replaced; the description is
untouched.

The formatter is copied here on purpose: a migration must keep doing what it
did when it was written.

Idempotent: re-running changes nothing.
"""

import re
from datetime import date, datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

from alembic import op
from sqlalchemy import text

revision = "20260927_incident_names"
down_revision = "20260926_org_tree"
branch_labels = None
depends_on = None

# The 58 counties' Caltrans codes, for reports that stored the county's name.
_COUNTY_CODES = {
    name.lower(): code
    for name, code in (pair.split("=") for pair in (
    "Alameda=ALA;Alpine=ALP;Amador=AMA;Butte=BUT;Calaveras=CAL;Colusa=COL;Contra Costa=CC;Del Norte=DN;"
    "El Dorado=ED;Fresno=FRE;Glenn=GLE;Humboldt=HUM;Imperial=IMP;Inyo=INY;Kern=KER;Kings=KIN;Lake=LAK;"
    "Lassen=LAS;Los Angeles=LA;Madera=MAD;Marin=MRN;Mariposa=MPA;Mendocino=MEN;Merced=MER;Modoc=MOD;Mono=MNO;"
    "Monterey=MON;Napa=NAP;Nevada=NEV;Orange=ORA;Placer=PLA;Plumas=PLU;Riverside=RIV;Sacramento=SAC;"
    "San Benito=SBT;San Bernardino=SBD;San Diego=SD;San Francisco=SF;San Joaquin=SJ;San Luis Obispo=SLO;"
    "San Mateo=SM;Santa Barbara=SB;Santa Clara=SCL;Santa Cruz=SCR;Shasta=SHA;Sierra=SIE;Siskiyou=SIS;"
    "Solano=SOL;Sonoma=SON;Stanislaus=STA;Sutter=SUT;Tehama=TEH;Trinity=TRI;Tulare=TUL;Tuolumne=TUO;"
    "Ventura=VEN;Yolo=YOL;Yuba=YUB"
    ).split(";"))
}


def _district(value) -> str:
    raw = str(value or "").strip()
    digits = "".join(ch for ch in raw if ch.isdigit())
    return digits.zfill(2) if digits else (raw or "?")


def _county(value) -> str:
    raw = re.sub(r"\s+County$", "", str(value or "").strip(), flags=re.IGNORECASE)
    return _COUNTY_CODES.get(raw.lower()) or raw.upper() or "?"


def _route(value) -> str:
    raw = str(value or "").strip()
    digits = "".join(ch for ch in raw if ch.isdigit())
    return digits[:3].zfill(3) if digits else (raw or "?")


def _post_mile(value) -> str:
    raw = str(value or "").strip()
    if not raw:
        return "?"
    try:
        return format(Decimal(raw).quantize(Decimal("0.001"), rounding=ROUND_HALF_UP), ".3f")
    except (InvalidOperation, ValueError):
        return raw


def _day(value) -> str:
    if isinstance(value, (datetime, date)):
        return value.strftime("%m/%d/%y")
    try:
        return datetime.fromisoformat(str(value or "").strip()[:10]).strftime("%m/%d/%y")
    except ValueError:
        return ""


def _name(row) -> str:
    base = "-".join((_district(row.district), _county(row.county), _route(row.route), _post_mile(row.post_mile)))
    day = _day(row.first_observed_at)
    return f"{base} - {day}" if day else base


def upgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(
        text("SELECT id, title, district, county, route, post_mile, first_observed_at FROM incidents")
    ).fetchall()
    for row in rows:
        name = _name(row)
        if row.title != name:
            bind.execute(text("UPDATE incidents SET title = :title WHERE id = :id"), {"title": name, "id": row.id})


def downgrade() -> None:
    # The typed titles are gone; the generated names stay.
    pass
