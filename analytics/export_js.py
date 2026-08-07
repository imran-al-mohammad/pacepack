"""
Export the Python analytics engine to insights.js for the browser.

Usage (from repo root):

    python analytics/export_js.py

This overwrites ../insights.js with a self-contained browser module.
"""

from __future__ import annotations

from pathlib import Path


JS_TEMPLATE = r"""/**
 * PacePack analytics — generated from analytics/insights.py
 * Do not hand-edit formulas here; change the Python source and re-run:
 *   python analytics/export_js.py
 */
(function (global) {
  "use strict";

  function parseTimeToSeconds(value) {
    if (value == null) return null;
    const raw = String(value).trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) return parseInt(raw, 10);
    const parts = raw.split(":");
    const nums = parts.map((p) => parseInt(p, 10));
    if (nums.some((n) => Number.isNaN(n))) return null;
    if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2];
    if (nums.length === 2) return nums[0] * 60 + nums[1];
    return null;
  }

  function formatSeconds(total) {
    if (total == null || Number.isNaN(total) || total < 0) return "—";
    const s = Math.round(total);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return h + ":" + String(m).padStart(2, "0") + ":" + String(sec).padStart(2, "0");
    return m + ":" + String(sec).padStart(2, "0");
  }

  function bestFinishSeconds(reg) {
    const chip = parseTimeToSeconds(reg && reg.chip_time);
    if (chip != null) return chip;
    return parseTimeToSeconds(reg && reg.gun_time);
  }

  function hasFinish(reg) {
    const status = String((reg && reg.status) || "").toLowerCase();
    return status === "completed" || bestFinishSeconds(reg) != null;
  }

  function mean(arr) {
    if (!arr.length) return null;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  function median(arr) {
    if (!arr.length) return null;
    const s = arr.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  /**
   * @param {{ runners?: object[], marathons?: object[], registrations?: object[] }} data
   */
  function analyze(data) {
    const runners = (data && data.runners) || [];
    const marathons = (data && data.marathons) || [];
    const registrations = (data && data.registrations) || [];

    const runnerById = {};
    runners.forEach((r) => {
      if (r && r.id) runnerById[r.id] = r;
    });
    const marathonById = {};
    marathons.forEach((m) => {
      if (m && m.id) marathonById[m.id] = m;
    });

    const totalRunners = runners.length;
    const totalMarathons = marathons.length;
    const totalRegs = registrations.length;

    const runnersWithEntry = {};
    registrations.forEach((r) => {
      if (r && r.runner_id) runnersWithEntry[r.runner_id] = true;
    });
    const activeRunners = Object.keys(runnersWithEntry).length;
    const participation = totalRunners ? (activeRunners / totalRunners) * 100 : null;
    const avgSignups = totalMarathons ? totalRegs / totalMarathons : null;

    const finishes = registrations.filter(hasFinish);
    const timed = finishes.map(bestFinishSeconds).filter((t) => t != null);
    const prs = registrations.filter((r) => r && r.is_pr).length;
    const prRate = finishes.length ? (prs / finishes.length) * 100 : null;

    const byRace = {};
    registrations.forEach((r) => {
      if (!r || !r.marathon_id) return;
      byRace[r.marathon_id] = (byRace[r.marathon_id] || 0) + 1;
    });
    let busiestId = null;
    let busiestCount = 0;
    Object.keys(byRace).forEach((id) => {
      if (byRace[id] > busiestCount) {
        busiestCount = byRace[id];
        busiestId = id;
      }
    });
    const busiest = busiestId ? marathonById[busiestId] : null;
    const emptyRaces = marathons.filter((m) => m && !byRace[m.id]);

    const byRunner = {};
    registrations.forEach((r) => {
      if (!r || !r.runner_id) return;
      if (!byRunner[r.runner_id]) {
        byRunner[r.runner_id] = { entries: 0, finishes: 0, prs: 0, times: [] };
      }
      const cur = byRunner[r.runner_id];
      cur.entries += 1;
      if (hasFinish(r)) cur.finishes += 1;
      if (r.is_pr) cur.prs += 1;
      const t = bestFinishSeconds(r);
      if (t != null) cur.times.push(t);
    });

    let mostActiveId = null;
    Object.keys(byRunner).forEach((rid) => {
      if (!mostActiveId) {
        mostActiveId = rid;
        return;
      }
      const a = byRunner[rid];
      const b = byRunner[mostActiveId];
      if (
        a.entries > b.entries ||
        (a.entries === b.entries && a.finishes > b.finishes) ||
        (a.entries === b.entries && a.finishes === b.finishes && a.prs > b.prs)
      ) {
        mostActiveId = rid;
      }
    });
    const mostActive = mostActiveId ? runnerById[mostActiveId] : null;

    const distanceCounts = {};
    marathons.forEach((m) => {
      const d = (m && m.distance) || "Other";
      distanceCounts[d] = (distanceCounts[d] || 0) + 1;
    });
    let topDistance = null;
    let topDistanceCount = 0;
    Object.keys(distanceCounts).forEach((d) => {
      if (distanceCounts[d] > topDistanceCount) {
        topDistanceCount = distanceCounts[d];
        topDistance = d;
      }
    });

    const statusCounts = {};
    registrations.forEach((r) => {
      const s = (r && r.status) || "unknown";
      statusCounts[s] = (statusCounts[s] || 0) + 1;
    });

    const inactive = runners.filter((r) => r && r.id && !runnersWithEntry[r.id]);

    const med = median(timed);
    const avg = mean(timed);

    const metrics = {
      total_runners: totalRunners,
      active_runners: activeRunners,
      inactive_runners: inactive.length,
      participation_rate_pct: participation != null ? Math.round(participation * 10) / 10 : null,
      total_marathons: totalMarathons,
      total_registrations: totalRegs,
      avg_signups_per_race: avgSignups != null ? Math.round(avgSignups * 10) / 10 : null,
      results_with_time: timed.length,
      total_prs: prs,
      pr_rate_pct: prRate != null ? Math.round(prRate * 10) / 10 : null,
      median_finish_seconds: med != null ? Math.round(med) : null,
      avg_finish_seconds: avg != null ? Math.round(avg) : null,
      median_finish_display: med != null ? formatSeconds(med) : null,
      avg_finish_display: avg != null ? formatSeconds(avg) : null,
      busiest_race_name: busiest ? busiest.name : null,
      busiest_race_count: busiestId ? byRace[busiestId] || 0 : 0,
      most_active_runner: mostActive ? mostActive.name : null,
      most_active_entries: mostActiveId ? byRunner[mostActiveId].entries : 0,
      top_distance: topDistance,
      empty_race_count: emptyRaces.length,
      status_counts: statusCounts,
      distance_counts: distanceCounts,
    };

    const insights = [];

    if (totalRunners === 0) {
      insights.push("No runners on the roster yet — add members or runners to start tracking.");
    } else if (participation != null) {
      if (participation >= 75) {
        insights.push(
          "Strong engagement: " +
            Math.round(participation) +
            "% of runners have at least one race entry."
        );
      } else if (participation >= 40) {
        insights.push(
          "Moderate engagement: " +
            Math.round(participation) +
            "% of runners are signed up for races — " +
            inactive.length +
            " still have no entries."
        );
      } else {
        insights.push(
          "Low participation: only " +
            Math.round(participation) +
            "% of runners have entries. Consider registering inactive athletes for upcoming races."
        );
      }
    }

    if (busiest && metrics.busiest_race_count) {
      insights.push(
        "Busiest race is “" +
          busiest.name +
          "” with " +
          metrics.busiest_race_count +
          " signup" +
          (metrics.busiest_race_count === 1 ? "" : "s") +
          "."
      );
    }

    if (emptyRaces.length) {
      const names = emptyRaces
        .slice(0, 3)
        .map((m) => "“" + (m.name || "Race") + "”")
        .join(", ");
      const extra = emptyRaces.length > 3 ? " (+" + (emptyRaces.length - 3) + " more)" : "";
      insights.push(emptyRaces.length + " race(s) still have zero signups: " + names + extra + ".");
    }

    if (mostActive && metrics.most_active_entries) {
      insights.push(
        "Most active runner is " +
          mostActive.name +
          " (" +
          metrics.most_active_entries +
          " registration" +
          (metrics.most_active_entries === 1 ? "" : "s") +
          ")."
      );
    }

    if (prRate != null && finishes.length) {
      if (prRate >= 25) {
        insights.push(
          "High PR rate (" + Math.round(prRate) + "% of finishes) — the group is improving quickly."
        );
      } else if (prs) {
        insights.push(
          prs +
            " personal record" +
            (prs === 1 ? "" : "s") +
            " logged (" +
            Math.round(prRate) +
            "% of finishes)."
        );
      } else {
        insights.push("No PRs flagged yet — mark breakthrough performances after race day.");
      }
    }

    if (timed.length) {
      insights.push(
        "Among " +
          timed.length +
          " timed result" +
          (timed.length === 1 ? "" : "s") +
          ", group median finish is " +
          metrics.median_finish_display +
          " (average " +
          metrics.avg_finish_display +
          ")."
      );
    }

    if (topDistance && distanceCounts[topDistance] > 1) {
      insights.push(
        "Most common distance is " +
          topDistance +
          " (" +
          distanceCounts[topDistance] +
          " of " +
          totalMarathons +
          " races)."
      );
    }

    const interested = statusCounts.interested || 0;
    const waitlisted = statusCounts.waitlisted || 0;
    if (interested) {
      insights.push(
        interested +
          " “interested” entr" +
          (interested === 1 ? "y" : "ies") +
          " — follow up to convert them to registered."
      );
    }
    if (waitlisted) {
      insights.push(waitlisted + " waitlisted entry(ies) may need capacity planning.");
    }

    if (avgSignups != null && totalMarathons >= 2) {
      if (avgSignups < 2) {
        insights.push(
          "Average of " +
            avgSignups.toFixed(1) +
            " signups per race is light — group challenges or shared training plans can lift turnout."
        );
      } else if (avgSignups >= 5) {
        insights.push(
          "Healthy turnout: about " + avgSignups.toFixed(1) + " signups per race on average."
        );
      }
    }

    let improvers = 0;
    Object.keys(byRunner).forEach((rid) => {
      const times = byRunner[rid].times;
      if (times.length >= 2 && times[times.length - 1] < times[0]) improvers += 1;
    });
    if (improvers) {
      insights.push(
        improvers +
          " runner" +
          (improvers === 1 ? "" : "s") +
          " improved their latest timed result versus their earliest logged time."
      );
    }

    return { metrics: metrics, insights: insights.slice(0, 10) };
  }

  global.PacePackAnalytics = {
    analyze: analyze,
    parseTimeToSeconds: parseTimeToSeconds,
    formatSeconds: formatSeconds,
    version: "1.0.0",
    source: "analytics/insights.py",
  };
})(typeof window !== "undefined" ? window : globalThis);
"""


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    out = root / "insights.js"
    out.write_text(JS_TEMPLATE.lstrip("\n"), encoding="utf-8")
    print(f"Wrote {out}")


if __name__ == "__main__":
    main()
