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
  members: { title: "Runners", desc: "People in the running roster (one per app member)" },
  registrations: { title: "Registrations", desc: "Who is signed up for which race" },
  results: { title: "Results & times", desc: "Finish times for registered runners only" },
  team: { title: "Team & access", desc: "Create users, logo, roles, and permissions" },
  profile: { title: "My profile", desc: "Photo, display name, and password" },
};

const ROLE_RANK = { member: 1, moderator: 2, admin: 3 };

const DEFAULT_BRAND_SVG = `
  <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
    <circle cx="16" cy="16" r="14" stroke="currentColor" stroke-width="2"/>
    <path d="M8 18c2-4 4-6 8-6s6 2 8 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    <path d="M12 12l2 8 2-5 2 5 2-8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

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
let raceTimerId = null;
let selectedWhosRunningMarathonId = null;
const SIDEBAR_COLLAPSED_KEY = "pacepack_sidebar_collapsed";

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

function canCreateUsers() {
  return hasMinRole("moderator");
}

function canAddRunners() {
  return hasMinRole("moderator");
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

/** Normalize race_time to HH:MM:SS for local Date parsing (default 09:00). */
function normalizeRaceTime(t) {
  const raw = String(t || "").trim();
  const m = raw.match(/^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?$/);
  if (!m) return "09:00:00";
  const h = String(Math.min(23, Number(m[1]))).padStart(2, "0");
  const min = m[2];
  const sec = m[3] || "00";
  return `${h}:${min}:${sec}`;
}

function formatRaceTime(t) {
  return normalizeRaceTime(t).slice(0, 5);
}

function formatRaceDateTime(marathon) {
  if (!marathon?.race_date) return "—";
  return `${formatDate(marathon.race_date)} · ${formatRaceTime(marathon.race_time)}`;
}

/**
 * True if a race has already started.
 * Accepts a marathon object (uses race_date + race_time) or a date string (date-only).
 */
function isPast(isoOrMarathon) {
  if (isoOrMarathon && typeof isoOrMarathon === "object") {
    const target = nextRaceTargetDate(isoOrMarathon);
    return !target || target.getTime() <= Date.now();
  }
  return String(isoOrMarathon || "").slice(0, 10) < todayISO();
}

function daysUntil(isoOrMarathon) {
  if (isoOrMarathon && typeof isoOrMarathon === "object") {
    const target = nextRaceTargetDate(isoOrMarathon);
    if (!target) return 0;
    const a = new Date();
    a.setHours(0, 0, 0, 0);
    const b = new Date(target);
    b.setHours(0, 0, 0, 0);
    return Math.round((b - a) / 86400000);
  }
  const a = new Date(todayISO() + "T12:00:00");
  const b = new Date(String(isoOrMarathon).slice(0, 10) + "T12:00:00");
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

function renderProfileAvatar(profile, fallbackName, fallbackId) {
  const src = profile?.image_url || profile?.profile_picture_url || "";
  if (src) {
    return `<img class="avatar avatar-image" src="${escapeHtml(src)}" alt="${escapeHtml(fallbackName || "Profile")}" />`;
  }
  const color = avatarColor(fallbackId || fallbackName || "");
  return `<div class="avatar" style="background:${color}22;color:${color}">${escapeHtml(initials(fallbackName))}</div>`;
}

function renderMarathonImage(marathon) {
  const src = marathon?.image_url || "";
  if (src) {
    return `
      <div class="marathon-media">
        <img class="marathon-image" src="${escapeHtml(src)}" alt="${escapeHtml(marathon?.name || "Marathon")}" />
      </div>`;
  }
  return `
    <div class="marathon-media marathon-media-empty">
      <span>Race image</span>
    </div>`;
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

function getRunnerForUser(userId) {
  if (!userId) return null;
  return state.runners.find((r) => r.user_id === userId) || null;
}

function profileImageUrl(p) {
  return (p?.profile_picture_url || p?.image_url || "").trim();
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
  return [...list].sort((a, b) => {
    const ta = nextRaceTargetDate(a)?.getTime() ?? 0;
    const tb = nextRaceTargetDate(b)?.getTime() ?? 0;
    if (ta !== tb) return ta - tb;
    return (a.name || "").localeCompare(b.name || "");
  });
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
  const passwordGate = document.getElementById("password-gate-screen");
  if (passwordGate) passwordGate.hidden = name !== "password-gate";
  document.getElementById("app-shell").hidden = name !== "app";
}

function mustChangePassword() {
  const meta = session?.user?.user_metadata?.must_change_password;
  const prof = profile?.must_change_password;
  return meta === true || meta === "true" || prof === true;
}

function brandLogoHtml(url) {
  const src = (url || "").trim();
  if (src) {
    return `<img class="brand-logo-img" src="${escapeHtml(src)}" alt="" />`;
  }
  return DEFAULT_BRAND_SVG;
}

function applyBrandLogo() {
  const url = group?.logo_url || "";
  document.querySelectorAll("[data-brand-logo]").forEach((el) => {
    el.innerHTML = brandLogoHtml(url);
  });
  const preview = document.querySelector("[data-brand-logo-preview]");
  if (preview) preview.innerHTML = brandLogoHtml(url);
  const title = document.getElementById("brand-title");
  if (title) title.textContent = "Impulsive Runners";
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
    const profilePicture = session.user.user_metadata?.profile_picture_url || session.user.user_metadata?.avatar_url || "";
    const password = session.user.user_metadata?.password || "";
    const { data: created, error: e2 } = await sb
      .from("profiles")
      .upsert({
        id: session.user.id,
        display_name: name,
        email: session.user.email,
        profile_picture_url: profilePicture,
        password,
      })
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

  let g = null;
  let gErr = null;
  ({ data: g, error: gErr } = await sb
    .from("groups")
    .select("*")
    .eq("id", membership.group_id)
    .maybeSingle());
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
      .select("id, display_name, email, profile_picture_url")
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
      profile_picture_url: row.user_id === session.user.id ? (profile?.profile_picture_url || "") : "",
    },
  }));

  // Each app member is also a runner on the roster
  await ensureRunnersForTeamMembers();
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

async function signOut() {
  stopRaceTimer();
  unsubscribeAll();
  await sb.auth.signOut();
  session = null;
  profile = null;
  group = null;
  myRole = null;
  state = { marathons: [], runners: [], registrations: [] };
  team = [];
  selectedWhosRunningMarathonId = null;
  showScreen("auth");
}

function isSidebarCollapsed() {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch (_) {
    return false;
  }
}

function setSidebarCollapsed(collapsed) {
  const shell = document.getElementById("app-shell");
  if (!shell) return;
  shell.classList.toggle("sidebar-collapsed", !!collapsed);
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch (_) {
    /* ignore */
  }
  document.querySelectorAll("#btn-sidebar-toggle, #btn-sidebar-toggle-mobile").forEach((btn) => {
    btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    btn.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
    const icon = btn.querySelector(".sidebar-toggle-icon");
    if (icon) icon.textContent = collapsed ? "⟩" : "⟨";
  });
}

function toggleSidebar() {
  setSidebarCollapsed(!document.getElementById("app-shell")?.classList.contains("sidebar-collapsed"));
}

function stopRaceTimer() {
  if (raceTimerId) {
    clearInterval(raceTimerId);
    raceTimerId = null;
  }
}

function nextRaceTargetDate(marathon) {
  if (!marathon?.race_date) return null;
  // Countdown to race start (date + race_time, default 09:00 local)
  const date = String(marathon.race_date).slice(0, 10);
  const time = normalizeRaceTime(marathon.race_time);
  return new Date(`${date}T${time}`);
}

function formatCountdownParts(target) {
  const now = Date.now();
  let diff = Math.max(0, target.getTime() - now);
  const days = Math.floor(diff / 86400000);
  diff -= days * 86400000;
  const hours = Math.floor(diff / 3600000);
  diff -= hours * 3600000;
  const mins = Math.floor(diff / 60000);
  diff -= mins * 60000;
  const secs = Math.floor(diff / 1000);
  return { days, hours, mins, secs, done: target.getTime() <= now };
}

function updateRaceTimerDisplay(marathon) {
  const meta = document.getElementById("next-race-meta");
  const panel = document.getElementById("next-race-panel");
  if (!meta || !panel) return;

  if (!marathon) {
    meta.textContent = "No upcoming races scheduled";
    panel.classList.add("next-race-empty");
    ["days", "hours", "mins", "secs"].forEach((u) => {
      const el = panel.querySelector(`[data-unit="${u}"]`);
      if (el) el.textContent = "0";
    });
    return;
  }

  panel.classList.remove("next-race-empty");
  const target = nextRaceTargetDate(marathon);
  const parts = formatCountdownParts(target);
  const count = regsForMarathon(marathon.id).length;
  if (parts.done) {
    meta.textContent = `${marathon.name} · ${formatRaceDateTime(marathon)} · started · ${count} signed up`;
  } else {
    meta.textContent = `${marathon.name} · ${formatRaceDateTime(marathon)} · ${marathon.location || "TBD"} · ${count} signed up`;
  }
  const map = { days: parts.days, hours: parts.hours, mins: parts.mins, secs: parts.secs };
  Object.entries(map).forEach(([u, v]) => {
    const el = panel.querySelector(`[data-unit="${u}"]`);
    if (el) el.textContent = String(v);
  });
}

function startRaceTimer() {
  stopRaceTimer();
  const upcoming = sortMarathons(state.marathons.filter((m) => !isPast(m)));
  const next = upcoming[0] || null;
  updateRaceTimerDisplay(next);
  if (!next) return;
  raceTimerId = setInterval(() => {
    if (currentView !== "dashboard") return;
    const still = sortMarathons(state.marathons.filter((m) => !isPast(m)))[0] || null;
    updateRaceTimerDisplay(still);
  }, 1000);
}

async function createGroup(name) {
  const { data, error } = await sb.rpc("create_group", { p_name: name });
  if (error) throw error;
  const ok = await loadMembership();
  if (!ok) {
    if (data) {
      group = data;
      myRole = "admin";
    } else {
      throw new Error("Group was created but could not be loaded. Run fix-relationships.sql in Supabase.");
    }
  }

  if (profile) {
    profile.group_id = group?.id || profile.group_id;
    profile.user_type = profile.user_type || "admin";
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

/**
 * A moderator or admin creates a login for someone else and adds them to the current group.
 * Uses a throwaway Supabase client so the admin session is not replaced.
 */
async function adminCreateUser({ email, password, displayName, role }) {
  if (!canCreateUsers()) throw new Error("Only moderators and admins can create users");
  if (!group?.id) throw new Error("No group loaded");

  const name = (displayName || "").trim();
  const mail = (email || "").trim().toLowerCase();
  const pass = password || "";
  const memberRole = role || "member";

  if (!name) throw new Error("Display name is required");
  if (!mail) throw new Error("Email is required");
  if (pass.length < 6) throw new Error("Password must be at least 6 characters");
  if (!["admin", "moderator", "member"].includes(memberRole)) {
    throw new Error("Invalid role");
  }
  if (memberRole !== "member" && !canManageRoles()) {
    throw new Error("Moderators can only create member users");
  }

  const { url, key } = getConfig();
  const temp = window.supabase.createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  const { data, error } = await temp.auth.signUp({
    email: mail,
    password: pass,
    options: {
      data: {
        display_name: name,
        must_change_password: true,
      },
    },
  });
  if (error) throw error;
  if (!data.user?.id) {
    throw new Error(
      "User was not created. If email confirmation is required, disable it in Supabase Auth settings."
    );
  }

  // Prefer security-definer RPC; fall back to direct insert if SQL not re-run yet
  let addError = null;
  const { error: rpcErr } = await sb.rpc("add_group_member", {
    p_group_id: group.id,
    p_user_id: data.user.id,
    p_role: memberRole,
  });
  addError = rpcErr;

  if (addError) {
    const { error: insertErr } = await sb.from("group_memberships").insert({
      group_id: group.id,
      user_id: data.user.id,
      role: memberRole,
    });
    if (insertErr) {
      throw new Error(
        `Account created (${mail}) but could not add to group: ${errMsg(addError)}. ` +
          `Run the latest supabase-schema.sql (add_group_member) in Supabase, or add them via invite. ` +
          `(fallback: ${errMsg(insertErr)})`
      );
    }
  }

  // Best-effort profile name sync (trigger usually already set it; RLS may block)
  try {
    await sb
      .from("profiles")
      .update({
        display_name: name,
        email: mail,
        must_change_password: true,
      })
      .eq("id", data.user.id);
  } catch (_) {
    /* ignore */
  }

  // Each team member is also a runner on the race roster
  try {
    await createRunnerForMember({
      userId: data.user.id,
      name,
      email: mail,
      imageUrl: "",
    });
  } catch (runnerErr) {
    console.warn("runner create:", runnerErr);
  }
}

/**
 * Ensure a runners row exists for an app member (linked via user_id when available).
 * Returns true if a new runner was created.
 */
async function createRunnerForMember({ userId, name, email, imageUrl }) {
  if (!group?.id) return false;
  const displayName = (name || email || "Runner").trim() || "Runner";
  const mail = (email || "").trim();
  const photo = (imageUrl || "").trim();

  const existing =
    (userId && state.runners.find((r) => r.user_id === userId)) ||
    (mail && state.runners.find((r) => (r.email || "").toLowerCase() === mail.toLowerCase())) ||
    null;

  if (existing) {
    const patch = {};
    if (userId && !existing.user_id) patch.user_id = userId;
    if (displayName && existing.name !== displayName) patch.name = displayName;
    if (mail && existing.email !== mail) patch.email = mail;
    if (photo && existing.image_url !== photo) patch.image_url = photo;
    if (Object.keys(patch).length) {
      const { error } = await sb.from("runners").update(patch).eq("id", existing.id);
      if (!error) Object.assign(existing, patch);
    }
    return false;
  }

  const row = {
    group_id: group.id,
    name: displayName,
    email: mail,
    image_url: photo,
    notes: "",
    created_by: session?.user?.id || null,
  };
  if (userId) row.user_id = userId;

  let { data, error } = await sb.from("runners").insert(row).select().single();
  if (error && userId && /user_id|column/i.test(error.message || "")) {
    delete row.user_id;
    ({ data, error } = await sb.from("runners").insert(row).select().single());
  }
  if (error) throw error;
  if (data) state.runners.push(data);
  return true;
}

async function ensureRunnersForTeamMembers() {
  if (!group?.id || !team.length) return;
  let created = false;
  for (const m of team) {
    try {
      const did = await createRunnerForMember({
        userId: m.user_id,
        name: m.profile?.display_name,
        email: m.profile?.email,
        imageUrl: profileImageUrl(m.profile),
      });
      if (did) created = true;
    } catch (e) {
      console.warn("ensure runner for member:", m.user_id, e);
    }
  }
  if (created) {
    const { data, error } = await sb
      .from("runners")
      .select("*")
      .eq("group_id", group.id)
      .order("name");
    if (!error && data) state.runners = data;
  }
}

async function enterApp() {
  if (mustChangePassword()) {
    showScreen("password-gate");
    return;
  }
  setBoot("Loading group data…");
  await loadGroupData();
  subscribeRealtime();
  showScreen("app");
  applyBrandLogo();
  updateUserChrome();
  updateRolePill();
  setSidebarCollapsed(isSidebarCollapsed());
  setView("dashboard");
}

async function completePasswordGate(newPassword) {
  const { error } = await sb.auth.updateUser({
    password: newPassword,
    data: { must_change_password: false },
  });
  if (error) throw error;

  try {
    await sb
      .from("profiles")
      .update({ must_change_password: false })
      .eq("id", session.user.id);
  } catch (_) {
    /* column may not exist yet */
  }

  // Refresh session metadata
  const { data } = await sb.auth.getSession();
  session = data.session || session;
  if (profile) profile.must_change_password = false;
  await loadProfile().catch(() => {});
  await enterApp();
}

async function saveGroupLogo(url) {
  if (!canManageRoles()) throw new Error("Only admins can change the logo");
  if (!group?.id) throw new Error("No group loaded");
  const logo_url = (url || "").trim();
  const { data, error } = await sb
    .from("groups")
    .update({ logo_url })
    .eq("id", group.id)
    .select("*")
    .maybeSingle();
  if (error) {
    if (/logo_url|column/i.test(error.message || "")) {
      throw new Error("Run SQL to add groups.logo_url (see add-image-url-columns.sql), then try again.");
    }
    throw error;
  }
  group = data || { ...group, logo_url };
  applyBrandLogo();
}

function updateUserChrome() {
  const name = profile?.display_name || session?.user?.email || "User";
  const display = document.getElementById("user-display");
  if (display) display.textContent = name;
  const slot = document.getElementById("user-avatar-slot");
  if (slot) {
    slot.innerHTML = renderProfileAvatar(
      { image_url: profileImageUrl(profile) },
      name,
      session?.user?.id
    );
  }
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
  if (view !== "dashboard") stopRaceTimer();
  renderTopbarActions();
  render();
}

function openRunnerCreateFlow() {
  if (!canCreateUsers()) {
    toast("Only moderators and admins can add runners", "error");
    return;
  }
  setView("team");
  setTimeout(() => {
    const input = document.getElementById("new-user-name");
    if (input) {
      input.focus();
      input.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, 80);
}

function renderTopbarActions() {
  const el = document.getElementById("topbar-actions");
  if (currentView === "members") {
    el.innerHTML = canAddRunners()
      ? `<button class="btn btn-primary" id="btn-add-member">+ Create user / runner</button>`
      : "";
    const addMember = document.getElementById("btn-add-member");
    if (addMember) addMember.onclick = () => openRunnerCreateFlow();
    return;
  }
  if (!canWrite()) {
    el.innerHTML = "";
    return;
  }
  if (currentView === "marathons") {
    el.innerHTML = `<button class="btn btn-primary" id="btn-add-marathon">+ Add marathon</button>`;
    document.getElementById("btn-add-marathon").onclick = () => openMarathonForm();
  } else if (currentView === "registrations") {
    el.innerHTML = `<button class="btn btn-primary" id="btn-add-reg">+ Add registration</button>`;
    document.getElementById("btn-add-reg").onclick = () => openRegistrationForm();
  } else if (currentView === "results") {
    el.innerHTML = `<button class="btn btn-primary" id="btn-add-result">+ Enter result</button>`;
    document.getElementById("btn-add-result").onclick = () => openResultForm();
  } else if (currentView === "dashboard") {
    el.innerHTML = `
      <button class="btn btn-secondary" id="btn-dash-result">+ Result</button>
      <button class="btn btn-primary" id="btn-dash-marathon">+ Marathon</button>
    `;
    document.getElementById("btn-dash-result").onclick = () => openResultForm();
    document.getElementById("btn-dash-marathon").onclick = () => openMarathonForm();
  } else {
    el.innerHTML = "";
  }
}

// ─── Render views ────────────────────────────────────────────────────────────

function render() {
  if (document.getElementById("app-shell").hidden) return;
  applyBrandLogo();
  updateRolePill();
  if (currentView === "dashboard") renderDashboard();
  if (currentView === "marathons") renderMarathons();
  if (currentView === "members") renderRunners();
  if (currentView === "registrations") renderRegistrations();
  if (currentView === "results") renderResults();
  if (currentView === "team") renderTeam();
  if (currentView === "profile") renderProfile();
}

function computeLeaderboard() {
  const byRunner = new Map();
  for (const r of state.registrations) {
    const finished = r.status === "completed" || !!displayFinishTime(r);
    if (!finished && !r.is_pr) continue;
    const cur = byRunner.get(r.runner_id) || { runnerId: r.runner_id, finishes: 0, prs: 0, score: 0 };
    if (finished) cur.finishes += 1;
    if (r.is_pr) cur.prs += 1;
    cur.score = cur.finishes + cur.prs * 2;
    byRunner.set(r.runner_id, cur);
  }
  return [...byRunner.values()]
    .map((row) => ({
      ...row,
      runner: getRunner(row.runnerId),
      name: getRunner(row.runnerId)?.name || "Unknown",
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || b.finishes - a.finishes || a.name.localeCompare(b.name));
}

function renderLeaderboardChart(entries) {
  const chartEl = document.getElementById("leaderboard-chart");
  const listEl = document.getElementById("leaderboard-list");
  if (!chartEl || !listEl) return;

  const top = entries.slice(0, 8);
  if (!top.length) {
    chartEl.innerHTML = `<div class="empty" style="border:none;padding:1rem 0.5rem"><strong>No leaderboard yet</strong>Log race results to rank runners.</div>`;
    listEl.innerHTML = "";
    return;
  }

  const max = Math.max(...top.map((e) => e.score), 1);
  const barW = 36;
  const gap = 18;
  const padL = 28;
  const padR = 16;
  const padT = 24;
  const padB = 48;
  const chartH = 160;
  const width = Math.max(280, padL + padR + top.length * (barW + gap) - gap);
  const height = padT + chartH + padB;

  const bars = top.map((e, i) => {
    const h = Math.max(6, Math.round((e.score / max) * chartH));
    const x = padL + i * (barW + gap);
    const y = padT + chartH - h;
    const color = AVATAR_COLORS[i % AVATAR_COLORS.length];
    const label = e.name.length > 10 ? `${e.name.slice(0, 9)}…` : e.name;
    return `
      <g class="lb-bar-group">
        <rect class="lb-bar" x="${x}" y="${y}" width="${barW}" height="${h}" rx="8" fill="${color}" opacity="0.9">
          <title>${escapeHtml(e.name)}: ${e.score} pts (${e.finishes} finishes, ${e.prs} PRs)</title>
        </rect>
        <text class="lb-value" x="${x + barW / 2}" y="${y - 8}" text-anchor="middle">${e.score}</text>
        <text class="lb-label" x="${x + barW / 2}" y="${padT + chartH + 18}" text-anchor="middle">${escapeHtml(label)}</text>
      </g>`;
  }).join("");

  chartEl.innerHTML = `
    <div class="leaderboard-chart-scroll">
      <svg class="leaderboard-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Runner leaderboard bar chart">
        <line class="lb-axis" x1="${padL - 8}" y1="${padT + chartH}" x2="${width - padR}" y2="${padT + chartH}" />
        ${bars}
      </svg>
    </div>`;

  listEl.innerHTML = `
    <ol class="leaderboard-ranks">
      ${top.map((e, i) => `
        <li class="leaderboard-rank-item">
          <span class="lb-rank">#${i + 1}</span>
          <span class="lb-avatar">${renderProfileAvatar(e.runner, e.name, e.runnerId)}</span>
          <span class="lb-name" title="${escapeHtml(e.name)}">${escapeHtml(e.name)}</span>
          <span class="lb-meta">${e.finishes} finish${e.finishes === 1 ? "" : "es"} · ${e.prs} PR${e.prs === 1 ? "" : "s"}</span>
          <span class="lb-score">${e.score}</span>
        </li>`).join("")}
    </ol>`;
}

function renderInsights() {
  const metricsEl = document.getElementById("insights-metrics");
  const listEl = document.getElementById("insights-list");
  if (!metricsEl || !listEl) return;

  if (typeof window.PacePackAnalytics?.analyze !== "function") {
    metricsEl.innerHTML = "";
    listEl.innerHTML = `<li class="insight-item">Analytics engine not loaded. Ensure <code>insights.js</code> is present (generated from Python).</li>`;
    return;
  }

  const report = window.PacePackAnalytics.analyze({
    runners: state.runners,
    marathons: state.marathons,
    registrations: state.registrations,
  });

  const m = report.metrics || {};
  metricsEl.innerHTML = `
    <div class="insight-metric">
      <p class="insight-metric-label">Participation</p>
      <p class="insight-metric-value">${m.participation_rate_pct != null ? m.participation_rate_pct + "%" : "—"}</p>
      <p class="insight-metric-hint">${m.active_runners ?? 0}/${m.total_runners ?? 0} runners with entries</p>
    </div>
    <div class="insight-metric">
      <p class="insight-metric-label">Avg signups / race</p>
      <p class="insight-metric-value">${m.avg_signups_per_race != null ? m.avg_signups_per_race : "—"}</p>
      <p class="insight-metric-hint">${m.total_registrations ?? 0} total registrations</p>
    </div>
    <div class="insight-metric">
      <p class="insight-metric-label">PR rate</p>
      <p class="insight-metric-value">${m.pr_rate_pct != null ? m.pr_rate_pct + "%" : "—"}</p>
      <p class="insight-metric-hint">${m.total_prs ?? 0} PRs · ${m.results_with_time ?? 0} timed results</p>
    </div>
    <div class="insight-metric">
      <p class="insight-metric-label">Group median finish</p>
      <p class="insight-metric-value time-mono">${escapeHtml(m.median_finish_display || "—")}</p>
      <p class="insight-metric-hint">${m.avg_finish_display ? "Avg " + escapeHtml(m.avg_finish_display) : "Need chip/gun times"}</p>
    </div>`;

  const insights = report.insights || [];
  if (!insights.length) {
    listEl.innerHTML = `<li class="insight-item">Add races, registrations, and results to unlock deeper insights.</li>`;
    return;
  }
  listEl.innerHTML = insights
    .map((text) => `<li class="insight-item">${escapeHtml(text)}</li>`)
    .join("");
}

function renderDashboard() {
  const upcoming = sortMarathons(state.marathons.filter((m) => !isPast(m)));
  const past = state.marathons.filter((m) => isPast(m));
  const registered = state.registrations.filter((r) => r.status === "registered").length;
  const completed = state.registrations.filter((r) => r.status === "completed").length;
  const withTimes = state.registrations.filter((r) => displayFinishTime(r)).length;

  renderInsights();
  renderLeaderboardChart(computeLeaderboard());

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
      const days = daysUntil(m);
      const when = days === 0 ? "Today!" : days === 1 ? "Tomorrow" : `In ${days} days`;
      return `
        <div class="list-item">
          <div class="list-item-main">
            <p class="list-item-title">${escapeHtml(m.name)}</p>
            <p class="list-item-sub">${formatRaceDateTime(m)} · ${escapeHtml(m.location || "TBD")} · ${escapeHtml(m.distance)}</p>
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

  startRaceTimer();
  renderWhosRunningChart();
}

function regsSortedForMarathon(marathonId) {
  return regsForMarathon(marathonId)
    .slice()
    .sort((a, b) =>
      (getRunner(a.runner_id)?.name || "").localeCompare(getRunner(b.runner_id)?.name || "")
    );
}

function whosRunningTooltipHtml(marathonId) {
  const marathon = getMarathon(marathonId);
  const regs = regsSortedForMarathon(marathonId);
  if (!marathon) return "";
  if (!regs.length) {
    return `
      <p class="wr-tip-title">${escapeHtml(marathon.name)}</p>
      <p class="wr-tip-empty">No one registered yet</p>`;
  }
  const names = regs
    .map((r) => {
      const runner = getRunner(r.runner_id);
      return `<li>${escapeHtml(runner?.name || "Unknown")} <span class="wr-tip-status">${escapeHtml(statusLabel(r.status))}</span></li>`;
    })
    .join("");
  return `
    <p class="wr-tip-title">${escapeHtml(marathon.name)}</p>
    <p class="wr-tip-meta">${regs.length} registered</p>
    <ul class="wr-tip-list">${names}</ul>`;
}

/**
 * Interactive bar chart: registration counts per race.
 * Hover a bar to see who is signed up; click to pin the list below.
 */
function renderWhosRunningChart() {
  const wrap = document.getElementById("matrix-wrap");
  if (!wrap) return;

  const marathons = sortMarathons(state.marathons);
  if (!marathons.length) {
    wrap.innerHTML = `<div class="empty" style="border:none"><strong>No races yet</strong>Add marathons to see who's running what.</div>`;
    return;
  }

  const series = marathons.map((m, i) => {
    const regs = regsForMarathon(m.id);
    const byStatus = {};
    regs.forEach((r) => {
      byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    });
    return {
      marathon: m,
      count: regs.length,
      byStatus,
      color: AVATAR_COLORS[i % AVATAR_COLORS.length],
    };
  });

  if (selectedWhosRunningMarathonId && !series.some((s) => s.marathon.id === selectedWhosRunningMarathonId)) {
    selectedWhosRunningMarathonId = null;
  }
  // Default select next upcoming race with signups, else first with count, else first
  if (!selectedWhosRunningMarathonId) {
    const upcoming = series.find((s) => !isPast(s.marathon) && s.count > 0)
      || series.find((s) => s.count > 0)
      || series[0];
    selectedWhosRunningMarathonId = upcoming?.marathon.id || null;
  }

  const max = Math.max(...series.map((s) => s.count), 1);
  const barW = 42;
  const gap = 16;
  const padL = 36;
  const padR = 20;
  const padT = 28;
  const padB = 56;
  const chartH = 170;
  const width = Math.max(320, padL + padR + series.length * (barW + gap) - gap);
  const height = padT + chartH + padB;

  const bars = series.map((s, i) => {
    const h = s.count === 0 ? 4 : Math.max(8, Math.round((s.count / max) * chartH));
    const x = padL + i * (barW + gap);
    const y = padT + chartH - h;
    const selected = s.marathon.id === selectedWhosRunningMarathonId;
    const label = s.marathon.name.length > 11 ? `${s.marathon.name.slice(0, 10)}…` : s.marathon.name;
    const dateShort = String(s.marathon.race_date).slice(5);
    return `
      <g class="wr-bar-group${selected ? " is-selected" : ""}" data-marathon-id="${s.marathon.id}" role="button" tabindex="0" style="cursor:pointer">
        <rect class="wr-bar-hit" x="${x - 6}" y="${padT}" width="${barW + 12}" height="${chartH + padB - 8}" fill="transparent"></rect>
        <rect class="wr-bar" x="${x}" y="${y}" width="${barW}" height="${h}" rx="9"
          fill="${s.color}" opacity="${selected ? "1" : "0.72"}"></rect>
        <text class="wr-value" x="${x + barW / 2}" y="${y - 8}" text-anchor="middle">${s.count}</text>
        <text class="wr-label" x="${x + barW / 2}" y="${padT + chartH + 18}" text-anchor="middle">${escapeHtml(label)}</text>
        <text class="wr-date" x="${x + barW / 2}" y="${padT + chartH + 34}" text-anchor="middle">${escapeHtml(dateShort)}</text>
      </g>`;
  }).join("");

  const selected = series.find((s) => s.marathon.id === selectedWhosRunningMarathonId);
  const selectedRegs = selected ? regsSortedForMarathon(selected.marathon.id) : [];

  const detail = selected
    ? `
      <div class="wr-detail">
        <div class="wr-detail-head">
          <h4 class="wr-detail-title">${escapeHtml(selected.marathon.name)}</h4>
          <p class="panel-hint" style="margin:0">${formatRaceDateTime(selected.marathon)} · ${escapeHtml(selected.marathon.distance || "")} · ${selected.count} runner${selected.count === 1 ? "" : "s"}</p>
        </div>
        ${selectedRegs.length
          ? `<ul class="wr-runner-list">
              ${selectedRegs.map((r) => {
                const runner = getRunner(r.runner_id);
                const time = displayFinishTime(r);
                return `<li class="wr-runner-item">
                  ${renderProfileAvatar(runner, runner?.name || "?", r.runner_id)}
                  <span class="wr-runner-name" title="${escapeHtml(runner?.name || "")}">${escapeHtml(runner?.name || "Unknown")}</span>
                  ${statusBadge(r.status)}
                  ${time ? `<span class="time-mono wr-runner-time">${escapeHtml(time)}</span>` : ""}
                  ${r.is_pr ? `<span class="badge badge-pr">PR</span>` : ""}
                </li>`;
              }).join("")}
            </ul>`
          : `<div class="empty" style="border:none;padding:0.75rem 0"><strong>No one signed up yet</strong>Add registrations for this race.</div>`}
      </div>`
    : "";

  wrap.innerHTML = `
    <div class="whos-running-chart-area">
      <div class="leaderboard-chart-scroll">
        <svg class="whos-running-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Registrations by race bar chart">
          <line class="lb-axis" x1="${padL - 10}" y1="${padT + chartH}" x2="${width - padR}" y2="${padT + chartH}" />
          ${bars}
        </svg>
      </div>
      <div class="wr-hover-tip" id="wr-hover-tip" hidden></div>
    </div>
    ${detail}`;

  const tip = wrap.querySelector("#wr-hover-tip");
  const chartArea = wrap.querySelector(".whos-running-chart-area");

  const showTip = (marathonId, clientX, clientY) => {
    if (!tip || !chartArea) return;
    tip.innerHTML = whosRunningTooltipHtml(marathonId);
    tip.hidden = false;
    const areaRect = chartArea.getBoundingClientRect();
    const tipW = tip.offsetWidth || 220;
    const tipH = tip.offsetHeight || 120;
    let left = clientX - areaRect.left + 14;
    let top = clientY - areaRect.top + 14;
    if (left + tipW > areaRect.width - 8) left = Math.max(8, clientX - areaRect.left - tipW - 12);
    if (top + tipH > areaRect.height - 8) top = Math.max(8, clientY - areaRect.top - tipH - 8);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };

  const hideTip = () => {
    if (tip) tip.hidden = true;
  };

  wrap.querySelectorAll("[data-marathon-id]").forEach((g) => {
    const mid = g.getAttribute("data-marathon-id");
    const pick = () => {
      selectedWhosRunningMarathonId = mid;
      hideTip();
      renderWhosRunningChart();
    };
    g.addEventListener("click", pick);
    g.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        pick();
      }
    });
    g.addEventListener("mouseenter", (e) => showTip(mid, e.clientX, e.clientY));
    g.addEventListener("mousemove", (e) => showTip(mid, e.clientX, e.clientY));
    g.addEventListener("mouseleave", hideTip);
    g.addEventListener("focus", () => {
      const rect = g.getBoundingClientRect();
      showTip(mid, rect.left + rect.width / 2, rect.top);
    });
    g.addEventListener("blur", hideTip);
  });
}

function renderMarathons() {
  const q = (document.getElementById("marathon-search")?.value || "").trim().toLowerCase();
  const filter = document.getElementById("marathon-filter-status")?.value || "all";
  let list = sortMarathons(state.marathons);
  if (filter === "upcoming") list = list.filter((m) => !isPast(m));
  if (filter === "past") list = list.filter((m) => isPast(m));
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
        ${renderMarathonImage(m)}
        <div style="display:flex;justify-content:space-between;gap:0.5rem;margin-top:0.75rem">
          <h3 class="card-title">${escapeHtml(m.name)}</h3>
          <span class="badge badge-distance">${escapeHtml(m.distance)}</span>
        </div>
        <div class="card-meta">
          <span>📅 ${formatRaceDateTime(m)}${isPast(m) ? " · past" : ""}</span>
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
    const linked = m.user_id ? team.find((t) => t.user_id === m.user_id) : null;
    const photo = (m.image_url || profileImageUrl(linked?.profile) || "").trim();
    const avatarSrc = { image_url: photo };
    return `
      <article class="card">
        <div class="member-head">
          <div class="runner-avatar-wrap">
            ${renderProfileAvatar(avatarSrc, m.name, m.id)}
          </div>
          <div class="member-head-text">
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
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty" style="border:none;margin:0.5rem"><strong>No registrations</strong></div></td></tr>`;
    return;
  }
  tbody.innerHTML = list.map((r) => {
    const runner = getRunner(r.runner_id);
    const marathon = getMarathon(r.marathon_id);
    const delBtn = canDelete()
      ? `<button class="btn btn-danger btn-sm" data-action="delete" data-id="${r.id}">Delete</button>`
      : "";
    return `
      <tr>
        <td>${escapeHtml(runner?.name || "Unknown")}</td>
        <td>${escapeHtml(marathon?.name || "Unknown")}</td>
        <td>${marathon ? formatDate(marathon.race_date) : "—"}</td>
        <td>${statusBadge(r.status)}</td>
        <td>${r.bib ? `<strong>#${escapeHtml(r.bib)}</strong>` : "—"}</td>
        <td>${escapeHtml(r.notes || "—")}</td>
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
        <td><div class="member-head" style="gap:0.6rem;justify-content:flex-start;min-width:0">
          ${renderProfileAvatar(runner, runner?.name || "Unknown", runner?.id || r.runner_id)}
          <span>${escapeHtml(runner?.name || "Unknown")}</span>
        </div></td>
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
    btn.addEventListener("click", () => openResultForm(btn.dataset.id));
  });
}

function renderProfile() {
  if (!profile && !session) return;
  const name = profile?.display_name || session.user.user_metadata?.display_name || "";
  const email = profile?.email || session.user.email || "";
  const image = profileImageUrl(profile);
  document.getElementById("profile-name").value = name;
  document.getElementById("profile-email").value = email;
  document.getElementById("profile-image-url").value = image;
  document.getElementById("profile-password").value = "";
  document.getElementById("profile-password-confirm").value = "";
  document.getElementById("profile-error").hidden = true;
  const preview = document.getElementById("profile-preview");
  if (preview) {
    preview.innerHTML = `
      ${renderProfileAvatar({ image_url: image }, name || "You", session.user.id)}
      <div>
        <p class="list-item-title" style="margin:0">${escapeHtml(name || "You")}</p>
        <p class="panel-hint" style="margin:0.15rem 0 0">${escapeHtml(email)}</p>
      </div>`;
  }
}

function renderTeam() {
  const createPanel = document.getElementById("create-user-panel");
  if (createPanel) {
    createPanel.hidden = !canCreateUsers();
  }
  const newUserRole = document.getElementById("new-user-role");
  if (newUserRole) {
    newUserRole.querySelectorAll('option:not([value="member"])').forEach((option) => {
      option.hidden = !canManageRoles();
    });
    if (!canManageRoles()) newUserRole.value = "member";
  }

  const logoPanel = document.getElementById("logo-panel");
  if (logoPanel) {
    logoPanel.hidden = !canManageRoles();
    if (canManageRoles()) {
      const logoInput = document.getElementById("group-logo-url");
      if (logoInput && document.activeElement !== logoInput) {
        logoInput.value = group?.logo_url || "";
      }
      const preview = document.querySelector("[data-brand-logo-preview]");
      if (preview) preview.innerHTML = brandLogoHtml(logoInput?.value || group?.logo_url || "");
    }
  }

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
            <label for="m-time">Start time *</label>
            <input class="input" type="time" id="m-time" required value="${escapeHtml(formatRaceTime(existing?.race_time || "09:00"))}" />
            <p class="panel-hint" style="margin:0.35rem 0 0">Countdown on the dashboard targets this time.</p>
          </div>
        </div>
        <div class="field">
          <label for="m-distance">Distance</label>
          <select class="select full" id="m-distance">${distanceOptions}</select>
        </div>
        <div class="field">
          <label for="m-location">Location</label>
          <input class="input" id="m-location" value="${escapeHtml(existing?.location || "")}" />
        </div>
        <div class="field">
          <label for="m-image-url">Image URL</label>
          <input class="input" id="m-image-url" placeholder="https://..." value="${escapeHtml(existing?.image_url || "")}" />
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
        const raceTimeRaw = document.getElementById("m-time").value.trim();
        const payload = {
          group_id: group.id,
          name: document.getElementById("m-name").value.trim(),
          race_date: document.getElementById("m-date").value,
          race_time: formatRaceTime(raceTimeRaw || "09:00"),
          location: document.getElementById("m-location").value.trim(),
          image_url: document.getElementById("m-image-url").value.trim(),
          distance: document.getElementById("m-distance").value,
          notes: document.getElementById("m-notes").value.trim(),
          created_by: session.user.id,
        };
        if (!payload.name || !payload.race_date) return toast("Name and date required", "error");
        if (!raceTimeRaw) return toast("Start time required", "error");
        try {
          if (existing) {
            const { error } = await sb.from("marathons").update(payload).eq("id", existing.id);
            if (error) {
              if (/race_time|column/i.test(error.message || "")) {
                throw new Error("Run SQL to add marathons.race_time (see add-image-url-columns.sql), then try again.");
              }
              throw error;
            }
          } else {
            const { error } = await sb.from("marathons").insert(payload);
            if (error) {
              if (/race_time|column/i.test(error.message || "")) {
                throw new Error("Run SQL to add marathons.race_time (see add-image-url-columns.sql), then try again.");
              }
              throw error;
            }
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
  if (!existing && !canAddRunners()) {
    return toast("Only moderators and admins can add runners", "error");
  }
  openModal({
    title: existing ? "Edit runner" : "Add runner",
    bodyHtml: `
      <form class="form-grid">
        ${!existing ? `<p class="panel-hint" style="margin:0 0 1rem">Runners are synced with app users. Create a user first from Team &amp; access, then they appear here automatically.</p>` : ""}
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
          <label for="p-image-url">Image URL</label>
          <input class="input" id="p-image-url" type="url" placeholder="https://… (optional)" value="${escapeHtml(existing?.image_url || "")}" />
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
          image_url: document.getElementById("p-image-url").value.trim(),
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
  // Registration form: entry statuses only (results use openResultForm)
  const regStatuses = STATUSES.filter((s) =>
    ["interested", "registered", "waitlisted"].includes(s.value)
    || (existing && existing.status === s.value)
  );
  const defaultStatus = existing?.status || defaults.status || "registered";

  const runnerOpts = sortRunners(state.runners)
    .map((m) => `<option value="${m.id}" ${(existing?.runner_id || defaults.runnerId) === m.id ? "selected" : ""}>${escapeHtml(m.name)}</option>`)
    .join("");
  const marathonOpts = sortMarathons(state.marathons)
    .map((m) => `<option value="${m.id}" ${(existing?.marathon_id || defaults.marathonId) === m.id ? "selected" : ""}>${escapeHtml(m.name)} (${escapeHtml(m.race_date)})</option>`)
    .join("");
  const statusOpts = regStatuses.map(
    (s) => `<option value="${s.value}" ${defaultStatus === s.value ? "selected" : ""}>${s.label}</option>`
  ).join("");

  openModal({
    title: existing ? "Edit registration" : "Add registration",
    bodyHtml: `
      <form class="form-grid">
        <p class="panel-hint" style="margin:0">Sign someone up for a race. Finish times are entered under <strong>Results &amp; times</strong> after they are registered.</p>
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
        <div class="field">
          <label for="r-notes">Notes</label>
          <textarea class="textarea" id="r-notes">${escapeHtml(existing?.notes || "")}</textarea>
        </div>
      </form>`,
    footerHtml: `
      <button class="btn btn-ghost" id="rf-cancel">Cancel</button>
      <button class="btn btn-primary" id="rf-save">Save</button>`,
    onMount() {
      document.getElementById("rf-cancel").onclick = closeModal;
      document.getElementById("rf-save").onclick = async () => {
        const payload = {
          group_id: group.id,
          runner_id: document.getElementById("r-runner").value,
          marathon_id: document.getElementById("r-marathon").value,
          status: document.getElementById("r-status").value,
          bib: document.getElementById("r-bib").value.trim(),
          notes: document.getElementById("r-notes").value.trim(),
          created_by: session.user.id,
        };
        if (!payload.runner_id || !payload.marathon_id) {
          return toast("Runner and marathon are required", "error");
        }

        try {
          if (existing) {
            const { error } = await sb.from("registrations").update(payload).eq("id", existing.id);
            if (error) throw error;
          } else {
            const { error } = await sb.from("registrations").insert(payload);
            if (error) throw error;
          }
          closeModal();
          toast("Registration saved");
          await loadGroupData();
          render();
        } catch (e) {
          toast(errMsg(e), "error");
        }
      };
    },
  });
}

/**
 * Enter / edit race results. Only works for runners already registered for the race.
 */
function openResultForm(registrationId, defaults = {}) {
  if (!canWrite()) return toast("No permission", "error");
  if (!state.marathons.length) return toast("Add a marathon first", "error");

  const existing = registrationId
    ? state.registrations.find((r) => r.id === registrationId)
    : null;

  const registeredEntries = state.registrations.filter((r) =>
    ["interested", "registered", "waitlisted", "completed", "dns", "dnf"].includes(r.status)
  );
  if (!existing && !registeredEntries.length) {
    return toast("Register runners for a race first, then enter results", "error");
  }

  const resultStatuses = STATUSES.filter((s) =>
    ["completed", "dns", "dnf", "registered"].includes(s.value)
  );
  const defaultStatus = existing?.status === "interested" || existing?.status === "waitlisted"
    ? "completed"
    : existing?.status || "completed";

  const marathonOpts = sortMarathons(state.marathons)
    .map((m) => {
      const selected = (existing?.marathon_id || defaults.marathonId) === m.id;
      return `<option value="${m.id}" ${selected ? "selected" : ""}>${escapeHtml(m.name)} (${escapeHtml(m.race_date)})</option>`;
    })
    .join("");

  openModal({
    title: existing ? "Edit result" : "Enter result",
    wide: true,
    bodyHtml: `
      <form class="form-grid">
        <p class="panel-hint" style="margin:0">Results can only be added for runners who are already registered for the race.</p>
        <div class="field">
          <label for="res-marathon">Marathon *</label>
          <select class="select full" id="res-marathon" ${existing ? "disabled" : ""}>${marathonOpts}</select>
        </div>
        <div class="field">
          <label for="res-reg">Registered runner *</label>
          <select class="select full" id="res-reg" ${existing ? "disabled" : ""}></select>
        </div>
        <div class="field">
          <label for="res-status">Status</label>
          <select class="select full" id="res-status">
            ${resultStatuses.map((s) => `<option value="${s.value}" ${defaultStatus === s.value ? "selected" : ""}>${s.label}</option>`).join("")}
          </select>
        </div>
        <p class="form-section-title">Times &amp; places</p>
        <div class="form-row">
          <div class="field">
            <label for="res-gun">Gun time</label>
            <input class="input" id="res-gun" value="${escapeHtml(existing?.gun_time || "")}" placeholder="3:45:12" />
          </div>
          <div class="field">
            <label for="res-chip">Chip / net time</label>
            <input class="input" id="res-chip" value="${escapeHtml(existing?.chip_time || "")}" placeholder="3:44:50" />
          </div>
        </div>
        <div class="pace-preview" id="res-pace-preview"></div>
        <div class="form-row">
          <div class="field">
            <label for="res-place">Overall place</label>
            <input class="input" id="res-place" value="${escapeHtml(existing?.place_overall || "")}" />
          </div>
          <div class="field">
            <label for="res-place-g">Gender place</label>
            <input class="input" id="res-place-g" value="${escapeHtml(existing?.place_gender || "")}" />
          </div>
        </div>
        <div class="form-row">
          <div class="field">
            <label for="res-place-ag">Age group place</label>
            <input class="input" id="res-place-ag" value="${escapeHtml(existing?.place_age_group || "")}" />
          </div>
          <div class="field" style="display:flex;align-items:flex-end;padding-bottom:0.35rem">
            <label class="check-inline">
              <input type="checkbox" id="res-pr" ${existing?.is_pr ? "checked" : ""} />
              Personal record (PR)
            </label>
          </div>
        </div>
        <div class="field">
          <label for="res-notes">Result notes</label>
          <textarea class="textarea" id="res-notes">${escapeHtml(existing?.result_notes || "")}</textarea>
        </div>
      </form>`,
    footerHtml: `
      <button class="btn btn-ghost" id="res-cancel">Cancel</button>
      <button class="btn btn-primary" id="res-save">Save result</button>`,
    onMount() {
      const marathonSel = document.getElementById("res-marathon");
      const regSel = document.getElementById("res-reg");

      const fillRunners = () => {
        const mid = marathonSel.value;
        const regs = state.registrations
          .filter((r) => r.marathon_id === mid)
          .sort((a, b) =>
            (getRunner(a.runner_id)?.name || "").localeCompare(getRunner(b.runner_id)?.name || "")
          );
        if (!regs.length) {
          regSel.innerHTML = `<option value="">No registered runners for this race</option>`;
          return;
        }
        const prefer = existing?.id || defaults.registrationId || "";
        regSel.innerHTML = regs.map((r) => {
          const runner = getRunner(r.runner_id);
          const hasTime = displayFinishTime(r) ? " · has time" : "";
          return `<option value="${r.id}" ${r.id === prefer ? "selected" : ""}>${escapeHtml(runner?.name || "Runner")}${hasTime}</option>`;
        }).join("");
      };

      fillRunners();
      if (!existing) marathonSel.addEventListener("change", fillRunners);

      const updatePace = () => {
        const reg = state.registrations.find((r) => r.id === regSel.value) || existing;
        const marathon = getMarathon(marathonSel.value || reg?.marathon_id);
        const pace = paceForRegistration(
          { chip_time: document.getElementById("res-chip").value, gun_time: document.getElementById("res-gun").value },
          marathon
        );
        document.getElementById("res-pace-preview").textContent = pace ? `Pace: ${pace.label}` : "";
      };
      ["res-chip", "res-gun", "res-marathon", "res-reg"].forEach((id) => {
        const el = document.getElementById(id);
        el?.addEventListener("input", updatePace);
        el?.addEventListener("change", updatePace);
      });
      updatePace();

      document.getElementById("res-cancel").onclick = closeModal;
      document.getElementById("res-save").onclick = async () => {
        const regId = existing?.id || regSel.value;
        if (!regId) return toast("Pick a registered runner", "error");
        const reg = state.registrations.find((r) => r.id === regId);
        if (!reg) return toast("Registration not found — register the runner first", "error");

        const gunRaw = document.getElementById("res-gun").value;
        const chipRaw = document.getElementById("res-chip").value;
        if (gunRaw.trim() && parseTimeToSeconds(gunRaw) == null) {
          return toast("Gun time format not recognized", "error");
        }
        if (chipRaw.trim() && parseTimeToSeconds(chipRaw) == null) {
          return toast("Chip time format not recognized", "error");
        }

        let status = document.getElementById("res-status").value;
        const gun_time = normalizeTimeInput(gunRaw);
        const chip_time = normalizeTimeInput(chipRaw);
        if ((gun_time || chip_time) && status !== "dnf" && status !== "dns") status = "completed";

        const payload = {
          status,
          gun_time,
          chip_time,
          place_overall: document.getElementById("res-place").value.trim(),
          place_gender: document.getElementById("res-place-g").value.trim(),
          place_age_group: document.getElementById("res-place-ag").value.trim(),
          is_pr: document.getElementById("res-pr").checked,
          result_notes: document.getElementById("res-notes").value.trim(),
        };

        try {
          const { error } = await sb.from("registrations").update(payload).eq("id", regId);
          if (error) throw error;
          closeModal();
          toast("Result saved");
          await loadGroupData();
          render();
        } catch (e) {
          toast(errMsg(e), "error");
        }
      };
    },
  });
}

async function saveProfile() {
  const name = document.getElementById("profile-name").value.trim();
  const imageUrl = document.getElementById("profile-image-url").value.trim();
  const newPass = document.getElementById("profile-password").value;
  const confirmPass = document.getElementById("profile-password-confirm").value;
  const errEl = document.getElementById("profile-error");
  errEl.hidden = true;

  if (!name) throw new Error("Display name is required");
  if (newPass || confirmPass) {
    if (newPass.length < 6) throw new Error("Password must be at least 6 characters");
    if (newPass !== confirmPass) throw new Error("Passwords do not match");
  }

  const { error: pErr } = await sb
    .from("profiles")
    .update({
      display_name: name,
      profile_picture_url: imageUrl,
      email: session.user.email,
    })
    .eq("id", session.user.id);
  if (pErr) throw pErr;

  const authPayload = {
    data: {
      display_name: name,
      profile_picture_url: imageUrl,
    },
  };
  if (newPass) {
    authPayload.password = newPass;
    authPayload.data.must_change_password = false;
  }
  const { error: aErr } = await sb.auth.updateUser(authPayload);
  if (aErr) throw aErr;

  if (newPass) {
    try {
      await sb.from("profiles").update({ must_change_password: false }).eq("id", session.user.id);
    } catch (_) {
      /* ignore */
    }
  }

  profile = {
    ...(profile || {}),
    id: session.user.id,
    display_name: name,
    profile_picture_url: imageUrl,
    email: session.user.email,
    must_change_password: newPass ? false : profile?.must_change_password,
  };

  // Keep linked runner in sync (member = runner)
  const linked = getRunnerForUser(session.user.id);
  if (linked) {
    await sb
      .from("runners")
      .update({
        name,
        image_url: imageUrl,
        email: session.user.email || linked.email || "",
      })
      .eq("id", linked.id);
  } else if (group?.id) {
    try {
      await createRunnerForMember({
        userId: session.user.id,
        name,
        email: session.user.email,
        imageUrl,
      });
    } catch (_) {
      /* ignore */
    }
  }

  updateUserChrome();
  await loadGroupData();
  render();
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
  const signinForm = document.getElementById("form-signin");
  if (signinForm) {
    signinForm.addEventListener("submit", async (e) => {
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
  }

  const createGroupForm = document.getElementById("form-create-group");
  if (createGroupForm) {
    createGroupForm.addEventListener("submit", async (e) => {
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
  }

  const createUserForm = document.getElementById("form-create-user");
  if (createUserForm) {
    createUserForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!canCreateUsers()) return toast("Only moderators and admins can create users", "error");
      const errEl = document.getElementById("create-user-error");
      const btn = document.getElementById("btn-create-user");
      errEl.hidden = true;
      btn.disabled = true;
      try {
        const email = document.getElementById("new-user-email").value.trim();
        await adminCreateUser({
          email,
          password: document.getElementById("new-user-password").value,
          displayName: document.getElementById("new-user-name").value.trim(),
          role: document.getElementById("new-user-role").value,
        });
        createUserForm.reset();
        document.getElementById("new-user-role").value = "member";
        toast(`User created and added to the roster — ${email} must set a new password on first sign-in`);
        await loadGroupData();
        renderTeam();
      } catch (err) {
        errEl.textContent = errMsg(err);
        errEl.hidden = false;
      } finally {
        btn.disabled = false;
      }
    });
  }

  const signoutButton = document.getElementById("btn-signout");
  if (signoutButton) signoutButton.onclick = () => signOut();

  const onboardSignoutButton = document.getElementById("btn-signout-onboard");
  if (onboardSignoutButton) onboardSignoutButton.onclick = () => signOut();

  const profileBtn = document.getElementById("btn-profile");
  if (profileBtn) profileBtn.onclick = () => setView("profile");

  const passwordGateForm = document.getElementById("form-password-gate");
  if (passwordGateForm) {
    passwordGateForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const errEl = document.getElementById("password-gate-error");
      const btn = document.getElementById("btn-password-gate");
      errEl.hidden = true;
      btn.disabled = true;
      try {
        const pass = document.getElementById("gate-password").value;
        const confirm = document.getElementById("gate-password-confirm").value;
        if (pass.length < 6) throw new Error("Password must be at least 6 characters");
        if (pass !== confirm) throw new Error("Passwords do not match");
        await completePasswordGate(pass);
        toast("Password updated");
      } catch (err) {
        errEl.textContent = errMsg(err);
        errEl.hidden = false;
      } finally {
        btn.disabled = false;
      }
    });
  }
  const gateSignout = document.getElementById("btn-signout-password-gate");
  if (gateSignout) gateSignout.onclick = () => signOut();

  const logoForm = document.getElementById("form-group-logo");
  if (logoForm) {
    logoForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const errEl = document.getElementById("logo-error");
      errEl.hidden = true;
      try {
        await saveGroupLogo(document.getElementById("group-logo-url").value);
        toast("Logo saved");
        renderTeam();
      } catch (err) {
        errEl.textContent = errMsg(err);
        errEl.hidden = false;
      }
    });
    document.getElementById("btn-clear-logo")?.addEventListener("click", async () => {
      const errEl = document.getElementById("logo-error");
      errEl.hidden = true;
      try {
        document.getElementById("group-logo-url").value = "";
        await saveGroupLogo("");
        toast("Default logo restored");
        renderTeam();
      } catch (err) {
        errEl.textContent = errMsg(err);
        errEl.hidden = false;
      }
    });
    document.getElementById("group-logo-url")?.addEventListener("input", (e) => {
      const preview = document.querySelector("[data-brand-logo-preview]");
      if (preview) preview.innerHTML = brandLogoHtml(e.target.value);
    });
  }

  const profileForm = document.getElementById("form-profile");
  if (profileForm) {
    profileForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const errEl = document.getElementById("profile-error");
      const btn = document.getElementById("btn-save-profile");
      errEl.hidden = true;
      btn.disabled = true;
      try {
        await saveProfile();
        toast("Profile saved");
        document.getElementById("profile-password").value = "";
        document.getElementById("profile-password-confirm").value = "";
      } catch (err) {
        errEl.textContent = errMsg(err);
        errEl.hidden = false;
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById("profile-image-url")?.addEventListener("input", () => {
      const name = document.getElementById("profile-name")?.value || "You";
      const image = document.getElementById("profile-image-url")?.value || "";
      const preview = document.getElementById("profile-preview");
      if (preview) {
        preview.innerHTML = `
          ${renderProfileAvatar({ image_url: image }, name, session?.user?.id)}
          <div>
            <p class="list-item-title" style="margin:0">${escapeHtml(name)}</p>
            <p class="panel-hint" style="margin:0.15rem 0 0">${escapeHtml(document.getElementById("profile-email")?.value || "")}</p>
          </div>`;
      }
    });
  }
}

function wireAppUi() {
  setSidebarCollapsed(isSidebarCollapsed());
  document.getElementById("btn-sidebar-toggle")?.addEventListener("click", toggleSidebar);
  document.getElementById("btn-sidebar-toggle-mobile")?.addEventListener("click", toggleSidebar);

  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => setView(btn.dataset.view));
  });
  document.getElementById("modal-close").onclick = closeModal;
  const modalBackdrop = document.getElementById("modal-backdrop");
  if (modalBackdrop) {
    modalBackdrop.addEventListener("click", (e) => {
      if (e.target.id === "modal-backdrop") closeModal();
    });
  }
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
