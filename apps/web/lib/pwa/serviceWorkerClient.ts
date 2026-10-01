/**
 * PWA — the page side of the service worker (public/sw.js).
 *
 *   registerServiceWorker  production only; never in dev (a dev SW caches a
 *                          moving build). Opt out with NEXT_PUBLIC_PWA_ENABLED=false.
 *   applyWaitingUpdate     the ONLY path to skipWaiting: the user chose Reload.
 *   clearServiceWorkerCaches  logout: deletes every proovra-* cache (and tells
 *                          the worker to do the same).
 */

export const SW_URL = "/sw.js";
export const SW_CACHE_PREFIX = "proovra-";

export function serviceWorkerEnabled(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  if (!("serviceWorker" in navigator)) return false;
  if (process.env.NEXT_PUBLIC_PWA_ENABLED === "false") return false;
  return process.env.NODE_ENV === "production";
}

/**
 * Registers the worker and reports a WAITING update (installed, not active)
 * through `onUpdateWaiting`. Never activates it by itself.
 */
export async function registerServiceWorker(
  onUpdateWaiting: (registration: ServiceWorkerRegistration) => void,
): Promise<ServiceWorkerRegistration | null> {
  if (!serviceWorkerEnabled()) return null;
  try {
    const registration = await navigator.serviceWorker.register(SW_URL, { scope: "/" });
    if (registration.waiting && navigator.serviceWorker.controller) onUpdateWaiting(registration);
    registration.addEventListener("updatefound", () => {
      const installing = registration.installing;
      if (!installing) return;
      installing.addEventListener("statechange", () => {
        // A worker that installed while another controls the page is an
        // UPDATE; the first install (no controller) needs no prompt.
        if (installing.state === "installed" && navigator.serviceWorker.controller) {
          onUpdateWaiting(registration);
        }
      });
    });
    return registration;
  } catch {
    // Registration failure must never break the app.
    return null;
  }
}

/** User consented: activate the waiting worker, then reload once it controls the page. */
export function applyWaitingUpdate(registration: ServiceWorkerRegistration): void {
  const waiting = registration.waiting;
  if (!waiting) return;
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });
  waiting.postMessage({ type: "SKIP_WAITING" });
}

/** Logout: nothing a session touched survives sign-out. Best-effort, never throws. */
export async function clearServiceWorkerCaches(): Promise<void> {
  try {
    if (typeof navigator !== "undefined" && navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage({ type: "CLEAR_CACHES" });
    }
  } catch {
    /* ignore */
  }
  try {
    if (typeof caches !== "undefined") {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith(SW_CACHE_PREFIX)).map((k) => caches.delete(k)));
    }
  } catch {
    /* ignore */
  }
}
