/**
 * Phase 30.9 — Network monitor.
 *
 * Wraps `navigator.onLine` + window 'online' / 'offline' events into
 * a subscribable monitor. Used by the orchestrator's retry loop and
 * the upload-operations UI banner.
 *
 * SSR / Node returns a no-op monitor that reports "always online" —
 * tests inject their own monitor via the orchestrator config.
 */

export type NetworkSnapshot = {
  isOnline: boolean;
  /** ms since epoch when the last online → offline OR offline → online
   *  transition was observed. `null` if we've never seen a transition. */
  lastTransitionMs: number | null;
};

export type NetworkListener = (snapshot: NetworkSnapshot) => void;

export type NetworkMonitor = {
  snapshot(): NetworkSnapshot;
  isOnline(): boolean;
  subscribe(listener: NetworkListener): () => void;
  /** Manual probe — useful when the browser misreports navigator.onLine
   *  (e.g. captive portals). Optional; the orchestrator never relies
   *  on this in the hot path. */
  probe?(url: string): Promise<boolean>;
};

export function createNetworkMonitor(): NetworkMonitor {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return createNoopMonitor();
  }
  return createBrowserMonitor();
}

// =============================================================================
// Browser implementation
// =============================================================================

function createBrowserMonitor(): NetworkMonitor {
  let snap: NetworkSnapshot = {
    isOnline: navigator.onLine !== false,
    lastTransitionMs: null,
  };
  const listeners = new Set<NetworkListener>();

  const onTransition = (online: boolean) => {
    if (snap.isOnline === online) return;
    snap = {
      isOnline: online,
      lastTransitionMs: Date.now(),
    };
    for (const l of listeners) {
      try {
        l(snap);
      } catch {
        /* listener errors don't propagate */
      }
    }
  };

  window.addEventListener("online", () => onTransition(true));
  window.addEventListener("offline", () => onTransition(false));

  return {
    snapshot: () => snap,
    isOnline: () => snap.isOnline,
    subscribe(listener) {
      listeners.add(listener);
      listener(snap);
      return () => {
        listeners.delete(listener);
      };
    },
    async probe(url) {
      try {
        const res = await fetch(url, {
          method: "HEAD",
          cache: "no-store",
          // Allow CORS failures to bubble as "offline" rather than
          // crash — the probe is best-effort.
        });
        const online = res.ok;
        onTransition(online);
        return online;
      } catch {
        onTransition(false);
        return false;
      }
    },
  };
}

// =============================================================================
// No-op (SSR / tests)
// =============================================================================

function createNoopMonitor(): NetworkMonitor {
  const snap: NetworkSnapshot = { isOnline: true, lastTransitionMs: null };
  return {
    snapshot: () => snap,
    isOnline: () => true,
    subscribe(listener) {
      listener(snap);
      return () => {
        /* noop */
      };
    },
  };
}
