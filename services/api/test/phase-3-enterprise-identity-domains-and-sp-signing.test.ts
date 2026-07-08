/**
 * PHASE 3 — Enterprise Identity: SAML SP AuthnRequest signing +
 * DNS-verified organization domain ownership + SSO login enforcement.
 *
 * SOURCE-CONTRACT + pure-function test suite (no live DB), mirroring the
 * phase-r8-2-saml-sp.test.ts convention.
 *
 * Groups:
 *   1. SP AuthnRequest signing (pure)        — signed URL shape + verifiable sig
 *   2. SP metadata AuthnRequestsSigned flag   — honest true/false + KeyDescriptor
 *   3. Domain service (pure)                  — normalize / email / DNS TXT
 *   4. isEmailDomainVerifiedForOrg (contract) — verified-only source rules
 *   5. Org-audit catalog                      — DOMAIN_ADDED/VERIFIED/REMOVED
 *   6. Step-up purposes                       — ORG_DOMAIN_VERIFY/REMOVE
 *   7. Domain routes hard rules (contract)    — gate + step-up + audit + register
 *   8. SSO JIT lands in ORGANIZATION (contract) — enforcement point wired
 *   9. Migration + schema (contract)          — additive table + columns
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  generateKeyPairSync,
  createVerify,
} from "node:crypto";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------
function repoPath(rel: string): string {
  return fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
}
function apiPath(rel: string): string {
  return fileURLToPath(new URL(`../${rel}`, import.meta.url));
}
function readApi(rel: string): string {
  return readFileSync(apiPath(rel), "utf8");
}
function readRepo(rel: string): string {
  return readFileSync(repoPath(rel), "utf8");
}

// ---------------------------------------------------------------------------
// Pure-service imports
// ---------------------------------------------------------------------------
import { buildSamlAuthnRequest } from "../src/services/security/saml-authn-request.service.js";
import {
  normalizeDomain,
  domainFromEmail,
  generateVerificationToken,
  checkDomainDnsTxt,
  DOMAIN_VERIFY_DNS_PREFIX,
  DOMAIN_VERIFY_TXT_PREFIX,
} from "../src/services/organization/organization-domain.service.js";
import { ORG_AUDIT_EVENT_TYPES } from "../src/services/organization/org-audit.service.js";
import { STEP_UP_PURPOSES } from "@proovra/shared";

const SAML_ROUTES = readApi("src/routes/saml-auth.routes.ts");
const AUTHN_REQ_SVC = readApi(
  "src/services/security/saml-authn-request.service.ts",
);
const DOMAIN_ROUTES = readApi("src/routes/organization-domains.routes.ts");
const DOMAIN_SVC = readApi(
  "src/services/organization/organization-domain.service.ts",
);
const LOGIN_POLICY_SVC = readApi(
  "src/services/access-control/sso-login-policy.service.ts",
);
const SSO_SERVICE = readApi("src/services/access-control/sso.service.ts");
const SERVER = readApi("src/server.ts");
const SCHEMA = readApi("prisma/schema.prisma");

// =============================================================================
// Group 1 — SP AuthnRequest signing (pure)
// =============================================================================
describe("Phase 3 Group 1 — SAML SP AuthnRequest signing", () => {
  const base = {
    connectionId: "conn-1",
    spEntityId: "https://app.example.com",
    acsUrl: "https://app.example.com/auth/saml/acs",
    idpSsoUrl: "https://idp.example.com/sso",
  };

  it("leaves the request UNSIGNED when no SP private key is provided", () => {
    const r = buildSamlAuthnRequest(base);
    expect(r.signed).toBe(false);
    const url = new URL(r.redirectUrl);
    expect(url.searchParams.has("Signature")).toBe(false);
    expect(url.searchParams.has("SigAlg")).toBe(false);
  });

  it("signs the query string and emits SigAlg + Signature when keyed", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const r = buildSamlAuthnRequest({ ...base, spPrivateKeyPem: pem });
    expect(r.signed).toBe(true);
    const url = new URL(r.redirectUrl);
    expect(url.searchParams.get("SigAlg")).toBe(
      "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    );
    expect(url.searchParams.get("Signature")).toBeTruthy();
  });

  it("produces a signature verifiable with the matching public key (HTTP-Redirect binding octet string)", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const r = buildSamlAuthnRequest({ ...base, spPrivateKeyPem: pem });

    // Reconstruct the exact signing input from the RAW (encoded) query params,
    // per SAML 2.0 Bindings §3.4.4.1 ordering: SAMLRequest, RelayState, SigAlg.
    const q = r.redirectUrl.split("?")[1]!;
    const parts = new Map<string, string>();
    for (const kv of q.split("&")) {
      const idx = kv.indexOf("=");
      parts.set(kv.slice(0, idx), kv.slice(idx + 1));
    }
    const signingInput = `SAMLRequest=${parts.get("SAMLRequest")}&RelayState=${parts.get("RelayState")}&SigAlg=${parts.get("SigAlg")}`;
    const signatureB64 = decodeURIComponent(parts.get("Signature")!);

    const v = createVerify("RSA-SHA256");
    v.update(signingInput, "utf-8");
    expect(v.verify(publicKey, signatureB64, "base64")).toBe(true);
  });

  it("authn-request service imports node:crypto createSign for signing", () => {
    expect(AUTHN_REQ_SVC).toMatch(/createSign/);
    expect(AUTHN_REQ_SVC).toMatch(/rsa-sha256/);
  });
});

// =============================================================================
// Group 2 — SP metadata honest AuthnRequestsSigned flag
// =============================================================================
describe("Phase 3 Group 2 — SP metadata reflects real signing capability", () => {
  it("metadata handler advertises AuthnRequestsSigned=true only when signing AND key material available", () => {
    // The flag is derived from samlSignRequests && signingKeyAvailable — not a
    // bare stored flag.
    expect(SAML_ROUTES).toMatch(/signingKeyAvailable/);
    expect(SAML_ROUTES).toMatch(
      /conn\.samlSignRequests && signingKeyAvailable/,
    );
  });

  it("metadata handler emits a signing KeyDescriptor when SP cert is configured", () => {
    expect(SAML_ROUTES).toMatch(/KeyDescriptor use="signing"/);
    expect(SAML_ROUTES).toMatch(/samlSpCertificate/);
  });

  it("login handler resolves the SP signing key and passes it to the builder", () => {
    expect(SAML_ROUTES).toMatch(/resolveSpSigningKey/);
    expect(SAML_ROUTES).toMatch(/spPrivateKeyPem/);
  });
});

// =============================================================================
// Group 3 — Domain service pure functions
// =============================================================================
describe("Phase 3 Group 3 — organization-domain.service pure functions", () => {
  it("normalizeDomain strips scheme, @, path, port, and lowercases", () => {
    expect(normalizeDomain("Acme.COM")).toBe("acme.com");
    expect(normalizeDomain("@acme.com")).toBe("acme.com");
    expect(normalizeDomain("https://acme.com/path")).toBe("acme.com");
    expect(normalizeDomain("acme.com:443")).toBe("acme.com");
    expect(normalizeDomain("sub.acme.co.uk")).toBe("sub.acme.co.uk");
  });

  it("normalizeDomain rejects single-label and empty inputs", () => {
    expect(normalizeDomain("localhost")).toBeNull();
    expect(normalizeDomain("")).toBeNull();
    expect(normalizeDomain("   ")).toBeNull();
  });

  it("domainFromEmail extracts the lowercased domain", () => {
    expect(domainFromEmail("Alice@Acme.com")).toBe("acme.com");
    expect(domainFromEmail("no-at-sign")).toBeNull();
  });

  it("generateVerificationToken returns a non-trivial url-safe token", () => {
    const t = generateVerificationToken();
    expect(t.length).toBeGreaterThan(20);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("checkDomainDnsTxt returns true when a TXT record contains the prefixed token", async () => {
    const token = "TESTTOKEN123";
    const resolver = async (host: string) => {
      expect(host).toBe(`${DOMAIN_VERIFY_DNS_PREFIX}.acme.com`);
      return [[`${DOMAIN_VERIFY_TXT_PREFIX}${token}`]];
    };
    expect(await checkDomainDnsTxt("acme.com", token, resolver)).toBe(true);
  });

  it("checkDomainDnsTxt accepts the bare token too (providers that strip prefix)", async () => {
    const token = "BARE-TOKEN";
    const resolver = async () => [[token]];
    expect(await checkDomainDnsTxt("acme.com", token, resolver)).toBe(true);
  });

  it("checkDomainDnsTxt is failure-closed on resolver error / missing token", async () => {
    const throwing = async () => {
      throw new Error("NXDOMAIN");
    };
    expect(await checkDomainDnsTxt("acme.com", "T", throwing)).toBe(false);
    const missing = async () => [["proovra-domain-verify=WRONG"]];
    expect(await checkDomainDnsTxt("acme.com", "RIGHT", missing)).toBe(false);
  });
});

// =============================================================================
// Group 4 — isEmailDomainVerifiedForOrg source contract
// =============================================================================
describe("Phase 3 Group 4 — isEmailDomainVerifiedForOrg", () => {
  it("queries OrganizationDomain filtered to verifiedAt not-null", () => {
    expect(DOMAIN_SVC).toMatch(/organizationDomain\.findFirst/);
    expect(DOMAIN_SVC).toMatch(/verifiedAt:\s*\{\s*not:\s*null\s*\}/);
  });

  it("exports isEmailDomainVerifiedForOrg for the SSO enforcement path", () => {
    expect(DOMAIN_SVC).toMatch(/export async function isEmailDomainVerifiedForOrg/);
  });
});

// =============================================================================
// Group 5 — Org-audit catalog
// =============================================================================
describe("Phase 3 Group 5 — org-audit domain events", () => {
  it("ORG_AUDIT_EVENT_TYPES includes the three domain lifecycle events", () => {
    expect(ORG_AUDIT_EVENT_TYPES).toContain("DOMAIN_ADDED");
    expect(ORG_AUDIT_EVENT_TYPES).toContain("DOMAIN_VERIFIED");
    expect(ORG_AUDIT_EVENT_TYPES).toContain("DOMAIN_REMOVED");
  });
});

// =============================================================================
// Group 6 — Step-up purposes
// =============================================================================
describe("Phase 3 Group 6 — domain step-up purposes", () => {
  it("STEP_UP_PURPOSES includes ORG_DOMAIN_VERIFY and ORG_DOMAIN_REMOVE", () => {
    expect(STEP_UP_PURPOSES).toContain("ORG_DOMAIN_VERIFY");
    expect(STEP_UP_PURPOSES).toContain("ORG_DOMAIN_REMOVE");
  });
});

// =============================================================================
// Group 7 — Domain routes hard rules
// =============================================================================
describe("Phase 3 Group 7 — organization-domains.routes hard rules", () => {
  it("every mutation checks org admin access (ORG_ADMIN / ORG_SECURITY_ADMIN)", () => {
    expect(DOMAIN_ROUTES).toMatch(/checkOrgAccess/);
    expect(DOMAIN_ROUTES).toMatch(/ORG_SECURITY_ADMIN/);
  });

  it("every endpoint applies the org enterprise feature gate", () => {
    expect(DOMAIN_ROUTES).toMatch(/resolveOrgEnterpriseFeatureGate/);
    expect(DOMAIN_ROUTES).toMatch(/"ssoScim"/);
  });

  it("verify + delete require step-up", () => {
    expect(DOMAIN_ROUTES).toMatch(/ORG_DOMAIN_VERIFY/);
    expect(DOMAIN_ROUTES).toMatch(/ORG_DOMAIN_REMOVE/);
    expect(DOMAIN_ROUTES).toMatch(/requireStepUpForSensitiveAction/);
  });

  it("each mutation emits an org audit event inside a transaction", () => {
    expect(DOMAIN_ROUTES).toMatch(/emitOrgAuditEvent/);
    expect(DOMAIN_ROUTES).toMatch(/DOMAIN_ADDED/);
    expect(DOMAIN_ROUTES).toMatch(/DOMAIN_VERIFIED/);
    expect(DOMAIN_ROUTES).toMatch(/DOMAIN_REMOVED/);
    expect(DOMAIN_ROUTES).toMatch(/prisma\.\$transaction/);
  });

  it("the verification token is never written to audit metadata", () => {
    // metadata objects only carry { domain: ... } — never the token.
    expect(DOMAIN_ROUTES).not.toMatch(/metadata:\s*\{[^}]*verificationToken/);
    expect(DOMAIN_ROUTES).not.toMatch(/metadata:\s*\{[^}]*token/);
  });

  it("routes are registered in server.ts near the org routes", () => {
    expect(SERVER).toMatch(/organizationDomainsRoutes/);
  });
});

// =============================================================================
// Group 8 — SSO JIT lands in ORGANIZATION, not PERSONAL + login enforcement
// =============================================================================
describe("Phase 3 Group 8 — SSO login enforcement point", () => {
  it("login-policy service rejects PERSONAL workspaces (isPersonal)", () => {
    expect(LOGIN_POLICY_SVC).toMatch(/isPersonal/);
    expect(LOGIN_POLICY_SVC).toMatch(/sso_workspace_personal/);
  });

  it("login-policy service enforces enterprise-only via the ssoScim gate", () => {
    expect(LOGIN_POLICY_SVC).toMatch(/resolveTeamEnterpriseFeatureGate/);
    expect(LOGIN_POLICY_SVC).toMatch(/sso_not_enterprise/);
  });

  it("login-policy service layers verified-domain enforcement on top", () => {
    expect(LOGIN_POLICY_SVC).toMatch(/isEmailDomainVerifiedForOrg/);
    expect(LOGIN_POLICY_SVC).toMatch(/restrictToVerifiedDomains/);
    expect(LOGIN_POLICY_SVC).toMatch(/sso_domain_not_verified/);
  });

  it("SAML ACS handler runs the enforcement point before minting a session", () => {
    expect(SAML_ROUTES).toMatch(/enforceSsoLoginPolicy/);
    expect(SAML_ROUTES).toMatch(/restrictToVerifiedDomains/);
  });

  it("OIDC callback runs the enforcement point before find-or-JIT", () => {
    expect(SSO_SERVICE).toMatch(/enforceSsoLoginPolicy/);
    expect(SSO_SERVICE).toMatch(/SSO_WORKSPACE_PERSONAL/);
    expect(SSO_SERVICE).toMatch(/SSO_NOT_ENTERPRISE/);
    expect(SSO_SERVICE).toMatch(/SSO_DOMAIN_NOT_VERIFIED/);
  });
});

// =============================================================================
// Group 9 — Migration + schema additive contract
// =============================================================================
describe("Phase 3 Group 9 — additive migration + schema", () => {
  const MIGRATION = readApi(
    "prisma/migrations/20270910000000_phase_3_enterprise_identity_domains_and_sp_signing/migration.sql",
  );

  it("migration creates organization_domains and is additive only", () => {
    expect(MIGRATION).toMatch(/CREATE TABLE "organization_domains"/);
    expect(MIGRATION).toMatch(/ADD COLUMN "saml_sp_private_key"/);
    expect(MIGRATION).toMatch(/ADD COLUMN "restrict_to_verified_domains"/);
    // No destructive statements.
    expect(MIGRATION).not.toMatch(/DROP TABLE/);
    expect(MIGRATION).not.toMatch(/DROP COLUMN/);
  });

  it("schema declares the OrganizationDomain model + unique (org, domain)", () => {
    expect(SCHEMA).toMatch(/model OrganizationDomain/);
    expect(SCHEMA).toMatch(/organization_domains_org_domain_uniq/);
  });

  it("schema adds SP signing + restrict-to-verified fields on SsoConnection", () => {
    expect(SCHEMA).toMatch(/samlSpPrivateKey\s+String\?/);
    expect(SCHEMA).toMatch(/restrictToVerifiedDomains\s+Boolean/);
  });
});
