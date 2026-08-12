/**
 * PacePack Service Worker
 * Caches the app shell for offline use, provides network-first
 * fallback for Supabase API requests, and handles web push notifications.
 */

// ─── Version: increment when assets change ─────────────────────────────────────
// Update this string (or use a build step) whenever STATIC_ASSETS changes.
// Must be declared BEFORE CACHE_NAME (const is not hoisted for use).
const CACHE_VERSION = "20260813j";
const CACHE_NAME = `pacepack-v2-${CACHE_VERSION}`;
const OFFLINE_PAGE = "offline.html";

// Static assets to cache on install (app shell)
const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./src/css/styles.css",
  "./src/css/styles.css?v=20260813-profile-menu",
  "./src/js/app.js?v=20260813-profile-history-fix",
  "./config.js",
  "./src/js/services/cache.js",
  "./src/js/dev/cache-examples.js",
  "./src/js/analytics/insights.js",
  "./src/js/app.js",
  "./manifest.webmanifest",
  "./offline.html",
  "./public/icons/icon-48.png",
  "./public/icons/icon-72.png",
  "./public/icons/icon-96.png",
  "./public/icons/icon-120.png",
  "./public/icons/icon-144.png",
  "./public/icons/icon-152.png",
  "./public/icons/icon-167.png",
  "./public/icons/icon-180.png",
  "./public/icons/icon-192.png",
  "./public/icons/icon-384.png",
  "./public/icons/icon-512.png",
  // Supabase JS client (CDN)
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2",
  // Google Fonts
  "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Outfit:wght@700&display=swap",
];

// ─── Install: pre-cache app shell ─────────────────────────────────────────────

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  // Force the waiting service worker to become active immediately
  self.skipWaiting();
});

// ─── Activate: clean up old caches ────────────────────────────────────────────

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
          return null;
        })
      )
    )
  );
  self.clients.claim();
});

// ─── Fetch: cache-first for static, network-first for API ─────────────────────

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== "GET") return;

  // Supabase API requests — network first, cache fallback
  if (url.hostname.includes("supabase.co")) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Google Fonts — cache first
  if (url.hostname.includes("googleapis.com") || url.hostname.includes("gstatic.com")) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Everything else (local assets) — cache first
  event.respondWith(cacheFirst(request));
});

// ─── Push notifications ───────────────────────────────────────────────────────

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "PacePack", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "PacePack";
  const options = {
    body: data.body || "",
    icon: data.icon || "./public/icons/icon-192.png",
    badge: data.badge || "./public/icons/icon-72.png",
    data: data.data || {},
    tag: data.tag || `pp-${Date.now()}`,
    renotify: data.renotify !== false,
    vibrate: data.vibrate || [200, 100, 200],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const data = event.notification.data || {};
  const marathonId = data.marathon_id;
  const type = data.type;

  // Determine which view to open
  let url = "./";
  if (type === "new_marathon" || type === "race_reminder") {
    url = "./?view=marathons";
  } else if (type === "result_added") {
    url = "./?view=results";
  }

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.postMessage({ type: "NOTIFICATION_CLICK", data });
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(url);
      }
    })
  );
});

// ─── Strategies ───────────────────────────────────────────────────────────────

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    // Cache successful responses
    if (response && response.status === 200) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Offline — return offline page for navigation requests
    if (request.mode === "navigate") {
      return caches.match(OFFLINE_PAGE);
    }
    return new Response("", { status: 504, statusText: "Gateway Timeout" });
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response && response.status === 200) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;

    // Offline — return offline page for navigation requests
    if (request.mode === "navigate") {
      return caches.match(OFFLINE_PAGE);
    }
    return new Response(JSON.stringify({ error: "Network unavailable" }), {
      status: 504,
      headers: { "Content-Type": "application/json" },
    });
  }
}
