# Routes package.
from . import photo_exports as _photo_exports  # noqa: F401
from ..services.field_media_quality import quality_gated_capture as _capture_policy
from ..services.field_media_ingest import install_upload_metadata_fallback as _install_media_ingest
from . import photo_map as _photo_map

_photo_map._quality_gated_capture = _capture_policy
_install_media_ingest()

# Incident is the operational root. Event Group is a shared grouping attribute,
# and coordinator approval is the permanence boundary that mints incident_key.
#
# The legacy Project routers remain mounted for one compatibility window because
# already-deployed Web/mobile clients may still call /projects. The database
# migration backs those endpoints with compatibility views; new clients must use
# the canonical Event Group APIs.
from . import incidents as _incidents  # noqa: E402
from . import event_groups as _event_groups  # noqa: E402
from . import event_group_lifecycle as _event_group_lifecycle  # noqa: E402
from . import incident_approval as _incident_approval  # noqa: E402
from . import mission_center_event_groups as _mission_center_event_groups  # noqa: E402
from . import projects as _projects  # noqa: E402
from . import project_lifecycle as _project_lifecycle  # noqa: E402
from . import incident_classification as _incident_classification  # noqa: E402
from . import mission_center_gis as _mission_center_gis  # noqa: E402

_incidents.router.include_router(_event_groups.router)
_incidents.router.include_router(_event_group_lifecycle.router)
_incidents.router.include_router(_incident_approval.router)
_incidents.router.include_router(_mission_center_event_groups.router)
_incidents.router.include_router(_projects.router)
_incidents.router.include_router(_project_lifecycle.router)
_incidents.router.include_router(_incident_classification.router)
_incidents.router.include_router(_mission_center_gis.router)

# Keep mobile road-inventory package bytes behind ERIS authentication. The
# object store remains private and never needs anonymous download policy.
from . import road_inventory as _road_inventory  # noqa: E402
from . import road_inventory_mobile_download as _road_inventory_mobile_download  # noqa: E402

_road_inventory.router.include_router(_road_inventory_mobile_download.router)
