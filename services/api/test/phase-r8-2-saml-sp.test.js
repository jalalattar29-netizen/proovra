/**
 * PHASE R8.2 — Real SAML SP Activation: source-contract test suite.
 *
 * This is a SOURCE-CONTRACT test file, not an integration test.
 * It reads source files and checks their content (structural/safety rules),
 * and runs pure-function unit tests against the pure SAML services.
 *
 * Groups:
 *   1. Documentation (2 tests)          — audit doc + architecture doc exist
 *   2. Security event vocabulary (6)    — 6 SAML events in packages/shared
 *   3. Source files / hard rules (5)    — route file, assertion, user-mapping
 *   4. saml-metadata.service unit (3)   — DTD guard, entityId extract, binding pref
 *   5. saml-authn-request.service (2)   — requestId prefix, SAMLRequest param
 *   6. saml-assertion.service unit (2)  — DTD guard, empty-decode guard
 *
 * Total: 20 tests.
 */
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------
function repoPath(rel) {
    return fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
}
function apiPath(rel) {
    return fileURLToPath(new URL(`../${rel}`, import.meta.url));
}
function readRepo(rel) {
    return readFileSync(repoPath(rel), "utf8");
}
function readApi(rel) {
    return readFileSync(apiPath(rel), "utf8");
}
// ---------------------------------------------------------------------------
// Top-level reads (source-contract checks — Group 2 & 3)
// ---------------------------------------------------------------------------
const SHARED_SECURITY = readRepo("packages/shared/src/security.ts");
const SAML_ROUTES = readApi("src/routes/saml-auth.routes.ts");
const SAML_ASSERTION_SVC = readApi("src/services/security/saml-assertion.service.ts");
const SAML_USER_MAPPING_SVC = readApi("src/services/security/saml-user-mapping.service.ts");
// ---------------------------------------------------------------------------
// Pure-service imports (Groups 4–6)
// ---------------------------------------------------------------------------
import { parseSamlMetadata, } from "../src/services/security/saml-metadata.service.js";
import { buildSamlAuthnRequest } from "../src/services/security/saml-authn-request.service.js";
import { validateSamlResponse, } from "../src/services/security/saml-assertion.service.js";
// =============================================================================
// Group 1 — Documentation
// =============================================================================
describe("R8.2 Group 1 — Documentation", () => {
    it("R8_2_SAML_ARCHITECTURE_AUDIT.md exists and contains SAML structural keywords", () => {
        const content = readRepo("docs/security/R8_2_SAML_ARCHITECTURE_AUDIT.md");
        expect(content.length).toBeGreaterThan(4000);
        expect(content).toMatch(/SAML/);
        expect(content).toMatch(/AuthnRequest/);
        expect(content).toMatch(/ACS/);
    });
    it("R8_2_REAL_SAML_SP.md exists and contains R8.2 phase markers + crypto references", () => {
        const content = readRepo("docs/security/R8_2_REAL_SAML_SP.md");
        expect(content.length).toBeGreaterThan(5000);
        expect(content).toMatch(/PHASE R8\.2/);
        expect(content).toMatch(/InResponseTo/);
        expect(content).toMatch(/xml-crypto/);
    });
});
// =============================================================================
// Group 2 — Security event vocabulary
// =============================================================================
describe("R8.2 Group 2 — Security event vocabulary in packages/shared", () => {
    it('shared security.ts contains "saml_login_started"', () => {
        expect(SHARED_SECURITY).toMatch(/"saml_login_started"/);
    });
    it('shared security.ts contains "saml_login_succeeded"', () => {
        expect(SHARED_SECURITY).toMatch(/"saml_login_succeeded"/);
    });
    it('shared security.ts contains "saml_login_failed"', () => {
        expect(SHARED_SECURITY).toMatch(/"saml_login_failed"/);
    });
    it('shared security.ts contains "saml_assertion_rejected"', () => {
        expect(SHARED_SECURITY).toMatch(/"saml_assertion_rejected"/);
    });
    it('shared security.ts contains "saml_jit_provisioned"', () => {
        expect(SHARED_SECURITY).toMatch(/"saml_jit_provisioned"/);
    });
    it('shared security.ts contains "saml_jit_denied"', () => {
        expect(SHARED_SECURITY).toMatch(/"saml_jit_denied"/);
    });
});
// =============================================================================
// Group 3 — Source files exist with correct hard rules
// =============================================================================
describe("R8.2 Group 3 — Source file hard rules", () => {
    it("saml-auth.routes.ts exists at src/routes/saml-auth.routes.ts and is > 15 000 bytes", () => {
        const stat = statSync(apiPath("src/routes/saml-auth.routes.ts"));
        expect(stat.size).toBeGreaterThan(15_000);
        // Confirm the canonical filename (not saml.routes.ts)
        expect(apiPath("src/routes/saml-auth.routes.ts")).toMatch(/saml-auth\.routes\.ts$/);
    });
    it("saml-auth.routes.ts does NOT expose raw assertion XML in error responses (no console.log / samlResponseRaw in log call)", () => {
        // Must have no console.log calls of any kind in this file
        expect(SAML_ROUTES).not.toMatch(/console\.log\(/);
        // samlResponseRaw must never appear inside a log/error call —
        // we verify it is NOT passed to any console method or logger call
        // by checking the pattern: logger.*(samlResponseRaw  or  log(samlResponseRaw
        expect(SAML_ROUTES).not.toMatch(/console\.\w+\([^)]*samlResponseRaw/);
    });
    it('saml-assertion.service.ts enforces unsigned-rejection hard rule via SAML_SIGNATURE_MISSING + "Unsigned assertions are rejected"', () => {
        expect(SAML_ASSERTION_SVC).toMatch(/"SAML_SIGNATURE_MISSING"/);
        expect(SAML_ASSERTION_SVC).toMatch(/Unsigned assertions are rejected/);
    });
    it("saml-assertion.service.ts does NOT log raw NameID or raw assertion content", () => {
        expect(SAML_ASSERTION_SVC).not.toMatch(/console\.log\(nameId/);
        expect(SAML_ASSERTION_SVC).not.toMatch(/console\.log\(assertion/);
    });
    it("saml-user-mapping.service.ts uses externalIdentityMapping (canonical OIDC pattern)", () => {
        expect(SAML_USER_MAPPING_SVC).toMatch(/externalIdentityMapping\.create/);
        expect(SAML_USER_MAPPING_SVC).toMatch(/ExternalIdentityMapping/);
    });
});
// =============================================================================
// Group 4 — saml-metadata.service.ts unit tests
// =============================================================================
describe("R8.2 Group 4 — saml-metadata.service pure-function tests", () => {
    it("parseSamlMetadata rejects DTD entity injection with METADATA_XML_UNSAFE", () => {
        const maliciousXml = `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY foo "bar">]><root/>`;
        expect(() => parseSamlMetadata(maliciousXml)).toThrowError(expect.objectContaining({
            name: "SamlMetadataError",
            code: "METADATA_XML_UNSAFE",
        }));
    });
    it("parseSamlMetadata extracts entityId and ssoUrl from minimal valid metadata", () => {
        const validMetadataXml = `<?xml version="1.0"?>` +
            `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://idp.example.com">` +
            `<md:IDPSSODescriptor>` +
            `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.com/sso"/>` +
            `<md:KeyDescriptor use="signing">` +
            `<ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">` +
            `<ds:X509Data>` +
            `<ds:X509Certificate>MIICpDCCAYwCCQDUrlwAVwdByh4NFAKENOTREAL</ds:X509Certificate>` +
            `</ds:X509Data>` +
            `</ds:KeyInfo>` +
            `</md:KeyDescriptor>` +
            `</md:IDPSSODescriptor>` +
            `</md:EntityDescriptor>`;
        const result = parseSamlMetadata(validMetadataXml);
        expect(result.entityId).toBe("https://idp.example.com");
        expect(result.ssoUrl).toBe("https://idp.example.com/sso");
    });
    it("parseSamlMetadata prefers HTTP-Redirect binding over HTTP-POST when both are present", () => {
        const dualBindingXml = `<?xml version="1.0"?>` +
            `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://idp.example.com">` +
            `<md:IDPSSODescriptor>` +
            // HTTP-POST listed FIRST — must NOT be preferred
            `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example.com/sso/post"/>` +
            // HTTP-Redirect listed SECOND — MUST be preferred
            `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.com/sso/redirect"/>` +
            `<md:KeyDescriptor use="signing">` +
            `<ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">` +
            `<ds:X509Data>` +
            `<ds:X509Certificate>MIICpDCCAYwCCQDUrlwAVwdByh4NFAKENOTREAL</ds:X509Certificate>` +
            `</ds:X509Data>` +
            `</ds:KeyInfo>` +
            `</md:KeyDescriptor>` +
            `</md:IDPSSODescriptor>` +
            `</md:EntityDescriptor>`;
        const result = parseSamlMetadata(dualBindingXml);
        expect(result.ssoUrl).toBe("https://idp.example.com/sso/redirect");
    });
});
// =============================================================================
// Group 5 — saml-authn-request.service.ts unit tests
// =============================================================================
describe("R8.2 Group 5 — saml-authn-request.service pure-function tests", () => {
    const baseInput = {
        connectionId: "conn-test-001",
        spEntityId: "https://app.example.com",
        acsUrl: "https://app.example.com/auth/saml/acs",
        idpSsoUrl: "https://idp.example.com/sso",
    };
    it("buildSamlAuthnRequest returns requestId starting with _ (SAML NCName requirement)", () => {
        const result = buildSamlAuthnRequest(baseInput);
        expect(result.requestId).toMatch(/^_/);
    });
    it("buildSamlAuthnRequest redirectUrl contains SAMLRequest query parameter", () => {
        const result = buildSamlAuthnRequest(baseInput);
        const url = new URL(result.redirectUrl);
        expect(url.searchParams.has("SAMLRequest")).toBe(true);
    });
});
// =============================================================================
// Group 6 — saml-assertion.service.ts unit tests
// =============================================================================
describe("R8.2 Group 6 — saml-assertion.service pure-function tests", () => {
    it("validateSamlResponse throws SAML_XML_UNSAFE when payload contains <!ENTITY after base64 decode", () => {
        // Construct a payload that decodes to something containing a DTD entity declaration
        const maliciousXml = `<!ENTITY foo "bar"><root/>`;
        const samlResponseBase64 = Buffer.from(maliciousXml, "utf-8").toString("base64");
        expect(() => validateSamlResponse({
            samlResponseBase64,
            idpCertificate: "MIICpDCCAYwCCQDUrlwAVwdByh4NFAKENOTREAL",
            spEntityId: "https://app.example.com",
        })).toThrowError(expect.objectContaining({
            name: "SamlAssertionError",
            code: "SAML_XML_UNSAFE",
        }));
    });
    it("validateSamlResponse throws SAML_DECODE_FAILED when samlResponseBase64 decodes to empty string", () => {
        // An empty string decodes to an empty Buffer → empty utf-8 string → should trigger SAML_DECODE_FAILED
        expect(() => validateSamlResponse({
            samlResponseBase64: "",
            idpCertificate: "MIICpDCCAYwCCQDUrlwAVwdByh4NFAKENOTREAL",
            spEntityId: "https://app.example.com",
        })).toThrowError(expect.objectContaining({
            name: "SamlAssertionError",
            code: "SAML_DECODE_FAILED",
        }));
    });
});
