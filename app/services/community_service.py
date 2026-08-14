"""System community posts for PR, badge, and result events. Idempotent."""

from __future__ import annotations

from typing import Any

from app.db import SupabaseClient, SupabaseError
from app.services.badge_service import BADGE_CATALOG
from app.services.pr_service import PREvent
from app.services.time_utils import finish_seconds, format_time, is_finish

SYSTEM_TITLES = {"New personal record", "Badge unlocked", "Race results"}


def _runner_name(runner_id: str, runners: list[dict[str, Any]]) -> str:
    runner = next((item for item in runners if item.get("id") == runner_id), None)
    return (runner or {}).get("name") or "Runner"


def _actor_id(db: SupabaseClient, group_id: str, preferred: str | None = None) -> str | None:
    if preferred:
        return preferred
    try:
        members = db.select("group_memberships", filters={"group_id": f"eq.{group_id}", "role": "eq.admin"}, limit=1)
        if members:
            return members[0].get("user_id")
        members = db.select("group_memberships", filters={"group_id": f"eq.{group_id}"}, limit=1)
        return members[0].get("user_id") if members else None
    except SupabaseError:
        return None


def _existing_contents(db: SupabaseClient, group_id: str) -> set[str]:
    try:
        posts = db.select("community_posts", filters={"group_id": f"eq.{group_id}"}, columns="content,title,event_key")
    except SupabaseError:
        return set()
    keys = set()
    for post in posts:
        if post.get("event_key"):
            keys.add(post["event_key"])
        if post.get("content"):
            keys.add(post["content"])
    return keys


def _insert_post(db: SupabaseClient, payload: dict[str, Any], seen: set[str]) -> bool:
    content = payload.get("content") or ""
    event_key = payload.get("event_key") or content
    if event_key in seen or content in seen:
        return False
    body = dict(payload)
    try:
        db.insert("community_posts", body)
    except SupabaseError:
        body.pop("event_key", None)
        try:
            db.insert("community_posts", body)
        except SupabaseError:
            return False
    seen.add(event_key)
    seen.add(content)
    return True


def announce_pr(db: SupabaseClient, event: PREvent, runners: list[dict[str, Any]]) -> bool:
    group_id = event.registration.get("group_id") or event.race.get("group_id")
    if not group_id:
        return False
    name = _runner_name(event.runner_id, runners)
    content = f"{name} set a new {event.distance} PR: {format_time(event.time_seconds)}! What’s your next goal?"
    actor = _actor_id(db, group_id, (next((r.get("user_id") for r in runners if r.get("id") == event.runner_id), None)))
    if not actor:
        return False
    seen = _existing_contents(db, group_id)
    return _insert_post(
        db,
        {
            "group_id": group_id,
            "user_id": actor,
            "runner_id": event.runner_id,
            "title": "New personal record",
            "content": content,
            "post_type": "announcement",
            "event_key": f"pr:{event.registration.get('id')}:{event.distance}",
        },
        seen,
    )


def announce_badge(db: SupabaseClient, group_id: str, runner_id: str, badge_key: str, runners: list[dict[str, Any]]) -> bool:
    label = BADGE_CATALOG.get(badge_key, {}).get("label") or badge_key.replace("_", " ")
    name = _runner_name(runner_id, runners)
    content = f"{name} unlocked the {label} badge! Celebrate the milestone and keep moving."
    actor = _actor_id(db, group_id, next((r.get("user_id") for r in runners if r.get("id") == runner_id), None))
    if not actor:
        return False
    seen = _existing_contents(db, group_id)
    return _insert_post(
        db,
        {
            "group_id": group_id,
            "user_id": actor,
            "runner_id": runner_id,
            "title": "Badge unlocked",
            "content": content,
            "post_type": "announcement",
            "event_key": f"badge:{runner_id}:{badge_key}",
        },
        seen,
    )


def announce_results(db: SupabaseClient, race_id: str | None, races: list[dict[str, Any]], registrations: list[dict[str, Any]]) -> bool:
    if not race_id:
        return False
    race = next((item for item in races if item.get("id") == race_id), None)
    if not race:
        return False
    finishes = [row for row in registrations if (row.get("marathon_id") == race_id or row.get("race_id") == race_id) and is_finish(row)]
    if not finishes:
        return False
    times = sorted(t for t in (finish_seconds(row) for row in finishes) if t is not None)
    median = f" Median finish: {format_time(times[len(times) // 2])}." if times else ""
    content = (
        f"New results have been logged for {race.get('name') or 'this race'}: "
        f"{len(finishes)} finisher{'s' if len(finishes) != 1 else ''} recorded.{median} Share your favorite moment!"
    )
    group_id = race.get("group_id")
    actor = _actor_id(db, group_id)
    if not actor or not group_id:
        return False
    seen = _existing_contents(db, group_id)
    return _insert_post(
        db,
        {
            "group_id": group_id,
            "user_id": actor,
            "title": "Race results",
            "content": content,
            "post_type": "announcement",
            "event_key": f"results:{race_id}",
        },
        seen,
    )


def is_system_post(post: dict[str, Any]) -> bool:
    return post.get("post_type") == "announcement" or post.get("title") in SYSTEM_TITLES
