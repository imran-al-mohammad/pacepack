"""Validate historical data integrity without writing.

    python -m app.jobs.validate snapshot.json
    python -m app.jobs.validate --group-id UUID
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from app.jobs.backfill import load_snapshot, plan_backfill
from app.services.time_utils import finish_seconds, is_finish, normalize_distance


def validate(data: dict) -> list[str]:
    errors: list[str] = []
    runner_ids = {row.get("id") for row in data.get("runners", [])}
    race_ids = {row.get("id") for row in data.get("marathons", [])}
    seen = set()
    for row in data.get("registrations", []):
        key = (row.get("marathon_id") or row.get("race_id"), row.get("runner_id"))
        if key in seen:
            errors.append(f"duplicate registration pair: {key}")
        seen.add(key)
        if row.get("runner_id") not in runner_ids:
            errors.append(f"registration {row.get('id')} references missing runner")
        race_id = row.get("marathon_id") or row.get("race_id")
        if race_id not in race_ids:
            errors.append(f"registration {row.get('id')} references missing race")
        if is_finish(row) and finish_seconds(row) is None and row.get("status") != "dnf":
            errors.append(f"finished registration {row.get('id')} has invalid time")
        race = next((item for item in data.get("marathons", []) if item.get("id") == race_id), {})
        if is_finish(row) and normalize_distance(row.get("race_distance") or race.get("distance")) == "Other":
            errors.append(f"registration {row.get('id')} has an unknown race distance")
    plan = plan_backfill(
        {
            "runners": data.get("runners", []),
            "marathons": data.get("marathons", []),
            "registrations": data.get("registrations", []),
            "personal_records": data.get("personal_records", []),
            "runner_badges": data.get("runner_badges", []),
            "community_posts": data.get("community_posts", []),
        }
    )
    if plan["pr_events"] and not data.get("personal_records"):
        errors.append(f"{plan['pr_events']} personal records can be backfilled from historical results")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", nargs="?", type=Path)
    parser.add_argument("--group-id")
    args = parser.parse_args()
    if args.snapshot:
        data = load_snapshot(str(args.snapshot))
    elif args.group_id:
        from app.db import service_client

        db = service_client()
        data = {
            "runners": db.select("runners", filters={"group_id": f"eq.{args.group_id}"}),
            "marathons": db.select("marathons", filters={"group_id": f"eq.{args.group_id}"}),
            "registrations": db.select("registrations", filters={"group_id": f"eq.{args.group_id}"}),
            "personal_records": db.select("personal_records", filters={"group_id": f"eq.{args.group_id}"}),
            "runner_badges": db.select("runner_badges", filters={"group_id": f"eq.{args.group_id}"}),
        }
    else:
        parser.error("provide a snapshot file or --group-id")
    problems = validate(data)
    for problem in problems:
        print(f"ERROR: {problem}")
    print(f"Checked: {len(problems)} issue(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
