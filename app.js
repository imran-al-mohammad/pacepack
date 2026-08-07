/**
 * PacePack — full online multi-user app
 * Roles: admin · moderator · member
 */

const STATUSES = [
  { value: "interested", label: "Interested" },
  { value: "registered", label: "Registered" },
  { value: "waitlisted", label: "Waitlisted" },
  { value: "completed", label: "Completed" },
  { value: "dns", label: "DNS" },
  { value: "dnf", label: "DNF" },
];

const DISTANCES = ["5K", "7.5K", "10K", "15K", "Half Marathon", "Marathon", "Ultra", "Other"];

const DISTANCE_KM = {
  "5K": 5,
  "7.5K": 7.5,
  "10K": 10,
  "15K": 15,
  "Half Marathon": 21.0975,
  Marathon: 42.195,
  Ultra: null,
  Other: null,
};

const AVATAR_COLORS = [
  "#ff6b4a", "#2dd4bf", "#60a5fa", "#fbbf24",
  "#c084fc", "#4ade80", "#f472b6", "#38bdf8",
];

const VIEW_META = {
  dashboard: { title: "Dashboard", desc: "Live overview of races and results" },
  marathons: { title: "Marathons", desc: "Races the group is tracking" },
  members: { title: "Runners", desc: "People in the running roster" },
  registrations: { title: "Registrations", desc: "Who signed up for which race" },
  results: { title: "Results & times", desc: "Finish times, pace, places, and PRs" },
  team: { title: "Team & access", desc: "Invite codes, roles, and permissions" },
};

const ROLE_RANK = { member: 1, moderator: 2, admin: 3 };

// ─── App state ───────────────────────────────────────────────────────────────

let sb = null;
let session = null;
let profile = null;
let group = null;
let myRole = null;
let team = []; // { membership, profile }

let state = {
  marathons: [],
  runners: [],
  registrations: [],
};

let currentView = "dashboard";
let channels = [];
let suppressToast = false;

// ─── Config / client ─────────────────────────────────────────────────────────

function getConfig() {
  const c = window.PACEPACK_CONFIG || {};
  return {
    url: (c.supabaseUrl || "").trim().replace(/\/$/, ""),
    key: (c.supabaseAnonKey || "").trim(),
  };
}

function isConfigured() {
  const { url, key } = getConfig();
  return !!(url && key && window.supabase?.createClient);
}

function createClient() {
  const { url, key } = getConfig();
  return window.supabase.createClient(url, key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
}

// ─── Permissions ─────────────────────────────────────────────────────────────

function hasMinRole(min) {
  return (ROLE_RANK[myRole] || 0) >= (ROLE_RANK[min] || 99);
}

function canDelete() {
  return hasMinRole("moderator");
}

function canManageRoles() {
  return hasMinRole("admin");
}

function canWrite() {
  return hasMinRole("member");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(String(iso).slice(0, 10) + "T12:00:00");
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function isPast(iso) {
  return String(iso).slice(0, 10) < todayISO();
}

function daysUntil(iso) {
  const a = new Date(todayISO() + "T12:00:00");
  const b = new Date(String(iso).slice(0, 10) + "T12:00:00");
  return Math.round((b - a) / 86400000);
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function initials(name) {
  return (name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join("") || "?";
}

function avatarColor(id) {
  const s = String(id || "");
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash + s.charCodeAt(i) * 17) % AVATAR_COLORS.length;
  return AVATAR_COLORS[hash];
}

function parseTimeToSeconds(input) {
  if (!input || !String(input).trim()) return null;
  const raw = String(input).trim().toLowerCase();
  const hms = raw.match(/^(\d+)\s*h(?:ours?)?\s*(\d+)\s*m(?:in(?:utes?)?)?\s*(\d+)\s*s(?:ec(?:onds?)?)?$/);
  if (hms) return (+hms[1]) * 3600 + (+hms[2]) * 60 + (+hms[3]);
  const colon = raw.match(/^(\d+):([0-5]?\d)(?::([0-5]?\d))?$/);
  if (colon) {
    if (colon[3] !== undefined) return (+colon[1]) * 3600 + (+colon[2]) * 60 + (+colon[3]);
    return (+colon[1]) * 60 + (+colon[2]);
  }
  return null;
}

function formatSeconds(total) {
  if (total == null || Number.isNaN(total) || total < 0) return "—";
  const s = Math.round(total);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function normalizeTimeInput(input) {
  const sec = parseTimeToSeconds(input);
  if (sec == null) return (input || "").trim();
  return formatSeconds(sec);
}

function bestFinishSeconds(reg) {
  const chip = parseTimeToSeconds(reg.chip_time || reg.chipTime);
  if (chip != null) return chip;
  return parseTimeToSeconds(reg.gun_time || reg.gunTime);
}

function displayFinishTime(reg) {
  return reg.chip_time || reg.gun_time || "";
}

function paceForRegistration(reg, marathon) {
  const seconds = bestFinishSeconds(reg);
  if (seconds == null || !marathon) return null;
  const km = DISTANCE_KM[marathon.distance];
  if (!km) return null;
  return {
    perKm: formatSeconds(seconds / km),
    perMi: formatSeconds(seconds / (km * 0.621371)),
    label: `${formatSeconds(seconds / km)}/km · ${formatSeconds(seconds / (km * 0.621371))}/mi`,
  };
}

function getRunner(id) {
  return state.runners.find((r) => r.id === id);
}

function getMarathon(id) {
  return state.marathons.find((m) => m.id === id);
}

function regsForMarathon(id) {
  return state.registrations.filter((r) => r.marathon_id === id);
}

function regsForRunner(id) {
  return state.registrations.filter((r) => r.runner_id === id);
}

function statusLabel(value) {
  return STATUSES.find((s) => s.value === value)?.label || value;
}

function statusBadge(status) {
  return `<span class="badge badge-${escapeHtml(status)}">${escapeHtml(statusLabel(status))}</span>`;
}

function roleBadge(role) {
  return `<span class="badge badge-role-${escapeHtml(role)}">${escapeHtml(role)}</span>`;
}

function sortMarathons(list) {
  return [...list].sort((a, b) => String(a.race_date).localeCompare(String(b.race_date)) || a.name.localeCompare(b.name));
}

function sortRunners(list) {
  return [...list].sort((a, b) => a.name.localeCompare(b.name));
}

function errMsg(err) {
  return err?.message || err?.error_description || String(err);
}

// ─── Toast / modal ───────────────────────────────────────────────────────────

function toast(message, type = "success") {
  if (suppressToast && type === "success") return;
  const host = document.getElementById("toast-host");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity 0.2s";
    setTimeout(() => el.remove(), 200);
  }, 2800);
}

function openModal({ title, bodyHtml, footerHtml, onMount, wide }) {
  document.getElementById("modal-title").textContent = title;
  document.getElementById("modal-body").innerHTML = bodyHtml;
  document.getElementById("modal-footer").innerHTML = footerHtml || "";
  document.getElementById("modal").classList.toggle("wide", !!wide);
  document.getElementById("modal-backdrop").hidden = false;
  if (onMount) onMount();
  const first = document.querySelector("#modal input, #modal select, #modal textarea");
  if (first) setTimeout(() => first.focus(), 30);
}

function closeModal() {
  document.getElementById("modal-backdrop").hidden = true;
  document.getElementById("modal-body").innerHTML = "";
  document.getElementById("modal-footer").innerHTML = "";
}

// ─── Screen routing ──────────────────────────────────────────────────────────

function showScreen(name) {
  document.getElementById("boot-screen").hidden = name !== "boot";
  document.getElementById("config-screen").hidden = name !== "config";
  document.getElementById("auth-screen").hidden = name !== "auth";
  document.getElementById("onboard-screen").hidden = name !== "onboard";
  document.getElementById("app-shell").hidden = name !== "app";
}

function setBoot(msg) {
  showScreen("boot");
  document.getElementById("boot-msg").textContent = msg || "Connecting…";
}

// ─── Data load ───────────────────────────────────────────────────────────────

async function loadProfile() {
  const { data, error } = await sb
    .from("profiles")
    .select("*")
    .eq("id", session.user.id)
    .maybeSingle();
  if (error) throw error;
  profile = data;
  if (!profile) {
    const name = session.user.user_metadata?.display_name || session.user.email?.split("@")[0] || "Runner";
    const { data: created, error: e2 } = await sb
      .from("profiles")
      .upsert({ id: session.user.id, display_name: name, email: session.user.email })
      .select()
      .single();
    if (e2) throw e2;
    profile = created;
  }
}

async function loadMembership() {
  // No nested embeds — avoids "relationship not found" when FKs/schema cache differ
  const { data: membership, error } = await sb
    .from("group_memberships")
    .select("id, role, group_id, user_id, created_at")
    .eq("user_id", session.user.id)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!membership) {
    group = null;
    myRole = null;
    return false;
  }

  const { data: g, error: gErr } = await sb
    .from("groups")
    .select("id, name, invite_code, created_at")
    .eq("id", membership.group_id)
    .maybeSingle();
  if (gErr) throw gErr;
  if (!g) {
    // Membership row exists but group missing / blocked by RLS
    group = null;
    myRole = null;
    throw new Error(
      "Group not found for your membership. Re-run supabase-schema.sql (or fix-relationships.sql) in Supabase SQL Editor."
    );
  }

  group = g;
  myRole = membership.role;
  return true;
}

async function loadGroupData() {
  if (!group) return;
  const gid = group.id;

  const [m, r, reg, mem] = await Promise.all([
    sb.from("marathons").select("*").eq("group_id", gid).order("race_date"),
    sb.from("runners").select("*").eq("group_id", gid).order("name"),
    sb.from("registrations").select("*").eq("group_id", gid),
    sb
      .from("group_memberships")
      .select("id, role, user_id, created_at")
      .eq("group_id", gid),
  ]);

  if (m.error) throw m.error;
  if (r.error) throw r.error;
  if (reg.error) throw reg.error;
  if (mem.error) throw mem.error;

  state.marathons = m.data || [];
  state.runners = r.data || [];
  state.registrations = reg.data || [];

  const memberships = mem.data || [];
  const userIds = [...new Set(memberships.map((row) => row.user_id).filter(Boolean))];

  let profileMap = {};
  if (userIds.length) {
    const { data: profiles, error: pErr } = await sb
      .from("profiles")
      .select("id, display_name, email")
      .in("id", userIds);
    if (pErr) {
      // Non-fatal: still show team without names
      console.warn("profiles load:", pErr);
    } else {
      (profiles || []).forEach((p) => {
        profileMap[p.id] = p;
      });
    }
  }

  team = memberships.map((row) => ({
    id: row.id,
    role: row.role,
    user_id: row.user_id,
    created_at: row.created_at,
    profile: profileMap[row.user_id] || {
      display_name: row.user_id === session.user.id ? (profile?.display_name || "You") : "User",
      email: row.user_id === session.user.id ? (session.user.email || "") : "",
    },
  }));
}

function unsubscribeAll() {
  channels.forEach((ch) => {
    try { sb.removeChannel(ch); } catch { /* ignore */ }
  });
  channels = [];
}

function subscribeRealtime() {
  unsubscribeAll();
  if (!group) return;
  const gid = group.id;

  const onChange = async () => {
    try {
      suppressToast = true;
      await loadGroupData();
      suppressToast = false;
      render();
    } catch (e) {
      suppressToast = false;
      console.error(e);
    }
  };

  ["marathons", "runners", "registrations", "group_memberships"].forEach((table) => {
    const ch = sb
      .channel(`pp-${table}-${gid}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table, filter: `group_id=eq.${gid}` },
        () => onChange()
      )
      .subscribe();
    channels.push(ch);
  });

  const chGroup = sb
    .channel(`pp-groups-${gid}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "groups", filter: `id=eq.${gid}` },
      async () => {
        const { data } = await sb.from("groups").select("*").eq("id", gid).single();
        if (data) {
          group = data;
          render();
        }
      }
    )
    .subscribe();
  channels.push(chGroup);
}

// ─── Auth actions ────────────────────────────────────────────────────────────

async function signIn(email, password) {
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

async function signUp(email, password, displayName) {
  const { data, error } = await sb.auth.signUp({
    email,
    password,
    options: { data: { display_name: displayName } },
  });
  if (error) throw error;
  if (data.user && !data.session) {
    throw new Error("Check your email to confirm the account, or disable email confirmation in Supabase Auth settings.");
  }
}

async function signOut() {
  unsubscribeAll();
  await sb.auth.signOut();
  session = null;
  profile = null;
  group = null;
  myRole = null;
  state = { marathons: [], runners: [], registrations: [] };
  team = [];
  showScreen("auth");
}

async function createGroup(name) {
  const { data, error } = await sb.rpc("create_group", { p_name: name });
  if (error) throw error;
  // Prefer loading via tables (verifies FKs/RLS work)
  const ok = await loadMembership();
  if (!ok) {
    if (data) {
      group = data;
      myRole = "admin";
    } else {
      throw new Error("Group was created but could not be loaded. Run fix-relationships.sql in Supabase.");
    }
  }
}

async function joinGroup(code) {
  const { data, error } = await sb.rpc("join_group", { p_code: code });
  if (error) throw error;
  const ok = await loadMembership();
  if (!ok) {
    if (data) {
      group = data;
      myRole = "member";
    } else {
      throw new Error("Joined but group could not be loaded. Run fix-relationships.sql in Supabase.");
    }
  }
}

async function enterApp() {
  setBoot("Loading group data…");
  await loadGroupData();
  subscribeRealtime();
  showScreen("app");
  document.getElementById("live-banner").hidden = false;
  document.getElementById("group-name-label").textContent = group.name;
  document.getElementById("user-display").textContent =
    profile?.display_name || session.user.email || "User";
  updateRolePill();
  setView("dashboard");
}

function updateRolePill() {
  const pill = document.getElementById("role-pill");
  const label = document.getElementById("role-label");
  pill.classList.remove("admin", "moderator", "member");
  pill.classList.add(myRole || "member");
  label.textContent = myRole || "member";
}

async function handleSession(newSession) {
  session = newSession;
  if (!session) {
    unsubscribeAll();
    showScreen("auth");
    return;
  }
  try {
    setBoot("Loading your profile…");
    await loadProfile();
    const hasGroup = await loadMembership();

    // Auto-join via ?invite=CODE
    const params = new URLSearchParams(location.search);
    const invite = (params.get("invite") || params.get("code") || "").trim();
    if (!hasGroup && invite) {
      setBoot("Joining group…");
      try {
        await joinGroup(invite);
        const url = new URL(location.href);
        url.searchParams.delete("invite");
        url.searchParams.delete("code");
        history.replaceState(null, "", url.toString());
        await enterApp();
        toast("Joined group");
        return;
      } catch (e) {
        console.error(e);
        toast(errMsg(e), "error");
        showScreen("onboard");
        document.getElementById("onboard-user-label").textContent =
          `Signed in as ${profile?.display_name || session.user.email}`;
        document.getElementById("invite-code").value = invite.toUpperCase();
        return;
      }
    }

    if (!hasGroup) {
      showScreen("onboard");
      document.getElementById("onboard-user-label").textContent =
        `Signed in as ${profile?.display_name || session.user.email}`;
      return;
    }

    await enterApp();
  } catch (e) {
    console.error(e);
    toast(errMsg(e), "error");
    showScreen("auth");
  }
}

// ─── Navigation ──────────────────────────────────────────────────────────────

function setView(view) {
  currentView = view;
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });
  document.querySelectorAll(".view").forEach((el) => {
    el.classList.toggle("active", el.id === `view-${view}`);
  });
  const meta = VIEW_META[view];
  document.getElementById("view-title").textContent = meta.title;
  document.getElementById("view-desc").textContent = meta.desc;
  renderTopbarActions();
  render();
}

function renderTopbarActions() {
  const el = document.getElementById("topbar-actions");
  if (!canWrite()) {
    el.innerHTML = "";
    return;
  }
  if (currentView === "marathons") {
    el.innerHTML = `<button class="btn btn-primary" id="btn-add-marathon">+ Add marathon</button>`;
    document.getElementById("btn-add-marathon").onclick = () => openMarathonForm();
  } else if (currentView === "members") {
    el.innerHTML = `<button class="btn btn-primary" id="btn-add-member">+ Add runner</button>`;
    document.getElementById("btn-add-member").onclick = () => openRunnerForm();
  } else if (currentView === "registrations") {
    el.innerHTML = `<button class="btn btn-primary" id="btn-add-reg">+ Add registration</button>`;
    document.getElementById("btn-add-reg").onclick = () => openRegistrationForm();
  } else if (currentView === "results") {
    el.innerHTML = `<button class="btn btn-primary" id="btn-add-result">+ Enter result</button>`;
    document.getElementById("btn-add-result").onclick = () => openRegistrationForm(null, { preferResult: true });
  } else if (currentView === "dashboard") {
    el.innerHTML = `
      <button class="btn btn-secondary" id="btn-dash-result">+ Result</button>
      <button class="btn btn-primary" id="btn-dash-marathon">+ Marathon</button>
    `;
    document.getElementById("btn-dash-result").onclick = () => openRegistrationForm(null, { preferResult: true });
    document.getElementById("btn-dash-marathon").onclick = () => openMarathonForm();
  } else {
    el.innerHTML = "";
  }
}

// ─── Render views ────────────────────────────────────────────────────────────

function render() {
  if (document.getElementById("app-shell").hidden) return;
  document.getElementById("group-name-label").textContent = group?.name || "Group";
  updateRolePill();
  if (currentView === "dashboard") renderDashboard();
  if (currentView === "marathons") renderMarathons();
  if (currentView === "members") renderRunners();
  if (currentView === "registrations") renderRegistrations();
  if (currentView === "results") renderResults();
  if (currentView === "team") renderTeam();
}

function renderDashboard() {
  const upcoming = sortMarathons(state.marathons.filter((m) => !isPast(m.race_date)));
  const past = state.marathons.filter((m) => isPast(m.race_date));
  const registered = state.registrations.filter((r) => r.status === "registered").length;
  const completed = state.registrations.filter((r) => r.status === "completed").length;
  const withTimes = state.registrations.filter((r) => displayFinishTime(r)).length;

  document.getElementById("stats-grid").innerHTML = `
    <div class="stat-card" style="--stat-color: var(--accent)">
      <p class="stat-label">Upcoming races</p>
      <p class="stat-value">${upcoming.length}</p>
      <p class="stat-hint">${past.length} past race${past.length === 1 ? "" : "s"}</p>
    </div>
    <div class="stat-card" style="--stat-color: var(--teal)">
      <p class="stat-label">Runners</p>
      <p class="stat-value">${state.runners.length}</p>
      <p class="stat-hint">${team.length} app user${team.length === 1 ? "" : "s"} with access</p>
    </div>
    <div class="stat-card" style="--stat-color: var(--blue)">
      <p class="stat-label">Registered</p>
      <p class="stat-value">${registered}</p>
      <p class="stat-hint">${state.registrations.length} total entries</p>
    </div>
    <div class="stat-card" style="--stat-color: var(--green)">
      <p class="stat-label">Results logged</p>
      <p class="stat-value">${withTimes}</p>
      <p class="stat-hint">${completed} completed</p>
    </div>
  `;

  const upcomingEl = document.getElementById("upcoming-list");
  if (!upcoming.length) {
    upcomingEl.innerHTML = `<div class="empty"><strong>No upcoming races</strong>Add a marathon to get started.</div>`;
  } else {
    upcomingEl.innerHTML = upcoming.slice(0, 6).map((m) => {
      const count = regsForMarathon(m.id).length;
      const days = daysUntil(m.race_date);
      const when = days === 0 ? "Today!" : days === 1 ? "Tomorrow" : `In ${days} days`;
      return `
        <div class="list-item">
          <div class="list-item-main">
            <p class="list-item-title">${escapeHtml(m.name)}</p>
            <p class="list-item-sub">${formatDate(m.race_date)} · ${escapeHtml(m.location || "TBD")} · ${escapeHtml(m.distance)}</p>
          </div>
          <div style="display:flex;gap:0.5rem;align-items:center">
            <span class="badge badge-count">${count} signed</span>
            <span class="badge badge-distance">${when}</span>
          </div>
        </div>`;
    }).join("");
  }

  const results = [...state.registrations]
    .filter((r) => r.status === "completed" || displayFinishTime(r))
    .sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at))
    .slice(0, 6);

  const recentEl = document.getElementById("recent-results");
  if (!results.length) {
    recentEl.innerHTML = `<div class="empty"><strong>No results yet</strong>Log finish times after race day.</div>`;
  } else {
    recentEl.innerHTML = results.map((r) => {
      const runner = getRunner(r.runner_id);
      const marathon = getMarathon(r.marathon_id);
      const time = displayFinishTime(r) || "—";
      const pace = paceForRegistration(r, marathon);
      return `
        <div class="list-item">
          <div class="list-item-main">
            <p class="list-item-title">${escapeHtml(runner?.name || "Unknown")}</p>
            <p class="list-item-sub">${escapeHtml(marathon?.name || "Race")}${pace ? " · " + pace.label : ""}</p>
          </div>
          <div style="display:flex;gap:0.45rem;align-items:center">
            ${r.is_pr ? `<span class="badge badge-pr">PR</span>` : ""}
            <span class="time-mono time-best">${escapeHtml(time)}</span>
          </div>
        </div>`;
    }).join("");
  }

  renderMatrix();
}

function renderMatrix() {
  const wrap = document.getElementById("matrix-wrap");
  const marathons = sortMarathons(state.marathons).slice(-8);
  const runners = sortRunners(state.runners);
  if (!marathons.length || !runners.length) {
    wrap.innerHTML = `<div class="empty" style="border:none"><strong>Matrix needs data</strong>Add runners and marathons.</div>`;
    return;
  }
  const head = marathons.map((m) =>
    `<th title="${escapeHtml(m.name)}">${escapeHtml(m.name.length > 14 ? m.name.slice(0, 12) + "…" : m.name)}<br><span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--text-dim)">${escapeHtml(String(m.race_date).slice(5))}</span></th>`
  ).join("");
  const rows = runners.map((runner) => {
    const cells = marathons.map((m) => {
      const reg = state.registrations.find((r) => r.runner_id === runner.id && r.marathon_id === m.id);
      if (!reg) return `<td><span class="matrix-dot"></span></td>`;
      if (displayFinishTime(reg)) {
        return `<td><span class="time-mono" style="font-size:0.78rem">${escapeHtml(displayFinishTime(reg))}</span></td>`;
      }
      return `<td>${statusBadge(reg.status)}</td>`;
    }).join("");
    return `<tr><td>${escapeHtml(runner.name)}</td>${cells}</tr>`;
  }).join("");
  wrap.innerHTML = `<table class="data-table matrix-table"><thead><tr><th>Runner</th>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

function renderMarathons() {
  const q = (document.getElementById("marathon-search")?.value || "").trim().toLowerCase();
  const filter = document.getElementById("marathon-filter-status")?.value || "all";
  let list = sortMarathons(state.marathons);
  if (filter === "upcoming") list = list.filter((m) => !isPast(m.race_date));
  if (filter === "past") list = list.filter((m) => isPast(m.race_date));
  if (q) {
    list = list.filter((m) =>
      [m.name, m.location, m.distance, m.notes].join(" ").toLowerCase().includes(q)
    );
  }
  const el = document.getElementById("marathon-list");
  if (!list.length) {
    el.innerHTML = `<div class="empty" style="grid-column:1/-1"><strong>No marathons found</strong></div>`;
    return;
  }
  el.innerHTML = list.map((m) => {
    const regs = regsForMarathon(m.id);
    const finished = regs.filter((r) => r.status === "completed" || displayFinishTime(r));
    const times = finished.map(bestFinishSeconds).filter((s) => s != null).sort((a, b) => a - b);
    const best = times.length ? formatSeconds(times[0]) : null;
    const delBtn = canDelete()
      ? `<button class="btn btn-danger btn-sm" data-action="delete" data-id="${m.id}">Delete</button>`
      : "";
    return `
      <article class="card">
        <div style="display:flex;justify-content:space-between;gap:0.5rem">
          <h3 class="card-title">${escapeHtml(m.name)}</h3>
          <span class="badge badge-distance">${escapeHtml(m.distance)}</span>
        </div>
        <div class="card-meta">
          <span>📅 ${formatDate(m.race_date)}${isPast(m.race_date) ? " · past" : ""}</span>
          <span>📍 ${escapeHtml(m.location || "TBD")}</span>
          ${best ? `<span>🏆 <span class="time-mono">${best}</span></span>` : ""}
        </div>
        ${m.notes ? `<p class="card-notes">${escapeHtml(m.notes)}</p>` : ""}
        <div class="card-footer">
          <span class="badge badge-count">${regs.length} entries · ${finished.length} results</span>
          <div class="card-actions">
            <button class="btn btn-ghost btn-sm" data-action="results" data-id="${m.id}">Results</button>
            ${canWrite() ? `<button class="btn btn-secondary btn-sm" data-action="edit" data-id="${m.id}">Edit</button>` : ""}
            ${delBtn}
          </div>
        </div>
      </article>`;
  }).join("");

  el.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      if (btn.dataset.action === "edit") openMarathonForm(id);
      if (btn.dataset.action === "delete") confirmDeleteMarathon(id);
      if (btn.dataset.action === "results") {
        setView("results");
        const sel = document.getElementById("results-marathon");
        if (sel) { sel.value = id; renderResults(); }
      }
    });
  });
}

function renderRunners() {
  const q = (document.getElementById("member-search")?.value || "").trim().toLowerCase();
  let list = sortRunners(state.runners);
  if (q) {
    list = list.filter((m) =>
      [m.name, m.email, m.phone, m.notes].join(" ").toLowerCase().includes(q)
    );
  }
  const el = document.getElementById("member-list");
  if (!list.length) {
    el.innerHTML = `<div class="empty" style="grid-column:1/-1"><strong>No runners yet</strong>Add people from your group.</div>`;
    return;
  }
  el.innerHTML = list.map((m) => {
    const regs = regsForRunner(m.id);
    const finishes = regs.filter((r) => displayFinishTime(r));
    const prs = regs.filter((r) => r.is_pr).length;
    const delBtn = canDelete()
      ? `<button class="btn btn-danger btn-sm" data-action="delete" data-id="${m.id}">Delete</button>`
      : "";
    return `
      <article class="card">
        <div class="member-head">
          <div class="avatar" style="background:${avatarColor(m.id)}22;color:${avatarColor(m.id)}">${escapeHtml(initials(m.name))}</div>
          <div>
            <h3 class="card-title">${escapeHtml(m.name)}</h3>
            <p class="member-contact">${escapeHtml(m.email || m.phone || "No contact")}</p>
          </div>
        </div>
        ${m.notes ? `<p class="card-notes">${escapeHtml(m.notes)}</p>` : ""}
        <div class="card-footer">
          <span class="badge badge-count">${finishes.length} result${finishes.length === 1 ? "" : "s"}${prs ? ` · ${prs} PR` : ""}</span>
          <div class="card-actions">
            ${canWrite() ? `<button class="btn btn-secondary btn-sm" data-action="edit" data-id="${m.id}">Edit</button>` : ""}
            ${delBtn}
          </div>
        </div>
      </article>`;
  }).join("");

  el.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.action === "edit") openRunnerForm(btn.dataset.id);
      if (btn.dataset.action === "delete") confirmDeleteRunner(btn.dataset.id);
    });
  });
}

function populateRegFilters() {
  const sel = document.getElementById("reg-filter-marathon");
  if (!sel) return;
  const current = sel.value || "all";
  sel.innerHTML =
    `<option value="all">All marathons</option>` +
    sortMarathons(state.marathons).map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join("");
  if ([...sel.options].some((o) => o.value === current)) sel.value = current;
}

function renderRegistrations() {
  populateRegFilters();
  const q = (document.getElementById("reg-search")?.value || "").trim().toLowerCase();
  const marathonFilter = document.getElementById("reg-filter-marathon")?.value || "all";
  const statusFilter = document.getElementById("reg-filter-status")?.value || "all";
  let list = [...state.registrations];
  if (marathonFilter !== "all") list = list.filter((r) => r.marathon_id === marathonFilter);
  if (statusFilter !== "all") list = list.filter((r) => r.status === statusFilter);
  if (q) {
    list = list.filter((r) => {
      const runner = getRunner(r.runner_id);
      const marathon = getMarathon(r.marathon_id);
      return [runner?.name, marathon?.name, r.bib, r.notes, r.gun_time, r.chip_time, r.status]
        .join(" ").toLowerCase().includes(q);
    });
  }
  list.sort((a, b) => {
    const da = getMarathon(a.marathon_id)?.race_date || "";
    const db = getMarathon(b.marathon_id)?.race_date || "";
    return String(db).localeCompare(String(da));
  });

  const tbody = document.getElementById("reg-tbody");
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty" style="border:none;margin:0.5rem"><strong>No registrations</strong></div></td></tr>`;
    return;
  }
  tbody.innerHTML = list.map((r) => {
    const runner = getRunner(r.runner_id);
    const marathon = getMarathon(r.marathon_id);
    const time = displayFinishTime(r);
    const pace = paceForRegistration(r, marathon);
    const delBtn = canDelete()
      ? `<button class="btn btn-danger btn-sm" data-action="delete" data-id="${r.id}">Delete</button>`
      : "";
    return `
      <tr>
        <td>${escapeHtml(runner?.name || "Unknown")}</td>
        <td>${escapeHtml(marathon?.name || "Unknown")}</td>
        <td>${marathon ? formatDate(marathon.race_date) : "—"}</td>
        <td>${statusBadge(r.status)}</td>
        <td class="time-mono">${time ? escapeHtml(time) : "—"}${r.is_pr ? ' <span class="badge badge-pr">PR</span>' : ""}</td>
        <td>${pace ? escapeHtml(pace.perKm) + "/km" : "—"}</td>
        <td>${r.bib ? `<strong>#${escapeHtml(r.bib)}</strong>` : ""}${r.bib && r.notes ? " · " : ""}${escapeHtml(r.notes || (r.bib ? "" : "—"))}</td>
        <td><div class="actions">
          ${canWrite() ? `<button class="btn btn-secondary btn-sm" data-action="edit" data-id="${r.id}">Edit</button>` : ""}
          ${delBtn}
        </div></td>
      </tr>`;
  }).join("");

  tbody.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.action === "edit") openRegistrationForm(btn.dataset.id);
      if (btn.dataset.action === "delete") confirmDeleteRegistration(btn.dataset.id);
    });
  });
}

function renderResults() {
  const sel = document.getElementById("results-marathon");
  const current = sel.value;
  sel.innerHTML =
    `<option value="">Select a race…</option>` +
    sortMarathons(state.marathons).slice().reverse()
      .map((m) => `<option value="${m.id}">${escapeHtml(m.name)} (${escapeHtml(m.race_date)})</option>`)
      .join("");
  if (current && [...sel.options].some((o) => o.value === current)) sel.value = current;
  else {
    const withResults = sortMarathons(state.marathons)
      .filter((m) => regsForMarathon(m.id).some((r) => displayFinishTime(r) || r.status === "completed"))
      .reverse();
    if (withResults[0]) sel.value = withResults[0].id;
    else if (state.marathons.length) sel.value = sortMarathons(state.marathons).slice(-1)[0].id;
  }

  const marathonId = sel.value;
  const sortBy = document.getElementById("results-sort")?.value || "time";
  const completedOnly = document.getElementById("results-completed-only")?.checked ?? true;
  const summary = document.getElementById("results-summary");
  const tbody = document.getElementById("results-tbody");

  if (!marathonId) {
    summary.innerHTML = `<div class="empty" style="border:none;padding:1rem"><strong>Pick a race</strong></div>`;
    tbody.innerHTML = "";
    return;
  }

  const marathon = getMarathon(marathonId);
  let list = regsForMarathon(marathonId);
  if (completedOnly) {
    list = list.filter((r) => ["completed", "dnf", "dns"].includes(r.status) || displayFinishTime(r));
  }

  const timed = list.map((r) => ({ r, sec: bestFinishSeconds(r) }))
    .filter((x) => x.sec != null)
    .sort((a, b) => a.sec - b.sec);
  const best = timed[0]?.sec;
  const median = timed.length ? timed[Math.floor(timed.length / 2)].sec : null;
  const prCount = list.filter((r) => r.is_pr).length;
  const finishers = list.filter((r) => r.status === "completed" || displayFinishTime(r)).length;

  summary.innerHTML = `
    <div class="panel-header" style="margin-bottom:0.85rem">
      <h3>${escapeHtml(marathon?.name || "Race")} results</h3>
      <p class="panel-hint">${marathon ? formatDate(marathon.race_date) + " · " + escapeHtml(marathon.distance) : ""}</p>
    </div>
    <div class="results-summary-grid">
      <div class="results-stat"><p class="label">Finishers</p><p class="value">${finishers}</p></div>
      <div class="results-stat"><p class="label">Group best</p><p class="value time-mono time-best">${best != null ? formatSeconds(best) : "—"}</p></div>
      <div class="results-stat"><p class="label">Median</p><p class="value time-mono">${median != null ? formatSeconds(median) : "—"}</p></div>
      <div class="results-stat"><p class="label">PRs</p><p class="value">${prCount}</p></div>
    </div>`;

  list = [...list];
  list.sort((a, b) => {
    if (sortBy === "name") return (getRunner(a.runner_id)?.name || "").localeCompare(getRunner(b.runner_id)?.name || "");
    if (sortBy === "place") {
      const pa = parseInt(a.place_overall, 10);
      const pb = parseInt(b.place_overall, 10);
      if (!Number.isNaN(pa) && !Number.isNaN(pb)) return pa - pb;
      if (!Number.isNaN(pa)) return -1;
      if (!Number.isNaN(pb)) return 1;
    }
    const sa = bestFinishSeconds(a);
    const sb = bestFinishSeconds(b);
    if (sa != null && sb != null) return sa - sb;
    if (sa != null) return -1;
    if (sb != null) return 1;
    return 0;
  });

  const rankById = new Map();
  timed.forEach((x, i) => rankById.set(x.r.id, i + 1));

  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="11"><div class="empty" style="border:none;margin:0.5rem"><strong>No results for this race</strong></div></td></tr>`;
    return;
  }

  tbody.innerHTML = list.map((r) => {
    const runner = getRunner(r.runner_id);
    const pace = paceForRegistration(r, marathon);
    const rank = rankById.get(r.id);
    return `
      <tr>
        <td>${rank != null ? rank : "—"}</td>
        <td>${escapeHtml(runner?.name || "Unknown")}</td>
        <td>${statusBadge(r.status)}</td>
        <td class="time-mono">${r.gun_time ? escapeHtml(r.gun_time) : "—"}</td>
        <td class="time-mono time-best">${r.chip_time ? escapeHtml(r.chip_time) : "—"}</td>
        <td>${pace ? escapeHtml(pace.perKm) + "/km" : "—"}</td>
        <td>${r.place_overall ? escapeHtml(r.place_overall) : "—"}</td>
        <td>${r.place_age_group ? escapeHtml(r.place_age_group) : "—"}</td>
        <td>${r.is_pr ? `<span class="badge badge-pr">PR</span>` : "—"}</td>
        <td>${escapeHtml(r.result_notes || "—")}</td>
        <td>${canWrite() ? `<button class="btn btn-secondary btn-sm" data-action="edit" data-id="${r.id}">Edit</button>` : ""}</td>
      </tr>`;
  }).join("");

  tbody.querySelectorAll("[data-action=edit]").forEach((btn) => {
    btn.addEventListener("click", () => openRegistrationForm(btn.dataset.id));
  });
}

function renderTeam() {
  const invitePanel = document.getElementById("invite-panel");
  const shareUrl = `${location.origin}${location.pathname}?invite=${group.invite_code}`;
  invitePanel.innerHTML = `
    <p class="panel-hint" style="margin:0">Invite code</p>
    <div class="invite-code-big">${escapeHtml(group.invite_code)}</div>
    <div class="field" style="margin-bottom:0.85rem">
      <label>Invite link</label>
      <input class="input" id="invite-link" readonly value="${escapeHtml(shareUrl)}" />
    </div>
    <div class="room-actions">
      <button class="btn btn-primary" type="button" id="btn-copy-code">Copy code</button>
      <button class="btn btn-secondary" type="button" id="btn-copy-link">Copy link</button>
    </div>
  `;
  document.getElementById("btn-copy-code").onclick = async () => {
    await navigator.clipboard.writeText(group.invite_code);
    toast("Code copied");
  };
  document.getElementById("btn-copy-link").onclick = async () => {
    await navigator.clipboard.writeText(shareUrl);
    toast("Link copied");
  };

  const tbody = document.getElementById("team-tbody");
  const sorted = [...team].sort((a, b) => {
    const ra = ROLE_RANK[b.role] - ROLE_RANK[a.role];
    if (ra) return ra;
    return (a.profile.display_name || "").localeCompare(b.profile.display_name || "");
  });

  tbody.innerHTML = sorted.map((m) => {
    const isMe = m.user_id === session.user.id;
    let actions = "";
    if (canManageRoles() && !isMe) {
      actions = `
        <select class="select" data-role-user="${m.user_id}" style="min-width:120px">
          <option value="member" ${m.role === "member" ? "selected" : ""}>Member</option>
          <option value="moderator" ${m.role === "moderator" ? "selected" : ""}>Moderator</option>
          <option value="admin" ${m.role === "admin" ? "selected" : ""}>Admin</option>
        </select>
        <button class="btn btn-danger btn-sm" data-remove="${m.user_id}">Remove</button>`;
    } else {
      actions = roleBadge(m.role) + (isMe ? ' <span class="badge badge-count">you</span>' : "");
    }
    return `
      <tr>
        <td>${escapeHtml(m.profile.display_name || "User")}</td>
        <td>${escapeHtml(m.profile.email || "—")}</td>
        <td>${roleBadge(m.role)}</td>
        <td><div class="actions" style="flex-wrap:wrap">${actions}</div></td>
      </tr>`;
  }).join("");

  tbody.querySelectorAll("[data-role-user]").forEach((sel) => {
    sel.addEventListener("change", async () => {
      try {
        const { error } = await sb.rpc("set_member_role", {
          p_group_id: group.id,
          p_user_id: sel.dataset.roleUser,
          p_role: sel.value,
        });
        if (error) throw error;
        toast("Role updated");
        await loadGroupData();
        renderTeam();
      } catch (e) {
        toast(errMsg(e), "error");
        await loadGroupData();
        renderTeam();
      }
    });
  });

  tbody.querySelectorAll("[data-remove]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Remove this person from app access?")) return;
      try {
        const { error } = await sb.rpc("remove_group_member", {
          p_group_id: group.id,
          p_user_id: btn.dataset.remove,
        });
        if (error) throw error;
        toast("Member removed");
        await loadGroupData();
        renderTeam();
      } catch (e) {
        toast(errMsg(e), "error");
      }
    });
  });
}

// ─── Forms / CRUD ────────────────────────────────────────────────────────────

function openMarathonForm(id) {
  if (!canWrite()) return toast("No permission", "error");
  const existing = id ? getMarathon(id) : null;
  const distanceOptions = DISTANCES.map(
    (d) => `<option value="${d}" ${existing?.distance === d ? "selected" : ""}>${d}</option>`
  ).join("");

  openModal({
    title: existing ? "Edit marathon" : "Add marathon",
    bodyHtml: `
      <form class="form-grid">
        <div class="field">
          <label for="m-name">Race name *</label>
          <input class="input" id="m-name" required value="${escapeHtml(existing?.name || "")}" />
        </div>
        <div class="form-row">
          <div class="field">
            <label for="m-date">Date *</label>
            <input class="input" type="date" id="m-date" required value="${escapeHtml(existing?.race_date || "")}" />
          </div>
          <div class="field">
            <label for="m-distance">Distance</label>
            <select class="select full" id="m-distance">${distanceOptions}</select>
          </div>
        </div>
        <div class="field">
          <label for="m-location">Location</label>
          <input class="input" id="m-location" value="${escapeHtml(existing?.location || "")}" />
        </div>
        <div class="field">
          <label for="m-notes">Notes</label>
          <textarea class="textarea" id="m-notes">${escapeHtml(existing?.notes || "")}</textarea>
        </div>
      </form>`,
    footerHtml: `
      <button class="btn btn-ghost" type="button" id="mf-cancel">Cancel</button>
      <button class="btn btn-primary" type="button" id="mf-save">Save</button>`,
    onMount() {
      document.getElementById("mf-cancel").onclick = closeModal;
      document.getElementById("mf-save").onclick = async () => {
        const payload = {
          group_id: group.id,
          name: document.getElementById("m-name").value.trim(),
          race_date: document.getElementById("m-date").value,
          location: document.getElementById("m-location").value.trim(),
          distance: document.getElementById("m-distance").value,
          notes: document.getElementById("m-notes").value.trim(),
          created_by: session.user.id,
        };
        if (!payload.name || !payload.race_date) return toast("Name and date required", "error");
        try {
          if (existing) {
            const { error } = await sb.from("marathons").update(payload).eq("id", existing.id);
            if (error) throw error;
          } else {
            const { error } = await sb.from("marathons").insert(payload);
            if (error) throw error;
          }
          closeModal();
          toast("Marathon saved");
          await loadGroupData();
          render();
        } catch (e) {
          toast(errMsg(e), "error");
        }
      };
    },
  });
}

function confirmDeleteMarathon(id) {
  if (!canDelete()) return toast("Moderators and admins can delete", "error");
  const m = getMarathon(id);
  openModal({
    title: "Delete marathon?",
    bodyHtml: `<p>Delete <strong>${escapeHtml(m?.name || "race")}</strong> and all its registrations?</p>`,
    footerHtml: `
      <button class="btn btn-ghost" id="del-cancel">Cancel</button>
      <button class="btn btn-danger" id="del-confirm">Delete</button>`,
    onMount() {
      document.getElementById("del-cancel").onclick = closeModal;
      document.getElementById("del-confirm").onclick = async () => {
        try {
          const { error } = await sb.from("marathons").delete().eq("id", id);
          if (error) throw error;
          closeModal();
          toast("Deleted");
          await loadGroupData();
          render();
        } catch (e) {
          toast(errMsg(e), "error");
        }
      };
    },
  });
}

function openRunnerForm(id) {
  if (!canWrite()) return toast("No permission", "error");
  const existing = id ? getRunner(id) : null;
  openModal({
    title: existing ? "Edit runner" : "Add runner",
    bodyHtml: `
      <form class="form-grid">
        <div class="field">
          <label for="p-name">Name *</label>
          <input class="input" id="p-name" required value="${escapeHtml(existing?.name || "")}" />
        </div>
        <div class="form-row">
          <div class="field">
            <label for="p-email">Email</label>
            <input class="input" type="email" id="p-email" value="${escapeHtml(existing?.email || "")}" />
          </div>
          <div class="field">
            <label for="p-phone">Phone</label>
            <input class="input" id="p-phone" value="${escapeHtml(existing?.phone || "")}" />
          </div>
        </div>
        <div class="field">
          <label for="p-notes">Notes</label>
          <textarea class="textarea" id="p-notes">${escapeHtml(existing?.notes || "")}</textarea>
        </div>
      </form>`,
    footerHtml: `
      <button class="btn btn-ghost" id="pf-cancel">Cancel</button>
      <button class="btn btn-primary" id="pf-save">Save</button>`,
    onMount() {
      document.getElementById("pf-cancel").onclick = closeModal;
      document.getElementById("pf-save").onclick = async () => {
        const payload = {
          group_id: group.id,
          name: document.getElementById("p-name").value.trim(),
          email: document.getElementById("p-email").value.trim(),
          phone: document.getElementById("p-phone").value.trim(),
          notes: document.getElementById("p-notes").value.trim(),
          created_by: session.user.id,
        };
        if (!payload.name) return toast("Name required", "error");
        try {
          if (existing) {
            const { error } = await sb.from("runners").update(payload).eq("id", existing.id);
            if (error) throw error;
          } else {
            const { error } = await sb.from("runners").insert(payload);
            if (error) throw error;
          }
          closeModal();
          toast("Runner saved");
          await loadGroupData();
          render();
        } catch (e) {
          toast(errMsg(e), "error");
        }
      };
    },
  });
}

function confirmDeleteRunner(id) {
  if (!canDelete()) return toast("Moderators and admins can delete", "error");
  const m = getRunner(id);
  openModal({
    title: "Delete runner?",
    bodyHtml: `<p>Remove <strong>${escapeHtml(m?.name || "runner")}</strong> and their registrations?</p>`,
    footerHtml: `
      <button class="btn btn-ghost" id="del-cancel">Cancel</button>
      <button class="btn btn-danger" id="del-confirm">Delete</button>`,
    onMount() {
      document.getElementById("del-cancel").onclick = closeModal;
      document.getElementById("del-confirm").onclick = async () => {
        try {
          const { error } = await sb.from("runners").delete().eq("id", id);
          if (error) throw error;
          closeModal();
          toast("Deleted");
          await loadGroupData();
          render();
        } catch (e) {
          toast(errMsg(e), "error");
        }
      };
    },
  });
}

function openRegistrationForm(id, defaults = {}) {
  if (!canWrite()) return toast("No permission", "error");
  if (!state.runners.length) return toast("Add a runner first", "error");
  if (!state.marathons.length) return toast("Add a marathon first", "error");

  const existing = id ? state.registrations.find((r) => r.id === id) : null;
  const defaultStatus = defaults.preferResult ? "completed" : existing?.status || "registered";

  const runnerOpts = sortRunners(state.runners)
    .map((m) => `<option value="${m.id}" ${(existing?.runner_id || defaults.runnerId) === m.id ? "selected" : ""}>${escapeHtml(m.name)}</option>`)
    .join("");
  const marathonOpts = sortMarathons(state.marathons)
    .map((m) => `<option value="${m.id}" ${(existing?.marathon_id || defaults.marathonId) === m.id ? "selected" : ""}>${escapeHtml(m.name)} (${escapeHtml(m.race_date)})</option>`)
    .join("");
  const statusOpts = STATUSES.map(
    (s) => `<option value="${s.value}" ${defaultStatus === s.value ? "selected" : ""}>${s.label}</option>`
  ).join("");

  openModal({
    title: existing ? "Edit registration / result" : defaults.preferResult ? "Enter result" : "Add registration",
    wide: true,
    bodyHtml: `
      <form class="form-grid">
        <p class="form-section-title">Entry</p>
        <div class="field">
          <label for="r-runner">Runner *</label>
          <select class="select full" id="r-runner">${runnerOpts}</select>
        </div>
        <div class="field">
          <label for="r-marathon">Marathon *</label>
          <select class="select full" id="r-marathon">${marathonOpts}</select>
        </div>
        <div class="form-row">
          <div class="field">
            <label for="r-status">Status</label>
            <select class="select full" id="r-status">${statusOpts}</select>
          </div>
          <div class="field">
            <label for="r-bib">Bib number</label>
            <input class="input" id="r-bib" value="${escapeHtml(existing?.bib || "")}" />
          </div>
        </div>
        <p class="form-section-title">Results &amp; times</p>
        <div class="form-row">
          <div class="field">
            <label for="r-gun">Gun time</label>
            <input class="input" id="r-gun" value="${escapeHtml(existing?.gun_time || "")}" placeholder="3:45:12 or 1:42:18" />
          </div>
          <div class="field">
            <label for="r-chip">Chip / net time</label>
            <input class="input" id="r-chip" value="${escapeHtml(existing?.chip_time || "")}" placeholder="3:44:50" />
          </div>
        </div>
        <div class="pace-preview" id="r-pace-preview"></div>
        <div class="form-row">
          <div class="field">
            <label for="r-place">Overall place</label>
            <input class="input" id="r-place" value="${escapeHtml(existing?.place_overall || "")}" />
          </div>
          <div class="field">
            <label for="r-place-g">Gender place</label>
            <input class="input" id="r-place-g" value="${escapeHtml(existing?.place_gender || "")}" />
          </div>
        </div>
        <div class="form-row">
          <div class="field">
            <label for="r-place-ag">Age group place</label>
            <input class="input" id="r-place-ag" value="${escapeHtml(existing?.place_age_group || "")}" />
          </div>
          <div class="field" style="display:flex;align-items:flex-end;padding-bottom:0.35rem">
            <label class="check-inline">
              <input type="checkbox" id="r-pr" ${existing?.is_pr ? "checked" : ""} />
              Personal record (PR)
            </label>
          </div>
        </div>
        <div class="field">
          <label for="r-result-notes">Result notes</label>
          <textarea class="textarea" id="r-result-notes">${escapeHtml(existing?.result_notes || "")}</textarea>
        </div>
        <div class="field">
          <label for="r-notes">Registration notes</label>
          <textarea class="textarea" id="r-notes">${escapeHtml(existing?.notes || "")}</textarea>
        </div>
      </form>`,
    footerHtml: `
      <button class="btn btn-ghost" id="rf-cancel">Cancel</button>
      <button class="btn btn-primary" id="rf-save">Save</button>`,
    onMount() {
      const updatePace = () => {
        const marathon = getMarathon(document.getElementById("r-marathon").value);
        const pace = paceForRegistration(
          { chip_time: document.getElementById("r-chip").value, gun_time: document.getElementById("r-gun").value },
          marathon
        );
        document.getElementById("r-pace-preview").textContent = pace ? `Pace: ${pace.label}` : "";
      };
      ["r-marathon", "r-chip", "r-gun"].forEach((id) => {
        document.getElementById(id).addEventListener("input", updatePace);
        document.getElementById(id).addEventListener("change", updatePace);
      });
      updatePace();

      document.getElementById("rf-cancel").onclick = closeModal;
      document.getElementById("rf-save").onclick = async () => {
        let status = document.getElementById("r-status").value;
        const gun_time = normalizeTimeInput(document.getElementById("r-gun").value);
        const chip_time = normalizeTimeInput(document.getElementById("r-chip").value);
        if (document.getElementById("r-gun").value.trim() && parseTimeToSeconds(document.getElementById("r-gun").value) == null) {
          return toast("Gun time format not recognized", "error");
        }
        if (document.getElementById("r-chip").value.trim() && parseTimeToSeconds(document.getElementById("r-chip").value) == null) {
          return toast("Chip time format not recognized", "error");
        }
        if ((gun_time || chip_time) && status !== "dnf" && status !== "dns") status = "completed";

        const payload = {
          group_id: group.id,
          runner_id: document.getElementById("r-runner").value,
          marathon_id: document.getElementById("r-marathon").value,
          status,
          bib: document.getElementById("r-bib").value.trim(),
          notes: document.getElementById("r-notes").value.trim(),
          gun_time,
          chip_time,
          place_overall: document.getElementById("r-place").value.trim(),
          place_gender: document.getElementById("r-place-g").value.trim(),
          place_age_group: document.getElementById("r-place-ag").value.trim(),
          is_pr: document.getElementById("r-pr").checked,
          result_notes: document.getElementById("r-result-notes").value.trim(),
          created_by: session.user.id,
        };

        try {
          if (existing) {
            const { error } = await sb.from("registrations").update(payload).eq("id", existing.id);
            if (error) throw error;
          } else {
            const { error } = await sb.from("registrations").insert(payload);
            if (error) throw error;
          }
          closeModal();
          toast("Saved");
          await loadGroupData();
          render();
        } catch (e) {
          toast(errMsg(e), "error");
        }
      };
    },
  });
}

function confirmDeleteRegistration(id) {
  if (!canDelete()) return toast("Moderators and admins can delete", "error");
  openModal({
    title: "Delete registration?",
    bodyHtml: `<p>Remove this registration / result?</p>`,
    footerHtml: `
      <button class="btn btn-ghost" id="del-cancel">Cancel</button>
      <button class="btn btn-danger" id="del-confirm">Delete</button>`,
    onMount() {
      document.getElementById("del-cancel").onclick = closeModal;
      document.getElementById("del-confirm").onclick = async () => {
        try {
          const { error } = await sb.from("registrations").delete().eq("id", id);
          if (error) throw error;
          closeModal();
          toast("Deleted");
          await loadGroupData();
          render();
        } catch (e) {
          toast(errMsg(e), "error");
        }
      };
    },
  });
}

// ─── Wire UI ─────────────────────────────────────────────────────────────────

function wireAuthUi() {
  document.querySelectorAll("[data-auth-tab]").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll("[data-auth-tab]").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const mode = tab.dataset.authTab;
      document.getElementById("form-signin").hidden = mode !== "signin";
      document.getElementById("form-signup").hidden = mode !== "signup";
      document.getElementById("auth-error").hidden = true;
    });
  });

  document.getElementById("form-signin").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("auth-error");
    errEl.hidden = true;
    try {
      await signIn(
        document.getElementById("signin-email").value.trim(),
        document.getElementById("signin-password").value
      );
    } catch (err) {
      errEl.textContent = errMsg(err);
      errEl.hidden = false;
    }
  });

  document.getElementById("form-signup").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("auth-error");
    errEl.hidden = true;
    try {
      await signUp(
        document.getElementById("signup-email").value.trim(),
        document.getElementById("signup-password").value,
        document.getElementById("signup-name").value.trim()
      );
      toast("Account created");
    } catch (err) {
      errEl.textContent = errMsg(err);
      errEl.hidden = false;
    }
  });

  document.getElementById("form-create-group").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("onboard-error");
    errEl.hidden = true;
    try {
      await createGroup(document.getElementById("group-name").value.trim());
      await enterApp();
      toast("Group created — share your invite code from Team & access");
    } catch (err) {
      errEl.textContent = errMsg(err);
      errEl.hidden = false;
    }
  });

  document.getElementById("form-join-group").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("onboard-error");
    errEl.hidden = true;
    try {
      await joinGroup(document.getElementById("invite-code").value.trim());
      await enterApp();
      toast("Joined group");
    } catch (err) {
      errEl.textContent = errMsg(err);
      errEl.hidden = false;
    }
  });

  document.getElementById("btn-signout").onclick = () => signOut();
  document.getElementById("btn-signout-onboard").onclick = () => signOut();
}

function wireAppUi() {
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => setView(btn.dataset.view));
  });
  document.getElementById("modal-close").onclick = closeModal;
  document.getElementById("modal-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "modal-backdrop") closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.getElementById("modal-backdrop").hidden) closeModal();
  });

  ["marathon-search", "marathon-filter-status"].forEach((id) => {
    const el = document.getElementById(id);
    el?.addEventListener("input", () => renderMarathons());
    el?.addEventListener("change", () => renderMarathons());
  });
  document.getElementById("member-search")?.addEventListener("input", () => renderRunners());
  ["reg-search", "reg-filter-marathon", "reg-filter-status"].forEach((id) => {
    const el = document.getElementById(id);
    el?.addEventListener("input", () => renderRegistrations());
    el?.addEventListener("change", () => renderRegistrations());
  });
  ["results-marathon", "results-sort", "results-completed-only"].forEach((id) => {
    document.getElementById(id)?.addEventListener("change", () => renderResults());
  });
}

// ─── Boot ────────────────────────────────────────────────────────────────────

async function init() {
  if (!isConfigured()) {
    showScreen("config");
    return;
  }

  sb = createClient();
  wireAuthUi();
  wireAppUi();

  sb.auth.onAuthStateChange(async (_event, newSession) => {
    await handleSession(newSession);
  });

  const { data } = await sb.auth.getSession();
  if (!data.session) {
    showScreen("auth");
  }
  // else onAuthStateChange / getSession will handle
  if (data.session) {
    await handleSession(data.session);
  }
}

init().catch((e) => {
  console.error(e);
  document.getElementById("boot-msg").textContent = errMsg(e);
});