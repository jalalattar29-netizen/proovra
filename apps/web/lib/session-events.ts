/**
 * F-18 — the browser event `apiFetch` dispatches when a response says the
 * session is no longer valid, and the platform context listens for.
 *
 * Its own module (not lib/api) so the listener does not depend on the API
 * client's module shape: components and tests that substitute lib/api still
 * load the context provider unchanged.
 */
export const SESSION_EXPIRED_EVENT = "proovra:session-expired";

/**
 * A1-06 — the browser event `apiFetch` dispatches when the server refuses a
 * write because the current terms are not accepted (428
 * `LEGAL_REACCEPT_REQUIRED`). The acceptance step listens for it, so a refusal
 * that arrives after the page loaded (terms updated mid-session) puts the
 * actionable prompt in front of the person instead of a dead-end error.
 */
export const LEGAL_REACCEPT_REQUIRED_EVENT = "proovra:legal-reaccept-required";
