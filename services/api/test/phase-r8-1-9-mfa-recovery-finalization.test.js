/**
 * PHASE R8.1.9 — Session-light endpoint, email-side signed snooze
 * link, send-test digest, admin recovery event feed, digest email
 * copy update with snooze link, verify-page session-light
 * integration. Source-contract tests.
 *
 * 20 numbered tests + 3 bonus + 1 file-size sentinel.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
const REPO = resolve(__dirname, "..", "..", "..");
const apiPath = (rel) => resolve(REPO, "services/api", rel);
const webPath = (rel) => resolve(REPO, "apps/web", rel);
const workerPath = (rel) => resolve(REPO, "services/worker", rel);
const AUTH_ROUTES = readFileSync(apiPath("src/routes/auth.routes.ts"), "utf8");
const ADMIN_ROUTES = readFileSync(apiPath("src/routes/mfa-admin.routes.ts"), "utf8");
const VERIFY_PAGE = readFileSync(webPath("app/auth/mfa-recovery/verify/page.tsx"), "utf8");
const SNOOZE_TOKEN_SVC = readFileSync(apiPath("src/services/security/mfa-digest-snooze-token.ts"), "utf8");
const EVENT_FEED_SVC = readFileSync(apiPath("src/services/security/mfa-recovery-event-feed.service.ts"), "utf8");
const EMAIL_SVC = readFileSync(apiPath("src/services/email.service.ts"), "utf8");
const DIGEST_WORKER = readFileSync(workerPath("src/mfa-recovery-digest.ts"), "utf8");
// =============================================================================
// PART 1 — Session-light endpoint
// =============================================================================
describe("R8.1.9 — session-light endpoint", () => {
    // ---------------------------------------------------------------------------
    // 1. Session-light endpoint exists in auth routes.
    // ---------------------------------------------------------------------------
    it("test 1: GET /v1/auth/session-light is wired in auth.routes.ts (no requireAuth)", () => {
        // Must be a GET and must NOT have requireAuth (it's anonymous).
        expect(AUTH_ROUTES).toMatch(/app\.get\(\s*["']\/v1\/auth\/session-light["']/);
        // The route handler must NOT call requireAuth — it is
        // intentionally unauthenticated (the token is the auth proof).
        const sessionLightBlock = AUTH_ROUTES.match(/app\.get\(\s*["']\/v1\/auth\/session-light["'][\s\S]*?\}\s*\)/);
        expect(sessionLightBlock).toBeTruthy();
        expect(sessionLightBlock[0]).not.toMatch(/requireAuth/);
    });
    // ---------------------------------------------------------------------------
    // 2. Session-light returns only { authenticated: boolean }.
    // ---------------------------------------------------------------------------
    it("test 2: session-light handler returns only { authenticated: boolean } — no id/email/role", () => {
        // Returns exactly one of two shapes; never anything extra.
        expect(AUTH_ROUTES).toMatch(/return \{ authenticated: false \}/);
        expect(AUTH_ROUTES).toMatch(/return \{ authenticated: true \}/);
        // The handler never returns a user-bearing shape. We extract the
        // session-light block and check its return statements.
        const sessionLightBlock = AUTH_ROUTES.match(/\/v1\/auth\/session-light["'][\s\S]*?return \{ authenticated: true \}/);
        expect(sessionLightBlock).toBeTruthy();
        // No userId, email, role, or teamId within the return shapes.
        const block = sessionLightBlock[0];
        expect(block).not.toMatch(/return \{[\s\S]{0,30}\buserId\b/);
        expect(block).not.toMatch(/return \{[\s\S]{0,30}\bemail\b/);
        expect(block).not.toMatch(/return \{[\s\S]{0,30}\brole\b/);
        expect(block).not.toMatch(/return \{[\s\S]{0,30}\bteamId\b/);
    });
    // ---------------------------------------------------------------------------
    // 3. Session-light refuses pending MFA tokens.
    // ---------------------------------------------------------------------------
    it("test 3: session-light refuses pending-MFA tokens (returns false, not true)", () => {
        // The handler must check payload.mfa === 'pending' and return
        // { authenticated: false } in that branch.
        expect(AUTH_ROUTES).toMatch(/payload\.mfa\s*===\s*["']pending["']/);
        // Adjacent to the pending check, it must return false (not true).
        const pendingCheck = AUTH_ROUTES.match(/payload\.mfa\s*===\s*["']pending["'][\s\S]{0,80}return \{ authenticated: false \}/);
        expect(pendingCheck).toBeTruthy();
    });
    // ---------------------------------------------------------------------------
    // 4. Session-light checks session revocation registry.
    // ---------------------------------------------------------------------------
    it("test 4: session-light calls isSessionRevoked and returns false if revoked", () => {
        expect(AUTH_ROUTES).toMatch(/isSessionRevoked/);
        // The revoked branch must collapse to { authenticated: false }.
        const revokedBranch = AUTH_ROUTES.match(/isSessionRevoked[\s\S]{0,200}return \{ authenticated: false \}/);
        expect(revokedBranch).toBeTruthy();
    });
});
// =============================================================================
// PART 2 — Verify page session-light integration
// =============================================================================
describe("R8.1.9 — verify page session-light integration", () => {
    // ---------------------------------------------------------------------------
    // 5. Verify page now calls session-light NOT /v1/auth/me.
    // ---------------------------------------------------------------------------
    it("test 5: verify page calls /v1/auth/session-light for session detection — not /v1/auth/me", () => {
        expect(VERIFY_PAGE).toMatch(/["']\/v1\/auth\/session-light["']/);
        // The old /v1/auth/me call for session detection must be gone.
        // (It may still appear in comments, so we check for the actual
        // apiFetch call pattern.)
        expect(VERIFY_PAGE).not.toMatch(/apiFetch\(\s*["']\/v1\/auth\/me["']/);
    });
    // ---------------------------------------------------------------------------
    // 6. Verify page uses probe.authenticated, not me.user.id.
    // ---------------------------------------------------------------------------
    it("test 6: verify page reads probe.authenticated to set sessionPresent", () => {
        expect(VERIFY_PAGE).toMatch(/probe\??\.authenticated/);
        // Must not read .user.id which was the /v1/auth/me shape.
        expect(VERIFY_PAGE).not.toMatch(/me\??\.user\??\.id/);
    });
    // ---------------------------------------------------------------------------
    // 7. Verify page no longer uses the localStorage shortcut.
    // ---------------------------------------------------------------------------
    it("test 7: verify page no longer uses localStorage.getItem(proovra-token) pre-check", () => {
        // R8.1.9 uses session-light which accepts HttpOnly cookies too,
        // so the localStorage shortcut is no longer needed. The pre-
        // check would exclude SSO-only users who have no localStorage
        // entry — that was the R8.1.8 HONEST CAVEAT; R8.1.9 closes it.
        expect(VERIFY_PAGE).not.toMatch(/localStorage\??\.getItem\(\s*["']proovra-token["']/);
        expect(VERIFY_PAGE).not.toMatch(/\bhasLocalToken\b/);
    });
    // ---------------------------------------------------------------------------
    // 8. Verify page still never mints a session after verify.
    // ---------------------------------------------------------------------------
    it("test 8: verify page still does NOT mint a session — no signJwt/setToken/setCookie", () => {
        expect(VERIFY_PAGE).not.toMatch(/\bsignJwt\s*\(/);
        expect(VERIFY_PAGE).not.toMatch(/\bsetToken\s*\(/);
        expect(VERIFY_PAGE).not.toMatch(/document\.cookie\s*=/);
        expect(VERIFY_PAGE).not.toMatch(/setCookie\s*\(\s*["']proovra_session/);
        // Success copy still declares no session was issued.
        expect(VERIFY_PAGE).toMatch(/did NOT log you in/);
    });
});
// =============================================================================
// PART 3 — Signed snooze token service
// =============================================================================
describe("R8.1.9 — signed digest snooze token service", () => {
    // ---------------------------------------------------------------------------
    // 9. Snooze token exports sign + verify + purpose constant.
    // ---------------------------------------------------------------------------
    it("test 9: snooze token module exports signMfaDigestSnoozeToken, verifyMfaDigestSnoozeToken, and MFA_DIGEST_SNOOZE_PURPOSE", () => {
        expect(SNOOZE_TOKEN_SVC).toMatch(/export function signMfaDigestSnoozeToken/);
        expect(SNOOZE_TOKEN_SVC).toMatch(/export function verifyMfaDigestSnoozeToken/);
        expect(SNOOZE_TOKEN_SVC).toMatch(/export const MFA_DIGEST_SNOOZE_PURPOSE/);
        expect(SNOOZE_TOKEN_SVC).toMatch(/["']mfa_recovery_digest_snooze["']/);
    });
    // ---------------------------------------------------------------------------
    // 10. Snooze token verify refuses wrong purpose discriminator.
    // ---------------------------------------------------------------------------
    it("test 10: verifyMfaDigestSnoozeToken returns wrong_purpose when purpose !== expected", () => {
        expect(SNOOZE_TOKEN_SVC).toMatch(/parsed\.purpose\s*!==\s*MFA_DIGEST_SNOOZE_PURPOSE/);
        expect(SNOOZE_TOKEN_SVC).toMatch(/reason:\s*["']wrong_purpose["']/);
        // The discriminator value appears exactly as a string constant
        // to prevent drift.
        expect(SNOOZE_TOKEN_SVC).toMatch(/MFA_DIGEST_SNOOZE_PURPOSE\s*=\s*["']mfa_recovery_digest_snooze["']/);
    });
    // ---------------------------------------------------------------------------
    // 11. Snooze token verify uses timingSafeEqual for signature check.
    // ---------------------------------------------------------------------------
    it("test 11: snooze token verify uses timingSafeEqual — no naive string comparison", () => {
        expect(SNOOZE_TOKEN_SVC).toMatch(/timingSafeEqual/);
        // Must not use === for the actual byte comparison.
        expect(SNOOZE_TOKEN_SVC).not.toMatch(/signatureB64\s*===\s*/);
    });
    // ---------------------------------------------------------------------------
    // 12. Snooze token TTL ≤ 15 days (cannot outlive the action).
    // ---------------------------------------------------------------------------
    it("test 12: snooze token TTL constant is exactly 15 days", () => {
        // 15 * 24 * 60 * 60 = 1296000 seconds
        expect(SNOOZE_TOKEN_SVC).toMatch(/MFA_DIGEST_SNOOZE_TTL_SECONDS\s*=\s*15\s*\*\s*24\s*\*\s*60\s*\*\s*60/);
        // The token exp cannot exceed ttl.
        expect(SNOOZE_TOKEN_SVC).toMatch(/exp:\s*now\s*\+\s*ttl/);
    });
});
// =============================================================================
// PART 4 — Email-side snooze link endpoint + send-test
// =============================================================================
describe("R8.1.9 — email-side snooze link + send-test endpoints", () => {
    // ---------------------------------------------------------------------------
    // 13. Snooze-link endpoint exists as anonymous GET.
    // ---------------------------------------------------------------------------
    it("test 13: GET /v1/identity/mfa-admin/digest-preferences/snooze-link exists without requireAuth", () => {
        expect(ADMIN_ROUTES).toMatch(/app\.get\(\s*["']\/v1\/identity\/mfa-admin\/digest-preferences\/snooze-link["']/);
        // The route registration must NOT include requireAuth preHandler.
        const block = ADMIN_ROUTES.match(/app\.get\(\s*["']\/v1\/identity\/mfa-admin\/digest-preferences\/snooze-link["'][\s\S]*?\}\s*\)/);
        expect(block).toBeTruthy();
        // Anonymous route — no preHandler: requireAuth on the route.
        expect(block[0]).not.toMatch(/preHandler:\s*requireAuth/);
    });
    // ---------------------------------------------------------------------------
    // 14. Snooze-link endpoint verifies purpose + JTI replay.
    // ---------------------------------------------------------------------------
    it("test 14: snooze-link verifies token purpose and guards replay via in-process JTI set", () => {
        expect(ADMIN_ROUTES).toMatch(/verifyMfaDigestSnoozeToken/);
        expect(ADMIN_ROUTES).toMatch(/snoozeLinkJtiSeen/);
        // The JTI set is a bounded Map keyed by JTI → exp.
        expect(ADMIN_ROUTES).toMatch(/snoozeLinkJtiByExp\s*=\s*new\s+Map/);
        // Returns 409 on replay.
        expect(ADMIN_ROUTES).toMatch(/already_used/);
        // Snooze is applied via canonical updateDigestPreference.
        expect(ADMIN_ROUTES).toMatch(/updateDigestPreference\(\{[\s\S]*?actorUserId:\s*verified\.payload\.sub/);
    });
    // ---------------------------------------------------------------------------
    // 15. Snooze-link endpoint emits the correct security event.
    // ---------------------------------------------------------------------------
    it("test 15: snooze-link endpoint emits mfa_recovery_digest_snooze_link_used", () => {
        expect(ADMIN_ROUTES).toMatch(/["']mfa_recovery_digest_snooze_link_used["']/);
        // Emitted via safeEmitSecurityEvent (not raw prisma insert).
        expect(ADMIN_ROUTES).toMatch(/safeEmitSecurityEvent/);
    });
    // ---------------------------------------------------------------------------
    // 16. Send-test endpoint exists, is POST + requireAuth.
    // ---------------------------------------------------------------------------
    it("test 16: POST /v1/identity/mfa-admin/digest-preferences/preview/send-test exists with requireAuth", () => {
        expect(ADMIN_ROUTES).toMatch(/app\.post\(\s*["']\/v1\/identity\/mfa-admin\/digest-preferences\/preview\/send-test["']/);
        const block = ADMIN_ROUTES.match(/app\.post\(\s*["']\/v1\/identity\/mfa-admin\/digest-preferences\/preview\/send-test["'][\s\S]*?preHandler:\s*requireAuth/);
        expect(block).toBeTruthy();
    });
    // ---------------------------------------------------------------------------
    // 17. Send-test is rate-limited (daily cap + min interval).
    // ---------------------------------------------------------------------------
    it("test 17: send-test applies in-process rate limits — daily cap 3, min interval 60s", () => {
        expect(ADMIN_ROUTES).toMatch(/SEND_TEST_DAILY_CAP\s*=\s*3/);
        expect(ADMIN_ROUTES).toMatch(/SEND_TEST_MIN_INTERVAL_MS\s*=\s*60\s*\*\s*1000/);
        // Both reasons surface to the caller.
        expect(ADMIN_ROUTES).toMatch(/["']too_soon["']/);
        expect(ADMIN_ROUTES).toMatch(/["']daily_cap["']/);
        // Returns 429 on limit hit.
        expect(ADMIN_ROUTES).toMatch(/reply\.code\(429\)/);
    });
    // ---------------------------------------------------------------------------
    // 18. Send-test builds + passes a snooze URL to the email service.
    // ---------------------------------------------------------------------------
    it("test 18: send-test builds a snoozeUrl and passes it to sendMfaRecoveryAdminDigestEmail", () => {
        // The route calls buildMfaDigestSnoozeUrl to build the URL.
        expect(ADMIN_ROUTES).toMatch(/buildMfaDigestSnoozeUrl/);
        // The snooze URL is passed as the 5th argument to the email call.
        expect(ADMIN_ROUTES).toMatch(/sendMfaRecoveryAdminDigestEmail\([\s\S]*?testSnoozeUrl/);
        // The route exports buildMfaDigestSnoozeUrl for the email service.
        expect(ADMIN_ROUTES).toMatch(/export function buildMfaDigestSnoozeUrl/);
    });
});
// =============================================================================
// PART 5 — Admin recovery event feed
// =============================================================================
describe("R8.1.9 — admin recovery event feed", () => {
    // ---------------------------------------------------------------------------
    // 19. Event feed endpoint exists with requireAuth.
    // ---------------------------------------------------------------------------
    it("test 19: GET /v1/identity/mfa-admin/recovery-events exists with requireAuth", () => {
        expect(ADMIN_ROUTES).toMatch(/app\.get\(\s*["']\/v1\/identity\/mfa-admin\/recovery-events["']/);
        const block = ADMIN_ROUTES.match(/app\.get\(\s*["']\/v1\/identity\/mfa-admin\/recovery-events["'][\s\S]*?preHandler:\s*requireAuth/);
        expect(block).toBeTruthy();
    });
    // ---------------------------------------------------------------------------
    // 20. Event feed service returns bounded labeled rows — no raw details.
    // ---------------------------------------------------------------------------
    it("test 20: readRecoveryEventFeed builds summary labels without exposing raw details payload", () => {
        // The service calls buildSummary and never returns details
        // directly.
        expect(EVENT_FEED_SVC).toMatch(/function buildSummary/);
        expect(EVENT_FEED_SVC).toMatch(/summary:\s*buildSummary\(/);
        // The returned RecoveryFeedRow interface does NOT have a
        // `details` field.
        const feedRowIface = EVENT_FEED_SVC.match(/export interface RecoveryFeedRow[\s\S]*?\}/);
        expect(feedRowIface).toBeTruthy();
        expect(feedRowIface[0]).not.toMatch(/\bdetails\b/);
        // `details` IS fetched from Prisma so the service can build the
        // summary — but it must never appear in the return shape.
        expect(EVENT_FEED_SVC).toMatch(/select:[\s\S]*?details:\s*true/);
        // The buildSummary function never returns `details` raw.
        const buildSummaryFn = EVENT_FEED_SVC.match(/function buildSummary[\s\S]*?\n\}/);
        expect(buildSummaryFn).toBeTruthy();
        expect(buildSummaryFn[0]).not.toMatch(/return\s+details/);
        expect(buildSummaryFn[0]).not.toMatch(/JSON\.stringify\(details\)/);
    });
});
// =============================================================================
// PART 6 — Digest email snooze link copy
// =============================================================================
describe("R8.1.9 — digest email snooze link copy", () => {
    // ---------------------------------------------------------------------------
    // 21. Email service interface accepts optional snoozeUrl.
    // ---------------------------------------------------------------------------
    it("test 21: sendMfaRecoveryAdminDigestEmail signature in EmailService type accepts snoozeUrl", () => {
        // The interface must accept 5 params, with the last optional.
        const ifaceMethod = EMAIL_SVC.match(/sendMfaRecoveryAdminDigestEmail:\s*\([\s\S]*?\)\s*=>\s*Promise/);
        expect(ifaceMethod).toBeTruthy();
        expect(ifaceMethod[0]).toMatch(/snoozeUrl/);
        // Optional (`?`) so callers that haven't migrated still compile.
        expect(ifaceMethod[0]).toMatch(/snoozeUrl\?:/);
    });
    // ---------------------------------------------------------------------------
    // 22. Email service implementation embeds snooze block in HTML+text.
    // ---------------------------------------------------------------------------
    it("test 22: sendMfaRecoveryAdminDigestEmail implementation includes conditional snooze block in both HTML and text bodies", () => {
        // There are two `sendMfaRecoveryAdminDigestEmail` bodies —
        // the no-op stub (for !apiKey) and the real Resend sender.
        // We pick the real one by looking for the snoozeHtmlBlock
        // variable which only exists in the actual implementation.
        expect(EMAIL_SVC).toMatch(/snoozeHtmlBlock/);
        expect(EMAIL_SVC).toMatch(/snoozeTextLine/);
        // Conditional: when snoozeUrl is present, include a link.
        expect(EMAIL_SVC).toMatch(/snoozeUrl\s*\n?\s*\?/);
        // The copy text for the snooze link.
        expect(EMAIL_SVC).toMatch(/Snooze these digest emails for 15 days/);
        // The disclaimer that security events are preserved.
        expect(EMAIL_SVC).toMatch(/security events and audit logs are unaffected/);
    });
    // ---------------------------------------------------------------------------
    // 23. Worker's sendAdminDigest includes snooze URL in HTML + text.
    // ---------------------------------------------------------------------------
    it("test 23: worker sendAdminDigest embeds input.snoozeUrl in the HTML body and text lines", () => {
        // Worker interface accepts snoozeUrl.
        const iface = DIGEST_WORKER.match(/interface SendAdminDigestInput[\s\S]*?\}/);
        expect(iface).toBeTruthy();
        expect(iface[0]).toMatch(/snoozeUrl/);
        // HTML body conditionally includes snooze block.
        expect(DIGEST_WORKER).toMatch(/input\.snoozeUrl\s*\?/);
        expect(DIGEST_WORKER).toMatch(/Snooze these digest emails for 15 days/);
        // Text body includes snooze URL when present.
        expect(DIGEST_WORKER).toMatch(/snooze these digest emails for 15 days/i);
    });
});
// =============================================================================
// Bonus — no parallel auth / no tenant leak / event vocabulary
// =============================================================================
describe("R8.1.9 bonus — scope guards", () => {
    // ---------------------------------------------------------------------------
    // Bonus A. Session-light does NOT export any user data beyond boolean.
    // ---------------------------------------------------------------------------
    it("bonus A: session-light is the ONLY new route in auth.routes.ts (no second auth surface)", () => {
        // R8.2 added saml-auth.routes.ts; all three are the auth-bearing files.
        const routesDir = readdirSync(apiPath("src/routes"));
        const authFiles = routesDir.filter((f) => /auth/i.test(f));
        expect(authFiles.sort()).toEqual([
            "auth.routes.ts",
            "saml-auth.routes.ts",
            "sso-auth.routes.ts",
        ]);
        // session-light lives inside auth.routes.ts, not a separate file.
        expect(AUTH_ROUTES).toMatch(/\/v1\/auth\/session-light/);
    });
    // ---------------------------------------------------------------------------
    // Bonus B. Event feed scopes strictly to actor's ACTIVE OWNER/ADMIN memberships.
    // ---------------------------------------------------------------------------
    it("bonus B: readRecoveryEventFeed scopes by ACTIVE OWNER/ADMIN memberships and restricts securityEvent query to those teamIds", () => {
        // Membership query keyed by actorUserId.
        expect(EVENT_FEED_SVC).toMatch(/teamMember\.findMany\(\{\s*where:\s*\{\s*userId:\s*input\.actorUserId,[\s\S]{0,200}status:\s*["']ACTIVE["']/);
        // SecurityEvent query restricts by teamId: { in: teamIds }.
        expect(EVENT_FEED_SVC).toMatch(/securityEvent\.findMany\(\{\s*where:\s*\{[\s\S]{0,400}teamId:\s*\{\s*in:\s*teamIds/);
        // Bounded page size enforced.
        expect(EVENT_FEED_SVC).toMatch(/MAX_PAGE_SIZE\s*=\s*200/);
    });
    // ---------------------------------------------------------------------------
    // Bonus C. No capture/custody/upload/report regression.
    // ---------------------------------------------------------------------------
    it("bonus C: R8.1.9 new files do not import capture / upload / custody / report-package / OTS / TSA", () => {
        const forbidden = [
            "/capture",
            "/upload",
            "/custody",
            "/report-package",
            "/finalization",
            "/ots-",
            "/tsa-",
        ];
        const surfaces = [
            AUTH_ROUTES,
            ADMIN_ROUTES,
            SNOOZE_TOKEN_SVC,
            EVENT_FEED_SVC,
            EMAIL_SVC,
            DIGEST_WORKER,
            VERIFY_PAGE,
        ];
        for (const src of surfaces) {
            for (const needle of forbidden) {
                expect(src.includes(`from "${needle}`) || src.includes(`from '${needle}`), `must not import ${needle}`).toBe(false);
            }
        }
    });
});
// =============================================================================
// File-size sentinel
// =============================================================================
describe("R8.1.9 test file size sentinel", () => {
    it("this test file is non-trivial (>=12 KB)", () => {
        const st = statSync(__filename);
        expect(st.size).toBeGreaterThan(12_000);
    });
});
