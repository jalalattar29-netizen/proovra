# PHASE R8.2 — Real SAML Service Provider Activation

**Status:** Implemented  
**Date:** 2026-05-25  
**Author:** Platform Security Engineering  
**Classification:** Internal — Security Architecture

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Security Controls](#security-controls)
4. [Implementation Details](#implementation-details)
5. [MFA Integration](#mfa-integration)
6. [Testing](#testing)
7. [Known Limitations](#known-limitations)
8. [Deployment Checklist](#deployment-checklist)

---

## Overview

PHASE R8.2 delivers a production-grade SAML 2.0 Service Provider (SP) implementation for Digital Witness. Prior phases established the foundational SSO plumbing via OIDC; this phase extends enterprise identity federation to cover organizations that rely exclusively on SAML 2.0-compliant Identity Providers (IdPs) such as Okta, Azure AD (Entra ID), PingFederate, ADFS, and OneLogin.

The implementation is strictly additive. No existing routes in `sso-auth.routes.ts` or `auth.routes.ts` were modified. All SAML-specific routes are registered in the new `saml-auth.routes.ts` module, which is mounted independently. The feature is gated by the `SAML_ENABLED` environment variable (default: enabled when the variable is absent or set to `"true"`).

SAML support in this phase covers the Web Browser SSO Profile using:

- **HTTP-Redirect binding** for `AuthnRequest` initiation (SP → IdP)
- **HTTP-POST binding** for the Assertion Consumer Service / ACS (IdP → SP)

Metadata exchange (SP metadata publication and IdP metadata ingestion) is also included, enabling zero-touch federation configuration for administrators.

---

## Architecture

### Binding Model

```
Browser                   SP (Digital Witness)               IdP
  │                              │                             │
  │── GET /saml/:id/login ──────>│                             │
  │                              │  Build AuthnRequest         │
  │                              │  Deflate + Base64 encode    │
  │                              │  Sign (if samlSignRequests) │
  │<── 302 Redirect (HTTP-Redirect binding) ─────────────────>│
  │                              │                             │
  │──────────────────────────────────── POST to ACS ─────────>│
  │                                                            │
  │<── POST /saml/acs (HTTP-POST binding, SAMLResponse) ──────│
  │                              │                             │
  │── POST /saml/acs ───────────>│                             │
  │                              │  Validate signature         │
  │                              │  Validate InResponseTo      │
  │                              │  Validate Audience          │
  │                              │  Validate NotBefore/NotOnOrAfter
  │                              │  JIT provision or resolve   │
  │                              │  Enforce MFA                │
  │<── Set-Cookie + Redirect ────│                             │
```

### Service Layer

Four new services handle the SAML lifecycle:

| Service | Responsibility |
|---|---|
| `saml-authn-request.service.ts` | Builds the SAML `AuthnRequest` XML, deflates and Base64-encodes it for HTTP-Redirect binding, optionally signs the query string. Persists the generated `ID` as `samlAuthnRequestId` on a new `SsoCallbackAttempt` record, and derives the `RelayState` HMAC stored alongside it. |
| `saml-assertion.service.ts` | Accepts the raw HTTP-POST body, Base64-decodes the `SAMLResponse`, parses it via `@xmldom/xmldom`, verifies the `XMLDSig` signature using `xml-crypto`, and extracts validated assertion attributes. This service is the trust boundary — it throws on any validation failure before returning data to the caller. |
| `saml-metadata.service.ts` | Publishes SP metadata XML at `GET /v1/auth/saml/metadata/:connectionId` and ingests IdP metadata from a URL or pasted XML at `POST /v1/auth/saml/:connectionId/ingest-metadata`, populating `samlSsoUrl`, `samlCertificate`, `samlCertFingerprint`, and `samlNameIdFormat` on `SsoConnection`. |
| `saml-user-mapping.service.ts` | Translates validated assertion attributes to an internal user identity. Performs JIT provisioning via `ExternalIdentityMapping` (same pattern as the OIDC implementation). Enforces domain allow-list constraints before creating or linking accounts. |

### Route Registration

All four routes are registered in `saml-auth.routes.ts`:

```
GET  /v1/auth/saml/:connectionId/login          — HTTP-Redirect initiation
POST /v1/auth/saml/acs                          — ACS handler (assertion validation)
GET  /v1/auth/saml/metadata/:connectionId       — SP metadata XML publication
POST /v1/auth/saml/:connectionId/ingest-metadata — IdP metadata ingestion
```

The ACS endpoint does not carry a `connectionId` path parameter because the `InResponseTo` attribute and stored `SsoCallbackAttempt` are the authoritative source for resolving which connection (and therefore which IdP certificate) applies to an incoming assertion. Trusting a client-supplied identifier at ACS time would create a connection confusion vector.

---

## Security Controls

### 1. Signature Verification — xml-crypto v6.1.2

All incoming SAML assertions MUST carry a valid `XMLDSig` signature. Verification is performed using `xml-crypto` v6.1.2. The library is invoked with the IdP's certificate retrieved from `SsoConnection.samlCertificate` in the database.

**KeyInfo is explicitly ignored.** The signing key is always sourced from the pinned `SsoConnection.samlCertificate` field, never from the `<KeyInfo>` element embedded in the assertion. Accepting `KeyInfo` from the assertion would allow an attacker who can forge or intercept a response to substitute their own key and produce a valid signature — a well-documented key confusion attack against naive SAML implementations.

Unsigned assertions cause an immediate error. There is no fallback or degraded mode.

### 2. InResponseTo — Anti-Injection Control

The ACS handler enforces `InResponseTo` correlation on every incoming assertion:

1. At `AuthnRequest` generation time, a unique `ID` (UUID v4) is written to `SsoCallbackAttempt.samlAuthnRequestId`.
2. When the assertion arrives at ACS, `saml-assertion.service.ts` extracts the `InResponseTo` attribute from the `<Response>` element.
3. The value is looked up against `SsoCallbackAttempt.samlAuthnRequestId` records that are pending and not expired.
4. If no matching record exists, or if the record has already been consumed, the assertion is rejected.

This control prevents IdP-initiated SSO flows (which carry no `InResponseTo`) from being accepted without explicit opt-in configuration, and prevents assertion replay across distinct authentication sessions. The `InResponseTo` field is the primary anti-injection mechanism for the SAML implementation.

### 3. RelayState HMAC — Replay Protection

The `RelayState` value included in the HTTP-Redirect URL is an HMAC-SHA256 digest computed from the `SsoCallbackAttempt` identifier and a server-side secret. The digest is stored in the `SsoCallbackAttempt` record at initiation time. On ACS receipt, the presented `RelayState` is verified against the stored value before proceeding. Mismatches cause rejection. This prevents cross-site request forgery targeting the ACS endpoint by an attacker who can predict or observe a `RelayState` in transit.

### 4. Audience Restriction

The `<AudienceRestriction>` element inside the assertion MUST include the SP's `entityID`. The SP entity ID is derived from the `samlEntityId` field of the `SsoConnection`, which is set at connection configuration time by an administrator. If the assertion's `<Audience>` does not match, the response is rejected. This prevents an assertion issued to one SP from being replayed against a different SP sharing the same IdP.

### 5. Clock Skew Tolerance

Assertions carry `NotBefore` and `NotOnOrAfter` validity windows. The implementation enforces these timestamps strictly, with a configurable clock skew tolerance. The maximum permitted skew is **300 seconds**. The default skew applied in the absence of explicit configuration is **60 seconds**. Assertions where the current server time falls outside `[NotBefore - skew, NotOnOrAfter + skew]` are rejected. Setting clock skew above 300 seconds is a configuration error and will be rejected at startup.

### 6. Safe XML Parsing — @xmldom/xmldom v0.9.4

SAML assertions are XML documents. Unsafe XML parsers may be vulnerable to XML External Entity (XXE) injection, which can expose server-side files or trigger server-side request forgery. The implementation uses `@xmldom/xmldom` v0.9.4 exclusively for XML parsing. This parser does not support external entity resolution, eliminating the XXE attack surface. DOCTYPE declarations in incoming assertions cause parse failure.

### 7. Security Event Logging

11 new SAML security events were added to `SECURITY_EVENT_TYPES`:

- `SAML_AUTH_INITIATED`
- `SAML_ASSERTION_RECEIVED`
- `SAML_SIGNATURE_VERIFIED`
- `SAML_SIGNATURE_FAILED`
- `SAML_IN_RESPONSE_TO_MISMATCH`
- `SAML_AUDIENCE_MISMATCH`
- `SAML_CLOCK_SKEW_EXCEEDED`
- `SAML_JIT_PROVISIONED`
- `SAML_LOGIN_SUCCESS`
- `SAML_LOGIN_FAILED`
- `SAML_METADATA_INGESTED`

Raw assertion content is never included in log payloads. Event records include structured metadata (connection ID, NameID format, issuer, error class) sufficient for incident investigation without exposing assertion attributes.

---

## Implementation Details

### Schema Changes

**`SsoConnection` model additions:**

| Column | Type | Purpose |
|---|---|---|
| `samlEntityId` | `String?` | SP entity ID advertised in SP metadata |
| `samlSsoUrl` | `String?` | IdP SSO endpoint URL for HTTP-Redirect |
| `samlCertificate` | `String?` | PEM-encoded IdP signing certificate (pinned) |
| `samlCertFingerprint` | `String?` | SHA-256 fingerprint for UI display and auditing |
| `samlNameIdFormat` | `String?` | NameID format URN (e.g., `emailAddress`, `persistent`) |
| `samlSignRequests` | `Boolean` | Whether to sign outbound `AuthnRequest` |
| `samlAttributeMapping` | `Json?` | Custom attribute-to-claim mapping for JIT provisioning |

**`SsoCallbackAttempt` model additions:**

| Column | Type | Purpose |
|---|---|---|
| `samlAuthnRequestId` | `String?` | The `ID` attribute from the sent `AuthnRequest`; used for `InResponseTo` validation |

### JIT Provisioning

The `saml-user-mapping.service.ts` follows the established OIDC JIT provisioning pattern using `ExternalIdentityMapping`. On first login:

1. The NameID and configured attribute claims are extracted from the validated assertion.
2. An `ExternalIdentityMapping` record is created linking the IdP's subject identifier to a Digital Witness user account.
3. If no matching account exists and JIT provisioning is enabled for the connection, a new user account is created with the provisioned role defined on the `SsoConnection`.
4. Subsequent logins resolve the existing `ExternalIdentityMapping` record — no duplicate provisioning occurs.

Domain allow-list enforcement occurs before any account is created or linked. Assertions presenting an email attribute whose domain is not on the connection's allow-list are rejected.

### HTTP-Redirect Binding Details

The `saml-authn-request.service.ts` constructs the `AuthnRequest` as follows:

1. Build the XML document with a freshly generated `ID`, `IssueInstant`, `AssertionConsumerServiceURL`, and `Destination`.
2. Deflate (raw DEFLATE, no zlib header) and Base64-encode the XML.
3. Compose the query string: `SAMLRequest=<encoded>&RelayState=<hmac>`.
4. If `samlSignRequests` is `true` on the connection, append `SigAlg=http://www.w3.org/2001/04/xmldsig-more#rsa-sha256` and compute `Signature` over the preceding query string bytes using the SP's private key.
5. Redirect the browser to `samlSsoUrl?<query string>`.

### Session Shape

Upon successful assertion validation, MFA enforcement, and user resolution, the session cookie is set using the existing `proovra_session` cookie name and shape. Session lifetime is 30 days, consistent with the existing OIDC and password-based authentication flows. No new cookie names or session formats are introduced.

---

## MFA Integration

MFA enforcement is applied **after** full assertion validation, not before. The sequence is:

1. SAML assertion received at ACS endpoint.
2. Signature verified via `xml-crypto` using pinned IdP certificate.
3. `InResponseTo`, Audience, and timestamp constraints validated.
4. User resolved or JIT-provisioned via `saml-user-mapping.service.ts`.
5. `resolveLoginMfaEnforcement` called with the resolved user context.
6. If MFA is required and not satisfied by the IdP assertion (i.e., no `AuthnContextClassRef` indicating MFA at the IdP), the user is redirected to the in-app MFA challenge flow before the session is issued.
7. On MFA satisfaction, session cookie is set and user is redirected to the original destination via `RelayState`.

SAML assertions from IdPs that assert `urn:oasis:names:tc:SAML:2.0:ac:classes:MFA` or equivalent context classes are treated as satisfying MFA at the IdP level. The attribute mapping in `samlAttributeMapping` allows administrators to configure which assertion attribute communicates MFA status for IdPs that use non-standard claim names.

This ordering ensures that MFA cannot be bypassed by manipulating the assertion — the assertion must pass cryptographic and semantic validation before any user context is established for MFA resolution.

---

## Testing

### Unit Tests

`saml-assertion.service.ts` carries unit tests covering:

- Valid assertion with correct signature passes validation.
- Assertion with tampered `NameID` fails signature check.
- Assertion missing `<Signature>` element is rejected.
- `InResponseTo` mismatch produces error (anti-injection control).
- Audience restriction mismatch produces error.
- Expired assertion (`NotOnOrAfter` in the past, outside skew) is rejected.
- `NotBefore` in the future (outside skew) is rejected.
- Clock skew of exactly 300s is accepted; 301s is rejected.
- XXE payload in assertion body causes parse failure (not resolution).
- `KeyInfo`-only signature (no pinned cert match) is rejected.

`saml-authn-request.service.ts` tests verify:

- Generated `AuthnRequest` XML is well-formed.
- Generated `ID` is persisted to `SsoCallbackAttempt.samlAuthnRequestId`.
- `RelayState` HMAC is stored and verifiable.
- Signed query string is produced when `samlSignRequests` is `true`.
- Unsigned query string is produced when `samlSignRequests` is `false`.

### Integration Tests

End-to-end integration tests exercise the full ACS flow using a self-signed test IdP certificate and pre-built assertion fixtures. Tests confirm:

- A valid assertion produces a `proovra_session` cookie and a 302 redirect.
- An invalid signature produces a 401 with `SAML_SIGNATURE_FAILED` event logged.
- A replayed assertion (previously consumed `samlAuthnRequestId`) produces a 401.
- MFA enforcement intercepts a login that requires additional factors.
- JIT provisioning creates the expected `ExternalIdentityMapping` and user records.

### Security Regression Tests

The 11 SAML security event types are exercised in the Phase 32 security event mapping tests to confirm they are correctly registered in `SECURITY_EVENT_TYPES` and are mapped to appropriate severity levels in the event pipeline.

---

## Known Limitations

| Limitation | Detail | Mitigation |
|---|---|---|
| IdP-initiated SSO not supported | Assertions without `InResponseTo` are rejected. | Document in federation setup guide. IdPs must use SP-initiated flow. |
| Single certificate per connection | `SsoConnection.samlCertificate` holds one PEM certificate. Rolling IdP certificates requires a manual update window. | A future phase will support a secondary certificate slot for zero-downtime certificate rotation. |
| Signed assertions only | Encrypted assertions (`<EncryptedAssertion>`) are not supported in this phase. | Most enterprise IdPs support signed-only assertions. Encryption support is scoped for a follow-on phase. |
| NameID format negotiation | The `samlNameIdFormat` is a hint in the `AuthnRequest`; IdPs may respond with a different format. The implementation accepts any NameID format the IdP provides. | Administrators should verify NameID format alignment during federation testing. |
| Attribute mapping is static | `samlAttributeMapping` is a JSON blob configured at connection setup. Dynamic attribute discovery from IdP metadata is not implemented. | Covered by the IdP metadata ingestion flow for standard schema attributes. |
| Single ACS URL | One ACS URL is registered per SP deployment. Multi-tenant setups where tenants need distinct ACS URLs are not supported. | The `connectionId` is resolved from `InResponseTo` at ACS time, which provides logical multi-tenancy within a single ACS endpoint. |

---

## Deployment Checklist

### Pre-Deployment

- [ ] Confirm `SAML_ENABLED` environment variable is set to `"true"` (or absent) in the target environment.
- [ ] Run Prisma migration to apply `samlAuthnRequestId` column on `SsoCallbackAttempt` and all new columns on `SsoConnection`.
- [ ] Verify the SP signing key pair is provisioned in secrets management if `samlSignRequests` will be enabled for any connection.
- [ ] Confirm `xml-crypto` v6.1.2 and `@xmldom/xmldom` v0.9.4 are resolved in the production dependency lock (`pnpm-lock.yaml`).
- [ ] Confirm `saml-auth.routes.ts` is mounted in `server.ts` and does not conflict with any existing route prefix.
- [ ] Validate that 11 new SAML `SECURITY_EVENT_TYPES` entries are present in the event registry.
- [ ] Review clock synchronization on API hosts — NTP drift exceeding 60 seconds will cause assertion rejections for strictly-configured IdPs.

### Functional Verification

- [ ] Perform SP-initiated login flow against a staging IdP (Okta or Azure AD sandbox).
- [ ] Confirm `proovra_session` cookie is set with 30-day expiry after successful assertion validation.
- [ ] Confirm `SAML_LOGIN_SUCCESS` event appears in the security event log.
- [ ] Confirm `SAML_SIGNATURE_FAILED` is emitted and login is blocked when the assertion signature is invalidated.
- [ ] Confirm a replayed assertion (resubmit the same `SAMLResponse` POST) is rejected with `SAML_IN_RESPONSE_TO_MISMATCH`.
- [ ] Confirm SP metadata is accessible at `/v1/auth/saml/metadata/:connectionId` without authentication.
- [ ] Confirm IdP metadata ingestion populates `samlSsoUrl`, `samlCertificate`, and `samlCertFingerprint` correctly.
- [ ] Confirm MFA enforcement intercepts a login for a user whose policy requires a second factor not asserted by the IdP.

### Security Hardening Verification

- [ ] Confirm no raw assertion XML or attribute values appear in application logs during a successful or failed login.
- [ ] Confirm that submitting an assertion with a DOCTYPE declaration results in parse failure (not silent processing).
- [ ] Confirm that an assertion with `<KeyInfo>` pointing to an attacker-controlled key is rejected (certificate pinning active).
- [ ] Confirm that an unsigned assertion is rejected, even if all other fields are valid.
- [ ] Confirm that an assertion with an `InResponseTo` referencing a non-existent or consumed `SsoCallbackAttempt` is rejected.
- [ ] Confirm that clock skew above 300 seconds produces a validation failure, not a silent acceptance.

### Rollback Plan

- [ ] `SAML_ENABLED=false` disables all SAML routes without requiring a deployment.
- [ ] Prisma migration is backward-compatible — all new columns are nullable. Reverting the application binary while leaving the migration applied does not affect existing OIDC or password-based auth flows.
- [ ] No existing routes in `sso-auth.routes.ts` or `auth.routes.ts` were modified. Rollback of `saml-auth.routes.ts` is isolated.

---

## Hard Rules — DO NOT Violate

The following constraints are non-negotiable and must not be removed, bypassed, or weakened during future maintenance:

- **DO NOT accept unsigned assertions.** Every production assertion MUST pass `xml-crypto` signature verification. There is no safe degraded mode.
- **DO NOT skip signature validation** for any reason, including IdP compatibility workarounds. If an IdP cannot produce signed assertions, the connection is not eligible for SAML federation.
- **DO NOT trust arbitrary email domains.** JIT provisioning MUST check the domain allow-list on the `SsoConnection` before creating or linking accounts. An assertion presenting an email from an unconfigured domain MUST be rejected.
- **DO NOT expose raw assertion content in logs.** Assertion attributes, NameID values, and the raw `SAMLResponse` base64 payload must never be written to application logs, error messages returned to the browser, or audit event payloads.

---

*End of PHASE R8.2 Implementation Report*
