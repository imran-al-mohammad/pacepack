"""Result logging lives on registrations (legacy source of truth)."""

from __future__ import annotations

from typing import Any

from app.db import SupabaseClient, SupabaseError
from app.services import badge_service, community_service, join_date_service, pr_service
from app.services.time_utils import (
    display_finish_time,
    finish_seconds,
    format_time,
    is_logged_result,
    pace_seconds,
    parse_time,
    registration_distance,
    status_label,
)

RESULT_FIELDS = (
    "status",
    "bib",
    "gun_time",
    "chip_time",
    "place_overall",
    "place_gender",
    "place_age_group",
    "result_notes",
    "race_distance",
)


class ResultError(ValueError):
    pass


def validate_result_payload(payload: dict[str, Any]) -> dict[str, Any]:
    cleaned: dict[str, Any] = {}
    status = str(payload.get("status") or "completed").strip().lower()
    allowed = {"interested", "registered", "waitlisted", "completed", "dns", "dnf"}
    if status not in allowed:
        raise ResultError("Invalid status")
    cleaned["status"] = status
    for field in ("bib", "gun_time", "chip_time", "place_overall", "place_gender", "place_age_group", "result_notes", "race_distance"):
        value = payload.get(field)
        cleaned[field] = str(value).strip() if value is not None else ""
    for time_field in ("gun_time", "chip_time"):
        if cleaned[time_field] and parse_time(cleaned[time_field]) is None:
            raise ResultError(f"Invalid {time_field.replace('_', ' ')}")
    if cleaned["status"] == "completed" and not (cleaned["chip_time"] or cleaned["gun_time"]):
        raise ResultError("Completed results need a chip or gun time")
    return cleaned


def enrich_result(row: dict[str, Any], runners: list[dict[str, Any]], races: list[dict[str, Any]]) -> dict[str, Any]:
    runner = next((item for item in runners if item.get("id") == row.get("runner_id")), None)
    race = next((item for item in races if item.get("id") == (row.get("marathon_id") or row.get("race_id"))), None)
    seconds = finish_seconds(row)
    pace = pace_seconds(row, race)
    return {
        **row,
        "runner": runner,
        "race": race,
        "runner_name": (runner or {}).get("name") or "Unknown",
        "race_name": (race or {}).get("name") or "Race",
        "distance_label": registration_distance(row, race),
        "finish_display": display_finish_time(row),
        "finish_seconds": seconds,
        "pace_display": f"{format_time(pace)}/km" if pace is not None else None,
        "status_label": status_label(row.get("status")),
        "logged": is_logged_result(row),
    }


def sort_results(rows: list[dict[str, Any]], sort_by: str = "time") -> list[dict[str, Any]]:
    def key(row: dict[str, Any]) -> tuple:
        if sort_by == "name":
            return (row.get("runner_name") or "",)
        if sort_by == "place":
            try:
                return (0, int(row.get("place_overall")))
            except (TypeError, ValueError):
                return (1, 999999)
        seconds = row.get("finish_seconds")
        return (0, seconds) if seconds is not None else (1, 10**9)

    return sorted(rows, key=key)


def summarize(rows: list[dict[str, Any]]) -> dict[str, Any]:
    timed = sorted(row["finish_seconds"] for row in rows if row.get("finish_seconds") is not None)
    finishers = [row for row in rows if row.get("logged") and str(row.get("status") or "") != "dns"]
    return {
        "finishers": len(finishers),
        "best": format_time(timed[0]) if timed else "—",
        "median": format_time(timed[len(timed) // 2]) if timed else "—",
        "prs": sum(1 for row in rows if row.get("is_pr")),
    }


def save_result(db: SupabaseClient, registration_id: str, payload: dict[str, Any], *, announce: bool = True) -> dict[str, Any]:
    cleaned = validate_result_payload(payload)
    rows = db.update("registrations", {"id": f"eq.{registration_id}"}, cleaned)
    if not rows:
        raise ResultError("Registration not found")
    result = rows[0]
    apply_side_effects(db, result, announce=announce)
    return result


def apply_side_effects(db: SupabaseClient, result: dict[str, Any], *, announce: bool = True) -> dict[str, Any]:
    """Refresh PRs, badges, join date, and community posts after a result write."""
    group_id = result.get("group_id")
    runner_id = result.get("runner_id")
    if not group_id or not runner_id:
        return {"prs": 0, "badges": 0, "posts": 0}
    races = db.select("marathons", filters={"group_id": f"eq.{group_id}"})
    registrations = db.select("registrations", filters={"group_id": f"eq.{group_id}"})
    stored = db.select("personal_records", filters={"group_id": f"eq.{group_id}"})
    runners = db.select("runners", filters={"group_id": f"eq.{group_id}"})
    events, _ = pr_service.detect_prs(races, [row for row in registrations if row.get("runner_id") == runner_id], stored)
    pr_count = 0
    for event in events:
        payload = pr_service.record_payload(event)
        db.insert("personal_records", payload, upsert=True)
        if event.registration.get("id"):
            db.update("registrations", {"id": f"eq.{event.registration['id']}"}, {"is_pr": True})
        pr_count += 1
        if announce:
            community_service.announce_pr(db, event, runners)
    existing_badges = db.select("runner_badges", filters={"group_id": f"eq.{group_id}", "runner_id": f"eq.{runner_id}"})
    new_keys = badge_service.new_badges_for_runner(runner_id, races, registrations, existing_badges, stored)
    for key in new_keys:
        db.insert("runner_badges", {"group_id": group_id, "runner_id": runner_id, "badge_key": key}, upsert=True)
        if announce:
            community_service.announce_badge(db, group_id, runner_id, key, runners)
    derived = join_date_service.first_race_date(runner_id, registrations, races)
    if derived:
        db.update("runners", {"id": f"eq.{runner_id}"}, {"join_date": derived})
    if announce and is_logged_result(result):
        community_service.announce_results(db, result.get("marathon_id"), races, registrations)
    return {"prs": pr_count, "badges": len(new_keys)}


def backfill_results_table(db: SupabaseClient, group_id: str) -> int:
    """Populate the optional normalized results table without touching registrations."""
    registrations = db.select("registrations", filters={"group_id": f"eq.{group_id}"})
    written = 0
    for row in registrations:
        if not is_logged_result(row):
            continue
        payload = {
            "id": row.get("id"),
            "group_id": row.get("group_id"),
            "race_id": row.get("marathon_id"),
            "registration_id": row.get("id"),
            "runner_id": row.get("runner_id"),
            "status": row.get("status"),
            "gun_time": row.get("gun_time") or "",
            "chip_time": row.get("chip_time") or "",
            "place_overall": row.get("place_overall") or "",
            "place_gender": row.get("place_gender") or "",
            "place_age_group": row.get("place_age_group") or "",
            "race_distance": row.get("race_distance") or "",
            "is_pr": bool(row.get("is_pr")),
            "result_notes": row.get("result_notes") or "",
        }
        try:
            db.insert("results", payload, upsert=True)
            written += 1
        except SupabaseError:
            break
    return written
