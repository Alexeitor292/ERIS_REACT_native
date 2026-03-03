from fastapi import HTTPException

from ..constants.gisa_lookups import (
    GISA_ACTION_CODE_TO_GROUP,
    GISA_DISTRIBUTION_CODES,
    GISA_HIGHWAY_STATUS_CODES,
    GISA_INCIDENT_TYPE_CODES,
)


def validate_distribution_code(code: str | None) -> None:
    if code and code not in GISA_DISTRIBUTION_CODES:
        raise HTTPException(status_code=400, detail=f"Invalid code: {code}")


def validate_highway_status_code(code: str | None) -> None:
    if code and code not in GISA_HIGHWAY_STATUS_CODES:
        raise HTTPException(status_code=400, detail=f"Invalid code: {code}")


def validate_incident_type_codes(codes: list[str]) -> None:
    for code in codes:
        if code not in GISA_INCIDENT_TYPE_CODES:
            raise HTTPException(status_code=400, detail=f"Invalid incident type: {code}")


def validate_action_code_group(code: str, expected_group: str) -> None:
    actual_group = GISA_ACTION_CODE_TO_GROUP.get(code)
    if not actual_group:
        raise HTTPException(status_code=400, detail=f"Invalid action: {code}")
    if actual_group != expected_group:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid action group for {code}: expected {expected_group}",
        )
