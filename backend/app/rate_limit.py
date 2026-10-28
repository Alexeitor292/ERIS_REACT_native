"""Per-client rate limits for the sign-in routes.

Entra already stops password guessing, but the sign-in routes are the only ones
an anonymous caller can reach, and each Entra exchange makes the API fetch and
verify tokens. A sliding window per client address keeps one caller from
tying them up. The API runs as a single uvicorn process, so an in-memory window
covers every request; a second process would get its own windows.

The client address: nginx in the pod appends the address it saw to
X-Forwarded-For, and the Caltrans gateway in front of it does the same, so the
entry ``TRUSTED_PROXY_HOPS`` from the right is the one the outermost trusted
proxy recorded. Entries further left came from the client and are ignored.
"""
from __future__ import annotations

import math
import threading
import time
from collections import OrderedDict, deque

from fastapi import HTTPException, Request, status

from .config import settings


class SlidingWindowLimiter:
    """At most ``limit`` hits per key in any ``window`` seconds. Thread-safe and bounded."""

    def __init__(self, limit: int, window: float = 60.0, max_keys: int = 10_000):
        self.limit = limit
        self.window = window
        self.max_keys = max_keys
        self._hits: OrderedDict[str, deque[float]] = OrderedDict()
        self._lock = threading.Lock()

    def hit(self, key: str, now: float | None = None) -> float | None:
        """Record a hit; return None if allowed, else the seconds until the next one is."""
        if self.limit <= 0:
            return None
        now = time.monotonic() if now is None else now
        with self._lock:
            hits = self._hits.pop(key, None) or deque()
            while hits and hits[0] <= now - self.window:
                hits.popleft()
            if len(hits) >= self.limit:
                self._hits[key] = hits
                return max(0.0, hits[0] + self.window - now)
            hits.append(now)
            self._hits[key] = hits
            # Least recently used first: a flood of new addresses evicts idle ones,
            # never an address that is being limited right now.
            while len(self._hits) > self.max_keys:
                self._hits.popitem(last=False)
            return None

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


def client_address(request: Request) -> str:
    peer = request.client.host if request.client else ""
    hops = max(0, int(settings.TRUSTED_PROXY_HOPS))
    forwarded = [part.strip() for part in (request.headers.get("x-forwarded-for") or "").split(",") if part.strip()]
    if hops and forwarded:
        return forwarded[max(0, len(forwarded) - hops)]
    return peer or "unknown"


sign_in_limiter = SlidingWindowLimiter(settings.AUTH_RATE_LIMIT_PER_MINUTE)


def limit_sign_in(request: Request) -> None:
    """Dependency for the anonymous sign-in routes: 429 with Retry-After when exceeded."""
    retry_after = sign_in_limiter.hit(client_address(request))
    if retry_after is not None:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Too many sign-in attempts. Wait a minute and try again.",
            headers={"Retry-After": str(max(1, math.ceil(retry_after)))},
        )
