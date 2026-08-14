"""Supabase Storage helpers. Certificate uploads are files, never URLs."""

from __future__ import annotations

import re
from pathlib import PurePosixPath
from uuid import uuid4

from app.db import SupabaseClient, SupabaseError

ALLOWED_CERTIFICATE_TYPES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "application/pdf": ".pdf",
}

BUCKET = "certificates"


class StorageError(RuntimeError):
    pass


def _safe_ext(filename: str, content_type: str) -> str:
    mapped = ALLOWED_CERTIFICATE_TYPES.get(content_type)
    if mapped:
        return mapped
    suffix = PurePosixPath(filename or "").suffix.lower()
    if suffix in {".jpg", ".jpeg", ".png", ".webp", ".pdf"}:
        return ".jpg" if suffix == ".jpeg" else suffix
    raise StorageError("Upload a JPG, PNG, WebP, or PDF file")


def _safe_segment(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9._-]+", "-", value or "")
    return cleaned.strip("-") or "file"


def upload_certificate(
    db: SupabaseClient,
    group_id: str,
    runner_id: str,
    race_id: str,
    filename: str,
    content: bytes,
    content_type: str,
    bucket: str = BUCKET,
) -> dict[str, str]:
    ext = _safe_ext(filename, content_type)
    path = f"{_safe_segment(group_id)}/{_safe_segment(runner_id)}/{_safe_segment(race_id)}/{uuid4().hex}{ext}"
    try:
        db.upload_file(bucket, path, content, content_type or "application/octet-stream")
    except SupabaseError as exc:
        raise StorageError(exc.args[0] if exc.args else "Storage upload failed") from exc
    return {"path": path, "public_url": db.public_url(bucket, path)}
