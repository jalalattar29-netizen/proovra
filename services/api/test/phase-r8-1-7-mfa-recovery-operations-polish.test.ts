/**
 * PHASE R8.1.7 — Digest preferences, multi-team digest grouping,
 * digest failure handling, verify-page session detection, recovery
 * analytics. Source-contract tests.
 *
 * 19 numbered tests + 3 bonus + 1 file-size sentinel.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "..", "..", "..");
const apiPath = (rel: string) => resolve(REPO, "services/api", rel);
const webPath = (rel: string) => resolve(REPO, "apps/web", rel);
const workerPath = (rel: string) => resolve(REPO, "services/worker", rel);
const sharedPath = (rel: string) => resolve(REPO, "packages/shared", rel);

const SCHEMA = readFileSync(apiPath("prisma/schema.prisma"), "utf8");
const SHARED_SEC = readFileSync(sharedPath("src/security.ts"), "utf8");
const DIGEST_PREF_SVC = readFileSync(
  apiPath("src/services/security/mfa-digest-preference.service.ts"),
  "utf8",
);
const ADMIN_ROUTES = readFileSync(
  apiPath("src/routes/mfa-admin.routes.ts"),
  "utf8",
);
const RECOVERY_SVC = readFileSync(
  apiPath("src/services/security/mfa-recovery-request.service.ts"),
  "utf8",
);
const DIGEST_WORKER = readFileSync(
  workerPath("src/mfa-recovery-digest.ts"),
  "utf8",
);
const VERIFY_PAGE = readFileSync(
  webPath("app/auth/mfa-recovery/verify/page.tsx"),
  "utf8",
);
const ADMIN_SPA = readFileSync(
  webPath("app/(app)/security-center/mfa-recovery/page.tsx"),
  "utf8",
);

// =============================================================================
// PART 1 — Digest preference model + service + route
// =============================================================================

describe("R8.1.7 — admin digest notification preferences", () => {
  // ---------------------------------------------------------------------------
  // 1. Digest preference model exists.
  // ---------------------------------------------------------------------------
  it("test 1: MfaAdminDigestPreference Prisma model exists with the bounded fields", () => {
    expect(SCHEMA).toMatch(/model MfaAdminDigestPreference \{/);
    expect(SCHEMA).toMatch(/userId\s+String/);
    expect(SCHEMA).toMatch(/teamId\s+String\?/);
    expect(SCHEMA).toMatch(/digestEnabled\s+Boolean/);
    expect(SCHEMA).toMatch(/suppressUntil\s+DateTime\?/);
    // UNIQUE on (userId, teamId).
    expect(SCHEMA).toMatch(/@@unique\(\[userId,\s*teamId\]\)/);
    // Migration ships.
    const migrations = readdirSync(apiPath("prisma/migrations"));
    expect(
      migrations.some((m) => m.endsWith("_r8_1_7_digest_preferences")),
    ).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 2. Preference default is enabled.
  // ---------------------------------------------------------------------------
  it("test 2: schema default + service default + worker fallback all ENABLED", () => {
    expect(SCHEMA).toMatch(/digestEnabled\s+Boolean\s+@default\(true\)/);
    // Service `shouldSendDigest` returns true when no row exists.
    const helper = DIGEST_PREF_SVC.match(
      /export function shouldSendDigest[\s\S]*?\n\}/,
    );
    expect(helper).toBeTruthy();
    expect(helper![0]).toMatch(/if\s*\(!effective\)\s*return true/);
    // Worker uses an equivalent local helper.
    expect(DIGEST_WORKER).toMatch(/function isDigestAllowed/);
    expect(DIGEST_WORKER).toMatch(/if\s*\(!effective\)\s*return true/);
  });

  // ---------------------------------------------------------------------------
  // 3. User can update own digest preference.
  // ---------------------------------------------------------------------------
  it("test 3: PATCH /v1/identity/mfa-admin/digest-preferences uses the authenticated actor as userId", () => {
    expect(ADMIN_ROUTES).toMatch(
      /app\.patch\(\s*["']\/v1\/identity\/mfa-admin\/digest-preferences["']/,
    );
    // The route never reads userId from the body; it always uses
    // the session userId from getAuthUserId(req).
    const block = ADMIN_ROUTES.match(
      /app\.patch\(\s*["']\/v1\/identity\/mfa-admin\/digest-preferences["'][\s\S]*?\}\s*,\s*\)\s*;/,
    );
    expect(block).toBeTruthy();
    expect(block![0]).toMatch(/getAuthUserId\(req\)/);
    expect(block![0]).toMatch(/actorUserId,\s*$/m);
    // Body schema does NOT accept a userId override.
    expect(ADMIN_ROUTES).toMatch(/PatchDigestPreferenceBody/);
    const bodySchema = ADMIN_ROUTES.match(
      /const PatchDigestPreferenceBody\s*=[\s\S]*?\}\);/,
    );
    expect(bodySchema).toBeTruthy();
    expect(bodySchema![0]).not.toMatch(/userId:/);
  });

  // ---------------------------------------------------------------------------
  // 4. Team-specific preference requires membership in that team.
  // ---------------------------------------------------------------------------
  it("test 4: team-scoped preference requires ACTIVE membership", () => {
    expect(DIGEST_PREF_SVC).toMatch(
      /if\s*\(input\.teamId\)\s*\{[\s\S]{0,200}teamMember\.findFirst/,
    );
    expect(DIGEST_PREF_SVC).toMatch(
      /teamId:\s*input\.teamId,\s*status:\s*["']ACTIVE["']/,
    );
    expect(DIGEST_PREF_SVC).toMatch(/reason:\s*["']not_member["']/);
  });

  // ---------------------------------------------------------------------------
  // 5. Preferences affect digest recipients only — NOT audit / security.
  // ---------------------------------------------------------------------------
  it("test 5: preferences are read only by digest sender; not consulted in audit/security event paths", () => {
    // The recovery service (which writes audit + security events
    // for every state change) does NOT import the digest
    // preference service.
    expect(RECOVERY_SVC).not.toMatch(/mfa-digest-preference/);
    // The admin lifecycle service likewise.
    const adminSvc = readFileSync(
      apiPath("src/services/security/mfa-admin-lifecycle.service.ts"),
      "utf8",
    );
    expect(adminSvc).not.toMatch(/mfa-digest-preference/);
    // Only the digest worker honours the preference.
    expect(DIGEST_WORKER).toMatch(/mfaAdminDigestPreference\.findMany/);
  });
});

// =============================================================================
// PART 2 — Multi-team digest grouping
// =============================================================================

describe("R8.1.7 — multi-team digest grouping", () => {
  // ---------------------------------------------------------------------------
  // 6. Multi-team digest groups requests into one admin email.
  // ---------------------------------------------------------------------------
  it("test 6: worker builds per-admin team-summary list + sends ONE email per admin (not per team)", () => {
    expect(DIGEST_WORKER).toMatch(/teamsByAdmin\s*=\s*new\s+Map/);
    expect(DIGEST_WORKER).toMatch(/includedSummaries:\s*TeamSummary\[\]/);
    // The send call is invoked once per admin with the full
    // team-summary list as one of its arguments.
    expect(DIGEST_WORKER).toMatch(
      /sendAdminDigest\(\{[\s\S]{0,200}teams:\s*includedSummaries/,
    );
    // The email body iterates the teams list, not the other way
    // around.
    expect(DIGEST_WORKER).toMatch(/for\s*\(const\s+t\s+of\s+input\.teams\)/);
  });

  // ---------------------------------------------------------------------------
  // 7. Digest log is per admin per day.
  // ---------------------------------------------------------------------------
  it("test 7: MfaRecoveryAdminDigestLog is keyed by (userId, sentDate) UNIQUE", () => {
    expect(SCHEMA).toMatch(/model MfaRecoveryAdminDigestLog \{/);
    expect(SCHEMA).toMatch(/userId\s+String/);
    expect(SCHEMA).toMatch(/sentDate\s+String/);
    expect(SCHEMA).toMatch(/@@unique\(\[userId,\s*sentDate\]\)/);
    // Worker uses the compound key on findUnique.
    expect(DIGEST_WORKER).toMatch(
      /mfaRecoveryAdminDigestLog\.findUnique\(\{\s*where:\s*\{\s*userId_sentDate:/,
    );
    // Worker reads + writes the row.
    expect(DIGEST_WORKER).toMatch(/mfaRecoveryAdminDigestLog\.create/);
  });

  // ---------------------------------------------------------------------------
  // 8. Suppressed admins receive no digest.
  // ---------------------------------------------------------------------------
  it("test 8: worker filters teams via isDigestAllowed before sending", () => {
    expect(DIGEST_WORKER).toMatch(
      /if\s*\(!isDigestAllowed\(prefs,\s*teamId,\s*now\)\)\s*continue/,
    );
    // When the entire summary list becomes empty after filtering,
    // we skip without writing a log row (preserving the right to
    // try again later if the suppression lifts).
    expect(DIGEST_WORKER).toMatch(
      /if\s*\(includedSummaries\.length\s*===\s*0\)\s*\{[\s\S]{0,300}continue/,
    );
  });
});

// =============================================================================
// PART 3 — Digest failure handling
// =============================================================================

describe("R8.1.7 — digest failure handling", () => {
  // ---------------------------------------------------------------------------
  // 9. Failed email send does NOT mark digest as delivered.
  // ---------------------------------------------------------------------------
  it("test 9: per-admin digest log is written AFTER the transport returns OK", () => {
    // The catch block on the sendAdminDigest call sets `sent =
    // "failed"`, emits the failure event, then `continue` —
    // BEFORE the `mfaRecoveryAdminDigestLog.create` call. So a
    // failed admin is left without a log row; the next tick will
    // retry.
    const block = DIGEST_WORKER.match(
      /sent:\s*"ok"\s*\|\s*"skipped_no_transport"\s*\|\s*"failed";[\s\S]*?adminsSent \+= 1;/,
    );
    expect(block).toBeTruthy();
    // The failure branch increments adminsFailed and continues.
    expect(block![0]).toMatch(/sent\s*=\s*"failed"/);
    expect(block![0]).toMatch(/adminsFailed\s*\+=\s*1/);
    expect(block![0]).toMatch(/continue/);
    // The log-row create comes AFTER the failure branch (block
    // ends with `if (sent === "ok") adminsSent += 1;` and the
    // create is between the failure continue and that line).
    expect(block![0]).toMatch(
      /mfaRecoveryAdminDigestLog\.create[\s\S]*?if\s*\(sent\s*===\s*"ok"\)/,
    );
  });

  // ---------------------------------------------------------------------------
  // 10. Successful send is idempotent.
  // ---------------------------------------------------------------------------
  it("test 10: per-admin idempotency uses UNIQUE (userId, sentDate); replays skip", () => {
    // Pre-check by findUnique on the compound key.
    expect(DIGEST_WORKER).toMatch(
      /mfaRecoveryAdminDigestLog\.findUnique\([^)]*userId_sentDate/,
    );
    expect(DIGEST_WORKER).toMatch(
      /if\s*\(existing\)\s*continue/,
    );
    // UNIQUE catch is the safety net.
    expect(DIGEST_WORKER).toMatch(/msg\.includes\(["']Unique["']\)/);
  });

  // ---------------------------------------------------------------------------
  // 11. Digest email contains no secrets/tokens.
  // ---------------------------------------------------------------------------
  it("test 11: worker email body carries only counts + team names + admin SPA URL", () => {
    // No raw tokens / OTPs / recovery codes anywhere in the body
    // assembly.
    const sendFn = DIGEST_WORKER.match(
      /async function sendAdminDigest[\s\S]*?\n\}/,
    );
    expect(sendFn).toBeTruthy();
    expect(sendFn![0]).not.toMatch(/\bemailToken/);
    expect(sendFn![0]).not.toMatch(/\brawToken/);
    expect(sendFn![0]).not.toMatch(/\botpauth/);
    expect(sendFn![0]).not.toMatch(/\bsecret(Ciphertext|Iv|AuthTag)/);
    expect(sendFn![0]).not.toMatch(/recovery code/i);
    // The body iterates only `input.teams` (team summaries — no
    // per-user enumeration).
    expect(sendFn![0]).toMatch(/for\s*\(const\s+t\s+of\s+input\.teams\)/);
  });
});

// =============================================================================
// PART 4 — Verify page session detection
// =============================================================================

describe("R8.1.7 — verify page session detection", () => {
  // ---------------------------------------------------------------------------
  // 12. Verify page detects existing session ONLY after verification.
  // ---------------------------------------------------------------------------
  it("test 12: page calls /v1/auth/me AFTER the successful verify, not before", () => {
    // The /v1/auth/me probe is INSIDE the success branch (after
    // the verify endpoint returns 200), not before. Indexes:
    const verifyIdx = VERIFY_PAGE.indexOf("/verify-email");
    const meIdx = VERIFY_PAGE.indexOf("/v1/auth/me");
    expect(verifyIdx).toBeGreaterThan(0);
    expect(meIdx).toBeGreaterThan(verifyIdx);
    // The state extension carries the boolean — `kind: "verified"`
    // and `sessionPresent: boolean` both appear in the union type.
    expect(VERIFY_PAGE).toMatch(/kind:\s*["']verified["']/);
    expect(VERIFY_PAGE).toMatch(/sessionPresent:\s*boolean/);
    // And the success setState call carries it.
    expect(VERIFY_PAGE).toMatch(
      /setState\(\{\s*kind:\s*["']verified["'],\s*sessionPresent\s*\}\)/,
    );
    // The two CTA branches are explicitly tagged.
    expect(VERIFY_PAGE).toMatch(
      /data-cc-mfa-recovery-verify-cta="continue-home"/,
    );
    expect(VERIFY_PAGE).toMatch(
      /data-cc-mfa-recovery-verify-cta="return-to-sign-in"/,
    );
  });

  // ---------------------------------------------------------------------------
  // 13. Verify page still does NOT create session.
  // ---------------------------------------------------------------------------
  it("test 13: verify page still does NOT mint a session anywhere", () => {
    // R8.1.8 tightening — the page's optimization comment
    // mentions `proovra_session` to explain the HttpOnly-cookie
    // limitation. Narrow the assertion to actual code shapes that
    // would mint or write the session.
    expect(VERIFY_PAGE).not.toMatch(/\bsignJwt\s*\(/);
    expect(VERIFY_PAGE).not.toMatch(/\bsetToken\s*\(/);
    expect(VERIFY_PAGE).not.toMatch(/setCookie\s*\(\s*["']proovra_session/);
    expect(VERIFY_PAGE).not.toMatch(/document\.cookie\s*=/);
    // Verified state explicitly states "did NOT log you in".
    expect(VERIFY_PAGE).toMatch(/did NOT log you in/);
  });
});

// =============================================================================
// PART 5 — Recovery verify analytics
// =============================================================================

describe("R8.1.7 — recovery verify analytics", () => {
  // ---------------------------------------------------------------------------
  // 14. Verify analytics emits success/failure WITHOUT token leakage.
  // ---------------------------------------------------------------------------
  it("test 14: route emits analytics on every verify outcome via writeAnalyticsEvent", () => {
    expect(ADMIN_ROUTES).toMatch(/writeAnalyticsEvent\(/);
    expect(ADMIN_ROUTES).toMatch(
      /eventType:\s*["']mfa_recovery_verify_succeeded["']/,
    );
    expect(ADMIN_ROUTES).toMatch(
      /eventType:\s*["']mfa_recovery_verify_failed["']/,
    );
    expect(ADMIN_ROUTES).toMatch(
      /eventType:\s*["']mfa_recovery_verify_page_viewed["']/,
    );
    // Payload metadata must not carry the raw verify token. Find
    // each analytics call's metadata object and assert.
    const calls = [
      ...ADMIN_ROUTES.matchAll(
        /writeAnalyticsEvent\(\{[\s\S]*?\}\)\.catch/g,
      ),
    ].map((m) => m[0]);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const c of calls) {
      expect(c).not.toMatch(/\btoken:/);
      expect(c).not.toMatch(/\brawToken/);
      expect(c).not.toMatch(/\botpauth/);
      expect(c).not.toMatch(/recoveryCode/);
      expect(c).not.toMatch(/secret(Ciphertext|Iv|AuthTag)/);
    }
  });

  // ---------------------------------------------------------------------------
  // 15. No duplicate analytics/security system introduced.
  // ---------------------------------------------------------------------------
  it("test 15: analytics events go through the canonical writeAnalyticsEvent — no bespoke ingest service", () => {
    // Only one source-of-truth for analytics writes.
    expect(ADMIN_ROUTES).toMatch(
      /from\s+["'][^"']*analytics-event\.service/,
    );
    // No parallel analytics shim.
    expect(ADMIN_ROUTES).not.toMatch(/sendAnalytics\(/);
    expect(ADMIN_ROUTES).not.toMatch(/postAnalytics\(/);
    expect(ADMIN_ROUTES).not.toMatch(/from\s+["'][^"']*\/analytics-shim/);
    // Worker does NOT introduce its own analytics ingest path.
    expect(DIGEST_WORKER).not.toMatch(/writeAnalyticsEvent/);
  });
});

// =============================================================================
// PART 6 — Scope guards (no parallel auth, workflow, tenant, capture)
// =============================================================================

describe("R8.1.7 — scope guards", () => {
  // ---------------------------------------------------------------------------
  // 16. No duplicate auth system introduced.
  // ---------------------------------------------------------------------------
  it("test 16: auth.routes.ts + sso-auth.routes.ts + saml-auth.routes.ts under src/routes matching *auth* (R8.2 additive)", () => {
    const routesDir = readdirSync(apiPath("src/routes"));
    const authFiles = routesDir.filter((f) => /auth/i.test(f));
    expect(authFiles.sort()).toEqual([
      "auth.routes.ts",
      "saml-auth.routes.ts",
      "sso-auth.routes.ts",
    ]);
    // The R8.1.7 verify endpoint is INTENTIONALLY unauthenticated
    // (the email token is the auth proof) — but it does not mint
    // a session token.
    expect(ADMIN_ROUTES).not.toMatch(/signJwt\(/);
    expect(ADMIN_ROUTES).not.toMatch(/setCookie\(/);
    expect(ADMIN_ROUTES).not.toMatch(/proovra_session\s*=/);
  });

  // ---------------------------------------------------------------------------
  // 17. No workflow/persona auth logic introduced.
  // ---------------------------------------------------------------------------
  it("test 17: digest preference + worker + verify page do not import workflow or persona", () => {
    const surfaces = [DIGEST_PREF_SVC, DIGEST_WORKER, VERIFY_PAGE, ADMIN_SPA];
    for (const src of surfaces) {
      expect(src).not.toMatch(/from\s+["'][^"']*workflow/);
      expect(src).not.toMatch(/from\s+["'][^"']*persona/);
    }
  });

  // ---------------------------------------------------------------------------
  // 18. No tenant isolation regression.
  // ---------------------------------------------------------------------------
  it("test 18: preference rows scope to (user, team); worker filters per-admin per-team; admin log is per user", () => {
    // Preference is scoped by userId; team-specific row binds teamId.
    expect(SCHEMA).toMatch(
      /model MfaAdminDigestPreference[\s\S]*?userId\s+String[\s\S]*?teamId\s+String\?/,
    );
    // Worker scopes recipients by team membership.
    expect(DIGEST_WORKER).toMatch(
      /teamMember\.findMany\(\{\s*where:\s*\{\s*teamId:\s*\{\s*in:\s*teamIds/,
    );
    // Admin digest log is per-user.
    expect(SCHEMA).toMatch(
      /model MfaRecoveryAdminDigestLog \{[\s\S]*?userId\s+String/,
    );
  });

  // ---------------------------------------------------------------------------
  // 19. No capture/upload/custody/report/package regression.
  // ---------------------------------------------------------------------------
  it("test 19: R8.1.7 surfaces do not import capture / upload / custody / report-package / TSA / OTS modules", () => {
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
      DIGEST_PREF_SVC,
      ADMIN_ROUTES,
      RECOVERY_SVC,
      DIGEST_WORKER,
      VERIFY_PAGE,
      ADMIN_SPA,
    ];
    for (const src of surfaces) {
      for (const needle of forbidden) {
        expect(
          src.includes(`from "${needle}`) || src.includes(`from '${needle}`),
          `must not import ${needle}`,
        ).toBe(false);
      }
    }
  });
});

// =============================================================================
// Bonus — bounded vocabulary additions
// =============================================================================

describe("R8.1.7 bonus — bounded SECURITY_EVENT_TYPES vocabulary", () => {
  const R8_1_7_EVENTS = [
    "mfa_recovery_digest_failed",
    "mfa_recovery_digest_preference_updated",
  ];

  it("every R8.1.7 event type appears EXACTLY once in SECURITY_EVENT_TYPES", () => {
    for (const evt of R8_1_7_EVENTS) {
      const matches = SHARED_SEC.match(new RegExp(`"${evt}"`, "g"));
      expect(
        matches?.length ?? 0,
        `${evt} must appear exactly once`,
      ).toBe(1);
    }
  });

  it("R8.1.7 additions are commented with the R8.1.7 phase marker", () => {
    expect(SHARED_SEC).toMatch(/Phase R8\.1\.7/);
  });
});

// =============================================================================
// File-size sentinel
// =============================================================================

describe("R8.1.7 test file size sentinel", () => {
  it("this test file is non-trivial (>=14 KB)", () => {
    const st = statSync(__filename);
    expect(st.size).toBeGreaterThan(14_000);
  });
});
