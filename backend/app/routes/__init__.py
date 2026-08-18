# Routes package.
from . import photo_exports as _photo_exports  # noqa: F401
from ..services.field_media_quality import quality_gated_capture as _capture_policy
from ..services.field_media_ingest import install_upload_metadata_fallback as _install_media_ingest
from . import photo_map as _photo_map

_photo_map._quality_gated_capture = _capture_policy
_install_media_ingest()

# Project is the operational parent of Incident. Compose the Project,
# Project lifecycle, assessment-derived classification, and Mission Center GIS
# APIs into the already-mounted incident router so the large legacy app/main.py
# module does not need more direct dependencies. Import Incident/Project first
# because the additive routers reuse their scope/serialization helpers.
from . import incidents as _incidents  # noqa: E402
from . import projects as _projects  # noqa: E402
from . import project_lifecycle as _project_lifecycle  # noqa: E402
from . import incident_classification as _incident_classification  # noqa: E402
from . import mission_center_gis as _mission_center_gis  # noqa: E402

_incidents.router.include_router(_projects.router)
_incidents.router.include_router(_project_lifecycle.router)
_incidents.router.include_router(_incident_classification.router)
_incidents.router.include_router(_mission_center_gis.router)
