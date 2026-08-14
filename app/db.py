"""Thin Supabase REST / Auth / Storage client.

Uses the caller's JWT so Postgres RLS still applies. Jobs pass the service
role key and therefore bypass RLS.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

import httpx

from app.config import Settings, get_settings


class SupabaseError(RuntimeError):
    def __init__(self, message: str, status_code: int = 400, details: Any = None):
        super().__init__(message)
        self.status_code = status_code
        self.details = details


class SupabaseClient:
    def __init__(self, settings: Settings | None = None, access_token: str | None = None, use_service_role: bool = False):
        self.settings = settings or get_settings()
        self.base = self.settings.supabase_url.rstrip("/")
        self.anon_key = self.settings.supabase_anon_key
        if use_service_role:
            self.token = self.settings.supabase_service_role_key
        else:
            self.token = access_token or self.anon_key
        if not self.base or not self.anon_key:
            raise SupabaseError("SUPABASE_URL and SUPABASE_ANON_KEY are required", 503)

    def _headers(self, prefer: str = "", extra: dict[str, str] | None = None) -> dict[str, str]:
        headers = {
            "apikey": self.anon_key,
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
        }
        if prefer:
            headers["Prefer"] = prefer
        if extra:
            headers.update(extra)
        return headers

    def _request(
        self,
        method: str,
        url: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: Any = None,
        content: bytes | None = None,
        headers: dict[str, str] | None = None,
        timeout: float = 30.0,
    ) -> Any:
        try:
            response = httpx.request(
                method,
                url,
                params=params,
                json=json_body,
                content=content,
                headers=headers,
                timeout=timeout,
            )
        except httpx.HTTPError as exc:
            raise SupabaseError(f"Supabase request failed: {exc}", 502) from exc
        if response.status_code >= 400:
            detail: Any
            try:
                detail = response.json()
            except ValueError:
                detail = response.text
            message = ""
            if isinstance(detail, dict):
                message = str(detail.get("message") or detail.get("error_description") or detail.get("msg") or detail.get("error") or "")
            raise SupabaseError(message or f"Supabase error ({response.status_code})", response.status_code, detail)
        if not response.content:
            return None
        try:
            return response.json()
        except ValueError:
            return response.text

    # ── Auth ──────────────────────────────────────────────────────────────────

    def sign_in(self, email: str, password: str) -> dict[str, Any]:
        return self._request(
            "POST",
            f"{self.base}/auth/v1/token",
            params={"grant_type": "password"},
            json_body={"email": email, "password": password},
            headers=self._headers(),
        )

    def refresh(self, refresh_token: str) -> dict[str, Any]:
        return self._request(
            "POST",
            f"{self.base}/auth/v1/token",
            params={"grant_type": "refresh_token"},
            json_body={"refresh_token": refresh_token},
            headers=self._headers(),
        )

    def get_user(self) -> dict[str, Any]:
        return self._request("GET", f"{self.base}/auth/v1/user", headers=self._headers())

    def update_user(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._request("PUT", f"{self.base}/auth/v1/user", json_body=payload, headers=self._headers())

    def sign_out(self) -> None:
        try:
            self._request("POST", f"{self.base}/auth/v1/logout", json_body={}, headers=self._headers())
        except SupabaseError:
            return

    # ── PostgREST ─────────────────────────────────────────────────────────────

    def select(
        self,
        table: str,
        *,
        filters: dict[str, str] | None = None,
        columns: str = "*",
        order: str | None = None,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        params: dict[str, Any] = {"select": columns}
        if filters:
            params.update(filters)
        if order:
            params["order"] = order
        if limit is not None:
            params["limit"] = str(limit)
        rows = self._request("GET", f"{self.base}/rest/v1/{table}", params=params, headers=self._headers())
        return rows or []

    def select_one(self, table: str, **filters: str) -> dict[str, Any] | None:
        rows = self.select(table, filters=filters, limit=1)
        return rows[0] if rows else None

    def insert(self, table: str, payload: dict[str, Any] | list[dict[str, Any]], upsert: bool = False) -> list[dict[str, Any]]:
        prefer = "return=representation"
        if upsert:
            prefer = "resolution=merge-duplicates,return=representation"
        rows = self._request(
            "POST",
            f"{self.base}/rest/v1/{table}",
            json_body=payload,
            headers=self._headers(prefer),
        )
        if rows is None:
            return []
        return rows if isinstance(rows, list) else [rows]

    def update(self, table: str, filters: dict[str, str], payload: dict[str, Any]) -> list[dict[str, Any]]:
        rows = self._request(
            "PATCH",
            f"{self.base}/rest/v1/{table}",
            params=filters,
            json_body=payload,
            headers=self._headers("return=representation"),
        )
        if rows is None:
            return []
        return rows if isinstance(rows, list) else [rows]

    def delete(self, table: str, filters: dict[str, str]) -> None:
        self._request("DELETE", f"{self.base}/rest/v1/{table}", params=filters, headers=self._headers("return=minimal"))

    def rpc(self, name: str, payload: dict[str, Any] | None = None) -> Any:
        return self._request(
            "POST",
            f"{self.base}/rest/v1/rpc/{name}",
            json_body=payload or {},
            headers=self._headers("return=representation"),
        )

    # ── Storage ───────────────────────────────────────────────────────────────

    def upload_file(self, bucket: str, path: str, content: bytes, content_type: str) -> dict[str, Any]:
        encoded = "/".join(quote(part, safe="") for part in path.split("/") if part)
        return self._request(
            "POST",
            f"{self.base}/storage/v1/object/{bucket}/{encoded}",
            content=content,
            headers=self._headers(extra={"Content-Type": content_type, "x-upsert": "true"}),
        ) or {}

    def public_url(self, bucket: str, path: str) -> str:
        encoded = "/".join(quote(part, safe="") for part in path.split("/") if part)
        return f"{self.base}/storage/v1/object/public/{bucket}/{encoded}"


def user_client(access_token: str | None = None) -> SupabaseClient:
    return SupabaseClient(access_token=access_token)


def service_client() -> SupabaseClient:
    settings = get_settings()
    if not settings.supabase_service_role_key:
        raise SupabaseError("SUPABASE_SERVICE_ROLE_KEY is required for jobs and privileged writes", 503)
    return SupabaseClient(use_service_role=True)
