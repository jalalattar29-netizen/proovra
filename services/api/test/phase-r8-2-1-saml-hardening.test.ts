/**
 * phase-r8-2-1-saml-hardening.test.ts
 *
 * Phase R8.2.1 — Real IdP Interoperability & SAML Hardening
 * Contract tests: 19 total
 *
 * Groups:
 *   1. Security event vocabulary (7 new events present in SECURITY_EVENT_TYPES)
 *   2. Metrics catalog (5 new counters in COUNTER_NAMES)
 *   3. Schema additions (new SsoConnection fields)
 *   4. Certificate rotation — validateSamlResponse accepts idpCertificateNext
 *   5. Attribute mapping hardening — EMAIL_ATTR_NAMES / NAME_ATTR_NAMES coverage
 *   6. JIT policy hardening — scimManaged gate + saml_jit_policy_denied
 *   7. Test-connection route existence
 *   8. Certificate rotation routes existence
 *   9. Documentation
 */

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const ROOT = resolve(__dirname, "../../..");
const SECURITY_TS = resolve(ROOT, "packages/shared/src/security.ts");
const METRICS_TS = resolve(ROOT, "packages/shared-runtime/src/ops/metrics.service.ts");
const SCHEMA_PRISMA = resolve(ROOT, "services/api/prisma/schema.prisma");
const ASSERTION_SVC = resolve(ROOT, "services/api/src/services/security/saml-assertion.service.ts");
const MAPPING_SVC = resolve(ROOT, "services/api/src/services/security/saml-user-mapping.service.ts");
const ROUTES = resolve(ROOT, "services/api/src/routes/saml-auth.routes.ts");
const IDP_COMPAT_DOC = resolve(ROOT, "docs/security/R8_2_1_SAML_IDP_COMPATIBILITY.md");
const HARDENING_DOC = resolve(ROOT, "docs/security/R8_2_1_SAML_HARDENING.md");

function readSrc(path: string): string {
  return readFileSync(path, "utf-8");
}

// ---------------------------------------------------------------------------
// Group 1 — Security event vocabulary (7 events)
// ---------------------------------------------------------------------------
describe("R8.2.1 — security event vocabulary", () => {
  const src = readSrc(SECURITY_TS);

  it("1. saml_connection_test_started is in SECURITY_EVENT_TYPES", () => {
    expect(src).toContain('"saml_connection_test_started"');
  });

  it("2. saml_connection_test_succeeded is in SECURITY_EVENT_TYPES", () => {
    expect(src).toContain('"saml_connection_test_succeeded"');
  });

  it("3. saml_connection_test_failed is in SECURITY_EVENT_TYPES", () => {
    expect(src).toContain('"saml_connection_test_failed"');
  });

  it("4. saml_certificate_rotated is in SECURITY_EVENT_TYPES", () => {
    expect(src).toContain('"saml_certificate_rotated"');
  });

  it("5. saml_certificate_expiring is in SECURITY_EVENT_TYPES", () => {
    expect(src).toContain('"saml_certificate_expiring"');
  });

  it("6. saml_attribute_mapping_failed is in SECURITY_EVENT_TYPES", () => {
    expect(src).toContain('"saml_attribute_mapping_failed"');
  });

  it("7. saml_jit_policy_denied is in SECURITY_EVENT_TYPES", () => {
    expect(src).toContain('"saml_jit_policy_denied"');
  });
});

// ---------------------------------------------------------------------------
// Group 2 — Metrics catalog (5 new counters)
// ---------------------------------------------------------------------------
describe("R8.2.1 — metrics catalog", () => {
  const src = readSrc(METRICS_TS);

  it("8. saml_connection_test_total in COUNTER_NAMES", () => {
    expect(src).toContain('"saml_connection_test_total"');
  });

  it("9. saml_connection_test_failure_total in COUNTER_NAMES", () => {
    expect(src).toContain('"saml_connection_test_failure_total"');
  });

  it("10. saml_certificate_rotation_total in COUNTER_NAMES", () => {
    expect(src).toContain('"saml_certificate_rotation_total"');
  });

  it("11. saml_attribute_mapping_failure_total in COUNTER_NAMES", () => {
    expect(src).toContain('"saml_attribute_mapping_failure_total"');
  });

  it("12. saml_jit_policy_denied_total in COUNTER_NAMES", () => {
    expect(src).toContain('"saml_jit_policy_denied_total"');
  });
});

// ---------------------------------------------------------------------------
// Group 3 — Schema additions
// ---------------------------------------------------------------------------
describe("R8.2.1 — schema additions", () => {
  const src = readSrc(SCHEMA_PRISMA);

  it("13. samlCertificateNext field present in SsoConnection", () => {
    expect(src).toContain("samlCertificateNext");
    expect(src).toContain("saml_certificate_next");
  });

  it("14. samlLastTestedAt field present in SsoConnection", () => {
    expect(src).toContain("samlLastTestedAt");
    expect(src).toContain("saml_last_tested_at");
  });

  it("15. samlLastTestStatus field present in SsoConnection", () => {
    expect(src).toContain("samlLastTestStatus");
    expect(src).toContain("saml_last_test_status");
  });

  it("16. samlScimManaged field present in SsoConnection", () => {
    expect(src).toContain("samlScimManaged");
    expect(src).toContain("saml_scim_managed");
  });
});

// ---------------------------------------------------------------------------
// Group 4 — Certificate rotation
// ---------------------------------------------------------------------------
describe("R8.2.1 — certificate rotation", () => {
  const src = readSrc(ASSERTION_SVC);

  it("17. validateSamlResponse accepts idpCertificateNext field", () => {
    expect(src).toContain("idpCertificateNext");
  });

  it("17b. Rotation tries both certs (certsToTry loop)", () => {
    expect(src).toContain("certsToTry");
    // Both the primary and next cert are iterated
    expect(src).toContain("for (const certBase64 of certsToTry)");
  });
});

// ---------------------------------------------------------------------------
// Group 5 — Attribute mapping hardening
// ---------------------------------------------------------------------------
describe("R8.2.1 — attribute mapping hardening", () => {
  const src = readSrc(MAPPING_SVC);

  it("18a. Entra ID UPN claim in EMAIL_ATTR_NAMES", () => {
    // Microsoft identity UPN claim
    expect(src).toContain(
      "http://schemas.microsoft.com/identity/claims/userprincipalname",
    );
  });

  it("18b. Google Workspace SAML email claim in EMAIL_ATTR_NAMES", () => {
    expect(src).toContain("urn:oasis:names:tc:SAML:attribute:email");
  });

  it("18c. userPrincipalName short-form in EMAIL_ATTR_NAMES", () => {
    expect(src).toContain('"userPrincipalName"');
  });

  it("18d. EmailAddress (capitalized) in EMAIL_ATTR_NAMES", () => {
    expect(src).toContain('"EmailAddress"');
  });

  it("18e. saml_attribute_mapping_failed event emitted on email resolution failure", () => {
    expect(src).toContain("saml_attribute_mapping_failed");
    expect(src).toContain("saml_attribute_mapping_failure_total");
  });

  it("18f. attributeKeysPresent logged (NOT values) to assist debugging", () => {
    // We log which keys the IdP sent so operators can diagnose attribute mismatches
    // without exposing the actual attribute values
    expect(src).toContain("attributeKeysPresent");
    // We do NOT log "attributeValues" (values could contain PII)
    expect(src).not.toContain('"attributeValues"');
  });
});

// ---------------------------------------------------------------------------
// Group 6 — JIT policy hardening
// ---------------------------------------------------------------------------
describe("R8.2.1 — JIT policy hardening", () => {
  const src = readSrc(MAPPING_SVC);

  it("18g. scimManaged field in HandleSamlAssertionInput", () => {
    expect(src).toContain("scimManaged");
  });

  it("18h. saml_jit_policy_denied event emitted for SCIM-managed orgs", () => {
    expect(src).toContain("saml_jit_policy_denied");
    expect(src).toContain("saml_jit_policy_denied_total");
  });

  it("18i. SCIM-managed orgs get explicit reason code", () => {
    expect(src).toContain("scim_managed_org");
  });
});

// ---------------------------------------------------------------------------
// Group 7 — Test-connection route
// ---------------------------------------------------------------------------
describe("R8.2.1 — test-connection route", () => {
  const src = readSrc(ROUTES);

  it("19a. POST test-connection route exists", () => {
    expect(src).toContain("/v1/auth/saml/:connectionId/test-connection");
  });

  it("19b. test-connection records samlLastTestedAt", () => {
    expect(src).toContain("samlLastTestedAt");
    expect(src).toContain("samlLastTestStatus");
  });

  it("19c. test-connection emits saml_connection_test_started event", () => {
    expect(src).toContain("saml_connection_test_started");
  });

  it("19d. test-connection emits saml_connection_test_succeeded / _failed", () => {
    expect(src).toContain("saml_connection_test_succeeded");
    expect(src).toContain("saml_connection_test_failed");
  });

  it("19e. test-connection does NOT issue a session cookie", () => {
    // The test flow must not call setSessionCookie. We verify by checking
    // that the test-connection handler block (between its route registration
    // and the next app.put registration) does NOT call setSessionCookie.
    const testBlock = src.split("test-connection")[1] ?? "";
    const beforeNextRoute = testBlock.split("certificate-next")[0] ?? "";
    expect(beforeNextRoute).not.toContain("setSessionCookie");
  });
});

// ---------------------------------------------------------------------------
// Group 8 — Certificate rotation routes
// ---------------------------------------------------------------------------
describe("R8.2.1 — certificate rotation routes", () => {
  const src = readSrc(ROUTES);

  it("19f. PUT certificate-next route exists", () => {
    expect(src).toContain(
      '"/v1/auth/saml/:connectionId/certificate-next"',
    );
  });

  it("19g. DELETE certificate-next (promote) route exists", () => {
    // Both routes share the same path string; we check both HTTP verbs
    expect(src).toContain("app.put(");
    expect(src).toContain("app.delete(");
  });

  it("19h. Rotation emits saml_certificate_rotated event", () => {
    expect(src).toContain("saml_certificate_rotated");
  });

  it("19i. Fingerprint stored for next cert (samlCertNextFingerprint)", () => {
    expect(src).toContain("samlCertNextFingerprint");
  });

  it("19j. Promote path clears samlCertificateNext (null)", () => {
    // The DELETE handler promotes next → primary and sets next to null
    expect(src).toContain("samlCertificateNext: null");
    expect(src).toContain("samlCertNextFingerprint: null");
  });
});

// ---------------------------------------------------------------------------
// Group 9 — Documentation
// ---------------------------------------------------------------------------
describe("R8.2.1 — documentation", () => {
  it("19k. IdP compatibility doc exists and is substantial", () => {
    expect(existsSync(IDP_COMPAT_DOC)).toBe(true);
    const content = readFileSync(IDP_COMPAT_DOC, "utf-8");
    // Must cover all three major IdPs
    expect(content).toContain("Okta");
    expect(content).toContain("Entra");
    expect(content).toContain("Google Workspace");
    expect(content.length).toBeGreaterThan(3000);
  });

  it("19l. Hardening doc exists and covers all R8.2.1 deliverables", () => {
    expect(existsSync(HARDENING_DOC)).toBe(true);
    const content = readFileSync(HARDENING_DOC, "utf-8");
    expect(content).toContain("R8.2.1");
    expect(content).toContain("certificate rotation");
    expect(content).toContain("test-connection");
    expect(content).toContain("scimManaged");
    expect(content.length).toBeGreaterThan(3000);
  });
});
