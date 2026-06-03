/**
 * Phase 21 — Alert dispatch service.
 *
 * Single entry point: `dispatchOpsAlert(input)`. The service:
 *   1. Resolves the active AlertProvider (webhook > noop).
 *   2. Applies a per-fingerprint in-memory rate limit (default: 1
 *      alert / 5 minutes / fingerprint).
 *   3. Applies a per-process global cap (default: 60 / hour).
 *   4. Dispatches via the provider; bumps metrics; never throws.
 *
 * Rate limiter is in-memory by design. The brief explicitly allows
 * per-instance dedup since the volume is bounded and the cost of
 * Redis is higher than the cost of a duplicate alert in a 2-instance
 * deployment.
 */
import { bump } from "../ops/metrics.service.js";
import { NoopAlertProvider } from "./noop-provider.js";
import { WebhookAlertProvider } from "./webhook-provider.js";
// -----------------------------------------------------------------------------
// Provider resolution
// -----------------------------------------------------------------------------
let cached = null;
export function getAlertProvider() {
    if (cached)
        return cached;
    const webhook = new WebhookAlertProvider();
    if (webhook.isReady()) {
        cached = webhook;
        return cached;
    }
    cached = new NoopAlertProvider();
    return cached;
}
export function setAlertProviderForTests(provider) {
    cached = provider;
    // Reset the throttle so tests don't see stale state.
    __resetAlertThrottleForTests();
}
// -----------------------------------------------------------------------------
// Rate limit
// -----------------------------------------------------------------------------
const PER_FINGERPRINT_WINDOW_MS = 5 * 60 * 1000;
const GLOBAL_HOUR_CAP = 60;
const recentByFingerprint = new Map();
const recentGlobalTimestamps = [];
function shouldThrottle(category, fingerprint, now) {
    // Global per-hour cap.
    const oneHourAgo = now - 60 * 60 * 1000;
    while (recentGlobalTimestamps.length > 0 && recentGlobalTimestamps[0] < oneHourAgo) {
        recentGlobalTimestamps.shift();
    }
    if (recentGlobalTimestamps.length >= GLOBAL_HOUR_CAP) {
        return true;
    }
    // Per-fingerprint window.
    const key = `${category}:${fingerprint}`;
    const lastAt = recentByFingerprint.get(key);
    if (lastAt !== undefined && now - lastAt < PER_FINGERPRINT_WINDOW_MS) {
        return true;
    }
    return false;
}
function recordSent(category, fingerprint, now) {
    recentByFingerprint.set(`${category}:${fingerprint}`, now);
    recentGlobalTimestamps.push(now);
    // Bound the map: oldest entries are cleaned opportunistically when
    // the map exceeds 500 keys.
    if (recentByFingerprint.size > 500) {
        let oldestKey = null;
        let oldestAt = Number.POSITIVE_INFINITY;
        for (const [k, at] of recentByFingerprint) {
            if (at < oldestAt) {
                oldestAt = at;
                oldestKey = k;
            }
        }
        if (oldestKey !== null)
            recentByFingerprint.delete(oldestKey);
    }
}
export function __resetAlertThrottleForTests() {
    recentByFingerprint.clear();
    recentGlobalTimestamps.length = 0;
}
// -----------------------------------------------------------------------------
// Dispatch
// -----------------------------------------------------------------------------
export async function dispatchOpsAlert(input) {
    const provider = getAlertProvider();
    if (!provider.isReady()) {
        return { ok: false, provider: provider.name, reason: "no_provider" };
    }
    const now = Date.now();
    if (shouldThrottle(input.category, input.fingerprint, now)) {
        bump("alert_suppressed_rate_limit");
        return { ok: false, provider: provider.name, reason: "rate_limited" };
    }
    recordSent(input.category, input.fingerprint, now);
    let result;
    try {
        result = await provider.dispatch(input);
    }
    catch {
        bump("alert_provider_failed");
        return { ok: false, provider: provider.name, reason: "dispatch_exception" };
    }
    if (result.ok) {
        bump("alert_sent");
    }
    else {
        bump("alert_provider_failed");
    }
    return result;
}
// -----------------------------------------------------------------------------
// Provider health (for /v1/ops/health)
// -----------------------------------------------------------------------------
export function buildAlertHealth() {
    const p = getAlertProvider();
    return { provider: p.name, ready: p.isReady() };
}
