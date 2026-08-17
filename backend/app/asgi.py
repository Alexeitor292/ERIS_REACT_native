"""ERIS ASGI entrypoint.

Keeps the legacy route module intact while applying deployment-facing API posture:
- production product identity instead of prototype naming
- interactive/OpenAPI documentation enabled by default only for local/dev/test
- explicit API_DOCS_ENABLED override for controlled environments
"""

from __future__ import annotations

import os

from .config import settings
from .main import app as app

_API_TITLE = "Emergency Response Information System API"
_API_DESCRIPTION = "ERIS operational API for Caltrans Geotechnical Services."
_DOCUMENTATION_PATHS = {
    "/docs",
    "/docs/oauth2-redirect",
    "/redoc",
    "/openapi.json",
}
_DEV_ENVIRONMENTS = {"dev", "development", "local", "test", "testing"}
_TRUE_VALUES = {"1", "true", "yes", "on"}
_FALSE_VALUES = {"0", "false", "no", "off"}


def _optional_bool_env(name: str) -> bool | None:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return None
    value = raw.strip().lower()
    if value in _TRUE_VALUES:
        return True
    if value in _FALSE_VALUES:
        return False
    raise RuntimeError(
        f"{name} must be one of {sorted(_TRUE_VALUES | _FALSE_VALUES)}, got {raw!r}"
    )


def api_docs_enabled() -> bool:
    override = _optional_bool_env("API_DOCS_ENABLED")
    if override is not None:
        return override
    return settings.ENV.strip().lower() in _DEV_ENVIRONMENTS


def _apply_runtime_posture() -> None:
    app.title = _API_TITLE
    app.description = _API_DESCRIPTION

    if api_docs_enabled():
        return

    # FastAPI creates documentation routes during app construction. The large
    # legacy route module remains untouched; this deployment entrypoint removes
    # only the documentation endpoints from the final ASGI router.
    app.router.routes[:] = [
        route
        for route in app.router.routes
        if getattr(route, "path", None) not in _DOCUMENTATION_PATHS
    ]
    app.docs_url = None
    app.redoc_url = None
    app.openapi_url = None
    app.openapi_schema = None


_apply_runtime_posture()
