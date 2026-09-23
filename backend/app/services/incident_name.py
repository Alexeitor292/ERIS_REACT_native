"""An incident is named by where and when it was seen, never by a typed title:
District-County-Route-PostMile - MM/DD/YY, e.g. "04-MRN-001-12.300 - 09/22/26".
The date is the day it was first observed, as the reporter entered it."""
from __future__ import annotations

import re
from datetime import date, datetime

from ..precision import normalize_post_mile, normalize_route

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


def _district(value: object | None) -> str:
    raw = str(value or "").strip()
    digits = "".join(ch for ch in raw if ch.isdigit())
    return digits.zfill(2) if digits else (raw or "?")


def _county(value: object | None) -> str:
    raw = re.sub(r"\s+County$", "", str(value or "").strip(), flags=re.IGNORECASE)
    return _COUNTY_CODES.get(raw.lower()) or raw.upper() or "?"


def _day(value: object | None) -> str:
    if isinstance(value, (datetime, date)):
        return value.strftime("%m/%d/%y")
    text = str(value or "").strip()
    try:
        return datetime.fromisoformat(text[:10]).strftime("%m/%d/%y")
    except ValueError:
        return ""


def incident_name(*, district: object, county: object, route: object, post_mile: object, observed_at: object) -> str:
    base = "-".join((
        _district(district),
        _county(county),
        normalize_route(route) or "?",
        normalize_post_mile(post_mile) or "?",
    ))
    day = _day(observed_at)
    return f"{base} - {day}" if day else base
