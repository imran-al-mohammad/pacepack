"""Detect personal records from results. No manual PR entry."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable

from app.services.time_utils import (
    distance_km,
    finish_seconds,
    is_finish,
    normalize_distance,
    registration_distance,
)


@dataclass(frozen=True)
class PREvent:
    registration: dict[str, Any]
    runner_id: str
    distance: str
    time_seconds: int
    previous_best: int | None
    race: dict[str, Any]


def _race_sort_key(registration: dict[str, Any], races: dict[str, dict[str, Any]]) -> tuple[str, str]:
    race = races.get(registration.get("marathon_id") or registration.get("race_id"), {})
    return (str(race.get("race_date") or "9999-12-31"), str(registration.get("id") or ""))


def detect_prs(
    races: Iterable[dict[str, Any]],
    registrations: Iterable[dict[str, Any]],
    stored_records: Iterable[dict[str, Any]] = (),
) -> tuple[list[PREvent], dict[tuple[str, str], dict[str, Any]]]:
    """First timed finish is a PR. Later finishes are PRs only when strictly faster."""
    race_map = {row.get("id"): row for row in races}
    best: dict[tuple[str, str], dict[str, Any]] = {}
    for record in stored_records:
        key = (record.get("runner_id"), normalize_distance(record.get("distance")))
        seconds = record.get("time_seconds")
        if key[0] and isinstance(seconds, (int, float)):
            best[key] = dict(record)

    events: list[PREvent] = []
    ordered = sorted((r for r in registrations if is_finish(r)), key=lambda r: _race_sort_key(r, race_map))
    for registration in ordered:
        seconds = finish_seconds(registration)
        race = race_map.get(registration.get("marathon_id") or registration.get("race_id"), {})
        distance = registration_distance(registration, race)
        runner_id = registration.get("runner_id")
        if not runner_id or seconds is None:
            continue
        key = (runner_id, distance)
        previous = best.get(key)
        previous_seconds = int(previous["time_seconds"]) if previous and previous.get("time_seconds") is not None else None
        if previous_seconds is None or seconds < previous_seconds:
            registration["is_pr"] = True
            events.append(
                PREvent(
                    registration=registration,
                    runner_id=runner_id,
                    distance=distance,
                    time_seconds=seconds,
                    previous_best=previous_seconds,
                    race=race,
                )
            )
            km = distance_km(distance) or 1
            best[key] = {
                "runner_id": runner_id,
                "distance": distance,
                "time_seconds": seconds,
                "pace_seconds_per_km": round(seconds / km, 3),
                "registration_id": registration.get("id"),
                "race_date": race.get("race_date"),
                "race_name": race.get("name") or "",
                "location": race.get("location") or "",
                "is_new_pr": True,
                "group_id": registration.get("group_id") or race.get("group_id"),
            }
        elif seconds == previous_seconds:
            registration["is_pr"] = True
    return events, best


def record_payload(event: PREvent) -> dict[str, Any]:
    km = distance_km(event.distance) or 1
    return {
        "group_id": event.registration.get("group_id") or event.race.get("group_id"),
        "runner_id": event.runner_id,
        "distance": event.distance,
        "time_seconds": event.time_seconds,
        "pace_seconds_per_km": round(event.time_seconds / km, 3),
        "race_date": event.race.get("race_date"),
        "race_name": event.race.get("name") or "",
        "location": event.race.get("location") or "",
        "is_new_pr": event.previous_best is not None,
    }


def records_for_runner(records: Iterable[dict[str, Any]], runner_id: str | None) -> list[dict[str, Any]]:
    if not runner_id:
        return []
    rows = [row for row in records if row.get("runner_id") == runner_id]
    rows.sort(key=lambda row: (distance_km(row.get("distance")) or 999, row.get("distance") or ""))
    return rows


def canonical_pr_registration_ids(
    races: Iterable[dict[str, Any]],
    registrations: Iterable[dict[str, Any]],
    stored_records: Iterable[dict[str, Any]] = (),
) -> set[str]:
    events, _ = detect_prs(races, registrations, stored_records)
    return {event.registration.get("id") for event in events if event.registration.get("id")}
