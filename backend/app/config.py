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
    # Region used when GENERATING presigned URLs. Set explicitly (MinIO's default
    # is us-east-1) so presigning is purely local — it must NOT round-trip a
    # GetBucketLocation call to the public endpoint at sign time. Override only if
    # the MinIO server is configured with a non-default site region.
    MINIO_REGION: str = Field(default="us-east-1")
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
    # Worker concurrency is achieved by running MULTIPLE worker CONTAINERS
    # (compose `deploy.replicas` / scaling); each worker process handles one job at
    # a time and jobs are claimed with `FOR UPDATE SKIP LOCKED`, so replicas never
    # double-claim. There is deliberately no in-process concurrency knob (a dead
    # setting that silently controls nothing). Default posture is a single worker.
    OFFLINE_SCENE_JOB_STALE_SECONDS: int = Field(default=900)
    # Production posture. FALSE by default and in prod compose. When FALSE, MinIO
    # offline-bucket posture problems (missing bucket, anonymous access, no
    # versioning) FAIL CLOSED instead of warning; when TRUE (local/dev) they warn
    # so a laptop run without a fully-provisioned MinIO can still iterate.
    OFFLINE_SCENE_DEV_MODE: bool = Field(default=False)
    # Single authoritative AOI ceiling. Enforced identically at the generate
    # endpoint, job creation, AND worker execution (see offline_scene.clamp_radius_m).
    # An absolute hard ceiling (offline_scene.HARD_MAX_RADIUS_M) caps this even if
    # misconfigured, so a package is never statewide/unbounded.
    OFFLINE_SCENE_MAX_RADIUS_M: float = Field(default=3000.0)
    # Maximum registered package size (policy, NOT device memory). Enforced before
    # catalog registration (worker) and before minting a mobile download grant.
    OFFLINE_SCENE_MAX_PACKAGE_MB: int = Field(default=512)
    # USGS 3DEP raster elevation ImageServer (authoritative terrain source).
    OFFLINE_SCENE_3DEP_IMAGESERVER: str = Field(
        default="https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer"
    )
    OFFLINE_SCENE_3DEP_DATASET: str = Field(default="USGS 3DEP (3DEPElevation ImageServer)")
    OFFLINE_SCENE_EXPORT_PX: int = Field(default=1024)  # hillshade texture px
    OFFLINE_SCENE_GRID_PX: int = Field(default=256)      # terrain height-grid dimension
    OFFLINE_SCENE_FETCH_TIMEOUT_S: int = Field(default=60)
    # Basemap/imagery provider for the generated package. "usgs_hillshade" is the
    # licence-clean default (server-rendered hillshade from USGS 3DEP). A licensed
    # offline imagery provider can be added later without redesigning the pipeline.
    OFFLINE_SCENE_IMAGERY_PROVIDER: str = Field(default="usgs_hillshade")

    # --- Offline context layers (roads / imagery / overview) --------------------
    # Packaged INSIDE the .eristerrain bundle at build time; never fetched during
    # the mobile download or while viewing offline. Each layer fails GRACEFULLY:
    # a source failure marks that layer unavailable (with a reason) and never
    # corrupts/deletes the valid terrain package. All assets count toward
    # OFFLINE_SCENE_MAX_PACKAGE_MB.
    #
    # Roads: default source is ERIS-authoritative data already in the build context
    # (submitted geometry + resolved road-bearing segment + road-inventory line
    # geometry), clipped to bounds + buffer — no third-party provider. An opt-in
    # ArcGIS FeatureServer adapter (documented, license-reviewed by the operator)
    # can broaden coverage.
    OFFLINE_SCENE_ROADS_ENABLED: bool = Field(default=True)
    OFFLINE_SCENE_ROAD_SOURCE: str = Field(default="eris_internal")  # eris_internal | arcgis_feature_service
    OFFLINE_SCENE_ROAD_SOURCE_URL: str | None = Field(default=None)  # required for arcgis_feature_service
    OFFLINE_SCENE_ROAD_BUFFER_M: float = Field(default=250.0)        # bounds buffer for clipping
    OFFLINE_SCENE_ROAD_FETCH_TIMEOUT_S: int = Field(default=30)

    # Aerial/satellite imagery drape. OPT-IN: NAIP (USGS/USDA, public domain) is the
    # intended licence-clean provider, but must be validated on a live worker before
    # we claim "satellite imagery", so it defaults OFF. When off/uncovered/too-large/
    # failed, the package is built WITHOUT imagery (manifest reason recorded) unless
    # OFFLINE_SCENE_IMAGERY_MANDATORY is true.
    OFFLINE_SCENE_IMAGERY_ENABLED: bool = Field(default=False)
    OFFLINE_SCENE_IMAGERY_MANDATORY: bool = Field(default=False)
    OFFLINE_SCENE_IMAGERY_EXPORT_URL: str = Field(
        default="https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer"
    )
    OFFLINE_SCENE_IMAGERY_MAX_PX: int = Field(default=1024)  # legacy single-image export dimension
    OFFLINE_SCENE_IMAGERY_FETCH_TIMEOUT_S: int = Field(default=45)

    # --- High-definition TILED aerial imagery -----------------------------------
    # When imagery is enabled, "tiled" (default) splits the AOI into a grid of JPEG
    # tiles packaged INSIDE the bundle at imagery/{row}/{col}.jpg. Each upstream
    # export stays small/safe (<= tile_px, well under the ImageServer max), so total
    # packaged detail can far exceed a single 4000px export without over-requesting
    # beyond source-native resolution. "single" keeps the legacy one imagery.png.
    # The DEFAULT source remains USGS/USDA NAIP (public domain) — a single large
    # 4000px request is deliberately NOT the permanent default.
    OFFLINE_SCENE_IMAGERY_MODE: str = Field(default="tiled")  # tiled | single
    # Target ground sample distance. "source_native..." clamps to the operator's
    # declared source-native m/px (never finer, so we never over-request beyond
    # useful source detail); a bare float (e.g. "0.6") forces that metres/pixel.
    OFFLINE_SCENE_IMAGERY_TARGET_MPP: str = Field(default="source_native_or_0.6")
    # Operator-declared source-native ground sample distance (m/px). NAIP is ~0.6-1.0
    # m/px depending on vintage/county; 0.6 is a safe modern default. When >0 the
    # planner never plans finer than this. Set to the real service GSD when known.
    OFFLINE_SCENE_IMAGERY_SOURCE_NATIVE_MPP: float = Field(default=0.6)
    OFFLINE_SCENE_IMAGERY_TILE_PX: int = Field(default=1024)            # 1024 or 2048
    OFFLINE_SCENE_IMAGERY_TILE_TIMEOUT_S: int = Field(default=90)
    OFFLINE_SCENE_IMAGERY_TILE_RETRIES: int = Field(default=3)
    OFFLINE_SCENE_IMAGERY_OVERALL_DEADLINE_S: int = Field(default=1200)
    OFFLINE_SCENE_IMAGERY_MAX_TILES: int = Field(default=64)
    OFFLINE_SCENE_IMAGERY_MAX_MB: int = Field(default=256)             # imagery-only budget
    OFFLINE_SCENE_IMAGERY_JPEG_QUALITY: int = Field(default=85)
    # Conservative per-request upstream export ceiling (ImageServer max width/height).
    # tile_px must stay <= this; a request never approaches the service maximum.
    OFFLINE_SCENE_IMAGERY_MAX_EXPORT_PX: int = Field(default=4096)

    # North-up 2D overview inset, server-rendered (Pillow) from package bounds +
    # roads + incident + geometry. Licence-clean; no external data.
    OFFLINE_SCENE_OVERVIEW_ENABLED: bool = Field(default=True)
    OFFLINE_SCENE_OVERVIEW_PX: int = Field(default=512)

    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]


settings = Settings()
