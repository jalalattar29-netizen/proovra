/**
 * Canonical network-awareness signal (Phase 3, dependency-free). The API layer
 * reports the outcome of each request; screens/providers subscribe. This avoids
 * a new NetInfo dependency while giving one truthful online/offline/unknown
 * owner. Offline is derived from actual transport failures — it is NEVER
 * conflated with invalid credentials (that lives in the auth/safe-error layer).
 */
export type NetworkStatus = "online" | "offline" | "unknown";

let status: NetworkStatus = "unknown";
const listeners = new Set<(s: NetworkStatus) => void>();

export function getNetworkStatus(): NetworkStatus {
  return status;
}

export function subscribeNetwork(cb: (s: NetworkStatus) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function set(next: NetworkStatus): void {
  if (next === status) return;
  status = next;
  for (const cb of listeners) cb(status);
}

/** Called by the API layer: a completed response ⇒ online. */
export function reportNetworkOnline(): void {
  set("online");
}

/** Called by the API layer: a transport failure ⇒ offline. */
export function reportNetworkOffline(): void {
  set("offline");
}
