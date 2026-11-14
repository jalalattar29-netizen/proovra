/**
 * F-18 — the browser event `apiFetch` dispatches when a response says the
 * session is no longer valid, and the platform context listens for.
 *
 * Its own module (not lib/api) so the listener does not depend on the API
 * client's module shape: components and tests that substitute lib/api still
 * load the context provider unchanged.
 */
export const SESSION_EXPIRED_EVENT = "proovra:session-expired";
