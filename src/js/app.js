import { createLeaderboardFeature } from "./features/leaderboard/leaderboard.js";

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

function normalizeDistanceLabel(value) {
  const raw = String(value || "Other").trim().toLowerCase().replace(/[\s-]+/g, "");
  if (["5k", "5km"].includes(raw)) return "5K";
  if (["7.5k", "7.5km"].includes(raw)) return "7.5K";
  if (["10k", "10km"].includes(raw)) return "10K";
  if (["15k", "15km"].includes(raw)) return "15K";
  if (["half", "halfmarathon", "21k", "21.1k", "21km", "21.1km"].includes(raw)) return "Half Marathon";
  if (["marathon", "fullmarathon", "42k", "42.2k", "42km", "42.2km"].includes(raw)) return "Marathon";
  return String(value || "Other").trim() || "Other";
}

function getDistanceKmValue(distance) {
  const normalized = normalizeDistanceLabel(distance);
  if (DISTANCE_KM[normalized] != null) return DISTANCE_KM[normalized];
  const configured = (state.groupDistances || []).find((item) => normalizeDistanceLabel(item.label) === normalized || item.label === distance);
  return configured ? Number(configured.distance_km) : null;
}

function configuredDistanceOptions(current = "") {
  const labels = [...new Set([
    ...DISTANCES,
    ...(state.groupDistances || []).map((item) => item.label),
    current,
  ].filter(Boolean))];
  return labels.map((label) => `<option value="${escapeHtml(label)}" ${label === current ? "selected" : ""}>${escapeHtml(label)}</option>`).join("");
}

function registrationDistance(reg, marathon) {
  return normalizeDistanceLabel(reg?.race_distance || marathon?.distance || "Other");
}

const AVATAR_COLORS = [
  "#ff6b4a", "#2dd4bf", "#60a5fa", "#fbbf24",
  "#c084fc", "#4ade80", "#f472b6", "#38bdf8",
];

const VIEW_META = {
  dashboard: { title: "Dashboard", desc: "Live overview of races and results" },
  marathons: { title: "Marathons", desc: "Races the group is tracking" },
  members: { title: "Runners", desc: "People in the running roster (one per app member)" },
  leaderboard: { title: "Leaderboard", desc: "Full rankings for speed and contribution" },
  registrations: { title: "Registrations", desc: "Who is signed up for which race" },
  results: { title: "Results & Times", desc: "Finish times for registered runners only" },
  certificates: { title: "Certificates", desc: "Upload and view certificates for logged results" },
  team: { title: "Team & Access", desc: "Create users, logo, roles, and permissions" },
  notifications: { title: "Notifications", desc: "Configure notification channels and reminder cadence" },
  community: { title: "Community", desc: "Group board for topics, tips, and race-day chat" },
  profile: { title: "My Profile", desc: "Photo, display name, and password" },
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
  notifications: [],
  unreadCount: 0,
  personalRecords: [],
  runnerBadges: [],
  groupDistances: [],
  notificationSettings: null,
  notificationSchedules: [],
  communityPosts: [],
};

const leaderboardFeature = createLeaderboardFeature({
  getState: () => state,
  getRunner,
  getMarathon,
  getDistanceKm: (distance) => getDistanceKmValue(distance),
  bestFinishSeconds,
  displayFinishTime,
  formatSeconds,
  renderProfileAvatar,
  escapeHtml,
});

let currentView = "dashboard";
let activeProfileTab = "overview";
let channels = [];
let suppressToast = false;
let raceTimerId = null;
let selectedWhosRunningMarathonId = null;
let selectedCommunityTopicId = null;
let activeCommunityTab = "announcements";
let communityUnavailable = false;
/** Prevent concurrent enterApp / dual auth handlers from double-subscribing Realtime */
let enterAppInFlight = null;
let lastHandledSessionUserId = null;
const SIDEBAR_COLLAPSED_KEY = "pacepack_sidebar_collapsed";
const BRAND_CACHE_KEY = "pacepack_brand_cache";

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

function canEdit() {
  return hasMinRole("moderator");
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

/** Only allow http/https URLs to prevent javascript: or data: schemes in href. */
function safeUrl(url) {
  const u = String(url || "").trim();
  if (!u) return "";
  return /^https?:\/\//i.test(u) ? u : "";
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

function computePersonalRecord(reg, marathon) {
  const seconds = bestFinishSeconds(reg);
  if (seconds == null || !marathon) return false;
  const distance = registrationDistance(reg, marathon);
  const previousTimes = state.registrations
    .filter((r) => r.id !== reg.id && r.runner_id === reg.runner_id)
    .map((r) => {
      const m = getMarathon(r.marathon_id);
      if (!m || registrationDistance(r, m) !== distance) return null;
      return bestFinishSeconds(r);
    })
    .filter((s) => s != null);

  if (!previousTimes.length) return true;
  const bestPrevious = Math.min(...previousTimes);
  return seconds < bestPrevious;
}

function displayFinishTime(reg) {
  return reg.chip_time || reg.gun_time || "";
}

function paceForRegistration(reg, marathon, distanceOverride = "") {
  const seconds = bestFinishSeconds(reg);
  if (seconds == null || !marathon) return null;
  const km = getDistanceKmValue(distanceOverride || registrationDistance(reg, marathon));
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

async function syncRunnerProfileImage(runner, { imageUrl, name, email } = {}) {
  if (!runner?.id) return;

  const nextImage = (imageUrl ?? runner?.image_url ?? "").trim();
  const runnerPatch = {};
  if (runner.image_url !== nextImage) runnerPatch.image_url = nextImage;
  if (name != null && runner.name !== name) runnerPatch.name = name;
  if (email != null && runner.email !== email) runnerPatch.email = email;

  if (Object.keys(runnerPatch).length) {
    const { error } = await sb.from("runners").update(runnerPatch).eq("id", runner.id);
    if (error) throw error;
    Object.assign(runner, runnerPatch);
  }

  if (!runner.user_id) return;

  const profilePayload = { id: runner.user_id, profile_picture_url: nextImage };
  if (name != null) profilePayload.display_name = name;
  if (email != null) profilePayload.email = email;

  try {
    await sb.from("profiles").upsert(profilePayload).select().single();
  } catch (e) {
    console.warn("profile sync:", e);
  }

  if (runner.user_id === session?.user?.id) {
    const authPayload = { data: {} };
    if (name != null) authPayload.data.display_name = name;
    if (nextImage !== undefined) authPayload.data.profile_picture_url = nextImage;
    if (Object.keys(authPayload.data).length) {
      try {
        await sb.auth.updateUser(authPayload);
      } catch (e) {
        console.warn("auth profile sync:", e);
      }
    }
  }
}

function getMarathon(id) {
  return state.marathons.find((m) => m.id === id);
}

function regsForMarathon(id) {
  return state.registrations.filter((r) => r && r.marathon_id === id);
}

function regsForRunner(id) {
  return state.registrations.filter((r) => r && r.runner_id === id);
}

function canonicalPRRegistrations() {
  const bestByKey = new Map();
  const prIds = new Set();
  const rows = state.registrations
    .map((reg) => ({ reg, marathon: getMarathon(reg.marathon_id), seconds: bestFinishSeconds(reg) }))
    .filter((row) => row.marathon && row.seconds != null && (row.reg.status === "completed" || row.reg.status === "dnf" || displayFinishTime(row.reg)))
    .sort((a, b) => String(a.marathon.race_date || "9999-12-31").localeCompare(String(b.marathon.race_date || "9999-12-31")) || String(a.reg.id).localeCompare(String(b.reg.id)));
  rows.forEach(({ reg, marathon, seconds }) => {
    const key = `${reg.runner_id}:${registrationDistance(reg, marathon)}`;
    const previous = bestByKey.get(key);
    if (previous == null || seconds < previous) prIds.add(reg.id);
    if (previous == null || seconds < previous) bestByKey.set(key, Math.min(previous ?? seconds, seconds));
  });
  return prIds;
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

function setButtonBusy(button, pendingLabel) {
  if (!button) return () => {};
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = pendingLabel;
  return () => {
    button.disabled = false;
    button.textContent = originalLabel;
  };
}

function operationFailed(action, error) {
  toast(`${action} failed: ${errMsg(error)}`, "error");
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

function getBrandCache() {
  try {
    const raw = localStorage.getItem(BRAND_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

function setBrandCache(data) {
  try {
    localStorage.setItem(BRAND_CACHE_KEY, JSON.stringify(data || {}));
  } catch (_) {
    /* ignore */
  }
}

function clearBrandCache() {
  try {
    localStorage.removeItem(BRAND_CACHE_KEY);
  } catch (_) {
    /* ignore */
  }
}

function brandLogoHtml(url) {
  const src = (url || "").trim();
  if (src) {
    return `<img class="brand-logo-img" src="${escapeHtml(src)}" alt="" />`;
  }
  return DEFAULT_BRAND_SVG;
}

function logoMimeType(url) {
  const path = String(url || "").split(/[?#]/)[0].toLowerCase();
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".avif")) return "image/avif";
  return "image/png";
}

function updateFavicon(url) {
  const src = (url || "").trim();
  if (!src) return;
  
  // Update shortcut icon
  let shortcutIcon = document.querySelector('link[rel="shortcut icon"]');
  if (!shortcutIcon) {
    shortcutIcon = document.createElement('link');
    shortcutIcon.rel = 'shortcut icon';
    document.head.appendChild(shortcutIcon);
  }
  shortcutIcon.href = src;
  shortcutIcon.type = logoMimeType(src);
  
  // Update standard favicon
  let favicon = document.querySelector('link[rel="icon"]');
  if (!favicon) {
    favicon = document.createElement('link');
    favicon.rel = 'icon';
    document.head.appendChild(favicon);
  }
  favicon.href = src;
  favicon.type = logoMimeType(src);
  
  // Update apple-touch-icons to use group logo
  const appleIconSizes = ['48x48', '72x72', '96x96', '120x120', '144x144', '152x152', '167x167', '180x180', '192x192', '512x512'];
  appleIconSizes.forEach(size => {
    let appleIcon = document.querySelector(`link[rel="apple-touch-icon"][sizes="${size}"]`);
    if (!appleIcon) {
      appleIcon = document.createElement('link');
      appleIcon.rel = 'apple-touch-icon';
      appleIcon.setAttribute('sizes', size);
      document.head.appendChild(appleIcon);
    }
    appleIcon.href = src;
  });
}

function updateManifestIcons(url) {
  // The installable PWA manifest must remain the static manifest served from
  // /pacepack/manifest.webmanifest. Replacing it with a blob URL makes the
  // manifest origin opaque and causes browsers to reject start_url/scope.
  // updateFavicon() still applies the group logo to the browser chrome.
  void url;
}

function applyBrandLogo() {
  const cached = getBrandCache();
  const url = group?.logo_url || cached?.logo_url || "";
  const name = group?.name || cached?.group_name || "Impulsive Runners";
  document.querySelectorAll("[data-brand-logo]").forEach((el) => {
    el.innerHTML = brandLogoHtml(url);
  });
  const preview = document.querySelector("[data-brand-logo-preview]");
  if (preview) preview.innerHTML = brandLogoHtml(url);
  document.querySelectorAll("[data-brand-title]").forEach((el) => {
    el.textContent = name;
  });
  
  // Update favicon and PWA icons with group logo
  updateFavicon(url);
  updateManifestIcons(url);
}

function cacheBrandFromGroup(g) {
  setBrandCache({ logo_url: g?.logo_url || "", group_name: g?.name || "" });
}

/**
 * Fetch group branding (name + logo) without requiring auth.
 * Used by the boot/loading screen and sign-in page so the group logo shows
 * before a user logs in and stays fresh on every load.
 */
async function fetchGroupBranding() {
  if (!sb) return;
  try {
    const { data, error } = await sb.rpc("get_group_branding");
    if (error) {
      if (group) cacheBrandFromGroup(group);
      console.warn("fetch group branding:", error);
      applyBrandLogo();
      return;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (row) cacheBrandFromGroup(row);
    applyBrandLogo();
  } catch (e) {
    console.warn("fetch group branding:", e);
    applyBrandLogo();
  }
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

  const [m, r, reg, mem, pr, badges, notifSettings, notifSchedules] = await Promise.all([
    sb.from("marathons").select("*").eq("group_id", gid).order("race_date"),
    sb.from("runners").select("*").eq("group_id", gid).order("name"),
    sb.from("registrations").select("*").eq("group_id", gid),
    sb
      .from("group_memberships")
      .select("id, role, user_id, created_at")
      .eq("group_id", gid),
    sb.from("personal_records").select("*").eq("group_id", gid),
    sb.from("runner_badges").select("*").eq("group_id", gid),
    sb.from("group_notification_settings").select("*").eq("group_id", gid).maybeSingle(),
    sb.from("notification_schedules").select("*").eq("group_id", gid).order("channel").order("days_before"),
  ]);

  if (m.error) throw m.error;
  if (r.error) throw r.error;
  if (reg.error) throw reg.error;
  if (mem.error) throw mem.error;
  if (pr.error) throw pr.error;
  if (badges.error) throw badges.error;

  state.marathons = m.data || [];
  state.runners = r.data || [];
  state.registrations = reg.data || [];
  state.personalRecords = pr.data || [];
  state.runnerBadges = badges.data || [];
  const { data: distanceRows, error: distanceError } = await sb
    .from("group_distances")
    .select("id, label, distance_km")
    .eq("group_id", gid)
    .order("label");
  state.groupDistances = distanceError ? [] : (distanceRows || []);
  state.notificationSettings = notifSettings.data || null;
  state.notificationSchedules = notifSchedules.data || [];

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

  // Community board (soft-fail if schema not applied yet)
  await loadCommunityPosts();
}

/**
 * Remove a channel by short name or Realtime topic (`realtime:name`).
 * Safe to call even if the channel was already subscribed (avoids
 * "cannot add postgres_changes callbacks … after subscribe()").
 */
function removeChannelByName(name) {
  if (!sb || !name) return;
  try {
    const all = typeof sb.getChannels === "function" ? sb.getChannels() : [];
    for (const ch of all) {
      const topic = ch?.topic || "";
      if (
        topic === name ||
        topic === `realtime:${name}` ||
        topic.endsWith(`:${name}`)
      ) {
        try {
          sb.removeChannel(ch);
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
}

function unsubscribeAll() {
  // Prefer tracked list; also clear any leftover client channels (race / remount)
  channels.forEach((ch) => {
    try {
      sb.removeChannel(ch);
    } catch {
      /* ignore */
    }
  });
  channels = [];
  try {
    const all = typeof sb.getChannels === "function" ? sb.getChannels() : [];
    all.forEach((ch) => {
      const topic = ch?.topic || "";
      if (topic.includes("pp-") || topic.includes("realtime:pp-")) {
        try {
          sb.removeChannel(ch);
        } catch {
          /* ignore */
        }
      }
    });
  } catch {
    /* ignore */
  }
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

  ["marathons", "runners", "registrations", "group_memberships", "personal_records", "runner_badges", "group_notification_settings", "notification_schedules", "community_posts"].forEach((table) => {
    const name = `pp-${table}-${gid}`;
    removeChannelByName(name);
    const ch = sb
      .channel(name)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table, filter: `group_id=eq.${gid}` },
        () => onChange()
      )
      .subscribe();
    channels.push(ch);
  });

  const groupName = `pp-groups-${gid}`;
  removeChannelByName(groupName);
  const chGroup = sb
    .channel(groupName)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "groups", filter: `id=eq.${gid}` },
      async () => {
        const { data } = await sb.from("groups").select("*").eq("id", gid).single();
        if (data) {
          group = data;
          cacheBrandFromGroup(group);
          render();
        }
      }
    )
    .subscribe();
  channels.push(chGroup);

  // Notifications share the same lifecycle as group realtime (prevents orphan re-subscribe)
  subscribeNotificationsRealtime();
}

function subscribeNotificationsRealtime() {
  if (!session?.user?.id || !sb) return;
  const name = `pp-notifications-${session.user.id}`;

  // Drop any prior subscription with this name before attaching new callbacks
  removeChannelByName(name);
  channels = channels.filter((ch) => {
    const topic = ch?.topic || "";
    return !(
      topic === name ||
      topic === `realtime:${name}` ||
      topic.endsWith(`:${name}`)
    );
  });

  const ch = sb
    .channel(name)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "notifications",
        filter: `user_id=eq.${session.user.id}`,
      },
      (payload) => {
        const newNotif = payload.new;
        if (!newNotif) return;
        state.notifications.unshift(newNotif);
        if (state.notifications.length > 50) state.notifications.pop();
        if (!newNotif.is_read) {
          state.unreadCount += 1;
          renderNotificationBadge();
        }
        if (!document.getElementById("notification-panel")?.hidden) {
          renderNotificationPanel();
        }
      }
    )
    .subscribe((status, err) => {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.warn("notifications realtime:", status, err || "");
      }
    });
  channels.push(ch);
}

// ─── Auth actions ────────────────────────────────────────────────────────────

async function signIn(email, password) {
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

// ─── Notifications ────────────────────────────────────────────────────────────

async function loadNotifications() {
  if (!session?.user?.id || !group?.id) return;
  try {
    const { data, error } = await sb
      .from("notifications")
      .select("*")
      .eq("user_id", session.user.id)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    state.notifications = data || [];
    state.unreadCount = state.notifications.filter((n) => !n.is_read).length;
    renderNotificationBadge();
  } catch (e) {
    // Table may not exist yet (notifications-schema.sql not run) — ignore silently
    console.warn("load notifications:", e);
  }
}

function renderNotificationBadge() {
  const badge = document.getElementById("notification-count");
  if (!badge) return;
  if (state.unreadCount > 0) {
    badge.textContent = state.unreadCount > 99 ? "99+" : String(state.unreadCount);
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

function notificationIcon(type) {
  const icons = {
    new_marathon: "🏁",
    result_added: "⏱",
    race_reminder: "🔔",
  };
  return icons[type] || "📬";
}

function formatNotificationTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60000) return "Just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function renderNotificationPanel() {
  const list = document.getElementById("notification-list");
  if (!list) return;

  if (!state.notifications.length) {
    list.innerHTML = `<div class="notification-empty">No notifications yet</div>`;
    return;
  }

  list.innerHTML = state.notifications
    .map((n) => {
      const timeAgo = formatNotificationTime(n.created_at);
      return `
        <div class="notification-item${n.is_read ? "" : " unread"}" data-notif-id="${n.id}" data-type="${n.type}" data-data='${escapeHtml(JSON.stringify(n.data || {}))}'>
          <div class="notification-item-icon">${notificationIcon(n.type)}</div>
          <div class="notification-item-content">
            <p class="notification-item-title">${escapeHtml(n.title)}</p>
            ${n.body ? `<p class="notification-item-body">${escapeHtml(n.body)}</p>` : ""}
            <p class="notification-item-time">${escapeHtml(timeAgo)}</p>
          </div>
        </div>`;
    })
    .join("");

  // Click handler for each notification
  list.querySelectorAll(".notification-item").forEach((el) => {
    el.addEventListener("click", async () => {
      const id = el.dataset.notifId;
      const type = el.dataset.type;
      let data = {};
      try { data = JSON.parse(el.dataset.data); } catch {}

      // Mark as read when unread, then always allow navigation
      if (el.classList.contains("unread")) {
        try {
          await sb.from("notifications").update({ is_read: true }).eq("id", id);
          el.classList.remove("unread");
          const notif = state.notifications.find((n) => n.id === id);
          if (notif) notif.is_read = true;
          state.unreadCount = Math.max(0, state.unreadCount - 1);
          renderNotificationBadge();
        } catch (e) {
          console.warn("mark read:", e);
        }
      }

      hideNotificationPanel();

      // Navigate based on notification type
      if (type === "new_marathon" || type === "race_reminder") {
        const marathonId = data?.marathon_id;
        if (marathonId) {
          setView("marathons");
          // Highlight the marathon card
          setTimeout(() => {
            const card = document.querySelector(`[data-action="results"][data-id="${marathonId}"]`);
            if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
          }, 100);
        }
      } else if (type === "result_added") {
        const marathonId = data?.marathon_id;
        if (marathonId) {
          setView("results");
          setTimeout(() => {
            const sel = document.getElementById("results-marathon");
            if (sel) { sel.value = marathonId; renderResults(); }
          }, 100);
        }
      }
    });
  });
}

let notificationPanelOpen = false;

async function toggleNotificationPanel() {
  const panel = document.getElementById("notification-panel");
  if (!panel) return;
  if (panel.hidden) {
    // Re-fetch on open so the bell still works when Realtime is unavailable.
    await loadNotifications();
    renderNotificationPanel();
    panel.hidden = false;
    notificationPanelOpen = true;
    document.getElementById("btn-notifications")?.setAttribute("aria-expanded", "true");
  } else {
    hideNotificationPanel();
  }
}

function hideNotificationPanel() {
  const panel = document.getElementById("notification-panel");
  if (panel) panel.hidden = true;
  document.getElementById("btn-notifications")?.setAttribute("aria-expanded", "false");
  notificationPanelOpen = false;
}

async function markAllNotificationsRead() {
  if (!session?.user?.id || !state.notifications.length) return;
  try {
    const unreadIds = state.notifications.filter((n) => !n.is_read).map((n) => n.id);
    if (!unreadIds.length) return;
    const { error } = await sb
      .from("notifications")
      .update({ is_read: true })
      .in("id", unreadIds);
    if (error) throw error;
    state.notifications.forEach((n) => { n.is_read = true; });
    state.unreadCount = 0;
    renderNotificationBadge();
    renderNotificationPanel();
  } catch (e) {
    console.warn("mark all read:", e);
  }
}

// ─── Web Push subscription ────────────────────────────────────────────────────

async function ensurePushSubscriptionStored(sub) {
  if (!session?.user?.id || !group?.id || !sub) return;
  const p256dhKey = sub.getKey("p256dh");
  const authKey = sub.getKey("auth");
  if (!p256dhKey || !authKey) return;

  const { data: stored } = await sb
    .from("push_subscriptions")
    .select("id")
    .eq("endpoint", sub.endpoint)
    .maybeSingle();

  if (!stored) {
    await sb.from("push_subscriptions").insert({
      user_id: session.user.id,
      group_id: group.id,
      endpoint: sub.endpoint,
      p256dh: arrayBufferToBase64(p256dhKey),
      auth: arrayBufferToBase64(authKey),
    });
  }
}

async function subscribeToPushNotifications() {
  if (!session?.user?.id || !group?.id) return;
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  // Secure context required (HTTPS or localhost)
  if (!window.isSecureContext) return;

  try {
    // Permission: never force a prompt mid-load if denied; request only when default
    if (typeof Notification !== "undefined") {
      if (Notification.permission === "denied") return;
      if (Notification.permission === "default") {
        const perm = await Notification.requestPermission();
        if (perm !== "granted") return;
      }
    }

    // Wait for an active SW (registration alone is not enough for push)
    const reg = await navigator.serviceWorker.ready;
    if (!reg?.active || !reg?.pushManager) {
      console.info("Push notifications unavailable: service worker is not active");
      return;
    }

    let existing = null;
    try {
      existing = await reg.pushManager.getSubscription();
    } catch {
      existing = null;
    }

    if (existing) {
      try {
        await ensurePushSubscriptionStored(existing);
      } catch (e) {
        console.warn("push store existing:", e?.message || e);
      }
      return;
    }

    const vapidPublicKey = await fetchVapidPublicKey();
    if (!vapidPublicKey) return;

    let applicationServerKey;
    try {
      applicationServerKey = urlBase64ToUint8Array(vapidPublicKey);
      // Uncompressed P-256 public keys are 65 bytes (0x04 || x || y)
      if (applicationServerKey.byteLength !== 65 || applicationServerKey[0] !== 4) {
        console.warn(
          "push subscribe: invalid VAPID public key",
          `length=${applicationServerKey.byteLength}`
        );
        return;
      }
    } catch (e) {
      console.warn("push subscribe: invalid VAPID key", e?.message || e);
      return;
    }

    let subscription;
    try {
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
    } catch (subErr) {
      const name = subErr?.name || "";
      const msg = String(subErr?.message || subErr);
      if (name === "NotAllowedError") return;
      if (name === "AbortError" || /push service error|registration failed/i.test(msg)) {
        // This is a browser/vendor push-service failure, not an app failure.
        // Retrying or unsubscribing repeats the failure and can discard a
        // valid existing subscription, so leave the session untouched.
        console.info("Push notifications unavailable in this browser:", msg);
        return;
      }
      console.info("Push notifications unavailable:", msg);
      return;
    }

    try {
      await ensurePushSubscriptionStored(subscription);
      console.log("Push subscription saved");
    } catch (e) {
      console.warn("push store:", e?.message || e);
    }
  } catch (e) {
    // Optional feature — never surface as a hard app error
    console.info("Push notifications unavailable:", e?.message || e);
  }
}

async function fetchVapidPublicKey() {
  // 1) Optional override in config.js
  const fromConfig = (window.PACEPACK_CONFIG?.vapidPublicKey || "").trim();
  if (fromConfig) return fromConfig;

  try {
    const { data, error } = await sb.rpc("get_vapid_public_key");
    if (error) throw error;
    if (typeof data === "string" && data.trim()) return data.trim();
  } catch (e) {
    console.warn("get_vapid_public_key:", e?.message || e);
  }
  return null;
}

function urlBase64ToUint8Array(base64String) {
  const raw = String(base64String || "").trim();
  if (!raw) throw new Error("empty VAPID key");
  const padding = "=".repeat((4 - (raw.length % 4)) % 4);
  const base64 = (raw + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signOut() {
  stopRaceTimer();
  unsubscribeAll();
  await sb.auth.signOut();
  session = null;
  profile = null;
  group = null;
  myRole = null;
  state = { marathons: [], runners: [], registrations: [], notifications: [], unreadCount: 0, personalRecords: [], runnerBadges: [], groupDistances: [] };
  team = [];
  selectedWhosRunningMarathonId = null;
  applyBrandLogo();
  showScreen("auth");
  fetchGroupBranding();
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
    // Desktop chevron rotates via CSS (.app.sidebar-collapsed .sidebar-toggle-icon)
  });
}

function isMobileSidebarViewport() {
  return window.matchMedia?.("(max-width: 800px)")?.matches === true;
}

function setMobileSidebarOpen(open) {
  const shell = document.getElementById("app-shell");
  const backdrop = document.getElementById("sidebar-backdrop");
  if (!shell) return;
  shell.classList.toggle("mobile-sidebar-open", !!open);
  if (backdrop) backdrop.hidden = !open;
  document.body.classList.toggle("mobile-sidebar-open", !!open);
  const button = document.getElementById("btn-sidebar-toggle-mobile");
  button?.setAttribute("aria-expanded", open ? "true" : "false");
}

function toggleSidebar() {
  if (isMobileSidebarViewport()) {
    setMobileSidebarOpen(!document.getElementById("app-shell")?.classList.contains("mobile-sidebar-open"));
    return;
  }
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
  const name = document.getElementById("next-race-name");
  const date = document.getElementById("next-race-date");
  const location = document.getElementById("next-race-location");
  const signups = document.getElementById("next-race-signups");
  const panel = document.getElementById("next-race-panel");
  if (!meta || !panel) return;

  const thumb = document.getElementById("next-race-thumb");
  const placeholder = panel.querySelector(".next-race-thumb-placeholder");
  if (thumb) {
    thumb.onerror = () => {
      thumb.hidden = true;
      thumb.src = "";
      panel.classList.remove("next-race-has-thumbnail");
      if (placeholder) placeholder.hidden = false;
    };
  }

  if (!marathon) {
    meta.textContent = "No upcoming races scheduled";
    if (name) name.textContent = "No upcoming races scheduled";
    if (date) date.textContent = "Date to be announced";
    if (location) location.textContent = "Location to be announced";
    if (signups) signups.textContent = "0 signed up";
    panel.classList.add("next-race-empty");
    panel.classList.remove("next-race-has-thumbnail");
    if (thumb) {
      thumb.hidden = true;
      thumb.src = "";
      thumb.alt = "";
    }
    if (placeholder) placeholder.hidden = false;
    ["days", "hours", "mins", "secs"].forEach((u) => {
      const el = panel.querySelector(`[data-unit="${u}"]`);
      if (el) el.textContent = "0";
    });
    return;
  }

  if (thumb) {
    if (marathon.image_url) {
      thumb.src = marathon.image_url;
      thumb.alt = `${marathon.name} race thumbnail`;
      thumb.hidden = false;
      panel.classList.add("next-race-has-thumbnail");
      if (placeholder) placeholder.hidden = true;
    } else {
      thumb.hidden = true;
      thumb.src = "";
      thumb.alt = "";
      panel.classList.remove("next-race-has-thumbnail");
      if (placeholder) placeholder.hidden = false;
    }
  }

  panel.classList.remove("next-race-empty");
  const target = nextRaceTargetDate(marathon);
  const parts = formatCountdownParts(target);
  const count = regsForMarathon(marathon.id).length;
  if (name) name.textContent = marathon.name;
  if (date) date.textContent = formatRaceDateTime(marathon);
  if (location) location.textContent = marathon.location || "Location TBD";
  if (signups) signups.textContent = `${count} signed up`;
  if (parts.done) {
    meta.textContent = `${marathon.name} · ${formatRaceDateTime(marathon)} · started · ${count} signed up`;
  } else {
    meta.textContent = `${marathon.name} · ${formatRaceDateTime(marathon)} · ${marathon.location || "TBD"} · ${count} signed up`;
  }
  meta.textContent = parts.done ? "This race has started" : "Get ready to run with the group";
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
    // Older imports often have no email. Only use a unique name match so an
    // existing historical runner is linked instead of creating an empty one.
    (state.runners.filter((r) => String(r.name || "").trim().toLowerCase() === displayName.toLowerCase()).length === 1
      ? state.runners.find((r) => String(r.name || "").trim().toLowerCase() === displayName.toLowerCase())
      : null) ||
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
  // Serialize concurrent enterApp (auth INITIAL_SESSION + getSession double-fire)
  if (enterAppInFlight) return enterAppInFlight;

  enterAppInFlight = (async () => {
    if (mustChangePassword()) {
      showScreen("password-gate");
      return;
    }
    setBoot("Loading group data…");
    await loadGroupData();
    // Realtime group + notifications (subscribeRealtime calls subscribeNotificationsRealtime)
    subscribeRealtime();
    await loadNotifications();
    showScreen("app");
    cacheBrandFromGroup(group);
    applyBrandLogo();
    updateUserChrome();
    updateRolePill();
    setSidebarCollapsed(isSidebarCollapsed());
    setView("dashboard");
    // Best-effort push (never blocks UI)
    subscribeToPushNotifications().catch(() => {});
  })().finally(() => {
    enterAppInFlight = null;
  });

  return enterAppInFlight;
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
  cacheBrandFromGroup(group);
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
  // Sidebar role badge removed; keep the navigation menus only.
}

async function handleSession(newSession) {
  session = newSession;
  if (!session) {
    lastHandledSessionUserId = null;
    unsubscribeAll();
    applyBrandLogo();
    showScreen("auth");
    fetchGroupBranding();
    return;
  }

  // Skip duplicate SIGNED_IN / INITIAL_SESSION for the same user while app is up
  const uid = session.user?.id || null;
  if (
    uid &&
    uid === lastHandledSessionUserId &&
    document.getElementById("app-shell") &&
    !document.getElementById("app-shell").hidden
  ) {
    return;
  }

  try {
    setBoot("Loading your profile…");
    await loadProfile();
    const hasGroup = await loadMembership();

    if (!hasGroup) {
      lastHandledSessionUserId = uid;
      showScreen("onboard");
      document.getElementById("onboard-user-label").textContent =
        `Signed in as ${profile?.display_name || session.user.email}`;
      return;
    }

    await enterApp();
    lastHandledSessionUserId = uid;
  } catch (e) {
    console.error(e);
    lastHandledSessionUserId = null;
    toast(errMsg(e), "error");
    applyBrandLogo();
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
  const meta = VIEW_META[view] || { title: view, desc: "" };
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
  if (currentView === "leaderboard") leaderboardFeature.renderFullLeaderboards();
  if (currentView === "registrations") renderRegistrations();
  if (currentView === "results") renderResults();
  if (currentView === "certificates") renderCertificatesView();
  if (currentView === "team") renderTeam();
  if (currentView === "notifications") renderNotifications();
  if (currentView === "community") renderCommunity();
  if (currentView === "profile") renderProfile();
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
    const color = i === 0 ? "var(--accent-hover)" : "var(--accent)";
    const label = e.name.length > 10 ? `${e.name.slice(0, 9)}…` : e.name;
    return `
      <g class="lb-bar-group">
        <rect class="lb-bar" x="${x}" y="${y}" width="${barW}" height="${h}" rx="8" fill="${color}" opacity="0.9">
          <title>${escapeHtml(e.name)}: ${e.score} points, ${e.entries} participations, ${e.bestTime != null ? formatSeconds(e.bestTime) : "no recorded time"}</title>
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
        <li class="leaderboard-rank-item lb-rank-${i + 1}">
          <span class="lb-rank"><small>Rank</small>#${i + 1}</span>
          <span class="lb-avatar">${renderProfileAvatar(e.runner, e.name, e.runnerId)}</span>
          <span class="lb-name" title="${escapeHtml(e.name)}">${escapeHtml(e.name)}</span>
          <span class="lb-time"><small>Best</small><strong class="time-mono">${e.bestTime != null ? formatSeconds(e.bestTime) : "—"}</strong></span>
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

  // Display fastest runners section
  const fastestRunners = report.metrics?.fastest_runners;
  if (fastestRunners && fastestRunners.length > 0) {
    const fastestSection = document.getElementById("fastest-runners-section");
    if (fastestSection) {
      fastestSection.hidden = false;
      const list = fastestSection.querySelector(".fastest-runners-list");
      if (list) {
        list.innerHTML = fastestRunners
          .map(
            (runner, index) => `
          <div class="fastest-runner-item">
            <span class="fastest-runner-rank">${index + 1}</span>
            <span class="fastest-runner-name">${escapeHtml(runner.name)}</span>
   <span class="fastest-runner-pace">${escapeHtml(runner.best_pace_display)}/km</span>
            <span class="fastest-runner-races">${runner.races} race${runner.races !== 1 ? "s" : ""}</span>
          </div>
        `
          )
          .join("");
      }
    }
  }
}

function renderCompactDashboardAnalytics() {
  const metricsEl = document.getElementById("insights-metrics");
  const listEl = document.getElementById("insights-list");
  const fastestSection = document.getElementById("fastest-runners-section");
  if (!metricsEl || !listEl) return;

  const report = typeof window.PacePackAnalytics?.analyze === "function"
    ? window.PacePackAnalytics.analyze({ runners: state.runners, marathons: state.marathons, registrations: state.registrations })
    : { metrics: {}, insights: [] };
  const m = report.metrics || {};
  const totalRegistrations = state.registrations.length;
  const finished = state.registrations.filter((r) => r.status === "completed" || displayFinishTime(r)).length;
  const completion = totalRegistrations ? Math.round((finished / totalRegistrations) * 100) : null;
  const value = (v) => v == null ? "—" : v;

  metricsEl.innerHTML = `
    <div class="insight-metric"><p class="insight-metric-label">Participation rate</p><p class="insight-metric-value">${value(m.participation_rate_pct)}${m.participation_rate_pct != null ? "%" : ""}</p><p class="insight-metric-hint">Runners with at least one entry</p></div>
    <div class="insight-metric"><p class="insight-metric-label">Results completion</p><p class="insight-metric-value">${value(completion)}${completion != null ? "%" : ""}</p><p class="insight-metric-hint">${finished} of ${totalRegistrations} registrations timed</p></div>
    <div class="insight-metric"><p class="insight-metric-label">Avg signups / race</p><p class="insight-metric-value">${value(m.avg_signups_per_race)}</p><p class="insight-metric-hint">Average entries per marathon</p></div>
    <div class="insight-metric"><p class="insight-metric-label">Group median finish</p><p class="insight-metric-value time-mono">${escapeHtml(m.median_finish_display || "—")}</p><p class="insight-metric-hint">Across all timed results</p></div>`;

  const zeroSignupRaces = state.marathons.filter((race) => regsForMarathon(race.id).length === 0);
  const popularRace = sortMarathons(state.marathons)
    .map((race) => ({ race, count: regsForMarathon(race.id).length }))
    .sort((a, b) => b.count - a.count)[0];
  const fastest = m.fastest_runners?.[0];
  const smartInsights = [];
  if (zeroSignupRaces.length) smartInsights.push(`${zeroSignupRaces.length} race${zeroSignupRaces.length === 1 ? "" : "s"} still have zero signups`);
  if (fastest) smartInsights.push(`${fastest.name} is currently fastest at ${fastest.best_pace_display}/km`);
  if (state.runnerBadges.length) smartInsights.push(`${state.runnerBadges.length} achievement${state.runnerBadges.length === 1 ? "" : "s"} earned across the club`);
  if (popularRace?.count) smartInsights.push(`Most popular race: ${popularRace.race.name} with ${popularRace.count} signup${popularRace.count === 1 ? "" : "s"}`);
  const waitlisted = state.registrations.filter((r) => r.status === "waitlisted").length;
  if (waitlisted) smartInsights.push(`${waitlisted} runner${waitlisted === 1 ? "" : "s"} on the waitlist need follow-up`);
  if (!smartInsights.length && !state.runners.length) smartInsights.push("Add runners and races to unlock group insights");
  listEl.innerHTML = smartInsights.slice(0, 4).map((text) => `<li class="insight-item">${escapeHtml(text)}</li>`).join("");

  const fastestRunners = (m.fastest_runners || []).slice(0, 5);
  if (fastestSection) {
    fastestSection.hidden = fastestRunners.length === 0;
    const list = fastestSection.querySelector(".fastest-runners-list");
    if (list) list.innerHTML = fastestRunners.map((runner, index) => `<div class="fastest-runner-item"><span class="fastest-runner-rank">${index + 1}</span><span class="fastest-runner-name">${escapeHtml(runner.name)}</span><span class="fastest-runner-pace time-mono">${escapeHtml(runner.best_pace_display)}/km</span><span class="fastest-runner-races">${runner.races} race${runner.races === 1 ? "" : "s"}</span></div>`).join("");
  }

  const active = leaderboardFeature.computeLeaderboard().slice(0, 5);
  const activeList = document.getElementById("leaderboard-list");
  if (activeList) activeList.innerHTML = active.length ? `<ol class="leaderboard-ranks compact-leaderboard">${active.map((entry, index) => `<li class="leaderboard-rank-item lb-rank-${index + 1}"><span class="lb-rank"><small>Rank</small>#${index + 1}</span><span class="lb-avatar">${renderProfileAvatar(entry.runner, entry.name, entry.runnerId)}</span><span class="lb-name" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</span><span class="lb-meta">${entry.finishes} finish${entry.finishes === 1 ? "" : "es"} · ${entry.entries} entr${entry.entries === 1 ? "y" : "ies"}</span><span class="lb-score">${entry.score}</span></li>`).join("")}</ol>` : `<div class="empty"><strong>No contributors yet</strong>Log results to build the leaderboard.</div>`;
}

function resultsNameKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter(Boolean).sort().join(" ");
}

function openResultsImport() {
  if (!canWrite()) return toast("No permission", "error");
  if (!state.marathons.length) return toast("Add a marathon first", "error");
  openModal({
    title: "Import race results",
    wide: true,
    bodyHtml: `<div class="form-grid">
      <div class="field" style="grid-column:1/-1">
        <label for="ri-url">Results page URL *</label>
        <div class="form-row"><input class="input" id="ri-url" type="url" placeholder="https://example.com/race-results" style="flex:1" /><button type="button" class="btn btn-secondary" id="ri-scrape">Scrape results</button></div>
        <p class="panel-hint" style="margin:0.35rem 0 0">Nothing is saved while scraping or reviewing.</p>
      </div>
      <div id="ri-preview" class="panel" style="grid-column:1/-1;display:none"></div>
    </div>`,
    footerHtml: `<button class="btn btn-ghost" id="ri-cancel">Cancel</button><button class="btn btn-primary" id="ri-save" disabled>Confirm and input results</button>`,
    onMount() {
      let imported = null;
      const preview = document.getElementById("ri-preview");
      const scrape = document.getElementById("ri-scrape");
      const save = document.getElementById("ri-save");
      document.getElementById("ri-cancel").onclick = closeModal;
      scrape.onclick = async () => {
        const url = document.getElementById("ri-url").value.trim();
        if (!/^https?:\/\//i.test(url)) return toast("Enter a valid http:// or https:// results URL", "error");
        const restore = setButtonBusy(scrape, "Scraping…");
        try {
          const { data, error } = await sb.functions.invoke("scrape-results", { body: { url } });
          if (error) throw new Error(data?.error || error.message || "Could not scrape results");
          if (data?.error) throw new Error(data.error);
          imported = data?.data;
          if (!imported?.results?.length) throw new Error("No result rows were found on that page");
          const selectedRace = getMarathon(document.getElementById("results-marathon")?.value);
          const race = state.marathons.find((m) => resultsNameKey(m.name) === resultsNameKey(imported.race_name)) || selectedRace;
          imported.marathon_id = race?.id || "";
          imported.results = imported.results.map((row) => {
            const matches = state.runners.filter((runner) => resultsNameKey(runner.name) === resultsNameKey(row.runner_name));
            const registration = matches.length === 1 && race ? state.registrations.find((r) => r.marathon_id === race.id && r.runner_id === matches[0].id) : null;
            return { ...row, runner_id: matches.length === 1 ? matches[0].id : "", registration_id: registration?.id || "", match_note: registration ? "Matched to registered runner" : matches.length === 1 ? "Runner found, but not registered for this race" : "Unmatched or ambiguous runner" };
          });
          const matched = imported.results.filter((row) => row.registration_id).length;
          preview.style.display = "block";
          preview.innerHTML = `<strong>Review before input</strong><p class="panel-hint">Race: ${escapeHtml(imported.race_name || "Unknown race")} · ${imported.results.length} rows · ${matched} will be entered · ${imported.results.length - matched} skipped</p><p class="panel-hint">Scrape source: <a href="${escapeHtml(imported.source_url || "#")}" target="_blank" rel="noopener">${escapeHtml(imported.source_url || "—")}</a></p><div class="table-wrap"><table class="data-table"><thead><tr><th>Runner</th><th>Time</th><th>Place</th><th>Status</th><th>Match</th></tr></thead><tbody>${imported.results.slice(0, 12).map((row) => `<tr><td>${escapeHtml(row.runner_name || "—")}</td><td>${escapeHtml(row.finish_time || "—")}</td><td>${escapeHtml(row.overall_place || "—")}</td><td>${escapeHtml(row.status || "completed")}</td><td>${escapeHtml(row.match_note)}</td></tr>`).join("")}</tbody></table></div>${imported.results.length > 12 ? `<p class="panel-hint">Showing first 12 rows.</p>` : ""}<p class="panel-hint">Confirming will input only rows matched to an existing registered runner. Unmatched rows will not be saved.</p>`;
          save.disabled = matched === 0;
        } catch (error) {
          toast(error?.message || "Failed to scrape results", "error");
        } finally { restore(); }
      };
      save.onclick = async () => {
        if (!imported) return;
        const rows = imported.results.filter((row) => row.registration_id);
        if (!rows.length) return toast("There are no matched registered runners to input", "error");
        const restore = setButtonBusy(save, "Inputting results…");
        try {
          for (const row of rows) {
            const status = ["dns", "dnf"].includes(row.status) ? row.status : row.finish_time ? "completed" : "registered";
            const { error } = await sb.from("registrations").update({ status, chip_time: row.finish_time || "", gun_time: row.finish_time || "", place_overall: row.overall_place || "", place_gender: row.gender_place || "", place_age_group: row.category_place || row.age_category || "", bib: row.bib || "", result_notes: `Imported from ${imported.source_url}` }).eq("id", row.registration_id);
            if (error) throw error;
          }
          closeModal();
          toast(`${rows.length} result${rows.length === 1 ? "" : "s"} entered successfully.`);
          await loadGroupData();
          render();
        } catch (error) { operationFailed("Inputting race results", error); }
        finally { restore(); }
      };
    },
  });
}

function findImprovementSpotlight() {
  const grouped = new Map();
  state.registrations.forEach((reg) => {
    const race = getMarathon(reg.marathon_id);
    const runner = getRunner(reg.runner_id);
    const seconds = bestFinishSeconds(reg);
    if (!race || !runner || seconds == null) return;
    const key = `${reg.runner_id}:${registrationDistance(reg, race)}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({ seconds, date: String(race.race_date || "") });
  });
  let spotlight = null;
  grouped.forEach((results, key) => {
    if (results.length < 2) return;
    results.sort((a, b) => a.date.localeCompare(b.date));
    const from = results[0].seconds;
    const to = Math.min(...results.slice(1).map((result) => result.seconds));
    if (from <= to) return;
    const [runnerId, distance] = key.split(":");
    const candidate = { name: getRunner(runnerId)?.name || "Runner", distance, from, to, drop: from - to };
    if (!spotlight || candidate.drop > spotlight.drop) spotlight = candidate;
  });
  return spotlight;
}

function renderVisualAnalytics() {
  const container = document.getElementById("analytics-visuals");
  if (!container) return;

  const total = state.registrations.length;
  const finished = state.registrations.filter((r) => r.status === "completed" || displayFinishTime(r)).length;
  const finishRate = total ? Math.round((finished / total) * 100) : 0;
  const activeRunnerIds = new Set(state.registrations.map((r) => r.runner_id));
  const participationRate = state.runners.length ? Math.round((activeRunnerIds.size / state.runners.length) * 100) : 0;
  const statusOrder = ["registered", "interested", "waitlisted", "completed", "dnf", "dns"];
  const statusColors = { registered: "var(--teal)", interested: "var(--blue)", waitlisted: "var(--amber)", completed: "var(--green)", dnf: "var(--purple)", dns: "var(--danger)" };
  const statusCounts = Object.fromEntries(statusOrder.map((status) => [status, state.registrations.filter((r) => r.status === status).length]));
  const activeStatuses = statusOrder.filter((status) => statusCounts[status]);
  const raceSeries = sortMarathons(state.marathons).map((marathon) => ({ name: marathon.name, count: regsForMarathon(marathon.id).length })).sort((a, b) => b.count - a.count).slice(0, 5);
  const maxRaceCount = Math.max(...raceSeries.map((race) => race.count), 1);

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const finishes = state.registrations.filter((r) => r.status === "completed" || displayFinishTime(r));
  const canonicalPRs = canonicalPRRegistrations();
  const prRows = state.registrations
    .filter((r) => (r.is_pr || canonicalPRs.has(r.id)) && displayFinishTime(r))
    .map((reg) => ({ reg, runner: getRunner(reg.runner_id), race: getMarathon(reg.marathon_id) }))
    .filter((row) => row.runner && row.race)
    .sort((a, b) => String(b.race.race_date || b.reg.updated_at || "").localeCompare(String(a.race.race_date || a.reg.updated_at || "")));
  const monthPRs = prRows.filter((row) => new Date(`${String(row.race.race_date || "").slice(0, 10)}T12:00:00`) >= monthStart);
  const prRate = finishes.length ? Math.round((prRows.length / finishes.length) * 100) : 0;
  const prDistanceCounts = {};
  prRows.forEach((row) => {
    const distance = registrationDistance(row.reg, row.race);
    prDistanceCounts[distance] = (prDistanceCounts[distance] || 0) + 1;
  });
  const badgeRows = state.runnerBadges || [];
  const monthBadges = badgeRows.filter((badge) => new Date(badge.awarded_at || 0) >= monthStart);
  const badgeCounts = {};
  badgeRows.forEach((badge) => { badgeCounts[badge.badge_key] = (badgeCounts[badge.badge_key] || 0) + 1; });
  const topBadges = Object.entries(badgeCounts).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const badgeLeaderboard = Object.entries(badgeRows.reduce((counts, badge) => { counts[badge.runner_id] = (counts[badge.runner_id] || 0) + 1; return counts; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([runnerId, count]) => ({ name: getRunner(runnerId)?.name || "Runner", count }));
  const badgeRunnerCounts = new Set(badgeRows.map((badge) => badge.runner_id)).size;
  const badgeRate = state.runners.length ? Math.round((badgeRunnerCounts / state.runners.length) * 100) : 0;
  const badgeLabel = (key) => String(key || "Achievement").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  const closestBadge = state.runners.map((runner) => {
    const count = state.registrations.filter((reg) => reg.runner_id === runner.id && (reg.status === "completed" || displayFinishTime(reg))).length;
    if (count >= 4 && count < 5) return `${runner.name} is 1 race from 5 Races Completed`;
    if (count >= 9 && count < 10) return `${runner.name} is 1 race from 10 Races Completed`;
    return null;
  }).find(Boolean);
  const recentPRMarkup = prRows.length ? prRows.slice(0, 5).map((row) => `<div class="recognition-row"><span class="recognition-icon">★</span><span class="recognition-main"><strong>${escapeHtml(row.runner.name)}</strong><small>${escapeHtml(registrationDistance(row.reg, row.race))} · ${escapeHtml(row.race.name)}</small></span><span class="time-mono">${escapeHtml(displayFinishTime(row.reg))}</span></div>`).join("") : `<p class="analytics-copy">PRs will appear here automatically after results are logged.</p>`;
  const distanceOrder = ["5K", "7.5K", "10K", "15K", "Half Marathon", "Marathon", "Ultra", "Other"];
  const distanceRows = [...new Set([...distanceOrder, ...Object.keys(prDistanceCounts)])]
    .filter((distance) => prDistanceCounts[distance] || Object.keys(prDistanceCounts).length === 0)
    .map((distance) => [distance, prDistanceCounts[distance] || 0]);
  const maxPRDistance = Math.max(1, ...distanceRows.map(([, count]) => count));
  const nextRace = sortMarathons(state.marathons.filter((m) => !isPast(m)))[0];
  const nextRaceRegs = nextRace ? regsForMarathon(nextRace.id) : [];
  const readiness = nextRace ? Math.round((nextRaceRegs.length / Math.max(state.runners.length, 1)) * 100) : 0;
  const improvement = findImprovementSpotlight();
  const trendRaces = sortMarathons(state.marathons.filter((m) => isPast(m))).slice(-6);
  const progressTrend = trendRaces.map((race) => {
    const rows = regsForMarathon(race.id);
    const times = rows.map((row) => bestFinishSeconds(row)).filter((value) => value != null).sort((a, b) => a - b);
    return { race, signups: rows.length, completion: rows.length ? Math.round((finishes.filter((row) => row.marathon_id === race.id).length / rows.length) * 100) : 0, median: times.length ? times[Math.floor(times.length / 2)] : null };
  });

  const mixSegments = activeStatuses.map((status) => `<span class="entry-mix-segment" style="width:${total ? (statusCounts[status] / total) * 100 : 0}%;background:${statusColors[status]}" title="${escapeHtml(statusLabel(status))}: ${statusCounts[status]}"></span>`).join("");
  const ring = (value, label, color) => `<div class="analytics-ring" style="--ring-value:${value}%;--ring-color:${color}" role="img" aria-label="${label}: ${value}%"><div><strong>${value}%</strong><span>${label}</span></div></div>`;

  container.innerHTML = `
    <div class="analytics-card analytics-progress-card">
      <div class="analytics-card-head"><span class="analytics-eyebrow">Group progress</span><span class="analytics-mini-total">${total} entries</span></div>
      <div class="analytics-rings">${ring(finishRate, "finished", "var(--green)")}${ring(participationRate, "active", "var(--accent)")}</div>
      <p class="analytics-copy">${finished} of ${total} entries have a recorded finish.</p>
    </div>
    <div class="analytics-card analytics-mix-card">
      <div class="analytics-card-head"><span class="analytics-eyebrow">Entry mix</span><span class="analytics-mini-total">${total} total</span></div>
      ${activeStatuses.length ? `<div class="entry-mix-bar" role="img" aria-label="Registration status breakdown">${mixSegments}</div><div class="status-legend">${activeStatuses.map((status) => `<div class="status-legend-item"><i style="background:${statusColors[status]}"></i><span>${escapeHtml(statusLabel(status))}</span><strong>${statusCounts[status]}</strong></div>`).join("")}</div>` : `<p class="analytics-copy">Add registrations to see the mix.</p>`}
    </div>
    <div class="analytics-card analytics-race-card">
      <div class="analytics-card-head"><span class="analytics-eyebrow">Most popular races</span><span class="analytics-mini-total">Top ${raceSeries.length || 0}</span></div>
      <div class="race-bars">${raceSeries.length ? raceSeries.map((race, index) => `<div class="race-bar-row"><span class="race-bar-rank">${index + 1}</span><span class="race-bar-name" title="${escapeHtml(race.name)}">${escapeHtml(race.name)}</span><div class="race-bar-track"><div class="race-bar-fill" style="width:${(race.count / maxRaceCount) * 100}%;--bar-index:${index}"></div></div><strong>${race.count}<small> runners</small></strong></div>`).join("") : `<p class="analytics-copy">Add races to compare signups.</p>`}</div>
    </div>
    <div class="analytics-card recognition-card">
      <div class="analytics-card-head"><span class="analytics-eyebrow">Group pulse</span><span class="analytics-trend">${monthPRs.length} PR${monthPRs.length === 1 ? "" : "s"} this month</span></div>
      <div class="recognition-kpis"><div><strong>${prRate}%</strong><span>PR rate</span></div><div><strong>${badgeRate}%</strong><span>badge reach</span></div><div><strong>${activeRunnerIds.size}</strong><span>active runners</span></div></div>
      <p class="analytics-copy">${finishes.length ? `${prRows.length} of ${finishes.length} recorded finishes are marked as personal bests.` : "Log results to measure group progress."}</p>
    </div>
    <div class="analytics-card recognition-card">
      <div class="analytics-card-head"><span class="analytics-eyebrow">Recent PRs</span><span class="analytics-mini-total">Last ${Math.min(prRows.length, 5)}</span></div>
      <div class="recognition-list">${recentPRMarkup}</div>
    </div>
    <div class="analytics-card recognition-card">
      <div class="analytics-card-head"><span class="analytics-eyebrow">PRs by distance</span><span class="analytics-mini-total">${prRows.length} total</span></div>
      <div class="recognition-bars">${distanceRows.map(([distance, count]) => `<div class="recognition-bar-row"><span>${escapeHtml(distance)}</span><span class="race-bar-track"><span class="race-bar-fill" style="width:${(count / maxPRDistance) * 100}%"></span></span><strong>${count}</strong></div>`).join("")}</div>
    </div>
    <div class="analytics-card recognition-card">
      <div class="analytics-card-head"><span class="analytics-eyebrow">Achievement momentum</span><span class="analytics-trend">${monthBadges.length} earned this month</span></div>
      <div class="recognition-list">${topBadges.length ? topBadges.map(([key, count]) => `<div class="recognition-row"><span class="recognition-icon">◆</span><span class="recognition-main"><strong>${escapeHtml(badgeLabel(key))}</strong><small>${count} runner${count === 1 ? "" : "s"} earned it</small></span><span class="badge badge-count">${count}</span></div>`).join("") : `<p class="analytics-copy">Badges will be awarded automatically from race results.</p>`}</div>
      ${closestBadge ? `<p class="analytics-copy">Closest to next badge: ${escapeHtml(closestBadge)}.</p>` : ""}
      ${badgeLeaderboard.length ? `<p class="analytics-copy">Badge leaders: ${badgeLeaderboard.map((entry) => `${escapeHtml(entry.name)} (${entry.count})`).join(" · ")}</p>` : ""}
    </div>
    <div class="analytics-card recognition-card">
      <div class="analytics-card-head"><span class="analytics-eyebrow">Improvement spotlight</span><span class="analytics-mini-total">Biggest drop</span></div>
      ${improvement ? `<div class="recognition-feature"><strong>${escapeHtml(improvement.name)}</strong><span>${escapeHtml(improvement.distance)} improved by <b>${formatSeconds(improvement.drop)}</b></span><small>${formatSeconds(improvement.from)} → ${formatSeconds(improvement.to)}</small></div>` : `<p class="analytics-copy">Two results at the same distance unlock the improvement spotlight.</p>`}
    </div>
    <div class="analytics-card recognition-card">
      <div class="analytics-card-head"><span class="analytics-eyebrow">Race readiness</span><span class="analytics-mini-total">Next race</span></div>
      ${nextRace ? `<div class="readiness-head"><strong>${readiness}%</strong><span>${nextRaceRegs.length}/${state.runners.length} registered</span></div><div class="profile-progress-track"><div class="profile-progress-fill" style="width:${Math.min(readiness, 100)}%"></div></div><p class="analytics-copy">${state.runners.length - nextRaceRegs.length} runner${state.runners.length - nextRaceRegs.length === 1 ? "" : "s"} still need to register for ${escapeHtml(nextRace.name)}.</p>` : `<p class="analytics-copy">Add an upcoming race to track readiness.</p>`}
    </div>
    <div class="analytics-card recognition-card analytics-trend-card">
      <div class="analytics-card-head"><span class="analytics-eyebrow">Progress trend</span><span class="analytics-mini-total">Last ${progressTrend.length} races</span></div>
      ${progressTrend.length ? `<div class="group-trend-chart">${progressTrend.map((item) => `<div class="group-trend-item" title="${escapeHtml(item.race.name)}"><span class="group-trend-value">${item.completion}%</span><span class="group-trend-bar" style="height:${Math.max(8, item.completion)}%"></span><small>${escapeHtml(item.race.name.slice(0, 10))}</small><em>${item.median != null ? escapeHtml(formatSeconds(item.median)) : "—"}</em></div>`).join("")}</div><p class="analytics-copy">Bars show result completion; labels show median finish.</p>` : `<p class="analytics-copy">Complete races to build a progress trend.</p>`}
    </div>`;
}

function renderDashboard() {
  const upcoming = sortMarathons(state.marathons.filter((m) => !isPast(m)));
  const past = state.marathons.filter((m) => isPast(m));
  const registered = state.registrations.filter((r) => r.status === "registered").length;
  const completed = state.registrations.filter((r) => r.status === "completed").length;
  const withTimes = state.registrations.filter((r) => displayFinishTime(r)).length;

  renderCompactDashboardAnalytics();
  renderVisualAnalytics();

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
  const chartStatuses = ["registered", "interested", "waitlisted", "completed", "dnf", "dns"];
  const statusChartColors = { registered: "var(--teal)", interested: "var(--blue)", waitlisted: "var(--amber)", completed: "var(--green)", dnf: "var(--purple)", dns: "var(--danger)" };

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
      color: "var(--accent)",
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
  const uniqueRunners = new Set(state.registrations.map((registration) => registration.runner_id).filter(Boolean)).size;
  const racesWithSignups = series.filter((item) => item.count > 0).length;
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
    let stackY = y + h;
    const stacks = chartStatuses.map((status) => {
      const count = s.byStatus[status] || 0;
      if (!count) return "";
      const segmentH = Math.max(3, (count / s.count) * h);
      stackY -= segmentH;
      return `<rect class="wr-bar wr-bar-${status}" x="${x}" y="${stackY}" width="${barW}" height="${segmentH + 0.5}" fill="${statusChartColors[status]}"></rect>`;
    }).join("");
    return `
      <g class="wr-bar-group${selected ? " is-selected" : ""}" data-marathon-id="${s.marathon.id}" role="button" tabindex="0" style="cursor:pointer">
        <rect class="wr-bar-hit" x="${x - 6}" y="${padT}" width="${barW + 12}" height="${chartH + padB - 8}" fill="transparent"></rect>
        <rect class="wr-bar-base" x="${x}" y="${y}" width="${barW}" height="${h}" rx="9" fill="${s.color}" opacity="${selected ? "0.28" : "0.16"}"></rect>
        <g opacity="${selected ? "1" : "0.72"}">${stacks}</g>
        <text class="wr-value" x="${x + barW / 2}" y="${y - 8}" text-anchor="middle">${s.count}</text>
        <text class="wr-label" x="${x + barW / 2}" y="${padT + chartH + 18}" text-anchor="middle">${escapeHtml(label)}</text>
        <text class="wr-date" x="${x + barW / 2}" y="${padT + chartH + 34}" text-anchor="middle">${escapeHtml(dateShort)}</text>
      </g>`;
  }).join("");

  const horizontalBars = series.map((s) => {
    const selected = s.marathon.id === selectedWhosRunningMarathonId;
    const previewRunners = regsSortedForMarathon(s.marathon.id).slice(0, 3).map((registration) => getRunner(registration.runner_id)).filter(Boolean);
    const avatarStack = previewRunners.map((runner) => `<span class="wr-mini-avatar">${renderProfileAvatar(runner, runner.name, runner.id)}</span>`).join("");
    const stacks = chartStatuses.map((status) => {
      const count = s.byStatus[status] || 0;
      return count ? `<span class="wr-stack wr-stack-${status}" style="width:${s.count ? (count / s.count) * 100 : 0}%;background:${statusChartColors[status]}" title="${escapeHtml(statusLabel(status))}: ${count}"></span>` : "";
    }).join("");
    return `<div class="wr-bar-group${selected ? " is-selected" : ""}" data-marathon-id="${s.marathon.id}" role="button" tabindex="0" aria-label="${escapeHtml(s.marathon.name)}: ${s.count} runners">
      <div class="wr-row-label"><div class="wr-row-title"><strong>${escapeHtml(s.marathon.name)}</strong><span class="wr-race-state">${isPast(s.marathon) ? "Completed" : "Upcoming"}</span></div><span>${escapeHtml(formatRaceDateTime(s.marathon))}</span></div>
      <div class="wr-row-track"><div class="wr-row-fill" style="width:${(s.count / max) * 100}%"><div class="wr-stack-track">${stacks}</div></div></div>
      <div class="wr-row-people">${avatarStack || `<span class="wr-no-avatar">—</span>`}<strong class="wr-row-count">${s.count}<small> runner${s.count === 1 ? "" : "s"}</small></strong></div>
    </div>`;
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
      <div class="wr-summary" aria-label="Who's running what summary"><div><strong>${series.length}</strong><span>races</span></div><div><strong>${racesWithSignups}</strong><span>with signups</span></div><div><strong>${uniqueRunners}</strong><span>runners in motion</span></div><p>Choose a race to inspect its runners.</p></div>
      <div class="wr-chart-legend">${chartStatuses.map((status) => `<span><i style="background:${statusChartColors[status]}"></i>${escapeHtml(statusLabel(status))}</span>`).join("")}</div>
      <div class="wr-visual-grid"><div class="wr-race-list" role="list" aria-label="Runners by race">${horizontalBars}</div><div class="wr-detail-column">${detail || ""}</div></div>
      <div class="leaderboard-chart-scroll" hidden>
        <svg class="whos-running-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Registrations by race bar chart">
          <line class="lb-axis" x1="${padL - 10}" y1="${padT + chartH}" x2="${width - padR}" y2="${padT + chartH}" />
          ${bars}
        </svg>
      </div>
      <div class="wr-hover-tip" id="wr-hover-tip" hidden></div>
    </div>`;

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
  const sort = document.getElementById("marathon-sort")?.value || "date-asc";
  let list = sortMarathons(state.marathons);
  if (filter === "upcoming") list = list.filter((m) => !isPast(m));
  if (filter === "past") list = list.filter((m) => isPast(m));
  if (q) {
    list = list.filter((m) =>
      [m.name, m.location, m.distance, m.notes].join(" ").toLowerCase().includes(q)
    );
  }
  list.sort((a, b) => {
    const dateA = nextRaceTargetDate(a)?.getTime() ?? 0;
    const dateB = nextRaceTargetDate(b)?.getTime() ?? 0;
    if (sort === "date-desc") return dateB - dateA || (a.name || "").localeCompare(b.name || "");
    if (sort === "name") return (a.name || "").localeCompare(b.name || "");
    if (sort === "entries") return regsForMarathon(b.id).length - regsForMarathon(a.id).length || dateA - dateB;
    if (sort === "results") {
      const resultCount = (m) => regsForMarathon(m.id).filter((r) => r.status === "completed" || displayFinishTime(r)).length;
      return resultCount(b) - resultCount(a) || dateA - dateB;
    }
    return dateA - dateB || (a.name || "").localeCompare(b.name || "");
  });
  const el = document.getElementById("marathon-list");
  if (!list.length) {
    el.innerHTML = `<div class="empty" style="grid-column:1/-1"><strong>No marathons found</strong></div>`;
    return;
  }
  el.innerHTML = list.map((m) => {
    const past = isPast(m);
    const regs = regsForMarathon(m.id);
    const finished = regs.filter((r) => r.status === "completed" || displayFinishTime(r));
    const times = finished.map(bestFinishSeconds).filter((s) => s != null).sort((a, b) => a - b);
    const best = times.length ? formatSeconds(times[0]) : null;
    const regOpen = m.reg_open_date ? `Opens ${formatDate(m.reg_open_date)}` : "";
    const regClose = m.reg_close_date ? `Closes ${formatDate(m.reg_close_date)}` : "";
    const regPeriod = [regOpen, regClose].filter(Boolean).join(" · ");
    const signupUrl = safeUrl(m.reg_link);
    const regButton = signupUrl
      ? `<a class="btn btn-secondary btn-sm" href="${escapeHtml(signupUrl)}" target="_blank" rel="noopener noreferrer">Sign up</a>`
      : "";
    const delBtn = canDelete()
      ? `<button class="btn btn-danger btn-sm" data-action="delete" data-id="${m.id}">Delete</button>`
      : "";
    return `
      <article class="card marathon-card${past ? " marathon-card-past" : ""}">
        <div class="marathon-media-wrap">
          ${renderMarathonImage(m)}
          <span class="marathon-state ${past ? "marathon-state-past" : "marathon-state-upcoming"}">${past ? "Past race" : "Upcoming"}</span>
        </div>
        <div class="marathon-card-title-row">
          <h3 class="card-title">${escapeHtml(m.name)}</h3>
          <span class="badge badge-distance">${escapeHtml(m.distance)}</span>
        </div>
        <div class="card-meta">
          <span>📅 ${formatRaceDateTime(m)}${isPast(m) ? " · past" : ""}</span>
          <span>📍 ${escapeHtml(m.location || "TBD")}</span>
          ${regPeriod ? `<span>📝 ${escapeHtml(regPeriod)}</span>` : ""}
          ${best ? `<span>🏆 <span class="time-mono">${best}</span></span>` : ""}
        </div>
        ${m.notes ? `<p class="card-notes">${escapeHtml(m.notes)}</p>` : ""}
        <div class="card-footer">
          <span class="badge badge-count">${regs.length} entries · ${finished.length} results</span>
          <div class="card-actions">
            ${regButton}
            <button class="btn btn-ghost btn-sm" data-action="results" data-id="${m.id}">Results</button>
            ${canEdit() ? `<button class="btn btn-secondary btn-sm" data-action="edit" data-id="${m.id}">Edit</button>` : ""}
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
    const isMe = m.user_id === session?.user?.id;
    return `
      <article class="card">
        <div class="member-head">
          <div class="runner-avatar-wrap">
            ${renderProfileAvatar(avatarSrc, m.name, m.id)}
          </div>
          <div class="member-head-text">
            <h3 class="card-title">${escapeHtml(m.name)}${isMe ? ' <span class="badge badge-count">you</span>' : ""}</h3>
            <p class="member-contact">${escapeHtml(m.email || m.phone || "No contact")}</p>
          </div>
        </div>
        ${m.notes ? `<p class="card-notes">${escapeHtml(m.notes)}</p>` : ""}
        <div class="card-footer">
          <span class="badge badge-count">${finishes.length} result${finishes.length === 1 ? "" : "s"}${prs ? ` · ${prs} PR` : ""}</span>
          <div class="card-actions">
            <button class="btn btn-ghost btn-sm" data-action="profile" data-id="${m.id}">View Profile</button>
            ${canEdit() ? `<button class="btn btn-secondary btn-sm" data-action="edit" data-id="${m.id}">Edit</button>` : ""}
            ${delBtn}
          </div>
        </div>
      </article>`;
  }).join("");

  el.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.action === "profile") openRunnerProfileDetail(btn.dataset.id);
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
        <td>${escapeHtml(registrationDistance(r, marathon))}</td>
        <td>${marathon ? formatDate(marathon.race_date) : "—"}</td>
        <td>${statusBadge(r.status)}</td>
        <td><div class="actions">
          ${canEdit() ? `<button class="btn btn-secondary btn-sm" data-action="edit" data-id="${r.id}">Edit</button>` : ""}
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
      .map((m) => {
        const count = regsForMarathon(m.id).length;
        return `<option value="${m.id}">${escapeHtml(m.name)} (${escapeHtml(m.race_date)}) — ${count} registered</option>`;
      })
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
    tbody.innerHTML = `<tr><td colspan="9"><div class="empty" style="border:none;margin:0.5rem"><strong>No results for this race</strong></div></td></tr>`;
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
        <td>${escapeHtml(registrationDistance(r, marathon))}</td>
        <td>${statusBadge(r.status)}</td>
        <td class="time-mono">${r.gun_time ? escapeHtml(r.gun_time) : "—"}</td>
        <td class="time-mono time-best">${r.chip_time ? escapeHtml(r.chip_time) : "—"}</td>
        <td>${pace ? escapeHtml(pace.perKm) + "/km" : "—"}</td>
        <td>${r.place_overall ? escapeHtml(r.place_overall) : "—"}</td>
        <td>${r.place_gender ? escapeHtml(r.place_gender) : "—"}</td>
        <td>${canEdit() ? `<button class="btn btn-secondary btn-sm" data-action="edit" data-id="${r.id}">Edit</button>` : ""}</td>
      </tr>`;
  }).join("");

  tbody.querySelectorAll("[data-action=edit]").forEach((btn) => {
    btn.addEventListener("click", () => openResultForm(btn.dataset.id));
  });
}

// ─── Profile helpers ─────────────────────────────────────────────────────────

function getMyRunner() {
  const linked = getRunnerForUser(session?.user?.id);
  const displayName = String(profile?.display_name || session?.user?.user_metadata?.display_name || "").trim().toLowerCase();
  const email = String(profile?.email || session?.user?.email || "").trim().toLowerCase();
  const emailMatches = email ? state.runners.filter((runner) => String(runner.email || "").trim().toLowerCase() === email) : [];
  const nameMatches = displayName ? state.runners.filter((runner) => String(runner.name || "").trim().toLowerCase() === displayName) : [];
  const historicalNameMatches = nameMatches.filter((runner) => regsForRunner(runner.id).length);
  const legacyMatches = emailMatches.length
    ? emailMatches
    : (nameMatches.length === 1 || historicalNameMatches.length === 1 ? (historicalNameMatches.length === 1 ? historicalNameMatches : nameMatches) : []);
  // A newly-created linked row can coexist with an older imported row when
  // the import had no email. Prefer the row carrying historical registrations.
  if (linked && regsForRunner(linked.id).length) return linked;
  const historicalMatch = legacyMatches
    .filter((runner) => regsForRunner(runner.id).length)
    .sort((a, b) => regsForRunner(b.id).length - regsForRunner(a.id).length)[0];
  if (historicalMatch) return historicalMatch;
  if (!linked || !regsForRunner(linked.id).length) {
    const historicalRunners = state.runners.filter((runner) => regsForRunner(runner.id).length);
    // Legacy imports may have no reliable identity fields. It is safe to use
    // the sole historical runner for a one-member group, or an unambiguous
    // single historical runner in the loaded group.
    if (historicalRunners.length === 1 && (team.length <= 1 || state.runners.length === 1)) {
      return historicalRunners[0];
    }
  }
  if (linked) return linked;
  return legacyMatches.sort((a, b) => regsForRunner(b.id).length - regsForRunner(a.id).length)[0] || null;
}

function canEditRunnerProfile(runner) {
  if (!runner || !session) return false;
  if (runner.user_id === session.user.id) return true;
  return hasMinRole("moderator");
}

function canViewRunnerProfile(runner) {
  if (!runner) return false;
  if (canEditRunnerProfile(runner)) return true;
  return !!runner.public_profile_enabled;
}

/** System-owned PRs. Race results are recalculated by the database trigger/RPC. */
function getRunnerPRs(runnerId) {
  const byDistance = new Map();
  // Registrations/results are the canonical source.  The stored PR table is a
  // derived cache and may be empty or stale for older runners.
  regsForRunner(runnerId).forEach((reg) => {
    const marathon = getMarathon(reg.marathon_id);
    const seconds = bestFinishSeconds(reg);
    const distance = registrationDistance(reg, marathon);
    const km = getDistanceKmValue(distance);
    if (!marathon || seconds == null || km == null) return;
    const current = byDistance.get(distance);
    const raceDate = String(marathon.race_date || "9999-12-31");
    const currentDate = String(current?.race_date || "9999-12-31");
    if (!current || seconds < Number(current.time_seconds) ||
        (seconds === Number(current.time_seconds) && raceDate < currentDate)) {
      byDistance.set(distance, {
        id: `derived-${reg.id}`,
        runner_id: runnerId,
        distance,
        time_seconds: seconds,
        pace_seconds_per_km: seconds / km,
        race_date: marathon.race_date,
        race_name: marathon.name,
        location: marathon.location,
        is_new_pr: true,
        derived: true,
      });
    }
  });

  // Preserve manually recorded PRs only for distances that have no timed
  // result yet. Historical results always win when they exist.
  state.personalRecords
    .filter((pr) => pr && typeof pr === "object" && pr.runner_id === runnerId)
    .forEach((pr) => {
    const distance = normalizeDistanceLabel(pr.distance);
    if (!byDistance.has(distance)) byDistance.set(distance, { ...pr, distance });
  });
  return [...byDistance.values()].sort((a, b) => String(a.distance).localeCompare(String(b.distance)));
}

/** Compute performance stats for a runner from race results + PRs. */
function computeRunnerStats(runnerId) {
  const regs = regsForRunner(runnerId).filter((r) => displayFinishTime(r));
  const timed = [];
  const now = new Date();
  const threeMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate());
  const yearStart = new Date(now.getFullYear(), 0, 1);

  for (const r of regs) {
    const marathon = getMarathon(r.marathon_id);
    if (!marathon) continue;
    const seconds = bestFinishSeconds(r);
    if (seconds == null) continue;
    const km = getDistanceKmValue(registrationDistance(r, marathon));
    if (km == null) continue;
    const date = new Date(String(marathon.race_date).slice(0, 10) + "T12:00:00");
    timed.push({ reg: r, marathon, seconds, km, date });
  }

  const bestPace = timed.length
    ? Math.min(...timed.map((t) => t.seconds / t.km))
    : null;
  const recent = timed.filter((t) => t.date >= threeMonthsAgo);
  const avgPace3mo = recent.length
    ? recent.reduce((sum, t) => sum + t.seconds / t.km, 0) / recent.length
    : null;
  const thisYear = timed.filter((t) => t.date >= yearStart);
  const totalDistanceYear = thisYear.reduce((sum, t) => sum + t.km, 0);
  const totalDistanceAll = timed.reduce((sum, t) => sum + t.km, 0);
  const totalRunsYear = thisYear.length;
  const longestRun = timed.length ? Math.max(...timed.map((t) => t.km)) : null;

  // Highest weekly volume: group finishes by week
  let highestWeekly = 0;
  const weekMap = new Map();
  for (const t of timed) {
    const weekStart = new Date(t.date);
    const day = (weekStart.getDay() + 6) % 7;
    weekStart.setDate(weekStart.getDate() - day);
    weekStart.setHours(0, 0, 0, 0);
    const key = weekStart.toISOString().slice(0, 10);
    weekMap.set(key, (weekMap.get(key) || 0) + t.km);
  }
  weekMap.forEach((v) => { if (v > highestWeekly) highestWeekly = v; });

  return {
    bestPace,
    avgPace3mo,
    totalDistanceYear,
    totalDistanceAll,
    totalRunsYear,
    longestRun,
    highestWeekly,
  };
}

/** Consistency streak: consecutive months (ending now or last month) with a race result. */
function computeStreak(runnerId) {
  const months = new Set();
  for (const r of regsForRunner(runnerId)) {
    const marathon = getMarathon(r.marathon_id);
    if (!marathon || !displayFinishTime(r)) continue;
    const d = new Date(String(marathon.race_date).slice(0, 10) + "T12:00:00");
    months.add(`${d.getFullYear()}-${d.getMonth()}`);
  }
  if (!months.size) return 0;
  const keys = [...months].sort();
  const now = new Date();
  const thisKey = `${now.getFullYear()}-${now.getMonth()}`;
  const lastKey = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastKeyStr = `${lastKey.getFullYear()}-${lastKey.getMonth()}`;
  let idx = keys.length - 1;
  if (keys[idx] !== thisKey && keys[idx] !== lastKeyStr) return 0;
  let streak = 1;
  for (let i = idx - 1; i >= 0; i--) {
    const prev = new Date(keys[i].split("-")[0], +keys[i].split("-")[1], 1);
    const cur = new Date(keys[i + 1].split("-")[0], +keys[i + 1].split("-")[1], 1);
    const diff = Math.round((cur - prev) / 86400000);
    if (diff <= 40) streak++;
    else break;
  }
  return streak;
}

/** Auto-derive pace group from best PR pace. */
function derivePaceGroup(prs) {
  const timed = prs
    .filter((pr) => pr && typeof pr === "object")
    .map((pr) => ({ dist: pr.distance, pace: pr.pace_seconds_per_km }))
    .filter((x) => x.pace != null && Number.isFinite(Number(x.pace)) && Number(x.pace) >= 0)
    .sort((a, b) => a.pace - b.pace);
  if (!timed.length) return "";
  const best = timed[0].pace; // seconds per km
  const pref = timed[0].dist;
  if (best < 210) return "Sub-3:30";
  if (best < 240) return "Sub-4:00";
  if (best < 270) return "Sub-4:30";
  if (best < 300) return "4:30–5:00";
  if (best < 330) return "5:00–5:30";
  if (best < 360) return "5:30–6:00";
  return "6:00+";
}

/** Compute badges for a runner. */
function computeBadges(runnerId) {
  // Badge awards are system-owned. The database backfill/trigger is the
  // source of truth; do not re-award browser-only badges from partial state.
  const systemLabels = {
    first_race: ["First Race", "🏁"],
    new_personal_record: ["New Personal Record", "🏅"],
    first_10k: ["First 10K", "🏃"],
    first_half_marathon: ["First Half Marathon", "🎖"],
    first_marathon: ["First Marathon", "🎖"],
    sub_5_marathon: ["Sub-5:00 Marathon", "⚡"],
    sub_4_marathon: ["Sub-4:00 Marathon", "⚡"],
    five_races: ["5 Races Completed", "🏁"],
    ten_races: ["10 Races Completed", "🏆"],
    "1000km": ["1000 km Club", "🏅"],
  };
  const storedBadges = state.runnerBadges
    .filter((badge) => badge.runner_id === runnerId)
    .map((badge) => {
      const [label, icon] = systemLabels[badge.badge_key] || [badge.badge_key.replaceAll("_", " "), "🏅"];
      return { key: badge.badge_key, label, icon, awardedAt: badge.awarded_at };
    });
  const regs = regsForRunner(runnerId);
  const finished = regs.filter((reg) => {
    return reg.status === "completed" || reg.status === "dnf" || bestFinishSeconds(reg) != null;
  });
  const prs = getRunnerPRs(runnerId);
  const earned = new Set(storedBadges.map((badge) => badge.key));
  const add = (key) => {
    if (earned.has(key)) return;
    const [label, icon] = systemLabels[key] || [key.replaceAll("_", " "), "🏅"];
    storedBadges.push({ key, label, icon, auto: true });
    earned.add(key);
  };
  if (finished.length) add("first_race");
  const canonicalPRs = new Set(canonicalPRRegistrations());
  if (finished.some((reg) => canonicalPRs.has(reg.id) || reg.is_pr)) add("new_personal_record");
  const distances = new Set(finished.map((reg) => registrationDistance(reg, getMarathon(reg.marathon_id))));
  if (distances.has("10K")) add("first_10k");
  if (distances.has("Half Marathon")) add("first_half_marathon");
  if (distances.has("Marathon")) add("first_marathon");
  const marathonPR = prs.find((pr) => pr.distance === "Marathon");
  if (marathonPR?.time_seconds < 18000) add("sub_5_marathon");
  if (marathonPR?.time_seconds < 14400) add("sub_4_marathon");
  if (finished.length >= 5) add("five_races");
  if (finished.length >= 10) add("ten_races");
  const totalKm = finished.reduce((total, reg) => total + (getDistanceKmValue(registrationDistance(reg, getMarathon(reg.marathon_id))) || 0), 0);
  if (totalKm >= 1000) add("1000km");
  return storedBadges;

  /* Legacy browser badge derivation retained below for reference; the
     system-backed result above is returned before this compatibility block. */
  const legacyBadges = [];
  const legacyRegs = regsForRunner(runnerId);
  const legacyTimed = legacyRegs.filter((r) => displayFinishTime(r));
  const legacyPrs = getRunnerPRs(runnerId);
  const legacyStored = state.runnerBadges.filter((badge) => badge.runner_id === runnerId);
  const storedLabels = {
    new_personal_record: ["New Personal Record", "🏅"],
    first_10k: ["First 10K", "🏃"],
    first_half_marathon: ["First Half Marathon", "🎖"],
    first_marathon: ["First Marathon", "🎖"],
    sub_5_marathon: ["Sub-5:00 Marathon", "⚡"],
    sub_4_marathon: ["Sub-4:00 Marathon", "⚡"],
    five_races: ["5 Races Completed", "🏁"],
    ten_races: ["10 Races Completed", "🏆"],
  };

  const marathonFinish = timed.find((r) => {
    const m = getMarathon(r.marathon_id);
    return m?.distance === "Marathon";
  });
  if (marathonFinish) badges.push({ key: "first_marathon", label: "First Marathon", icon: "🎖" });

  const legacyMarathonPR = legacyPrs.find((pr) => pr.distance === "Marathon" && pr.time_seconds != null);
  if (legacyMarathonPR && legacyMarathonPR.time_seconds < 14400) {
    badges.push({ key: "sub4", label: "Sub-4 Marathon", icon: "⚡" });
  }

  const legacyTotalKm = legacyTimed.reduce((sum, r) => {
    const m = getMarathon(r.marathon_id);
    const km = getDistanceKmValue(registrationDistance(r, m));
    return sum + (km || 0);
  }, 0);
  if (totalKm >= 1000) badges.push({ key: "1000km", label: "1000 km Club", icon: "🏅" });

  const halfPR = prs.find((pr) => pr.distance === "Half Marathon" && pr.time_seconds != null);
  if (halfPR && halfPR.time_seconds < 5400) {
    badges.push({ key: "sub1h30", label: "Sub-1:30 Half", icon: "🚀" });
  }
  const tenKPR = prs.find((pr) => pr.distance === "10K" && pr.time_seconds != null);
  if (tenKPR && tenKPR.time_seconds < 2700) {
    badges.push({ key: "sub45_10k", label: "Sub-45 10K", icon: "🔥" });
  }
  if (badges.length) badges.push({ key: "first_race", label: "First Race", icon: "🏁", auto: true });
  const known = new Set(badges.map((badge) => badge.key));
  stored.forEach((badge) => {
    if (known.has(badge.badge_key)) return;
    const [label, icon] = storedLabels[badge.badge_key] || [badge.badge_key.replaceAll("_", " "), "🏅"];
    badges.push({ key: badge.badge_key, label, icon, awardedAt: badge.awarded_at });
  });
  return badges;
}

function formatPace(paceSecondsPerKm) {
  if (paceSecondsPerKm == null) return "—";
  return formatSeconds(paceSecondsPerKm) + " /km";
}

function formatDistance(km) {
  if (km == null) return "—";
  if (km >= 42.195) return `${(km / 42.195).toFixed(2)} marathons`;
  if (km >= 21.0975) return `${(km / 21.0975).toFixed(1)} HM`;
  return `${km.toFixed(1)} km`;
}

function monthShortYear(iso) {
  if (!iso) return "—";
  const d = new Date(String(iso).slice(0, 10) + "T12:00:00");
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

function profileStatCard(label, value, hint) {
  return `
    <div class="profile-stat-card">
      <p class="profile-stat-label">${escapeHtml(label)}</p>
      <p class="profile-stat-value">${value}</p>
      ${hint ? `<p class="profile-stat-hint">${hint}</p>` : ""}
    </div>`;
}

function setProfileTab(tab) {
  const valid = ["overview", "analytics", "records", "badges", "history", "certificates", "settings"];
  activeProfileTab = valid.includes(tab) ? tab : "overview";
  document.querySelectorAll("[data-profile-tab]").forEach((button) => {
    const selected = button.dataset.profileTab === activeProfileTab;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-selected", selected ? "true" : "false");
  });
  document.querySelectorAll("[data-profile-panel]").forEach((panel) => {
    const selected = panel.dataset.profilePanel === activeProfileTab;
    panel.hidden = !selected;
    panel.classList.toggle("is-active", selected);
  });
}

function getProfileTimedResults(runnerId) {
  return regsForRunner(runnerId)
    .map((reg) => {
      const marathon = getMarathon(reg.marathon_id);
      const seconds = bestFinishSeconds(reg);
      const km = marathon ? getDistanceKmValue(registrationDistance(reg, marathon)) : null;
      if (!marathon || seconds == null || km == null) return null;
      const date = new Date(`${String(marathon.race_date || "").slice(0, 10)}T12:00:00`);
      return { reg, marathon, seconds, km, date, pace: seconds / km };
    })
    .filter(Boolean)
    .sort((a, b) => a.date - b.date);
}

function renderProfileAnalytics(runnerId) {
  const results = getProfileTimedResults(runnerId);
  const registrations = regsForRunner(runnerId);
  const completed = results.length;
  const summary = document.getElementById("profile-summary");
  const stats = computeRunnerStats(runnerId);
  if (summary) {
    summary.innerHTML = [
      ["Completed races", `${completed} of ${registrations.length}`],
      ["Current focus", results.length ? `${formatPace(results[results.length - 1].pace)} recent pace` : "Log a result to start tracking"],
      ["Longest completed distance", formatDistance(stats.longestRun)],
      ["Consistency", computeStreak(runnerId) ? `${computeStreak(runnerId)}-month activity streak` : "Build a streak by racing regularly"],
    ].map(([label, value]) => `<div class="profile-summary-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("");
  }

  const trend = document.getElementById("profile-pace-trend");
  if (trend) {
    const points = results.slice(-8);
    if (!points.length) trend.innerHTML = `<p class="profile-chart-empty">Complete a timed race to see your pace trend.</p>`;
    else {
      const paces = points.map((point) => point.pace);
      const fastest = Math.min(...paces), slowest = Math.max(...paces);
      trend.innerHTML = points.map((point) => {
        const ratio = slowest === fastest ? 0.7 : 0.28 + ((slowest - point.pace) / (slowest - fastest)) * 0.72;
        return `<div class="profile-trend-item" title="${escapeHtml(point.marathon.name)}"><span class="profile-trend-value">${escapeHtml(formatPace(point.pace))}</span><span class="profile-trend-bar" style="height:${Math.round(ratio * 100)}%"></span><span class="profile-trend-label">${escapeHtml(monthShortYear(point.marathon.race_date))}</span></div>`;
      }).join("");
    }
  }

  const progression = document.getElementById("profile-pr-progression");
  if (progression) {
    const canonicalPRs = canonicalPRRegistrations();
    const prRows = results.filter((point) => point.reg.is_pr || canonicalPRs.has(point.reg.id));
    const grouped = {};
    prRows.forEach((point) => { (grouped[registrationDistance(point.reg, point.marathon)] ||= []).push(point); });
    const distances = Object.keys(grouped);
    progression.innerHTML = distances.length ? distances.map((distance) => {
      const points = grouped[distance].slice(-5);
      return `<div class="profile-pr-progress-row"><strong>${escapeHtml(distance)}</strong><div class="profile-pr-progress-points">${points.map((point) => `<span title="${escapeHtml(monthShortYear(point.marathon.race_date))}">${escapeHtml(displayFinishTime(point.reg) || formatSeconds(point.seconds))}</span>`).join("<i>→</i>")}</div></div>`;
    }).join("") : `<p class="profile-chart-empty">Your PR progression will appear after your first detected personal record.</p>`;
  }

  const completion = document.getElementById("profile-completion");
  if (completion) {
    const percent = registrations.length ? Math.round((completed / registrations.length) * 100) : 0;
    completion.innerHTML = `<div class="profile-progress-percent">${percent}%</div><div class="profile-progress-track"><div class="profile-progress-fill" style="width:${percent}%"></div></div><div class="profile-progress-meta"><span>${completed} finished</span><span>${registrations.length - completed} pending / incomplete</span></div>`;
  }

  const mix = document.getElementById("profile-distance-mix");
  if (mix) {
    const counts = {};
    results.forEach((point) => {
      const distance = registrationDistance(point.reg, point.marathon);
      counts[distance] = (counts[distance] || 0) + 1;
    });
    const preferredOrder = ["5K", "7.5K", "10K", "15K", "Half Marathon", "Marathon", "Ultra", "Other"];
    const distances = [...new Set([...preferredOrder, ...Object.keys(counts)])]
      .filter((distance) => counts[distance] || Object.keys(counts).length === 0);
    const rows = distances.map((distance) => [distance, counts[distance] || 0]);
    const max = Math.max(1, ...rows.map(([, count]) => count));
    mix.innerHTML = rows.map(([distance, count]) => `<div class="profile-bar-row"><span>${escapeHtml(distance)}</span><span class="profile-bar-track"><span class="profile-bar-fill" style="width:${(count / max) * 100}%"></span></span><span class="profile-bar-count">${count}</span></div>`).join("");
  }

  const recent = document.getElementById("profile-recent-form");
  if (recent) {
    const points = results.slice(-5).reverse();
    recent.innerHTML = points.length ? points.map((point) => `<div class="profile-form-row"><span class="profile-form-race" title="${escapeHtml(point.marathon.name)}">${escapeHtml(point.marathon.name)}</span><span class="profile-form-meta">${escapeHtml(registrationDistance(point.reg, point.marathon))} · ${escapeHtml(monthShortYear(point.marathon.race_date))}</span><span class="profile-form-time">${escapeHtml(displayFinishTime(point.reg) || "—")}</span></div>`).join("") : `<p class="profile-chart-empty">Your recent finishes will appear here.</p>`;
  }

  const monthly = document.getElementById("profile-monthly-activity");
  if (monthly) {
    const now = new Date();
    const months = Array.from({ length: 12 }, (_, index) => new Date(now.getFullYear(), now.getMonth() - 11 + index, 1));
    const monthCounts = months.map((month) => {
      const key = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}`;
      return results.filter((point) => `${point.date.getFullYear()}-${String(point.date.getMonth() + 1).padStart(2, "0")}` === key).length;
    });
    const max = Math.max(1, ...monthCounts);
    monthly.innerHTML = months.map((month, index) => `<div class="profile-month-item"><span class="profile-month-count">${monthCounts[index] || ""}</span><span class="profile-month-bar" style="height:${Math.max(4, (monthCounts[index] / max) * 100)}%"></span><span class="profile-month-label">${month.toLocaleDateString(undefined, { month: "short" }).slice(0, 3)}</span></div>`).join("");
  }
}

function getShareSlug(runner) {
  if (runner?.share_slug) return runner.share_slug;
  return runner?.id || "";
}

function shareLinkFor(runner) {
  const base = window.location.origin + window.location.pathname;
  return `${base}?runner=${encodeURIComponent(getShareSlug(runner))}`;
}

// ─── Profile rendering ───────────────────────────────────────────────────────

function renderProfile() {
  if (!profile && !session) return;
  setProfileTab(activeProfileTab);
  const name = profile?.display_name || session.user.user_metadata?.display_name || "";
  const email = profile?.email || session.user.email || "";
  const image = profileImageUrl(profile);
  const myRunner = getMyRunner();

  // Edit form
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

  // Join date + pace group
  const joinDateInput = document.getElementById("profile-join-date");
  if (joinDateInput) joinDateInput.value = myRunner?.join_date || "";
  const paceGroupSelect = document.getElementById("profile-pace-group");
  if (paceGroupSelect && myRunner) paceGroupSelect.value = myRunner.pace_group || "";

  // Header
  const headerAvatar = document.getElementById("profile-header-avatar");
  if (headerAvatar) {
    headerAvatar.innerHTML = renderProfileAvatar({ image_url: image }, name || "You", session.user.id);
  }
  document.getElementById("profile-header-name").textContent = name || "You";
  const paceGroup = myRunner?.pace_group || derivePaceGroup(getRunnerPRs(myRunner?.id)) || "No pace group yet";
  const paceEl = document.getElementById("profile-header-pace");
  if (paceEl) paceEl.textContent = paceGroup ? `Pace group: ${paceGroup}` : "Pace group: —";
  document.getElementById("profile-join-date-label")?.remove();
  const joinDateText = myRunner?.join_date ? formatDate(myRunner.join_date) : "Joined —";
  const joinDateMeta = document.getElementById("profile-join-date-meta");
  if (joinDateMeta) joinDateMeta.textContent = `Joined: ${joinDateText}`;
  const streak = computeStreak(myRunner?.id);
  const streakEl = document.getElementById("profile-streak");
  if (streakEl) {
    streakEl.textContent = streak > 0 ? `${streak}-month streak` : "No streak yet";
  }

  // Public toggle
  const publicToggle = document.getElementById("profile-public-toggle");
  if (publicToggle) publicToggle.checked = !!myRunner?.public_profile_enabled;

  // Stats
  const stats = computeRunnerStats(myRunner?.id);
  const statsGrid = document.getElementById("profile-stats-grid");
  if (statsGrid) {
    const statMap = [
      profileStatCard("Best Pace (lifetime)", formatPace(stats.bestPace), "Fastest race pace"),
      profileStatCard("Avg Pace (3 months)", formatPace(stats.avgPace3mo), "Recent race pace"),
      profileStatCard("Total Distance (year)", formatDistance(stats.totalDistanceYear), `All time: ${formatDistance(stats.totalDistanceAll)}`),
      profileStatCard("Total Runs (year)", String(stats.totalRunsYear), "Race finishes"),
      profileStatCard("Longest Run", formatDistance(stats.longestRun), "Longest race"),
      profileStatCard("Highest Weekly Volume", formatDistance(stats.highestWeekly), "Most km in one week"),
    ];
    statsGrid.innerHTML = statMap.join("");
  }

  renderProfileAnalytics(myRunner?.id);

  // PRs
  const prs = getRunnerPRs(myRunner?.id).filter((pr) => pr && typeof pr === "object");
  const prTbody = document.getElementById("profile-pr-tbody");
  if (prTbody) {
    if (!prs.length) {
      prTbody.innerHTML = `<tr><td colspan="6"><div class="empty" style="border:none;margin:0.5rem"><strong>No PRs yet</strong>Complete a race and your best time will appear here automatically.</div></td></tr>`;
    } else {
      const newestPrId = prs.slice().sort((a, b) => String(b.race_date || "").localeCompare(String(a.race_date || "")))[0]?.id;
      // Imported/manual PR rows may be incomplete. Keep them visible, but
      // Only compare rows that have a numeric pace. Incomplete rows remain
      // visible with the normal fallback formatting.
      const pacedPrs = prs.filter((pr) =>
        pr.pace_seconds_per_km != null &&
        Number.isFinite(Number(pr.pace_seconds_per_km)) &&
        Number(pr.pace_seconds_per_km) >= 0
      );
      const fastest = pacedPrs.length
        ? pacedPrs.reduce((fastestPr, pr) =>
            Number(pr.pace_seconds_per_km) < Number(fastestPr.pace_seconds_per_km) ? pr : fastestPr
          )
        : null;
      prTbody.innerHTML = prs.map((pr) => {
        const isFastest = pr.id === fastest?.id;
        const isNew = pr.is_new_pr || pr.derived || pr.id === newestPrId;
        return `
          <tr class="${isFastest ? "pr-fastest" : ""}">
            <td>${escapeHtml(pr.distance)}${isFastest ? ' <span class="pr-trophy">🏆</span>' : ""}</td>
            <td class="time-mono">${formatSeconds(pr.time_seconds)}</td>
            <td class="time-mono">${formatPace(pr.pace_seconds_per_km)}</td>
            <td>${monthShortYear(pr.race_date)}</td>
            <td>${escapeHtml(pr.race_name || "—")}${pr.location ? ` <span class="text-dim">· ${escapeHtml(pr.location)}</span>` : ""}</td>
            <td>
              ${isNew ? `<span class="badge badge-pr">New PR</span>` : ""}
            </td>
          </tr>`;
      }).join("");
    }
  }

  // Race history
  const historyEl = document.getElementById("profile-race-history");
  if (historyEl) {
    const races = regsForRunner(myRunner?.id)
      .map((r) => ({ r, marathon: getMarathon(r.marathon_id) }))
      .filter((x) => x.marathon)
      .sort((a, b) => String(b.marathon.race_date || "").localeCompare(String(a.marathon.race_date || "")) || String(b.r.id).localeCompare(String(a.r.id)));
    if (!races.length) {
      historyEl.innerHTML = `<div class="empty"><strong>No race history yet</strong>Log a result to see it here.</div>`;
    } else {
      historyEl.innerHTML = races.map(({ r, marathon }) => {
        const pace = paceForRegistration(r, marathon);
        return `
          <div class="list-item">
            <div class="list-item-main">
              <p class="list-item-title">${escapeHtml(marathon.name)}</p>
              <p class="list-item-sub">${formatDate(marathon.race_date)} · ${escapeHtml(registrationDistance(r, marathon))}${pace ? ` · ${pace.perKm}/km` : ""}</p>
            </div>
            <div style="display:flex;gap:0.45rem;align-items:center">
              ${(r.is_pr || canonicalPRRegistrations().has(r.id)) ? `<span class="badge badge-pr">PR</span>` : ""}
              <span class="time-mono">${escapeHtml(displayFinishTime(r) || "—")}</span>
              ${r.place_overall ? `<span class="badge badge-count">#${escapeHtml(r.place_overall)}</span>` : ""}
            </div>
          </div>`;
      }).join("");
    }
  }

  // Badges
  const badgesEl = document.getElementById("profile-badges");
  if (badgesEl) {
    const badges = computeBadges(myRunner?.id);
    if (!badges.length) {
      badgesEl.innerHTML = `<p class="panel-hint">Earn badges by finishing races (First Marathon, Sub-4, 1000 km Club…).</p>`;
    } else {
      badgesEl.innerHTML = badges.map((b) => `
        <div class="profile-badge">
          <span class="profile-badge-icon">${b.icon}</span>
          <span>${escapeHtml(b.label)}</span>
        </div>`).join("");
    }
  }

  renderProfileCertificates(myRunner);
}

// ─── PR CRUD ─────────────────────────────────────────────────────────────────

function openPrForm(prId) {
  const myRunner = getMyRunner();
  if (!myRunner) return toast("No linked runner profile", "error");
  const existing = prId ? state.personalRecords.find((pr) => pr.id === prId) : null;
  const distanceOptions = DISTANCES.map(
    (d) => `<option value="${d}" ${existing?.distance === d ? "selected" : ""}>${d}</option>`
  ).join("");

  openModal({
    title: existing ? "Edit PR" : "Add PR",
    bodyHtml: `
      <form class="form-grid">
        <div class="field">
          <label for="pr-distance">Distance *</label>
          <select class="select full" id="pr-distance">${distanceOptions}</select>
          <p class="panel-hint" style="margin:0.35rem 0 0">Pace is computed automatically from time + distance.</p>
        </div>
        <div class="field">
          <label for="pr-time">Time *</label>
          <input class="input" id="pr-time" value="${existing ? formatSeconds(existing.time_seconds) : ""}" placeholder="e.g. 22:18 or 1:48:32" required />
        </div>
        <div class="form-row">
          <div class="field">
            <label for="pr-date">Date</label>
            <input class="input" type="date" id="pr-date" value="${escapeHtml(existing?.race_date || "")}" />
          </div>
          <div class="field">
            <label for="pr-location">Location</label>
            <input class="input" id="pr-location" value="${escapeHtml(existing?.location || "")}" placeholder="e.g. Dhaka" />
          </div>
        </div>
        <div class="field">
          <label for="pr-name">Race / Event name</label>
          <input class="input" id="pr-name" value="${escapeHtml(existing?.race_name || "")}" placeholder="e.g. Dhaka Night Run" />
        </div>
        <div class="pace-preview" id="pr-pace-preview"></div>
      </form>`,
    footerHtml: `
      <button class="btn btn-ghost" id="pr-cancel">Cancel</button>
      <button class="btn btn-primary" id="pr-save">Save PR</button>`,
    onMount() {
      const pacePreview = document.getElementById("pr-pace-preview");
      const updatePace = () => {
        const dist = document.getElementById("pr-distance").value;
        const km = DISTANCE_KM[dist];
        const sec = parseTimeToSeconds(document.getElementById("pr-time").value);
        if (km && sec != null) {
          pacePreview.textContent = `Pace: ${formatSeconds(sec / km)}/km`;
        } else {
          pacePreview.textContent = "";
        }
      };
      ["pr-distance", "pr-time"].forEach((id) => {
        document.getElementById(id)?.addEventListener("input", updatePace);
        document.getElementById(id)?.addEventListener("change", updatePace);
      });
      updatePace();

      document.getElementById("pr-cancel").onclick = closeModal;
      document.getElementById("pr-save").onclick = async () => {
        const dist = document.getElementById("pr-distance").value;
        const seconds = parseTimeToSeconds(document.getElementById("pr-time").value);
        if (!dist) return toast("Distance required", "error");
        if (seconds == null) return toast("Time format not recognized", "error");
        const km = DISTANCE_KM[dist];
        if (km == null) return toast("Pace cannot be computed for that distance", "error");

        const payload = {
          group_id: group.id,
          runner_id: myRunner.id,
          distance: dist,
          time_seconds: seconds,
          pace_seconds_per_km: seconds / km,
          race_date: document.getElementById("pr-date").value || null,
          race_name: document.getElementById("pr-name").value.trim(),
          location: document.getElementById("pr-location").value.trim(),
          is_new_pr: true,
          created_by: session.user.id,
        };

        try {
          if (existing) {
            delete payload.created_by;
            const { error } = await sb.from("personal_records").update(payload).eq("id", existing.id);
            if (error) throw error;
          } else {
            const { error } = await sb.from("personal_records").insert(payload);
            if (error) throw error;
          }
          closeModal();
          toast("PR saved");
          await loadGroupData();
          renderProfile();
          updatePaceGroupAuto();
        } catch (e) {
          toast(errMsg(e), "error");
        }
      };
    },
  });
}

async function updatePaceGroupAuto() {
  const myRunner = getMyRunner();
  if (!myRunner || !group) return;
  // Only auto-update if the user hasn't set a manual pace group different from auto
  const prs = getRunnerPRs(myRunner.id);
  const auto = derivePaceGroup(prs);
  if (!myRunner.pace_group || myRunner.pace_group === auto) {
    if (myRunner.pace_group !== auto) {
      const { error } = await sb.from("runners").update({ pace_group: auto }).eq("id", myRunner.id);
      if (!error) myRunner.pace_group = auto;
    }
  }
}

async function deletePr(id) {
  const myRunner = getMyRunner();
  if (!myRunner) return;
  openModal({
    title: "Delete PR?",
    bodyHtml: `<p>Remove this personal record?</p>`,
    footerHtml: `
      <button class="btn btn-ghost" id="del-cancel">Cancel</button>
      <button class="btn btn-danger" id="del-confirm">Delete</button>`,
    onMount() {
      document.getElementById("del-cancel").onclick = closeModal;
      document.getElementById("del-confirm").onclick = async () => {
        try {
          const { error } = await sb.from("personal_records").delete().eq("id", id);
          if (error) throw error;
          closeModal();
          toast("PR deleted");
          await loadGroupData();
          renderProfile();
          updatePaceGroupAuto();
        } catch (e) {
          toast(errMsg(e), "error");
        }
      };
    },
  });
}

// ─── Share / public toggle ───────────────────────────────────────────────────

async function togglePublicProfile() {
  const myRunner = getMyRunner();
  if (!myRunner || !group) return;
  const enabled = !!document.getElementById("profile-public-toggle")?.checked;
  let payload = { public_profile_enabled: enabled };
  if (enabled && !myRunner.share_slug) {
    payload.share_slug = (myRunner.id || "").slice(0, 8) + Math.random().toString(36).slice(2, 8);
  }
  try {
    const { error } = await sb.from("runners").update(payload).eq("id", myRunner.id);
    if (error) throw error;
    Object.assign(myRunner, payload);
    toast(enabled ? "Profile is now visible to members" : "Profile hidden from members");
  } catch (e) {
    toast(errMsg(e), "error");
    document.getElementById("profile-public-toggle").checked = !enabled;
  }
}

async function copyShareLink() {
  const myRunner = getMyRunner();
  if (!myRunner) return toast("No linked runner profile", "error");
  const link = shareLinkFor(myRunner);
  try {
    await navigator.clipboard.writeText(link);
    toast("Share link copied to clipboard");
  } catch (e) {
    prompt("Copy this share link:", link);
  }
}

// ─── Runner public profile detail (from Runners menu) ────────────────────────

function openRunnerProfileDetail(runnerId) {
  const runner = getRunner(runnerId);
  if (!runner) return;
  if (!canViewRunnerProfile(runner)) {
    toast("This runner's profile is not public", "error");
    return;
  }
  const me = getMyRunner();
  const prs = getRunnerPRs(runnerId);
  const stats = computeRunnerStats(runnerId);
  const streak = computeStreak(runnerId);
  const badges = computeBadges(runnerId);
  const paced = derivePaceGroup(prs) || runner.pace_group || "—";

  openModal({
    title: "Runner Profile",
    wide: true,
    bodyHtml: `
      <div class="runner-profile-detail">
        <div class="runner-profile-head">
          ${renderProfileAvatar({ image_url: runner.image_url }, runner.name, runner.id)}
          <div>
            <h3>${escapeHtml(runner.name)}</h3>
            <p class="profile-header-pace">Pace group: ${escapeHtml(paced)}</p>
            <p class="panel-hint" style="margin:0.2rem 0 0">
              ${runner.join_date ? `Joined ${formatDate(runner.join_date)}` : ""}
              ${streak > 0 ? ` · ${streak}-month streak` : ""}
            </p>
          </div>
        </div>

        <div class="profile-stats-grid" style="margin-top:1rem">
          ${profileStatCard("Best Pace", formatPace(stats.bestPace), "Lifetime")}
          ${profileStatCard("Avg Pace (3mo)", formatPace(stats.avgPace3mo), "Recent")}
          ${profileStatCard("Distance (year)", formatDistance(stats.totalDistanceYear), `All: ${formatDistance(stats.totalDistanceAll)}`)}
          ${profileStatCard("Races (year)", String(stats.totalRunsYear), "Finishes")}
          ${profileStatCard("Longest Run", formatDistance(stats.longestRun), "")}
          ${profileStatCard("Weekly Volume", formatDistance(stats.highestWeekly), "Best week")}
        </div>

        <h4 style="margin:1.25rem 0 0.5rem">Personal Records</h4>
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>Distance</th><th>Time</th><th>Pace</th><th>Date</th><th>Race / Location</th></tr></thead>
            <tbody>
              ${prs.length ? prs.map((pr) => `
                <tr>
                  <td>${escapeHtml(pr.distance)}</td>
                  <td class="time-mono">${formatSeconds(pr.time_seconds)}</td>
                  <td class="time-mono">${formatPace(pr.pace_seconds_per_km)}</td>
                  <td>${monthShortYear(pr.race_date)}</td>
                  <td>${escapeHtml(pr.race_name || "—")}</td>
                </tr>`).join("")
              : `<tr><td colspan="5"><div class="empty" style="border:none;margin:0.5rem">No PRs yet</div></td></tr>`}
            </tbody>
          </table>
        </div>

        ${badges.length ? `
          <h4 style="margin:1.25rem 0 0.5rem">Badges</h4>
          <div class="profile-badges">
            ${badges.map((b) => `<div class="profile-badge"><span class="profile-badge-icon">${b.icon}</span><span>${escapeHtml(b.label)}</span></div>`).join("")}
          </div>` : ""}

        ${me && me.id !== runnerId ? `
          <div class="room-actions" style="margin-top:1.25rem">
            <button class="btn btn-secondary btn-sm" id="btn-compare-with-me">⚖ Compare with me</button>
            <button class="btn btn-ghost btn-sm" id="btn-copy-runner-link">🔗 Copy link</button>
          </div>` : ""}
      </div>`,
    onMount() {
      const compareBtn = document.getElementById("btn-compare-with-me");
      if (compareBtn) {
        compareBtn.onclick = () => openCompareModal(runnerId);
      }
      const copyLinkBtn = document.getElementById("btn-copy-runner-link");
      if (copyLinkBtn) {
        copyLinkBtn.onclick = async () => {
          try {
            await navigator.clipboard.writeText(shareLinkFor(runner));
            toast("Link copied");
          } catch (e) {
            prompt("Copy link:", shareLinkFor(runner));
          }
        };
      }
    },
  });
}

function openCompareModal(runnerId) {
  const me = getMyRunner();
  const other = getRunner(runnerId);
  if (!me || !other) return;
  const myPRs = getRunnerPRs(me.id);
  const otherPRs = getRunnerPRs(runnerId);
  const distances = [...new Set([...myPRs.map((p) => p.distance), ...otherPRs.map((p) => p.distance)])];

  openModal({
    title: "Compare PRs",
    wide: true,
    bodyHtml: `
      <div class="compare-table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Distance</th>
              <th>${escapeHtml(me.name)}</th>
              <th>${escapeHtml(other.name)}</th>
            </tr>
          </thead>
          <tbody>
            ${distances.length ? distances.map((dist) => {
              const my = myPRs.find((p) => p.distance === dist);
              const ot = otherPRs.find((p) => p.distance === dist);
              const myTime = my ? formatSeconds(my.time_seconds) : "—";
              const otTime = ot ? formatSeconds(ot.time_seconds) : "—";
              return `<tr><td>${escapeHtml(dist)}</td><td class="time-mono">${myTime}</td><td class="time-mono">${otTime}</td></tr>`;
            }).join("") : `<tr><td colspan="3"><div class="empty" style="border:none;margin:0.5rem">No PRs to compare</div></td></tr>`}
          </tbody>
        </table>
      </div>`,
    footerHtml: `<button class="btn btn-ghost" id="cmp-close">Close</button>`,
    onMount() {
      document.getElementById("cmp-close").onclick = closeModal;
    },
  });
}

const NOTIFICATION_CHANNELS = [
  { key: "enable_new_marathon", label: "New race added", desc: "Notify all members when a new race is added", icon: "🏁" },
  { key: "enable_result_added", label: "Result logged", desc: "Notify all members when a result is entered", icon: "⏱" },
  { key: "enable_race_reminders", label: "Race reminders", desc: "Remind registered runners before race start", icon: "🔔" },
  { key: "enable_registration_nudge", label: "Registration nudge", desc: "Remind registered runners to confirm entry", icon: "📝" },
  { key: "enable_race_announcement", label: "Race announcement", desc: "Announce upcoming races to all members", icon: "📣" },
];

const SCHEDULE_CHANNEL_LABELS = {
  race_reminder: "Race reminder",
  registration_nudge: "Registration nudge",
  race_announcement: "Race announcement",
};

function renderNotifications() {
  const settingsPanel = document.getElementById("notification-settings-panel");
  const readonlyPanel = document.getElementById("notification-readonly-panel");
  if (!settingsPanel || !readonlyPanel) return;

  const isAdmin = canManageRoles();
  settingsPanel.hidden = !isAdmin;
  readonlyPanel.hidden = isAdmin;

  if (isAdmin) {
    renderNotificationSettingsForm();
  } else {
    renderNotificationReadonlySummary();
  }
}

function renderNotificationSettingsForm() {
  const channelList = document.getElementById("notification-channel-list");
  const tbody = document.getElementById("notification-schedule-tbody");
  if (!channelList || !tbody) return;

  const settings = state.notificationSettings || {};
  channelList.innerHTML = NOTIFICATION_CHANNELS.map((ch) => `
    <label class="notification-channel-item">
      <span class="notification-channel-icon">${ch.icon}</span>
      <span class="notification-channel-text">
        <strong>${escapeHtml(ch.label)}</strong>
        <small>${escapeHtml(ch.desc)}</small>
      </span>
      <input type="checkbox" class="notification-channel-toggle" data-channel="${ch.key}" ${settings[ch.key] !== false ? "checked" : ""} />
    </label>
  `).join("");

  const schedules = state.notificationSchedules || [];
  if (!schedules.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty" style="border:none;margin:0.5rem"><strong>No schedule points yet</strong>Add one below.</div></td></tr>`;
  } else {
    tbody.innerHTML = schedules.map((s) => `
      <tr data-schedule-id="${s.id}">
        <td>
          <select class="select" data-field="channel">
            ${Object.entries(SCHEDULE_CHANNEL_LABELS).map(([val, label]) => `<option value="${val}" ${s.channel === val ? "selected" : ""}>${label}</option>`).join("")}
          </select>
        </td>
        <td><input class="input" type="number" min="0" max="365" data-field="days_before" value="${s.days_before}" style="width:80px" /></td>
        <td><input class="input" type="number" min="0" max="23" data-field="hours_before" value="${s.hours_before}" style="width:80px" /></td>
        <td>
          <select class="select" data-field="frequency">
            <option value="once" ${s.frequency === "once" ? "selected" : ""}>Once</option>
            <option value="daily" ${s.frequency === "daily" ? "selected" : ""}>Daily</option>
          </select>
        </td>
        <td>
          <select class="select" data-field="relative_to">
            <option value="race_start" ${s.relative_to === "race_start" ? "selected" : ""}>Race start</option>
            <option value="registration_deadline" ${s.relative_to === "registration_deadline" ? "selected" : ""}>Reg deadline</option>
          </select>
        </td>
        <td><input type="checkbox" class="notification-channel-toggle" data-field="enabled" ${s.enabled ? "checked" : ""} /></td>
        <td><button class="btn btn-danger btn-sm" data-action="delete-schedule" data-id="${s.id}">Remove</button></td>
      </tr>
    `).join("");
  }

  // Wire up delete buttons
  tbody.querySelectorAll("[data-action='delete-schedule']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Remove this schedule point?")) return;
      const restoreButton = setButtonBusy(btn, "Removing…");
      try {
        const { error } = await sb.from("notification_schedules").delete().eq("id", btn.dataset.id);
        if (error) throw error;
        toast("Reminder schedule removed successfully.");
        await loadGroupData();
        renderNotifications();
      } catch (e) {
        operationFailed("Removing reminder schedule", e);
      } finally {
        restoreButton();
      }
    });
  });
}

function renderNotificationReadonlySummary() {
  const summary = document.getElementById("notification-readonly-summary");
  if (!summary) return;

  const settings = state.notificationSettings || {};
  const enabled = NOTIFICATION_CHANNELS.filter((ch) => settings[ch.key] !== false);
  const schedules = state.notificationSchedules || [];

  summary.innerHTML = `
    <div class="notification-readonly-list">
      <p class="panel-hint" style="margin:0 0 0.75rem"><strong>Enabled channels:</strong></p>
      <ul>
        ${enabled.length ? enabled.map((ch) => `<li>${ch.icon} ${escapeHtml(ch.label)}</li>`).join("") : `<li>No channels enabled</li>`}
      </ul>
      ${schedules.length ? `
        <p class="panel-hint" style="margin:1rem 0 0.75rem"><strong>Reminder cadence:</strong></p>
        <ul>
          ${schedules.map((s) => `<li>${escapeHtml(SCHEDULE_CHANNEL_LABELS[s.channel] || s.channel)} — ${s.days_before}d before at ${String(s.hours_before).padStart(2, "0")}:00 (${s.frequency})</li>`).join("")}
        </ul>
      ` : ""}
    </div>`;
}

async function saveNotificationSettings() {
  if (!canManageRoles()) return toast("Only admins can change notification settings", "error");
  if (!group?.id) return toast("No group loaded", "error");

  const settings = {};
  NOTIFICATION_CHANNELS.forEach((ch) => {
    const toggle = document.querySelector(`[data-channel="${ch.key}"]`);
    settings[ch.key] = toggle ? toggle.checked : true;
  });

  try {
    const { error } = await sb
      .from("group_notification_settings")
      .upsert({ group_id: group.id, ...settings });
    if (error) throw error;

    // Save schedule rows (update existing + insert newly added rows)
    const tbody = document.getElementById("notification-schedule-tbody");
    if (tbody) {
      const rows = tbody.querySelectorAll("tr[data-schedule-id]");
      for (const row of rows) {
        const id = row.dataset.scheduleId;
        const payload = {
          channel: row.querySelector('[data-field="channel"]').value,
          days_before: parseInt(row.querySelector('[data-field="days_before"]').value, 10) || 0,
          hours_before: parseInt(row.querySelector('[data-field="hours_before"]').value, 10) || 0,
          frequency: row.querySelector('[data-field="frequency"]').value,
          relative_to: row.querySelector('[data-field="relative_to"]').value,
          enabled: row.querySelector('[data-field="enabled"]').checked,
        };
        if (id === "new") {
          const { error: sErr } = await sb.from("notification_schedules").insert({
            group_id: group.id,
            ...payload,
          });
          if (sErr) throw sErr;
        } else {
          const { error: sErr } = await sb.from("notification_schedules").update(payload).eq("id", id);
          if (sErr) throw sErr;
        }
      }
    }

    toast("Notification settings updated successfully.");
    await loadGroupData();
    renderNotifications();
  } catch (e) {
    operationFailed("Saving notification settings", e);
  }
}

function addScheduleRow() {
  const tbody = document.getElementById("notification-schedule-tbody");
  if (!tbody) return;
  const row = document.createElement("tr");
  row.dataset.scheduleId = "new";
  row.innerHTML = `
    <td>
      <select class="select" data-field="channel">
        ${Object.entries(SCHEDULE_CHANNEL_LABELS).map(([val, label]) => `<option value="${val}">${label}</option>`).join("")}
      </select>
    </td>
    <td><input class="input" type="number" min="0" max="365" data-field="days_before" value="1" style="width:80px" /></td>
    <td><input class="input" type="number" min="0" max="23" data-field="hours_before" value="9" style="width:80px" /></td>
    <td>
      <select class="select" data-field="frequency">
        <option value="once">Once</option>
        <option value="daily">Daily</option>
      </select>
    </td>
    <td>
      <select class="select" data-field="relative_to">
        <option value="race_start">Race start</option>
        <option value="registration_deadline">Reg deadline</option>
      </select>
    </td>
    <td><input type="checkbox" class="notification-channel-toggle" data-field="enabled" checked /></td>
    <td><button class="btn btn-danger btn-sm" data-action="delete-schedule" data-id="new">Remove</button></td>
  `;
  tbody.appendChild(row);

  row.querySelector("[data-action='delete-schedule']").addEventListener("click", () => {
    row.remove();
  });
}

// ─── Community board ─────────────────────────────────────────────────────────

async function loadCommunityPosts() {
  if (!group?.id) {
    state.communityPosts = [];
    communityUnavailable = false;
    return;
  }
  try {
    const { data, error } = await sb
      .from("community_posts")
      .select("*")
      .eq("group_id", group.id)
      .order("created_at", { ascending: false });
    if (error) throw error;
    state.communityPosts = data || [];
    communityUnavailable = false;
  } catch (e) {
    // Table may not exist yet (community-schema.sql not run) — keep board empty
    console.warn("load community:", e);
    state.communityPosts = [];
    communityUnavailable = true;
  }
}

function getCommunityAuthor(post) {
  if (post?.runner_id) {
    const runner = getRunner(post.runner_id);
    if (runner) {
      return {
        name: runner.name || "Runner",
        image: runner.image_url || "",
        id: runner.id,
      };
    }
  }
  if (post?.user_id) {
    const runner = getRunnerForUser(post.user_id);
    if (runner) {
      return {
        name: runner.name || "Runner",
        image: runner.image_url || "",
        id: runner.id || post.user_id,
      };
    }
    const member = team.find((t) => t.user_id === post.user_id);
    if (member) {
      return {
        name: member.profile?.display_name || "Member",
        image: member.profile?.profile_picture_url || "",
        id: post.user_id,
      };
    }
  }
  return { name: "Member", image: "", id: post?.user_id || "unknown" };
}

function canManageCommunityPost(post) {
  if (!post) return false;
  const isAnnouncement = post.post_type === "announcement" || ["New personal record", "Badge unlocked", "Race results"].includes(post.title);
  if (isAnnouncement) return hasMinRole("admin");
  if (session?.user?.id && post.user_id === session.user.id) return true;
  return hasMinRole("moderator");
}

function communityTopics() {
  return (state.communityPosts || [])
    .filter((p) => {
      const announcement = p.post_type === "announcement" || ["New personal record", "Badge unlocked", "Race results"].includes(p.title);
      return activeCommunityTab === "announcements" ? announcement : !announcement;
    })
    .filter((p) => !p.parent_id)
    .sort((a, b) => Number(Boolean(b.is_pinned)) - Number(Boolean(a.is_pinned)) || new Date(b.created_at) - new Date(a.created_at));
}

function communityReplies(topicId) {
  return (state.communityPosts || [])
    .filter((p) => p.parent_id === topicId)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

function renderCommunity() {
  const feed = document.getElementById("community-feed");
  if (!feed) return;

  document.querySelectorAll("[data-community-tab]").forEach((button) => {
    const selected = button.dataset.communityTab === activeCommunityTab;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-selected", selected ? "true" : "false");
  });
  const compose = document.querySelector(".community-compose-panel");
  if (compose) compose.hidden = activeCommunityTab !== "create";
  const createButton = document.querySelector("[data-community-tab='create']");
  if (createButton) createButton.hidden = activeCommunityTab === "announcements";
  const feedTitle = document.getElementById("community-feed-title");
  if (feedTitle) feedTitle.textContent = activeCommunityTab === "announcements" ? "Announcements" : "Community board";

  if (communityUnavailable) {
    feed.innerHTML = `
      <div class="empty">
        <strong>Community board unavailable</strong>
        Run <code>docs/community-schema.sql</code> (or <code>docs/MIGRATE-ALL.sql</code>) in the Supabase SQL Editor, then refresh.
      </div>`;
    return;
  }

  const topics = communityTopics();
  if (!topics.length) {
    feed.innerHTML = `
      <div class="empty">
        <strong>No topics yet</strong>
        Be the first to start a conversation with your group.
      </div>`;
    return;
  }

  feed.innerHTML = topics
    .map((topic) => {
      const author = getCommunityAuthor(topic);
      const replies = communityReplies(topic.id);
      const open = selectedCommunityTopicId === topic.id;
      const title = (topic.title || "").trim();
      const content = (topic.content || "").trim();
      const canDelete = canManageCommunityPost(topic);
      const canPin = hasMinRole("moderator");

      return `
        <article class="community-topic${open ? " open" : ""}" data-topic-id="${topic.id}">
          <div class="community-topic-header" data-action="toggle-topic" data-id="${topic.id}" role="button" tabindex="0" aria-expanded="${open ? "true" : "false"}">
            ${renderProfileAvatar({ image_url: author.image }, author.name, author.id)}
            <div class="community-topic-body">
              <div class="community-topic-meta">
                <span class="community-topic-author">${escapeHtml(author.name)}</span>
                <span>${escapeHtml(formatNotificationTime(topic.created_at))}</span>
              </div>
              ${title ? `<h4 class="community-topic-title">${escapeHtml(title)}</h4>` : ""}
              <p class="community-topic-preview">${escapeHtml(content)}</p>
            </div>
            <div class="community-topic-actions">
              ${topic.is_pinned ? `<span class="community-pin-label">Pinned</span>` : ""}
              <span class="community-reply-count">${replies.length} ${replies.length === 1 ? "reply" : "replies"}</span>
              ${canPin ? `<button type="button" class="btn btn-ghost btn-sm" data-action="toggle-pin" data-id="${topic.id}">${topic.is_pinned ? "Unpin" : "Pin"}</button>` : ""}
              ${canDelete && (topic.post_type === "announcement" || ["New personal record", "Badge unlocked", "Race results"].includes(topic.title)) ? `<button type="button" class="btn btn-ghost btn-sm" data-action="edit-post" data-id="${topic.id}">Edit</button>` : ""}
              ${canDelete ? `<button type="button" class="btn btn-ghost btn-sm community-delete-btn" data-action="delete-post" data-id="${topic.id}">Delete</button>` : ""}
            </div>
          </div>
          <div class="community-thread">
            <div class="community-replies">
              ${replies.length
                ? replies
                    .map((reply) => {
                      const replyAuthor = getCommunityAuthor(reply);
                      const canDeleteReply = canManageCommunityPost(reply);
                      return `
                        <div class="community-reply" data-reply-id="${reply.id}">
                          ${renderProfileAvatar({ image_url: replyAuthor.image }, replyAuthor.name, replyAuthor.id)}
                          <div class="community-reply-body">
                            <div class="community-topic-meta">
                              <span class="community-topic-author">${escapeHtml(replyAuthor.name)}</span>
                              <span>${escapeHtml(formatNotificationTime(reply.created_at))}</span>
                              ${canDeleteReply ? `<button type="button" class="btn btn-ghost btn-sm community-delete-btn" data-action="delete-post" data-id="${reply.id}">Delete</button>` : ""}
                            </div>
                            <p class="community-reply-content">${escapeHtml(reply.content || "")}</p>
                          </div>
                        </div>`;
                    })
                    .join("")
                : `<div class="empty" style="padding:1rem;margin:0"><strong>No replies yet</strong>Start the thread below.</div>`}
            </div>
            <form class="community-reply-form" data-action="reply-form" data-parent-id="${topic.id}">
              <textarea class="textarea" name="reply" required maxlength="4000" placeholder="Write a reply…" rows="2"></textarea>
              <div class="community-reply-actions">
                <button type="submit" class="btn btn-primary btn-sm">Reply</button>
              </div>
            </form>
          </div>
        </article>`;
    })
    .join("");
}

async function toggleCommunityPostPin(postId) {
  if (!hasMinRole("moderator")) return toast("Moderators can pin community posts", "error");
  const post = (state.communityPosts || []).find((item) => item.id === postId);
  if (!post) return;
  const button = document.querySelector(`[data-action='toggle-pin'][data-id='${postId}']`);
  const restoreButton = setButtonBusy(button, post.is_pinned ? "Unpinning…" : "Pinning…");
  try {
    const { error } = await sb.from("community_posts").update({ is_pinned: !post.is_pinned }).eq("id", postId);
    if (error) throw error;
    post.is_pinned = !post.is_pinned;
    toast(post.is_pinned ? "Topic pinned successfully." : "Topic unpinned successfully.");
    renderCommunity();
  } catch (error) {
    operationFailed(post.is_pinned ? "Unpinning topic" : "Pinning topic", error);
  } finally {
    restoreButton();
  }
}

async function editCommunityPost(postId) {
  const post = (state.communityPosts || []).find((item) => item.id === postId);
  if (!post || !hasMinRole("admin")) return toast("Only admins can edit announcements", "error");
  const content = window.prompt("Edit announcement", post.content || "");
  if (content == null || !content.trim()) return;
  const title = window.prompt("Announcement title", post.title || "") ?? post.title;
  const { data, error } = await sb.from("community_posts").update({ title: title.trim() || null, content: content.trim() }).eq("id", postId).select().single();
  if (error) return operationFailed("Editing announcement", error);
  Object.assign(post, data || { title, content });
  toast("Announcement updated successfully.");
  renderCommunity();
}

async function createCommunityTopic() {
  if (activeCommunityTab === "announcements") return toast("Announcements are generated by the system", "error");
  if (!canWrite()) return toast("You need to be a group member to post", "error");
  if (!group?.id || !session?.user?.id) return toast("Not signed in", "error");

  const titleEl = document.getElementById("community-topic-title");
  const contentEl = document.getElementById("community-topic-content");
  const title = (titleEl?.value || "").trim();
  const content = (contentEl?.value || "").trim();
  if (!content) return toast("Write a message first", "error");

  const myRunner = getMyRunner();
  const btn = document.getElementById("btn-post-topic");
  const restoreButton = setButtonBusy(btn, "Posting topic…");

  try {
    const { data, error } = await sb
      .from("community_posts")
      .insert({
        group_id: group.id,
        user_id: session.user.id,
        runner_id: myRunner?.id || null,
        title: title || null,
        content,
        post_type: "board",
        parent_id: null,
      })
      .select("*")
      .single();
    if (error) throw error;

    if (data) {
      state.communityPosts.unshift(data);
      selectedCommunityTopicId = data.id;
    }
    if (titleEl) titleEl.value = "";
    if (contentEl) contentEl.value = "";
    activeCommunityTab = "board";
    toast("Topic posted successfully.");
    renderCommunity();
  } catch (e) {
    operationFailed("Posting topic", e);
  } finally {
    restoreButton();
  }
}

async function createCommunityReply(parentId, content, submitButton) {
  if (!canWrite()) return toast("You need to be a group member to reply", "error");
  if (!group?.id || !session?.user?.id) return toast("Not signed in", "error");
  const text = String(content || "").trim();
  if (!parentId || !text) return toast("Write a reply first", "error");

  const myRunner = getMyRunner();
  const restoreButton = setButtonBusy(submitButton, "Posting reply…");
  try {
    const { data, error } = await sb
      .from("community_posts")
      .insert({
        group_id: group.id,
        user_id: session.user.id,
        runner_id: myRunner?.id || null,
        title: null,
        content: text,
        parent_id: parentId,
      })
      .select("*")
      .single();
    if (error) throw error;

    if (data) state.communityPosts.unshift(data);
    selectedCommunityTopicId = parentId;
    toast("Reply posted successfully.");
    renderCommunity();
  } catch (e) {
    operationFailed("Posting reply", e);
  } finally {
    restoreButton();
  }
}

async function deleteCommunityPost(postId) {
  const post = (state.communityPosts || []).find((p) => p.id === postId);
  if (!post) return;
  if (!canManageCommunityPost(post)) return toast("You can only delete your own posts", "error");

  const label = post.parent_id ? "reply" : "topic";
  if (!confirm(`Delete this ${label}?`)) return;

  const restoreButton = setButtonBusy(document.querySelector(`[data-action='delete-post'][data-id='${postId}']`), `Deleting ${label}…`);
  try {
    const { error } = await sb.from("community_posts").delete().eq("id", postId);
    if (error) throw error;

    // Remove the post and any nested replies when deleting a topic
    state.communityPosts = state.communityPosts.filter(
      (p) => p.id !== postId && p.parent_id !== postId
    );
    if (selectedCommunityTopicId === postId) selectedCommunityTopicId = null;
    toast(`${label[0].toUpperCase()}${label.slice(1)} deleted successfully.`);
    renderCommunity();
  } catch (e) {
    operationFailed(`Deleting ${label}`, e);
  } finally {
    restoreButton();
  }
}

function onCommunityFeedClick(e) {
  const editBtn = e.target.closest("[data-action='edit-post']");
  if (editBtn) {
    e.preventDefault();
    e.stopPropagation();
    editCommunityPost(editBtn.dataset.id);
    return;
  }
  const pinBtn = e.target.closest("[data-action='toggle-pin']");
  if (pinBtn) {
    e.preventDefault();
    e.stopPropagation();
    toggleCommunityPostPin(pinBtn.dataset.id);
    return;
  }
  const deleteBtn = e.target.closest("[data-action='delete-post']");
  if (deleteBtn) {
    e.preventDefault();
    e.stopPropagation();
    deleteCommunityPost(deleteBtn.dataset.id);
    return;
  }

  const toggle = e.target.closest("[data-action='toggle-topic']");
  if (toggle && !e.target.closest("button")) {
    const id = toggle.dataset.id;
    selectedCommunityTopicId = selectedCommunityTopicId === id ? null : id;
    renderCommunity();
  }
}

function onCommunityFeedSubmit(e) {
  const form = e.target.closest("form[data-action='reply-form']");
  if (!form) return;
  e.preventDefault();
  const parentId = form.dataset.parentId;
  const textarea = form.querySelector("textarea[name='reply']");
  createCommunityReply(parentId, textarea?.value || "", form.querySelector("button[type='submit']"));
}

function onCommunityFeedKeydown(e) {
  if (e.key !== "Enter" && e.key !== " ") return;
  const toggle = e.target.closest("[data-action='toggle-topic']");
  if (!toggle || e.target.closest("button, textarea, input")) return;
  e.preventDefault();
  const id = toggle.dataset.id;
  selectedCommunityTopicId = selectedCommunityTopicId === id ? null : id;
  renderCommunity();
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
        toast(`Role updated to ${sel.value}.`);
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
      const restoreButton = setButtonBusy(btn, "Removing member…");
      try {
        const { error } = await sb.rpc("remove_group_member", {
          p_group_id: group.id,
          p_user_id: btn.dataset.remove,
        });
        if (error) throw error;
        toast("Member removed from group access.");
        await loadGroupData();
        renderTeam();
      } catch (e) {
        operationFailed("Removing member", e);
      } finally {
        restoreButton();
      }
    });
  });
}

// ─── Forms / CRUD ────────────────────────────────────────────────────────────

function openDistanceManager(returnToMarathonId = null) {
  if (!hasMinRole("admin")) return toast("Only admins can manage distances", "error");
  const renderRows = () => (state.groupDistances || []).map((distance) => `
    <div class="list-item" data-distance-row="${escapeHtml(distance.id)}">
      <div class="list-item-main"><strong>${escapeHtml(distance.label)}</strong><span class="list-item-sub">${distance.distance_km} km</span></div>
      <button type="button" class="btn btn-danger btn-sm" data-delete-distance="${escapeHtml(distance.id)}">Remove</button>
    </div>`).join("");
  openModal({
    title: "Manage race distances",
    bodyHtml: `<div class="form-grid"><p class="panel-hint" style="margin:0">These options are available when creating races and recording results.</p><div id="distance-manager-list" class="list">${renderRows() || `<div class="empty"><strong>No configured distances</strong></div>`}</div><div class="form-row"><div class="field"><label for="new-distance-label">Distance name</label><input class="input" id="new-distance-label" placeholder="e.g. 3K" /></div><div class="field"><label for="new-distance-km">Kilometres</label><input class="input" id="new-distance-km" type="number" min="0.01" step="0.001" placeholder="3" /></div></div></div>`,
    footerHtml: `<button class="btn btn-ghost" id="distance-manager-close">Done</button><button class="btn btn-primary" id="distance-manager-add">Add distance</button>`,
    onMount() {
      document.getElementById("distance-manager-close").onclick = () => { closeModal(); openMarathonForm(returnToMarathonId); };
      document.getElementById("distance-manager-add").onclick = async () => {
        const label = document.getElementById("new-distance-label").value.trim();
        const km = Number(document.getElementById("new-distance-km").value);
        if (!label || !Number.isFinite(km) || km <= 0) return toast("Enter a distance name and positive kilometre value", "error");
        const { data, error } = await sb.from("group_distances").insert({ group_id: group.id, label, distance_km: km }).select().single();
        if (error) return toast(error.message || "Could not add distance", "error");
        state.groupDistances.push(data); closeModal(); openDistanceManager(returnToMarathonId);
      };
      document.querySelectorAll("[data-delete-distance]").forEach((button) => {
        button.onclick = async () => {
          const { error } = await sb.from("group_distances").delete().eq("id", button.dataset.deleteDistance);
          if (error) return toast(error.message || "Could not remove distance", "error");
          state.groupDistances = state.groupDistances.filter((item) => item.id !== button.dataset.deleteDistance);
          closeModal(); openDistanceManager(returnToMarathonId);
        };
      });
    },
  });
}

function openMarathonForm(id) {
  const existing = id ? getMarathon(id) : null;

  // Members can add marathons, moderators can edit
  if (existing && !canEdit()) return toast("Only moderators can edit marathons", "error");
  if (!existing && !canWrite()) return toast("No permission", "error");

  const distanceOptions = configuredDistanceOptions(existing?.distance || "");

  openModal({
    title: existing ? "Edit marathon" : "Add marathon",
    bodyHtml: `
      <form class="form-grid">
        ${!existing ? `
        <div class="field" style="grid-column: 1 / -1;">
          <label for="m-scrape-url">Import from URL (optional)</label>
          <div class="form-row">
            <input class="input" id="m-scrape-url" type="url" placeholder="https://example.com/race-signup" style="flex:1" />
            <button type="button" class="btn btn-secondary" id="m-scrape-btn">Scrape</button>
          </div>
          <p class="panel-hint" style="margin:0.35rem 0 0">Paste a race registration link to auto-fill the form</p>
        </div>
        ` : ""}
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
          ${hasMinRole("admin") ? `<button type="button" class="btn btn-ghost btn-sm" id="m-manage-distances" style="margin-top:0.45rem">Manage distances</button>` : ""}
        </div>
        <div class="field">
          <label for="m-location">Location</label>
          <input class="input" id="m-location" value="${escapeHtml(existing?.location || "")}" />
        </div>
        <div class="form-row">
          <div class="field">
            <label for="m-open-date">Registration opens</label>
            <input class="input" type="date" id="m-open-date" value="${escapeHtml(existing?.reg_open_date || "")}" />
          </div>
          <div class="field">
            <label for="m-close-date">Registration closes</label>
            <input class="input" type="date" id="m-close-date" value="${escapeHtml(existing?.reg_close_date || "")}" />
          </div>
        </div>
        <div class="field">
          <label for="m-reg-link">Registration URL</label>
          <input class="input" type="url" id="m-reg-link" placeholder="https://..." value="${escapeHtml(existing?.reg_link || "")}" />
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
      <button class="btn btn-primary" type="button" id="mf-save">${existing ? "Save changes" : "Create race"}</button>`,
    onMount() {
      document.getElementById("m-manage-distances")?.addEventListener("click", () => {
        closeModal();
        openDistanceManager(id || null);
      });
      // Scrape from URL functionality
      const scrapeBtn = document.getElementById("m-scrape-btn")
      const scrapeUrlInput = document.getElementById("m-scrape-url")
      
      if (scrapeBtn && scrapeUrlInput) {
        scrapeBtn.onclick = async () => {
          const url = scrapeUrlInput.value.trim()
          if (!url) {
            return toast("Please enter a URL", "error")
          }
          
          if (!url.startsWith('http://') && !url.startsWith('https://')) {
            return toast("URL must start with http:// or https://", "error")
          }
          
          scrapeBtn.disabled = true
          scrapeBtn.textContent = "Scraping..."
          
          try {
            // Call the scrape-race edge function (server-side fetch avoids browser CORS)
            const { data, error } = await sb.functions.invoke("scrape-race", {
              body: { url },
            })

            if (error) {
              // Supabase wraps HTTP errors; surface a useful message
              const status = error.context?.status
              const bodyMsg =
                (typeof data?.error === "string" && data.error) ||
                (typeof data?.message === "string" && data.message) ||
                null
              if (status === 404) {
                throw new Error(
                  "Scraper is not deployed. Deploy the scrape-race edge function in Supabase.",
                )
              }
              if (status === 401 || status === 403) {
                throw new Error(
                  "Not authorized to use the scraper. Sign in and try again.",
                )
              }
              throw new Error(
                bodyMsg ||
                  error.message ||
                  "Failed to reach the race scraper service",
              )
            }

            // Detect the default Supabase "Hello World" stub (not our scraper)
            if (
              typeof data?.message === "string" &&
              /^Hello\b/i.test(data.message) &&
              !data?.data
            ) {
              throw new Error(
                'Wrong function deployed: still the "Hello World" template. Replace scrape-race with the code from supabase/functions/scrape-race/index.ts and redeploy.',
              )
            }

            if (data?.error) {
              throw new Error(data.error)
            }

            if (data?.data) {
              showScrapeConfirmation(data.data)
            } else {
              throw new Error("No data received from scraper")
            }
          } catch (e) {
            console.error("Scraping error:", e)
            // "strict-origin-when-cross-origin" is a Referrer-Policy, not the real error
            const msg = e?.message || String(e)
            toast(
              msg.includes("Failed to fetch") || msg.includes("NetworkError")
                ? "Could not reach scraper (network/CORS). Is scrape-race deployed?"
                : msg || "Failed to scrape race data",
              "error",
            )
          } finally {
            scrapeBtn.disabled = false
            scrapeBtn.textContent = "Scrape"
          }
        }
      }
      
      document.getElementById("mf-cancel").onclick = closeModal;
      document.getElementById("mf-save").onclick = async () => {
        const saveButton = document.getElementById("mf-save");
        const raceTimeRaw = document.getElementById("m-time").value.trim();
        const rawRegLink = document.getElementById("m-reg-link").value.trim();
        const regLink = rawRegLink ? safeUrl(rawRegLink) : "";
        if (rawRegLink && !regLink) return toast("Registration link must start with http:// or https://", "error");

        const payload = {
          group_id: group.id,
          name: document.getElementById("m-name").value.trim(),
          race_date: document.getElementById("m-date").value,
          race_time: formatRaceTime(raceTimeRaw || "09:00"),
          location: document.getElementById("m-location").value.trim(),
          image_url: document.getElementById("m-image-url").value.trim(),
          distance: document.getElementById("m-distance").value,
          notes: document.getElementById("m-notes").value.trim(),
          reg_open_date: document.getElementById("m-open-date").value || null,
          reg_close_date: document.getElementById("m-close-date").value || null,
          reg_link: regLink || null,
          created_by: session.user.id,
        };
        if (!payload.name || !payload.race_date) return toast("Name and date required", "error");
        if (!raceTimeRaw) return toast("Start time required", "error");
        if (payload.reg_open_date && payload.reg_close_date && payload.reg_close_date < payload.reg_open_date) {
          return toast("Registration close date must be on or after the open date", "error");
        }
        const restoreButton = setButtonBusy(saveButton, existing ? "Saving changes…" : "Creating race…");
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
          toast(existing ? "Race updated successfully." : "Race created successfully.");
          await loadGroupData();
          render();
        } catch (e) {
          operationFailed(existing ? "Updating race" : "Creating race", e);
        } finally {
          restoreButton();
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
        const deleteButton = document.getElementById("del-confirm");
        const restoreButton = setButtonBusy(deleteButton, "Deleting race…");
        try {
          const { error } = await sb.from("marathons").delete().eq("id", id);
          if (error) throw error;
          closeModal();
          toast("Race deleted successfully.");
          await loadGroupData();
          render();
        } catch (e) {
          operationFailed("Deleting race", e);
        } finally {
          restoreButton();
        }
      };
    },
  });
}

/**
 * Show confirmation dialog with scraped data and allow user to edit before saving
 */
function showScrapeConfirmation(data) {
  const distanceOptions = DISTANCES.map(
    (d) => `<option value="${d}">${d}</option>`
  ).join("");
  
  // Find best matching distance
  let selectedDistance = "Marathon";
  if (data.distances && data.distances.length > 0) {
    const match = DISTANCES.find(d => data.distances.includes(d));
    if (match) selectedDistance = match;
  }

  openModal({
    title: "Confirm Scraped Data",
    wide: true,
    bodyHtml: `
      <div class="scrape-preview">
        <p class="panel-hint" style="margin:0 0 1rem">Review the scraped data below. Edit any field if needed, then click "Use This Data" to fill the form.</p>
        
        <form class="form-grid" id="scrape-confirm-form">
          <div class="field">
            <label for="sc-name">Race Name *</label>
            <input class="input" id="sc-name" value="${escapeHtml(data.name || "")}" required />
          </div>
          
          <div class="form-row">
            <div class="field">
              <label for="sc-date">Date *</label>
              <input class="input" type="date" id="sc-date" value="${escapeHtml(data.date || "")}" required />
            </div>
            <div class="field">
              <label for="sc-time">Start Time</label>
              <input class="input" type="time" id="sc-time" value="${escapeHtml(data.start_time || "09:00")}" />
            </div>
          </div>
          
          <div class="field">
            <label for="sc-distance">Distance</label>
            <select class="select full" id="sc-distance">
              ${distanceOptions}
            </select>
          </div>
          
          <div class="field">
            <label for="sc-location">Location</label>
            <input class="input" id="sc-location" value="${escapeHtml(data.location || "")}" />
          </div>
          
          <div class="form-row">
            <div class="field">
              <label for="sc-deadline">Registration Deadline</label>
              <input class="input" type="date" id="sc-deadline" value="${escapeHtml(data.registration_deadline || "")}" />
            </div>
            <div class="field">
              <label for="sc-fee">Entry Fee</label>
              <input class="input" id="sc-fee" value="${escapeHtml(data.entry_fee || "")}" />
            </div>
          </div>
          
          <div class="field">
            <label for="sc-organizer">Organizer</label>
            <input class="input" id="sc-organizer" value="${escapeHtml(data.organizer || "")}" />
          </div>
          
          <div class="field">
            <label for="sc-reg-link">Registration URL</label>
            <input class="input" type="url" id="sc-reg-link" value="${escapeHtml(data.registration_url || "")}" />
          </div>
          
          <div class="field">
            <label for="sc-notes">Description / Notes</label>
            <textarea class="textarea" id="sc-notes">${escapeHtml(data.description || "")}</textarea>
          </div>
        </form>
      </div>`,
    footerHtml: `
      <button class="btn btn-ghost" id="sc-cancel">Cancel</button>
      <button class="btn btn-primary" id="sc-confirm">Use This Data</button>`,
    onMount() {
      // Set the distance dropdown
      const distanceSelect = document.getElementById("sc-distance")
      if (distanceSelect && selectedDistance) {
        distanceSelect.value = selectedDistance
      }
      
      document.getElementById("sc-cancel").onclick = closeModal;
      document.getElementById("sc-confirm").onclick = () => {
        // Fill the main marathon form with the confirmed data
        document.getElementById("m-name").value = document.getElementById("sc-name").value
        document.getElementById("m-date").value = document.getElementById("sc-date").value
        document.getElementById("m-time").value = document.getElementById("sc-time").value
        document.getElementById("m-distance").value = document.getElementById("sc-distance").value
        document.getElementById("m-location").value = document.getElementById("sc-location").value
        document.getElementById("m-close-date").value = document.getElementById("sc-deadline").value
        document.getElementById("m-notes").value = document.getElementById("sc-notes").value
        document.getElementById("m-reg-link").value = document.getElementById("sc-reg-link").value
        
        // Close confirmation dialog
        closeModal()
        
        // Show success message
        toast("Data imported! Review and save the form.")
      }
    },
  });
}

function openRunnerForm(id) {
  const existing = id ? getRunner(id) : null;

  // Moderators can add/edit runners
  if (!canAddRunners()) return toast("Only moderators and admins can add runners", "error");
  if (existing && !canEdit()) return toast("Only moderators can edit runners", "error");

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
      <button class="btn btn-primary" id="pf-save">${existing ? "Save changes" : "Create runner"}</button>`,
    onMount() {
      document.getElementById("pf-cancel").onclick = closeModal;
      document.getElementById("pf-save").onclick = async () => {
        const saveButton = document.getElementById("pf-save");
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
        const restoreButton = setButtonBusy(saveButton, existing ? "Saving changes…" : "Creating runner…");
        try {
          let savedRunner = existing;
          if (existing) {
            const { error } = await sb.from("runners").update(payload).eq("id", existing.id);
            if (error) throw error;
          } else {
            const { data, error } = await sb.from("runners").insert(payload).select().single();
            if (error) throw error;
            savedRunner = data;
            if (savedRunner) state.runners.push(savedRunner);
          }

          if (savedRunner) {
            await syncRunnerProfileImage(savedRunner, {
              imageUrl: payload.image_url,
              name: payload.name,
              email: payload.email,
            });
          }

          closeModal();
          toast(existing ? "Runner updated successfully." : "Runner created successfully.");
          await loadGroupData();
          render();
        } catch (e) {
          operationFailed(existing ? "Updating runner" : "Creating runner", e);
        } finally {
          restoreButton();
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
        const deleteButton = document.getElementById("del-confirm");
        const restoreButton = setButtonBusy(deleteButton, "Deleting runner…");
        try {
          const { error } = await sb.from("runners").delete().eq("id", id);
          if (error) throw error;
          closeModal();
          toast("Runner deleted successfully.");
          await loadGroupData();
          render();
        } catch (e) {
          operationFailed("Deleting runner", e);
        } finally {
          restoreButton();
        }
      };
    },
  });
}

function openRegistrationForm(id, defaults = {}) {
  const existing = id ? state.registrations.find((r) => r.id === id) : null;

  // Members can add registrations, moderators can edit
  if (existing && !canEdit()) return toast("Only moderators can edit registrations", "error");
  if (!existing && !canWrite()) return toast("No permission", "error");
  if (!state.runners.length) return toast("Add a runner first", "error");
  if (!state.marathons.length) return toast("Add a marathon first", "error");

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
  const selectedMarathon = getMarathon(existing?.marathon_id || defaults.marathonId || state.marathons[0]?.id);
  const registrationDistanceValue = existing?.race_distance || defaults.raceDistance || selectedMarathon?.distance || "";

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
        <div class="field">
          <label for="r-distance">Distance completed *</label>
          <select class="select full" id="r-distance">${configuredDistanceOptions(registrationDistanceValue)}</select>
          <p class="panel-hint" style="margin:0.35rem 0 0">Different runners can record different distances for the same marathon event.</p>
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
      <button class="btn btn-primary" id="rf-save">${existing ? "Save changes" : "Register runner"}</button>`,
    onMount() {
      document.getElementById("rf-cancel").onclick = closeModal;
      document.getElementById("r-marathon")?.addEventListener("change", (event) => {
        const marathon = getMarathon(event.target.value);
        const distance = document.getElementById("r-distance");
        if (distance && marathon) distance.innerHTML = configuredDistanceOptions(marathon.distance);
      });
      document.getElementById("rf-save").onclick = async () => {
        const saveButton = document.getElementById("rf-save");
        const payload = {
          group_id: group.id,
          runner_id: document.getElementById("r-runner").value,
          marathon_id: document.getElementById("r-marathon").value,
          race_distance: document.getElementById("r-distance").value,
          status: document.getElementById("r-status").value,
          bib: document.getElementById("r-bib").value.trim(),
          notes: document.getElementById("r-notes").value.trim(),
          created_by: session.user.id,
        };
        if (!payload.runner_id || !payload.marathon_id) {
          return toast("Runner and marathon are required", "error");
        }
        if (!payload.race_distance) return toast("Distance is required", "error");

        const restoreButton = setButtonBusy(saveButton, existing ? "Saving changes…" : "Registering runner…");
        try {
          if (existing) {
            const { error } = await sb.from("registrations").update(payload).eq("id", existing.id);
            if (error) throw error;
          } else {
            const { error } = await sb.from("registrations").insert(payload);
            if (error) throw error;
          }
          closeModal();
          toast(existing ? "Registration updated successfully." : "Runner registered successfully.");
          await loadGroupData();
          render();
        } catch (e) {
          operationFailed(existing ? "Updating registration" : "Creating registration", e);
        } finally {
          restoreButton();
        }
      };
    },
  });
}

/**
 * Enter / edit race results. Only works for runners already registered for the race.
 * Members can add results, moderators can edit.
 */
function openResultForm(registrationId, defaults = {}) {
  const existing = registrationId
    ? state.registrations.find((r) => r.id === registrationId)
    : null;

  // Members can add results, moderators can edit
  if (existing && !canEdit()) return toast("Only moderators can edit results", "error");
  if (!existing && !canWrite()) return toast("No permission", "error");
  if (!state.marathons.length) return toast("Add a marathon first", "error");

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
        ${!existing ? `<div class="field" style="grid-column:1/-1"><label for="res-scrape-url">Import this runner's result from URL (optional)</label><div class="form-row"><input class="input" id="res-scrape-url" type="url" placeholder="https://example.com/race-results" style="flex:1" /><button type="button" class="btn btn-secondary" id="res-scrape-btn">Scrape result</button></div><p class="panel-hint" style="margin:0.35rem 0 0">Select the runner first. The scraped row will be reviewed before it fills this form.</p><div class="panel" id="res-scrape-preview" hidden style="margin-top:0.65rem"></div></div>` : ""}
        <div class="field">
          <label for="res-distance">Distance completed *</label>
          <select class="select full" id="res-distance">${configuredDistanceOptions(existing?.race_distance || getMarathon(existing?.marathon_id)?.distance || "")}</select>
          <p class="panel-hint" style="margin:0.35rem 0 0">A race may contain participants running different distances.</p>
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
        const selectedReg = regs.find((r) => r.id === regSel.value) || existing;
        const distance = document.getElementById("res-distance");
        const race = getMarathon(mid);
        if (distance && race) distance.innerHTML = configuredDistanceOptions(selectedReg?.race_distance || race.distance);
      };

      fillRunners();
      if (!existing) marathonSel.addEventListener("change", fillRunners);
      regSel.addEventListener("change", () => {
        const selectedReg = state.registrations.find((r) => r.id === regSel.value);
        const race = getMarathon(marathonSel.value);
        const distance = document.getElementById("res-distance");
        if (distance && race) distance.innerHTML = configuredDistanceOptions(selectedReg?.race_distance || race.distance);
      });

      const scrapeResultButton = document.getElementById("res-scrape-btn");
      const scrapeResultUrl = document.getElementById("res-scrape-url");
      const scrapeResultPreview = document.getElementById("res-scrape-preview");
      if (scrapeResultButton && scrapeResultUrl && scrapeResultPreview) {
        scrapeResultButton.onclick = async () => {
          const url = scrapeResultUrl.value.trim();
          const selected = state.registrations.find((r) => r.id === regSel.value);
          const runner = selected ? getRunner(selected.runner_id) : null;
          if (!runner) return toast("Select a registered runner first", "error");
          if (!/^https?:\/\//i.test(url)) return toast("Enter a valid http:// or https:// results URL", "error");
          const restore = setButtonBusy(scrapeResultButton, "Scraping…");
          try {
            const { data, error } = await sb.functions.invoke("scrape-results", { body: { url } });
            if (error) throw new Error(data?.error || error.message || "Could not scrape results");
            if (data?.error) throw new Error(data.error);
            const rows = data?.data?.results || [];
            const runnerKey = resultsNameKey(runner.name);
            const exact = rows.filter((row) => resultsNameKey(row.runner_name) === runnerKey);
            if (exact.length !== 1) throw new Error(exact.length ? "More than one matching result was found for this runner" : `No result found for ${runner.name}`);
            const row = exact[0];
            scrapeResultPreview.hidden = false;
            scrapeResultPreview.innerHTML = `<strong>Review scraped result</strong><p class="panel-hint">${escapeHtml(runner.name)} · ${escapeHtml(data.data.race_name || "Race")}</p><p>Time: <b>${escapeHtml(row.finish_time || "—")}</b> · Place: <b>${escapeHtml(row.overall_place || "—")}</b> · Status: <b>${escapeHtml(row.status || "completed")}</b></p><p class="panel-hint">Source: <a href="${escapeHtml(data.data.source_url || url)}" target="_blank" rel="noopener">${escapeHtml(data.data.source_url || url)}</a></p><button type="button" class="btn btn-secondary btn-sm" id="res-use-scraped">Use this result</button>`;
            document.getElementById("res-use-scraped").onclick = () => {
              document.getElementById("res-chip").value = row.finish_time || "";
              document.getElementById("res-gun").value = row.finish_time || "";
              document.getElementById("res-place").value = row.overall_place || "";
              document.getElementById("res-place-g").value = row.gender_place || "";
              document.getElementById("res-place-ag").value = row.category_place || row.age_category || "";
              document.getElementById("res-status").value = ["dns", "dnf"].includes(row.status) ? row.status : row.finish_time ? "completed" : "registered";
              const notes = document.getElementById("res-notes");
              notes.value = [notes.value.trim(), `Imported from ${data.data.source_url || url}`].filter(Boolean).join("\n");
              ["res-chip", "res-gun", "res-place", "res-place-g", "res-place-ag", "res-status"].forEach((id) => document.getElementById(id).dispatchEvent(new Event("input", { bubbles: true })));
              scrapeResultPreview.innerHTML = `<strong>Result accepted for review</strong><p class="panel-hint">The fields below are filled but not saved. Review them, then click “Save result”.</p>`;
            };
          } catch (error) { toast(error?.message || "Failed to scrape this runner's result", "error"); }
          finally { restore(); }
        };
      }

      const updatePace = () => {
        const reg = state.registrations.find((r) => r.id === regSel.value) || existing;
        const marathon = getMarathon(marathonSel.value || reg?.marathon_id);
        const pace = paceForRegistration(
          { chip_time: document.getElementById("res-chip").value, gun_time: document.getElementById("res-gun").value },
          marathon,
          document.getElementById("res-distance").value
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
        const saveButton = document.getElementById("res-save");
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
          race_distance: document.getElementById("res-distance").value,
          place_overall: document.getElementById("res-place").value.trim(),
          place_gender: document.getElementById("res-place-g").value.trim(),
          place_age_group: document.getElementById("res-place-ag").value.trim(),
          result_notes: document.getElementById("res-notes").value.trim(),
        };

        const restoreButton = setButtonBusy(saveButton, "Saving result…");
        try {
          const { error } = await sb.from("registrations").update(payload).eq("id", regId);
          if (error) throw error;
          closeModal();
          toast(existing ? "Race result updated successfully." : "Race result saved successfully.");
          await loadGroupData();
          render();
        } catch (e) {
          operationFailed(existing ? "Updating race result" : "Saving race result", e);
        } finally {
          restoreButton();
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
  const paceGroup = document.getElementById("profile-pace-group")?.value || "";
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
    await syncRunnerProfileImage(linked, {
      imageUrl,
      name,
      email: session.user.email || linked.email || "",
    });
    // Join date is system-owned and comes from the runner's earliest race.
    const runnerPatch = {};
    if (paceGroup && linked.pace_group !== paceGroup) runnerPatch.pace_group = paceGroup;
    if (Object.keys(runnerPatch).length) {
      const { error } = await sb.from("runners").update(runnerPatch).eq("id", linked.id);
      if (!error) Object.assign(linked, runnerPatch);
    }
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
        const deleteButton = document.getElementById("del-confirm");
        const restoreButton = setButtonBusy(deleteButton, "Deleting registration…");
        try {
          const { error } = await sb.from("registrations").delete().eq("id", id);
          if (error) throw error;
          closeModal();
          toast("Registration deleted successfully.");
          await loadGroupData();
          render();
        } catch (e) {
          operationFailed("Deleting registration", e);
        } finally {
          restoreButton();
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

  // Password visibility toggle
  const toggleBtn = document.getElementById("toggle-signin-password");
  if (toggleBtn) {
    const passInput = document.getElementById("signin-password");
    toggleBtn.addEventListener("click", () => {
      const isVisible = passInput.type === "text";
      passInput.type = isVisible ? "password" : "text";
      toggleBtn.setAttribute("aria-pressed", String(!isVisible));
      toggleBtn.setAttribute("aria-label", isVisible ? "Show password" : "Hide password");
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
      const restoreButton = setButtonBusy(btn, "Creating user…");
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
        toast(`User ${email} created and added to the roster.`);
        await loadGroupData();
        renderTeam();
      } catch (err) {
        errEl.textContent = errMsg(err);
        errEl.hidden = false;
        operationFailed("Creating user", err);
      } finally {
        restoreButton();
      }
    });
  }

  const signoutButton = document.getElementById("btn-signout");
  if (signoutButton) signoutButton.onclick = () => signOut();

  const onboardSignoutButton = document.getElementById("btn-signout-onboard");
  if (onboardSignoutButton) onboardSignoutButton.onclick = () => signOut();

  // Profile menu: open dropdown (Profile + Sign out) — do not jump to profile immediately
  wireProfileDropdown();

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
      const saveButton = logoForm.querySelector("button[type='submit']");
      const restoreButton = setButtonBusy(saveButton, "Saving logo…");
      errEl.hidden = true;
      try {
        await saveGroupLogo(document.getElementById("group-logo-url").value);
        toast("Group logo saved successfully.");
        renderTeam();
      } catch (err) {
        errEl.textContent = errMsg(err);
        errEl.hidden = false;
        operationFailed("Saving group logo", err);
      } finally {
        restoreButton();
      }
    });
    document.getElementById("btn-clear-logo")?.addEventListener("click", async () => {
      const errEl = document.getElementById("logo-error");
      const clearButton = document.getElementById("btn-clear-logo");
      const restoreButton = setButtonBusy(clearButton, "Restoring logo…");
      errEl.hidden = true;
      try {
        document.getElementById("group-logo-url").value = "";
        await saveGroupLogo("");
        toast("Default group logo restored successfully.");
        renderTeam();
      } catch (err) {
        errEl.textContent = errMsg(err);
        errEl.hidden = false;
        operationFailed("Restoring default logo", err);
      } finally {
        restoreButton();
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
      const restoreButton = setButtonBusy(btn, "Saving profile…");
      try {
        await saveProfile();
        toast("Profile updated successfully.");
        document.getElementById("profile-password").value = "";
        document.getElementById("profile-password-confirm").value = "";
      } catch (err) {
        errEl.textContent = errMsg(err);
        errEl.hidden = false;
        operationFailed("Updating profile", err);
      } finally {
        restoreButton();
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

/**
 * Top-nav user menu: toggle Profile / Sign out dropdown.
 */
function closeProfileDropdown() {
  const dropdown = document.getElementById("profileDropdown");
  const profileBtn = document.getElementById("btn-profile");
  if (dropdown) dropdown.hidden = true;
  if (profileBtn) profileBtn.setAttribute("aria-expanded", "false");
}

function openProfileDropdown() {
  const dropdown = document.getElementById("profileDropdown");
  const profileBtn = document.getElementById("btn-profile");
  if (dropdown) dropdown.hidden = false;
  if (profileBtn) profileBtn.setAttribute("aria-expanded", "true");
  // Close notifications if open so panels don't stack
  try {
    hideNotificationPanel();
  } catch {
    /* ignore */
  }
}

function toggleProfileDropdown(e) {
  e?.preventDefault?.();
  e?.stopPropagation?.();
  const dropdown = document.getElementById("profileDropdown");
  if (!dropdown) return;
  if (dropdown.hidden) openProfileDropdown();
  else closeProfileDropdown();
}

function wireProfileDropdown() {
  const profileBtn = document.getElementById("btn-profile");
  const dropdown = document.getElementById("profileDropdown");
  if (!profileBtn || !dropdown) return;

  profileBtn.setAttribute("aria-haspopup", "menu");
  profileBtn.setAttribute("aria-expanded", "false");
  profileBtn.setAttribute("aria-controls", "profileDropdown");

  profileBtn.onclick = (e) => toggleProfileDropdown(e);

  // Menu items
  dropdown.querySelectorAll(".dropdown-item[data-view]").forEach((item) => {
    item.onclick = (e) => {
      e.stopPropagation();
      closeProfileDropdown();
      const view = item.dataset.view;
      if (view) setView(view);
    };
  });

  const signoutDropdown = document.getElementById("btn-signout-dropdown");
  if (signoutDropdown) {
    signoutDropdown.onclick = (e) => {
      e.stopPropagation();
      closeProfileDropdown();
      signOut();
    };
  }

  // Click outside closes menu
  document.addEventListener("click", (e) => {
    const chip = profileBtn.closest(".user-chip");
    if (chip && !chip.contains(e.target)) closeProfileDropdown();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeProfileDropdown();
  });
}

function wireAppUi() {
  setSidebarCollapsed(isSidebarCollapsed());
  document.getElementById("btn-sidebar-toggle")?.addEventListener("click", toggleSidebar);
  document.getElementById("btn-sidebar-toggle-mobile")?.addEventListener("click", toggleSidebar);
  document.getElementById("sidebar-backdrop")?.addEventListener("click", () => setMobileSidebarOpen(false));
  window.addEventListener("resize", () => {
    if (!isMobileSidebarViewport()) setMobileSidebarOpen(false);
  });

  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      setView(btn.dataset.view);
      setMobileSidebarOpen(false);
    });
  });
  document.querySelectorAll(".analytics-view-link[data-leaderboard]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setView("leaderboard");
      requestAnimationFrame(() => {
        const target = document.getElementById(btn.dataset.leaderboard === "fastest" ? "full-fastest-leaderboard" : "full-activity-leaderboard");
        target?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
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

  // Notification bell
  document.getElementById("btn-notifications")?.addEventListener("click", (e) => {
    e.stopPropagation();
    closeProfileDropdown();
    toggleNotificationPanel().catch((err) => console.warn("open notifications:", err));
  });
  document.querySelectorAll("[data-enable-push]").forEach((button) => {
    button.addEventListener("click", async () => {
      const status = button.parentElement?.querySelector("[data-push-status]");
      button.disabled = true;
      if (status) status.textContent = "Requesting permission…";
      try {
        await subscribeToPushNotifications();
        if (status) status.textContent = typeof Notification !== "undefined" && Notification.permission === "granted"
          ? "Push notifications are enabled on this device."
          : "Push permission was not granted.";
      } catch (err) {
        if (status) status.textContent = "Push notifications could not be enabled.";
        console.warn("enable push:", err);
      } finally {
        button.disabled = false;
      }
    });
  });
  document.getElementById("btn-mark-all-read")?.addEventListener("click", async (e) => {
    e.stopPropagation();
    await markAllNotificationsRead();
  });

  // Close notification panel when clicking outside
  document.addEventListener("click", (e) => {
    const wrap = document.querySelector(".notification-bell-wrap");
    if (wrap && !wrap.contains(e.target)) {
      hideNotificationPanel();
    }
  });

  ["marathon-search", "marathon-filter-status", "marathon-sort"].forEach((id) => {
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
  document.getElementById("certificates-marathon")?.addEventListener("change", () => {
    const runnerSel = document.getElementById("certificates-runner");
    if (runnerSel) runnerSel.value = "";
    renderCertificatesView();
  });
  document.getElementById("certificates-runner")?.addEventListener("change", () => renderCertificatesView());

  // Profile: share link + public toggle. PRs are result-derived.
  document.querySelectorAll("[data-profile-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      setProfileTab(button.dataset.profileTab);
      // Refresh all profile panels after async/realtime state changes. This
      // also re-resolves legacy runner links before rendering tab contents.
      renderProfile();
    });
  });
  document.getElementById("btn-copy-share-link")?.addEventListener("click", copyShareLink);
  document.getElementById("profile-public-toggle")?.addEventListener("change", togglePublicProfile);

  // Notification settings form
  document.getElementById("form-notification-settings")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const saveButton = form.querySelector("button[type='submit']");
    const restoreButton = setButtonBusy(saveButton, "Saving settings…");
    try {
      await saveNotificationSettings();
    } finally {
      restoreButton();
    }
  });
  document.getElementById("btn-add-schedule")?.addEventListener("click", addScheduleRow);

  // Community board
  document.getElementById("form-community-topic")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    await createCommunityTopic();
  });
  document.querySelectorAll("[data-community-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      activeCommunityTab = button.dataset.communityTab;
      renderCommunity();
    });
  });
  const communityFeed = document.getElementById("community-feed");
  communityFeed?.addEventListener("click", onCommunityFeedClick);
  communityFeed?.addEventListener("submit", onCommunityFeedSubmit);
  communityFeed?.addEventListener("keydown", onCommunityFeedKeydown);
}

// ─── Boot ────────────────────────────────────────────────────────────────────

function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker
    .register("./sw.js", { scope: "./" })
    .then((reg) => {
      // Pick up SW fixes (e.g. cache version) without waiting for full refresh cycles
      reg.update?.().catch(() => {});
    })
    .catch((err) => {
      console.warn("SW registration failed:", err);
    });
}

// ─── PWA install prompt ──────────────────────────────────────────────────────

let deferredPrompt = null;

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  // Show install button in the topbar
  renderInstallButton();
});

window.addEventListener("appinstalled", () => {
  deferredPrompt = null;
  renderInstallButton();
});

function renderInstallButton() {
  const topbar = document.getElementById("topbar-actions");
  if (!topbar) return;
  // Remove existing install button
  const existing = document.getElementById("btn-install");
  if (existing) existing.remove();
  // Add install button if prompt is available
  if (deferredPrompt) {
    const btn = document.createElement("button");
    btn.id = "btn-install";
    btn.className = "btn btn-secondary btn-sm";
    btn.innerHTML = "📱 Install";
    btn.onclick = async () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        if (outcome === "accepted") {
          console.log("User installed the app");
        }
        deferredPrompt = null;
        renderInstallButton();
      }
    };
    topbar.insertBefore(btn, topbar.firstChild);
  }
}

function wireBackToTop() {
  const btn = document.getElementById("btn-back-to-top");
  if (!btn) return;

  const onScroll = () => {
    const scrollY = window.scrollY || document.documentElement.scrollTop;
    btn.classList.toggle("visible", scrollY > 300);
  };

  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  btn.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

async function init() {
  registerServiceWorker();
  wireBackToTop();

  if (!isConfigured()) {
    showScreen("config");
    return;
  }

  sb = createClient();
  wireAuthUi();
  wireAppUi();
  fetchGroupBranding();

  // Handle push notification clicks while app is open
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data?.type === "NOTIFICATION_CLICK") {
        const data = event.data.data || {};
        const type = data.type;
        const marathonId = data.marathon_id;

        if (type === "new_marathon" || type === "race_reminder") {
          setView("marathons");
          if (marathonId) {
            setTimeout(() => {
              const card = document.querySelector(`[data-action="results"][data-id="${marathonId}"]`);
              if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
            }, 100);
          }
        } else if (type === "result_added") {
          setView("results");
          if (marathonId) {
            setTimeout(() => {
              const sel = document.getElementById("results-marathon");
              if (sel) { sel.value = marathonId; renderResults(); }
            }, 100);
          }
        }
      }
    });
  }

  // Single path for session: onAuthStateChange also emits INITIAL_SESSION.
  // Avoid calling handleSession from both getSession + onAuthStateChange (double Realtime subscribe).
  let initialSessionHandled = false;
  sb.auth.onAuthStateChange(async (event, newSession) => {
    if (event === "INITIAL_SESSION") initialSessionHandled = true;
    // TOKEN_REFRESHED should not re-run full app boot
    if (event === "TOKEN_REFRESHED") {
      session = newSession;
      return;
    }
    await handleSession(newSession);
  });

  const { data } = await sb.auth.getSession();
  if (!data.session) {
    applyBrandLogo();
    showScreen("auth");
  } else if (!initialSessionHandled) {
    // Older supabase-js may not emit INITIAL_SESSION — boot once here
    await handleSession(data.session);
  }

  // Handle share link: ?runner=<slug-or-id>
  const params = new URLSearchParams(window.location.search);
  const runnerParam = params.get("runner");
  if (runnerParam) {
    // Wait for app to be ready, then open the runner profile
    const tryOpen = () => {
      const runner = state.runners.find((r) => r.share_slug === runnerParam || r.id === runnerParam);
      if (runner) {
        openRunnerProfileDetail(runner.id);
        return true;
      }
      return false;
    };
    if (!tryOpen()) {
      const checkInterval = setInterval(() => {
        if (tryOpen()) clearInterval(checkInterval);
      }, 500);
      setTimeout(() => clearInterval(checkInterval), 10000);
    }
  }
}

init().catch((e) => {
  console.error(e);
  document.getElementById("boot-msg").textContent = errMsg(e);
});

// ─── Certificates (sidebar view) ─────────────────────────────────────────────

function isLoggedResult(reg) {
  return !!(reg && (displayFinishTime(reg) || reg.status === "completed"));
}

function certificatePublicUrl(cert) {
  return safeUrl(cert?.certificate_url || cert?.url || cert?.file_url);
}

function loggedResultsForRace(marathonId) {
  return regsForMarathon(marathonId)
    .filter(isLoggedResult)
    .sort((a, b) => (getRunner(a.runner_id)?.name || "").localeCompare(getRunner(b.runner_id)?.name || ""));
}

function canAttachCertificate(result) {
  if (!result || !isLoggedResult(result)) return false;
  if (hasMinRole("moderator")) return true;
  const mine = getMyRunner();
  return !!(mine && result.runner_id === mine.id);
}

function fillRaceSelect(selectEl) {
  if (!selectEl) return "";
  const current = selectEl.value;
  selectEl.innerHTML =
    `<option value="">Select a race…</option>` +
    sortMarathons(state.marathons).slice().reverse()
      .map((m) => {
        const count = regsForMarathon(m.id).length;
        return `<option value="${m.id}">${escapeHtml(m.name)} (${escapeHtml(m.race_date)}) — ${count} registered</option>`;
      })
      .join("");
  if (current && [...selectEl.options].some((o) => o.value === current)) {
    selectEl.value = current;
  } else {
    const withResults = sortMarathons(state.marathons)
      .filter((m) => regsForMarathon(m.id).some(isLoggedResult))
      .reverse();
    if (withResults[0]) selectEl.value = withResults[0].id;
    else if (state.marathons.length) selectEl.value = sortMarathons(state.marathons).slice(-1)[0].id;
  }
  return selectEl.value;
}

function fillCertificateRunnerSelect(selectEl, marathonId) {
  if (!selectEl) return "";
  const results = loggedResultsForRace(marathonId).filter(canAttachCertificate);
  const current = selectEl.value;
  const mine = getMyRunner();
  selectEl.innerHTML =
    `<option value="">Select a runner…</option>` +
    results.map((reg) => {
      const runner = getRunner(reg.runner_id);
      const name = runner?.name || "Runner";
      const time = displayFinishTime(reg) || "logged";
      return `<option value="${reg.runner_id}">${escapeHtml(name)} — ${escapeHtml(time)}</option>`;
    }).join("");
  if (current && [...selectEl.options].some((o) => o.value === current)) {
    selectEl.value = current;
  } else if (mine && results.some((reg) => reg.runner_id === mine.id)) {
    selectEl.value = mine.id;
  } else if (results[0]) {
    selectEl.value = results[0].runner_id;
  }
  return selectEl.value;
}

function certificateCardHtml(cert) {
  const url = certificatePublicUrl(cert);
  const runner = getRunner(cert.runner_id);
  const when = cert.race_date || cert.issued_at || cert.created_at;
  return `
    <div class="certificate-card">
      <div class="certificate-card-head">
        <span class="certificate-icon">🏅</span>
        <div>
          <strong>${escapeHtml(runner?.name || cert.marathon_name || cert.race_name || "Race")}</strong>
          <small>${escapeHtml(cert.marathon_name || cert.race_name || "Race")} · ${escapeHtml(cert.distance || "")} · ${escapeHtml(formatDate(when))}</small>
        </div>
      </div>
      <div class="certificate-card-meta">
        <span>Time: <b class="time-mono">${escapeHtml(cert.finish_time || "—")}</b></span>
        ${cert.place_overall ? `<span>Place: <b>#${escapeHtml(cert.place_overall)}</b></span>` : ""}
      </div>
      <div class="certificate-card-actions">
        ${url
          ? `<a class="btn btn-primary btn-sm" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">View certificate</a>`
          : `<span class="badge badge-count">Certificate available</span>`}
      </div>
    </div>`;
}

async function fetchCertificatesForRace(marathonId, runnerId) {
  if (!group?.id || !marathonId) return [];
  const trySelect = async (table, raceCol) => {
    let query = sb.from(table).select("*").eq("group_id", group.id).eq(raceCol, marathonId);
    if (runnerId) query = query.eq("runner_id", runnerId);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  };
  try {
    return await trySelect("user_certificates", "marathon_id");
  } catch (e) {
    try {
      return await trySelect("certificates", "race_id");
    } catch (inner) {
      console.warn("fetch certificates:", e, inner);
      return [];
    }
  }
}

async function fetchCertificatesForRunner(runnerId) {
  if (!group?.id || !runnerId) return [];
  const trySelect = async (table) => {
    const { data, error } = await sb.from(table).select("*").eq("group_id", group.id).eq("runner_id", runnerId);
    if (error) throw error;
    return data || [];
  };
  try {
    return await trySelect("user_certificates");
  } catch (e) {
    try {
      return await trySelect("certificates");
    } catch (inner) {
      console.warn("fetch runner certificates:", e, inner);
      return [];
    }
  }
}

function deriveCertificatesFromRunner(runnerId) {
  return regsForRunner(runnerId)
    .filter((reg) => isLoggedResult(reg) && certificatePublicUrl(reg))
    .flatMap((reg) => deriveCertificatesFromResult(reg));
}

async function renderProfileCertificates(myRunner) {
  const uploadEl = document.getElementById("profile-certificates-upload");
  const gridEl = document.getElementById("profile-certificates-grid");
  if (!uploadEl || !gridEl) return;
  if (!myRunner) {
    uploadEl.innerHTML = `<div class="empty"><strong>No linked runner profile</strong></div>`;
    gridEl.innerHTML = "";
    return;
  }
  const logged = regsForRunner(myRunner.id)
    .filter(isLoggedResult)
    .map((reg) => ({ reg, marathon: getMarathon(reg.marathon_id) }))
    .filter((row) => row.marathon)
    .sort((a, b) => String(b.marathon.race_date || "").localeCompare(String(a.marathon.race_date || "")));
  if (logged.length) {
    uploadEl.innerHTML = `
      <div class="form-row">
        <div class="field">
          <label for="profile-certificate-race">Race with a logged result</label>
          <select class="select full" id="profile-certificate-race">
            ${logged.map(({ reg, marathon }) =>
              `<option value="${reg.marathon_id}">${escapeHtml(marathon.name)} · ${escapeHtml(formatDate(marathon.race_date))}</option>`
            ).join("")}
          </select>
        </div>
        <div class="field">
          <label for="profile-certificate-file">Certificate file</label>
          <input class="input" id="profile-certificate-file" type="file" accept="image/*,application/pdf" />
          <p class="panel-hint" id="profile-certificate-file-name">No file selected</p>
        </div>
      </div>
      <button class="btn btn-primary" type="button" id="profile-certificate-upload-btn">Upload certificate</button>`;
    const fileInput = document.getElementById("profile-certificate-file");
    const nameHint = document.getElementById("profile-certificate-file-name");
    const button = document.getElementById("profile-certificate-upload-btn");
    fileInput.onchange = () => {
      if (nameHint) nameHint.textContent = fileInput.files?.[0]?.name || "No file selected";
    };
    button.onclick = async () => {
      const file = fileInput.files?.[0];
      const raceId = document.getElementById("profile-certificate-race")?.value;
      if (!file) return toast("Choose a certificate file to upload", "error");
      if (!raceId) return toast("Pick a race with a logged result", "error");
      const restore = setButtonBusy(button, "Uploading…");
      try {
        await uploadCertificateForResult(file, raceId, myRunner.id);
        toast("Certificate attached to this result");
        renderProfile();
      } catch (error) {
        toast(error?.message || "Failed to upload certificate", "error");
      } finally {
        restore();
      }
    };
  } else {
    uploadEl.innerHTML = `<div class="empty"><strong>Log a result first</strong>Certificates can only be attached to a finished race.</div>`;
  }

  let certs = await fetchCertificatesForRunner(myRunner.id);
  if (!certs.length) certs = deriveCertificatesFromRunner(myRunner.id);
  certs.sort((a, b) => String(b.race_date || b.issued_at || "").localeCompare(String(a.race_date || a.issued_at || "")));
  gridEl.innerHTML = certs.length
    ? certs.map(certificateCardHtml).join("")
    : `<div class="empty"><strong>No certificates yet</strong>Finish a race, then upload the file here.</div>`;
}

function deriveCertificatesFromResult(result) {
  if (!result || !certificatePublicUrl(result)) return [];
  const marathon = getMarathon(result.marathon_id);
  return [{
    id: `derived-${result.id}`,
    runner_id: result.runner_id,
    group_id: group?.id,
    marathon_id: result.marathon_id,
    marathon_name: marathon?.name,
    race_date: marathon?.race_date,
    distance: registrationDistance(result, marathon),
    finish_time: displayFinishTime(result) || "",
    place_overall: result.place_overall || "",
    certificate_url: result.certificate_url || "",
    issued_at: result.updated_at || result.created_at || null,
    derived: true,
  }];
}

function storageErrorMessage(error) {
  const message = error?.message || error?.error || "Upload failed";
  if (/row-level security|AccessDenied|Unauthorized|403/i.test(message)) {
    return "Storage blocked this upload (RLS). Run docs/certificate-upload-rls.sql in the Supabase SQL editor, then try again.";
  }
  return message;
}

async function saveCertificateRecord(result, marathon, publicUrl) {
  const uploaderId = session?.user?.id || null;
  const base = {
    group_id: group.id,
    runner_id: result.runner_id,
    user_id: uploaderId,
    marathon_id: result.marathon_id,
    title: `${marathon?.name || "Race"} certificate`,
    url: publicUrl,
    certificate_url: publicUrl,
    notes: "",
    marathon_name: marathon?.name || "",
    race_date: marathon?.race_date || null,
    distance: registrationDistance(result, marathon),
    finish_time: displayFinishTime(result) || "",
    place_overall: result.place_overall != null ? String(result.place_overall) : "",
    issued_at: new Date().toISOString(),
  };
  const attempts = [
    { table: "user_certificates", body: base, conflict: "runner_id,marathon_id" },
    {
      table: "user_certificates",
      body: {
        group_id: group.id,
        runner_id: result.runner_id,
        user_id: uploaderId,
        marathon_id: result.marathon_id,
        title: base.title,
        url: publicUrl,
      },
      conflict: "runner_id,marathon_id",
    },
    {
      table: "certificates",
      body: {
        group_id: group.id,
        runner_id: result.runner_id,
        user_id: uploaderId,
        race_id: result.marathon_id,
        registration_id: result.id,
        file_url: publicUrl,
        file_name: base.title,
        distance: base.distance,
        finish_time: base.finish_time,
      },
      conflict: "runner_id,race_id",
    },
  ];
  let lastError = null;
  for (const attempt of attempts) {
    const { error } = await sb.from(attempt.table).upsert(attempt.body, { onConflict: attempt.conflict });
    if (!error) return;
    lastError = error;
    const { error: insertError } = await sb.from(attempt.table).insert(attempt.body);
    if (!insertError) return;
    lastError = insertError;
  }
  if (lastError) throw new Error(storageErrorMessage(lastError));
}

async function uploadCertificateForResult(file, marathonId, runnerId) {
  if (!session?.user?.id) throw new Error("Sign in to upload a certificate");
  const result = regsForMarathon(marathonId).find((r) => r.runner_id === runnerId && isLoggedResult(r));
  if (!result) throw new Error("Log a result for this runner first");
  if (!canAttachCertificate(result)) throw new Error("You can only attach a certificate to your own result");
  const validTypes = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
  if (!validTypes.includes(file.type) && !/\.(jpe?g|png|webp|pdf)$/i.test(file.name)) {
    throw new Error("Unsupported file type. Upload JPG, PNG, WebP, or PDF.");
  }
  if (file.size > 10 * 1024 * 1024) throw new Error("File too large. Maximum size is 10MB.");
  const ext = (file.name.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
  const path = `${session.user.id}/${result.runner_id}/${result.marathon_id}/${Date.now()}.${ext}`;
  const { error: upErr } = await sb.storage.from("certificates").upload(path, file, {
    contentType: file.type || "application/octet-stream",
    upsert: false,
  });
  if (upErr) throw new Error(storageErrorMessage(upErr));
  const { data } = sb.storage.from("certificates").getPublicUrl(path);
  const publicUrl = data?.publicUrl || "";
  if (!publicUrl) throw new Error("Could not get a public URL for the file");

  const { error: regErr } = await sb.from("registrations").update({ certificate_url: publicUrl }).eq("id", result.id);
  if (regErr) throw new Error(storageErrorMessage(regErr));
  result.certificate_url = publicUrl;

  const marathon = getMarathon(marathonId);
  await saveCertificateRecord(result, marathon, publicUrl);
  return publicUrl;
}

function bindCertificateUpload(marathonId, runnerId) {
  const input = document.getElementById("certificate-file");
  const nameHint = document.getElementById("certificate-file-name");
  const button = document.getElementById("certificate-upload-btn");
  if (!input || !button) return;
  input.onchange = () => {
    if (nameHint) nameHint.textContent = input.files?.[0]?.name || "No file selected";
  };
  button.onclick = async () => {
    const file = input.files?.[0];
    if (!file) return toast("Choose a certificate file to upload", "error");
    const restore = setButtonBusy(button, "Uploading…");
    try {
      await uploadCertificateForResult(file, marathonId, runnerId);
      toast("Certificate attached to this result");
      renderCertificatesView();
    } catch (error) {
      toast(error?.message || "Failed to upload certificate", "error");
    } finally {
      restore();
    }
  };
}

async function renderCertificatesView() {
  const raceSel = document.getElementById("certificates-marathon");
  const runnerSel = document.getElementById("certificates-runner");
  const uploadEl = document.getElementById("certificates-upload");
  const gridEl = document.getElementById("certificates-grid");
  if (!raceSel || !runnerSel || !uploadEl || !gridEl) return;

  const marathonId = fillRaceSelect(raceSel);
  if (!marathonId) {
    runnerSel.innerHTML = `<option value="">Select a runner…</option>`;
    uploadEl.innerHTML = `<div class="empty"><strong>Pick a race</strong></div>`;
    gridEl.innerHTML = "";
    return;
  }

  const runnerId = fillCertificateRunnerSelect(runnerSel, marathonId);
  const result = loggedResultsForRace(marathonId).find((reg) => reg.runner_id === runnerId);
  if (!runnerId || !result) {
    uploadEl.innerHTML = `
      <div class="empty">
        <strong>No logged result to attach a certificate to.</strong>
        Pick a runner who already has a result, or log one first.
        <button class="btn btn-secondary btn-sm" type="button" id="certificates-log-result">Log a result first</button>
      </div>`;
    document.getElementById("certificates-log-result")?.addEventListener("click", () => {
      const resultsSel = document.getElementById("results-marathon");
      if (resultsSel) resultsSel.value = marathonId;
      setView("results");
    });
    gridEl.innerHTML = "";
    return;
  }

  const runner = getRunner(runnerId);
  uploadEl.innerHTML = `
    <p class="panel-hint">Attaching to <strong>${escapeHtml(runner?.name || "this runner")}</strong> for this race result.</p>
    <div class="field">
      <label for="certificate-file">Certificate file</label>
      <input class="input" id="certificate-file" type="file" accept="image/*,application/pdf" />
      <p class="panel-hint" id="certificate-file-name">No file selected</p>
    </div>
    <button class="btn btn-primary" type="button" id="certificate-upload-btn">Upload certificate</button>`;
  bindCertificateUpload(marathonId, runnerId);

  let certs = await fetchCertificatesForRace(marathonId, runnerId);
  if (!certs.length) certs = deriveCertificatesFromResult(result);
  gridEl.innerHTML = certs.length
    ? certs.map(certificateCardHtml).join("")
    : `<div class="empty"><strong>No certificate on this result yet</strong>Upload a file to attach it.</div>`;
}
