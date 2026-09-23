"""Every APIRoute an app serves, whichever way the framework holds included routers.

Starlette < 1.0 copies an included router's routes into ``app.routes`` with their
full paths. Starlette 1.x wraps each included router instead (``original_router``)
and keeps its path prefix on ``include_context`` (for a router included inside
another router, that prefix already carries the outer router's). Tests that walk
the route table use this, so an upgrade cannot quietly shrink what they check.
"""
from __future__ import annotations

import copy

from fastapi.routing import APIRoute


def api_routes(app) -> list[APIRoute]:
    found: list[APIRoute] = []

    def walk(routes, prefix: str) -> None:
        for route in routes:
            if isinstance(route, APIRoute):
                if prefix:
                    route = copy.copy(route)
                    route.path = prefix + route.path
                found.append(route)
            elif hasattr(route, "original_router"):
                include = getattr(getattr(route, "include_context", None), "prefix", "") or ""
                walk(route.original_router.routes, prefix + include)
            elif hasattr(route, "routes"):
                walk(route.routes, prefix + (getattr(route, "path", "") or ""))

    walk(app.routes, "")
    return found
