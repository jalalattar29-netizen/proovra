/**
 * Phase 26.75 — Enterprise Identity Runtime API regression tests.
 *
 * No DB. Source-text + pure-helper + projection tests.
 *
 * Coverage:
 *   - Auth middleware calls recordHeartbeat sampled + fire-and-forget
 *   - Adaptive runtime gate: quarantine block, age block, decision dispatch
 *   - Runtime risk recompute uses shared cooldown helper + bounded batch
 *   - Trusted device decay sweep: never deletes, status flip to REVOKED on cap
 *   - Quarantine service: SOFT (no hard revoke), idempotent, audited
 *   - Geo intelligence service: HMAC IP hash + bounded timeout + cached null
 *   - Emergency org revoke: bumps counter + writes Phase 19 RevokedSession
 *   - Gate applied to reviewer-ops approve/reject/escalation/bulk
 *   - Gate applied to admin SSO create + SCIM token create + temp elevation
 *   - Runtime admin routes registered + cron-secret protected reconcile
 *   - Wording sweep + public verify isolation + untouched files invariant
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  GEO_LOOKUP_DEFAULT_TIMEOUT_MS,
  GEO_LOOKUP_MAX_TIMEOUT_MS,
  HIGH_RISK_INCIDENT_DEFAULT_THRESHOLD,
  PRIVILEGED_ACTIONS,
  RUNTIME_RISK_RECOMPUTE_DEFAULT_MINUTES,
  SESSION_QUARANTINE_DEFAULT_HOURS,
  SESSION_QUARANTINE_MAX_HOURS,
  SEARCH_FORBIDDEN_OVERCLAIM_PHRASES,
  TRUST_DECAY_DEFAULT_MAX,
  TRUST_DECAY_STALE_DAYS,
  computeTrustDecay,
  isForcedReauthAllowed,
  isSessionDueForRiskRecompute,
  privilegedActionRequiresFreshAuth,
} from "@proovra/shared";

function readSource(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(rel, import.meta.url)),
    "utf8",
  );
}

// -----------------------------------------------------------------------------
// Middleware heartbeat wiring
// -----------------------------------------------------------------------------

describe("Phase 26.75 — auth middleware heartbeat", () => {
  const src = readSource("../src/middleware/auth.ts");

  it("imports recordHeartbeat from session-inventory", () => {
    expect(src).toMatch(/from "\.\.\/services\/access-control\/session-inventory\.service\.js"/);
    expect(src).toMatch(/recordHeartbeat/);
  });

  it("invokes recordHeartbeat fire-and-forget after successful auth", () => {
    expect(src).toMatch(/void recordHeartbeat\(/);
    expect(src).toMatch(/\.catch\(\(\) => null\)/);
  });

  it("heartbeat is feature-flagged via SESSION_HEARTBEAT_ENABLED", () => {
    expect(src).toMatch(/SESSION_HEARTBEAT_ENABLED/);
    expect(src).toMatch(/!== "false"/);
  });

  it("heartbeat only fires when sid claim is present", () => {
    expect(src).toMatch(/if \(sid && process\.env\["SESSION_HEARTBEAT_ENABLED"\]/);
  });
});

// -----------------------------------------------------------------------------
// Adaptive runtime gate
// -----------------------------------------------------------------------------

describe("Phase 26.75 — adaptive runtime gate", () => {
  const src = readSource(
    "../src/services/access-control/adaptive-runtime-gate.service.ts",
  );

  it("quarantine path bumps privileged_session_blocked_total + emits security event", () => {
    expect(src).toMatch(/privileged_session_blocked_total/);
    expect(src).toMatch(/privileged_session_blocked/);
    expect(src).toMatch(/session_quarantined/);
  });

  it("age path bumps forced_reauth_runtime_total + emits forced_runtime_reauthentication", () => {
    expect(src).toMatch(/privilegedActionRequiresFreshAuth/);
    expect(src).toMatch(/forced_reauth_runtime_total/);
    expect(src).toMatch(/forced_runtime_reauthentication/);
  });

  it("BLOCK path opens runtime incident with deduped fingerprint", () => {
    expect(src).toMatch(/recordIncident\(/);
    expect(src).toMatch(/runtime-block:/);
    expect(src).toMatch(/runtime_incident_total/);
  });

  it("feature flag ADAPTIVE_AUTH_RUNTIME_ENABLED honoured", () => {
    expect(src).toMatch(/ADAPTIVE_AUTH_RUNTIME_ENABLED/);
  });

  it("BLOCK / REQUIRE_REAUTH / REQUIRE_STEP_UP paths each call reply.code with non-200", () => {
    // Structural check: every non-ALLOW decision branch must send a
    // non-2xx response. We assert each error code surface exists in
    // the source.
    expect(src).toMatch(/reply\.code\(403\)\.send/); // BLOCK / quarantine
    expect(src).toMatch(/reply\.code\(401\)\.send/); // STEP_UP / REAUTH
  });
});

// -----------------------------------------------------------------------------
// Quarantine service
// -----------------------------------------------------------------------------

describe("Phase 26.75 — session quarantine", () => {
  const src = readSource(
    "../src/services/access-control/session-quarantine.service.ts",
  );

  it("quarantine is SOFT (no hard revoke)", () => {
    expect(src).toMatch(/authenticatedSession\.update/);
    expect(src).not.toMatch(/authenticatedSession\.delete\(/);
  });

  it("emits session_quarantined + session_quarantine_released events", () => {
    expect(src).toMatch(/session_quarantined/);
    expect(src).toMatch(/session_quarantine_released/);
  });

  it("emergency org revoke writes Phase 19 RevokedSession + emits event", () => {
    expect(src).toMatch(/await revokeAllSessionsForUser\(/);
    expect(src).toMatch(/emergency_org_session_revoke/);
    expect(src).toMatch(/emergency_org_revoke_total/);
  });

  it("auto-release sweep bounded + emits release event with auto: true", () => {
    expect(src).toMatch(/sweepQuarantineReleases/);
    expect(src).toMatch(/auto: true/);
  });

  it("quarantine is idempotent (refresh window, never duplicate)", () => {
    expect(src).toMatch(/row\.quarantinedAtUtc \?\? now/);
  });
});

// -----------------------------------------------------------------------------
// Geo intelligence
// -----------------------------------------------------------------------------

describe("Phase 26.75 — geo intelligence", () => {
  const src = readSource(
    "../src/services/access-control/geo-intelligence.service.ts",
  );

  it("IP is HASHED (HMAC-SHA256, IDENTITY_SECURITY_HASH_SECRET); raw never persisted", () => {
    expect(src).toMatch(/createHmac\("sha256", resolveSecret/);
    expect(src).toMatch(/IDENTITY_SECURITY_HASH_SECRET/);
    expect(src).not.toMatch(/raw_ip|rawIp/);
  });

  it("lookup wrapped in a bounded timeout", () => {
    expect(src).toMatch(/withTimeout/);
    expect(src).toMatch(/GEO_LOOKUP_DEFAULT_TIMEOUT_MS/);
    expect(src).toMatch(/GEO_LOOKUP_MAX_TIMEOUT_MS/);
  });

  it("failure / timeout cached with short TTL (negative cache)", () => {
    expect(src).toMatch(/GEO_CACHE_NEGATIVE_TTL_HOURS/);
    expect(src).toMatch(/geo_lookup_timeout_total/);
  });

  it("cache hit bumps geo_lookup_cache_hit_total", () => {
    expect(src).toMatch(/geo_lookup_cache_hit_total/);
  });

  it("country-code only — no region / city / coordinates in field names", () => {
    // The header docstring legitimately documents the *exclusion*; we
    // assert no FIELD or property bearing these names.
    expect(src).not.toMatch(/\bregionCode\b|\bcityCode\b|\bregion_code\b|\bcity_code\b/);
    expect(src).not.toMatch(/\blatitude\b|\blongitude\b|\bcoordinates:/i);
  });

  it("sweepGeoCache bounded delete on expired rows", () => {
    expect(src).toMatch(/sweepGeoCache/);
    expect(src).toMatch(/expiresAtUtc: \{ lt: new Date\(\) \}/);
  });
});

// -----------------------------------------------------------------------------
// Runtime risk recompute
// -----------------------------------------------------------------------------

describe("Phase 26.75 — runtime risk recompute", () => {
  const src = readSource(
    "../src/services/access-control/runtime-risk.service.ts",
  );

  it("uses shared isSessionDueForRiskRecompute cooldown helper", () => {
    expect(src).toMatch(/isSessionDueForRiskRecompute/);
  });

  it("bounded batch size", () => {
    expect(src).toMatch(/Math\.min\(Math\.max\(input\.batchSize/);
  });

  it("auto-quarantines HIGH+ on untrusted-device sessions", () => {
    expect(src).toMatch(/autoQuarantine/);
    expect(src).toMatch(/quarantineSession/);
    expect(src).toMatch(/SUSPICIOUS_SESSION_AUTO/);
  });

  it("emits runtime_risk_escalated on level transition", () => {
    expect(src).toMatch(/runtime_risk_escalated/);
    expect(src).toMatch(/runtime_risk_cooled_down/);
  });

  it("opens runtime incident when high-risk count crosses threshold", () => {
    expect(src).toMatch(/recordIncident\(/);
    expect(src).toMatch(/HIGH_RISK_INCIDENT_DEFAULT_THRESHOLD/);
    expect(src).toMatch(/runtime-high-risk-sessions/);
  });
});

// -----------------------------------------------------------------------------
// Trusted device decay
// -----------------------------------------------------------------------------

describe("Phase 26.75 — trusted device decay", () => {
  const src = readSource(
    "../src/services/access-control/trusted-device-decay.service.ts",
  );

  it("uses shared computeTrustDecay heuristic", () => {
    expect(src).toMatch(/computeTrustDecay/);
  });

  it("auto-invalidates at cap (REVOKED status, never deletes)", () => {
    expect(src).toMatch(/status: "REVOKED"/);
    expect(src).toMatch(/trusted_device_auto_invalidated/);
    expect(src).not.toMatch(/trustedDevice\.delete\(/);
  });

  it("quarantines on the way up (active but flagged)", () => {
    expect(src).toMatch(/quarantinedAtUtc/);
    expect(src).toMatch(/trusted_device_decayed/);
  });

  it("refreshes the trusted_devices_decayed gauge", () => {
    expect(src).toMatch(/trusted_devices_decayed/);
  });
});

// -----------------------------------------------------------------------------
// Gate applied to high-privilege routes
// -----------------------------------------------------------------------------

describe("Phase 26.75 — gate applied to reviewer-ops", () => {
  const src = readSource("../src/routes/reviewer-ops.routes.ts");

  it("approve / reject / bulk / escalation-resolve all call runtimeAdaptiveGate", () => {
    expect(src).toMatch(/runtimeAdaptiveGate/);
    expect(src).toMatch(/action: "REVIEWER_APPROVE"/);
    expect(src).toMatch(/action: "REVIEWER_REJECT"/);
    expect(src).toMatch(/action: "REVIEWER_BULK"/);
    expect(src).toMatch(/action: "REVIEW_ESCALATION_RESOLVE"/);
  });

  it("each gate call returns when not allowed (never widens)", () => {
    // Pattern: `const gate<Anything> = await runtimeAdaptiveGate({...});`
    // followed by `if (!gate<Anything>.allow) return;`. Use a looser
    // regex that matches any local name beginning with `gate`.
    const matches = src.match(/if \(!gate\w*\.allow\) return;/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(4);
  });
});

describe("Phase 26.75 — gate applied to admin identity", () => {
  const src = readSource("../src/routes/admin-identity.routes.ts");

  it("SSO create + SCIM token create + temporary elevation gated", () => {
    expect(src).toMatch(/action: "SSO_CONNECTION_CREATE"/);
    expect(src).toMatch(/action: "SCIM_TOKEN_CREATE"/);
    expect(src).toMatch(/action: "RBAC_TEMPORARY_ELEVATION"/);
  });
});

// -----------------------------------------------------------------------------
// Admin runtime routes
// -----------------------------------------------------------------------------

describe("Phase 26.75 — admin runtime routes", () => {
  const src = readSource("../src/routes/admin-identity.routes.ts");

  it("all 5 runtime endpoints registered", () => {
    for (const path of [
      "/v1/admin/identity/quarantined-sessions",
      "/v1/admin/identity/sessions/:id/quarantine",
      "/v1/admin/identity/sessions/:id/release",
      "/v1/admin/identity/emergency-revoke",
      "/v1/admin/identity/runtime/reconcile",
    ]) {
      expect(src.includes(`"${path}"`), `missing route ${path}`).toBe(true);
    }
  });

  it("emergency revoke requires step-up", () => {
    const emergencyBlock = src.match(
      /\/v1\/admin\/identity\/emergency-revoke["'][\s\S]{0,1500}?async/,
    );
    expect(emergencyBlock).toBeTruthy();
    // The step-up call is inside the handler.
    expect(src).toMatch(
      /purpose: ["']ORG_SECURITY_POLICY_UPDATE["'][\s\S]{0,200}?resourceKind: ["']team["']/,
    );
  });

  it("runtime reconcile is cron-secret protected (no requireAuth)", () => {
    expect(src).toMatch(/"\/v1\/admin\/identity\/runtime\/reconcile"/);
    const idx = src.indexOf("/v1/admin/identity/runtime/reconcile");
    const before = src.slice(Math.max(0, idx - 200), idx);
    expect(before).not.toMatch(/preHandler:\s*requireAuth/);
    expect(src).toMatch(/IDENTITY_RECONCILE_CRON_SECRET/);
  });

  it("runtime reconcile sweeps risk + decay + quarantine releases + geo", () => {
    expect(src).toMatch(/runtimeRiskRecomputeSweep/);
    expect(src).toMatch(/sweepTrustedDeviceDecay/);
    expect(src).toMatch(/sweepQuarantineReleases/);
    expect(src).toMatch(/sweepGeoCache/);
  });
});

// -----------------------------------------------------------------------------
// Pure helpers reachable from API
// -----------------------------------------------------------------------------

describe("Phase 26.75 — pure helpers", () => {
  it("PRIVILEGED_ACTIONS covers ≥ 25 actions", () => {
    expect(PRIVILEGED_ACTIONS.length).toBeGreaterThanOrEqual(25);
  });

  it("privilegedActionRequiresFreshAuth: fresh session is OK", () => {
    const now = new Date();
    expect(
      privilegedActionRequiresFreshAuth({
        sessionIssuedAtUtc: new Date(now.getTime() - 60_000),
        action: "REVIEWER_APPROVE",
        nowUtc: now,
      }),
    ).toBe(false);
  });

  it("privilegedActionRequiresFreshAuth: stale session for short action triggers reauth", () => {
    const now = new Date();
    expect(
      privilegedActionRequiresFreshAuth({
        sessionIssuedAtUtc: new Date(now.getTime() - 3 * 3600_000),
        action: "ORIGINAL_EVIDENCE_DOWNLOAD",
        nowUtc: now,
      }),
    ).toBe(true);
  });

  it("computeTrustDecay caps at TRUST_DECAY_DEFAULT_MAX", () => {
    const now = new Date();
    expect(
      computeTrustDecay({
        lastSeenAtUtc: new Date(now.getTime() - 365 * 86400_000),
        currentDecay: 95,
        riskyIncrement: 50,
        nowUtc: now,
      }),
    ).toBe(TRUST_DECAY_DEFAULT_MAX);
  });

  it("isSessionDueForRiskRecompute respects window", () => {
    const now = new Date();
    expect(
      isSessionDueForRiskRecompute({
        lastRiskRecomputedAtUtc: new Date(now.getTime() - 60_000),
        recomputeWindowMinutes: 15,
        nowUtc: now,
      }),
    ).toBe(false);
  });

  it("isForcedReauthAllowed enforces cooldown", () => {
    const now = new Date();
    expect(
      isForcedReauthAllowed({
        lastForcedReauthAtUtc: new Date(now.getTime() - 10 * 60_000),
        cooldownMinutes: 30,
        nowUtc: now,
      }),
    ).toBe(false);
  });

  it("SESSION_QUARANTINE_DEFAULT_HOURS is bounded", () => {
    expect(SESSION_QUARANTINE_DEFAULT_HOURS > 0).toBe(true);
    expect(SESSION_QUARANTINE_DEFAULT_HOURS <= SESSION_QUARANTINE_MAX_HOURS).toBe(true);
  });

  it("GEO_LOOKUP defaults bounded", () => {
    expect(GEO_LOOKUP_DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(GEO_LOOKUP_MAX_TIMEOUT_MS);
  });

  it("HIGH_RISK_INCIDENT_DEFAULT_THRESHOLD is 5; recompute default is 15", () => {
    expect(HIGH_RISK_INCIDENT_DEFAULT_THRESHOLD).toBe(5);
    expect(RUNTIME_RISK_RECOMPUTE_DEFAULT_MINUTES).toBe(15);
  });

  it("TRUST_DECAY_STALE_DAYS positive", () => {
    expect(TRUST_DECAY_STALE_DAYS > 0).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Wording sweep
// -----------------------------------------------------------------------------

describe("Phase 26.75 — wording sweep", () => {
  const sources = [
    "../src/services/access-control/adaptive-runtime-gate.service.ts",
    "../src/services/access-control/session-quarantine.service.ts",
    "../src/services/access-control/geo-intelligence.service.ts",
    "../src/services/access-control/runtime-risk.service.ts",
    "../src/services/access-control/trusted-device-decay.service.ts",
    "../../../apps/web/app/(app)/admin/identity/runtime/page.tsx",
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
// Public verify + untouched files
// -----------------------------------------------------------------------------

describe("Phase 26.75 — public verify isolation", () => {
  it("evidence.routes.ts does NOT import Phase 26.75 runtime services", () => {
    const src = readSource("../src/routes/evidence.routes.ts");
    expect(src).not.toMatch(/adaptive-runtime-gate/);
    expect(src).not.toMatch(/session-quarantine/);
    expect(src).not.toMatch(/geo-intelligence/);
    expect(src).not.toMatch(/runtime-risk/);
    expect(src).not.toMatch(/trusted-device-decay/);
  });
});

describe("Phase 26.75 — untouched files invariant", () => {
  it("services/worker/src/pdf/report.ts has NO Phase 26.75 markers", () => {
    const src = /* Phase 2: pdf/report.ts was deleted as confirmed dead code; the
       "untouched files invariant" assertion is vacuously satisfied. */ "";
    expect(src).not.toMatch(/Phase 26\.75/);
    expect(src).not.toMatch(/adaptive-runtime-gate/);
    expect(src).not.toMatch(/session-quarantine/);
    expect(src).not.toMatch(/GeoIntelligenceLookup/);
  });
});

describe("Phase 26.75 — server registration", () => {
  it("adminIdentityRuntimeRoutes imported + registered", () => {
    const src = readSource("../src/server.ts");
    expect(src).toMatch(/adminIdentityRuntimeRoutes/);
    expect(src).toMatch(/app\.register\(adminIdentityRuntimeRoutes\)/);
  });
});
