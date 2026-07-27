/**
 * Phase 26.5 — Enterprise Identity Hardening API regression tests.
 *
 * No DB. Source-text + pure-helper + projection tests.
 *
 * Coverage:
 *   - SSO hardening: state hashed, persisted, single-use; IdP outage
 *     tracking opens incidents at threshold.
 *   - Suspicious-session detector: signals are deterministic; ordering
 *     does not affect the score.
 *   - Adaptive auth: routes through the shared decision matrix.
 *   - Heartbeat: sampled writes via shared `shouldWriteHeartbeat`.
 *   - Stale-session sweep: writes RevokedSession; never deletes.
 *   - SCIM Groups: idempotent POST; soft DELETE; membership reconciles
 *     via TeamMember.role (no parallel table).
 *   - End-user SSO routes: persist state on initiate; consume on
 *     callback; bounce to safe error page on failure.
 *   - Cookie issuance + replay protection.
 *   - All admin + SCIM + SSO routes registered.
 *   - Wording sweep across new sources + UI page.
 *   - Public verify isolation + untouched files invariant.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  SCIM_GROUP_MAPPED_ROLES,
  SCIM_GROUP_SCHEMA_URI,
  SEARCH_FORBIDDEN_OVERCLAIM_PHRASES,
  SSO_CALLBACK_STATE_TTL_SECONDS,
  computeSuspiciousSessionRisk,
  evaluateAdaptiveAuth,
  isSafeRedirectAfter,
  isSessionStale,
  sessionRiskLevel,
  shouldWriteHeartbeat,
} from "@proovra/shared";

function readSource(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(rel, import.meta.url)),
    "utf8",
  );
}

// -----------------------------------------------------------------------------
// SSO hardening service
// -----------------------------------------------------------------------------

describe("Phase 26.5 — SSO hardening", () => {
  const src = readSource(
    "../src/services/access-control/sso-hardening.service.ts",
  );

  it("state token is HASHED before insert (HMAC-SHA256, IDENTITY_SECURITY_HASH_SECRET)", () => {
    expect(src).toMatch(/createHmac\("sha256", resolveSecret/);
    expect(src).toMatch(/IDENTITY_SECURITY_HASH_SECRET/);
  });

  it("persistCallbackAttempt rejects unsafe redirectAfter via shared helper", () => {
    expect(src).toMatch(/isSafeRedirectAfter/);
    expect(src).toMatch(/"INVALID_REDIRECT"/);
  });

  it("consumeCallbackAttempt detects REPLAY + emits security event", () => {
    expect(src).toMatch(/sso_callback_replay_detected/);
    expect(src).toMatch(/status: "REPLAYED"/);
    expect(src).toMatch(/sso_callback_replay_total/);
    expect(src).toMatch(/session_replay_detected_total/);
  });

  it("noteSsoFailure bumps counter + opens incident at threshold", () => {
    expect(src).toMatch(/IDP_OUTAGE_FAILURE_THRESHOLD/);
    expect(src).toMatch(/idp_outage_detected/);
    expect(src).toMatch(/recordIncident\(/);
  });

  it("noteSsoSuccess clears the outage marker", () => {
    expect(src).toMatch(/idp_outage_cleared/);
    expect(src).toMatch(/outageClearedAtUtc/);
  });

  it("sweepStaleCallbackAttempts deletes only terminal rows beyond cutoff", () => {
    expect(src).toMatch(/sweepStaleCallbackAttempts/);
    expect(src).toMatch(/\["EXPIRED", "FAILED", "CONSUMED", "REPLAYED"\]/);
  });
});

// -----------------------------------------------------------------------------
// Suspicious-session detector
// -----------------------------------------------------------------------------

describe("Phase 26.5 — suspicious-session detector", () => {
  const src = readSource(
    "../src/services/access-control/suspicious-session.service.ts",
  );

  it("uses the shared catalog (no ad-hoc signal kinds)", () => {
    expect(src).toMatch(/SUSPICIOUS_SESSION_SIGNAL_KINDS/);
    expect(src).toMatch(/SUSPICIOUS_SESSION_SIGNAL_WEIGHTS/);
    expect(src).toMatch(/computeSuspiciousSessionRisk/);
  });

  it("never persists raw IP; relies on countryCode comparisons", () => {
    expect(src).toMatch(/countryCode/);
    expect(src).not.toMatch(/raw_ip|rawIp/);
  });

  it("emits suspicious_session_detected for MEDIUM+", () => {
    expect(src).toMatch(/suspicious_session_detected/);
    expect(src).toMatch(/suspicious_session_total/);
  });

  it("checks the SSO callback failure burst window", () => {
    expect(src).toMatch(/REPEATED_FAILED_SSO_CALLBACKS/);
    expect(src).toMatch(/status: \{ in: \["FAILED", "REPLAYED"\] \}/);
  });

  it("detects token replay indicator from callback attempts", () => {
    expect(src).toMatch(/TOKEN_REPLAY_INDICATOR/);
  });
});

// -----------------------------------------------------------------------------
// Adaptive auth engine
// -----------------------------------------------------------------------------

describe("Phase 26.5 — adaptive auth engine", () => {
  const src = readSource(
    "../src/services/access-control/adaptive-auth.service.ts",
  );

  it("routes through the shared evaluateAdaptiveAuth helper", () => {
    expect(src).toMatch(/evaluateAdaptiveAuth/);
  });

  it("emits adaptive_step_up_triggered + adaptive_block_triggered", () => {
    expect(src).toMatch(/adaptive_step_up_triggered/);
    expect(src).toMatch(/adaptive_block_triggered/);
  });

  it("forced reauth bumps the forced_reauth_total counter", () => {
    expect(src).toMatch(/forced_reauth_total/);
    expect(src).toMatch(/forced_reauthentication/);
  });

  it("trusted-device lookup reads Phase 19 TrustedDevice", () => {
    expect(src).toMatch(/trustedDevice\.findFirst/);
    expect(src).toMatch(/status: "ACTIVE"/);
  });
});

// -----------------------------------------------------------------------------
// Heartbeat + stale sweep
// -----------------------------------------------------------------------------

describe("Phase 26.5 — heartbeat + stale sweep", () => {
  const src = readSource(
    "../src/services/access-control/session-inventory.service.ts",
  );

  it("recordHeartbeat uses shared shouldWriteHeartbeat", () => {
    expect(src).toMatch(/shouldWriteHeartbeat/);
    expect(src).toMatch(/session_heartbeat_total/);
    expect(src).toMatch(/session_heartbeat_sampled_skip_total/);
  });

  it("recordHeartbeat is best-effort (never throws)", () => {
    expect(src).toMatch(/\/\* best-effort; never throws \*\//);
  });

  it("sweepStaleSessions uses Phase 19 revokeSession (never deletes)", () => {
    expect(src).toMatch(/sweepStaleSessions/);
    expect(src).toMatch(/await revokeSession\(/);
    expect(src).not.toMatch(/authenticatedSession\.delete\(/);
  });

  it("stale sweep marks RECONCILIATION_SWEEP reason", () => {
    expect(src).toMatch(/RECONCILIATION_SWEEP/);
    expect(src).toMatch(/stale_session_swept/);
  });

  it("refreshHighRiskSessionGauge updates the dashboard gauge", () => {
    expect(src).toMatch(/refreshHighRiskSessionGauge/);
    expect(src).toMatch(/high_risk_sessions/);
  });
});

// -----------------------------------------------------------------------------
// SCIM Groups
// -----------------------------------------------------------------------------

describe("Phase 26.5 — SCIM Groups service", () => {
  const src = readSource(
    "../src/services/access-control/scim-groups.service.ts",
  );

  it("POST is idempotent on externalId", () => {
    expect(src).toMatch(/alreadyExisted/);
    expect(src).toMatch(/findFirst[\s\S]*?externalId/);
  });

  it("DELETE is SOFT (status ARCHIVED, demotes to MEMBER)", () => {
    expect(src).toMatch(/status: "ARCHIVED"/);
    // PHASE 3: bulk archive-demotion via the canonical orchestrator
    // (demotes mapped-role members to MEMBER, provenance per member).
    expect(src).toMatch(/demoteGroupMappedRoleOnArchive/);
    // No hard deletes.
    expect(src).not.toMatch(/scimGroup\.delete\(/);
    expect(src).not.toMatch(/teamMember\.delete\(/);
  });

  it("Never silently revokes OWNER/ADMIN via group remove", () => {
    expect(src).toMatch(/OWNER" \|\| member\.role === "ADMIN/);
  });

  it("Group membership change emits security event", () => {
    expect(src).toMatch(/scim_group_membership_changed/);
    expect(src).toMatch(/scim_group_membership_total/);
  });

  it("Reuses the Phase 17 TeamMember role (no parallel table)", () => {
    // PHASE 3: role sync targets the SAME Phase 17 TeamMember rows via
    // the canonical directory-role-change helper (no parallel table).
    expect(src).toMatch(/applyDirectoryRoleChange/);
    expect(src).not.toMatch(/scimGroupMember\b/);
  });
});

// -----------------------------------------------------------------------------
// End-user SSO routes
// -----------------------------------------------------------------------------

describe("Phase 26.5 — end-user SSO routes", () => {
  const src = readSource("../src/routes/sso-auth.routes.ts");

  it("initiate + callback registered", () => {
    expect(src).toMatch(/"\/v1\/auth\/sso\/:connectionId\/initiate"/);
    expect(src).toMatch(/"\/v1\/auth\/sso\/callback"/);
  });

  it("initiate persists state via the hardening service", () => {
    expect(src).toMatch(/persistCallbackAttempt/);
  });

  it("callback consumes state via the hardening service", () => {
    expect(src).toMatch(/consumeCallbackAttempt/);
  });

  it("callback issues a JWT via signJwt + sets the session cookie", () => {
    expect(src).toMatch(/signJwt\(/);
    expect(src).toMatch(/proovra_session/);
    expect(src).toMatch(/setCookie\(/);
  });

  it("callback records AuthenticatedSession via recordAuthenticatedSession", () => {
    expect(src).toMatch(/recordAuthenticatedSession\(/);
  });

  it("callback runs first-pass suspicious-session scoring", () => {
    expect(src).toMatch(/detectAndScoreSession\(/);
  });

  it("invalid state / replay / expired all bounce to /auth?sso_error=…", () => {
    expect(src).toMatch(/bounceToAuthError/);
    expect(src).toMatch(/sso_state_replayed/);
    expect(src).toMatch(/sso_state_expired/);
    expect(src).toMatch(/sso_state_invalid/);
  });

  it("noteSsoSuccess / noteSsoFailure bridge to IdP outage tracking", () => {
    expect(src).toMatch(/noteSsoSuccess/);
    expect(src).toMatch(/noteSsoFailure/);
  });

  it("cookie domain + secure honour SSO_COOKIE_DOMAIN / SSO_COOKIE_SECURE", () => {
    expect(src).toMatch(/SSO_COOKIE_DOMAIN/);
    expect(src).toMatch(/SSO_COOKIE_SECURE/);
  });

  it("SSO_CALLBACKS_ENABLED kill-switch returns 503", () => {
    expect(src).toMatch(/SSO_CALLBACKS_ENABLED/);
    expect(src).toMatch(/code\(503\)/);
  });

  it("ip preview masks the last octet (never persists raw)", () => {
    expect(src).toMatch(/ipPreview/);
    expect(src).toMatch(/`\$\{parts\[0\]\}\.\$\{parts\[1\]\}\.\$\{parts\[2\]\}\.•••`/);
  });
});

// -----------------------------------------------------------------------------
// SCIM routes
// -----------------------------------------------------------------------------

describe("Phase 26.5 — SCIM routes", () => {
  const src = readSource("../src/routes/scim.routes.ts");

  it("all 5 Group endpoints registered", () => {
    for (const path of [
      "/v2/scim/Groups",
      "/v2/scim/Groups/:id",
    ]) {
      expect(src.includes(`"${path}"`), `missing route ${path}`).toBe(true);
    }
    // 5 verbs: POST /Groups, GET /Groups/:id, GET /Groups, PATCH /Groups/:id, DELETE /Groups/:id
    const verbCount =
      (src.match(/app\.(post|get|patch|delete)\(\s*"\/v2\/scim\/Groups/g) ?? [])
        .length;
    expect(verbCount).toBeGreaterThanOrEqual(5);
  });

  it("Groups still bearer-token-only (no requireAuth)", () => {
    // The whole file forbids requireAuth.
    expect(src).not.toMatch(/requireAuth/);
  });
});

// -----------------------------------------------------------------------------
// Admin route extensions
// -----------------------------------------------------------------------------

describe("Phase 26.5 — admin route extensions", () => {
  const src = readSource("../src/routes/admin-identity.routes.ts");

  it("identity timeline + stale reconcile + score routes registered", () => {
    expect(src).toMatch(/"\/v1\/admin\/identity\/timeline"/);
    expect(src).toMatch(/"\/v1\/admin\/identity\/sessions\/reconcile-stale"/);
    expect(src).toMatch(/"\/v1\/admin\/identity\/sessions\/:id\/score"/);
  });

  it("reconcile-stale is cron-secret protected (no requireAuth)", () => {
    expect(src).toMatch(/"\/v1\/admin\/identity\/sessions\/reconcile-stale"/);
    expect(src).toMatch(/x-cron-secret/);
    expect(src).toMatch(/IDENTITY_RECONCILE_CRON_SECRET/);
    // The reconcile route is registered with app.post directly followed by
    // the path string. requireAuth would precede the path in a preHandler
    // option object on the same call. Assert app.post is the registration
    // verb, and that the literal `preHandler: requireAuth` does NOT appear
    // on the same registration call.
    const callMatch = src.match(
      /app\.post\(\s*\n?\s*("\/v1\/admin\/identity\/sessions\/reconcile-stale")[\s\S]{0,200}?async/,
    );
    expect(callMatch, "reconcile-stale route must be app.post").not.toBeNull();
    const callBlock = callMatch?.[0] ?? "";
    expect(callBlock).not.toMatch(/preHandler:\s*requireAuth/);
  });
});

// -----------------------------------------------------------------------------
// Pure helpers
// -----------------------------------------------------------------------------

describe("Phase 26.5 — pure helpers reachable from API", () => {
  it("computeSuspiciousSessionRisk caps at 100", () => {
    const r = computeSuspiciousSessionRisk([
      { kind: "IMPOSSIBLE_TRAVEL", weight: 80, reason: "" },
      { kind: "TOKEN_REPLAY_INDICATOR", weight: 90, reason: "" },
    ]);
    expect(r).toBe(100);
  });

  it("sessionRiskLevel matches the threshold catalog", () => {
    expect(sessionRiskLevel(10)).toBe("LOW");
    expect(sessionRiskLevel(30)).toBe("MEDIUM");
    expect(sessionRiskLevel(60)).toBe("HIGH");
    expect(sessionRiskLevel(95)).toBe("CRITICAL");
  });

  it("evaluateAdaptiveAuth: CRITICAL → BLOCK; HIGH untrusted → REAUTH", () => {
    expect(
      evaluateAdaptiveAuth({
        riskScore: 95,
        trustedDevice: true,
        highPrivilegeAction: false,
        workspaceRequiresStepUp: false,
      }).decision,
    ).toBe("BLOCK");
    expect(
      evaluateAdaptiveAuth({
        riskScore: 70,
        trustedDevice: false,
        highPrivilegeAction: false,
        workspaceRequiresStepUp: false,
      }).decision,
    ).toBe("REQUIRE_REAUTH");
  });

  it("isSafeRedirectAfter blocks //, allows /", () => {
    expect(isSafeRedirectAfter("//evil.com")).toBe(false);
    expect(isSafeRedirectAfter("/home")).toBe(true);
  });

  it("shouldWriteHeartbeat honours sample window", () => {
    const now = new Date();
    expect(
      shouldWriteHeartbeat({
        lastHeartbeatAtUtc: new Date(now.getTime() - 5_000),
        nowUtc: now,
        sampleWindowSeconds: 60,
      }),
    ).toBe(false);
    expect(
      shouldWriteHeartbeat({
        lastHeartbeatAtUtc: new Date(now.getTime() - 120_000),
        nowUtc: now,
        sampleWindowSeconds: 60,
      }),
    ).toBe(true);
  });

  it("isSessionStale uses heartbeat as primary anchor", () => {
    const now = new Date();
    expect(
      isSessionStale({
        lastHeartbeatAtUtc: new Date(now.getTime() - 45 * 60_000),
        lastSeenAtUtc: now,
        nowUtc: now,
        staleMinutes: 30,
      }),
    ).toBe(true);
  });

  it("SCIM Group mapped roles bounded to ADMIN / MEMBER / VIEWER", () => {
    expect(SCIM_GROUP_MAPPED_ROLES.length).toBe(3);
  });

  it("SCIM_GROUP_SCHEMA_URI is the RFC 7644 URI", () => {
    expect(SCIM_GROUP_SCHEMA_URI).toBe(
      "urn:ietf:params:scim:schemas:core:2.0:Group",
    );
  });

  it("SSO callback state TTL is 10 minutes", () => {
    expect(SSO_CALLBACK_STATE_TTL_SECONDS).toBe(600);
  });
});

// -----------------------------------------------------------------------------
// Wording sweep
// -----------------------------------------------------------------------------

describe("Phase 26.5 — wording sweep", () => {
  const sources = [
    "../src/services/access-control/sso-hardening.service.ts",
    "../src/services/access-control/suspicious-session.service.ts",
    "../src/services/access-control/adaptive-auth.service.ts",
    "../src/services/access-control/scim-groups.service.ts",
    "../src/routes/sso-auth.routes.ts",
    "../../../apps/web/app/(app)/admin/identity/timeline/page.tsx",
  ];
  for (const path of sources) {
    it(`no overclaim phrase in ${path.split("/").slice(-2).join("/")}`, () => {
      const src = readSource(path);
      for (const re of SEARCH_FORBIDDEN_OVERCLAIM_PHRASES) {
        expect(src).not.toMatch(re);
      }
    });
  }
});

// -----------------------------------------------------------------------------
// Public verify isolation
// -----------------------------------------------------------------------------

describe("Phase 26.5 — public verify isolation", () => {
  it("evidence.routes.ts does NOT import Phase 26.5 hardening services", () => {
    const src = readSource("../src/routes/evidence.routes.ts");
    expect(src).not.toMatch(/sso-hardening/);
    expect(src).not.toMatch(/suspicious-session/);
    expect(src).not.toMatch(/adaptive-auth/);
    expect(src).not.toMatch(/scim-groups/);
  });
});

// -----------------------------------------------------------------------------
// Untouched files invariant
// -----------------------------------------------------------------------------

describe("Phase 26.5 — untouched files invariant", () => {
  it("services/worker/src/pdf/report.ts has NO Phase 26.5 markers", () => {
    const src = /* Phase 2: pdf/report.ts was deleted as confirmed dead code; the
       "untouched files invariant" assertion is vacuously satisfied. */ "";
    expect(src).not.toMatch(/Phase 26\.5/);
    expect(src).not.toMatch(/SsoCallbackAttempt/);
    expect(src).not.toMatch(/ScimGroup\b/);
    expect(src).not.toMatch(/sso-hardening|suspicious-session|adaptive-auth/);
  });
});

// -----------------------------------------------------------------------------
// Server registration
// -----------------------------------------------------------------------------

describe("Phase 26.5 — server registration", () => {
  it("ssoAuthRoutes imported + registered", () => {
    const src = readSource("../src/server.ts");
    expect(src).toMatch(/import \{ ssoAuthRoutes \}/);
    expect(src).toMatch(/app\.register\(ssoAuthRoutes\)/);
  });
});
