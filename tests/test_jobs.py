import json
import tempfile
import unittest
from pathlib import Path

from app.jobs.backfill import load_snapshot, plan_backfill
from app.jobs.validate import validate


class JobTests(unittest.TestCase):
    def test_snapshot_backfill_plan(self):
        snapshot = {
            "runners": [{"id": "r1", "name": "Ava", "group_id": "g1"}],
            "marathons": [{"id": "m1", "name": "City 10K", "distance": "10K", "race_date": "2025-01-10", "group_id": "g1"}],
            "registrations": [
                {"id": "x1", "runner_id": "r1", "marathon_id": "m1", "group_id": "g1", "status": "completed", "chip_time": "0:48:00"}
            ],
            "personal_records": [],
            "runner_badges": [],
        }
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as handle:
            json.dump(snapshot, handle)
            path = handle.name
        data = load_snapshot(path)
        Path(path).unlink(missing_ok=True)
        plan = plan_backfill(data)
        self.assertEqual(plan["pr_events"], 1)
        self.assertGreaterEqual(len(plan["badges"]), 1)
        self.assertEqual(plan["join_dates"][0]["join_date"], "2025-01-10")
        problems = validate(data)
        self.assertTrue(any("personal records" in item for item in problems))
