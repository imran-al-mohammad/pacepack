/**
 * PacePack — Marathon Group Manager
 * Local storage + optional Supabase shared rooms.
 */

const STORAGE_KEY = "pacepack-data-v1";
const CONFIG_KEY = "pacepack-config-v1";
const ROOM_KEY = "pacepack-room-v1";

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
  dashboard: { title: "Dashboard", desc: "Overview of races, sign-ups, and results" },
  marathons: { title: "Marathons", desc: "Races your group is tracking" },
  members: { title: "Group Members", desc: "People in your running group" },
  registrations: { title: "Registrations", desc: "Who signed up for which race" },
  results: { title: "Results & times", desc: "Finish times, pace, places, and PRs" },
  share: { title: "Shared online", desc: "Sync this group across phones and laptops" },
};

// ─── State ───────────────────────────────────────────────────────────────────

let state = loadState();
let currentView = "dashboard";
let syncStatus = "local"; // local | online | syncing | error
let syncMessage = "Local only";
let supabaseClient = null;
let roomChannel = null;
let pushTimer = null;
let applyingRemote = false;
let lastRemoteUpdatedAt = null;

// ─── Persistence ─────────────────────────────────────────────────────────────

function defaultState() {
  return { marathons: [], members: [], registrations: [] };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return seedDemoData();
    const parsed = JSON.parse(raw);
    return normalizeState(parsed);
  } catch {
    return defaultState();
  }
}

function normalizeState(parsed) {
  return {
    marathons: (parsed.marathons || []).map(normalizeMarathon),
    members: (parsed.members || []).map(normalizeMember),
    registrations: (parsed.registrations || []).map(normalizeRegistration),
  };
}

function normalizeMarathon(m) {
  return {
    id: m.id,
    name: m.name || "",
    date: m.date || "",
    location: m.location || "",
    distance: m.distance || "Marathon",
    notes: m.notes || "",
    createdAt: m.createdAt || Date.now(),
  };
}

function normalizeMember(m) {
  return {
    id: m.id,
    name: m.name || "",
    email: m.email || "",
    phone: m.phone || "",
    notes: m.notes || "",
    createdAt: m.createdAt || Date.now(),
  };
}

function normalizeRegistration(r) {
  return {
    id: r.id,
    memberId: r.memberId,
    marathonId: r.marathonId,
    status: r.status || "registered",
    bib: r.bib || "",
    notes: r.notes || "",
    gunTime: r.gunTime || "",
    chipTime: r.chipTime || "",
    placeOverall: r.placeOverall ?? "",
    placeGender: r.placeGender ?? "",
    placeAgeGroup: r.placeAgeGroup ?? "",
    isPR: !!r.isPR,
    resultNotes: r.resultNotes || "",
    createdAt: r.createdAt || Date.now(),
    updatedAt: r.updatedAt || r.createdAt || Date.now(),
  };
}

function saveState(options = {}) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (!options.skipRemote && !applyingRemote) {
    scheduleRemotePush();
  }
}

function uid() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function seedDemoData() {
  const m1 = uid();
  const m2 = uid();
  const m3 = uid();
  const a = uid();
  const b = uid();
  const c = uid();
  const d = uid();
  const y = new Date().getFullYear();
  const past = `${y - 1}-11-03`;
  const nextYear = new Date().getMonth() > 9 ? y + 1 : y;

  return normalizeState({
    marathons: [
      {
        id: m1,
        name: "City Spring Marathon",
        date: `${y}-04-12`,
        location: "Downtown",
        distance: "Marathon",
        notes: "Group meetup at start corral B.",
        createdAt: Date.now(),
      },
      {
        id: m2,
        name: "Riverside Half",
        date: past,
        location: "Riverside Park",
        distance: "Half Marathon",
        notes: "Flat course — good for PRs.",
        createdAt: Date.now(),
      },
      {
        id: m3,
        name: "Autumn 10K Classic",
        date: `${nextYear}-10-18`,
        location: "North Trail",
        distance: "10K",
        notes: "",
        createdAt: Date.now(),
      },
    ],
    members: [
      { id: a, name: "Alex Rivera", email: "alex@example.com", phone: "", notes: "Paces ~8:30/mi", createdAt: Date.now() },
      { id: b, name: "Jordan Lee", email: "jordan@example.com", phone: "", notes: "First full this year", createdAt: Date.now() },
      { id: c, name: "Sam Okonkwo", email: "sam@example.com", phone: "", notes: "", createdAt: Date.now() },
      { id: d, name: "Casey Nguyen", email: "casey@example.com", phone: "", notes: "Ultra training", createdAt: Date.now() },
    ],
    registrations: [
      { id: uid(), memberId: a, marathonId: m1, status: "registered", bib: "1042", notes: "", createdAt: Date.now() },
      { id: uid(), memberId: b, marathonId: m1, status: "registered", bib: "", notes: "Charity bib", createdAt: Date.now() },
      { id: uid(), memberId: c, marathonId: m1, status: "interested", bib: "", notes: "", createdAt: Date.now() },
      {
        id: uid(),
        memberId: a,
        marathonId: m2,
        status: "completed",
        bib: "882",
        gunTime: "1:42:18",
        chipTime: "1:41:55",
        placeOverall: "412",
        placeAgeGroup: "38",
        isPR: true,
        resultNotes: "Negative split",
        createdAt: Date.now(),
      },
      {
        id: uid(),
        memberId: d,
        marathonId: m2,
        status: "completed",
        bib: "901",
        gunTime: "1:38:04",
        chipTime: "1:37:40",
        placeOverall: "298",
        placeAgeGroup: "22",
        isPR: false,
        createdAt: Date.now(),
      },
      {
        id: uid(),
        memberId: c,
        marathonId: m2,
        status: "completed",
        bib: "915",
        gunTime: "1:55:22",
        chipTime: "1:54:50",
        placeOverall: "780",
        isPR: true,
        createdAt: Date.now(),
      },
      { id: uid(), memberId: b, marathonId: m2, status: "dnf", bib: "890", resultNotes: "IT band after mile 9", createdAt: Date.now() },
      { id: uid(), memberId: c, marathonId: m3, status: "interested", bib: "", notes: "", createdAt: Date.now() },
    ],
  });
}

// ─── Config / room ───────────────────────────────────────────────────────────

function loadConfig() {
  try {
    const fromStorage = JSON.parse(localStorage.getItem(CONFIG_KEY) || "null");
    if (fromStorage?.url && fromStorage?.anonKey) return fromStorage;
  } catch { /* ignore */ }
  const globalCfg = window.PACEPACK_CONFIG || {};
  if (globalCfg.supabaseUrl && globalCfg.supabaseAnonKey) {
    return { url: globalCfg.supabaseUrl, anonKey: globalCfg.supabaseAnonKey };
  }
  return { url: "", anonKey: "" };
}

function saveConfig(cfg) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

function loadRoom() {
  try {
    return JSON.parse(localStorage.getItem(ROOM_KEY) || "null");
  } catch {
    return null;
  }
}

function saveRoom(room) {
  if (room) localStorage.setItem(ROOM_KEY, JSON.stringify(room));
  else localStorage.removeItem(ROOM_KEY);
}

function getRoomCodeFromUrl() {
  const params = new URLSearchParams(location.search);
  return (params.get("room") || params.get("code") || "").trim().toUpperCase();
}

function setUrlRoom(code) {
  const url = new URL(location.href);
  if (code) url.searchParams.set("room", code);
  else url.searchParams.delete("room");
  history.replaceState(null, "", url.toString());
}

// ─── Time / pace helpers ─────────────────────────────────────────────────────

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function isPast(iso) {
  return iso < todayISO();
}

function daysUntil(iso) {
  const a = new Date(todayISO() + "T12:00:00");
  const b = new Date(iso + "T12:00:00");
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
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join("") || "?";
}

function avatarColor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash + id.charCodeAt(i) * 17) % AVATAR_COLORS.length;
  return AVATAR_COLORS[hash];
}

/** Parse "3:45:12", "1:42:18", "45:12", "3h 45m 12s" → seconds or null */
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

  const mins = raw.match(/^(\d+(?:\.\d+)?)\s*(?:min|m)$/);
  if (mins) return Math.round(parseFloat(mins[1]) * 60);

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
  const chip = parseTimeToSeconds(reg.chipTime);
  if (chip != null) return chip;
  return parseTimeToSeconds(reg.gunTime);
}

function displayFinishTime(reg) {
  if (reg.chipTime) return reg.chipTime;
  if (reg.gunTime) return reg.gunTime;
  return "";
}

function paceForRegistration(reg, marathon) {
  const seconds = bestFinishSeconds(reg);
  if (seconds == null || !marathon) return null;
  const km = DISTANCE_KM[marathon.distance];
  if (!km) return null;
  const perKm = seconds / km;
  const perMi = seconds / (km * 0.621371);
  return {
    perKm: formatSeconds(perKm),
    perMi: formatSeconds(perMi),
    label: `${formatSeconds(perKm)}/km · ${formatSeconds(perMi)}/mi`,
  };
}

function getMember(id) {
  return state.members.find((m) => m.id === id);
}

function getMarathon(id) {
  return state.marathons.find((m) => m.id === id);
}

function regsForMarathon(marathonId) {
  return state.registrations.filter((r) => r.marathonId === marathonId);
}

function regsForMember(memberId) {
  return state.registrations.filter((r) => r.memberId === memberId);
}

function statusLabel(value) {
  return STATUSES.find((s) => s.value === value)?.label || value;
}

function statusBadge(status) {
  return `<span class="badge badge-${escapeHtml(status)}">${escapeHtml(statusLabel(status))}</span>`;
}

function sortMarathons(list) {
  return [...list].sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}

function sortMembers(list) {
  return [...list].sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Toast & Modal ───────────────────────────────────────────────────────────

function toast(message, type = "success") {
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
  const backdrop = document.getElementById("modal-backdrop");
  document.getElementById("modal-title").textContent = title;
  document.getElementById("modal-body").innerHTML = bodyHtml;
  document.getElementById("modal-footer").innerHTML = footerHtml || "";
  document.getElementById("modal").classList.toggle("wide", !!wide);
  backdrop.hidden = false;
  if (onMount) onMount(document.getElementById("modal"));
  const first = document.querySelector("#modal input, #modal select, #modal textarea");
  if (first) setTimeout(() => first.focus(), 30);
}

function closeModal() {
  document.getElementById("modal-backdrop").hidden = true;
  document.getElementById("modal-body").innerHTML = "";
  document.getElementById("modal-footer").innerHTML = "";
}

// ─── Sync UI ─────────────────────────────────────────────────────────────────

function setSyncStatus(status, message) {
  syncStatus = status;
  syncMessage = message;
  const pill = document.getElementById("sync-pill");
  const label = document.getElementById("sync-label");
  if (!pill || !label) return;
  pill.classList.remove("online", "syncing", "error");
  if (status === "online") pill.classList.add("online");
  if (status === "syncing") pill.classList.add("syncing");
  if (status === "error") pill.classList.add("error");
  label.textContent = message;
}

// ─── Supabase online layer ───────────────────────────────────────────────────

function isConfigured() {
  const cfg = loadConfig();
  return !!(cfg.url && cfg.anonKey && window.supabase?.createClient);
}

function getClient() {
  if (!isConfigured()) return null;
  if (supabaseClient) return supabaseClient;
  const cfg = loadConfig();
  supabaseClient = window.supabase.createClient(cfg.url, cfg.anonKey);
  return supabaseClient;
}

function resetClient() {
  if (roomChannel) {
    try { roomChannel.unsubscribe(); } catch { /* ignore */ }
    roomChannel = null;
  }
  supabaseClient = null;
}

function generateRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  for (let i = 0; i < 6; i++) code += alphabet[arr[i] % alphabet.length];
  return code;
}

async function ensureRoomRow(code, initialPayload) {
  const client = getClient();
  if (!client) throw new Error("Not connected");

  const { data: existing, error: readErr } = await client
    .from("pacepack_rooms")
    .select("code, payload, updated_at")
    .eq("code", code)
    .maybeSingle();

  if (readErr) throw readErr;

  if (!existing) {
    const { data, error } = await client
      .from("pacepack_rooms")
      .insert({
        code,
        payload: initialPayload || state,
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  }
  return existing;
}

async function pullRoom(code) {
  const client = getClient();
  if (!client) throw new Error("Not connected");
  const { data, error } = await client
    .from("pacepack_rooms")
    .select("code, payload, updated_at")
    .eq("code", code)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Room not found. Check the code.");
  return data;
}

async function pushRoom(code) {
  const client = getClient();
  if (!client) return;
  const updatedAt = new Date().toISOString();
  const { error } = await client
    .from("pacepack_rooms")
    .upsert({
      code,
      payload: state,
      updated_at: updatedAt,
    });
  if (error) throw error;
  lastRemoteUpdatedAt = updatedAt;
}

function scheduleRemotePush() {
  const room = loadRoom();
  if (!room?.code || !isConfigured()) return;
  setSyncStatus("syncing", "Syncing…");
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    try {
      await pushRoom(room.code);
      setSyncStatus("online", `Online · ${room.code}`);
    } catch (err) {
      console.error(err);
      setSyncStatus("error", "Sync failed");
      toast(err.message || "Could not sync", "error");
    }
  }, 450);
}

function subscribeRoom(code) {
  const client = getClient();
  if (!client) return;
  if (roomChannel) {
    try { roomChannel.unsubscribe(); } catch { /* ignore */ }
  }
  roomChannel = client
    .channel(`room-${code}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "pacepack_rooms", filter: `code=eq.${code}` },
      (payload) => {
        const row = payload.new;
        if (!row?.payload) return;
        if (row.updated_at && row.updated_at === lastRemoteUpdatedAt) return;
        applyingRemote = true;
        state = normalizeState(row.payload);
        saveState({ skipRemote: true });
        lastRemoteUpdatedAt = row.updated_at || null;
        applyingRemote = false;
        setSyncStatus("online", `Online · ${code}`);
        render();
        toast("Updated from group");
      }
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") setSyncStatus("online", `Online · ${code}`);
    });
}

async function createSharedRoom() {
  if (!isConfigured()) {
    toast("Save Supabase connection first", "error");
    return;
  }
  const code = generateRoomCode();
  setSyncStatus("syncing", "Creating room…");
  try {
    const row = await ensureRoomRow(code, state);
    saveRoom({ code: row.code });
    setUrlRoom(row.code);
    lastRemoteUpdatedAt = row.updated_at;
    subscribeRoom(row.code);
    setSyncStatus("online", `Online · ${row.code}`);
    toast(`Room ${row.code} created — share this code`);
    renderShare();
  } catch (err) {
    console.error(err);
    setSyncStatus("error", "Create failed");
    toast(explainSupabaseError(err), "error");
  }
}

async function joinSharedRoom(code) {
  if (!isConfigured()) {
    toast("Save Supabase connection first", "error");
    return;
  }
  code = (code || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(code)) {
    toast("Enter a valid room code", "error");
    return;
  }
  setSyncStatus("syncing", "Joining…");
  try {
    const row = await pullRoom(code);
    applyingRemote = true;
    state = normalizeState(row.payload || defaultState());
    saveState({ skipRemote: true });
    applyingRemote = false;
    saveRoom({ code: row.code });
    setUrlRoom(row.code);
    lastRemoteUpdatedAt = row.updated_at;
    subscribeRoom(row.code);
    setSyncStatus("online", `Online · ${row.code}`);
    toast(`Joined room ${row.code}`);
    render();
  } catch (err) {
    console.error(err);
    setSyncStatus("error", "Join failed");
    toast(explainSupabaseError(err), "error");
  }
}

async function leaveSharedRoom() {
  if (roomChannel) {
    try { roomChannel.unsubscribe(); } catch { /* ignore */ }
    roomChannel = null;
  }
  saveRoom(null);
  setUrlRoom(null);
  lastRemoteUpdatedAt = null;
  setSyncStatus("local", isConfigured() ? "Connected · no room" : "Local only");
  toast("Left shared room — local copy kept");
  renderShare();
}

async function pushNow() {
  const room = loadRoom();
  if (!room?.code) return;
  setSyncStatus("syncing", "Pushing…");
  try {
    await pushRoom(room.code);
    setSyncStatus("online", `Online · ${room.code}`);
    toast("Pushed to group");
  } catch (err) {
    setSyncStatus("error", "Push failed");
    toast(explainSupabaseError(err), "error");
  }
}

function explainSupabaseError(err) {
  const msg = err?.message || String(err);
  if (/relation .* does not exist|Could not find the table/i.test(msg)) {
    return "Table missing — run supabase-schema.sql in the SQL Editor";
  }
  if (/JWT|Invalid API key|Invalid API/i.test(msg)) {
    return "Invalid Supabase URL or anon key";
  }
  if (/Failed to fetch|NetworkError|CORS/i.test(msg)) {
    return "Network error — check URL and internet connection";
  }
  return msg;
}

async function initOnline() {
  const cfg = loadConfig();
  if (cfg.url && cfg.anonKey) {
    document.getElementById("cfg-url").value = cfg.url;
    document.getElementById("cfg-key").value = cfg.anonKey;
  }

  if (!isConfigured()) {
    setSyncStatus("local", "Local only");
    return;
  }

  getClient();
  const urlCode = getRoomCodeFromUrl();
  const saved = loadRoom();
  const code = (urlCode || saved?.code || "").toUpperCase();

  if (!code) {
    setSyncStatus("local", "Connected · no room");
    return;
  }

  setSyncStatus("syncing", "Connecting…");
  try {
    const row = await pullRoom(code);
    applyingRemote = true;
    state = normalizeState(row.payload || defaultState());
    saveState({ skipRemote: true });
    applyingRemote = false;
    saveRoom({ code: row.code });
    setUrlRoom(row.code);
    lastRemoteUpdatedAt = row.updated_at;
    subscribeRoom(row.code);
    setSyncStatus("online", `Online · ${row.code}`);
  } catch (err) {
    console.error(err);
    // Room may not exist yet if creating later
    if (saved?.code) {
      setSyncStatus("error", "Room offline");
    } else {
      setSyncStatus("local", "Connected · no room");
    }
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
  if (currentView === "marathons") {
    el.innerHTML = `<button class="btn btn-primary" id="btn-add-marathon">+ Add marathon</button>`;
    document.getElementById("btn-add-marathon").onclick = () => openMarathonForm();
  } else if (currentView === "members") {
    el.innerHTML = `<button class="btn btn-primary" id="btn-add-member">+ Add member</button>`;
    document.getElementById("btn-add-member").onclick = () => openMemberForm();
  } else if (currentView === "registrations") {
    el.innerHTML = `<button class="btn btn-primary" id="btn-add-reg">+ Add registration</button>`;
    document.getElementById("btn-add-reg").onclick = () => openRegistrationForm();
  } else if (currentView === "results") {
    el.innerHTML = `<button class="btn btn-primary" id="btn-add-result">+ Enter result</button>`;
    document.getElementById("btn-add-result").onclick = () => openRegistrationForm(null, { preferResult: true });
  } else if (currentView === "share") {
    el.innerHTML = "";
  } else {
    el.innerHTML = `
      <button class="btn btn-secondary" id="btn-dash-result">+ Result</button>
      <button class="btn btn-primary" id="btn-dash-marathon">+ Marathon</button>
    `;
    document.getElementById("btn-dash-result").onclick = () => openRegistrationForm(null, { preferResult: true });
    document.getElementById("btn-dash-marathon").onclick = () => openMarathonForm();
  }
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

function renderDashboard() {
  const upcoming = sortMarathons(state.marathons.filter((m) => !isPast(m.date)));
  const past = state.marathons.filter((m) => isPast(m.date));
  const registered = state.registrations.filter((r) => r.status === "registered").length;
  const completed = state.registrations.filter((r) => r.status === "completed").length;
  const withTimes = state.registrations.filter((r) => displayFinishTime(r)).length;

  document.getElementById("stats-grid").innerHTML = `
    <div class="stat-card" style="--stat-color: var(--accent)">
      <p class="stat-label">Upcoming races</p>
      <p class="stat-value">${upcoming.length}</p>
      <p class="stat-hint">${past.length} past race${past.length === 1 ? "" : "s"} tracked</p>
    </div>
    <div class="stat-card" style="--stat-color: var(--teal)">
      <p class="stat-label">Group members</p>
      <p class="stat-value">${state.members.length}</p>
      <p class="stat-hint">In your running group</p>
    </div>
    <div class="stat-card" style="--stat-color: var(--blue)">
      <p class="stat-label">Registered</p>
      <p class="stat-value">${registered}</p>
      <p class="stat-hint">${state.registrations.length} total entries</p>
    </div>
    <div class="stat-card" style="--stat-color: var(--green)">
      <p class="stat-label">Results logged</p>
      <p class="stat-value">${withTimes}</p>
      <p class="stat-hint">${completed} marked completed</p>
    </div>
  `;

  const upcomingEl = document.getElementById("upcoming-list");
  if (!upcoming.length) {
    upcomingEl.innerHTML = `<div class="empty"><strong>No upcoming races</strong>Add a marathon to get started.</div>`;
  } else {
    upcomingEl.innerHTML = upcoming.slice(0, 6).map((m) => {
      const count = regsForMarathon(m.id).length;
      const days = daysUntil(m.date);
      const when = days === 0 ? "Today!" : days === 1 ? "Tomorrow" : `In ${days} days`;
      return `
        <div class="list-item">
          <div class="list-item-main">
            <p class="list-item-title">${escapeHtml(m.name)}</p>
            <p class="list-item-sub">${formatDate(m.date)} · ${escapeHtml(m.location || "TBD")} · ${escapeHtml(m.distance)}</p>
          </div>
          <div style="display:flex;align-items:center;gap:0.5rem">
            <span class="badge badge-count">${count} signed</span>
            <span class="badge badge-distance">${when}</span>
          </div>
        </div>
      `;
    }).join("");
  }

  const results = state.registrations
    .filter((r) => r.status === "completed" || displayFinishTime(r))
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
    .slice(0, 6);

  const recentEl = document.getElementById("recent-results");
  if (!results.length) {
    recentEl.innerHTML = `<div class="empty"><strong>No results yet</strong>Log a finish time after race day.</div>`;
  } else {
    recentEl.innerHTML = results.map((r) => {
      const member = getMember(r.memberId);
      const marathon = getMarathon(r.marathonId);
      const time = displayFinishTime(r) || "—";
      const pace = paceForRegistration(r, marathon);
      return `
        <div class="list-item">
          <div class="list-item-main">
            <p class="list-item-title">${escapeHtml(member?.name || "Unknown")}</p>
            <p class="list-item-sub">${escapeHtml(marathon?.name || "Unknown race")}${pace ? " · " + pace.label : ""}</p>
          </div>
          <div style="display:flex;align-items:center;gap:0.45rem">
            ${r.isPR ? `<span class="badge badge-pr">PR</span>` : ""}
            <span class="time-mono time-best">${escapeHtml(time)}</span>
          </div>
        </div>
      `;
    }).join("");
  }

  renderMatrix();
}

function renderMatrix() {
  const wrap = document.getElementById("matrix-wrap");
  const marathons = sortMarathons(state.marathons).slice(-8);
  const members = sortMembers(state.members);

  if (!marathons.length || !members.length) {
    wrap.innerHTML = `<div class="empty" style="border:none"><strong>Matrix needs data</strong>Add members and marathons to see the overview.</div>`;
    return;
  }

  const head = marathons
    .map((m) => `<th title="${escapeHtml(m.name)}">${escapeHtml(m.name.length > 14 ? m.name.slice(0, 12) + "…" : m.name)}<br><span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--text-dim)">${escapeHtml(m.date.slice(5))}</span></th>`)
    .join("");

  const rows = members
    .map((member) => {
      const cells = marathons
        .map((m) => {
          const reg = state.registrations.find(
            (r) => r.memberId === member.id && r.marathonId === m.id
          );
          if (!reg) return `<td><span class="matrix-dot" title="Not signed up"></span></td>`;
          if (displayFinishTime(reg)) {
            return `<td title="${escapeHtml(displayFinishTime(reg))}"><span class="time-mono" style="font-size:0.78rem">${escapeHtml(displayFinishTime(reg))}</span></td>`;
          }
          return `<td title="${escapeHtml(statusLabel(reg.status))}">${statusBadge(reg.status)}</td>`;
        })
        .join("");
      return `<tr><td>${escapeHtml(member.name)}</td>${cells}</tr>`;
    })
    .join("");

  wrap.innerHTML = `
    <table class="data-table matrix-table">
      <thead><tr><th>Member</th>${head}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// ─── Marathons ───────────────────────────────────────────────────────────────

function renderMarathons() {
  const q = (document.getElementById("marathon-search")?.value || "").trim().toLowerCase();
  const filter = document.getElementById("marathon-filter-status")?.value || "all";

  let list = sortMarathons(state.marathons);
  if (filter === "upcoming") list = list.filter((m) => !isPast(m.date));
  if (filter === "past") list = list.filter((m) => isPast(m.date));
  if (q) {
    list = list.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        (m.location || "").toLowerCase().includes(q) ||
        (m.distance || "").toLowerCase().includes(q) ||
        (m.notes || "").toLowerCase().includes(q)
    );
  }

  const el = document.getElementById("marathon-list");
  if (!list.length) {
    el.innerHTML = `<div class="empty" style="grid-column:1/-1"><strong>No marathons found</strong>Add a race or clear your filters.</div>`;
    return;
  }

  el.innerHTML = list
    .map((m) => {
      const regs = regsForMarathon(m.id);
      const finished = regs.filter((r) => r.status === "completed" || displayFinishTime(r));
      const registered = regs.filter((r) => r.status === "registered" || r.status === "completed").length;
      const past = isPast(m.date);
      const times = finished.map(bestFinishSeconds).filter((s) => s != null).sort((a, b) => a - b);
      const best = times.length ? formatSeconds(times[0]) : null;
      return `
        <article class="card" data-id="${m.id}">
          <div style="display:flex;justify-content:space-between;gap:0.5rem;align-items:flex-start">
            <h3 class="card-title">${escapeHtml(m.name)}</h3>
            <span class="badge badge-distance">${escapeHtml(m.distance)}</span>
          </div>
          <div class="card-meta">
            <span>📅 ${formatDate(m.date)}${past ? " · past" : ""}</span>
            <span>📍 ${escapeHtml(m.location || "Location TBD")}</span>
            ${best ? `<span>🏆 Best <span class="time-mono">${best}</span></span>` : ""}
          </div>
          ${m.notes ? `<p class="card-notes">${escapeHtml(m.notes)}</p>` : ""}
          <div class="card-footer">
            <span class="badge badge-count">${registered} reg · ${finished.length} results</span>
            <div class="card-actions">
              <button class="btn btn-ghost btn-sm" data-action="results" data-id="${m.id}">Results</button>
              <button class="btn btn-secondary btn-sm" data-action="edit" data-id="${m.id}">Edit</button>
              <button class="btn btn-danger btn-sm" data-action="delete" data-id="${m.id}">Delete</button>
            </div>
          </div>
        </article>
      `;
    })
    .join("");

  el.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      if (btn.dataset.action === "edit") openMarathonForm(id);
      if (btn.dataset.action === "delete") confirmDeleteMarathon(id);
      if (btn.dataset.action === "results") {
        setView("results");
        const sel = document.getElementById("results-marathon");
        if (sel) {
          sel.value = id;
          renderResults();
        }
      }
    });
  });
}

function openMarathonForm(id) {
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
          <input class="input" id="m-name" required value="${escapeHtml(existing?.name || "")}" placeholder="e.g. Boston Marathon" />
        </div>
        <div class="form-row">
          <div class="field">
            <label for="m-date">Date *</label>
            <input class="input" type="date" id="m-date" required value="${escapeHtml(existing?.date || "")}" />
          </div>
          <div class="field">
            <label for="m-distance">Distance</label>
            <select class="select full" id="m-distance">${distanceOptions}</select>
          </div>
        </div>
        <div class="field">
          <label for="m-location">Location</label>
          <input class="input" id="m-location" value="${escapeHtml(existing?.location || "")}" placeholder="City or venue" />
        </div>
        <div class="field">
          <label for="m-notes">Notes</label>
          <textarea class="textarea" id="m-notes" placeholder="Meetup plans, course notes…">${escapeHtml(existing?.notes || "")}</textarea>
        </div>
      </form>
    `,
    footerHtml: `
      <button class="btn btn-ghost" type="button" id="mf-cancel">Cancel</button>
      <button class="btn btn-primary" type="button" id="mf-save">${existing ? "Save changes" : "Add marathon"}</button>
    `,
    onMount() {
      document.getElementById("mf-cancel").onclick = closeModal;
      document.getElementById("mf-save").onclick = () => {
        const name = document.getElementById("m-name").value.trim();
        const date = document.getElementById("m-date").value;
        if (!name || !date) {
          toast("Name and date are required", "error");
          return;
        }
        const payload = {
          name,
          date,
          location: document.getElementById("m-location").value.trim(),
          distance: document.getElementById("m-distance").value,
          notes: document.getElementById("m-notes").value.trim(),
        };
        if (existing) {
          Object.assign(existing, payload);
          toast("Marathon updated");
        } else {
          state.marathons.push({ id: uid(), ...payload, createdAt: Date.now() });
          toast("Marathon added");
        }
        saveState();
        closeModal();
        render();
      };
    },
  });
}

function confirmDeleteMarathon(id) {
  const m = getMarathon(id);
  if (!m) return;
  const count = regsForMarathon(id).length;
  openModal({
    title: "Delete marathon?",
    bodyHtml: `<p>Delete <strong>${escapeHtml(m.name)}</strong>?${
      count ? ` This will also remove <strong>${count}</strong> registration${count === 1 ? "" : "s"}.` : ""
    }</p>`,
    footerHtml: `
      <button class="btn btn-ghost" id="del-cancel">Cancel</button>
      <button class="btn btn-danger" id="del-confirm">Delete</button>
    `,
    onMount() {
      document.getElementById("del-cancel").onclick = closeModal;
      document.getElementById("del-confirm").onclick = () => {
        state.marathons = state.marathons.filter((x) => x.id !== id);
        state.registrations = state.registrations.filter((r) => r.marathonId !== id);
        saveState();
        closeModal();
        toast("Marathon deleted");
        render();
      };
    },
  });
}

// ─── Members ─────────────────────────────────────────────────────────────────

function renderMembers() {
  const q = (document.getElementById("member-search")?.value || "").trim().toLowerCase();
  let list = sortMembers(state.members);
  if (q) {
    list = list.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        (m.email || "").toLowerCase().includes(q) ||
        (m.phone || "").toLowerCase().includes(q) ||
        (m.notes || "").toLowerCase().includes(q)
    );
  }

  const el = document.getElementById("member-list");
  if (!list.length) {
    el.innerHTML = `<div class="empty" style="grid-column:1/-1"><strong>No members found</strong>Add someone from your group.</div>`;
    return;
  }

  el.innerHTML = list
    .map((m) => {
      const regs = regsForMember(m.id);
      const finishes = regs.filter((r) => displayFinishTime(r));
      const prs = regs.filter((r) => r.isPR).length;
      return `
        <article class="card">
          <div class="member-head">
            <div class="avatar" style="background:${avatarColor(m.id)}22;color:${avatarColor(m.id)}">${escapeHtml(initials(m.name))}</div>
            <div>
              <h3 class="card-title">${escapeHtml(m.name)}</h3>
              <p class="member-contact">${escapeHtml(m.email || m.phone || "No contact info")}</p>
            </div>
          </div>
          ${m.notes ? `<p class="card-notes">${escapeHtml(m.notes)}</p>` : ""}
          <div class="card-footer">
            <span class="badge badge-count">${finishes.length} result${finishes.length === 1 ? "" : "s"}${prs ? ` · ${prs} PR` : ""}</span>
            <div class="card-actions">
              <button class="btn btn-ghost btn-sm" data-action="regs" data-id="${m.id}">Races</button>
              <button class="btn btn-secondary btn-sm" data-action="edit" data-id="${m.id}">Edit</button>
              <button class="btn btn-danger btn-sm" data-action="delete" data-id="${m.id}">Delete</button>
            </div>
          </div>
        </article>
      `;
    })
    .join("");

  el.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      if (btn.dataset.action === "edit") openMemberForm(id);
      if (btn.dataset.action === "delete") confirmDeleteMember(id);
      if (btn.dataset.action === "regs") showMemberRegs(id);
    });
  });
}

function openMemberForm(id) {
  const existing = id ? getMember(id) : null;
  openModal({
    title: existing ? "Edit member" : "Add member",
    bodyHtml: `
      <form class="form-grid">
        <div class="field">
          <label for="p-name">Name *</label>
          <input class="input" id="p-name" required value="${escapeHtml(existing?.name || "")}" placeholder="Full name" />
        </div>
        <div class="form-row">
          <div class="field">
            <label for="p-email">Email</label>
            <input class="input" type="email" id="p-email" value="${escapeHtml(existing?.email || "")}" placeholder="name@example.com" />
          </div>
          <div class="field">
            <label for="p-phone">Phone</label>
            <input class="input" id="p-phone" value="${escapeHtml(existing?.phone || "")}" placeholder="Optional" />
          </div>
        </div>
        <div class="field">
          <label for="p-notes">Notes</label>
          <textarea class="textarea" id="p-notes" placeholder="Pace, goals, emergency contact…">${escapeHtml(existing?.notes || "")}</textarea>
        </div>
      </form>
    `,
    footerHtml: `
      <button class="btn btn-ghost" id="pf-cancel">Cancel</button>
      <button class="btn btn-primary" id="pf-save">${existing ? "Save changes" : "Add member"}</button>
    `,
    onMount() {
      document.getElementById("pf-cancel").onclick = closeModal;
      document.getElementById("pf-save").onclick = () => {
        const name = document.getElementById("p-name").value.trim();
        if (!name) {
          toast("Name is required", "error");
          return;
        }
        const payload = {
          name,
          email: document.getElementById("p-email").value.trim(),
          phone: document.getElementById("p-phone").value.trim(),
          notes: document.getElementById("p-notes").value.trim(),
        };
        if (existing) {
          Object.assign(existing, payload);
          toast("Member updated");
        } else {
          state.members.push({ id: uid(), ...payload, createdAt: Date.now() });
          toast("Member added");
        }
        saveState();
        closeModal();
        render();
      };
    },
  });
}

function confirmDeleteMember(id) {
  const m = getMember(id);
  if (!m) return;
  const count = regsForMember(id).length;
  openModal({
    title: "Remove member?",
    bodyHtml: `<p>Remove <strong>${escapeHtml(m.name)}</strong> from the group?${
      count ? ` Their <strong>${count}</strong> registration${count === 1 ? "" : "s"} will also be deleted.` : ""
    }</p>`,
    footerHtml: `
      <button class="btn btn-ghost" id="del-cancel">Cancel</button>
      <button class="btn btn-danger" id="del-confirm">Remove</button>
    `,
    onMount() {
      document.getElementById("del-cancel").onclick = closeModal;
      document.getElementById("del-confirm").onclick = () => {
        state.members = state.members.filter((x) => x.id !== id);
        state.registrations = state.registrations.filter((r) => r.memberId !== id);
        saveState();
        closeModal();
        toast("Member removed");
        render();
      };
    },
  });
}

function showMemberRegs(id) {
  const m = getMember(id);
  if (!m) return;
  const regs = regsForMember(id);
  const rows = regs.length
    ? regs
        .map((r) => {
          const marathon = getMarathon(r.marathonId);
          const time = displayFinishTime(r);
          return `<div class="list-item">
            <div class="list-item-main">
              <p class="list-item-title">${escapeHtml(marathon?.name || "Unknown race")}</p>
              <p class="list-item-sub">${marathon ? formatDate(marathon.date) : "—"}${time ? " · " + escapeHtml(time) : ""}</p>
            </div>
            ${statusBadge(r.status)}
          </div>`;
        })
        .join("")
    : `<div class="empty"><strong>No race sign-ups yet</strong></div>`;

  openModal({
    title: `${m.name} — races`,
    bodyHtml: `<div class="list">${rows}</div>`,
    footerHtml: `
      <button class="btn btn-ghost" id="mr-close">Close</button>
      <button class="btn btn-primary" id="mr-add">+ Add registration</button>
    `,
    onMount() {
      document.getElementById("mr-close").onclick = closeModal;
      document.getElementById("mr-add").onclick = () => {
        closeModal();
        openRegistrationForm(null, { memberId: id });
      };
    },
  });
}

// ─── Registrations ───────────────────────────────────────────────────────────

function populateRegFilters() {
  const sel = document.getElementById("reg-filter-marathon");
  if (!sel) return;
  const current = sel.value || "all";
  const options = sortMarathons(state.marathons)
    .map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`)
    .join("");
  sel.innerHTML = `<option value="all">All marathons</option>${options}`;
  if ([...sel.options].some((o) => o.value === current)) sel.value = current;
}

function renderRegistrations() {
  populateRegFilters();
  const q = (document.getElementById("reg-search")?.value || "").trim().toLowerCase();
  const marathonFilter = document.getElementById("reg-filter-marathon")?.value || "all";
  const statusFilter = document.getElementById("reg-filter-status")?.value || "all";

  let list = [...state.registrations];
  if (marathonFilter !== "all") list = list.filter((r) => r.marathonId === marathonFilter);
  if (statusFilter !== "all") list = list.filter((r) => r.status === statusFilter);
  if (q) {
    list = list.filter((r) => {
      const member = getMember(r.memberId);
      const marathon = getMarathon(r.marathonId);
      const hay = [member?.name, marathon?.name, r.bib, r.notes, r.gunTime, r.chipTime, statusLabel(r.status)]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }

  list.sort((a, b) => {
    const ma = getMarathon(a.marathonId)?.date || "";
    const mb = getMarathon(b.marathonId)?.date || "";
    return mb.localeCompare(ma) || (getMember(a.memberId)?.name || "").localeCompare(getMember(b.memberId)?.name || "");
  });

  const tbody = document.getElementById("reg-tbody");
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty" style="border:none;margin:0.5rem"><strong>No registrations</strong>Add a sign-up to track who is racing.</div></td></tr>`;
    return;
  }

  tbody.innerHTML = list
    .map((r) => {
      const member = getMember(r.memberId);
      const marathon = getMarathon(r.marathonId);
      const time = displayFinishTime(r);
      const pace = paceForRegistration(r, marathon);
      return `
        <tr>
          <td>${escapeHtml(member?.name || "Unknown")}</td>
          <td>${escapeHtml(marathon?.name || "Unknown")}</td>
          <td>${marathon ? formatDate(marathon.date) : "—"}</td>
          <td>${statusBadge(r.status)}</td>
          <td class="time-mono">${time ? escapeHtml(time) : "—"}${r.isPR ? ' <span class="badge badge-pr">PR</span>' : ""}</td>
          <td>${pace ? escapeHtml(pace.perKm) + "/km" : "—"}</td>
          <td>${r.bib ? `<strong>#${escapeHtml(r.bib)}</strong>` : ""}${r.bib && r.notes ? " · " : ""}${escapeHtml(r.notes || (r.bib ? "" : "—"))}</td>
          <td>
            <div class="actions">
              <button class="btn btn-secondary btn-sm" data-action="edit" data-id="${r.id}">Edit</button>
              <button class="btn btn-danger btn-sm" data-action="delete" data-id="${r.id}">Delete</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");

  tbody.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.action === "edit") openRegistrationForm(btn.dataset.id);
      if (btn.dataset.action === "delete") confirmDeleteRegistration(btn.dataset.id);
    });
  });
}

function wirePacePreview() {
  const update = () => {
    const marathon = getMarathon(document.getElementById("r-marathon")?.value);
    const chip = document.getElementById("r-chip")?.value;
    const gun = document.getElementById("r-gun")?.value;
    const fake = { chipTime: chip, gunTime: gun };
    const pace = paceForRegistration(fake, marathon);
    const el = document.getElementById("r-pace-preview");
    if (el) el.textContent = pace ? `Pace: ${pace.label}` : "";
  };
  ["r-marathon", "r-chip", "r-gun"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", update);
    document.getElementById(id)?.addEventListener("change", update);
  });
  update();
}

function openRegistrationForm(id, defaults = {}) {
  if (!state.members.length) {
    toast("Add a group member first", "error");
    return;
  }
  if (!state.marathons.length) {
    toast("Add a marathon first", "error");
    return;
  }

  const existing = id ? state.registrations.find((r) => r.id === id) : null;
  const defaultStatus = defaults.preferResult
    ? "completed"
    : existing?.status || "registered";

  const memberOpts = sortMembers(state.members)
    .map(
      (m) =>
        `<option value="${m.id}" ${(existing?.memberId || defaults.memberId) === m.id ? "selected" : ""}>${escapeHtml(m.name)}</option>`
    )
    .join("");
  const marathonOpts = sortMarathons(state.marathons)
    .map(
      (m) =>
        `<option value="${m.id}" ${(existing?.marathonId || defaults.marathonId) === m.id ? "selected" : ""}>${escapeHtml(m.name)} (${escapeHtml(m.date)})</option>`
    )
    .join("");
  const statusOpts = STATUSES.map(
    (s) =>
      `<option value="${s.value}" ${defaultStatus === s.value ? "selected" : ""}>${s.label}</option>`
  ).join("");

  openModal({
    title: existing ? "Edit registration / result" : defaults.preferResult ? "Enter result" : "Add registration",
    wide: true,
    bodyHtml: `
      <form class="form-grid">
        <p class="form-section-title">Entry</p>
        <div class="field">
          <label for="r-member">Member *</label>
          <select class="select full" id="r-member">${memberOpts}</select>
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
            <input class="input" id="r-bib" value="${escapeHtml(existing?.bib || "")}" placeholder="Optional" />
          </div>
        </div>

        <p class="form-section-title">Results &amp; times</p>
        <div class="form-row">
          <div class="field">
            <label for="r-gun">Gun time</label>
            <input class="input" id="r-gun" value="${escapeHtml(existing?.gunTime || "")}" placeholder="e.g. 3:45:12 or 1:42:18" />
            <p class="hint">Clock time from the start gun</p>
          </div>
          <div class="field">
            <label for="r-chip">Chip / net time</label>
            <input class="input" id="r-chip" value="${escapeHtml(existing?.chipTime || "")}" placeholder="e.g. 3:44:50" />
            <p class="hint">Preferred for pace when both are set</p>
          </div>
        </div>
        <div class="pace-preview" id="r-pace-preview"></div>
        <div class="form-row">
          <div class="field">
            <label for="r-place">Overall place</label>
            <input class="input" id="r-place" value="${escapeHtml(existing?.placeOverall ?? "")}" placeholder="e.g. 412" />
          </div>
          <div class="field">
            <label for="r-place-g">Gender place</label>
            <input class="input" id="r-place-g" value="${escapeHtml(existing?.placeGender ?? "")}" placeholder="Optional" />
          </div>
        </div>
        <div class="form-row">
          <div class="field">
            <label for="r-place-ag">Age group place</label>
            <input class="input" id="r-place-ag" value="${escapeHtml(existing?.placeAgeGroup ?? "")}" placeholder="Optional" />
          </div>
          <div class="field" style="display:flex;align-items:flex-end;padding-bottom:0.35rem">
            <label class="check-inline">
              <input type="checkbox" id="r-pr" ${existing?.isPR ? "checked" : ""} />
              Personal record (PR)
            </label>
          </div>
        </div>
        <div class="field">
          <label for="r-result-notes">Result notes</label>
          <textarea class="textarea" id="r-result-notes" placeholder="Splits, weather, how it felt…">${escapeHtml(existing?.resultNotes || "")}</textarea>
        </div>
        <div class="field">
          <label for="r-notes">Registration notes</label>
          <textarea class="textarea" id="r-notes" placeholder="Charity entry, hotel, goal time…">${escapeHtml(existing?.notes || "")}</textarea>
        </div>
      </form>
    `,
    footerHtml: `
      <button class="btn btn-ghost" id="rf-cancel">Cancel</button>
      <button class="btn btn-primary" id="rf-save">${existing ? "Save changes" : "Save"}</button>
    `,
    onMount() {
      wirePacePreview();
      document.getElementById("rf-cancel").onclick = closeModal;
      document.getElementById("rf-save").onclick = () => {
        const memberId = document.getElementById("r-member").value;
        const marathonId = document.getElementById("r-marathon").value;
        let status = document.getElementById("r-status").value;
        const bib = document.getElementById("r-bib").value.trim();
        const notes = document.getElementById("r-notes").value.trim();
        const gunTime = normalizeTimeInput(document.getElementById("r-gun").value);
        const chipTime = normalizeTimeInput(document.getElementById("r-chip").value);
        const placeOverall = document.getElementById("r-place").value.trim();
        const placeGender = document.getElementById("r-place-g").value.trim();
        const placeAgeGroup = document.getElementById("r-place-ag").value.trim();
        const isPR = document.getElementById("r-pr").checked;
        const resultNotes = document.getElementById("r-result-notes").value.trim();

        if (gunTime && parseTimeToSeconds(document.getElementById("r-gun").value) == null && document.getElementById("r-gun").value.trim()) {
          toast("Gun time format not recognized (use H:MM:SS or M:SS)", "error");
          return;
        }
        if (chipTime && parseTimeToSeconds(document.getElementById("r-chip").value) == null && document.getElementById("r-chip").value.trim()) {
          toast("Chip time format not recognized (use H:MM:SS or M:SS)", "error");
          return;
        }

        // Auto-mark completed if a finish time is entered
        if ((gunTime || chipTime) && status !== "dnf" && status !== "dns") {
          status = "completed";
        }

        const duplicate = state.registrations.find(
          (r) => r.memberId === memberId && r.marathonId === marathonId && r.id !== existing?.id
        );
        if (duplicate) {
          toast("That member is already linked to this race", "error");
          return;
        }

        const payload = {
          memberId,
          marathonId,
          status,
          bib,
          notes,
          gunTime,
          chipTime,
          placeOverall,
          placeGender,
          placeAgeGroup,
          isPR,
          resultNotes,
          updatedAt: Date.now(),
        };

        if (existing) {
          Object.assign(existing, payload);
          toast("Saved");
        } else {
          state.registrations.push({ id: uid(), ...payload, createdAt: Date.now() });
          toast("Registration saved");
        }
        saveState();
        closeModal();
        render();
      };
    },
  });
}

function confirmDeleteRegistration(id) {
  const r = state.registrations.find((x) => x.id === id);
  if (!r) return;
  const member = getMember(r.memberId);
  const marathon = getMarathon(r.marathonId);
  openModal({
    title: "Delete registration?",
    bodyHtml: `<p>Remove <strong>${escapeHtml(member?.name || "member")}</strong> from <strong>${escapeHtml(marathon?.name || "race")}</strong>?</p>`,
    footerHtml: `
      <button class="btn btn-ghost" id="del-cancel">Cancel</button>
      <button class="btn btn-danger" id="del-confirm">Delete</button>
    `,
    onMount() {
      document.getElementById("del-cancel").onclick = closeModal;
      document.getElementById("del-confirm").onclick = () => {
        state.registrations = state.registrations.filter((x) => x.id !== id);
        saveState();
        closeModal();
        toast("Registration deleted");
        render();
      };
    },
  });
}

// ─── Results view ────────────────────────────────────────────────────────────

function populateResultsMarathonSelect() {
  const sel = document.getElementById("results-marathon");
  if (!sel) return;
  const current = sel.value;
  const opts = sortMarathons(state.marathons)
    .slice()
    .reverse()
    .map((m) => `<option value="${m.id}">${escapeHtml(m.name)} (${escapeHtml(m.date)})</option>`)
    .join("");
  sel.innerHTML = `<option value="">Select a race…</option>${opts}`;

  if (current && [...sel.options].some((o) => o.value === current)) {
    sel.value = current;
  } else {
    // Prefer most recent past race with results, else latest marathon
    const withResults = sortMarathons(state.marathons)
      .filter((m) => regsForMarathon(m.id).some((r) => displayFinishTime(r) || r.status === "completed"))
      .reverse();
    if (withResults[0]) sel.value = withResults[0].id;
    else if (state.marathons.length) {
      const last = sortMarathons(state.marathons).slice(-1)[0];
      sel.value = last.id;
    }
  }
}

function renderResults() {
  populateResultsMarathonSelect();
  const marathonId = document.getElementById("results-marathon")?.value;
  const sortBy = document.getElementById("results-sort")?.value || "time";
  const completedOnly = document.getElementById("results-completed-only")?.checked ?? true;
  const summary = document.getElementById("results-summary");
  const tbody = document.getElementById("results-tbody");

  if (!marathonId) {
    summary.innerHTML = `<div class="empty" style="border:none;padding:1rem"><strong>Pick a race</strong>Choose a marathon to see the leaderboard.</div>`;
    tbody.innerHTML = "";
    return;
  }

  const marathon = getMarathon(marathonId);
  let list = regsForMarathon(marathonId);
  if (completedOnly) {
    list = list.filter((r) => r.status === "completed" || r.status === "dnf" || r.status === "dns" || displayFinishTime(r));
  }

  const timed = list
    .map((r) => ({ r, sec: bestFinishSeconds(r) }))
    .filter((x) => x.sec != null)
    .sort((a, b) => a.sec - b.sec);

  const best = timed[0]?.sec;
  const median = timed.length
    ? timed[Math.floor(timed.length / 2)].sec
    : null;
  const prCount = list.filter((r) => r.isPR).length;
  const finishers = list.filter((r) => r.status === "completed" || displayFinishTime(r)).length;

  summary.innerHTML = `
    <div class="panel-header" style="margin-bottom:0.85rem">
      <h3>${escapeHtml(marathon?.name || "Race")} results</h3>
      <p class="panel-hint">${marathon ? formatDate(marathon.date) + " · " + escapeHtml(marathon.distance) : ""}</p>
    </div>
    <div class="results-summary-grid">
      <div class="results-stat">
        <p class="label">Finishers</p>
        <p class="value">${finishers}</p>
      </div>
      <div class="results-stat">
        <p class="label">Group best</p>
        <p class="value time-mono time-best">${best != null ? formatSeconds(best) : "—"}</p>
      </div>
      <div class="results-stat">
        <p class="label">Median time</p>
        <p class="value time-mono">${median != null ? formatSeconds(median) : "—"}</p>
      </div>
      <div class="results-stat">
        <p class="label">PRs</p>
        <p class="value">${prCount}</p>
      </div>
    </div>
  `;

  list = [...list];
  list.sort((a, b) => {
    if (sortBy === "name") {
      return (getMember(a.memberId)?.name || "").localeCompare(getMember(b.memberId)?.name || "");
    }
    if (sortBy === "place") {
      const pa = parseInt(a.placeOverall, 10);
      const pb = parseInt(b.placeOverall, 10);
      if (!Number.isNaN(pa) && !Number.isNaN(pb)) return pa - pb;
      if (!Number.isNaN(pa)) return -1;
      if (!Number.isNaN(pb)) return 1;
    }
    // time (default)
    const sa = bestFinishSeconds(a);
    const sb = bestFinishSeconds(b);
    if (sa != null && sb != null) return sa - sb;
    if (sa != null) return -1;
    if (sb != null) return 1;
    return (getMember(a.memberId)?.name || "").localeCompare(getMember(b.memberId)?.name || "");
  });

  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="11"><div class="empty" style="border:none;margin:0.5rem"><strong>No results for this race</strong>Enter finish times from Registrations or + Enter result.</div></td></tr>`;
    return;
  }

  // Group rank by time among those with times
  const rankById = new Map();
  timed.forEach((x, i) => rankById.set(x.r.id, i + 1));

  tbody.innerHTML = list
    .map((r) => {
      const member = getMember(r.memberId);
      const pace = paceForRegistration(r, marathon);
      const groupRank = rankById.get(r.id);
      return `
        <tr>
          <td>${groupRank != null ? groupRank : "—"}</td>
          <td>${escapeHtml(member?.name || "Unknown")}</td>
          <td>${statusBadge(r.status)}</td>
          <td class="time-mono">${r.gunTime ? escapeHtml(r.gunTime) : "—"}</td>
          <td class="time-mono time-best">${r.chipTime ? escapeHtml(r.chipTime) : "—"}</td>
          <td>${pace ? escapeHtml(pace.perKm) + "/km" : "—"}</td>
          <td>${r.placeOverall ? escapeHtml(String(r.placeOverall)) : "—"}</td>
          <td>${r.placeAgeGroup ? escapeHtml(String(r.placeAgeGroup)) : "—"}</td>
          <td>${r.isPR ? `<span class="badge badge-pr">PR</span>` : "—"}</td>
          <td>${escapeHtml(r.resultNotes || "—")}</td>
          <td>
            <div class="actions">
              <button class="btn btn-secondary btn-sm" data-action="edit" data-id="${r.id}">Edit</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");

  tbody.querySelectorAll("[data-action=edit]").forEach((btn) => {
    btn.addEventListener("click", () => openRegistrationForm(btn.dataset.id));
  });
}

// ─── Share view ──────────────────────────────────────────────────────────────

function renderShare() {
  const cfg = loadConfig();
  const room = loadRoom();
  const panel = document.getElementById("share-room-panel");
  if (!panel) return;

  if (document.getElementById("cfg-url") && !document.getElementById("cfg-url").matches(":focus")) {
    if (!document.getElementById("cfg-url").value) document.getElementById("cfg-url").value = cfg.url || "";
  }
  if (document.getElementById("cfg-key") && !document.getElementById("cfg-key").matches(":focus")) {
    if (!document.getElementById("cfg-key").value) document.getElementById("cfg-key").value = cfg.anonKey || "";
  }

  if (!isConfigured()) {
    panel.innerHTML = `
      <div class="share-status-box warn">
        Save your Supabase URL and anon key above to enable multi-device sharing.
      </div>
      <p class="panel-hint">Until then, the app works fully offline on this device only.</p>
    `;
    return;
  }

  if (room?.code) {
    const shareUrl = `${location.origin}${location.pathname}?room=${room.code}`;
    panel.innerHTML = `
      <div class="share-status-box">
        Live room active — changes sync for everyone using this code.
      </div>
      <p class="panel-hint" style="margin:0">Room code</p>
      <div class="room-code-display" id="room-code-text">${escapeHtml(room.code)}</div>
      <div class="field" style="margin-bottom:1rem">
        <label>Share link</label>
        <input class="input" id="share-link" readonly value="${escapeHtml(shareUrl)}" />
      </div>
      <div class="room-actions">
        <button class="btn btn-primary" id="btn-copy-code">Copy code</button>
        <button class="btn btn-secondary" id="btn-copy-link">Copy link</button>
        <button class="btn btn-secondary" id="btn-push-now">Push now</button>
        <button class="btn btn-danger" id="btn-leave-room">Leave room</button>
      </div>
      <p class="hint" style="margin-top:0.85rem">Host the app online (GitHub Pages / Netlify), then send the share link so the group does not need files on their computer.</p>
    `;
    document.getElementById("btn-copy-code").onclick = async () => {
      await navigator.clipboard.writeText(room.code);
      toast("Code copied");
    };
    document.getElementById("btn-copy-link").onclick = async () => {
      await navigator.clipboard.writeText(shareUrl);
      toast("Link copied");
    };
    document.getElementById("btn-push-now").onclick = () => pushNow();
    document.getElementById("btn-leave-room").onclick = () => leaveSharedRoom();
    return;
  }

  panel.innerHTML = `
    <div class="share-status-box warn">
      Connected to Supabase, but not in a room yet.
    </div>
    <div class="form-grid">
      <div class="field">
        <label>Create a new shared room from this device's data</label>
        <button class="btn btn-primary" id="btn-create-room">Create room</button>
      </div>
      <div class="field">
        <label for="join-code">Or join an existing room</label>
        <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
          <input class="input" id="join-code" placeholder="e.g. AB12CD" style="flex:1;min-width:140px;text-transform:uppercase" maxlength="12" />
          <button class="btn btn-secondary" id="btn-join-room">Join</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById("btn-create-room").onclick = () => createSharedRoom();
  document.getElementById("btn-join-room").onclick = () => {
    joinSharedRoom(document.getElementById("join-code").value);
  };
  document.getElementById("join-code").addEventListener("keydown", (e) => {
    if (e.key === "Enter") joinSharedRoom(e.target.value);
  });
}

// ─── Import / Export ─────────────────────────────────────────────────────────

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `pacepack-backup-${todayISO()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast("Backup exported");
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data || !Array.isArray(data.marathons) || !Array.isArray(data.members) || !Array.isArray(data.registrations)) {
        throw new Error("Invalid file shape");
      }
      openModal({
        title: "Import backup?",
        bodyHtml: `<p>This will <strong>replace</strong> all current data with the backup (${data.marathons.length} races, ${data.members.length} members, ${data.registrations.length} registrations).${
          loadRoom()?.code ? " The shared room will also be updated." : ""
        }</p>`,
        footerHtml: `
          <button class="btn btn-ghost" id="imp-cancel">Cancel</button>
          <button class="btn btn-primary" id="imp-confirm">Import</button>
        `,
        onMount() {
          document.getElementById("imp-cancel").onclick = closeModal;
          document.getElementById("imp-confirm").onclick = () => {
            state = normalizeState(data);
            saveState();
            closeModal();
            toast("Data imported");
            render();
          };
        },
      });
    } catch {
      toast("Could not read that file", "error");
    }
  };
  reader.readAsText(file);
}

// ─── Master render ───────────────────────────────────────────────────────────

function render() {
  if (currentView === "dashboard") renderDashboard();
  if (currentView === "marathons") renderMarathons();
  if (currentView === "members") renderMembers();
  if (currentView === "registrations") renderRegistrations();
  if (currentView === "results") renderResults();
  if (currentView === "share") renderShare();
}

// ─── Init ────────────────────────────────────────────────────────────────────

function init() {
  if (!localStorage.getItem(STORAGE_KEY)) {
    saveState({ skipRemote: true });
  }

  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => setView(btn.dataset.view));
  });

  document.getElementById("sync-pill")?.addEventListener("click", () => setView("share"));

  document.getElementById("modal-close").onclick = closeModal;
  document.getElementById("modal-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "modal-backdrop") closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.getElementById("modal-backdrop").hidden) closeModal();
  });

  document.getElementById("btn-export").onclick = exportData;
  document.getElementById("btn-import").onclick = () => document.getElementById("import-file").click();
  document.getElementById("import-file").addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) importData(file);
    e.target.value = "";
  });

  document.getElementById("btn-save-config")?.addEventListener("click", () => {
    const url = document.getElementById("cfg-url").value.trim().replace(/\/$/, "");
    const anonKey = document.getElementById("cfg-key").value.trim();
    if (!url || !anonKey) {
      toast("URL and anon key are required", "error");
      return;
    }
    if (!url.includes("supabase")) {
      toast("URL should look like https://xxxx.supabase.co", "error");
      return;
    }
    saveConfig({ url, anonKey });
    resetClient();
    toast("Connection saved");
    initOnline().then(() => renderShare());
  });

  document.getElementById("btn-clear-config")?.addEventListener("click", () => {
    saveConfig({ url: "", anonKey: "" });
    resetClient();
    leaveSharedRoom();
    document.getElementById("cfg-url").value = "";
    document.getElementById("cfg-key").value = "";
    setSyncStatus("local", "Local only");
    toast("Connection cleared");
    renderShare();
  });

  ["marathon-search", "marathon-filter-status"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("input", () => renderMarathons());
    el.addEventListener("change", () => renderMarathons());
  });
  document.getElementById("member-search")?.addEventListener("input", () => renderMembers());
  ["reg-search", "reg-filter-marathon", "reg-filter-status"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("input", () => renderRegistrations());
    el.addEventListener("change", () => renderRegistrations());
  });
  ["results-marathon", "results-sort", "results-completed-only"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("change", () => renderResults());
  });

  setView("dashboard");
  initOnline().then(() => {
    if (currentView === "share") renderShare();
  });
}

init();
