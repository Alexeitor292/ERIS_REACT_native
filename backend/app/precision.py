from __future__ import annotations

from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

POST_MILE_DECIMALS = 3
COORDINATE_DECIMALS = 6


def _clean_text(value: object | None) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _quantized_decimal(value: object | None, decimals: int) -> Decimal | None:
    text = _clean_text(value)
    if text is None:
        return None
    try:
        quantizer = Decimal("1").scaleb(-decimals)
        return Decimal(text).quantize(quantizer, rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError):
        return None


def normalize_post_mile(value: object | None) -> str | None:
    text = _clean_text(value)
    if text is None:
        return None
    quantized = _quantized_decimal(text, POST_MILE_DECIMALS)
    if quantized is None:
        return text
    return format(quantized, f".{POST_MILE_DECIMALS}f")


def round_coordinate(value: object | None) -> float | None:
    quantized = _quantized_decimal(value, COORDINATE_DECIMALS)
    if quantized is None:
        return None
    return float(quantized)


def coordinates_differ(left: object | None, right: object | None) -> bool:
    return round_coordinate(left) != round_coordinate(right)
