/**
 * Leaderboard feature.
 * The feature receives app selectors/render helpers so it stays independent
 * from the Supabase/data-loading implementation in app.js.
 */
export function createLeaderboardFeature({
  getState,
  getRunner,
  getMarathon,
  getDistanceKm,
  bestFinishSeconds,
  displayFinishTime,
  formatSeconds,
  renderProfileAvatar,
  escapeHtml,
}) {
  function computeLeaderboard() {
    const byRunner = new Map();
    for (const registration of getState().registrations) {
      const finished = registration.status === "completed" || !!displayFinishTime(registration);
      const current = byRunner.get(registration.runner_id) || {
        runnerId: registration.runner_id,
        entries: 0,
        finishes: 0,
        prs: 0,
        times: [],
        score: 0,
      };
      current.entries += 1;
      if (finished) current.finishes += 1;
      if (registration.is_pr) current.prs += 1;
      const seconds = bestFinishSeconds(registration);
      if (seconds != null) current.times.push(seconds);
      current.score = current.finishes + current.prs * 2;
      byRunner.set(registration.runner_id, current);
    }

    return [...byRunner.values()]
      .map((row) => ({
        ...row,
        runner: getRunner(row.runnerId),
        name: getRunner(row.runnerId)?.name || "Unknown",
        bestTime: row.times.length ? Math.min(...row.times) : null,
        averageTime: row.times.length
          ? Math.round(row.times.reduce((sum, time) => sum + time, 0) / row.times.length)
          : null,
      }))
      .filter((row) => row.entries > 0)
      .sort((a, b) => b.score - a.score || b.finishes - a.finishes || b.entries - a.entries || a.name.localeCompare(b.name));
  }

  function computeFastestLeaderboard() {
    const byRunner = new Map();
    for (const registration of getState().registrations) {
      const marathon = getMarathon(registration.marathon_id);
      const seconds = bestFinishSeconds(registration);
      const km = getDistanceKm(registration.race_distance || marathon?.distance);
      if (seconds == null || !km) continue;
      const pace = seconds / km;
      const current = byRunner.get(registration.runner_id) || {
        runnerId: registration.runner_id,
        bestPace: null,
        races: 0,
      };
      current.bestPace = current.bestPace == null ? pace : Math.min(current.bestPace, pace);
      current.races += 1;
      byRunner.set(registration.runner_id, current);
    }
    return [...byRunner.values()]
      .map((entry) => ({ ...entry, runner: getRunner(entry.runnerId), name: getRunner(entry.runnerId)?.name || "Unknown" }))
      .sort((a, b) => a.bestPace - b.bestPace || a.name.localeCompare(b.name));
  }

  function renderFullLeaderboards() {
    const fastestEl = document.getElementById("full-fastest-list");
    const activityEl = document.getElementById("full-activity-list");
    if (!fastestEl || !activityEl) return;

    const fastest = computeFastestLeaderboard();
    fastestEl.innerHTML = fastest.length
      ? fastest.map((entry, index) => `<div class="fastest-runner-item"><span class="fastest-runner-rank">${index + 1}</span><span class="fastest-runner-name">${escapeHtml(entry.name)}</span><span class="fastest-runner-pace time-mono">${escapeHtml(formatSeconds(entry.bestPace))}/km</span><span class="fastest-runner-races">${entry.races} race${entry.races === 1 ? "" : "s"}</span></div>`).join("")
      : `<div class="empty"><strong>No pace results yet</strong>Log finish times to rank runners.</div>`;

    const activity = computeLeaderboard();
    activityEl.innerHTML = activity.length
      ? `<ol class="leaderboard-ranks">${activity.map((entry, index) => `<li class="leaderboard-rank-item lb-rank-${index + 1}"><span class="lb-rank"><small>Rank</small>#${index + 1}</span><span class="lb-avatar">${renderProfileAvatar(entry.runner, entry.name, entry.runnerId)}</span><span class="lb-name" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</span><span class="lb-meta">${entry.finishes} finish${entry.finishes === 1 ? "" : "es"} · ${entry.entries} entr${entry.entries === 1 ? "y" : "ies"}</span><span class="lb-score">${entry.score}</span></li>`).join("")}</ol>`
      : `<div class="empty"><strong>No contributors yet</strong>Log results to build the leaderboard.</div>`;
  }

  return { computeLeaderboard, computeFastestLeaderboard, renderFullLeaderboards };
}
