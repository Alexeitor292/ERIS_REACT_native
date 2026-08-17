# Routes package.
from . import photo_exports as _photo_exports  # noqa: F401
from ..services.field_media_quality import quality_gated_capture as _capture_policy
from ..services.field_media_ingest import install_upload_metadata_fallback as _install_media_ingest
from . import photo_map as _photo_map

_photo_map._quality_gated_capture = _capture_policy
_install_media_ingest()

# Project is the operational parent of Incident. Compose the Project API into the
# already-mounted incident router at package import time so the large legacy
# app/main.py module does not need another direct dependency. Import Incident
# first because the Project workflow reuses its district-scope authority helper.
from . import incidents as _incidents  # noqa: E402
from . import projects as _projects  # noqa: E402

_incidents.router.include_router(_projects.router)
