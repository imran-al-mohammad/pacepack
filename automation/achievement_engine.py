"""Pure, dependency-free achievement rules for PacePack.

The functions in this module only transform dictionaries.  They can therefore
be tested with exported JSON and reused by a scheduled Supabase sync job.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable


DISTANCE_KM = {
    "5k": 5.0,
    "7.5k": 7.5,
    "10k": 10.0,
    "15k": 15.0,
    "half marathon": 21.0975,
    "half": 21.0975,
    "marathon": 42.195,
}


def parse_time(value: Any) -> int | None:
    """Return seconds for H:MM:SS, M:SS, or numeric seconds."""
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    if raw.isdigit():
        return int(raw)
    try:
        parts = [int(part) for part in raw.split(":")]
    except ValueError:
        return None
    if len(parts) == 2:
        return parts[0] * 60 + parts[1]
    if len(parts) == 3:
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    return None


def format_time(seconds: int | None) -> str:
    if seconds is None:
        return "—"
    seconds = int(seconds)
    hours, remainder = divmod(seconds, 3600)
    minutes, secs = divmod(remainder, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes}:{secs:02d}"


def normalized_distance(value: Any) -> str:
    """Normalize labels while preserving unknown distances for separate PRs."""
    raw = " ".join(str(value or "Other").strip().lower().split())
    raw = raw.replace("kilometers", "k").replace("kilometres", "k").replace(" km", "k")
    if raw in {"21.1k", "21k", "half-marathon"}:
        return "Half Marathon"
    if raw in {"42.2k", "42k", "full marathon"}:
        return "Marathon"
    for key, km in DISTANCE_KM.items():
        if raw == key or raw.replace(" ", "") == key.replace(" ", ""):
            if "half" in key:
                return "Half Marathon"
            if key == "marathon":
                return "Marathon"
            return key.upper()
    return str(value or "Other").strip() or "Other"


def finish_seconds(registration: dict[str, Any]) -> int | None:
    return parse_time(registration.get("chip_time")) or parse_time(registration.get("gun_time"))


def is_finish(registration: dict[str, Any]) -> bool:
    return (str(registration.get("status") or "").lower() in {"completed", "dnf"}
            or finish_seconds(registration) is not None)


def race_sort_key(registration: dict[str, Any], races: dict[str, dict[str, Any]]) -> tuple[str, str]:
    race = races.get(registration.get("marathon_id"), {})
    return (str(race.get("race_date") or "9999-12-31"), str(registration.get("id") or ""))


@dataclass(frozen=True)
class PREvent:
    registration: dict[str, Any]
    distance: str
    time_seconds: int
    previous_best: int | None


def detect_prs(
    runners: Iterable[dict[str, Any]],
    races: Iterable[dict[str, Any]],
    registrations: Iterable[dict[str, Any]],
    stored_records: Iterable[dict[str, Any]] = (),
) -> tuple[list[PREvent], dict[tuple[str, str], dict[str, Any]]]:
    """Detect strict improvements and return the resulting best records.

    The first timed finish is a PR.  A later finish is a new PR only when it
    is strictly faster; equal times are retained as a best result but do not
    generate another announcement.
    """
    del runners  # kept in the signature to make callers self-documenting
    race_map = {row.get("id"): row for row in races}
    best: dict[tuple[str, str], dict[str, Any]] = {}
    for record in stored_records:
        key = (record.get("runner_id"), normalized_distance(record.get("distance")))
        seconds = record.get("time_seconds")
        if key[0] and isinstance(seconds, (int, float)):
            best[key] = dict(record)

    events: list[PREvent] = []
    ordered = sorted((r for r in registrations if is_finish(r)), key=lambda r: race_sort_key(r, race_map))
    for registration in ordered:
        seconds = finish_seconds(registration)
        key = (registration.get("runner_id"), normalized_distance(race_map.get(registration.get("marathon_id"), {}).get("distance")))
        if not key[0] or seconds is None:
            continue
        previous = best.get(key)
        previous_seconds = int(previous["time_seconds"]) if previous else None
        if previous_seconds is None or seconds < previous_seconds:
            registration["is_pr"] = True
            events.append(PREvent(registration, key[1], seconds, previous_seconds))
            best[key] = {
                "runner_id": key[0],
                "distance": key[1],
                "time_seconds": seconds,
                "registration_id": registration.get("id"),
            }
        elif seconds == previous_seconds:
            registration["is_pr"] = True
    return events, best


BADGE_RULES = {
    "new_personal_record": "New Personal Record",
    "first_10k": "First 10K",
    "first_half_marathon": "First Half Marathon",
    "first_marathon": "First Marathon",
    "sub_5_marathon": "Sub-5:00 Marathon",
    "sub_4_marathon": "Sub-4:00 Marathon",
    "five_races": "5 Races Completed",
    "ten_races": "10 Races Completed",
}


def eligible_badges(
    runner_id: str,
    races: dict[str, dict[str, Any]],
    registrations: Iterable[dict[str, Any]],
) -> set[str]:
    finishes = [r for r in registrations if r.get("runner_id") == runner_id and is_finish(r)]
    distances = {normalized_distance(races.get(r.get("marathon_id"), {}).get("distance")) for r in finishes}
    marathon_times = [finish_seconds(r) for r in finishes if normalized_distance(races.get(r.get("marathon_id"), {}).get("distance")) == "Marathon"]
    marathon_times = [t for t in marathon_times if t is not None]
    eligible: set[str] = set()
    if any(r.get("is_pr") for r in finishes): eligible.add("new_personal_record")
    if "10K" in distances: eligible.add("first_10k")
    if "Half Marathon" in distances: eligible.add("first_half_marathon")
    if "Marathon" in distances: eligible.add("first_marathon")
    if any(t < 5 * 3600 for t in marathon_times): eligible.add("sub_5_marathon")
    if any(t < 4 * 3600 for t in marathon_times): eligible.add("sub_4_marathon")
    if len(finishes) >= 5: eligible.add("five_races")
    if len(finishes) >= 10: eligible.add("ten_races")
    return eligible
