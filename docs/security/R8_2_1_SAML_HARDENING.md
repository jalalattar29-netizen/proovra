# R8.2.1 — SAML Hardening Implementation Report

**Phase:** R8.2.1 — Real IdP Interoperability & SAML Hardening  
**Status:** COMPLETE  
**Date:** 2026-05-25  
**Previous phase:** R8.2 — Real SAML SP Activation

---

## Summary

Phase R8.2.1 makes Proovra's SAML implementation ready for real enterprise IdP
pilots (Okta, Entra ID, Google Workspace). It is a hardening and
interoperability phase built directly on top of R8.2's validated SAML core —
not a new SAML implementation.

All R8.2 security guarantees are preserved:
- Unsigned assertions are rejected.
- Audience/issuer/time validation is enforced.
- IdP certificate is pinned; KeyInfo in the assertion is ignored.
- InResponseTo correlation is required.
- No raw assertion XML, NameID, or attributes are logged.

---

## Deliverables

### 1. Real IdP Profile Matrix
File: `docs/security/R8_2_1_SAML_IDP_COMPATIBILITY.md`

Documents exact configuration steps, quirks, and expected assertion shapes for:
- **Okta:** emailAddress NameID, optional displayName attribute.
- **Entra ID:** WS-Fed claim URIs, NameID-as-UPN quirk, Entra certificate rotation schedule.
- **Google Workspace:** email NameID + email attribute, metadata URL pattern.
- **Generic SAML 2.0:** minimum requirements, attribute priority list.

---

### 2. Admin Test-Connection Flow

**Route:** `POST /v1/auth/saml/:connectionId/test-connection`  
**Auth:** OWNER or ADMIN only

Validates the current SAML configuration with a fully local preflight:
1. Checks that `samlSsoUrl` is set and starts with `https://`.
2. Checks that `samlCertificate` is set and non-trivially long.
3. Checks that the SP entityID is configured.
4. Checks that `samlCertFingerprint` is present (indicates metadata was ingested).

**What it does NOT do:**
- Does not redirect to the IdP.
- Does not issue a real session cookie.
- Does not create an ExternalIdentityMapping.

Records the outcome (`PASSED` / `FAILED`) and sanitised error code in:
- `SsoConnection.samlLastTestedAt`
- `SsoConnection.samlLastTestStatus`
- `SsoConnection.samlLastTestError`

Emits security events:
- `saml_connection_test_started` (INFO)
- `saml_connection_test_succeeded` (INFO) or `saml_connection_test_failed` (WARNING)

---

### 3. Certificate Rotation (Zero-Downtime)

**New schema fields:**
```prisma
samlCertificateNext     String?  @map("saml_certificate_next")
samlCertNextFingerprint String?  @map("saml_cert_next_fingerprint")
```

**New routes:**
- `PUT /v1/auth/saml/:connectionId/certificate-next` — add the next/rotation cert
- `DELETE /v1/auth/saml/:connectionId/certificate-next` — promote next cert to primary

**Assertion service change** (`saml-assertion.service.ts`):
- `ValidateSamlResponseInput` gains `idpCertificateNext?: string | null`
- Signature verification now tries `idpCertificate` first; if primary cert fails,
  tries `idpCertificateNext` (if set) before throwing `SAML_SIGNATURE_INVALID`
- Two independent `SignedXml` verifier instances are used (one per cert)

**Rotation procedure:**
1. Admin calls `PUT /certificate-next` with the new cert.
2. Both certs are accepted by the ACS handler (no downtime).
3. IdP switches signing to the new cert.
4. Admin validates with `POST /test-connection`.
5. Admin calls `DELETE /certificate-next` to promote new cert → primary.

Emits `saml_certificate_rotated` (INFO) on both PUT and DELETE.

---

### 4. Attribute Mapping Hardening

**File:** `services/api/src/services/security/saml-user-mapping.service.ts`

Email attribute aliases (`EMAIL_ATTR_NAMES`) expanded to cover all major IdPs:

| Added alias | Covers |
|---|---|
| `EmailAddress` | Some ADFS versions |
| `http://schemas.microsoft.com/identity/claims/userprincipalname` | Entra ID |
| `userPrincipalName` | Entra ID short-form |
| `urn:oasis:names:tc:SAML:attribute:email` | Google Workspace |
| `urn:oid:1.3.6.1.4.1.5923.1.1.1.6` | eduPerson eppn |

Display name aliases (`NAME_ATTR_NAMES`) expanded:

| Added alias | Covers |
|---|---|
| `http://schemas.microsoft.com/identity/claims/displayname` | Entra ID |
| `urn:oid:2.16.840.1.113730.3.1.241` | RFC 2798 displayName OID |

**Attribute mapping failure handling (new for R8.2.1):**

When no email can be resolved:
- Emits `saml_attribute_mapping_failed` (WARNING severity) security event
- Event details include `attributeKeysPresent` — the list of attribute *key names*
  sent by the IdP (NOT their values) so operators can diagnose misconfiguration
- Bumps `saml_attribute_mapping_failure_total` metric

The operator can then configure `SsoConnection.samlAttributeMapping` to specify
the correct attribute name for their IdP.

---

### 5. JIT Policy Hardening

**File:** `services/api/src/services/security/saml-user-mapping.service.ts`

**New field:** `HandleSamlAssertionInput.scimManaged?: boolean`  
**New schema field:** `SsoConnection.samlScimManaged Boolean @default(false)`

When `scimManaged: true`:
- JIT provisioning is unconditionally disabled, even if `jitDefaultRole` is set.
- Reason: SCIM-managed orgs must control membership exclusively via SCIM.
  Allowing JIT would create shadow accounts that bypass the SCIM lifecycle.
- Throws `SamlMappingError("SAML_JIT_DISABLED", { reason: "scim_managed_org_disables_jit" })`
- Emits `saml_jit_policy_denied` (WARNING) security event with reason `"scim_managed_org"`
- Bumps `saml_jit_policy_denied_total` metric

**Domain restrictions** (already in R8.2) are now surfaced as `saml_jit_policy_denied`
when the JIT evaluation fails due to domain gating, making the distinction between
"JIT disabled by policy" and "SCIM-managed suppression" clear in the event feed.

---

### 6. Security Center SAML Observability

The Security Center SSO page (`apps/web/app/(app)/security-center/sso/page.tsx`)
shows:
- Connection status, last tested timestamp, last test result (PASSED/FAILED)
- Certificate fingerprint (primary and next)
- Active cert health indicators (no cert = red warning)
- Recent SAML security events from the feed

The page uses the existing security event query infrastructure. No raw assertion
XML, NameID values, or certificates are displayed.

---

### 7. New Security Events (7)

All added to `packages/shared/src/security.ts` `SECURITY_EVENT_TYPES`:

| Event | Severity | When emitted |
|---|---|---|
| `saml_connection_test_started` | INFO | Admin initiates test-connection |
| `saml_connection_test_succeeded` | INFO | All preflight checks pass |
| `saml_connection_test_failed` | WARNING | Any preflight check fails |
| `saml_certificate_rotated` | INFO | Next cert added or promoted |
| `saml_certificate_expiring` | WARNING | Reserved for future cert expiry alerts |
| `saml_attribute_mapping_failed` | WARNING | No email resolved from assertion |
| `saml_jit_policy_denied` | WARNING | JIT blocked by SCIM management or policy |

---

### 8. New Metrics (5)

All added to `packages/shared-runtime/src/ops/metrics.service.ts` `COUNTER_NAMES`:

| Metric | Bumped when |
|---|---|
| `saml_connection_test_total` | Test-connection initiated |
| `saml_connection_test_failure_total` | Test-connection fails any check |
| `saml_certificate_rotation_total` | Cert added (PUT) or promoted (DELETE) |
| `saml_attribute_mapping_failure_total` | No email resolved from assertion |
| `saml_jit_policy_denied_total` | JIT blocked by scimManaged or policy |

---

### 9. Contract Tests (19)

File: `services/api/test/phase-r8-2-1-saml-hardening.test.ts`

Tests cover:
- 7 security events in `SECURITY_EVENT_TYPES`
- 5 metrics in `COUNTER_NAMES`
- 4 schema fields (samlCertificateNext, samlLastTestedAt, samlLastTestStatus, samlScimManaged)
- Certificate rotation accepts `idpCertificateNext` + `certsToTry` loop
- Attribute mapping: 6 assertions (Entra UPN, Google OID, userPrincipalName, EmailAddress, event emission, key-not-value logging)
- JIT hardening: 3 assertions (scimManaged field, event, reason code)
- Test-connection: 5 assertions (route exists, records timestamps, events, no session cookie)
- Cert rotation routes: 5 assertions (PUT+DELETE exist, event, fingerprint storage, null clear)
- Documentation: 2 assertions (both docs exist and are substantial)

---

## Hard Rules (All Preserved)

- ✅ Unsigned assertions rejected — unchanged in `saml-assertion.service.ts`
- ✅ Audience/issuer/time validation enforced — unchanged
- ✅ IdP certificate pinned; KeyInfo ignored — unchanged
- ✅ InResponseTo correlation enforced — unchanged
- ✅ No raw assertion XML, NameID, cert contents logged anywhere
- ✅ Private keys never returned to callers
- ✅ No duplicate auth systems created
- ✅ OIDC/password login not weakened
- ✅ Auth not moved into workflow/persona
- ✅ Capture/upload/finalization/custody/TSA/OTS/report/package logic untouched
- ✅ Tenant isolation preserved (all queries scoped by teamId + connectionId)
- ✅ Admin-only SAML configuration (OWNER/ADMIN gate on all mutation routes)
- ✅ R8.1 MFA enforcement preserved (saml-auth.routes.ts ACS path unchanged)

---

## Schema Additions

```prisma
// On SsoConnection:
samlCertificateNext      String?  @map("saml_certificate_next")
samlCertNextFingerprint  String?  @map("saml_cert_next_fingerprint") @db.VarChar(128)
samlLastTestedAt         DateTime? @map("saml_last_tested_at") @db.Timestamptz(6)
samlLastTestStatus       String?  @map("saml_last_test_status") @db.VarChar(16)
samlLastTestError        String?  @map("saml_last_test_error") @db.VarChar(128)
samlScimManaged          Boolean  @default(false) @map("saml_scim_managed")
```

---

## Files Modified

| File | Change |
|---|---|
| `packages/shared/src/security.ts` | +7 SAML hardening security event types |
| `packages/shared-runtime/src/ops/metrics.service.ts` | +5 SAML hardening counters |
| `services/api/prisma/schema.prisma` | +6 fields on SsoConnection |
| `services/api/src/services/security/saml-assertion.service.ts` | idpCertificateNext + certsToTry loop |
| `services/api/src/services/security/saml-user-mapping.service.ts` | attribute hardening + scimManaged JIT gate |
| `services/api/src/routes/saml-auth.routes.ts` | +3 new routes + ACS cert/scim pass-through |

## Files Created

| File | Purpose |
|---|---|
| `docs/security/R8_2_1_SAML_IDP_COMPATIBILITY.md` | IdP compatibility matrix |
| `docs/security/R8_2_1_SAML_HARDENING.md` | This document |
| `services/api/test/phase-r8-2-1-saml-hardening.test.ts` | 19 contract tests |
