"""Club join date is the runner's first race date. Not user-editable."""

from __future__ import annotations

from typing import Any, Iterable

from app.services.time_utils import parse_iso_date


def first_race_date(
    runner_id: str,
    registrations: Iterable[dict[str, Any]],
    races: Iterable[dict[str, Any]],
) -> str | None:
    race_map = {row.get("id"): row for row in races}
    dates = []
    for row in registrations:
        if row.get("runner_id") != runner_id:
            continue
        race = race_map.get(row.get("marathon_id") or row.get("race_id"), {})
        parsed = parse_iso_date(race.get("race_date"))
        if parsed:
            dates.append(parsed)
    if not dates:
        return None
    return min(dates).isoformat()


def join_date_updates(
    runners: Iterable[dict[str, Any]],
    registrations: Iterable[dict[str, Any]],
    races: Iterable[dict[str, Any]],
) -> list[dict[str, Any]]:
    updates = []
    for runner in runners:
        runner_id = runner.get("id")
        if not runner_id:
            continue
        derived = first_race_date(runner_id, registrations, races)
        current = str(runner.get("join_date") or "")[:10] or None
        if derived and derived != current:
            updates.append({"id": runner_id, "join_date": derived, "previous": current})
    return updates
