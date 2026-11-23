from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration. Secrets are required from the environment or an env file."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    PROJECT_NAME: str = "Enterprise OS Patching & Update Platform"
    API_V1_STR: str = "/api"
    SECRET_KEY: str
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 15
    REFRESH_TOKEN_EXPIRE_HOURS: int = 8
    LOGIN_MAX_ATTEMPTS: int = 5
    LOGIN_LOCKOUT_MINUTES: int = 15
    PLATFORM_CA_CERT_PATH: str = "/etc/patching-platform/pki/patchops-root-ca.crt"
    DATABASE_URL: str
    REDIS_URL: str | None = None
    CORS_ORIGINS: list[str] = []
    ENABLE_API_DOCS: bool = False

    AWX_URL: str | None = None
    AWX_TOKEN: str | None = None
    AWX_VERIFY_SSL: bool = True
    AWX_CA_BUNDLE: str | None = None
    AWX_INVENTORY_ID: int | None = None
    AWX_DISCOVERY_TEMPLATE_NAME: str = "Template-OS-Discovery"
    AWX_SECURITY_TEMPLATE_NAME: str = "Template-Security-Patching"
    AWX_REGULAR_TEMPLATE_NAME: str = "Template-Regular-Patching"
    AWX_MAJOR_UPGRADE_TEMPLATE_NAME: str = "Template-Major-OS-Upgrade"
    AWX_WINDOWS_WINRM_TRANSPORT: Literal["ntlm", "kerberos"] = "ntlm"
    AWX_WINDOWS_WINRM_SERVER_CERT_VALIDATION: Literal["validate", "ignore"] = "validate"
    AWX_POLL_INTERVAL_SECONDS: int = 5
    AWX_JOB_TIMEOUT_SECONDS: int = 86400
    DISCOVERY_MAX_AGE_HOURS: int = 24
    WORKER_POLL_INTERVAL_SECONDS: int = 5

    @field_validator("SECRET_KEY")
    @classmethod
    def validate_secret_key(cls, value: str) -> str:
        if len(value) < 32:
            raise ValueError("SECRET_KEY must contain at least 32 characters")
        return value


settings = Settings()
