"""
PacePack analytics & insights engine.

Pure Python so formulas stay testable. Export to browser JS with:

    python analytics/export_js.py

The generated insights.js exposes window.PacePackAnalytics.analyze(data).
"""

from __future__ import annotations

from statistics import mean, median
from typing import Any


def parse_time_to_seconds(value: Any) -> int | None:
    """Parse H:MM:SS, M:SS, or bare seconds into total seconds."""
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    if raw.isdigit():
        return int(raw)
    parts = raw.split(":")
    try:
        nums = [int(p) for p in parts]
    except ValueError:
        return None
    if len(nums) == 3:
        h, m, s = nums
        return h * 3600 + m * 60 + s
    if len(nums) == 2:
        m, s = nums
        return m * 60 + s
    return None


def format_seconds(total: int | None) -> str:
    if total is None:
        return "—"
    total = int(round(total))
    if total < 0:
        return "—"
    h = total // 3600
    m = (total % 3600) // 60
    s = total % 60
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def best_finish_seconds(reg: dict) -> int | None:
    chip = parse_time_to_seconds(reg.get("chip_time"))
    if chip is not None:
        return chip
    return parse_time_to_seconds(reg.get("gun_time"))


def has_finish(reg: dict) -> bool:
    status = (reg.get("status") or "").lower()
    return status == "completed" or best_finish_seconds(reg) is not None


def analyze(
    runners: list[dict] | None = None,
    marathons: list[dict] | None = None,
    registrations: list[dict] | None = None,
) -> dict[str, Any]:
    """
    Compute metrics and natural-language insights for a club.

    Parameters mirror the app's in-memory tables (list of dict rows).
    """
    runners = runners or []
    marathons = marathons or []
    registrations = registrations or []

    runner_by_id = {r.get("id"): r for r in runners if r.get("id")}
    marathon_by_id = {m.get("id"): m for m in marathons if m.get("id")}

    total_runners = len(runners)
    total_marathons = len(marathons)
    total_regs = len(registrations)

    runners_with_entry = {r.get("runner_id") for r in registrations if r.get("runner_id")}
    active_runners = len(runners_with_entry)
    participation = (active_runners / total_runners * 100) if total_runners else None

    avg_signups = (total_regs / total_marathons) if total_marathons else None

    finishes = [r for r in registrations if has_finish(r)]
    timed = [best_finish_seconds(r) for r in finishes]
    timed = [t for t in timed if t is not None]
    prs = sum(1 for r in registrations if r.get("is_pr"))
    pr_rate = (prs / len(finishes) * 100) if finishes else None

    # Per-race depth
    by_race: dict[str, int] = {}
    for r in registrations:
        mid = r.get("marathon_id")
        if mid:
            by_race[mid] = by_race.get(mid, 0) + 1
    busiest_id = max(by_race, key=by_race.get) if by_race else None
    busiest = marathon_by_id.get(busiest_id) if busiest_id else None
    quietest_id = min(by_race, key=by_race.get) if by_race else None
    # races with zero regs
    empty_races = [m for m in marathons if by_race.get(m.get("id"), 0) == 0]

    # Per-runner activity
    by_runner: dict[str, dict[str, Any]] = {}
    for r in registrations:
        rid = r.get("runner_id")
        if not rid:
            continue
        cur = by_runner.setdefault(rid, {"entries": 0, "finishes": 0, "prs": 0, "times": []})
        cur["entries"] += 1
        if has_finish(r):
            cur["finishes"] += 1
        if r.get("is_pr"):
            cur["prs"] += 1
        t = best_finish_seconds(r)
        if t is not None:
            cur["times"].append(t)

    most_active_id = None
    if by_runner:
        most_active_id = max(
            by_runner,
            key=lambda rid: (by_runner[rid]["entries"], by_runner[rid]["finishes"], by_runner[rid]["prs"]),
        )
    most_active = runner_by_id.get(most_active_id) if most_active_id else None

    # Distance mix
    distance_counts: dict[str, int] = {}
    for m in marathons:
        d = m.get("distance") or "Other"
        distance_counts[d] = distance_counts.get(d, 0) + 1
    top_distance = max(distance_counts, key=distance_counts.get) if distance_counts else None

    # Status mix
    status_counts: dict[str, int] = {}
    for r in registrations:
        s = r.get("status") or "unknown"
        status_counts[s] = status_counts.get(s, 0) + 1

    inactive = [r for r in runners if r.get("id") not in runners_with_entry]

    metrics = {
        "total_runners": total_runners,
        "active_runners": active_runners,
        "inactive_runners": len(inactive),
        "participation_rate_pct": round(participation, 1) if participation is not None else None,
        "total_marathons": total_marathons,
        "total_registrations": total_regs,
        "avg_signups_per_race": round(avg_signups, 1) if avg_signups is not None else None,
        "results_with_time": len(timed),
        "total_prs": prs,
        "pr_rate_pct": round(pr_rate, 1) if pr_rate is not None else None,
        "median_finish_seconds": int(median(timed)) if timed else None,
        "avg_finish_seconds": int(mean(timed)) if timed else None,
        "median_finish_display": format_seconds(int(median(timed))) if timed else None,
        "avg_finish_display": format_seconds(int(mean(timed))) if timed else None,
        "busiest_race_name": (busiest or {}).get("name"),
        "busiest_race_count": by_race.get(busiest_id, 0) if busiest_id else 0,
        "most_active_runner": (most_active or {}).get("name"),
        "most_active_entries": by_runner.get(most_active_id, {}).get("entries", 0) if most_active_id else 0,
        "top_distance": top_distance,
        "empty_race_count": len(empty_races),
        "status_counts": status_counts,
        "distance_counts": distance_counts,
    }

    insights: list[str] = []

    if total_runners == 0:
        insights.append("No runners on the roster yet — add members or runners to start tracking.")
    elif participation is not None:
        if participation >= 75:
            insights.append(
                f"Strong engagement: {participation:.0f}% of runners have at least one race entry."
            )
        elif participation >= 40:
            insights.append(
                f"Moderate engagement: {participation:.0f}% of runners are signed up for races — "
                f"{len(inactive)} still have no entries."
            )
        else:
            insights.append(
                f"Low participation: only {participation:.0f}% of runners have entries. "
                f"Consider registering inactive athletes for upcoming races."
            )

    if busiest and metrics["busiest_race_count"]:
        insights.append(
            f"Busiest race is “{busiest.get('name')}” with {metrics['busiest_race_count']} signup"
            f"{'' if metrics['busiest_race_count'] == 1 else 's'}."
        )

    if empty_races:
        names = ", ".join(f"“{m.get('name')}”" for m in empty_races[:3])
        extra = f" (+{len(empty_races) - 3} more)" if len(empty_races) > 3 else ""
        insights.append(f"{len(empty_races)} race(s) still have zero signups: {names}{extra}.")

    if most_active and metrics["most_active_entries"]:
        insights.append(
            f"Most active runner is {most_active.get('name')} "
            f"({metrics['most_active_entries']} registration"
            f"{'' if metrics['most_active_entries'] == 1 else 's'})."
        )

    if pr_rate is not None and finishes:
        if pr_rate >= 25:
            insights.append(
                f"High PR rate ({pr_rate:.0f}% of finishes) — the group is improving quickly."
            )
        elif prs:
            insights.append(
                f"{prs} personal record{'' if prs == 1 else 's'} logged "
                f"({pr_rate:.0f}% of finishes)."
            )
        else:
            insights.append("No PRs flagged yet — mark breakthrough performances after race day.")

    if timed:
        insights.append(
            f"Among {len(timed)} timed result{'' if len(timed) == 1 else 's'}, "
            f"group median finish is {metrics['median_finish_display']} "
            f"(average {metrics['avg_finish_display']})."
        )

    if top_distance and distance_counts.get(top_distance, 0) > 1:
        insights.append(
            f"Most common distance is {top_distance} "
            f"({distance_counts[top_distance]} of {total_marathons} races)."
        )

    interested = status_counts.get("interested", 0)
    waitlisted = status_counts.get("waitlisted", 0)
    if interested:
        insights.append(
            f"{interested} “interested” entr{'y' if interested == 1 else 'ies'} — "
            "follow up to convert them to registered."
        )
    if waitlisted:
        insights.append(f"{waitlisted} waitlisted entry(ies) may need capacity planning.")

    if avg_signups is not None and total_marathons >= 2:
        if avg_signups < 2:
            insights.append(
                f"Average of {avg_signups:.1f} signups per race is light — "
                "group challenges or shared training plans can lift turnout."
            )
        elif avg_signups >= 5:
            insights.append(
                f"Healthy turnout: about {avg_signups:.1f} signups per race on average."
            )

    # Improvement: runners with ≥2 timed results where latest is faster than first
    improvers = 0
    for rid, stats in by_runner.items():
        times = stats["times"]
        if len(times) >= 2 and times[-1] < times[0]:
            improvers += 1
    if improvers:
        insights.append(
            f"{improvers} runner{'' if improvers == 1 else 's'} improved their latest timed "
            "result versus their earliest logged time."
        )

    return {
        "metrics": metrics,
        "insights": insights[:10],
    }


if __name__ == "__main__":
    # Tiny self-check with sample data
    sample = analyze(
        runners=[{"id": "r1", "name": "Ava"}, {"id": "r2", "name": "Ben"}],
        marathons=[
            {"id": "m1", "name": "City 10K", "distance": "10K"},
            {"id": "m2", "name": "Spring Half", "distance": "Half Marathon"},
        ],
        registrations=[
            {"runner_id": "r1", "marathon_id": "m1", "status": "completed", "chip_time": "0:48:12", "is_pr": True},
            {"runner_id": "r1", "marathon_id": "m2", "status": "registered"},
            {"runner_id": "r2", "marathon_id": "m1", "status": "interested"},
        ],
    )
    from pprint import pprint

    pprint(sample)
