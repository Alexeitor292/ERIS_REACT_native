"""Apple Push Notification service (APNs) for the native ERIS iOS app.

Token-based provider authentication: the API signs a short-lived ES256 JWT
with the APNs auth key (``.p8``) from Caltrans's Apple developer account, so no
push certificate has to be renewed every year. The key lives in the private
secrets folder (``deploy/podman/secrets``), never in an env file or image.
APNs requires HTTP/2.

Device tokens are registered by the app as platform ``apns`` (production
gateway: App Store, in-house and TestFlight builds) or ``apns-sandbox``
(builds run from Xcode). Never logs a device token or a message body.
"""
from __future__ import annotations

import json
import logging
import re
import threading
import time
from dataclasses import dataclass

import httpx
from jose import jwt

from ..config import settings

logger = logging.getLogger("eris.push")

PLATFORMS = {"apns": "https://api.push.apple.com", "apns-sandbox": "https://api.sandbox.push.apple.com"}
DEVICE_TOKEN = re.compile(r"^[0-9a-fA-F]{64,200}$")
# Apple: refresh the provider token at most every 20 minutes, and before 60.
_TOKEN_LIFETIME_S = 45 * 60
# Reasons Apple gives when a device token will never work again.
_DEAD_TOKEN_REASONS = {"BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"}

_lock = threading.Lock()
_cached: tuple[str, float] | None = None


def configured() -> bool:
    return bool(settings.APNS_ENABLED and settings.APNS_KEY_FILE and settings.APNS_KEY_ID
                and settings.APNS_TEAM_ID and settings.APNS_TOPIC)


def provider_token(now: float | None = None) -> str:
    """The ES256 provider JWT, reused until it is 45 minutes old."""
    global _cached
    now = time.time() if now is None else now
    with _lock:
        if _cached and now - _cached[1] < _TOKEN_LIFETIME_S:
            return _cached[0]
        with open(settings.APNS_KEY_FILE, "r", encoding="ascii") as handle:
            key = handle.read()
        token = jwt.encode({"iss": settings.APNS_TEAM_ID, "iat": int(now)}, key, algorithm="ES256",
                           headers={"kid": settings.APNS_KEY_ID})
        _cached = (token, now)
        return token


def forget_provider_token() -> None:
    global _cached
    with _lock:
        _cached = None


def payload(title: str, body: str, link: str | None, notification_id: int) -> bytes:
    # content-available: iOS also wakes the app in the background, so it can
    # fetch what the notice is about (new work assigned) before it is opened.
    return json.dumps({
        "aps": {"alert": {"title": title, "body": body}, "sound": "default", "content-available": 1},
        "link": link,
        "id": notification_id,
    }, separators=(",", ":")).encode("utf-8")


@dataclass
class Result:
    delivered: bool
    retire_token: bool = False
    retry_later: bool = False


def _client() -> httpx.Client:
    return httpx.Client(http2=True, timeout=15)


def send(deliveries: list[tuple[str, str, bytes]]) -> list[Result]:
    """Send (platform, device_token, payload) tuples. Never raises."""
    results: list[Result] = []
    try:
        client = _client()
    except Exception as exc:  # e.g. the h2 package missing
        logger.warning("APNs unavailable: %s", type(exc).__name__)
        return [Result(delivered=False, retry_later=True) for _ in deliveries]
    with client:
        for platform, device_token, body in deliveries:
            try:
                response = client.post(
                    f"{PLATFORMS[platform]}/3/device/{device_token}",
                    content=body,
                    headers={
                        "authorization": f"bearer {provider_token()}",
                        "apns-topic": settings.APNS_TOPIC,
                        "apns-push-type": "alert",
                        "apns-priority": "10",
                    },
                )
            except Exception as exc:  # network: try again next round
                logger.warning("APNs request failed: %s", type(exc).__name__)
                results.append(Result(delivered=False, retry_later=True))
                continue
            if response.status_code == 200:
                results.append(Result(delivered=True))
                continue
            try:
                reason = str(response.json().get("reason") or "")
            except ValueError:
                reason = ""
            if response.status_code == 410 or reason in _DEAD_TOKEN_REASONS:
                results.append(Result(delivered=False, retire_token=True))
            elif response.status_code in {403, 429} or response.status_code >= 500:
                # 403 ExpiredProviderToken / InvalidProviderToken: mint a new one.
                if response.status_code == 403:
                    forget_provider_token()
                logger.warning("APNs refused a push (%s %s); retrying later", response.status_code, reason)
                results.append(Result(delivered=False, retry_later=True))
            else:
                logger.warning("APNs rejected a push (%s %s)", response.status_code, reason)
                results.append(Result(delivered=False))
    return results
