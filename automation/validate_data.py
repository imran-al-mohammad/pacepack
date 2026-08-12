"""Validate an exported PacePack JSON snapshot without changing it."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from achievement_engine import finish_seconds, is_finish, normalized_distance


def validate(data: dict) -> list[str]:
    errors: list[str] = []
    runner_ids = {r.get("id") for r in data.get("runners", [])}
    race_ids = {r.get("id") for r in data.get("marathons", [])}
    seen = set()
    for row in data.get("registrations", []):
        key = (row.get("marathon_id"), row.get("runner_id"))
        if key in seen: errors.append(f"duplicate registration pair: {key}")
        seen.add(key)
        if row.get("runner_id") not in runner_ids: errors.append(f"registration {row.get('id')} references missing runner")
        if row.get("marathon_id") not in race_ids: errors.append(f"registration {row.get('id')} references missing race")
        if is_finish(row) and finish_seconds(row) is None: errors.append(f"finished registration {row.get('id')} has invalid time")
        if is_finish(row) and normalized_distance(next((r.get("distance") for r in data.get("marathons", []) if r.get("id") == row.get("marathon_id")), "Other")) == "Other":
            errors.append(f"registration {row.get('id')} has an unknown race distance")
    return errors


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("snapshot", type=Path)
    args = parser.parse_args()
    problems = validate(json.loads(args.snapshot.read_text(encoding="utf-8")))
    for problem in problems: print(f"ERROR: {problem}")
    print(f"Checked snapshot: {len(problems)} issue(s)")
    raise SystemExit(1 if problems else 0)

