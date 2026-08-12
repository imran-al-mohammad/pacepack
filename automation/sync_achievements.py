"""Synchronize PRs, badges, notifications, and community posts.

Examples:
    python automation/sync_achievements.py --input snapshot.json --dry-run
    SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... python automation/sync_achievements.py --group-id UUID

The Supabase mode uses the REST API directly, so no Python dependency is
needed. Use a service-role key only in a protected scheduled environment.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from statistics import median
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from achievement_engine import BADGE_RULES, DISTANCE_KM, detect_prs, eligible_badges, finish_seconds, format_time, is_finish


TABLES = ("runners", "marathons", "registrations", "personal_records", "runner_badges", "group_memberships", "community_posts", "notifications")


class RestClient:
    def __init__(self, url: str, key: str):
        self.base = url.rstrip("/") + "/rest/v1/"
        self.key = key

    def request(self, table: str, method: str = "GET", query: dict[str, str] | None = None, payload: Any = None, prefer: str = "") -> Any:
        url = self.base + table
        if query:
            url += "?" + urllib.parse.urlencode(query)
        body = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(url, data=body, method=method, headers={
            "apikey": self.key, "Authorization": f"Bearer {self.key}", "Content-Type": "application/json",
            "Prefer": prefer or "return=representation",
        })
        with urllib.request.urlopen(req, timeout=30) as response:
            raw = response.read()
            return json.loads(raw) if raw else []

    def select(self, table: str, group_id: str) -> list[dict[str, Any]]:
        return self.request(table, query={"group_id": f"eq.{group_id}", "select": "*"})


def load_snapshot(path: str) -> dict[str, list[dict[str, Any]]]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return {table: data.get(table, []) for table in TABLES}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", help="JSON snapshot; skips Supabase and is always dry-run")
    parser.add_argument("--group-id", help="Supabase group UUID")
    parser.add_argument("--dry-run", action="store_true", help="print mutations without writing")
    args = parser.parse_args()
    if args.input:
        data = load_snapshot(args.input)
        writer = None
    else:
        if not args.group_id:
            parser.error("--group-id is required without --input")
        url, key = os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_SERVICE_ROLE_KEY")
        if not url or not key:
            parser.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")
        writer = RestClient(url, key)
        data = {table: writer.select(table, args.group_id) for table in TABLES}

    races = {r.get("id"): r for r in data["marathons"]}
    runners = {r.get("id"): r for r in data["runners"]}
    events, best_records = detect_prs(data["runners"], data["marathons"], data["registrations"], data["personal_records"])
    existing_badges = {(b.get("runner_id"), b.get("badge_key")) for b in data["runner_badges"]}
    posts = {p.get("content") for p in data["community_posts"]}
    memberships = {}
    for member in data["group_memberships"]:
        memberships.setdefault(member.get("group_id"), set()).add(member.get("user_id"))
    notification_keys = {
        (n.get("type"), (n.get("data") or {}).get("registration_id"), (n.get("data") or {}).get("badge_key"), n.get("user_id"))
        for n in data["notifications"]
    }

    mutations: list[tuple[str, str, dict[str, Any]]] = []
    group_id = args.group_id or next((r.get("group_id") for r in data["runners"] if r.get("group_id")), None)
    actor_id = next(iter(memberships.get(group_id, set())), None)
    if not group_id or not actor_id:
        print("No group/member context found; snapshot analysis only.", file=sys.stderr)

    for event in events:
        reg, runner = event.registration, runners.get(event.registration.get("runner_id"), {})
        race = races.get(reg.get("marathon_id"), {})
        runner_name, race_name = runner.get("name", "Runner"), race.get("name", "Race")
        record = {"group_id": group_id or reg.get("group_id"), "runner_id": runner.get("id"), "distance": event.distance,
                  "time_seconds": event.time_seconds, "pace_seconds_per_km": round(event.time_seconds / DISTANCE_KM.get(event.distance.lower(), 1), 3),
                  "race_date": race.get("race_date"), "race_name": race_name, "location": race.get("location", ""), "is_new_pr": True}
        mutations.append(("personal_records", "upsert", record))
        if reg.get("id"):
            mutations.append(("registrations", "mark_pr", {"id": reg["id"], "is_pr": True}))
        content = f"{runner_name} set a new {event.distance} PR: {format_time(event.time_seconds)}! What’s your next goal?"
        if content not in posts:
            mutations.append(("community_posts", "insert", {"group_id": group_id or reg.get("group_id"), "user_id": actor_id, "runner_id": runner.get("id"), "title": "New personal record", "content": content}))
        for user_id in {runner.get("user_id"), *memberships.get(group_id, set())} - {None}:
            key = ("pr_detected", reg.get("id"), None, user_id)
            if key not in notification_keys:
                mutations.append(("notifications", "insert", {"user_id": user_id, "group_id": group_id or reg.get("group_id"), "type": "pr_detected", "title": "New personal record!", "body": f"{event.distance} PR: {format_time(event.time_seconds)}. Keep going!", "data": {"registration_id": reg.get("id"), "runner_id": runner.get("id")}}))
                notification_keys.add(key)

    for runner_id, runner in runners.items():
        eligible = eligible_badges(runner_id, races, data["registrations"])
        for badge_key in sorted(eligible - {key for rid, key in existing_badges if rid == runner_id}):
            badge = {"group_id": group_id or runner.get("group_id"), "runner_id": runner_id, "badge_key": badge_key}
            mutations.append(("runner_badges", "insert", badge))
            label = BADGE_RULES[badge_key]
            content = f"{runner.get('name', 'Runner')} unlocked the {label} badge! Celebrate the milestone and keep moving."
            if content not in posts:
                mutations.append(("community_posts", "insert", {"group_id": group_id or runner.get("group_id"), "user_id": actor_id, "runner_id": runner_id, "title": "Badge unlocked", "content": content}))
            for user_id in {runner.get("user_id"), *memberships.get(group_id, set())} - {None}:
                key = ("badge_earned", None, badge_key, user_id)
                if key not in notification_keys:
                    mutations.append(("notifications", "insert", {"user_id": user_id, "group_id": group_id or runner.get("group_id"), "type": "badge_earned", "title": "Badge unlocked!", "body": f"You earned: {label}.", "data": {"runner_id": runner_id, "badge_key": badge_key}}))
                    notification_keys.add(key)

    # One compact discussion prompt per race with newly available finishes.
    announced_races = {p for p in posts if p and p.startswith("New results have been logged for ")}
    for race_id, race in races.items():
        race_results = [r for r in data["registrations"] if r.get("marathon_id") == race_id and is_finish(r)]
        if not race_results:
            continue
        times = sorted(filter(None, (finish_seconds(r) for r in race_results)))
        median_text = f" Median finish: {format_time(int(median(times)))}." if times else ""
        content = f"New results have been logged for {race.get('name', 'this race')}: {len(race_results)} finish{'er' if len(race_results) == 1 else 'ers'} recorded.{median_text} Share your favorite moment!"
        if content not in posts and content not in announced_races:
            mutations.append(("community_posts", "insert", {"group_id": group_id or race.get("group_id"), "user_id": actor_id, "title": "Race results", "content": content}))

    print(json.dumps({"events": len(events), "mutations": len(mutations), "actions": mutations}, indent=2, default=str))
    if writer and not args.dry_run:
        for table, action, payload in mutations:
            if action == "upsert":
                writer.request(table, "POST", payload=payload, prefer="resolution=merge-duplicates,return=minimal")
            elif action == "mark_pr":
                writer.request(table, "PATCH", query={"id": f"eq.{payload['id']}"}, payload={"is_pr": True}, prefer="return=minimal")
            elif action == "insert":
                writer.request(table, "POST", payload=payload, prefer="return=minimal")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
