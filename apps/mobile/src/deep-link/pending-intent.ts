/**
 * Pending deep-link intent (Phase 3). When an external link arrives while
 * unauthenticated, its in-app destination is stashed here and replayed after
 * the auth → MFA → legal journey completes. The destination screen still
 * enforces authorization via its own authenticated fetch (server remains the
 * authority); this only preserves *where the user was going*. In-memory: it
 * survives the auth journey within one app launch, which is the requirement.
 */
let pending: string | null = null;

export function setPendingRoute(route: string): void {
  pending = route;
}

export function peekPendingRoute(): string | null {
  return pending;
}

/** Read and clear the pending route (one-shot). */
export function takePendingRoute(): string | null {
  const r = pending;
  pending = null;
  return r;
}
