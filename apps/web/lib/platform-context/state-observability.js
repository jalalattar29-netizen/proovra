/**
 * CR1.5 — Dev/test-only platform-state observability.
 *
 * RULES (enforced by this module + by `phase-cr1-5-state-observability.test.ts`):
 *
 *   1. Disabled by default. The `emit()` function is a no-op unless
 *      both:
 *        - `process.env.NODE_ENV !== "production"`, AND
 *        - the explicit opt-in flag `NEXT_PUBLIC_PLATFORM_STATE_OBSERVABILITY === "true"`
 *      is set in the build environment. Production builds never emit
 *      even if the flag is accidentally set, because the NODE_ENV gate
 *      fires first.
 *
 *   2. **Safe payload only.** Each event accepts ONLY:
 *        - event name (from the bounded `StateObservabilityEvent`
 *          union)
 *        - timestamp (auto-injected)
 *        - boolean flags
 *        - short safe labels (workspace scope label, persona profile
 *          code, surface name)
 *        - REDACTED workspace IDs (`"workspace_<first-8-chars>"`)
 *        - small integers (counts, version numbers)
 *      The TypeScript `SafePayload` shape FORBIDS the following at
 *      compile time: evidence content, raw GPS coordinates, secrets,
 *      tokens, raw API keys, email addresses, file paths, blobs.
 *
 *   3. **No production user-visible UI.** This module exposes events
 *      only — there is no React component, no DOM injection, no
 *      `window`-attached object in production.
 *
 *   4. **No broad runtime logging.** When the flag is set in dev,
 *      events go to `console.debug` and to an in-memory ring buffer
 *      (capped at 200 entries). The ring buffer is also the test
 *      hook — `recordedEvents()` returns a snapshot for assertions.
 *
 *   5. **Tree-shakeable.** Consumers that do not import from this
 *      module pay zero runtime cost. Importing only the types pays
 *      zero runtime cost.
 *
 * R1 may wire this utility into `PlatformContextProvider` state
 * transitions (e.g. `LOADING_CONTEXT → READY`, `READY → SWITCHING`,
 * `refresh()` invocation) and into the persona save handler so the
 * "Reload to see" UX bug becomes observable in dev traces. CR1.5
 * adds the utility but does NOT wire it — wiring is part of R1's
 * acceptance criteria.
 */
// =============================================================================
// Bounded event vocabulary
// =============================================================================
export const STATE_OBSERVABILITY_EVENTS = [
    "platform-envelope:loaded",
    "platform-envelope:refreshed",
    "platform-envelope:refresh-missing",
    "platform-envelope:switch-started",
    "platform-envelope:switch-succeeded",
    "platform-envelope:switch-failed",
    "active-space:resolved",
    "persona-profile:loaded",
    "persona-profile:saved",
    "persona-profile:refresh-missing",
    "sidebar:resolved",
    "dashboard:resolved",
    "onboarding:completed",
    "workspace:missing",
    "team-gate:personal-space-blocked",
    // R1.5B — workspace experience segmentation traces. Dev/test only.
    "workspace-experience:resolved",
    "navigation-mode:resolved",
    "dashboard-mode:resolved",
    "advanced-tooling:disclosed",
    // R3 — dashboard orchestration traces. Dev/test only.
    "dashboard-sections:resolved",
    "dashboard-priority:resolved",
    "dashboard-quick-actions:resolved",
];
// =============================================================================
// Production-gated emit
// =============================================================================
const MAX_LABEL_LEN = 64;
const RING_CAPACITY = 200;
function isObservabilityEnabled() {
    // Production gate fires first — the public flag cannot override it.
    if (typeof process === "undefined")
        return false;
    if (process.env.NODE_ENV === "production")
        return false;
    return process.env.NEXT_PUBLIC_PLATFORM_STATE_OBSERVABILITY === "true";
}
function sanitize(payload) {
    const out = {};
    for (const [key, value] of Object.entries(payload)) {
        if (typeof value === "string") {
            // Bounded label only — truncate aggressively to prevent leaking
            // long secrets/paths/email through the safe channel.
            out[key] = value.slice(0, MAX_LABEL_LEN);
        }
        else if (typeof value === "number") {
            // Integer cast — forbids floating point (no GPS precision).
            out[key] = Number.isFinite(value) ? Math.trunc(value) : 0;
        }
        else {
            out[key] = value;
        }
    }
    return out;
}
/**
 * Helper: convert a workspace id (UUID) to a redacted label safe for
 * dev-only emission. Never use the full id directly in payloads.
 */
export function redactWorkspaceId(id) {
    if (!id)
        return "workspace_none";
    return `workspace_${id.slice(0, 8)}`;
}
// In-memory ring buffer for test assertions. Never read by production
// rendering code.
const ring = [];
/**
 * Emit a state observability event. NO-OP in production builds and
 * when the explicit opt-in flag is not set.
 */
export function emit(event, surface, payload = {}) {
    if (!isObservabilityEnabled())
        return;
    const recorded = {
        event,
        tMs: Date.now(),
        surface: surface.slice(0, MAX_LABEL_LEN),
        payload: sanitize(payload),
    };
    ring.push(recorded);
    if (ring.length > RING_CAPACITY)
        ring.shift();
    // eslint-disable-next-line no-console
    if (typeof console !== "undefined" && console.debug) {
        console.debug("[platform-state]", recorded);
    }
}
// =============================================================================
// Test/diagnostic hooks (no-op-safe; never imported by production paths)
// =============================================================================
export function recordedEvents() {
    return ring.slice();
}
export function clearRecordedEvents() {
    ring.length = 0;
}
/**
 * Test-only: force enable. Use ONLY in tests; never call from app
 * code. The test sets the flag via this helper to avoid touching
 * `process.env` directly across worker threads.
 */
export function __testForceEnable(enabled) {
    if (process.env.NODE_ENV === "production")
        return;
    process.env.NEXT_PUBLIC_PLATFORM_STATE_OBSERVABILITY = enabled
        ? "true"
        : "false";
}
