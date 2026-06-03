/**
 * PHASE R8.1.3 — Organisation MFA policy enforcement +
 * durable MFA pending challenge store. Source-contract tests.
 *
 * 17 numbered tests from the phase spec, plus a small sentinel
 * group at the tail that guards the file from accidental
 * truncation. These are SOURCE-CONTRACT tests — they read the
 * canonical files and assert structural properties; they do NOT
 * touch a live database (which the API integration suite already
 * covers separately).
 *
 * The tests deliberately verify:
 *   - The durable MfaPendingChallenge model exists in the schema +
 *     a migration ships for it.
 *   - The verify endpoint uses `consumeMfaPendingChallenge`, NOT
 *     `verifyAndConsumeMfaPendingToken` (the legacy in-memory path).
 *   - The atomic consume signature (`updateMany` keyed by
 *     `consumedAt: null` + `expiresAt > now`) is present.
 *   - The login gate consults the enforcement resolver (org policy)
 *     and routes ENROLLMENT_REQUIRED → guided enrollment instead of
 *     a session.
 *   - The bounded SECURITY_EVENT_TYPES vocabulary gained exactly the
 *     R8.1.3 additions, no more, no less, and no event payload
 *     leaks an OTP / recovery code / secret / raw token.
 *   - No duplicate auth system was introduced (no parallel
 *     /v1/auth-mfa or /v1/login-mfa surface; the existing
 *     auth.routes.ts is authoritative).
 *   - No workflow/persona authorization was introduced.
 *   - No capture/upload/custody/report/package code was touched.
 */

import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "..", "..", "..");
const apiPath = (rel: string) => resolve(REPO, "services/api", rel);
const webPath = (rel: string) => resolve(REPO, "apps/web", rel);
const sharedPath = (rel: string) => resolve(REPO, "packages/shared", rel);

const AUTH_SRC = readFileSync(
  apiPath("src/routes/auth.routes.ts"),
  "utf8",
);
const SSO_SRC = readFileSync(
  apiPath("src/routes/sso-auth.routes.ts"),
  "utf8",
);
const MFA_SVC = readFileSync(
  apiPath("src/services/security/mfa.service.ts"),
  "utf8",
);
const ENFORCEMENT_SVC = readFileSync(
  apiPath("src/services/security/login-mfa-enforcement.service.ts"),
  "utf8",
);
const SCHEMA = readFileSync(apiPath("prisma/schema.prisma"), "utf8");
const SHARED_SEC = readFileSync(sharedPath("src/security.ts"), "utf8");
const MFA_PAGE = readFileSync(
  webPath("app/auth/mfa-challenge/page.tsx"),
  "utf8",
);
const SECURITY_CENTER = readFileSync(
  webPath("app/(app)/security-center/page.tsx"),
  "utf8",
);

// Endpoint substring extractor — same helper R8.1.2 uses.
function endpointBody(path: string): string {
  const anchor = AUTH_SRC.indexOf(`app.post("${path}"`);
  if (anchor < 0) return "";
  const tail = AUTH_SRC.slice(anchor + 1);
  const nextRoute = tail.search(
    /\bapp\.(post|get|delete|put|patch)\(\s*["'][^"']+["']/,
  );
  const end = nextRoute >= 0 ? anchor + 1 + nextRoute : AUTH_SRC.length;
  return AUTH_SRC.slice(anchor, end);
}

// =============================================================================
// Spec-numbered tests
// =============================================================================

describe("R8.1.3 — durable MFA pending challenge model + enforcement", () => {
  // ---------------------------------------------------------------------------
  // 1. Durable challenge model exists.
  // ---------------------------------------------------------------------------
  it("test 1: MfaPendingChallenge model exists in schema with the required fields", () => {
    expect(SCHEMA).toMatch(/model MfaPendingChallenge \{/);
    expect(SCHEMA).toMatch(/jti\s+String/);
    expect(SCHEMA).toMatch(/userId\s+String/);
    expect(SCHEMA).toMatch(/purpose\s+MfaChallengePurpose/);
    expect(SCHEMA).toMatch(/expiresAt\s+DateTime/);
    expect(SCHEMA).toMatch(/consumedAt\s+DateTime\?/);
    expect(SCHEMA).toMatch(/failureCount\s+Int/);
    expect(SCHEMA).toMatch(/ipHash\s+String\?/);
    expect(SCHEMA).toMatch(/userAgentHash\s+String\?/);
    // UNIQUE on jti so two challenges can never collide on lookup.
    expect(SCHEMA).toMatch(/@@unique\(\[jti\]\)/);
    // Migration ships.
    const migrations = readdirSync(apiPath("prisma/migrations"));
    expect(
      migrations.some((m) => m.endsWith("_r8_1_3_mfa_pending_challenges")),
    ).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 2. Challenge created when MFA_REQUIRED issued.
  // ---------------------------------------------------------------------------
  it("test 2: gateLoginWithMfa creates a durable challenge before issuing the pending token", () => {
    // The MFA_REQUIRED branch of the gate calls createMfaPendingChallenge
    // and signs the token with the resulting jti.
    expect(AUTH_SRC).toMatch(/createMfaPendingChallenge\(/);
    expect(AUTH_SRC).toMatch(/challenge\.jti/);
    expect(AUTH_SRC).toMatch(/signMfaPendingToken\(/);
    // The orchestrator helper sets purpose: "LOGIN" on the create.
    expect(AUTH_SRC).toMatch(/purpose:\s*["']LOGIN["']/);
  });

  // ---------------------------------------------------------------------------
  // 3. Challenge expires correctly.
  // ---------------------------------------------------------------------------
  it("test 3: createMfaPendingChallenge sets expiresAt = now + TTL (5 min default)", () => {
    expect(MFA_SVC).toMatch(/MFA_PENDING_CHALLENGE_TTL_SECONDS\s*=\s*5\s*\*\s*60/);
    // Source uses object shorthand (`expiresAt,`) — accept either
    // longhand or shorthand form.
    expect(MFA_SVC).toMatch(/expiresAt(?:,|:\s*expiresAt)/);
    // The atomic consume refuses rows where now >= expiresAt.
    expect(MFA_SVC).toMatch(/row\.expiresAt\.getTime\(\)\s*<=\s*Date\.now\(\)/);
    // The atomic UPDATE also re-checks expiresAt to avoid TOCTOU.
    expect(MFA_SVC).toMatch(/expiresAt:\s*\{\s*gt:\s*new Date\(\)\s*\}/);
  });

  // ---------------------------------------------------------------------------
  // 4. Challenge consumed atomically.
  // ---------------------------------------------------------------------------
  it("test 4: consume uses a single UPDATE keyed by consumedAt: null AND expiresAt > now", () => {
    // The atomic consume MUST flip the row in ONE statement; a
    // findFirst-then-update is racy. We assert the updateMany call
    // includes both gates in its WHERE clause.
    const block = MFA_SVC.match(
      /prisma\.mfaPendingChallenge\.updateMany\(\{[\s\S]*?\}\s*\)/,
    );
    expect(block).toBeTruthy();
    expect(block![0]).toMatch(/consumedAt:\s*null/);
    expect(block![0]).toMatch(/expiresAt:\s*\{\s*gt:/);
    expect(block![0]).toMatch(/data:\s*\{\s*consumedAt:\s*new Date/);
  });

  // ---------------------------------------------------------------------------
  // 5. Replayed challenge fails across durable store.
  // ---------------------------------------------------------------------------
  it("test 5: replay returns ok:false with reason `already_consumed` and emits mfa_challenge_replayed", () => {
    // Two consume paths reach this reason: (a) row.consumedAt was
    // already set when we read it; (b) updateMany rowcount was 0
    // because another writer won the race.
    expect(MFA_SVC).toMatch(/reason:\s*["']already_consumed["']/);
    expect(MFA_SVC).toMatch(/eventType:\s*["']mfa_challenge_replayed["']/);
  });

  // ---------------------------------------------------------------------------
  // 6. In-memory JTI deny-list is not the production replay source.
  // ---------------------------------------------------------------------------
  it("test 6: verify endpoint uses verifyMfaPendingTokenSignature + consumeMfaPendingChallenge (NOT in-memory deny list)", () => {
    const verify = endpointBody("/v1/auth/mfa/verify");
    expect(verify).toMatch(/verifyMfaPendingTokenSignature/);
    expect(verify).toMatch(/consumeMfaPendingChallenge/);
    // The legacy helper (which still flips the in-memory deny list)
    // must not be the production replay check. Verify endpoint may
    // not call it.
    expect(verify).not.toMatch(/verifyAndConsumeMfaPendingToken/);
  });

  // ---------------------------------------------------------------------------
  // 7. Login MFA still works with durable challenge.
  // ---------------------------------------------------------------------------
  it("test 7: success path issues the canonical session ONLY after durable consume succeeds", () => {
    const verify = endpointBody("/v1/auth/mfa/verify");
    // The canonical session token + cookie issuance comes AFTER the
    // consumeMfaPendingChallenge call in the function body.
    const consumeIdx = verify.indexOf("consumeMfaPendingChallenge");
    const signIdx = verify.indexOf("signJwt(");
    const cookieIdx = verify.indexOf("maybeSetWebCookie");
    expect(consumeIdx).toBeGreaterThan(0);
    expect(signIdx).toBeGreaterThan(consumeIdx);
    expect(cookieIdx).toBeGreaterThan(consumeIdx);
  });

  // ---------------------------------------------------------------------------
  // 8. Org policy OFF does not force MFA.
  // ---------------------------------------------------------------------------
  it("test 8: enforcement resolver returns NOT_REQUIRED when no team policy demands MFA and user has no factor", () => {
    // We can't run Prisma here; assert the resolver's branch is wired.
    expect(ENFORCEMENT_SVC).toMatch(/outcome:\s*["']NOT_REQUIRED["']/);
    expect(ENFORCEMENT_SVC).toMatch(/mfaRequiredForRole/);
    // The resolver consults the canonical mfaRequiredForRole helper,
    // which returns false for OFF.
  });

  // ---------------------------------------------------------------------------
  // 9. Org policy REQUIRED_FOR_ALL requires MFA.
  // ---------------------------------------------------------------------------
  it("test 9: resolver picks the strictest policy across all of the user's teams (uses LEVEL_STRICTNESS rank)", () => {
    expect(ENFORCEMENT_SVC).toMatch(/LEVEL_STRICTNESS/);
    expect(ENFORCEMENT_SVC).toMatch(/ALL_MEMBERS/);
    expect(ENFORCEMENT_SVC).toMatch(/REVIEWERS_AND_ABOVE/);
    expect(ENFORCEMENT_SVC).toMatch(/ADMINS_ONLY/);
    expect(ENFORCEMENT_SVC).toMatch(/strictestLevel/);
  });

  // ---------------------------------------------------------------------------
  // 10. User without enrolled MFA gets guided enrollment, not silent lockout.
  // ---------------------------------------------------------------------------
  it("test 10: ENROLLMENT_REQUIRED branch surfaces a 403 with guided message AND emits mfa_enrollment_required", () => {
    expect(ENFORCEMENT_SVC).toMatch(/outcome:\s*["']ENROLLMENT_REQUIRED["']/);
    // The auth.routes gate must NOT call signJwt for sessions when
    // the decision is ENROLLMENT_REQUIRED. The branch must respond
    // with a guided message + emit the event.
    expect(AUTH_SRC).toMatch(/decision\.outcome\s*===\s*["']ENROLLMENT_REQUIRED["']/);
    expect(AUTH_SRC).toMatch(/mfaEnrollmentRequired:\s*true/);
    expect(AUTH_SRC).toMatch(/eventType:\s*["']mfa_enrollment_required["']/);
    // Frontend page renders a dedicated surface with the data-cc
    // attribute; no silent lockout.
    expect(MFA_PAGE).toMatch(/data-cc-mfa-state=["']enrollment-required["']/);
    expect(MFA_PAGE).toMatch(/data-cc-mfa-enrollment-cta/);
  });

  // ---------------------------------------------------------------------------
  // 11. Policy update emits org_mfa_policy_updated event.
  // ---------------------------------------------------------------------------
  it("test 11: mfa-policy.service.ts emits an MFA policy event on update", () => {
    const policySvc = readFileSync(
      apiPath("src/services/identity-security/mfa-policy.service.ts"),
      "utf8",
    );
    // The existing service emits `mfa_policy_updated` (Phase 19
    // canonical). R8.1.3 ALSO permits the new `org_mfa_policy_updated`
    // alias in the bounded vocabulary — accept either.
    expect(policySvc).toMatch(/eventType:\s*["'](?:org_)?mfa_policy_updated["']/);
  });

  // ---------------------------------------------------------------------------
  // 12. Challenge lifecycle emits events.
  // ---------------------------------------------------------------------------
  it("test 12: every challenge lifecycle transition emits the canonical event", () => {
    expect(MFA_SVC).toMatch(/eventType:\s*["']mfa_challenge_created["']/);
    expect(MFA_SVC).toMatch(/eventType:\s*["']mfa_challenge_expired["']/);
    expect(MFA_SVC).toMatch(/eventType:\s*["']mfa_challenge_replayed["']/);
    expect(MFA_SVC).toMatch(/eventType:\s*["']mfa_challenge_consumed["']/);
  });

  // ---------------------------------------------------------------------------
  // 13. No raw OTP/recovery/secret/token logging — privacy contract.
  // ---------------------------------------------------------------------------
  it("test 13: no event payload includes the raw code, recoveryCode, signed token, secret, IV, or auth tag", () => {
    // Audit + security emit sites in the verify endpoint and the
    // orchestrator MUST NOT carry raw secrets. The challenge id
    // hash (truncated SHA-256) is the only identifier surfaced.
    const verify = endpointBody("/v1/auth/mfa/verify");
    for (const src of [verify, MFA_SVC, AUTH_SRC, SSO_SRC]) {
      expect(src).not.toMatch(
        /details:\s*\{[^}]*\bcode:\s*body\.code/,
      );
      expect(src).not.toMatch(
        /details:\s*\{[^}]*\brecoveryCode:/,
      );
      expect(src).not.toMatch(
        /details:\s*\{[^}]*\bsecret(Ciphertext|Iv|AuthTag)?:/,
      );
      expect(src).not.toMatch(
        /details:\s*\{[^}]*\bmfaPendingToken:/,
      );
    }
    // The challenge model stores hashed IP / UA, never raw.
    expect(SCHEMA).toMatch(/ipHash\s+String\?/);
    expect(SCHEMA).toMatch(/userAgentHash\s+String\?/);
    expect(SCHEMA).not.toMatch(/^\s*ipAddress\s+String\s+@map.*mfa_pending/);
  });

  // ---------------------------------------------------------------------------
  // 14. No duplicate auth system introduced.
  // ---------------------------------------------------------------------------
  it("test 14: no parallel auth route file added (auth.routes.ts + sso-auth.routes.ts + saml-auth.routes.ts; mfa.routes.ts is identity sub-domain)", () => {
    const routesDir = readdirSync(apiPath("src/routes"));
    // Filter to .ts sources only — compiled .js artifacts in src/ would
    // otherwise duplicate every match. The pin is on source files.
    const auth = routesDir.filter((f) => /auth/i.test(f) && f.endsWith(".ts"));
    // Allowed: auth.routes.ts, sso-auth.routes.ts, saml-auth.routes.ts (R8.2 additive).
    // mfa.routes.ts is identity sub-domain (R8.1.1), not parallel auth.
    expect(auth.sort()).toEqual(["auth.routes.ts", "saml-auth.routes.ts", "sso-auth.routes.ts"]);
    // The login MFA verify endpoint lives in the canonical
    // auth.routes.ts, not a separate "auth-mfa.routes.ts".
    expect(AUTH_SRC).toMatch(/app\.post\(\s*["']\/v1\/auth\/mfa\/verify["']/);
  });

  // ---------------------------------------------------------------------------
  // 15. No workflow/persona auth logic introduced.
  // ---------------------------------------------------------------------------
  it("test 15: enforcement resolver does NOT import workflow or persona modules", () => {
    expect(ENFORCEMENT_SVC).not.toMatch(/from\s+["'][^"']*workflow/);
    expect(ENFORCEMENT_SVC).not.toMatch(/from\s+["'][^"']*persona/);
    // It DOES import the canonical role-based MFA helper.
    expect(ENFORCEMENT_SVC).toMatch(/mfaRequiredForRole/);
  });

  // ---------------------------------------------------------------------------
  // 16. No tenant isolation regression.
  // ---------------------------------------------------------------------------
  it("test 16: resolver scopes membership lookups to userId only (no cross-tenant query)", () => {
    // The findMany on teamMember must be keyed by userId (the
    // caller's id), never by an arbitrary teamId.
    expect(ENFORCEMENT_SVC).toMatch(
      /prisma\.teamMember\.findMany\(\{\s*where:\s*\{\s*userId:\s*input\.userId/,
    );
    // The org policy lookup is keyed by the explicit set of teamIds
    // the user belongs to. NEVER by `team: { somethingElse: ... }`.
    expect(ENFORCEMENT_SVC).toMatch(
      /prisma\.organizationSecurityPolicy\.findMany\(\{\s*where:\s*\{\s*teamId:\s*\{\s*in:\s*teamIds/,
    );
  });

  // ---------------------------------------------------------------------------
  // 17. No capture/upload/custody/report/package regression.
  // ---------------------------------------------------------------------------
  it("test 17: R8.1.3 does not import capture / upload / custody / report / package modules anywhere", () => {
    const forbiddenSubstrings = [
      "/capture",
      "/upload",
      "/custody",
      "/report-package",
      "/finalization",
      "/ots-",
      "/tsa-",
    ];
    const surfaces = [
      MFA_SVC,
      ENFORCEMENT_SVC,
      AUTH_SRC,
      SSO_SRC,
      MFA_PAGE,
      SECURITY_CENTER,
    ];
    for (const src of surfaces) {
      for (const needle of forbiddenSubstrings) {
        expect(
          src.includes(`from "${needle}`) || src.includes(`from '${needle}`),
          `R8.1.3 surface must not import ${needle}`,
        ).toBe(false);
      }
    }
  });
});

// =============================================================================
// Part 6 bonus — bounded vocabulary additions (no surprise events)
// =============================================================================

describe("R8.1.3 bonus — bounded SECURITY_EVENT_TYPES vocabulary", () => {
  const R8_1_3_EVENTS = [
    "org_mfa_policy_updated",
    "org_mfa_policy_enforced",
    "mfa_challenge_created",
    "mfa_challenge_expired",
    "mfa_challenge_replayed",
    "mfa_challenge_consumed",
    "mfa_enrollment_required",
  ];

  it("every R8.1.3 event type appears EXACTLY once in SECURITY_EVENT_TYPES", () => {
    for (const evt of R8_1_3_EVENTS) {
      const matches = SHARED_SEC.match(new RegExp(`"${evt}"`, "g"));
      expect(
        matches?.length ?? 0,
        `${evt} must appear exactly once`,
      ).toBe(1);
    }
  });

  it("R8.1.3 additions are commented with the R8.1.3 phase marker", () => {
    expect(SHARED_SEC).toMatch(/Phase R8\.1\.3/);
  });
});

// =============================================================================
// File-size sentinel
// =============================================================================

describe("R8.1.3 test file size sentinel", () => {
  it("this test file is non-trivial (>=14 KB) — protects against accidental truncation", () => {
    const st = statSync(__filename);
    expect(st.size).toBeGreaterThan(14_000);
  });
});

// =============================================================================
// Cleanup strategy lock
// =============================================================================

describe("R8.1.3 — cleanup / TTL strategy is implemented", () => {
  it("opportunistic GC fires on create AND on expire/replay paths", () => {
    expect(MFA_SVC).toMatch(/gcStalePendingChallenges/);
    expect(MFA_SVC).toMatch(/MFA_PENDING_CHALLENGE_RETENTION_SECONDS/);
    expect(MFA_SVC).toMatch(/MFA_PENDING_CHALLENGE_GC_BATCH/);
  });
  it("admin-callable sweep is exported for ops surfaces", () => {
    expect(MFA_SVC).toMatch(/export async function sweepExpiredPendingChallenges/);
  });
});
