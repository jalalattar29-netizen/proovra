# R8.2.2 — SAML Pilot Readiness & Compliance Closure

**Phase:** R8.2.2  
**Date:** 2026-05-25  
**Status:** Implementation complete — live IdP validation pending  
**Predecessor:** R8.2.1 (SAML Hardening — 6/6 validation passed)

---

## Executive Summary

R8.2.2 closes the SAML compliance gap between the cryptographically correct SP implementation delivered in R8.2 and R8.2.1 and the operational requirements for a real enterprise IdP pilot. This document records what was implemented, what was deliberately deferred, and the conditions that must be met before claiming production readiness with a named IdP.

**Core principle:** This document distinguishes between _code-supported_ (the implementation exists, is tested, and follows the SAML 2.0 specification) and _externally validated_ (a named IdP was used with real credentials and a real login roundtrip was performed end-to-end). No claim of "tested with Okta" or "tested with Entra ID" appears here, because no such test was performed during R8.2.2 implementation.

---

## 1. What R8.2.2 Delivers

### 1.1 Certificate Lifecycle Management

**`saml-cert.service.ts`** — new service implementing:

| Export | Description |
|--------|-------------|
| `parseCertExpiry(base64Cert)` | Parses the X.509 `NotAfter` date from a base64-only DER certificate using Node.js built-in `X509Certificate` (Node 16+). Returns `Date \| null`. Raw cert content is never logged. |
| `getCertExpiryStatus(notAfter, nowMs?)` | Classifies expiry as `"ok" \| "expiring_90d" \| "expiring_60d" \| "expiring_30d" \| "expired"`. Accepts `null` (returns `"ok"` — unknown is treated permissively). |
| `emitCertExpiryWarningIfNeeded(input)` | Checks cert expiry and emits `saml_certificate_expiring` security event + bumps metric counter. Idempotent — safe to call on every test-connection or ingest. |

**Expiry thresholds:**
- `expired` — `NotAfter` is in the past → severity `HIGH`
- `expiring_30d` — ≤ 30 days remaining → severity `HIGH`
- `expiring_60d` — ≤ 60 days remaining → severity `WARNING`
- `expiring_90d` — ≤ 90 days remaining → severity `WARNING`
- `ok` — > 90 days remaining → no event emitted

**Schema fields added:**

```prisma
samlIdpEntityId          String?  @map("saml_idp_entity_id") @db.VarChar(400)
samlCertNotAfter         DateTime? @map("saml_cert_not_after") @db.Timestamptz(6)
samlCertNextNotAfter     DateTime? @map("saml_cert_next_not_after") @db.Timestamptz(6)
```

- `samlIdpEntityId` — the IdP's EntityID from the metadata `EntityDescriptor`. Kept separate from the SP's `samlEntityId`.
- `samlCertNotAfter` — the X.509 `NotAfter` of the primary IdP signing certificate, parsed on metadata ingest.
- `samlCertNextNotAfter` — the `NotAfter` of the rotation (next) certificate, parsed when `PUT /certificate-next` is called.

**Cert expiry metrics added (R8.2.2):**

| Counter | When bumped |
|---------|-------------|
| `saml_cert_expiry_checked_total` | Every call to `emitCertExpiryWarningIfNeeded` |
| `saml_cert_expiring_30d_total` | Cert is expired or expiring within 30 days |
| `saml_cert_expiring_60d_total` | Cert is expiring within 31–60 days |
| `saml_cert_expiring_90d_total` | Cert is expiring within 61–90 days |
| `saml_idp_entity_id_stored_total` | IdP EntityID stored on metadata ingest |

### 1.2 SP Metadata Endpoint Hardening

`GET /v1/auth/saml/metadata/:connectionId` now:

- Reads `samlSignRequests` from the database and reflects it honestly in `AuthnRequestsSigned`.
- `AuthnRequestsSigned="false"` — always false until R8.3 wires SP private key signing.
- `WantAssertionsSigned="true"` — always true; unsigned assertions are always rejected.
- No private key material or internal hostnames in the metadata response.
- `Cache-Control: public, max-age=3600` so IdPs do not hammer the endpoint.

**Honest status:** Request signing is schema-supported (`samlSignRequests` column exists) but the signing code in `buildSamlAuthnRequest` does not yet apply a private key. Setting `samlSignRequests: true` in the database will update the metadata XML honestly but will not make the SP actually sign requests until R8.3 wires the key.

### 1.3 Metadata Ingest Updates

`POST /v1/auth/saml/:connectionId/ingest-metadata` now:

1. Calls `parseCertExpiry(parsed.certificate)` to extract `NotAfter` from the IdP cert.
2. Stores `samlIdpEntityId: parsed.entityId` (the IdP's entity ID, not the SP's).
3. Stores `samlCertNotAfter: certNotAfter` (null if the cert could not be parsed).
4. Calls `emitCertExpiryWarningIfNeeded(...)` immediately after ingest.
5. Returns `certNotAfter` in the response body so the admin UI can show it immediately.
6. Emits `saml_metadata_ingested` security event with `idpEntityId` and `certNotAfter`.

### 1.4 Certificate Rotation Expiry Tracking

**`PUT /certificate-next`** now:
- Calls `parseCertExpiry(cleanedNextCert)` to extract the rotation cert's expiry.
- Stores `samlCertNextNotAfter` alongside `samlCertificateNext`.
- Calls `emitCertExpiryWarningIfNeeded({ isNextCert: true, ... })` so the rotation cert's expiry is also monitored.

**`DELETE /certificate-next` (promote)** now:
- Reads `samlCertNextNotAfter` from the database before promoting.
- Writes `samlCertNotAfter: conn.samlCertNextNotAfter` when promoting next → primary.
- Clears `samlCertNextNotAfter: null` after promotion.
- Result: the primary cert's expiry is always current after a rotation promotion.

### 1.5 Test-Connection: Cert Expiry Check

`POST /v1/auth/saml/:connectionId/test-connection` now includes:

- **Check 5: `certificate_not_expired`** — `ok: false` only when the cert is already expired (not just expiring). An expiring-but-not-yet-expired cert sets `ok: true` but includes a human-readable `detail` string.
- Calls `emitCertExpiryWarningIfNeeded(...)` on every test-connection run (idempotent).

### 1.6 SAML Failure Category Labels

`SAML_FAILURE_CATEGORY_LABELS` (exported from `saml-assertion.service.ts`) maps internal error codes to bounded, operator-safe lowercase_snake_case labels. These labels:

- Are safe to log (no PII, no raw assertion content, no NameIDs).
- Are safe to surface in admin UI error messages.
- Cover 22 error codes including metadata parse failures.

Full mapping:

| Internal code | Operator label |
|---------------|---------------|
| `SAML_DECODE_FAILED` | `invalid_response_encoding` |
| `SAML_XML_UNSAFE` | `unsafe_xml_entity` |
| `SAML_PARSE_FAILED` | `malformed_xml` |
| `SAML_STATUS_NOT_SUCCESS` | `idp_reported_failure` |
| `SAML_SIGNATURE_MISSING` | `unsigned_assertion` |
| `SAML_SIGNATURE_INVALID` | `invalid_signature` |
| `SAML_CONDITIONS_EXPIRED` | `expired_assertion` |
| `SAML_CONDITIONS_NOT_YET_VALID` | `assertion_not_yet_valid` |
| `SAML_AUDIENCE_MISMATCH` | `invalid_audience` |
| `SAML_IN_RESPONSE_TO_MISMATCH` | `relay_state_correlation_failed` |
| `SAML_NAME_ID_MISSING` | `missing_subject_identifier` |
| `SAML_ASSERTION_MISSING` | `missing_assertion` |
| `SAML_EMAIL_MISSING` | `missing_email_attribute` |
| `SAML_EMAIL_DOMAIN_NOT_ALLOWED` | `domain_not_allowed` |
| `SAML_JIT_DISABLED` | `jit_policy_denied` |
| `SAML_CONNECTION_NOT_FOUND` | `connection_not_found` |
| `SAML_CONNECTION_INACTIVE` | `connection_inactive` |
| `METADATA_PARSE_FAILED` | `metadata_parse_failed` |
| `METADATA_MISSING_ENTITY_ID` | `metadata_missing_entity_id` |
| `METADATA_MISSING_SSO_URL` | `metadata_missing_sso_url` |
| `METADATA_MISSING_CERTIFICATE` | `metadata_missing_certificate` |
| `METADATA_XML_UNSAFE` | `metadata_unsafe_xml_entity` |

### 1.7 Admin UI Completeness (R8.2.2)

The SAML SSO admin page at `/security-center/sso` now displays:

| Field | Source | Notes |
|-------|--------|-------|
| SP Metadata URL | `buildSpMetadataUrl` | Already present |
| ACS URL (HTTP-POST Binding) | `buildAcsUrl` | **New** — explicit copy field |
| Request signing status | Honest label | "Unsigned AuthnRequests (signed requests not yet enabled)" |
| SP Entity ID | `samlEntityId` | Already present |
| IdP Entity ID | `samlIdpEntityId` | **New** — from IdP metadata |
| NameID format | `samlNameIdFormat` | **New** — from ingested metadata |
| Cert fingerprint (primary) | `samlCertFingerprint` | Already present |
| Cert expiry | `samlCertNotAfter` | **New** — with coloured expiry label |
| Cert expiry warning banner | Computed | **New** — warn at 30/60/90d |
| SCIM-managed warning | `samlScimManaged` | **New** — explains JIT suppression |
| JIT provisioning status | `jitDefaultRole` + `samlScimManaged` | **New** |
| Ingest result: `certNotAfter` | API response | **New** — shown immediately after ingest |

---

## 2. Security Invariants Preserved

All R8.2 and R8.2.1 invariants are preserved unchanged:

| Invariant | Status |
|-----------|--------|
| Unsigned assertions always rejected | ✅ Unchanged |
| Audience restriction enforced | ✅ Unchanged |
| Issuer/InResponseTo validated | ✅ Unchanged |
| Conditions expiry + clock skew checked | ✅ Unchanged |
| Replay protection (SsoCallbackAttempt) | ✅ Unchanged |
| MFA enforcement after assertion validation | ✅ Unchanged |
| Tenant isolation | ✅ Unchanged |
| No raw assertion content in logs | ✅ Unchanged |
| No PII in security events | ✅ Unchanged |
| No open redirects | ✅ Unchanged |
| Dual-cert rotation window | ✅ Unchanged |
| SCIM-managed JIT suppression | ✅ Unchanged |
| Attribute mapping with 13-alias email resolution | ✅ Unchanged |

---

## 3. What Is NOT Done (Honest Scope Boundaries)

### 3.1 SP Request Signing
Request signing is schema-supported (`samlSignRequests` column) and `AuthnRequestsSigned` in the SP metadata XML reflects the flag honestly. However, `buildSamlAuthnRequest` does not apply an SP private key to sign requests. Signed requests remain "not yet enabled" — deferred to R8.3.

### 3.2 Live IdP Validation
No live IdP was connected during R8.2.2 implementation. The following are confirmed code-supported but NOT externally tested:

- SP-initiated login full roundtrip (browser → SP → IdP → ACS → session cookie)
- Certificate rotation window under live IdP traffic
- SCIM + SAML concurrent provisioning boundary
- Entra ID UPN claim fallback under real assertions
- Google Workspace OID attribute name resolution under real assertions
- Clock skew boundary behaviour with a real IdP's NTP configuration

See `docs/security/R8_2_2_SAML_REAL_IDP_PILOT_CHECKLIST.md` for the per-IdP checklist of items required before claiming production readiness.

### 3.3 IdP-Initiated Login
IdP-initiated login (SP omitted from assertion's InResponseTo) is not implemented. All login flows must be SP-initiated (browser starts at `/v1/auth/saml/:connectionId/login`).

### 3.4 SCIM Directory Sync
SCIM provisioning (`samlScimManaged`) is a flag on `SsoConnection` that controls JIT suppression. The SCIM provisioning protocol itself is not implemented in R8.2.2.

---

## 4. New Security Events

| Event type | When | Severity |
|------------|------|----------|
| `saml_certificate_expiring` | Cert expiry within 90/60/30 days or already expired | `HIGH` (≤30d/expired) / `WARNING` (≤90d) |
| `saml_metadata_ingested` | IdP metadata ingested via admin UI | `INFO` |
| `saml_connection_test_started` | Test-connection invoked by admin | `INFO` |
| `saml_connection_test_succeeded` | All preflight checks passed | `INFO` |
| `saml_connection_test_failed` | One or more preflight checks failed | `WARNING` |

(Events in rows 2–5 were also added in R8.2.1; listed here for completeness.)

---

## 5. New Metric Counters

| Counter | Description |
|---------|-------------|
| `saml_cert_expiry_checked_total` | Every call to `emitCertExpiryWarningIfNeeded` |
| `saml_cert_expiring_30d_total` | Cert expired or expiring ≤30 days |
| `saml_cert_expiring_60d_total` | Cert expiring ≤60 days |
| `saml_cert_expiring_90d_total` | Cert expiring ≤90 days |
| `saml_idp_entity_id_stored_total` | IdP EntityID stored on metadata ingest |

---

## 6. Contract Tests

`services/api/test/phase-r8-2-2-saml-compliance.test.ts` — 19 tests:

| # | Test | What it verifies |
|---|------|-----------------|
| T01 | parseCertExpiry — empty string → null | No throw on empty |
| T02 | parseCertExpiry — non-cert data → null | No throw on garbage |
| T03 | parseCertExpiry — truncated base64 → null | No throw on partial DER |
| T04 | parseCertExpiry — strips whitespace | Whitespace tolerance |
| T05 | parseCertExpiry — returns Date or null | Contract: Date \| null, never throws |
| T06 | getCertExpiryStatus — null → "ok" | Unknown expiry is permissive |
| T07 | getCertExpiryStatus — past date → "expired" | Expired boundary |
| T08 | getCertExpiryStatus — exactly 30 days → "expiring_30d" | 30d boundary |
| T09 | getCertExpiryStatus — 29d 23h → "expiring_30d" | Inside 30d window |
| T10 | getCertExpiryStatus — 31 days → "expiring_60d" | Just outside 30d |
| T11 | getCertExpiryStatus — exactly 60 days → "expiring_60d" | 60d boundary |
| T12 | getCertExpiryStatus — 61 days → "expiring_90d" | Just outside 60d |
| T13 | getCertExpiryStatus — exactly 90 days → "expiring_90d" | 90d boundary |
| T14 | getCertExpiryStatus — 91 days → "ok" | Just outside all windows |
| T15 | getCertExpiryStatus — far future → "ok" | Long-validity cert |
| T16 | emitCertExpiryWarningIfNeeded — expired cert: bumps metric + HIGH event | Emission correctness |
| T17 | emitCertExpiryWarningIfNeeded — 20d cert: HIGH severity | 30d threshold severity |
| T18 | emitCertExpiryWarningIfNeeded — 45d cert: WARNING severity | 60d threshold severity |
| T19 | SAML_FAILURE_CATEGORY_LABELS: all 22 codes present, lowercase_snake_case | Label safety contract |

---

## 7. Files Changed in R8.2.2

| File | Change type |
|------|------------|
| `services/api/prisma/schema.prisma` | Added 3 fields: `samlIdpEntityId`, `samlCertNotAfter`, `samlCertNextNotAfter` |
| `packages/shared-runtime/src/ops/metrics.service.ts` | Added 5 metric counters |
| `services/api/src/services/security/saml-cert.service.ts` | New file — cert lifecycle service |
| `services/api/src/services/security/saml-assertion.service.ts` | Added `SAML_FAILURE_CATEGORY_LABELS` export |
| `services/api/src/routes/saml-auth.routes.ts` | SP metadata hardening, ingest-metadata expiry, cert-next expiry tracking, test-connection expiry check, dynamic-import fix |
| `apps/web/app/(app)/security-center/sso/page.tsx` | R8.2.2 completeness: ACS URL, IdP Entity ID, NameID, cert expiry, SCIM warning, signing status |
| `services/api/test/phase-r8-2-2-saml-compliance.test.ts` | New file — 19 contract tests |
| `docs/security/R8_2_2_SAML_REAL_IDP_PILOT_CHECKLIST.md` | New file — per-IdP pilot checklist |
| `docs/security/R8_2_2_SAML_COMPLIANCE_CLOSURE.md` | This file |

---

## 8. Validation Checklist

The following commands must pass after R8.2.2 implementation:

```bash
pnpm --filter proovra-api prisma generate       # schema regeneration
pnpm --filter proovra-api typecheck              # TypeScript strict
pnpm --filter proovra-api test                   # includes R8.2.2 tests
pnpm --filter proovra-web typecheck              # web strict
pnpm --filter proovra-web build                  # Next.js production build
pnpm --filter proovra-worker typecheck           # worker strict
pnpm --filter proovra-worker test                # worker tests
```

---

## 9. Definition of Done for R8.2.2

| Criterion | Met |
|-----------|-----|
| `saml-cert.service.ts` implements `parseCertExpiry`, `getCertExpiryStatus`, `emitCertExpiryWarningIfNeeded` | ✅ |
| `SAML_FAILURE_CATEGORY_LABELS` exported with 22 safe lowercase codes | ✅ |
| SP metadata `AuthnRequestsSigned` reflects `samlSignRequests` honestly | ✅ |
| `ingest-metadata` stores `samlIdpEntityId` and `samlCertNotAfter` | ✅ |
| `PUT /certificate-next` stores `samlCertNextNotAfter` | ✅ |
| `DELETE /certificate-next` promotes expiry: `samlCertNextNotAfter` → `samlCertNotAfter` | ✅ |
| `test-connection` Check 5 checks cert expiry | ✅ |
| Admin UI shows ACS URL explicitly | ✅ |
| Admin UI shows IdP Entity ID | ✅ |
| Admin UI shows NameID format | ✅ |
| Admin UI shows cert expiry with colour-coded label | ✅ |
| Admin UI shows SCIM-managed JIT suppression warning | ✅ |
| Admin UI shows honest request signing status | ✅ |
| 19 contract tests (R8.2.2) | ✅ |
| `R8_2_2_SAML_REAL_IDP_PILOT_CHECKLIST.md` authored | ✅ |
| `R8_2_2_SAML_COMPLIANCE_CLOSURE.md` authored | ✅ |
| Live IdP validation (Okta, Entra ID, Google, Generic) | ⚠️ **Pending — requires real IdP credentials** |
| SP request signing (R8.3) | ⚠️ Deferred |

---

_End of R8.2.2 compliance closure document._
