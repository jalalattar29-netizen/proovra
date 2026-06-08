/**
 * Phase P1.1 — Identity Operations Completion Pass contract suite.
 *
 * Phase P1.1 closed the four honest-scope follow-ups from P1:
 *
 *   1. SCIM drift detection + reconciliation engine
 *   2. Visual SAML attribute mapping builder
 *   3. SSO health dashboard
 *   4. Bounded session identity timeline
 *
 * These tests are source-contract style — they read source files
 * and assert regex / string contracts. No live server, no DB.
 *
 * Hard rules being verified:
 *   * Backend service surfaces exist with the documented exports.
 *   * Routes exist + are registered in server.ts.
 *   * Destructive endpoints (reconciliation execute, privilege-
 *     affecting SAML save) route through `requireStepUpForSensitiveAction`.
 *   * The four feature areas land as proper frontend pages /
 *     tabs / drawer, NOT placeholder copy.
 *   * Bounded event-type allowlist + bounded metric registry are
 *     extended (no ad-hoc names).
 *   * Honest-scope card on /settings/security removes the four
 *     shipped items.
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  const url = new URL(rel, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

function exists(rel: string): boolean {
  const url = new URL(rel, import.meta.url);
  return existsSync(fileURLToPath(url));
}

// ---------------------------------------------------------------------------
// 1. Backend services exist with the documented exports
// ---------------------------------------------------------------------------

describe("Phase P1.1 — Backend services", () => {
  it("SCIM reconciliation service exports detect / execute / list / replay", () => {
    const src = readSource(
      "../src/services/access-control/scim-reconciliation.service.ts",
    );
    expect(src).toMatch(/export\s+async\s+function\s+detectScimDrift/);
    expect(src).toMatch(/export\s+async\s+function\s+executeScimReconciliation/);
    expect(src).toMatch(/export\s+async\s+function\s+listScimSyncFailures/);
    expect(src).toMatch(/export\s+async\s+function\s+replayScimSyncFailure/);
    // 5 bounded drift categories
    expect(src).toContain("ORPHAN_LOCAL_MEMBERSHIP");
    expect(src).toContain("UNLINKED_IDENTITY_ACTIVE_USER");
    expect(src).toContain("STALE_TOKEN");
    expect(src).toContain("ORPHAN_SCIM_GROUP");
    expect(src).toContain("DUPLICATE_EXTERNAL_SUBJECT");
    // Bounded action enum (NOT a free-form string)
    expect(src).toContain("ARCHIVE_TOKEN");
    expect(src).toContain("SUSPEND_MEMBERSHIP");
    expect(src).toContain("ARCHIVE_GROUP");
    expect(src).toContain("REVIEW_ONLY");
    // Preview cache TTL must be bounded (5 minutes)
    expect(src).toMatch(/PREVIEW_TTL_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/);
  });

  it("SAML mapping service exports schema / current / preview / update + privilege purpose", () => {
    const src = readSource(
      "../src/services/security/saml-mapping.service.ts",
    );
    expect(src).toMatch(/export\s+function\s+getSamlMappingSchema/);
    expect(src).toMatch(/export\s+async\s+function\s+getCurrentSamlMapping/);
    expect(src).toMatch(/export\s+async\s+function\s+previewSamlMapping/);
    expect(src).toMatch(/export\s+async\s+function\s+updateSamlMapping/);
    expect(src).toContain("SAML_MAPPING_PRIVILEGE_PURPOSE");
    // Bounded warning codes
    expect(src).toContain("GROUP_ROLE_INCLUDES_OWNER_OR_ADMIN");
    expect(src).toContain("GROUP_ROLE_OVERLAPS_SCIM");
    expect(src).toContain("DEFAULT_ROLE_DOWNGRADED");
    expect(src).toContain("EMAIL_MAPPING_REMOVED");
    expect(src).toContain("EXTERNAL_ID_OVERRIDE_RISKY");
  });

  it("SSO health service exports buildSsoHealthSnapshot + failure taxonomy", () => {
    const src = readSource(
      "../src/services/security/sso-health.service.ts",
    );
    expect(src).toMatch(/export\s+async\s+function\s+buildSsoHealthSnapshot/);
    // Bounded health statuses
    expect(src).toContain('"HEALTHY"');
    expect(src).toContain('"DEGRADED"');
    expect(src).toContain('"OUTAGE"');
    expect(src).toContain('"DISABLED"');
    expect(src).toContain('"UNCONFIGURED"');
    // Bounded failure reason taxonomy
    expect(src).toContain('"invalid_signature"');
    expect(src).toContain('"expired_certificate"');
    expect(src).toContain('"audience_mismatch"');
    expect(src).toContain('"replay_detected"');
    // Cert expiry bands
    expect(src).toContain('"warning"');
    expect(src).toContain('"expiring"');
    expect(src).toContain('"expired"');
  });

  it("Session timeline service exports buildIdentitySessionTimeline + bounded event allowlist", () => {
    const src = readSource(
      "../src/services/security/session-timeline.service.ts",
    );
    expect(src).toMatch(/export\s+async\s+function\s+buildIdentitySessionTimeline/);
    expect(src).toContain("IDENTITY_TIMELINE_EVENT_TYPES");
    // Bounded event allowlist — must include identity-security
    // events; must NOT include surveillance-grade events.
    expect(src).toContain('"saml_login_succeeded"');
    expect(src).toContain('"mfa_challenge_verified"');
    expect(src).toContain('"step_up_challenge_verified"');
    expect(src).toContain('"session_quarantined"');
    expect(src).toContain('"session_revoked_admin"');
    // Bounded cap (200 events)
    expect(src).toMatch(/take:\s*201/);
  });
});

// ---------------------------------------------------------------------------
// 2. Routes — registered in server.ts + carry step-up where required
// ---------------------------------------------------------------------------

describe("Phase P1.1 — Routes registration", () => {
  it("identity operations completion routes are registered in server.ts", () => {
    const server = readSource("../src/server.ts");
    expect(server).toContain("identityOperationsCompletionRoutes");
    expect(server).toMatch(
      /app\.register\(\s*identityOperationsCompletionRoutes/,
    );
  });

  it("routes file exposes all 9 endpoints", () => {
    const routes = readSource(
      "../src/routes/identity-operations-completion.routes.ts",
    );
    // SCIM
    expect(routes).toContain('"/v1/scim/reconciliation/preview"');
    expect(routes).toContain('"/v1/scim/reconciliation/execute"');
    expect(routes).toContain('"/v1/scim/sync-failures"');
    expect(routes).toContain('"/v1/scim/sync-failures/:id/replay"');
    // SAML mapping
    expect(routes).toContain('"/v1/saml/mapping/schema"');
    expect(routes).toContain('"/v1/saml/mapping/current"');
    expect(routes).toContain('"/v1/saml/mapping/preview"');
    expect(routes).toContain('"/v1/saml/mapping"');
    // SSO health
    expect(routes).toContain('"/v1/sso/health"');
    // Session timeline
    expect(routes).toContain('"/v1/identity/sessions/:sessionId/timeline"');
  });

  it("destructive endpoints route through requireStepUpForSensitiveAction", () => {
    const routes = readSource(
      "../src/routes/identity-operations-completion.routes.ts",
    );
    // Reconciliation execute — always step-up gated
    expect(routes).toMatch(
      /requireStepUpForSensitiveAction[\s\S]*purpose:\s*"SCIM_RECONCILIATION_EXECUTE"/,
    );
    // SAML mapping update — step-up gated when preview.privilegeAffecting
    expect(routes).toMatch(/preview\.preview\.privilegeAffecting/);
    expect(routes).toMatch(
      /requireStepUpForSensitiveAction[\s\S]*purpose:\s*SAML_MAPPING_PRIVILEGE_PURPOSE/,
    );
  });

  it("anti-enumeration 404 on non-admin callers", () => {
    const routes = readSource(
      "../src/routes/identity-operations-completion.routes.ts",
    );
    // The shared requireIdentityAdmin helper returns 404 for
    // non-members (anti-enumeration) and 403 for inactive /
    // wrong-role members.
    expect(routes).toMatch(/reply\.code\(404\)[\s\S]*not_found/);
    expect(routes).toMatch(/member_inactive/);
    expect(routes).toMatch(/identity_ops_require_admin_role/);
  });
});

// ---------------------------------------------------------------------------
// 3. Bounded event types + metric registry are extended
// ---------------------------------------------------------------------------

describe("Phase P1.1 — Bounded registries", () => {
  it("security event types include the P1.1 set", () => {
    const sec = readSource("../../../packages/shared/src/security.ts");
    expect(sec).toContain("scim_drift_scan_completed");
    expect(sec).toContain("scim_reconciliation_executed");
    expect(sec).toContain("scim_reconciliation_token_archived");
    expect(sec).toContain("scim_reconciliation_membership_suspended");
    expect(sec).toContain("scim_reconciliation_group_archived");
    expect(sec).toContain("scim_sync_replayed");
    expect(sec).toContain("saml_mapping_previewed");
    expect(sec).toContain("saml_mapping_updated");
    expect(sec).toContain("saml_mapping_privilege_warning");
    expect(sec).toContain("sso_health_checked");
    expect(sec).toContain("identity_session_timeline_viewed");
  });

  it("metric registry includes the P1.1 keys", () => {
    const m = readSource(
      "../../../packages/shared-runtime/src/ops/metrics.service.ts",
    );
    expect(m).toContain('"scim_drift_scan_started_total"');
    expect(m).toContain('"scim_drift_detected_total"');
    expect(m).toContain('"scim_reconciliation_executed_total"');
    expect(m).toContain('"scim_reconciliation_applied_total"');
    expect(m).toContain('"scim_sync_replay_total"');
    expect(m).toContain('"saml_mapping_previewed_total"');
    expect(m).toContain('"saml_mapping_update_total"');
    expect(m).toContain('"sso_health_checked_total"');
    expect(m).toContain('"sso_health_degraded_total"');
    expect(m).toContain('"identity_session_timeline_viewed_total"');
  });

  it("step-up purpose enum includes the two new purposes", () => {
    const idn = readSource(
      "../../../packages/shared/src/identity-security.ts",
    );
    expect(idn).toContain('"SCIM_RECONCILIATION_EXECUTE"');
    expect(idn).toContain('"SAML_MAPPING_PRIVILEGE_UPDATE"');
  });
});

// ---------------------------------------------------------------------------
// 4. Frontend surfaces exist
// ---------------------------------------------------------------------------

describe("Phase P1.1 — Frontend surfaces", () => {
  it("SCIM page exposes Tokens / Drift / Replay tabs", () => {
    const p = readSource(
      "../../../apps/web/app/(app)/admin/identity/scim/page.tsx",
    );
    expect(p).toContain("TAB_LABELS");
    expect(p).toContain("Drift detection");
    expect(p).toContain("Sync replay");
    // Drift tab calls the preview + execute endpoints
    expect(p).toContain("/v1/scim/reconciliation/preview");
    expect(p).toContain("/v1/scim/reconciliation/execute");
    // Step-up wrapper present
    expect(p).toContain("runStepUpAction");
    // Replay tab calls the failures endpoint
    expect(p).toContain("/v1/scim/sync-failures");
    expect(p).toContain("/replay");
  });

  it("SSO Health dashboard page exists at /security-center/sso/health", () => {
    expect(
      exists(
        "../../../apps/web/app/(app)/security-center/sso/health/page.tsx",
      ),
    ).toBe(true);
    const p = readSource(
      "../../../apps/web/app/(app)/security-center/sso/health/page.tsx",
    );
    expect(p).toContain("/v1/sso/health");
    expect(p).toContain("overallStatus");
    expect(p).toContain("Failure breakdown");
  });

  it("SAML Visual Mapping Builder exists at /security-center/sso/mapping", () => {
    expect(
      exists(
        "../../../apps/web/app/(app)/security-center/sso/mapping/page.tsx",
      ),
    ).toBe(true);
    const p = readSource(
      "../../../apps/web/app/(app)/security-center/sso/mapping/page.tsx",
    );
    expect(p).toContain("/v1/saml/mapping/schema");
    expect(p).toContain("/v1/saml/mapping/current");
    expect(p).toContain("/v1/saml/mapping/preview");
    expect(p).toContain("/v1/saml/mapping");
    expect(p).toContain("privilegeAffecting");
    // Step-up wrapper present
    expect(p).toContain("runStepUpAction");
  });

  it("Sessions page wires a Session Timeline drawer per row", () => {
    const p = readSource(
      "../../../apps/web/app/(app)/admin/identity/sessions/page.tsx",
    );
    expect(p).toContain("SessionTimelineDrawer");
    expect(p).toContain("View timeline");
    expect(p).toContain("/v1/identity/sessions/");
    expect(p).toContain("/timeline");
  });

  it("/security-center/sso links to the new health + mapping pages", () => {
    const p = readSource(
      "../../../apps/web/app/(app)/security-center/sso/page.tsx",
    );
    expect(p).toContain('"/security-center/sso/health"');
    expect(p).toContain('"/security-center/sso/mapping"');
  });
});

// ---------------------------------------------------------------------------
// 5. Honest-scope card removes the four shipped items
// ---------------------------------------------------------------------------

describe("Phase P1.1 — Honest-scope card hygiene", () => {
  it("/admin/identity no longer lists the four shipped follow-ups", () => {
    // Phase IA-collapse — hub moved from /settings/security to
    // /admin/identity. /settings/security is now the Account Security
    // home (route id `account.security`).
    const hub = readSource(
      "../../../apps/web/app/(app)/admin/identity/page.tsx",
    );
    expect(hub).not.toMatch(
      /<strong>SCIM drift reconciliation engine<\/strong>/,
    );
    expect(hub).not.toMatch(
      /<strong>SSO connection health monitoring dashboard<\/strong>/,
    );
    expect(hub).not.toMatch(
      /<strong>Visual SAML attribute mapping builder<\/strong>/,
    );
    expect(hub).not.toMatch(/<strong>Historical session replay<\/strong>/);
    // Step-up exemption rules remains an honest follow-up
    expect(hub).toContain("Step-up exemption rules");
  });
});

// ---------------------------------------------------------------------------
// 6. Privacy invariant on session timeline
// ---------------------------------------------------------------------------

describe("Phase P1.1 — Session timeline privacy invariants", () => {
  it("response omits raw IP / userAgent / device telemetry", () => {
    const src = readSource(
      "../src/services/security/session-timeline.service.ts",
    );
    // The response shape (IdentitySessionTimeline) intentionally
    // omits ip / userAgent fields. If a future change adds them
    // the test fails — forcing reviewers to confront the privacy
    // implication.
    const responseDoc = src.split("export type IdentitySessionTimeline")[1];
    expect(responseDoc).toBeDefined();
    // Look inside the type definition only (until the matching closing brace)
    const typeBody = responseDoc.split("};")[0];
    expect(typeBody).not.toContain("ipAddress");
    expect(typeBody).not.toContain("userAgent");
    expect(typeBody).not.toContain("deviceId");
  });

  it("event allowlist excludes surveillance-grade event types", () => {
    const src = readSource(
      "../src/services/security/session-timeline.service.ts",
    );
    // These are page-view / activity events that exist elsewhere
    // in the platform. They must NOT be surfaced in the bounded
    // identity timeline.
    expect(src).not.toContain("page_view");
    expect(src).not.toContain("mouse_activity");
    expect(src).not.toContain("evidence_viewed");
  });
});
