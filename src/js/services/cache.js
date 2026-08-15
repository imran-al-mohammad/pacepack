/**
 * PacePack — client-side cache utility
 *
 * A lightweight, dependency-free TTL cache built on top of `localStorage`.
 * Designed for static GitHub Pages apps that use Supabase for data.
 *
 * Features:
 *   - Per-key Time-To-Live (TTL) with automatic expiry
 *   - Configurable storage prefix to avoid collisions
 *   - Safe JSON serialization (handles circular refs, parse errors)
 *   - Graceful degradation when localStorage is unavailable (SSR, private mode)
 *
 * Usage:
 *   <script src="./services/cache.js"></script>
 *   <script>
 *     window.PacePackCache.setPrefix("myapp_");
 *     window.PacePackCache.setCache("user:123", { name: "Alex" }, 10 * 60);
 *     const data = window.PacePackCache.getCache("user:123");
 *   </script>
 */
(function (global) {
  "use strict";

  // ─── Configuration ─────────────────────────────────────────────────────────

  /**
   * Prefix applied to every localStorage key.
   * Change this to avoid collisions with other apps sharing the same origin.
   * @type {string}
   */
  let PREFIX = "mg_cache_";

  /**
   * Default TTL in seconds (5 minutes).
   * @type {number}
   */
  const DEFAULT_TTL_SECONDS = 5 * 60;

  // ─── Internal helpers ───────────────────────────────────────────────────────

  /**
   * Build the full localStorage key from a logical key.
   * @param {string} key
   * @returns {string}
   */
  function fullKey(key) {
    return PREFIX + String(key);
  }

  /**
   * Check whether localStorage is available and writable.
   * In private browsing mode or SSR, localStorage may throw on access.
   * @returns {boolean}
   */
  function storageAvailable() {
    try {
      const test = "__pp_cache_test__";
      localStorage.setItem(test, test);
      localStorage.removeItem(test);
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Safely JSON-parse a value, returning null on failure.
   * @param {string} raw
   * @returns {*}
   */
  function safeParse(raw) {
    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  /**
   * Safely JSON-stringify a value, returning null on failure.
   * @param {*} data
   * @returns {string|null}
   */
  function safeStringify(data) {
    try {
      return JSON.stringify(data);
    } catch (_) {
      return null;
    }
  }

  /**
   * Determine whether a cached entry has expired.
   * @param {{expiresAt:number}} entry
   * @returns {boolean}
   */
  function isExpired(entry) {
    if (!entry || typeof entry.expiresAt !== "number") return true;
    return Date.now() >= entry.expiresAt;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Cache module namespace.
   * @namespace PacePackCache
   */
  const Cache = {
    /**
     * Change the storage prefix at runtime.
     * Useful for multi-tenant apps or testing.
     * @param {string} prefix
     */
    setPrefix(prefix) {
      PREFIX = String(prefix || "");
    },

    /**
     * Get the current storage prefix.
     * @returns {string}
     */
    getPrefix() {
      return PREFIX;
    },

    /**
     * Retrieve a value from the cache.
     *
     * Returns `null` if:
     *   - localStorage is unavailable
     *   - the key does not exist
     *   - the entry has expired (and is automatically removed)
     *
     * @param {string} key - Logical cache key (without prefix)
     * @returns {*} The cached data, or `null` on miss / expiry
     */
    getCache(key) {
      if (!storageAvailable()) return null;

      const raw = localStorage.getItem(fullKey(key));
      if (!raw) return null;

      const entry = safeParse(raw);
      if (!entry) {
        // Corrupt entry — remove it
        localStorage.removeItem(fullKey(key));
        return null;
      }

      if (isExpired(entry)) {
        // Expired — clean up and return null
        localStorage.removeItem(fullKey(key));
        return null;
      }

      return entry.data;
    },

    /**
     * Store a value in the cache with a TTL.
     *
     * @param {string} key - Logical cache key (without prefix)
     * @param {*} data - Any JSON-serializable value
     * @param {number} [ttl=300] - Time-to-live in **seconds** (default: 300 = 5 min)
     * @returns {boolean} `true` if stored successfully, `false` otherwise
     */
    setCache(key, data, ttl) {
      if (!storageAvailable()) return false;

      const ttlSeconds = typeof ttl === "number" && ttl > 0 ? ttl : DEFAULT_TTL_SECONDS;
      const entry = {
        data,
        expiresAt: Date.now() + ttlSeconds * 1000,
        createdAt: Date.now(),
      };

      const serialized = safeStringify(entry);
      if (serialized === null) return false;

      try {
        localStorage.setItem(fullKey(key), serialized);
        return true;
      } catch (_) {
        return false;
      }
    },

    /**
     * Remove a specific key from the cache.
     *
     * @param {string} key - Logical cache key (without prefix)
     * @returns {boolean} `true` if removed (or didn't exist), `false` on error
     */
    clearCache(key) {
      if (!storageAvailable()) return false;
      try {
        localStorage.removeItem(fullKey(key));
        return true;
      } catch (_) {
        return false;
      }
    },

    /**
     * Remove **all** keys that match the current prefix.
     * Other localStorage entries (not using this prefix) are left untouched.
     *
     * @returns {number} Number of keys removed
     */
    clearAllCache() {
      if (!storageAvailable()) return 0;

      let removed = 0;
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith(PREFIX)) {
            localStorage.removeItem(k);
            removed++;
            // Adjust index since we removed an item
            i--;
          }
        }
      } catch (_) {
        /* ignore individual errors */
      }
      return removed;
    },

    /**
     * Remove all keys matching a given prefix pattern.
     * Useful for invalidating a group of related keys (e.g. all "profile:*").
     *
     * @param {string} pattern - Prefix to match (without the global PREFIX)
     * @returns {number} Number of keys removed
     */
    clearCachePattern(pattern) {
      if (!storageAvailable()) return 0;

      const fullPattern = PREFIX + String(pattern);
      let removed = 0;
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith(fullPattern)) {
            localStorage.removeItem(k);
            removed++;
            i--;
          }
        }
      } catch (_) {
        /* ignore */
      }
      return removed;
    },

    /**
     * Check whether a key exists and is still valid (not expired).
     * Does **not** return the data — use `getCache` for that.
     *
     * @param {string} key
     * @returns {boolean}
     */
    hasCache(key) {
      return this.getCache(key) !== null;
    },

    /**
     * Get the remaining TTL (in seconds) for a cached key.
     * Returns `0` if the key is missing or expired.
     *
     * @param {string} key
     * @returns {number}
     */
    getCacheTTL(key) {
      if (!storageAvailable()) return 0;
      const raw = localStorage.getItem(fullKey(key));
      if (!raw) return 0;
      const entry = safeParse(raw);
      if (!entry || !entry.expiresAt) return 0;
      const remaining = Math.floor((entry.expiresAt - Date.now()) / 1000);
      return remaining > 0 ? remaining : 0;
    },
  };

  // ─── Expose globally ────────────────────────────────────────────────────────

  // Support both browser global and CommonJS (for testing / Node)
  if (typeof module !== "undefined" && module.exports) {
    module.exports = Cache;
  }
  global.PacePackCache = Cache;

})(
  typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this)
);
