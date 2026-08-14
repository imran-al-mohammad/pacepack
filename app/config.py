from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    supabase_url: str = ""
    supabase_anon_key: str = ""
    supabase_service_role_key: str = ""
    secret_key: str = "dev-only-change-me"
    app_env: str = "development"
    app_host: str = "127.0.0.1"
    app_port: int = 8000
    certificates_bucket: str = "certificates"
    session_cookie_secure: bool = False
    access_cookie: str = "pacepack_access"
    refresh_cookie: str = "pacepack_refresh"

    @property
    def configured(self) -> bool:
        return bool(self.supabase_url and self.supabase_anon_key)

    @property
    def is_dev(self) -> bool:
        return self.app_env.lower() in {"dev", "development", "local"}


@lru_cache
def get_settings() -> Settings:
    return Settings()
