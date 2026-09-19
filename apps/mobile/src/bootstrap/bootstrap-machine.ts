/**
 * DETERMINISTIC BOOTSTRAP STATE MACHINE (Phase 3). Pure reducer (type-only
 * imports) so it is unit-testable and is the single authority for the boot
 * decision — replacing the scattered "truthy token → /(tabs)" gate that let an
 * expired/invalid token fall into an authenticated-looking dead shell.
 *
 * Key invariants (audit §I / Master §7):
 *  - an auth failure while restoring → EXPIRED (token must be cleared) → gateway,
 *    never the main app with a dead token;
 *  - a NETWORK failure while restoring is NOT treated as invalid credentials —
 *    the token is kept and the app opens in an offline-authenticated state.
 */

export type BootPhase =
  | "restoring" // reading storage / validating session
  | "anonymous" // no valid session → AUTH_GATEWAY
  | "authenticated" // session validated (GET /v1/auth/me ok)
  | "offlineAuthed" // token present, /me unreachable (offline) → main app, degraded
  | "expired"; // token rejected (401) → cleared → AUTH_GATEWAY

export interface BootState {
  phase: BootPhase;
  /** True while the stored token is still considered usable (not cleared). */
  hasToken: boolean;
}

export type BootEvent =
  | { type: "RESTORE_NO_TOKEN" }
  | { type: "RESTORE_FOUND_TOKEN" }
  | { type: "ME_OK" }
  | { type: "ME_FAILED"; reason: "auth" | "network" }
  | { type: "SIGNED_IN" }
  | { type: "SIGNED_OUT" }
  | { type: "SESSION_EXPIRED" };

export const INITIAL_BOOT_STATE: BootState = { phase: "restoring", hasToken: false };

export function bootReducer(state: BootState, event: BootEvent): BootState {
  switch (event.type) {
    case "RESTORE_NO_TOKEN":
      return { phase: "anonymous", hasToken: false };
    case "RESTORE_FOUND_TOKEN":
      // keep restoring until /me resolves
      return { phase: "restoring", hasToken: true };
    case "ME_OK":
      return { phase: "authenticated", hasToken: true };
    case "ME_FAILED":
      // auth failure clears the token; network failure keeps it (offline).
      return event.reason === "auth"
        ? { phase: "expired", hasToken: false }
        : { phase: "offlineAuthed", hasToken: true };
    case "SIGNED_IN":
      return { phase: "authenticated", hasToken: true };
    case "SIGNED_OUT":
      return { phase: "anonymous", hasToken: false };
    case "SESSION_EXPIRED":
      return { phase: "expired", hasToken: false };
    default:
      // Unknown event: leave state unchanged (total function, no hidden states).
      return state;
  }
}

export type BootDestination = "gateway" | "main" | "pending";

/** The single routing decision derived from boot state. */
export function bootDestination(state: BootState): BootDestination {
  switch (state.phase) {
    case "authenticated":
    case "offlineAuthed":
      return "main";
    case "anonymous":
    case "expired":
      return "gateway";
    case "restoring":
    default:
      return "pending";
  }
}

/** A token must be purged from secure storage exactly when we reach EXPIRED. */
export function shouldClearToken(prev: BootState, next: BootState): boolean {
  return next.phase === "expired" && prev.phase !== "expired";
}
