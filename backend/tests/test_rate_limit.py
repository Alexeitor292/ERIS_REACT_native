"""Sign-in rate limits (app/rate_limit.py) and the API's default response headers."""
from types import SimpleNamespace

import pytest

from app import rate_limit
from app.rate_limit import SlidingWindowLimiter, client_address


def _request(peer="10.0.0.9", forwarded=None):
    headers = {"x-forwarded-for": forwarded} if forwarded is not None else {}
    return SimpleNamespace(client=SimpleNamespace(host=peer), headers=headers)


def test_window_allows_the_limit_then_refuses_until_the_oldest_hit_expires():
    limiter = SlidingWindowLimiter(limit=3, window=60)
    assert [limiter.hit("a", now=t) for t in (0, 1, 2)] == [None, None, None]
    assert limiter.hit("a", now=10) == pytest.approx(50)
    assert limiter.hit("b", now=10) is None  # other clients are unaffected
    assert limiter.hit("a", now=60.5) is None  # the hit at 0 has left the window


def test_refused_hits_do_not_extend_the_wait():
    limiter = SlidingWindowLimiter(limit=1, window=60)
    assert limiter.hit("a", now=0) is None
    for t in (5, 10, 30):
        assert limiter.hit("a", now=t) is not None
    assert limiter.hit("a", now=61) is None


def test_zero_turns_the_limit_off():
    limiter = SlidingWindowLimiter(limit=0)
    assert all(limiter.hit("a", now=0) is None for _ in range(100))


def test_memory_is_bounded_and_evicts_idle_clients_first():
    limiter = SlidingWindowLimiter(limit=1, window=60, max_keys=2)
    limiter.hit("old", now=0)
    limiter.hit("busy", now=1)
    limiter.hit("busy", now=2)  # refused, but marks it recently used
    limiter.hit("new", now=3)
    assert set(limiter._hits) == {"busy", "new"}


def test_client_address_uses_the_entry_the_outermost_trusted_proxy_added(monkeypatch):
    monkeypatch.setattr(rate_limit.settings, "TRUSTED_PROXY_HOPS", 2)
    # A client-supplied entry, the gateway's view of the client, nginx's view of the gateway.
    assert client_address(_request("127.0.0.1", "6.6.6.6, 10.1.2.3, 10.9.9.9")) == "10.1.2.3"
    # Fewer entries than hops: the leftmost one.
    assert client_address(_request("127.0.0.1", "10.1.2.3")) == "10.1.2.3"
    monkeypatch.setattr(rate_limit.settings, "TRUSTED_PROXY_HOPS", 1)
    assert client_address(_request("127.0.0.1", "6.6.6.6, 10.1.2.3")) == "10.1.2.3"


def test_client_address_ignores_the_header_without_trusted_proxies(monkeypatch):
    monkeypatch.setattr(rate_limit.settings, "TRUSTED_PROXY_HOPS", 0)
    assert client_address(_request("10.0.0.9", "6.6.6.6")) == "10.0.0.9"
    monkeypatch.setattr(rate_limit.settings, "TRUSTED_PROXY_HOPS", 1)
    assert client_address(_request("10.0.0.9")) == "10.0.0.9"


@pytest.mark.parametrize("method,path", [
    ("GET", "/auth/entra/start"),
    ("GET", "/auth/entra/callback"),
    ("POST", "/auth/entra/native"),
    ("POST", "/auth/login"),
])
def test_every_sign_in_route_is_limited(method, path):
    from app.main import app
    from tests.route_table import api_routes

    route = next(r for r in api_routes(app) if getattr(r, "path", None) == path and method in getattr(r, "methods", ()))
    limits = {rate_limit.limit_sign_in, rate_limit.limit_sign_in_navigation}
    assert any(d.call in limits for d in route.dependant.dependencies), path


def test_the_api_answers_429_with_retry_after(client, sign_in_rate_limit_off, monkeypatch):
    monkeypatch.setattr(sign_in_rate_limit_off, "limit", 2)
    statuses = [client.post("/auth/entra/native", json={}).status_code for _ in range(2)]
    assert 429 not in statuses
    refused = client.post("/auth/entra/native", json={})
    assert refused.status_code == 429
    assert 1 <= int(refused.headers["retry-after"]) <= 60
    assert "Too many sign-in attempts" in refused.json()["detail"]


def test_a_limited_browser_navigation_returns_to_the_sign_in_page(client, sign_in_rate_limit_off, monkeypatch):
    monkeypatch.setattr(sign_in_rate_limit_off, "limit", 1)
    client.get("/auth/entra/start", follow_redirects=False)
    refused = client.get("/auth/entra/start", follow_redirects=False)
    assert refused.status_code == 303
    assert refused.headers["location"].endswith("/login?entra=busy")
    assert int(refused.headers["retry-after"]) >= 1


def test_api_responses_are_not_cached_or_sniffed(client):
    response = client.get("/health")
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
