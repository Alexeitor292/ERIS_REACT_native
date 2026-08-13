# Routes package.
from . import photo_exports as _photo_exports  # noqa: F401
from ..services.field_media_quality import quality_gated_capture as _capture_policy
from . import photo_map as _photo_map

_photo_map._quality_gated_capture = _capture_policy
