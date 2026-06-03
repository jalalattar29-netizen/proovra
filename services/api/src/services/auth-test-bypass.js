/**
 * Phase 2.7Z+ — E2E auth rate-limit bypass (env-gated, production-safe).
 *
 * Background:
 *   The Playwright suite issues many guest-auth sessions in rapid
 *   succession (every test invokes `createGuestSession()`). The
 *   production rate limit (5 per IP per 60 s) is shared by every
 *   in-flight test because all tests appear to the API as
 *   localhost / 127.0.0.1. As the suite grew past ~40 sessions per
 *   3-minute run, the limit started triggering and cascading
 *   into unrelated tests as HTTP 429 RATE_LIMITED.
 *
 *   The brief explicitly forbids weakening the production rate
 *   limiter. This module implements the allowed solution: a
 *   dedicated E2E bypass header gated by an environment-scoped
 *   shared secret, with three layers of defense against accidental
 *   activation on production.
 *
 * How it works:
 *   - Operator/CI sets `E2E_AUTH_BYPASS_SECRET=<32+ char random>` in
 *     the test environment (and ONLY in the test environment).
 *   - Playwright sends header `X-E2E-Auth-Bypass: <secret>` on every
 *     guest-auth request.
 *   - The auth route calls `shouldBypassAuthRateLimit(req)` BEFORE
 *     consulting `enforceRateLimit`. When the helper returns true,
 *     the route skips the rate-limit check for that request only.
 *
 * Defense in depth (any single failure disables the bypass):
 *
 *   1. `NODE_ENV === "production"`        → bypass DISABLED, always.
 *      Even if the env var and header both somehow appear in prod,
 *      the production NODE_ENV check blocks the bypass.
 *
 *   2. `E2E_AUTH_BYPASS_SECRET` unset OR
 *      shorter than 32 chars              → bypass DISABLED.
 *      Defensive minimum length prevents accidental weak secrets;
 *      production deployment never sets the variable.
 *
 *   3. `X-E2E-Auth-Bypass` header missing
 *      or doesn't match the env value     → bypass DISABLED.
 *      Constant-time string comparison defeats timing-based
 *      enumeration of the secret.
 *
 *   4. ALL bypass hits are logged at INFO level with a request id
 *      so post-hoc audit can detect any unexpected use.
 *
 * Operational rules:
 *   - The env var MUST NOT appear in any production deployment.
 *   - The env var MUST be rotated if it ever leaks (treat it like
 *     a JWT signing key for ops purposes).
 *   - Local developers running e2e set it in `services/api/.env`
 *     via `.env.audit-local.example` (which contains a documented
 *     test-only default — never use that value in production).
 *
 * Scope:
 *   - Stage 1 (this module) covers the guest-auth rate limit only,
 *     since that's the documented failure mode. Future expansion
 *     to email-login / password-reset rate limits would re-use
 *     this helper.
 *   - This module does NOT touch the public verify rate limiter.
 *     Tests that specifically exercise the public-verify
 *     rate-limit contract (e.g. phase2-3 verify-privacy.spec.ts)
 *     continue to drive that limiter via the real path.
 */
const HEADER_NAME = "x-e2e-auth-bypass";
const MIN_SECRET_LENGTH = 32;
/**
 * Constant-time string equality. Defeats timing-based byte-by-byte
 * enumeration of the secret value. Both strings are first compared
 * by length; mismatched length short-circuits to false without
 * leaking the expected length (the attacker already controls the
 * supplied length, so this is informational at best).
 */
function constantTimeEquals(a, b) {
    if (a.length !== b.length)
        return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}
/**
 * Returns true ONLY when:
 *   - NODE_ENV is not "production"
 *   - E2E_AUTH_BYPASS_SECRET is set and at least 32 chars
 *   - the `X-E2E-Auth-Bypass` header on the request matches
 *     the env value via constant-time comparison
 *
 * The caller is responsible for SKIPPING the rate-limit enforcement
 * when this returns true. The caller is ALSO responsible for
 * emitting a log line documenting the bypass — this module returns
 * the boolean only.
 */
export function shouldBypassAuthRateLimit(req) {
    // Layer 1 — production is sacred. Never bypass, regardless of
    // env or header. This survives accidental env-var leakage.
    if (process.env.NODE_ENV === "production")
        return false;
    // Layer 2 — env var must be set and meet a minimum entropy bar.
    const expected = (process.env.E2E_AUTH_BYPASS_SECRET ?? "").trim();
    if (!expected || expected.length < MIN_SECRET_LENGTH)
        return false;
    // Layer 3 — header must be present and match exactly.
    const raw = req.headers[HEADER_NAME];
    const got = Array.isArray(raw) ? raw[0] ?? "" : (raw ?? "").toString();
    const trimmed = got.trim();
    if (!trimmed)
        return false;
    return constantTimeEquals(trimmed, expected);
}
/**
 * Operator-readable structured log payload for bypass hits. The
 * caller passes this into Fastify's `req.log.info` so the bypass is
 * visible in any production audit log search. We never log the
 * secret itself — only that a bypass was honored.
 */
export function buildBypassLogPayload(req) {
    return {
        bucket: "e2e-bypass",
        route: req.url,
        headerPresent: Boolean(req.headers[HEADER_NAME]),
    };
}
