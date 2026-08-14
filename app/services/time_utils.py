from __future__ import annotations

from datetime import date, datetime
from typing import Any

DISTANCE_KM = {
    "5K": 5.0,
    "7.5K": 7.5,
    "10K": 10.0,
    "15K": 15.0,
    "Half Marathon": 21.0975,
    "Marathon": 42.195,
}

DISTANCE_ALIASES = {
    "5k": "5K",
    "5km": "5K",
    "7.5k": "7.5K",
    "7.5km": "7.5K",
    "10k": "10K",
    "10km": "10K",
    "15k": "15K",
    "15km": "15K",
    "half": "Half Marathon",
    "halfmarathon": "Half Marathon",
    "half-marathon": "Half Marathon",
    "21k": "Half Marathon",
    "21.1k": "Half Marathon",
    "21km": "Half Marathon",
    "21.1km": "Half Marathon",
    "marathon": "Marathon",
    "fullmarathon": "Marathon",
    "full-marathon": "Marathon",
    "42k": "Marathon",
    "42.2k": "Marathon",
    "42km": "Marathon",
    "42.2km": "Marathon",
}

STATUSES = [
    ("interested", "Interested"),
    ("registered", "Registered"),
    ("waitlisted", "Waitlisted"),
    ("completed", "Completed"),
    ("dns", "DNS"),
    ("dnf", "DNF"),
]

FINISH_STATUSES = {"completed", "dnf"}


def parse_time(value: Any) -> int | None:
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


def format_time(seconds: int | float | None) -> str:
    if seconds is None:
        return "—"
    seconds = int(round(seconds))
    if seconds < 0:
        return "—"
    hours, remainder = divmod(seconds, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


def format_pace(pace_seconds: int | float | None) -> str:
    if pace_seconds is None:
        return "—"
    return f"{format_time(pace_seconds)} /km"


def normalize_distance(value: Any) -> str:
    raw = " ".join(str(value or "Other").strip().lower().split())
    compact = raw.replace("kilometers", "k").replace("kilometres", "k").replace(" ", "").replace("-", "")
    if compact in DISTANCE_ALIASES:
        return DISTANCE_ALIASES[compact]
    if raw in DISTANCE_ALIASES:
        return DISTANCE_ALIASES[raw]
    for label in DISTANCE_KM:
        if raw == label.lower() or compact == label.lower().replace(" ", ""):
            return label
    cleaned = str(value or "Other").strip()
    return cleaned or "Other"


def distance_km(value: Any) -> float | None:
    return DISTANCE_KM.get(normalize_distance(value))


def finish_seconds(row: dict[str, Any]) -> int | None:
    return parse_time(row.get("chip_time")) or parse_time(row.get("gun_time"))


def display_finish_time(row: dict[str, Any]) -> str:
    raw = (row.get("chip_time") or row.get("gun_time") or "").strip()
    return raw or "—"


def is_finish(row: dict[str, Any]) -> bool:
    status = str(row.get("status") or "").lower()
    return status in FINISH_STATUSES or finish_seconds(row) is not None


def is_logged_result(row: dict[str, Any]) -> bool:
    """A result is 'logged' when a finish time or terminal status exists."""
    status = str(row.get("status") or "").lower()
    if status in {"completed", "dnf", "dns"}:
        return True
    return finish_seconds(row) is not None


def registration_distance(row: dict[str, Any], race: dict[str, Any] | None = None) -> str:
    return normalize_distance(row.get("race_distance") or (race or {}).get("distance") or "Other")


def pace_seconds(row: dict[str, Any], race: dict[str, Any] | None = None) -> float | None:
    seconds = finish_seconds(row)
    km = distance_km(registration_distance(row, race))
    if seconds is None or not km:
        return None
    return seconds / km


def parse_iso_date(value: Any) -> date | None:
    if not value:
        return None
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    raw = str(value)[:10]
    try:
        return date.fromisoformat(raw)
    except ValueError:
        return None


def format_date(value: Any) -> str:
    parsed = parse_iso_date(value)
    if not parsed:
        return "—"
    return parsed.strftime("%d %b %Y")


def month_short_year(value: Any) -> str:
    parsed = parse_iso_date(value)
    if not parsed:
        return "—"
    return parsed.strftime("%b %Y")


def today() -> date:
    return date.today()


def is_past_race(race: dict[str, Any], on: date | None = None) -> bool:
    race_date = parse_iso_date(race.get("race_date"))
    if not race_date:
        return False
    return race_date < (on or today())


def days_until(race: dict[str, Any], on: date | None = None) -> int | None:
    race_date = parse_iso_date(race.get("race_date"))
    if not race_date:
        return None
    return (race_date - (on or today())).days


def race_datetime(race: dict[str, Any]) -> datetime | None:
    race_date = parse_iso_date(race.get("race_date"))
    if not race_date:
        return None
    time_raw = str(race.get("race_time") or "09:00").strip() or "09:00"
    try:
        hour, minute = [int(p) for p in time_raw.split(":")[:2]]
    except ValueError:
        hour, minute = 9, 0
    return datetime(race_date.year, race_date.month, race_date.day, hour, minute)


def status_label(value: str | None) -> str:
    lookup = dict(STATUSES)
    return lookup.get(str(value or "").lower(), str(value or "Unknown").title())


def initials(name: str | None) -> str:
    parts = [p for p in str(name or "").split() if p]
    if not parts:
        return "?"
    if len(parts) == 1:
        return parts[0][:2].upper()
    return (parts[0][0] + parts[-1][0]).upper()


def avatar_color(seed: str | None) -> str:
    colors = ["#ff6b4a", "#2dd4bf", "#60a5fa", "#fbbf24", "#c084fc", "#4ade80", "#f472b6", "#38bdf8"]
    if not seed:
        return colors[0]
    return colors[sum(ord(ch) for ch in seed) % len(colors)]
