"""Dashboard and profile analytics. Pure functions over already-loaded rows."""

from __future__ import annotations

from datetime import date
from statistics import mean, median
from typing import Any

from app.services.time_utils import (
    days_until,
    distance_km,
    finish_seconds,
    format_pace,
    format_time,
    is_finish,
    is_past_race,
    parse_iso_date,
    registration_distance,
    today,
)


def club_report(runners: list[dict], races: list[dict], registrations: list[dict]) -> dict[str, Any]:
    runner_ids = {row.get("id") for row in runners}
    active = {row.get("runner_id") for row in registrations if row.get("runner_id")}
    finishes = [row for row in registrations if is_finish(row)]
    timed = [t for t in (finish_seconds(row) for row in finishes) if t is not None]
    prs = sum(1 for row in registrations if row.get("is_pr"))
    participation = (len(active) / len(runner_ids) * 100) if runner_ids else None
    avg_signups = (len(registrations) / len(races)) if races else None
    pr_rate = (prs / len(finishes) * 100) if finishes else None
    by_race: dict[str, int] = {}
    for row in registrations:
        mid = row.get("marathon_id") or row.get("race_id")
        if mid:
            by_race[mid] = by_race.get(mid, 0) + 1
    empty = [race for race in races if by_race.get(race.get("id"), 0) == 0]
    popular = max(races, key=lambda race: by_race.get(race.get("id"), 0), default=None)
    waitlisted = sum(1 for row in registrations if row.get("status") == "waitlisted")
    insights: list[str] = []
    if empty:
        insights.append(f"{len(empty)} race{'s' if len(empty) != 1 else ''} still have zero signups")
    if popular and by_race.get(popular.get("id")):
        insights.append(f"Most popular race: {popular.get('name')} with {by_race[popular.get('id')]} signup{'s' if by_race[popular.get('id')] != 1 else ''}")
    if waitlisted:
        insights.append(f"{waitlisted} runner{'s' if waitlisted != 1 else ''} on the waitlist need follow-up")
    if participation is not None:
        insights.append(f"{participation:.0f}% of runners have at least one race entry")
    if not insights and not runners:
        insights.append("Add runners and races to unlock group insights")

    fastest = fastest_runners(runners, races, registrations)[:5]
    if fastest:
        insights.insert(0, f"{fastest[0]['name']} is currently fastest at {fastest[0]['best_pace_display']}/km")

    return {
        "metrics": {
            "total_runners": len(runners),
            "active_runners": len(active),
            "participation_rate_pct": round(participation, 1) if participation is not None else None,
            "total_races": len(races),
            "total_registrations": len(registrations),
            "avg_signups_per_race": round(avg_signups, 1) if avg_signups is not None else None,
            "results_with_time": len(timed),
            "total_prs": prs,
            "pr_rate_pct": round(pr_rate, 1) if pr_rate is not None else None,
            "median_finish_display": format_time(int(median(timed))) if timed else None,
            "avg_finish_display": format_time(int(mean(timed))) if timed else None,
            "empty_race_count": len(empty),
            "waitlisted": waitlisted,
            "fastest_runners": fastest,
        },
        "insights": insights[:6],
    }


def fastest_runners(runners: list[dict], races: list[dict], registrations: list[dict]) -> list[dict[str, Any]]:
    race_map = {row.get("id"): row for row in races}
    runner_map = {row.get("id"): row for row in runners}
    best: dict[str, dict[str, Any]] = {}
    for row in registrations:
        race = race_map.get(row.get("marathon_id") or row.get("race_id"))
        seconds = finish_seconds(row)
        km = distance_km(registration_distance(row, race))
        if seconds is None or not km:
            continue
        pace = seconds / km
        current = best.get(row.get("runner_id"))
        if not current or pace < current["best_pace"]:
            best[row.get("runner_id")] = {
                "runner_id": row.get("runner_id"),
                "name": (runner_map.get(row.get("runner_id")) or {}).get("name") or "Unknown",
                "best_pace": pace,
                "best_pace_display": format_time(pace),
                "races": (current["races"] + 1) if current else 1,
            }
        elif current:
            current["races"] += 1
    return sorted(best.values(), key=lambda item: item["best_pace"])


def activity_leaderboard(runners: list[dict], registrations: list[dict]) -> list[dict[str, Any]]:
    runner_map = {row.get("id"): row for row in runners}
    by_runner: dict[str, dict[str, Any]] = {}
    for row in registrations:
        runner_id = row.get("runner_id")
        current = by_runner.setdefault(
            runner_id,
            {"runner_id": runner_id, "entries": 0, "finishes": 0, "prs": 0, "times": []},
        )
        current["entries"] += 1
        if is_finish(row):
            current["finishes"] += 1
        if row.get("is_pr"):
            current["prs"] += 1
        seconds = finish_seconds(row)
        if seconds is not None:
            current["times"].append(seconds)
    rows = []
    for runner_id, stats in by_runner.items():
        runner = runner_map.get(runner_id) or {}
        rows.append(
            {
                **stats,
                "runner": runner,
                "name": runner.get("name") or "Unknown",
                "score": stats["finishes"] + stats["prs"] * 2,
                "best_time": min(stats["times"]) if stats["times"] else None,
                "best_time_display": format_time(min(stats["times"])) if stats["times"] else "—",
            }
        )
    rows.sort(key=lambda item: (-item["score"], -item["finishes"], -item["entries"], item["name"]))
    return rows


def dashboard_summary(runners: list[dict], races: list[dict], registrations: list[dict], team_count: int = 0) -> dict[str, Any]:
    upcoming = sorted(
        [race for race in races if not is_past_race(race)],
        key=lambda race: str(race.get("race_date") or "9999"),
    )
    past = [race for race in races if is_past_race(race)]
    next_race = upcoming[0] if upcoming else None
    countdown = None
    if next_race:
        remain = days_until(next_race)
        countdown = {
            "race": next_race,
            "days": remain if remain is not None else 0,
            "label": "Today" if remain == 0 else ("Tomorrow" if remain == 1 else f"In {remain} days"),
        }
    recent = []
    race_map = {row.get("id"): row for row in races}
    runner_map = {row.get("id"): row for row in runners}
    finished = [row for row in registrations if is_finish(row)]
    finished.sort(key=lambda row: str(row.get("updated_at") or row.get("created_at") or ""), reverse=True)
    for row in finished[:6]:
        race = race_map.get(row.get("marathon_id") or row.get("race_id")) or {}
        runner = runner_map.get(row.get("runner_id")) or {}
        recent.append(
            {
                "runner_name": runner.get("name") or "Unknown",
                "race_name": race.get("name") or "Race",
                "time": format_time(finish_seconds(row)),
                "is_pr": bool(row.get("is_pr")),
            }
        )
    report = club_report(runners, races, registrations)
    leaderboard = activity_leaderboard(runners, registrations)
    return {
        "upcoming_count": len(upcoming),
        "past_count": len(past),
        "runner_count": len(runners),
        "team_count": team_count,
        "registered_count": sum(1 for row in registrations if row.get("status") == "registered"),
        "entry_count": len(registrations),
        "results_logged": sum(1 for row in registrations if finish_seconds(row) is not None),
        "completed_count": sum(1 for row in registrations if row.get("status") == "completed"),
        "upcoming": upcoming[:6],
        "recent": recent,
        "countdown": countdown,
        "report": report,
        "leaderboard": leaderboard[:5],
        "fastest": report["metrics"]["fastest_runners"][:5],
        "signup_counts": {
            race.get("id"): sum(1 for row in registrations if (row.get("marathon_id") or row.get("race_id")) == race.get("id"))
            for race in upcoming[:6]
        },
    }


def runner_stats(runner_id: str | None, races: list[dict], registrations: list[dict]) -> dict[str, Any]:
    if not runner_id:
        return empty_runner_stats()
    race_map = {row.get("id"): row for row in races}
    mine = [row for row in registrations if row.get("runner_id") == runner_id]
    timed = []
    for row in mine:
        race = race_map.get(row.get("marathon_id") or row.get("race_id"))
        seconds = finish_seconds(row)
        km = distance_km(registration_distance(row, race))
        race_date = parse_iso_date((race or {}).get("race_date"))
        if seconds is None or not km or not race:
            continue
        timed.append({"row": row, "race": race, "seconds": seconds, "km": km, "pace": seconds / km, "date": race_date})
    year = today().year
    year_rows = [item for item in timed if item["date"] and item["date"].year == year]
    last_90 = [item for item in timed if item["date"] and (today() - item["date"]).days <= 90]
    weekly: dict[str, float] = {}
    for item in timed:
        if not item["date"]:
            continue
        iso = item["date"].isocalendar()
        weekly[f"{iso.year}-{iso.week}"] = weekly.get(f"{iso.year}-{iso.week}", 0) + item["km"]
    return {
        "registrations": len(mine),
        "completed": len(timed),
        "best_pace": min((item["pace"] for item in timed), default=None),
        "best_pace_display": format_pace(min((item["pace"] for item in timed), default=None)),
        "avg_pace_3mo": (sum(item["pace"] for item in last_90) / len(last_90)) if last_90 else None,
        "avg_pace_3mo_display": format_pace((sum(item["pace"] for item in last_90) / len(last_90)) if last_90 else None),
        "total_distance_year": sum(item["km"] for item in year_rows),
        "total_distance_all": sum(item["km"] for item in timed),
        "total_runs_year": len(year_rows),
        "longest_run": max((item["km"] for item in timed), default=None),
        "highest_weekly": max(weekly.values(), default=None),
        "streak": compute_streak(timed),
        "timed": timed,
    }


def empty_runner_stats() -> dict[str, Any]:
    return {
        "registrations": 0,
        "completed": 0,
        "best_pace": None,
        "best_pace_display": "—",
        "avg_pace_3mo": None,
        "avg_pace_3mo_display": "—",
        "total_distance_year": 0,
        "total_distance_all": 0,
        "total_runs_year": 0,
        "longest_run": None,
        "highest_weekly": None,
        "streak": 0,
        "timed": [],
    }


def compute_streak(timed: list[dict[str, Any]]) -> int:
    months = {
        (item["date"].year, item["date"].month)
        for item in timed
        if item.get("date")
    }
    if not months:
        return 0
    cursor = date(today().year, today().month, 1)
    streak = 0
    while (cursor.year, cursor.month) in months:
        streak += 1
        if cursor.month == 1:
            cursor = date(cursor.year - 1, 12, 1)
        else:
            cursor = date(cursor.year, cursor.month - 1, 1)
    return streak


def format_distance(km: float | None) -> str:
    if km is None:
        return "—"
    if km >= 42.195:
        return f"{km / 42.195:.2f} marathons"
    if km >= 21.0975:
        return f"{km / 21.0975:.1f} HM"
    return f"{km:.1f} km"


def profile_analytics(stats: dict[str, Any]) -> dict[str, Any]:
    timed = stats.get("timed") or []
    points = timed[-8:]
    paces = [item["pace"] for item in points]
    fastest = min(paces) if paces else None
    slowest = max(paces) if paces else None
    trend = []
    for item in points:
        if fastest is None or slowest is None:
            ratio = 0.7
        elif slowest == fastest:
            ratio = 0.7
        else:
            ratio = 0.28 + ((slowest - item["pace"]) / (slowest - fastest)) * 0.72
        trend.append({**item, "ratio": ratio})
    counts: dict[str, int] = {}
    for item in timed:
        label = registration_distance(item["row"], item["race"])
        counts[label] = counts.get(label, 0) + 1
    order = ["5K", "7.5K", "10K", "15K", "Half Marathon", "Marathon", "Ultra", "Other"]
    mix = [(label, counts.get(label, 0)) for label in order if counts.get(label)]
    for label, count in counts.items():
        if label not in order:
            mix.append((label, count))
    now = today()
    months = []
    for offset in range(11, -1, -1):
        month = now.month - offset
        year = now.year
        while month <= 0:
            month += 12
            year -= 1
        key = (year, month)
        count = sum(1 for item in timed if item.get("date") and (item["date"].year, item["date"].month) == key)
        months.append({"label": date(year, month, 1).strftime("%b"), "count": count})
    pr_groups: dict[str, list] = {}
    for item in timed:
        if item["row"].get("is_pr"):
            pr_groups.setdefault(registration_distance(item["row"], item["race"]), []).append(item)
    return {
        "trend": trend,
        "mix": mix,
        "mix_max": max((count for _, count in mix), default=1),
        "months": months,
        "month_max": max((item["count"] for item in months), default=1),
        "recent": list(reversed(timed[-5:])),
        "pr_groups": pr_groups,
        "completion_pct": round((stats["completed"] / stats["registrations"]) * 100) if stats["registrations"] else 0,
    }
