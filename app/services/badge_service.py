"""Award badges from existing results. Idempotent; no manual award path."""

from __future__ import annotations

from typing import Any, Iterable

from app.services.pr_service import detect_prs
from app.services.time_utils import distance_km, finish_seconds, is_finish, registration_distance

BADGE_CATALOG: dict[str, dict[str, str]] = {
    "first_race": {"label": "First Race", "icon": "🏁", "description": "Logged a first race result"},
    "new_personal_record": {"label": "New Personal Record", "icon": "🏅", "description": "Set a personal best"},
    "first_10k": {"label": "First 10K", "icon": "🏃", "description": "Finished a 10K"},
    "first_half_marathon": {"label": "First Half Marathon", "icon": "🎖", "description": "Finished a half marathon"},
    "first_marathon": {"label": "First Marathon", "icon": "🎖", "description": "Finished a marathon"},
    "sub_5_marathon": {"label": "Sub-5:00 Marathon", "icon": "⚡", "description": "Marathon finish under 5 hours"},
    "sub_4_marathon": {"label": "Sub-4:00 Marathon", "icon": "⚡", "description": "Marathon finish under 4 hours"},
    "five_races": {"label": "5 Races Completed", "icon": "🏁", "description": "Five recorded finishes"},
    "ten_races": {"label": "10 Races Completed", "icon": "🏆", "description": "Ten recorded finishes"},
    "1000km": {"label": "1000 km Club", "icon": "🏅", "description": "1000 km of race distance"},
}


def eligible_badges(
    runner_id: str,
    races: Iterable[dict[str, Any]],
    registrations: Iterable[dict[str, Any]],
    stored_records: Iterable[dict[str, Any]] = (),
) -> set[str]:
    race_map = {row.get("id"): row for row in races}
    finishes = [row for row in registrations if row.get("runner_id") == runner_id and is_finish(row)]
    distances = {registration_distance(row, race_map.get(row.get("marathon_id") or row.get("race_id"))) for row in finishes}
    marathon_times = [
        finish_seconds(row)
        for row in finishes
        if registration_distance(row, race_map.get(row.get("marathon_id") or row.get("race_id"))) == "Marathon"
    ]
    marathon_times = [t for t in marathon_times if t is not None]
    total_km = 0.0
    for row in finishes:
        km = distance_km(registration_distance(row, race_map.get(row.get("marathon_id") or row.get("race_id"))))
        if km:
            total_km += km

    events, _ = detect_prs(races, [r for r in registrations if r.get("runner_id") == runner_id], stored_records)
    eligible: set[str] = set()
    if finishes:
        eligible.add("first_race")
    if events or any(row.get("is_pr") for row in finishes):
        eligible.add("new_personal_record")
    if "10K" in distances:
        eligible.add("first_10k")
    if "Half Marathon" in distances:
        eligible.add("first_half_marathon")
    if "Marathon" in distances:
        eligible.add("first_marathon")
    if any(t < 5 * 3600 for t in marathon_times):
        eligible.add("sub_5_marathon")
    if any(t < 4 * 3600 for t in marathon_times):
        eligible.add("sub_4_marathon")
    if len(finishes) >= 5:
        eligible.add("five_races")
    if len(finishes) >= 10:
        eligible.add("ten_races")
    if total_km >= 1000:
        eligible.add("1000km")
    return eligible


def new_badges_for_runner(
    runner_id: str,
    races: Iterable[dict[str, Any]],
    registrations: Iterable[dict[str, Any]],
    existing: Iterable[dict[str, Any]],
    stored_records: Iterable[dict[str, Any]] = (),
) -> list[str]:
    already = {row.get("badge_key") for row in existing if row.get("runner_id") == runner_id}
    return sorted(eligible_badges(runner_id, races, registrations, stored_records) - already)


def decorate_badges(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    decorated = []
    for row in rows:
        meta = BADGE_CATALOG.get(row.get("badge_key") or "", {})
        decorated.append(
            {
                **row,
                "label": meta.get("label") or str(row.get("badge_key") or "").replace("_", " ").title(),
                "icon": meta.get("icon") or "🏅",
                "description": meta.get("description") or "",
            }
        )
    decorated.sort(key=lambda item: item.get("awarded_at") or "", reverse=True)
    return decorated
