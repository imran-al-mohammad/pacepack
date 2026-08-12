/**
 * PacePack — cache usage examples
 *
 * This file demonstrates how to integrate the PacePackCache utility with
 * Supabase queries. It follows the "cache-first, network fallback" pattern:
 *
 *   1. Check cache first
 *   2. If cache miss → fetch from Supabase
 *   3. Store the result in cache
 *   4. Return the data
 *
 * It also shows how to invalidate specific cache keys when data is updated.
 *
 * Usage:
 *   <script src="../services/cache.js"></script>
 *   <script src="./cache-examples.js"></script>
 *
 *   // Then call the example functions:
 *   const profile = await fetchUserProfile("user-uuid");
 *   const leaderboard = await fetchLeaderboard("group-uuid");
 */
(function (global) {
  "use strict";

  // ─── TTL constants (in seconds) ─────────────────────────────────────────────
  // Suggested TTLs from the requirements:
  //   User profiles:     10–30 minutes
  //   Personal records:  15–60 minutes
  //   Group runs list:   2–5 minutes
  //   Leaderboards:      3–10 minutes

  const TTL = {
    USER_PROFILE: 20 * 60,        // 20 minutes
    PERSONAL_RECORDS: 30 * 60,    // 30 minutes
    GROUP_RUNS: 3 * 60,           // 3 minutes
    LEADERBOARD: 5 * 60,          // 5 minutes
    MARATHONS: 5 * 60,            // 5 minutes
    RUNNERS: 10 * 60,             // 10 minutes
    TEAM: 10 * 60,                // 10 minutes
  };

  // ─── Cache key helpers ──────────────────────────────────────────────────────
  // Using a consistent naming convention makes invalidation predictable.
  // Pattern: "<entity>:<id>" or "<entity>:list:<context>"

  const Keys = {
    userProfile: (userId) => `profile:${userId}`,
    personalRecords: (runnerId) => `pr:${runnerId}`,
    groupRuns: (groupId) => `runs:${groupId}`,
    leaderboard: (groupId) => `leaderboard:${groupId}`,
    marathons: (groupId) => `marathons:${groupId}`,
    runners: (groupId) => `runners:${groupId}`,
    team: (groupId) => `team:${groupId}`,
  };

  // ─── Supabase client accessor ───────────────────────────────────────────────
  // In the real app, `sb` is the global Supabase client created in app.js.
  // This helper lets the examples work standalone or within the app.

  function getClient() {
    // Prefer the app's global client
    if (global.sb) return global.sb;
    // Fallback: create from config (for standalone testing)
    const cfg = global.PACEPACK_CONFIG || {};
    if (cfg.supabaseUrl && cfg.supabaseAnonKey && global.supabase?.createClient) {
      return global.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      });
    }
    throw new Error("Supabase client not available. Ensure supabase-js is loaded and config.js is set.");
  }

  // ─── Cache-first fetch helpers ──────────────────────────────────────────────

  /**
   * Fetch a user's profile with caching.
   *
   * Cache key: "profile:<userId>"
   * TTL: 20 minutes
   *
   * @param {string} userId - The auth user ID (UUID)
   * @param {object} [supabase] - Optional Supabase client override
   * @returns {Promise<object|null>} The profile row, or null
   */
  async function fetchUserProfile(userId, supabase) {
    if (!userId) return null;

    const cache = global.PacePackCache;
    const key = Keys.userProfile(userId);

    // 1. Check cache first
    const cached = cache.getCache(key);
    if (cached) {
      console.debug("[cache] HIT", key);
      return cached;
    }
    console.debug("[cache] MISS", key);

    // 2. Cache miss → fetch from Supabase
    const sb = supabase || getClient();
    const { data, error } = await sb
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .maybeSingle();

    if (error) throw error;

    // 3. Store in cache (only if we got data)
    if (data) {
      cache.setCache(key, data, TTL.USER_PROFILE);
    }

    // 4. Return the data
    return data;
  }

  /**
   * Fetch personal records for a runner with caching.
   *
   * Cache key: "pr:<runnerId>"
   * TTL: 30 minutes
   *
   * @param {string} runnerId - The runner's UUID
   * @param {object} [supabase] - Optional Supabase client override
   * @returns {Promise<Array>} Array of personal record rows
   */
  async function fetchPersonalRecords(runnerId, supabase) {
    if (!runnerId) return [];

    const cache = global.PacePackCache;
    const key = Keys.personalRecords(runnerId);

    // 1. Check cache first
    const cached = cache.getCache(key);
    if (cached) {
      console.debug("[cache] HIT", key);
      return cached;
    }
    console.debug("[cache] MISS", key);

    // 2. Cache miss → fetch from Supabase
    const sb = supabase || getClient();
    const { data, error } = await sb
      .from("personal_records")
      .select("*")
      .eq("runner_id", runnerId)
      .order("race_date", { ascending: false });

    if (error) throw error;

    // 3. Store in cache
    const records = data || [];
    cache.setCache(key, records, TTL.PERSONAL_RECORDS);

    // 4. Return the data
    return records;
  }

  /**
   * Fetch the group runs list (registrations) with caching.
   *
   * Cache key: "runs:<groupId>"
   * TTL: 3 minutes
   *
   * @param {string} groupId - The group's UUID
   * @param {object} [supabase] - Optional Supabase client override
   * @returns {Promise<Array>} Array of registration rows
   */
  async function fetchGroupRuns(groupId, supabase) {
    if (!groupId) return [];

    const cache = global.PacePackCache;
    const key = Keys.groupRuns(groupId);

    // 1. Check cache first
    const cached = cache.getCache(key);
    if (cached) {
      console.debug("[cache] HIT", key);
      return cached;
    }
    console.debug("[cache] MISS", key);

    // 2. Cache miss → fetch from Supabase
    const sb = supabase || getClient();
    const { data, error } = await sb
      .from("registrations")
      .select("*")
      .eq("group_id", groupId);

    if (error) throw error;

    // 3. Store in cache
    const runs = data || [];
    cache.setCache(key, runs, TTL.GROUP_RUNS);

    // 4. Return the data
    return runs;
  }

  /**
   * Fetch the leaderboard with caching.
   *
   * Cache key: "leaderboard:<groupId>"
   * TTL: 5 minutes
   *
   * @param {string} groupId - The group's UUID
   * @param {object} [supabase] - Optional Supabase client override
   * @returns {Promise<Array>} Array of leaderboard entries
   */
  async function fetchLeaderboard(groupId, supabase) {
    if (!groupId) return [];

    const cache = global.PacePackCache;
    const key = Keys.leaderboard(groupId);

    // 1. Check cache first
    const cached = cache.getCache(key);
    if (cached) {
      console.debug("[cache] HIT", key);
      return cached;
    }
    console.debug("[cache] MISS", key);

    // 2. Cache miss → fetch from Supabase
    // This example uses an RPC; replace with your actual query
    const sb = supabase || getClient();
    const { data, error } = await sb.rpc("get_leaderboard", { p_group_id: groupId });

    if (error) throw error;

    // 3. Store in cache
    const leaderboard = data || [];
    cache.setCache(key, leaderboard, TTL.LEADERBOARD);

    // 4. Return the data
    return leaderboard;
  }

  /**
   * Fetch marathons for a group with caching.
   *
   * Cache key: "marathons:<groupId>"
   * TTL: 5 minutes
   *
   * @param {string} groupId - The group's UUID
   * @param {object} [supabase] - Optional Supabase client override
   * @returns {Promise<Array>} Array of marathon rows
   */
  async function fetchMarathons(groupId, supabase) {
    if (!groupId) return [];

    const cache = global.PacePackCache;
    const key = Keys.marathons(groupId);

    const cached = cache.getCache(key);
    if (cached) {
      console.debug("[cache] HIT", key);
      return cached;
    }
    console.debug("[cache] MISS", key);

    const sb = supabase || getClient();
    const { data, error } = await sb
      .from("marathons")
      .select("*")
      .eq("group_id", groupId)
      .order("race_date");

    if (error) throw error;

    const marathons = data || [];
    cache.setCache(key, marathons, TTL.MARATHONS);
    return marathons;
  }

  /**
   * Fetch runners for a group with caching.
   *
   * Cache key: "runners:<groupId>"
   * TTL: 10 minutes
   *
   * @param {string} groupId - The group's UUID
   * @param {object} [supabase] - Optional Supabase client override
   * @returns {Promise<Array>} Array of runner rows
   */
  async function fetchRunners(groupId, supabase) {
    if (!groupId) return [];

    const cache = global.PacePackCache;
    const key = Keys.runners(groupId);

    const cached = cache.getCache(key);
    if (cached) {
      console.debug("[cache] HIT", key);
      return cached;
    }
    console.debug("[cache] MISS", key);

    const sb = supabase || getClient();
    const { data, error } = await sb
      .from("runners")
      .select("*")
      .eq("group_id", groupId)
      .order("name");

    if (error) throw error;

    const runners = data || [];
    cache.setCache(key, runners, TTL.RUNNERS);
    return runners;
  }

  // ─── Cache invalidation helpers ─────────────────────────────────────────────
  // Call these after mutations (inserts, updates, deletes) to keep the cache
  // in sync with the database.

  /**
   * Invalidate the cache for a specific user profile.
   * Call this after a user updates their profile.
   *
   * @param {string} userId
   */
  function invalidateUserProfile(userId) {
    global.PacePackCache.clearCache(Keys.userProfile(userId));
    console.debug("[cache] invalidated", Keys.userProfile(userId));
  }

  /**
   * Invalidate the cache for a runner's personal records.
   * Call this after adding, updating, or deleting a PR.
   *
   * @param {string} runnerId
   */
  function invalidatePersonalRecords(runnerId) {
    global.PacePackCache.clearCache(Keys.personalRecords(runnerId));
    console.debug("[cache] invalidated", Keys.personalRecords(runnerId));
  }

  /**
   * Invalidate the cache for a group's runs list.
   * Call this after adding, updating, or deleting a registration.
   *
   * @param {string} groupId
   */
  function invalidateGroupRuns(groupId) {
    global.PacePackCache.clearCache(Keys.groupRuns(groupId));
    console.debug("[cache] invalidated", Keys.groupRuns(groupId));
  }

  /**
   * Invalidate the cache for a group's leaderboard.
   * Call this after a race result is added or updated.
   *
   * @param {string} groupId
   */
  function invalidateLeaderboard(groupId) {
    global.PacePackCache.clearCache(Keys.leaderboard(groupId));
    console.debug("[cache] invalidated", Keys.leaderboard(groupId));
  }

  /**
   * Invalidate all caches for a group.
   * Call this after a bulk data refresh or when switching groups.
   *
   * @param {string} groupId
   */
  function invalidateGroupCache(groupId) {
    global.PacePackCache.clearCache(Keys.marathons(groupId));
    global.PacePackCache.clearCache(Keys.runners(groupId));
    global.PacePackCache.clearCache(Keys.groupRuns(groupId));
    global.PacePackCache.clearCache(Keys.leaderboard(groupId));
    global.PacePackCache.clearCache(Keys.team(groupId));
    console.debug("[cache] invalidated all caches for group", groupId);
  }

  /**
   * Invalidate all caches for a specific runner.
   * Call this after updating a runner's profile or results.
   *
   * @param {string} runnerId
   */
  function invalidateRunnerCache(runnerId) {
    global.PacePackCache.clearCache(Keys.personalRecords(runnerId));
    console.debug("[cache] invalidated caches for runner", runnerId);
  }

  // ─── Example: mutation with cache invalidation ──────────────────────────────

  /**
   * Example: Update a user's profile and invalidate the cache.
   *
   * @param {string} userId
   * @param {object} updates - Fields to update on the profile
   * @param {object} [supabase] - Optional Supabase client override
   * @returns {Promise<object>} The updated profile
   */
  async function updateUserProfile(userId, updates, supabase) {
    const sb = supabase || getClient();

    const { data, error } = await sb
      .from("profiles")
      .update(updates)
      .eq("id", userId)
      .select()
      .single();

    if (error) throw error;

    // Invalidate the cached profile so the next fetch gets fresh data
    invalidateUserProfile(userId);

    return data;
  }

  /**
   * Example: Add a race result and invalidate related caches.
   *
   * @param {string} groupId
   * @param {string} runnerId
   * @param {object} result - The registration/result payload
   * @param {object} [supabase] - Optional Supabase client override
   * @returns {Promise<object>} The inserted/updated registration
   */
  async function addRaceResult(groupId, runnerId, result, supabase) {
    const sb = supabase || getClient();

    const { data, error } = await sb
      .from("registrations")
      .update(result)
      .eq("id", result.id)
      .select()
      .single();

    if (error) throw error;

    // Invalidate all caches that could be affected by a result change
    invalidateGroupRuns(groupId);
    invalidateLeaderboard(groupId);
    invalidatePersonalRecords(runnerId);

    return data;
  }

  // ─── Example: cache-aware data refresh ────────────────────────────────────────

  /**
   * Force-refresh a cached query by bypassing the cache,
   * then updating the cache with fresh data.
   *
   * @param {string} groupId
   * @param {object} [supabase] - Optional Supabase client override
   * @returns {Promise<Array>} Fresh leaderboard data
   */
  async function refreshLeaderboard(groupId, supabase) {
    const cache = global.PacePackCache;
    const key = Keys.leaderboard(groupId);

    // Clear the old cache entry
    cache.clearCache(key);

    // Re-fetch (this will populate the cache again)
    return fetchLeaderboard(groupId, supabase);
  }

  // ─── Example: cache stats / debugging ─────────────────────────────────────────

  /**
   * Print cache statistics to the console for debugging.
   */
  function cacheStats() {
    const cache = global.PacePackCache;
    const prefix = cache.getPrefix();
    let count = 0;
    let expired = 0;
    const keys = [];

    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) {
          count++;
          const ttl = cache.getCacheTTL(k.slice(prefix.length));
          if (ttl === 0) expired++;
          keys.push({ key: k.slice(prefix.length), ttlSeconds: ttl });
        }
      }
    } catch (_) {
      /* ignore */
    }

    console.table(keys);
    console.log(`Cache stats: ${count} entries (${expired} expired), prefix: "${prefix}"`);
  }

  // ─── Expose on global scope ─────────────────────────────────────────────────

  global.PacePackCacheExamples = {
    TTL,
    Keys,
    fetchUserProfile,
    fetchPersonalRecords,
    fetchGroupRuns,
    fetchLeaderboard,
    fetchMarathons,
    fetchRunners,
    invalidateUserProfile,
    invalidatePersonalRecords,
    invalidateGroupRuns,
    invalidateLeaderboard,
    invalidateGroupCache,
    invalidateRunnerCache,
    updateUserProfile,
    addRaceResult,
    refreshLeaderboard,
    cacheStats,
  };

})(typeof window !== "undefined" ? window : globalThis);
