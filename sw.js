/**
 * PacePack Service Worker
 * Caches the app shell for offline use and provides network-first
 * fallback for Supabase API requests.
 */

const CACHE_NAME = "pacepack-v1";
const OFFLINE_PAGE = "offline.html";

// Static assets to cache on install (app shell)
const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./config.js",
  "./app.js",
  "./insights.js",
  "./manifest.webmanifest",
  "./offline.html",
  "./icons/icon-48.png",
  "./icons/icon-72.png",
  "./icons/icon-96.png",
  "./icons/icon-120.png",
  "./icons/icon-144.png",
  "./icons/icon-152.png",
  "./icons/icon-167.png",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-384.png",
  "./icons/icon-512.png",
  // Supabase JS client (CDN)
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2",
  // Google Fonts
  "https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=Outfit:wght@500;600;700;800&display=swap",
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
