# Routes package.
from . import photo_exports as _photo_exports  # noqa: F401
from ..services.field_media_quality import quality_gated_capture as _capture_policy
from ..services.field_media_ingest import install_upload_metadata_fallback as _install_media_ingest
from . import photo_map as _photo_map

_photo_map._quality_gated_capture = _capture_policy
_install_media_ingest()

# Project is the operational parent of Incident. Compose the Project and
# assessment-derived classification APIs into the already-mounted incident
# router so the large legacy app/main.py module does not need more direct
# dependencies. Import Incident first because both workflows reuse its
# scope/authority helpers.
from . import incidents as _incidents  # noqa: E402
from . import projects as _projects  # noqa: E402
from . import incident_classification as _incident_classification  # noqa: E402

_incidents.router.include_router(_projects.router)
_incidents.router.include_router(_incident_classification.router)
