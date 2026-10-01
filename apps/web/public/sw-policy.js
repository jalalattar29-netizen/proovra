/*
 * PROOVRA service-worker ROUTE POLICY — the one authority for what the service
 * worker may cache. Loaded by /sw.js with importScripts and, unchanged, by
 * apps/web/__tests__/pwa-service-worker-policy.test.ts in a VM context.
 *
 * WHAT IS NEVER CACHED (network-only, not even intercepted):
 *   - any non-GET request;
 *   - anything cross-origin: the API origin, presigned storage URLs, OAuth
 *     providers, analytics — so evidence bytes, presigned URLs and API
 *     responses can never land in a cache;
 *   - same-origin /v1/* and /api/* (relative API paths, should any exist);
 *   - page navigations: every page may be authenticated or tenant-specific,
 *     so it is always fetched from the network. Only when the network FAILS
 *     is the static, content-free /offline.html shown instead;
 *   - any response that is not a plain 200 same-origin ("basic") response, or
 *     that says Cache-Control no-store / private.
 *
 * WHAT IS CACHED: the static application shell only — content-hashed Next.js
 * build assets (/_next/static/, immutable, cache-first), the brand/icon assets,
 * the manifest and the offline page (stale-while-revalidate).
 */
(function (root) {
  var VERSION = "proovra-sw-v1";
  var CACHE_PREFIX = "proovra-";
  var STATIC_CACHE = VERSION + "-static";
  var OFFLINE_URL = "/offline.html";
  var PRECACHE = [
    OFFLINE_URL,
    "/manifest.webmanifest",
    "/icons/icon-192.png",
    "/icons/icon-512.png",
  ];

  var SHELL_PREFIXES = ["/assets/", "/brand/", "/images/", "/icons/"];
  var SHELL_EXACT = ["/manifest.webmanifest", OFFLINE_URL];

  /**
   * decide({ method, url, mode, origin }) → one of
   *   { strategy: "bypass" }            not intercepted at all (network-only)
   *   { strategy: "navigate-network" }  network, offline page only on failure
   *   { strategy: "cache-first" }       immutable build asset
   *   { strategy: "stale-while-revalidate" }  static shell asset
   */
  function decide(req) {
    if (!req || String(req.method || "GET").toUpperCase() !== "GET") return { strategy: "bypass" };
    var url;
    try {
      url = new URL(req.url);
    } catch (e) {
      return { strategy: "bypass" };
    }
    if (url.origin !== req.origin) return { strategy: "bypass" };
    var path = url.pathname;
    if (path.indexOf("/v1/") === 0 || path === "/v1" || path.indexOf("/api/") === 0) {
      return { strategy: "bypass" };
    }
    if (url.search && /(?:^|[?&])(X-Amz-|Signature=|token=)/i.test(url.search)) {
      return { strategy: "bypass" };
    }
    if (req.mode === "navigate") return { strategy: "navigate-network" };
    if (path.indexOf("/_next/static/") === 0) return { strategy: "cache-first" };
    if (SHELL_EXACT.indexOf(path) !== -1) return { strategy: "stale-while-revalidate" };
    for (var i = 0; i < SHELL_PREFIXES.length; i++) {
      if (path.indexOf(SHELL_PREFIXES[i]) === 0) return { strategy: "stale-while-revalidate" };
    }
    return { strategy: "bypass" };
  }

  /** May this response be stored? Only plain same-origin 200s without no-store/private. */
  function cacheable(res) {
    if (!res || res.status !== 200 || res.type !== "basic") return false;
    var cc = "";
    try {
      cc = (res.headers && res.headers.get && res.headers.get("cache-control")) || "";
    } catch (e) {
      cc = "";
    }
    return !/no-store|private/i.test(cc);
  }

  root.ProovraSwPolicy = {
    VERSION: VERSION,
    CACHE_PREFIX: CACHE_PREFIX,
    STATIC_CACHE: STATIC_CACHE,
    OFFLINE_URL: OFFLINE_URL,
    PRECACHE: PRECACHE,
    decide: decide,
    cacheable: cacheable,
  };
})(typeof self !== "undefined" ? self : globalThis);
