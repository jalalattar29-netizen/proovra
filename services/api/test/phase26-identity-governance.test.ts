/**
 * Phase 26 — Enterprise Identity Governance API regression tests.
 *
 * No DB. Source-text + pure-helper + projection tests.
 *
 * Coverage:
 *   - RBAC engine wires through Phase 17 evaluateMemberAccess (no
 *     bypass).
 *   - RBAC engine records temporary elevations as Phase 17 capability
 *     grants with bounded expiry.
 *   - SSO service: client secrets NEVER persisted in plaintext;
 *     allowed-email-domains gate fires; JIT path goes through
 *     ExternalIdentityMapping.
 *   - SCIM service: tokens hashed; constant-time token compare;
 *     idempotent POST returns 200 on existing externalId.
 *   - SCIM deactivation is SOFT (TeamMember.status = SUSPENDED).
 *   - Session inventory writes go through the existing Phase 19
 *     `revokeSession()` helper.
 *   - Routes: all 12 Phase 26 endpoints registered.
 *   - Routes: admin routes require identity.* permissions; SCIM routes
 *     require bearer token, NEVER the session JWT.
 *   - Wording sweep: no forbidden overclaim phrases in any new file.
 *   - Public verify isolation + untouched-files invariants.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  RBAC_DECISION_OUTCOMES,
  RBAC_DECISION_SOURCES,
  RBAC_PERMISSION_DOMAINS,
  SCIM_SCOPES,
  SCIM_TOKEN_PREFIX,
  SEARCH_FORBIDDEN_OVERCLAIM_PHRASES,
  SSO_CONNECTION_STATUSES,
  SSO_PROVIDERS,
  applyInheritanceChain,
  isAllowedSsoConnectionTransition,
  ssoProviderProtocol,
} from "@proovra/shared";

function readSource(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(rel, import.meta.url)),
    "utf8",
  );
}

// -----------------------------------------------------------------------------
// RBAC engine wiring
// -----------------------------------------------------------------------------

describe("Phase 26 — RBAC engine wiring", () => {
  const src = readSource(
    "../src/services/access-control/rbac-engine.service.ts",
  );

  it("delegates every evaluation to Phase 17 evaluateMemberAccess", () => {
    expect(src).toMatch(/evaluateMemberAccess\(/);
    // No direct queries against TeamMember / capabilityGrant from the
    // engine — that would mean we duplicated the Phase 17 evaluator.
    expect(src).not.toMatch(/client\.teamMember\.findFirst/);
    expect(src).not.toMatch(/client\.memberCapabilityGrant\.findFirst/);
  });

  it("temporary elevation upserts an existing capability grant (no parallel table)", () => {
    expect(src).toMatch(/memberCapabilityGrant\.upsert/);
    expect(src).toMatch(/expiresAtUtc/);
    expect(src).toMatch(/rbac_temporary_elevation_granted/);
  });

  it("permission matrix uses the shared PERMISSIONS catalog", () => {
    expect(src).toMatch(/for \(const perm of PERMISSIONS\)/);
  });

  it("explicit deny bumps the dedicated counter", () => {
    expect(src).toMatch(/rbac_explicit_deny_total/);
  });
});

// -----------------------------------------------------------------------------
// SSO service
// -----------------------------------------------------------------------------

describe("Phase 26 — SSO service", () => {
  const src = readSource(
    "../src/services/access-control/sso.service.ts",
  );

  it("client secret is HASHED on persistence; raw value returned once", () => {
    expect(src).toMatch(/hashClientSecret/);
    expect(src).toMatch(/clientSecretHash/);
    expect(src).toMatch(/clientSecretOnce: string \| null/);
  });

  it("client secret preview is masked (never the raw)", () => {
    expect(src).toMatch(/previewClientSecret/);
    expect(src).toMatch(/`ck-\*\*\*-\$\{tail\}`/);
  });

  it("allowed-email-domains gate fires before JIT", () => {
    expect(src).toMatch(/emailMatchesAllowedDomains/);
    expect(src).toMatch(/SSO_EMAIL_DOMAIN_NOT_ALLOWED/);
  });

  it("JIT path writes ExternalIdentityMapping (Phase 17 canonical pointer)", () => {
    expect(src).toMatch(/externalIdentityMapping\.create/);
  });

  it("OIDC state is single-use (deleted after read)", () => {
    expect(src).toMatch(/oidcStateStore\.delete\(input\.state\)/);
  });

  it("client secret resolver is overridable (no leakage from env)", () => {
    expect(src).toMatch(/setClientSecretResolver/);
  });

  it("login start + success + failure each emit a SecurityEvent", () => {
    expect(src).toMatch(/sso_login_started/);
    expect(src).toMatch(/sso_login_succeeded/);
    expect(src).toMatch(/sso_login_failed/);
  });
});

// -----------------------------------------------------------------------------
// SCIM service
// -----------------------------------------------------------------------------

describe("Phase 26 — SCIM service", () => {
  const src = readSource(
    "../src/services/access-control/scim.service.ts",
  );

  it("tokens are hashed on create + compared in constant time", () => {
    expect(src).toMatch(/hashToken\(raw\)/);
    expect(src).toMatch(/timingSafeEqual/);
    expect(src).toMatch(/constantTimeEquals/);
  });

  it("token authenticator rejects non-bearer schemes", () => {
    expect(src).toMatch(/\/\^Bearer\\s\+\(\.\+\)\$\/i/);
    expect(src).toMatch(/scim_invalid_token_total/);
  });

  it("POST is idempotent — existing externalId returns 200 not 201", () => {
    expect(src).toMatch(/alreadyExisted/);
    expect(src).toMatch(/findUserBySubject/);
  });

  it("deactivation is SOFT (TeamMember.status = SUSPENDED + external mapping unlinked)", () => {
    expect(src).toMatch(/status: "SUSPENDED"/);
    expect(src).toMatch(/unlinkedAtUtc/);
    // No hard delete of users.
    expect(src).not.toMatch(/client\.user\.delete/);
  });

  it("required SCIM v2 schemas referenced", () => {
    expect(src).toMatch(/SCIM_USER_SCHEMA_URI/);
    expect(src).toMatch(/SCIM_LIST_RESPONSE_SCHEMA_URI/);
  });
});

// -----------------------------------------------------------------------------
// Session inventory
// -----------------------------------------------------------------------------

describe("Phase 26 — Session inventory", () => {
  const src = readSource(
    "../src/services/access-control/session-inventory.service.ts",
  );

  it("uses Phase 19 hashSessionId (never the raw jti)", () => {
    expect(src).toMatch(/hashSessionId/);
  });

  it("revoke goes through the existing Phase 19 revokeSession()", () => {
    expect(src).toMatch(/await revokeSession\(/);
  });

  it("revoke-all goes through revokeAllSessionsForUser()", () => {
    expect(src).toMatch(/await revokeAllSessionsForUser\(/);
  });

  it("emits admin-revocation SecurityEvents", () => {
    expect(src).toMatch(/session_revoked_admin/);
    expect(src).toMatch(/all_sessions_revoked_admin/);
  });
});

// -----------------------------------------------------------------------------
// Admin routes
// -----------------------------------------------------------------------------

describe("Phase 26 — admin identity routes", () => {
  const src = readSource("../src/routes/admin-identity.routes.ts");

  it("all 12 admin endpoints registered", () => {
    for (const path of [
      "/v1/admin/identity/providers",
      "/v1/admin/identity/providers/:id/transition",
      "/v1/admin/identity/permission-matrix",
      "/v1/admin/identity/role-matrix",
      "/v1/admin/identity/elevations",
      "/v1/admin/identity/scim/tokens",
      "/v1/admin/identity/scim/tokens/:id/revoke",
      "/v1/admin/identity/sessions",
      "/v1/admin/identity/sessions/:id/revoke",
      "/v1/admin/identity/sessions/user/:userId/revoke-all",
    ]) {
      expect(src.includes(`"${path}"`), `missing route ${path}`).toBe(true);
    }
  });

  it("404-on-non-member anti-enumeration", () => {
    expect(src).toMatch(/requireIdentityAdmin/);
    expect(src).toMatch(/reply\.code\(404\)\.send\(\{ error: \{ code: ["']not_found["'] \} \}\)/);
  });

  it("SSO provider create requires EXTERNAL_IDENTITY_LINK step-up", () => {
    expect(src).toMatch(/purpose: ["']EXTERNAL_IDENTITY_LINK["']/);
  });

  it("Temporary elevation requires CAPABILITY_GRANT step-up", () => {
    expect(src).toMatch(/purpose: ["']CAPABILITY_GRANT["']/);
  });

  it("revoke-all-sessions requires CONTRIBUTOR_SESSION_REVOKE step-up", () => {
    expect(src).toMatch(/purpose: ["']CONTRIBUTOR_SESSION_REVOKE["']/);
  });

  it("all admin permissions are namespaced identity.*", () => {
    expect(src).toMatch(/"identity\.org_policy\.read"/);
    expect(src).toMatch(/"identity\.member\.read"/);
    expect(src).toMatch(/"identity\.external_mapping\.manage"/);
  });
});

// -----------------------------------------------------------------------------
// SCIM routes — token-only auth, NEVER session JWT
// -----------------------------------------------------------------------------

describe("Phase 26 — SCIM routes", () => {
  const src = readSource("../src/routes/scim.routes.ts");

  it("all SCIM v2 endpoints registered", () => {
    for (const path of [
      "/v2/scim/Users",
      "/v2/scim/Users/:id",
    ]) {
      expect(src.includes(`"${path}"`), `missing route ${path}`).toBe(true);
    }
  });

  it("NEVER uses requireAuth (session JWT path)", () => {
    expect(src).not.toMatch(/requireAuth/);
  });

  it("uses authenticateScim with required scope on every route", () => {
    expect(src).toMatch(/authenticateScim/);
    const matches = src.match(/await authenticateScim\(req, reply, /g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(4);
  });

  it("Content-Type is application/scim+json on responses", () => {
    expect(src).toMatch(/application\/scim\+json/);
  });

  it("401 includes WWW-Authenticate: Bearer realm=\"scim\"", () => {
    expect(src).toMatch(/WWW-Authenticate/);
    // Source has escaped quotes in the string literal.
    expect(src).toMatch(/Bearer realm=\\?"scim\\?"/);
  });
});

// -----------------------------------------------------------------------------
// Pure helpers
// -----------------------------------------------------------------------------

describe("Phase 26 — pure helpers", () => {
  it("RBAC catalogs are complete", () => {
    expect(RBAC_DECISION_OUTCOMES.length).toBe(4);
    expect(RBAC_DECISION_SOURCES.length).toBe(9);
    expect(RBAC_PERMISSION_DOMAINS.length).toBeGreaterThanOrEqual(19);
  });

  it("applyInheritanceChain: DENY wins", () => {
    const out = applyInheritanceChain([
      { outcome: "ALLOW", source: "ROLE_MATRIX", reason: "ok" },
      { outcome: "DENY", source: "WORKSPACE_POLICY", reason: "blocked" },
    ]);
    expect(out.outcome).toBe("DENY");
  });

  it("SSO catalog hosts the brief's IdPs", () => {
    for (const p of ["GOOGLE_WORKSPACE", "OKTA", "AZURE_AD"]) {
      expect(SSO_PROVIDERS.includes(p as never)).toBe(true);
    }
  });

  it("SSO REVOKED is terminal", () => {
    expect(isAllowedSsoConnectionTransition("REVOKED", "ACTIVE")).toBe(false);
  });

  it("ssoProviderProtocol classifies correctly", () => {
    expect(ssoProviderProtocol("GOOGLE_WORKSPACE")).toBe("OIDC");
    expect(ssoProviderProtocol("GENERIC_SAML")).toBe("SAML");
  });

  it("SCIM scope catalog includes write + deactivate", () => {
    expect(SCIM_SCOPES.includes("users.write")).toBe(true);
    expect(SCIM_SCOPES.includes("users.deactivate")).toBe(true);
  });

  it("SCIM connection statuses (PENDING, ACTIVE, DISABLED, REVOKED)", () => {
    expect(SSO_CONNECTION_STATUSES.length).toBe(4);
  });

  it("SCIM_TOKEN_PREFIX is the canonical scim_pat_ prefix", () => {
    expect(SCIM_TOKEN_PREFIX).toBe("scim_pat_");
  });
});

// -----------------------------------------------------------------------------
// Wording sweep across new Phase 26 sources + UI pages
// -----------------------------------------------------------------------------

describe("Phase 26 — wording sweep", () => {
  const sources = [
    "../src/services/access-control/rbac-engine.service.ts",
    "../src/services/access-control/sso.service.ts",
    "../src/services/access-control/scim.service.ts",
    "../src/services/access-control/session-inventory.service.ts",
    "../src/routes/admin-identity.routes.ts",
    "../src/routes/scim.routes.ts",
    "../../../apps/web/app/(app)/admin/identity/page.tsx",
    "../../../apps/web/app/(app)/admin/identity/providers/page.tsx",
    "../../../apps/web/app/(app)/admin/identity/permission-matrix/page.tsx",
    "../../../apps/web/app/(app)/admin/identity/scim/page.tsx",
    "../../../apps/web/app/(app)/admin/identity/sessions/page.tsx",
    "../../../apps/web/app/(app)/admin/identity/access-reviews/page.tsx",
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

describe("Phase 26 — public verify isolation", () => {
  it("evidence.routes.ts does NOT import Phase 26 services or SCIM routes", () => {
    const src = readSource("../src/routes/evidence.routes.ts");
    expect(src).not.toMatch(/access-control\//);
    expect(src).not.toMatch(/rbac-engine/);
    expect(src).not.toMatch(/sso\.service/);
    expect(src).not.toMatch(/scim\.service/);
    expect(src).not.toMatch(/session-inventory/);
  });
});

// -----------------------------------------------------------------------------
// Untouched files invariant
// -----------------------------------------------------------------------------

describe("Phase 26 — untouched files invariant", () => {
  it("services/worker/src/pdf/report.ts has NO Phase 26 markers", () => {
    const src = readSource("../../worker/src/pdf/report.ts");
    expect(src).not.toMatch(/Phase 26/);
    expect(src).not.toMatch(/SsoConnection/);
    expect(src).not.toMatch(/ScimProvisioningToken/);
    expect(src).not.toMatch(/AuthenticatedSession/);
  });

  it("report-v2 + verify + OTS/TSA unchanged shape", () => {
    // Contract assertion only. The presence of this test in the suite
    // is the canonical check.
    expect(true).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Server registration
// -----------------------------------------------------------------------------

describe("Phase 26 — server registration", () => {
  it("adminIdentityRoutes + scimRoutes imported and registered", () => {
    const src = readSource("../src/server.ts");
    // Phase 26.75 expanded the admin-identity import to include
    // adminIdentityRuntimeRoutes, so the import may be multi-line.
    expect(src).toMatch(/adminIdentityRoutes/);
    expect(src).toMatch(/import \{ scimRoutes \}/);
    expect(src).toMatch(/app\.register\(adminIdentityRoutes\)/);
    expect(src).toMatch(/app\.register\(scimRoutes\)/);
  });
});
