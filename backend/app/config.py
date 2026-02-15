from pathlib import Path
from pydantic import Field, BaseModel
from pydantic_settings import BaseSettings, SettingsConfigDict
import os

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
    MINIO_ENDPOINT: str = os.getenv("MINIO_ENDPOINT", "http://localhost:9000")
    MINIO_BUCKET: str = os.getenv("MINIO_BUCKET", "eris-uploads")
    MINIO_ACCESS_KEY: str = os.getenv("MINIO_ROOT_USER", "minioadmin")
    MINIO_SECRET_KEY: str = os.getenv("MINIO_ROOT_PASSWORD", "minio_root_password")
    MINIO_PUBLIC_ENDPOINT: str | None = os.getenv("MINIO_PUBLIC_ENDPOINT") or None

    # JWT (required)
    JWT_SECRET: str  # REQUIRED
    JWT_ALG: str = Field(default="HS256")
    JWT_EXPIRES_MINUTES: int = Field(default=120)

    # Dev-only seeding
    SEED_ADMIN: bool = Field(default=False)
    SEED_ADMIN_EMAIL: str = Field(default="admin@local")
    SEED_ADMIN_PASSWORD: str | None = Field(default=None)

    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]


settings = Settings()
