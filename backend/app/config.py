from pathlib import Path
from pydantic import Field, BaseModel
from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parents[1]  # .../backend


class Settings(BaseSettings):
    """
    Production-safe config:
    - Loads env from backend/.env (deterministic, not cwd-dependent)
    - Secrets do NOT have defaults
    """

    model_config = SettingsConfigDict(
        env_file=str(BASE_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Runtime
    ENV: str = Field(default="dev")
    LOG_LEVEL: str = Field(default="INFO")

    # API
    API_HOST: str = Field(default="0.0.0.0")
    API_PORT: int = Field(default=8000)
    CORS_ORIGINS: str = Field(default="http://localhost:5173,http://127.0.0.1:5173")

    # DB (DB_PASS is required)
    DB_HOST: str = Field(default="127.0.0.1")
    DB_PORT: int = Field(default=3306)
    DB_NAME: str = Field(default="eris")
    DB_USER: str = Field(default="eris_user")
    DB_PASS: str  # REQUIRED

    # MinIO (keys required)
    MINIO_ENDPOINT: str = Field(default="http://localhost:9000")
    MINIO_BUCKET: str = Field(default="eris-uploads")
    MINIO_ACCESS_KEY: str = Field(default="minioadmin", validation_alias="MINIO_ROOT_USER")
    MINIO_SECRET_KEY: str = Field(default="minio_root_password", validation_alias="MINIO_ROOT_PASSWORD")
    MINIO_PUBLIC_ENDPOINT: str | None = Field(default=None)
    # "presigned" (default): return MinIO presigned GET URLs.
    # "public": return deterministic direct object URLs via MINIO_PUBLIC_ENDPOINT.
    STORAGE_URL_MODE: str = Field(default="presigned")

    # JWT (required)
    JWT_SECRET: str  # REQUIRED
    JWT_ALG: str = Field(default="HS256")
    JWT_EXPIRES_MINUTES: int = Field(default=120)

    # Optional ArcGIS enrichment (for route/postmile lookup)
    POSTMILE_FEATURE_LAYER_URL: str | None = Field(default=None)
    POSTMILE_ROUTE_FIELD: str = Field(default="ROUTE")
    POSTMILE_PM_FIELD: str = Field(default="POSTMILE")
    POSTMILE_COUNTY_FIELD: str = Field(default="COUNTY")
    POSTMILE_DISTRICT_FIELD: str = Field(default="DISTRICT")
    POSTMILE_WHERE: str = Field(default="1=1")
    POSTMILE_SEARCH_DISTANCE_METERS: int = Field(default=120)

    # ArcGIS runtime configuration (backend-managed, no DB persistence)
    ARCGIS_RUNTIME_ENABLED: bool = Field(default=False)
    ARCGIS_API_KEY: str | None = Field(default=None)
    ARCGIS_LICENSE_KEY: str | None = Field(default=None)
    ARCGIS_LICENSE_EXPIRES_AT: str | None = Field(default=None)
    ARCGIS_MMPK_URL: str | None = Field(default=None)
    ARCGIS_CONFIG_OFFLINE_TTL_HOURS: int = Field(default=168)
    # Private MinIO bucket holding operator-authored offline 3D scene packages
    # (.mspk). Separate from the uploads bucket; never made anonymous/public.
    # Availability is decided by the catalog table + a live object HEAD, NOT by a
    # base-URL string. Mobile never receives MinIO credentials — it gets a
    # short-lived presigned URL from the protected download endpoint.
    MINIO_OFFLINE_SCENES_BUCKET: str = Field(default="eris-offline-scenes")
    OFFLINE_SCENE_DOWNLOAD_TTL_SECONDS: int = Field(default=900)
    # --- Automatic offline 3D package-generation pipeline (worker) ---
    OFFLINE_SCENE_WORKER_POLL_SECONDS: int = Field(default=5)
    OFFLINE_SCENE_WORKER_CONCURRENCY: int = Field(default=1)
    OFFLINE_SCENE_JOB_STALE_SECONDS: int = Field(default=900)
    # Dev mode keeps AOIs/sizes conservative for laptop/dev runs.
    OFFLINE_SCENE_DEV_MODE: bool = Field(default=True)
    OFFLINE_SCENE_MAX_RADIUS_M: float = Field(default=3000.0)
    # USGS 3DEP raster elevation ImageServer (authoritative terrain source).
    OFFLINE_SCENE_3DEP_IMAGESERVER: str = Field(
        default="https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer"
    )
    OFFLINE_SCENE_3DEP_DATASET: str = Field(default="USGS 3DEP (3DEPElevation ImageServer)")
    OFFLINE_SCENE_EXPORT_PX: int = Field(default=1024)
    OFFLINE_SCENE_FETCH_TIMEOUT_S: int = Field(default=60)
    # Basemap/imagery provider for the generated package. "usgs_hillshade" is the
    # licence-clean default (server-rendered hillshade from USGS 3DEP). A licensed
    # offline imagery provider can be added later without redesigning the pipeline.
    OFFLINE_SCENE_IMAGERY_PROVIDER: str = Field(default="usgs_hillshade")

    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]


settings = Settings()
