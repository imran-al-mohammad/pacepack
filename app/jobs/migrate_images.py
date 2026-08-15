"""Copy existing runner and marathon image URLs into Supabase Storage.

Skips empty URLs and files already stored in the public images bucket.

    python -m app.jobs.migrate_images --group-id UUID --dry-run
    python -m app.jobs.migrate_images --group-id UUID --apply
    python -m app.jobs.migrate_images --apply
"""

from __future__ import annotations

import argparse
import mimetypes
import re
import sys
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import urlparse
from uuid import uuid4

import httpx

from app.db import SupabaseError, service_client

BUCKET = "images"
STORED_MARK = "/storage/v1/object/public/images/"
MAX_BYTES = 8 * 1024 * 1024
ALLOWED_TYPES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
}


def _already_stored(url: str) -> bool:
    return STORED_MARK in (url or "")


def _ext_for(url: str, content_type: str) -> str:
    mapped = ALLOWED_TYPES.get((content_type or "").split(";")[0].strip().lower())
    if mapped:
        return mapped
    suffix = PurePosixPath(urlparse(url).path).suffix.lower()
    if suffix == ".jpeg":
        return ".jpg"
    if suffix in {".jpg", ".png", ".webp", ".gif"}:
        return suffix
    return ".jpg"


def _safe_part(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9._-]+", "-", value or "")
    return cleaned.strip("-") or "file"


def _download(url: str) -> tuple[bytes, str]:
    with httpx.Client(follow_redirects=True, timeout=30.0) as client:
        response = client.get(url)
        response.raise_for_status()
    content = response.content or b""
    if not content:
        raise ValueError("empty image")
    if len(content) > MAX_BYTES:
        raise ValueError(f"image larger than {MAX_BYTES} bytes")
    content_type = (response.headers.get("content-type") or "").split(";")[0].strip().lower()
    if content_type not in ALLOWED_TYPES:
        guessed, _ = mimetypes.guess_type(url)
        content_type = (guessed or "image/jpeg").split(";")[0].strip().lower()
        if content_type not in ALLOWED_TYPES:
            raise ValueError(f"unsupported type {content_type or 'unknown'}")
    return content, content_type


def _store(db, folder: str, owner_id: str, url: str) -> str:
    content, content_type = _download(url)
    ext = _ext_for(url, content_type)
    path = f"{_safe_part(folder)}/{_safe_part(owner_id)}/{uuid4().hex}{ext}"
    db.upload_file(BUCKET, path, content, content_type)
    return db.public_url(BUCKET, path)


def collect_targets(db, group_id: str | None) -> list[dict[str, Any]]:
    filters = {"group_id": f"eq.{group_id}"} if group_id else None
    targets: list[dict[str, Any]] = []
    for table, column in (("runners", "image_url"), ("marathons", "image_url")):
        rows = db.select(table, filters=filters, columns=f"id,group_id,{column}")
        for row in rows:
            url = (row.get(column) or "").strip()
            if not url or not url.startswith("http"):
                continue
            if _already_stored(url):
                continue
            targets.append({"table": table, "id": row["id"], "group_id": row.get("group_id"), "url": url, "column": column})
    if group_id:
        runners = {row["id"]: row for row in db.select("runners", filters={"group_id": f"eq.{group_id}"}, columns="id,user_id,image_url")}
    else:
        runners = {row["id"]: row for row in db.select("runners", columns="id,user_id,image_url")}
    profiles = db.select("profiles", columns="id,profile_picture_url")
    for profile in profiles:
        url = (profile.get("profile_picture_url") or "").strip()
        if not url or not url.startswith("http") or _already_stored(url):
            continue
        if group_id and not any(runner.get("user_id") == profile["id"] for runner in runners.values()):
            continue
        targets.append({"table": "profiles", "id": profile["id"], "group_id": group_id, "url": url, "column": "profile_picture_url"})
    return targets


def migrate(group_id: str | None, apply: bool) -> dict[str, int]:
    db = service_client()
    targets = collect_targets(db, group_id)
    counts = {"found": len(targets), "copied": 0, "skipped": 0, "failed": 0}
    for item in targets:
        label = f"{item['table']} {item['id']}"
        if not apply:
            print(f"dry-run {label} <- {item['url']}")
            continue
        try:
            folder = "marathons" if item["table"] == "marathons" else "runners"
            stored = _store(db, folder, str(item["id"]), item["url"])
            db.update(item["table"], {"id": f"eq.{item['id']}"}, {item["column"]: stored})
            print(f"copied {label}")
            counts["copied"] += 1
        except (SupabaseError, ValueError, httpx.HTTPError) as exc:
            print(f"failed {label}: {exc}", file=sys.stderr)
            counts["failed"] += 1
    return counts


def main() -> int:
    parser = argparse.ArgumentParser(description="Copy existing image URLs into the images storage bucket")
    parser.add_argument("--group-id", help="Limit to one group (recommended)")
    parser.add_argument("--dry-run", action="store_true", help="List URLs without uploading")
    parser.add_argument("--apply", action="store_true", help="Download, upload, and rewrite URLs")
    args = parser.parse_args()
    if args.apply == args.dry_run:
        print("Pass exactly one of --dry-run or --apply", file=sys.stderr)
        return 2
    counts = migrate(args.group_id, apply=args.apply)
    print(counts)
    return 1 if counts["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
