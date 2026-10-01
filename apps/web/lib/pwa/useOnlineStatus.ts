"use client";

import { useSyncExternalStore } from "react";

/**
 * The browser's own connectivity signal (`navigator.onLine` + online/offline
 * events). It can report "online" on a captive or broken network, so it is a
 * HINT for UX (disable actions that certainly cannot work, explain why), never
 * a guarantee that a request will succeed. SSR snapshot: online.
 */
function subscribe(callback: () => void): () => void {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

function getSnapshot(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine !== false;
}

export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => true);
}
