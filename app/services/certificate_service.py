"""Certificates are file uploads attached to an already-logged result."""

from __future__ import annotations

from typing import Any

from app.db import SupabaseClient, SupabaseError
from app.services.storage_service import ALLOWED_CERTIFICATE_TYPES, StorageError, upload_certificate
from app.services.time_utils import display_finish_time, is_logged_result, registration_distance

MAX_CERTIFICATE_BYTES = 8 * 1024 * 1024


class CertificateError(ValueError):
    pass


def _has_logged_result(registrations: list[dict[str, Any]], runner_id: str, race_id: str) -> dict[str, Any] | None:
    for row in registrations:
        if row.get("runner_id") == runner_id and (row.get("marathon_id") == race_id or row.get("race_id") == race_id):
            if is_logged_result(row):
                return row
    return None


def list_certificates(db: SupabaseClient, group_id: str, runner_id: str | None = None, race_id: str | None = None) -> list[dict[str, Any]]:
    filters = {"group_id": f"eq.{group_id}"}
    if runner_id:
        filters["runner_id"] = f"eq.{runner_id}"
    if race_id:
        filters["marathon_id"] = f"eq.{race_id}"
    try:
        rows = db.select("certificates", filters=filters, order="created_at.desc")
        if rows:
            return [_normalize(row) for row in rows]
    except SupabaseError:
        rows = []
    try:
        rows = db.select("user_certificates", filters=filters, order="created_at.desc")
    except SupabaseError:
        rows = []
    return [_normalize(row) for row in rows]


def _normalize(row: dict[str, Any]) -> dict[str, Any]:
    return {
        **row,
        "url": row.get("file_url") or row.get("certificate_url") or row.get("url") or "",
        "race_name": row.get("race_name") or row.get("marathon_name") or "Race",
        "finish_time": row.get("finish_time") or "",
        "distance": row.get("distance") or "",
    }


def upload_for_result(
    db: SupabaseClient,
    *,
    group_id: str,
    runner_id: str,
    user_id: str,
    race_id: str,
    filename: str,
    content: bytes,
    content_type: str,
    registrations: list[dict[str, Any]],
    races: list[dict[str, Any]],
) -> dict[str, Any]:
    if not content:
        raise CertificateError("Choose a certificate file to upload")
    if len(content) > MAX_CERTIFICATE_BYTES:
        raise CertificateError("Certificate files must be 8 MB or smaller")
    if content_type not in ALLOWED_CERTIFICATE_TYPES and not filename.lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".pdf")):
        raise CertificateError("Upload a JPG, PNG, WebP, or PDF file")
    result = _has_logged_result(registrations, runner_id, race_id)
    if not result:
        raise CertificateError("Log a result first before uploading a certificate")
    race = next((item for item in races if item.get("id") == race_id), {})
    try:
        stored = upload_certificate(db, group_id, runner_id, race_id, filename, content, content_type)
    except StorageError as exc:
        raise CertificateError(str(exc)) from exc
    payload = {
        "group_id": group_id,
        "runner_id": runner_id,
        "user_id": user_id,
        "marathon_id": race_id,
        "marathon_name": race.get("name") or "",
        "race_date": race.get("race_date"),
        "distance": registration_distance(result, race),
        "finish_time": display_finish_time(result) if display_finish_time(result) != "—" else "",
        "place_overall": result.get("place_overall") or "",
        "certificate_url": stored["public_url"],
        "file_url": stored["public_url"],
        "url": stored["public_url"],
        "title": f"{race.get('name') or 'Race'} certificate",
    }
    row = _insert_certificate(db, payload)
    try:
        db.update("registrations", {"id": f"eq.{result['id']}"}, {"certificate_url": stored["public_url"]})
    except SupabaseError:
        pass
    return _normalize(row)


def _insert_certificate(db: SupabaseClient, payload: dict[str, Any]) -> dict[str, Any]:
    for table, body in (
        (
            "certificates",
            {
                "group_id": payload["group_id"],
                "runner_id": payload["runner_id"],
                "user_id": payload.get("user_id"),
                "race_id": payload["marathon_id"],
                "registration_id": None,
                "file_url": payload["file_url"],
                "file_name": payload.get("title") or "",
                "distance": payload.get("distance") or "",
                "finish_time": payload.get("finish_time") or "",
            },
        ),
        ("user_certificates", payload),
    ):
        try:
            rows = db.insert(table, body, upsert=True)
            if rows:
                return rows[0]
        except SupabaseError:
            continue
    raise CertificateError("Could not save the certificate record")
