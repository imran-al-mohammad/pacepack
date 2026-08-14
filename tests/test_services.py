import unittest

from app.services import badge_service, join_date_service, pr_service, result_service
from app.services.analytics_service import activity_leaderboard, club_report
from app.services.certificate_service import _has_logged_result
from app.services.result_service import ResultError
from app.services.time_utils import format_time, parse_time


RACES = [
    {"id": "m1", "name": "City 10K", "distance": "10K", "race_date": "2025-01-10", "group_id": "g1", "location": "Dhaka"},
    {"id": "m2", "name": "Spring Half", "distance": "Half Marathon", "race_date": "2025-03-02", "group_id": "g1", "location": "Dhaka"},
    {"id": "m3", "name": "National Marathon", "distance": "Marathon", "race_date": "2025-06-01", "group_id": "g1", "location": "Dhaka"},
]
RUNNERS = [
    {"id": "r1", "name": "Ava", "group_id": "g1", "join_date": None},
    {"id": "r2", "name": "Ben", "group_id": "g1", "join_date": "2024-01-01"},
]


class TimeUtilsTests(unittest.TestCase):
    def test_parse_and_format(self):
        self.assertEqual(parse_time("1:48:32"), 6512)
        self.assertEqual(format_time(6512), "1:48:32")
        self.assertEqual(parse_time("22:18"), 1338)


class PRServiceTests(unittest.TestCase):
    def test_first_finish_is_pr_and_slower_is_not(self):
        regs = [
            {"id": "x1", "runner_id": "r1", "marathon_id": "m1", "group_id": "g1", "status": "completed", "chip_time": "0:50:00"},
            {"id": "x2", "runner_id": "r1", "marathon_id": "m1", "group_id": "g1", "status": "completed", "chip_time": "0:52:00"},
        ]
        events, best = pr_service.detect_prs(RACES[:1], regs)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].time_seconds, 3000)
        self.assertEqual(best[("r1", "10K")]["time_seconds"], 3000)

    def test_faster_later_finish_is_new_pr(self):
        regs = [
            {"id": "x1", "runner_id": "r1", "marathon_id": "m1", "group_id": "g1", "status": "completed", "chip_time": "0:50:00"},
            {"id": "x2", "runner_id": "r1", "marathon_id": "m1", "group_id": "g1", "status": "completed", "chip_time": "0:48:00"},
        ]
        # Same race id would not happen in production; use two races with same distance via race_distance.
        regs[1]["id"] = "x2"
        regs[1]["marathon_id"] = "m2"
        regs[1]["race_distance"] = "10K"
        events, best = pr_service.detect_prs(RACES, regs)
        self.assertEqual(len(events), 2)
        self.assertEqual(best[("r1", "10K")]["time_seconds"], 2880)
        self.assertEqual(events[1].previous_best, 3000)

    def test_no_manual_record_without_result(self):
        events, best = pr_service.detect_prs(RACES, [])
        self.assertEqual(events, [])
        self.assertEqual(best, {})


class BadgeServiceTests(unittest.TestCase):
    def test_badges_from_historical_results(self):
        regs = [
            {"id": "x1", "runner_id": "r1", "marathon_id": "m1", "status": "completed", "chip_time": "0:48:00", "is_pr": True},
            {"id": "x2", "runner_id": "r1", "marathon_id": "m2", "status": "completed", "chip_time": "1:45:00"},
            {"id": "x3", "runner_id": "r1", "marathon_id": "m3", "status": "completed", "chip_time": "3:50:00"},
        ]
        eligible = badge_service.eligible_badges("r1", RACES, regs)
        self.assertIn("first_race", eligible)
        self.assertIn("first_10k", eligible)
        self.assertIn("first_half_marathon", eligible)
        self.assertIn("first_marathon", eligible)
        self.assertIn("sub_4_marathon", eligible)
        self.assertIn("new_personal_record", eligible)

    def test_backfill_is_idempotent(self):
        regs = [{"id": "x1", "runner_id": "r1", "marathon_id": "m1", "status": "completed", "chip_time": "0:48:00"}]
        existing = [{"runner_id": "r1", "badge_key": "first_race"}, {"runner_id": "r1", "badge_key": "first_10k"}]
        first = badge_service.new_badges_for_runner("r1", RACES, regs, [])
        second = badge_service.new_badges_for_runner("r1", RACES, regs, existing + [{"runner_id": "r1", "badge_key": key} for key in first])
        self.assertEqual(second, [])


class JoinDateTests(unittest.TestCase):
    def test_join_date_is_first_race(self):
        regs = [
            {"runner_id": "r1", "marathon_id": "m2"},
            {"runner_id": "r1", "marathon_id": "m1"},
        ]
        self.assertEqual(join_date_service.first_race_date("r1", regs, RACES), "2025-01-10")

    def test_join_date_updates_are_idempotent(self):
        runners = [{"id": "r1", "join_date": "2025-01-10"}]
        regs = [{"runner_id": "r1", "marathon_id": "m1"}]
        self.assertEqual(join_date_service.join_date_updates(runners, regs, RACES), [])


class ResultServiceTests(unittest.TestCase):
    def test_completed_requires_a_time(self):
        with self.assertRaises(ResultError):
            result_service.validate_result_payload({"status": "completed"})

    def test_valid_result(self):
        payload = result_service.validate_result_payload({"status": "completed", "chip_time": "1:48:32"})
        self.assertEqual(payload["chip_time"], "1:48:32")


class CertificateRuleTests(unittest.TestCase):
    def test_upload_requires_logged_result(self):
        regs = [{"runner_id": "r1", "marathon_id": "m1", "status": "registered"}]
        self.assertIsNone(_has_logged_result(regs, "r1", "m1"))
        regs[0]["chip_time"] = "0:48:00"
        self.assertIsNotNone(_has_logged_result(regs, "r1", "m1"))


class AnalyticsTests(unittest.TestCase):
    def test_club_report_and_leaderboard(self):
        regs = [
            {"runner_id": "r1", "marathon_id": "m1", "status": "completed", "chip_time": "0:48:00", "is_pr": True},
            {"runner_id": "r2", "marathon_id": "m1", "status": "registered"},
        ]
        report = club_report(RUNNERS, RACES, regs)
        self.assertEqual(report["metrics"]["total_prs"], 1)
        board = activity_leaderboard(RUNNERS, regs)
        self.assertEqual(board[0]["name"], "Ava")
        self.assertEqual(board[0]["score"], 3)


if __name__ == "__main__":
    unittest.main()
