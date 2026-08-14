"""Idempotent backfills for PRs, badges, and join dates.

Examples:
    python -m app.jobs.backfill --group-id UUID --dry-run
    python -m app.jobs.backfill --group-id UUID --apply
    python -m app.jobs.backfill --input snapshot.json --dry-run
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from app.db import service_client
from app.services import badge_service, community_service, join_date_service, pr_service, result_service
from app.services.time_utils import is_logged_result


def load_snapshot(path: str) -> dict[str, list[dict[str, Any]]]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return {
        "runners": data.get("runners", []),
        "marathons": data.get("marathons", data.get("races", [])),
        "registrations": data.get("registrations", data.get("results", [])),
        "personal_records": data.get("personal_records", []),
        "runner_badges": data.get("runner_badges", []),
        "community_posts": data.get("community_posts", []),
    }


def plan_backfill(data: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    races = data["marathons"]
    registrations = data["registrations"]
    events, best = pr_service.detect_prs(races, registrations, data["personal_records"])
    pr_payloads = [pr_service.record_payload(event) for event in events]
    badges: list[dict[str, Any]] = []
    for runner in data["runners"]:
        runner_id = runner.get("id")
        if not runner_id:
            continue
        for key in badge_service.new_badges_for_runner(
            runner_id, races, registrations, data["runner_badges"], data["personal_records"]
        ):
            badges.append({"group_id": runner.get("group_id"), "runner_id": runner_id, "badge_key": key})
    joins = join_date_service.join_date_updates(data["runners"], registrations, races)
    logged = [row for row in registrations if is_logged_result(row)]
    return {
        "pr_events": len(events),
        "pr_records": pr_payloads,
        "badges": badges,
        "join_dates": joins,
        "logged_results": len(logged),
        "best_records": list(best.values()),
    }


def apply_backfill(group_id: str, announce: bool = False) -> dict[str, Any]:
    db = service_client()
    data = {
        "runners": db.select("runners", filters={"group_id": f"eq.{group_id}"}),
        "marathons": db.select("marathons", filters={"group_id": f"eq.{group_id}"}),
        "registrations": db.select("registrations", filters={"group_id": f"eq.{group_id}"}),
        "personal_records": db.select("personal_records", filters={"group_id": f"eq.{group_id}"}),
        "runner_badges": db.select("runner_badges", filters={"group_id": f"eq.{group_id}"}),
        "community_posts": db.select("community_posts", filters={"group_id": f"eq.{group_id}"}),
    }
    plan = plan_backfill(data)
    written = {"prs": 0, "badges": 0, "join_dates": 0, "results": 0}
    for payload in plan["pr_records"]:
        payload["group_id"] = payload.get("group_id") or group_id
        db.insert("personal_records", payload, upsert=True)
        written["prs"] += 1
    for event in pr_service.detect_prs(data["marathons"], data["registrations"], data["personal_records"])[0]:
        if event.registration.get("id"):
            db.update("registrations", {"id": f"eq.{event.registration['id']}"}, {"is_pr": True})
        if announce:
            community_service.announce_pr(db, event, data["runners"])
    for badge in plan["badges"]:
        badge["group_id"] = badge.get("group_id") or group_id
        db.insert("runner_badges", badge, upsert=True)
        written["badges"] += 1
        if announce:
            community_service.announce_badge(db, group_id, badge["runner_id"], badge["badge_key"], data["runners"])
    for update in plan["join_dates"]:
        db.update("runners", {"id": f"eq.{update['id']}"}, {"join_date": update["join_date"]})
        written["join_dates"] += 1
    written["results"] = result_service.backfill_results_table(db, group_id)
    return {"plan": {k: plan[k] for k in ("pr_events", "logged_results") if k in plan}, "written": written, "join_dates": plan["join_dates"], "badges": plan["badges"]}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", help="JSON snapshot; always dry-run")
    parser.add_argument("--group-id", help="Supabase group UUID")
    parser.add_argument("--apply", action="store_true", help="write backfill to Supabase")
    parser.add_argument("--dry-run", action="store_true", help="print the plan only")
    parser.add_argument("--announce", action="store_true", help="also create community posts")
    args = parser.parse_args()
    if args.input:
        plan = plan_backfill(load_snapshot(args.input))
        print(json.dumps({"mode": "snapshot", **_public(plan)}, indent=2, default=str))
        return 0
    if not args.group_id:
        parser.error("--group-id is required without --input")
    if args.apply and not args.dry_run:
        result = apply_backfill(args.group_id, announce=args.announce)
        print(json.dumps(result, indent=2, default=str))
        return 0
    db = service_client()
    data = {
        "runners": db.select("runners", filters={"group_id": f"eq.{args.group_id}"}),
        "marathons": db.select("marathons", filters={"group_id": f"eq.{args.group_id}"}),
        "registrations": db.select("registrations", filters={"group_id": f"eq.{args.group_id}"}),
        "personal_records": db.select("personal_records", filters={"group_id": f"eq.{args.group_id}"}),
        "runner_badges": db.select("runner_badges", filters={"group_id": f"eq.{args.group_id}"}),
        "community_posts": [],
    }
    plan = plan_backfill(data)
    print(json.dumps({"mode": "dry-run", **_public(plan)}, indent=2, default=str))
    return 0


def _public(plan: dict[str, Any]) -> dict[str, Any]:
    return {
        "pr_events": plan["pr_events"],
        "badge_awards": len(plan["badges"]),
        "join_date_updates": len(plan["join_dates"]),
        "logged_results": plan["logged_results"],
        "badges": plan["badges"],
        "join_dates": plan["join_dates"],
    }


if __name__ == "__main__":
    raise SystemExit(main())
