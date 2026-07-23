from pathlib import Path
from pydantic import Field, BaseModel, field_validator
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
    # Package the Road Inventory-derived roadway cross-section layout (lane counts/
    # widths, shoulders, median width/category) + route/postmile metadata + upstation
    # direction into road_cross_section.json, so the native offline Cross Section tool
    # works in Airplane Mode. Small JSON metadata (not elevation — that is sampled from
    # the packaged terrain grid at cross-section time). Degrades gracefully.
    OFFLINE_SCENE_ROAD_CROSS_SECTION_ENABLED: bool = Field(default=True)
    # none | eris_internal | arcgis_feature_service | census_tigerweb | caltrans_crs
    # See docs/adr-offline-road-context-source.md. `none` packages NO road context;
    # census_tigerweb is the credential-free DEVELOPMENT road-snap source (public U.S.
    # Census TIGERweb); arcgis_feature_service is a generic authorized ArcGIS/Enterprise
    # centerline layer; caltrans_crs is the OPTIONAL Caltrans freeway/expressway road
    # context (public Caltrans CRS Functional Classification FeatureServer — a functional
    # classification, NOT an ownership dataset; see the caltrans block below). The value is
    # validated at startup (an invalid provider is rejected).
    OFFLINE_SCENE_ROAD_SOURCE: str = Field(default="eris_internal")
    OFFLINE_SCENE_ROAD_SOURCE_URL: str | None = Field(default=None)  # required for arcgis_feature_service
    OFFLINE_SCENE_ROAD_BUFFER_M: float = Field(default=250.0)        # bounds buffer for clipping
    OFFLINE_SCENE_ROAD_FETCH_TIMEOUT_S: int = Field(default=30)
    # Roads REQUIRED vs optional (applies to the selected provider, never to `none`).
    # False (default): a road-source failure/absence marks the roads layer unavailable
    # (with a truthful reason) and the terrain package still builds. True: a road
    # retrieval/validation/filter/packaging failure FAILS the job — no READY package is
    # ever published without verified road data.
    OFFLINE_SCENE_ROADS_REQUIRED: bool = Field(default=False)
    # EXPLICIT, AUDITED fallback. Empty (default) = NO fallback: ERIS never silently
    # falls back from one provider to another. When set to another real source
    # (eris_internal | census_tigerweb | arcgis_feature_service), a failure of the primary
    # provider falls back to it AND records the fallback in the manifest + logs.
    OFFLINE_SCENE_ROAD_FALLBACK_SOURCE: str = Field(default="")
    # Public U.S. Census TIGERweb Transportation MapServer (no credentials/tokens). Layers:
    # 2 = Primary Roads, 6 = Secondary Roads, 8 = Local Roads. Worker-side fetch ONLY —
    # the mobile app never contacts a road source. TIGERweb is road SNAP CONTEXT, not
    # Caltrans engineering/survey-grade data (provenance must say U.S. Census Bureau).
    OFFLINE_SCENE_TIGERWEB_BASE_URL: str = Field(
        default="https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer"
    )
    OFFLINE_SCENE_TIGERWEB_LAYERS: str = Field(default="2,6,8")

    # --- Caltrans CRS Functional Classification (OPTIONAL freeway/expressway road context) ---
    # Public, credential-free Caltrans ArcGIS Feature Service. Active ONLY when
    # OFFLINE_SCENE_ROAD_SOURCE=caltrans_crs (explicit selection). Worker-side fetch only —
    # the mobile app never contacts this service; roads are packaged into roads.geojson.
    # This layer publishes FUNCTIONAL CLASSIFICATION (how a road functions), NOT ownership:
    # it does not establish that a feature is Caltrans-owned or a State Route, and a filtered
    # subset must never be described as "the state highway system". Road CONTEXT only — not
    # survey/engineering-grade centerline. See offline_scene_caltrans.py and
    # docs/adr-offline-road-context-source.md.
    OFFLINE_SCENE_CALTRANS_ROADS_URL: str = Field(
        default="https://caltrans-gis.dot.ca.gov/arcgis/rest/services/CHhighway/CRS_Functional_Classification/FeatureServer/0"
    )
    # F_System functional-classification codes to INCLUDE. DEFAULT 1,2 = Interstate + Other
    # Freeways and Expressways (the conservative freeway/expressway scope). Class 3
    # ("Principal Arterial - Other") is a SURFACE arterial, NOT a freeway — operators may
    # opt in with "1,2,3" for broader principal-arterial context. Codes 1-7 only; a supplied
    # value that is malformed, out of range, floating-point or empty is REJECTED at startup
    # (never ignored and never silently collapsed to the default).
    OFFLINE_SCENE_CALTRANS_FUNCTIONAL_CLASSES: str = Field(default="1,2")
    # Bounded pagination + safety limits (never download the statewide dataset). Bounds are
    # enforced, not just documented: the page size is capped at the service's advertised
    # maxRecordCount (2000) because a larger request is silently clamped server-side, and the
    # cap/backstop values must be >= 1 so a misconfiguration cannot make every job fail.
    OFFLINE_SCENE_CALTRANS_PAGE_SIZE: int = Field(default=1000, ge=1, le=2000)
    OFFLINE_SCENE_CALTRANS_MAX_FEATURES: int = Field(default=20000, ge=1)  # hard cap per package
    OFFLINE_SCENE_CALTRANS_MAX_PAGES: int = Field(default=100, ge=1)       # infinite-pagination backstop
    OFFLINE_SCENE_CALTRANS_MAX_RESPONSE_MB: int = Field(default=32, ge=1)  # per-page response ceiling
    OFFLINE_SCENE_CALTRANS_RETRIES: int = Field(default=2, ge=0)           # bounded transient retries per page

    # --- Divided-highway corridor pairing (worker-side, deterministic) ----------
    # TIGERweb packages a divided highway as TWO primary centerlines. This pass decides —
    # LOCALLY ALONG THE ROUTE, never globally by route name or mere proximity — where two
    # primary carriageways share one corridor, and derives a midpoint centerline so the map
    # can show ONE selectable yellow line. Additive: legacy packages are unaffected.
    # See docs/adr-divided-highway-corridor-pairing.md for the design + thresholds.
    OFFLINE_SCENE_DIVIDED_PAIRING_ENABLED: bool = Field(default=True)
    OFFLINE_SCENE_PAIR_SAMPLE_INTERVAL_M: float = Field(default=10.0)   # deterministic resampling step
    OFFLINE_SCENE_PAIR_WINDOW_M: float = Field(default=120.0)           # moving longitudinal window
    OFFLINE_SCENE_PAIR_MIN_SEPARATION_M: float = Field(default=4.0)     # below this: effectively duplicate lines
    # Generous by design: a WIDE but STABLE grass/open median is still one corridor. The
    # decision rests on stability (stdev/slope), never on one small maximum-distance rule.
    OFFLINE_SCENE_PAIR_MAX_SEPARATION_M: float = Field(default=120.0)
    OFFLINE_SCENE_PAIR_MAX_BEARING_DIFF_DEG: float = Field(default=20.0)      # axial, mod 180
    OFFLINE_SCENE_PAIR_MAX_OFFSET_ANGLE_DEV_DEG: float = Field(default=35.0)  # offset must be ~perpendicular
    OFFLINE_SCENE_PAIR_SEP_STDEV_MAX_M: float = Field(default=12.0)           # separation stability
    OFFLINE_SCENE_PAIR_SEP_SLOPE_MAX: float = Field(default=0.25)             # |d(sep)/ds|: rejects divergence
    OFFLINE_SCENE_PAIR_MIN_WINDOW_COVERAGE: float = Field(default=0.8)
    # Rejects brief interchange-only proximity and parallel ramps hugging the mainline.
    OFFLINE_SCENE_PAIR_MIN_CORRIDOR_LENGTH_M: float = Field(default=150.0)
    # Behaviour-changing: how far the derived midpoint may sit off-centre between the two
    # carriageways before the run is SPLIT. Not a numeric epsilon — at metre scale it
    # decides pairing, so it is a first-class configured threshold.
    OFFLINE_SCENE_PAIR_MIDPOINT_TOLERANCE_M: float = Field(default=3.0)

    # Provider-neutral ROUTE-CHAIN pre-pass (road_route_chains): stitch a mainline fragmented
    # by provider segmentation (e.g. the Caltrans CRS LRS event layer) into continuous
    # carriageways and conservatively demote branch/ramp geometry to `connector` BEFORE
    # pairing, so a ramp can never become a carriageway partner. A no-op for providers that
    # carry no carriageway-continuity key (e.g. TIGER), so existing behaviour is unchanged.
    OFFLINE_SCENE_ROUTE_CHAIN_ENABLED: bool = Field(default=True)
    OFFLINE_SCENE_ROUTE_CHAIN_JOIN_GAP_M: float = Field(default=25.0)          # endpoint join distance
    OFFLINE_SCENE_ROUTE_CHAIN_JOIN_BEARING_DEG: float = Field(default=35.0)    # axial continuity across a join
    OFFLINE_SCENE_ROUTE_CHAIN_MIN_MAINLINE_LEN_M: float = Field(default=200.0)  # sustained-through-route length (a geometric reference, not a role claim)
    OFFLINE_SCENE_ROUTE_CHAIN_CONNECTOR_MAX_LEN_M: float = Field(default=400.0)  # only a SHORT branch is a connector
    OFFLINE_SCENE_ROUTE_CHAIN_BRANCH_ANGLE_DEG: float = Field(default=35.0)    # MIN acute deviation = a branch
    # MAX deviation still treated as a branch. A near-perpendicular meeting is a
    # grade-separated CROSSING (another highway), never a branch of this one.
    OFFLINE_SCENE_ROUTE_CHAIN_BRANCH_ANGLE_MAX_DEG: float = Field(default=80.0)
    OFFLINE_SCENE_ROUTE_CHAIN_JUNCTION_TOL_M: float = Field(default=30.0)      # endpoint-to-through-route attachment

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
    # Imagery ACQUISITION vintage (e.g. "NAIP 2022"). `retrieved_at` is the worker fetch
    # time and is NOT a vintage. There is no service-metadata probe today, so this is
    # operator-declared: leave EMPTY unless the real upstream vintage is known. When empty
    # the manifest reports vintage_available=false rather than inventing a date.
    OFFLINE_SCENE_IMAGERY_SOURCE_VINTAGE: str = Field(default="")
    # Conservative per-request upstream export ceiling (ImageServer max width/height).
    # tile_px must stay <= this; a request never approaches the service maximum.
    OFFLINE_SCENE_IMAGERY_MAX_EXPORT_PX: int = Field(default=4096)

    # North-up 2D overview inset, server-rendered (Pillow) from package bounds +
    # roads + incident + geometry. Licence-clean; no external data.
    OFFLINE_SCENE_OVERVIEW_ENABLED: bool = Field(default=True)
    OFFLINE_SCENE_OVERVIEW_PX: int = Field(default=512)

    @field_validator("OFFLINE_SCENE_ROAD_SOURCE")
    @classmethod
    def _validate_road_source(cls, v):
        # Reject an unknown road provider at startup (typed selection, not free strings).
        from .services.offline_scene_context import normalize_road_source

        return normalize_road_source(v)

    @field_validator("OFFLINE_SCENE_CALTRANS_FUNCTIONAL_CLASSES")
    @classmethod
    def _validate_caltrans_classes(cls, v):
        # Strict: a supplied-but-malformed value is REJECTED at startup, never silently
        # collapsed to the default (which would give the operator a different road scope
        # than they asked for). Field defaults are not validated by pydantic, so genuinely
        # omitting the setting still uses the declared default.
        from .services.offline_scene_caltrans import parse_functional_classes

        return ",".join(str(n) for n in parse_functional_classes(v))

    @field_validator("OFFLINE_SCENE_ROAD_FALLBACK_SOURCE")
    @classmethod
    def _validate_road_fallback(cls, v):
        s = str(v or "").strip().lower()
        if not s:
            return ""  # empty = no fallback (the default posture)
        from .services.offline_scene_context import (
            ROAD_SOURCE_CALTRANS,
            ROAD_SOURCE_NONE,
            VALID_ROAD_SOURCES,
        )

        allowed = VALID_ROAD_SOURCES - {ROAD_SOURCE_NONE, ROAD_SOURCE_CALTRANS}
        if s not in allowed:
            raise ValueError(
                f"OFFLINE_SCENE_ROAD_FALLBACK_SOURCE must be empty or one of {sorted(allowed)}, got {v!r}"
            )
        return s

    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]


settings = Settings()
