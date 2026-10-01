/*
 * PROOVRA service worker. Policy: /sw-policy.js (the one authority; see its
 * header for what is never cached).
 *
 * UPDATE SAFETY: a new worker installs and WAITS. It never calls
 * skipWaiting() on its own — only when the page posts { type: "SKIP_WAITING" }
 * after the user chose "Reload" in the update prompt — so a tab is never
 * switched to new code mid-capture or mid-upload.
 *
 * LOGOUT: the page posts { type: "CLEAR_CACHES" } (and also deletes the
 * caches itself through the Cache Storage API) so nothing from a session
 * survives sign-out. Only static shell assets are ever cached, but they are
 * cleared anyway.
 */
/* global self, caches, fetch, importScripts */
importScripts("/sw-policy.js");

var P = self.ProovraSwPolicy;

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(P.STATIC_CACHE).then(function (cache) {
      return cache.addAll(P.PRECACHE);
    }),
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys
            .filter(function (k) {
              return k.indexOf(P.CACHE_PREFIX) === 0 && k !== P.STATIC_CACHE;
            })
            .map(function (k) {
              return caches.delete(k);
            }),
        );
      })
      .then(function () {
        return self.clients.claim();
      }),
  );
});

self.addEventListener("message", function (event) {
  var data = event.data || {};
  if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }
  if (data.type === "CLEAR_CACHES") {
    event.waitUntil(
      caches.keys().then(function (keys) {
        return Promise.all(
          keys
            .filter(function (k) {
              return k.indexOf(P.CACHE_PREFIX) === 0;
            })
            .map(function (k) {
              return caches.delete(k);
            }),
        );
      }),
    );
  }
});

function putIfCacheable(request, response) {
  if (!P.cacheable(response)) return;
  var copy = response.clone();
  caches.open(P.STATIC_CACHE).then(function (cache) {
    cache.put(request, copy);
  });
}

self.addEventListener("fetch", function (event) {
  var req = event.request;
  var decision = P.decide({
    method: req.method,
    url: req.url,
    mode: req.mode,
    origin: self.location.origin,
  });

  if (decision.strategy === "bypass") return; // network-only, untouched

  if (decision.strategy === "navigate-network") {
    event.respondWith(
      fetch(req).catch(function () {
        return caches.match(P.OFFLINE_URL).then(function (offline) {
          return offline || Response.error();
        });
      }),
    );
    return;
  }

  if (decision.strategy === "cache-first") {
    event.respondWith(
      caches.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          putIfCacheable(req, res);
          return res;
        });
      }),
    );
    return;
  }

  // stale-while-revalidate
  event.respondWith(
    caches.match(req).then(function (hit) {
      var network = fetch(req)
        .then(function (res) {
          putIfCacheable(req, res);
          return res;
        })
        .catch(function () {
          return hit || Response.error();
        });
      return hit || network;
    }),
  );
});
