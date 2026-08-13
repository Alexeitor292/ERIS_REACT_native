# Routes package.
# Import the corrected-photo export extension so it registers its endpoint on
# the shared Site Photo Map router before app.main includes that router.
from . import photo_exports as _photo_exports  # noqa: F401
