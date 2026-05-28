# SAML Admin Guide (Phase P1)

**Audience:** enterprise IT admins responsible for SSO configuration + cert lifecycle.

**Canonical path:** `/settings/security/saml` (redirects to the implementation surface at `/security-center/sso`).

**Companion docs:** R8.2.0 / R8.2.1 / R8.2.2 in `docs/security/R8_2_*` provide the technical SAML hardening history. This guide is the operator-facing how-to.

---

## 1. What PROOVRA's SAML console does

The console at `/settings/security/saml` provides production-grade configuration for a workspace's SAML SSO connection. An IT admin can:

- View the per-connection status (PENDING / ACTIVE / DISABLED / REVOKED) with reason metadata.
- Read the SP-side metadata + ACS URL needed by the IdP (copy-to-clipboard).
- See request-signing posture (currently unsigned — see R8.3 roadmap).
- Run a connection health check (`POST /v1/auth/saml/:connectionId/test-connection`) and read the pass/fail breakdown.
- Ingest the IdP's metadata XML to extract endpoints, certificates, NameID format, and certificate expiry (`POST /v1/auth/saml/:connectionId/ingest-metadata`).
- Manage certificate rotation: add a secondary certificate (`PUT /v1/auth/saml/:connectionId/certificate-next`), then promote to primary when the IdP has switched (`DELETE /v1/auth/saml/:connectionId/certificate-next`).
- See certificate expiry warnings at 30/60/90-day thresholds.
- See IdP outage indicators (consecutive failure thresholds).

---

## 2. SAML configuration checklist

### 2.1 Provision a new IdP connection

Connections are created via the platform's onboarding flow (or by Platform Admin via the providers admin page at `/admin/identity/providers`). The SAML console assumes a connection record exists; the path is:

1. IT admin navigates to `/settings/security/saml`.
2. The card lists the active SAML connection(s) for the workspace.
3. Click **Copy SP metadata URL** and send it to the IdP team.
4. The IdP team configures their IdP using the SP metadata and shares back their IdP metadata XML.

### 2.2 Ingest IdP metadata

In the **IdP metadata ingestion** textarea, paste the full XML. PROOVRA extracts:

| Extracted field | Stored as |
| --- | --- |
| Single Sign-On URL | `samlSsoUrl` |
| IdP entity ID | `samlIdpEntityId` |
| Signing certificate | `samlCertificate` |
| NameID format | `samlNameIdFormat` |
| Certificate expiry | `samlCertNotAfter` |

Failures (malformed XML, missing required nodes, expired certificate) surface inline with the offending node.

### 2.3 Run the connection health check

Click **Run health check**. PROOVRA validates:

- Signing cert is parseable and not expired.
- SSO URL is reachable (TCP-level probe; not a full HTTP fetch).
- ACS URL matches the SP metadata.
- NameID format is one of the supported policies.

Each check returns a pass/fail with a structured reason. Failed checks block the connection from transitioning to ACTIVE.

### 2.4 Promote the connection to ACTIVE

When all health checks pass, the connection is eligible for ACTIVE. The transition is performed via the providers admin page (`/admin/identity/providers`) — the action is audited as `sso_connection_transitioned`.

---

## 3. Certificate rotation (the dangerous operation)

### Why step-up is required

Certificate rotation replaces the active IdP cert on a live connection. If misconfigured, every user is locked out of SSO. The frontend wraps the promotion call in `useStepUpAction({teamId})`; backend's `enforceStepUpIfFlagged` middleware returns 401 STEP_UP_REQUIRED if the workspace's step-up policy is set; the modal collects an SMS / WhatsApp OTP before the operation proceeds.

### Rotation procedure

1. **Receive new IdP cert.** The IdP team rotates their signing key.
2. **Stage the secondary cert.** Paste the new PEM block in the **Add rotation certificate** textarea. PROOVRA stores it as `samlCertificateNext`. **At this stage assertions are accepted from BOTH certs.** PROOVRA tries the primary first; on signature mismatch it tries the secondary.
3. **Confirm IdP has switched.** Wait for the IdP team to confirm their new key is the active signer.
4. **Promote.** Click **Promote rotation cert to primary**. PROOVRA:
   - Step-up gate (if flagged).
   - Backend swap: `samlCertificate` becomes the old `samlCertificateNext`; `samlCertificateNext` is cleared.
   - Audit emission: `saml_certificate_rotated`.

### Rollback

If the promotion is incorrect, PROOVRA does not auto-rollback. Recovery:
1. Open the connection.
2. Stage the OLD cert as the new secondary (`PUT certificate-next`).
3. Confirm the IdP has switched back.
4. Promote.

---

## 4. Observability

The SAML console emits the following audit events (consumed by the audit center timeline at `/settings/security/audit`):

| Event | When |
| --- | --- |
| `saml_login_started` | Operator initiates SP-initiated SSO |
| `saml_login_succeeded` | Assertion validated + JIT provisioning complete |
| `saml_login_failed` | Assertion rejection (with reason: signature / audience / NameID / replay / ACS mismatch / cert expiry) |
| `saml_metadata_ingested` | Admin imports IdP metadata |
| `saml_connection_test_started/succeeded/failed` | Health check lifecycle |
| `saml_certificate_rotated` | Cert promotion |
| `saml_assertion_rejected` | Detailed assertion rejection (the audit timeline's high-severity filter highlights these) |

Metrics:

- `saml_login_initiated_total`, `saml_login_succeeded_total`, `saml_login_failure_total`
- `saml_relay_state_invalid_total`
- `saml_connection_test_total`, `saml_connection_test_failure_total`
- `saml_certificate_rotation_total`

---

## 5. Bounded follow-ups (NOT shipped today)

Per the P1.0 honest-scope disclosure:

- **Visual SAML attribute mapping builder.** Today the attribute mapping (NameID, email, first/last name, role, group, workspace) is configured in the IdP record via the providers admin page. A visual builder that consumes the parsed metadata + offers attribute-pick dropdowns is bounded follow-up.
- **SSO connection health monitoring dashboard.** Today the health check is per-connection on-demand. An aggregated dashboard showing all connections' health over time + IdP outage correlation is bounded follow-up.
- **Request signing.** SP-side request signing is on the R8.3 roadmap; today PROOVRA's SP requests are unsigned, which is acceptable for the connection types we support but bounded follow-up for high-assurance procurement.

---

## 6. Procurement / compliance posture

- All SAML mutations emit `safeEmitSecurityEvent` calls; the audit center timeline is the authoritative record.
- Cert rotation is step-up gated when the workspace policy is set.
- Replay protection: `SsoCallbackAttempt` ledger + `InResponseTo` correlation enforced by `services/api/src/services/security/sso-hardening.service.ts`.
- The strict assertion validator pins the IdP cert in the connection record; KeyInfo trust is NOT used.
- Backend services: `saml-authn-request.service.ts`, `saml-metadata.service.ts`, `saml-assertion.service.ts`, `saml-user-mapping.service.ts`, `saml-cert.service.ts`, `sso.service.ts`, `sso-hardening.service.ts`.

---

## 7. Reference

- Surface: [apps/web/app/(app)/security-center/sso/page.tsx](../../apps/web/app/%28app%29/security-center/sso/page.tsx)
- Canonical redirect: [apps/web/app/(app)/settings/security/saml/page.tsx](../../apps/web/app/%28app%29/settings/security/saml/page.tsx)
- Backend routes: [services/api/src/routes/saml-auth.routes.ts](../../services/api/src/routes/saml-auth.routes.ts)
- R8.2 history: [R8_2_REAL_SAML_SP.md](./R8_2_REAL_SAML_SP.md), [R8_2_1_SAML_HARDENING.md](./R8_2_1_SAML_HARDENING.md), [R8_2_2_SAML_COMPLIANCE_CLOSURE.md](./R8_2_2_SAML_COMPLIANCE_CLOSURE.md)
- Audit center: [identity-audit-center.md](./identity-audit-center.md)
