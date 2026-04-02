from __future__ import annotations

import json
import re
from typing import Any


def normalize_profile_text(raw: Any) -> str | None:
    text_value = str(raw or "").strip()
    if not text_value:
        return None
    return re.sub(r"\s+", " ", text_value)


def normalize_district_code(raw: Any) -> str | None:
    value = normalize_profile_text(raw)
    if not value:
        return None
    match = re.search(r"(\d{1,2})", value)
    if not match:
        return value
    return match.group(1).zfill(2)


def normalize_office_code(raw: Any) -> str | None:
    value = normalize_profile_text(raw)
    return value.upper() if value else None


def parse_user_metadata(raw: Any) -> dict[str, str | None]:
    record: dict[str, Any]
    if raw is None:
        record = {}
    elif isinstance(raw, dict):
        record = raw
    elif isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            record = parsed if isinstance(parsed, dict) else {}
        except Exception:
            record = {}
    else:
        record = {}

    return {
        "district": normalize_district_code(record.get("district")),
        "office_code": normalize_office_code(record.get("office_code")),
        "office_location": normalize_profile_text(record.get("office_location")),
    }


def user_metadata_json(raw: Any) -> str | None:
    metadata = parse_user_metadata(raw)
    if not any(metadata.values()):
        return None
    return json.dumps(metadata)
