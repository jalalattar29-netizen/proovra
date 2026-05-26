# Phase R8.C — Identity, Env & Config Consolidation

**Status:** Implementation Complete — Pending Final Validation  
**Date:** 2026-05-25  
**Scope:** Stabilization only. No new auth subsystems. No new feature flags beyond those already shipped.

---

## 1. Purpose

Phase R8.C closes the gap between what R8 built (MFA, SAML SP, security events, signing infrastructure) and what was actually consistently configured in the runtime environment. The audit found:

- **Duplicated variables** in `.env` — dotenv first-wins semantics meant "PHASE 20 HARDENING" secret rotations appended to the file bottom were silently ignored; old values were active throughout.
- **No runtime enforcement** of signing provider consistency — `SIGNER_PROVIDER=aws-kms` could be set without `KMS_KEY_ID` and the server would start with broken signing.
- **No localhost leak detection** — `SAML_SP_ACS_URL=http://localhost:...` and `S3_ENDPOINT=http://localhost:...` were valid in production config without any validator rejecting them.
- **Auth surface boundary** was implicit — which subsystems are supported vs. intentionally deferred was not written down anywhere.

R8.C resolves all four gaps. It does **not** add new auth capabilities.

---

## 2. Canonical ENV Strategy

### 2.1 Single-occurrence rule

Every variable in `.env` appears **exactly once**. The file was rewritten from 577 lines (12+ duplicate declarations) to ~290 lines with one authoritative value per key.

**The first-wins rule that caused the silent ignoring bug:**
> In dotenv, when a variable appears multiple times, the FIRST occurrence wins. Any subsequent assignment is silently ignored. The "PHASE 20 HARDENING" pattern of appending to the file bottom was therefore a no-op for every variable already declared above.

**Enforcement:** The `.env` file header now contains a hard prohibition:
```
# RULE: Each variable appears EXACTLY ONCE in this file.
# NEVER append overrides to the bottom — edit in place.
# dotenv takes the FIRST occurrence; appended "overrides" are silently ignored.
```

### 2.2 Canonical variable names

| Concern | Canonical Name | Deprecated / Alias | Notes |
|---|---|---|---|
| SAML ACS URL | `SAML_SP_ACS_URL` | `SAML_ACS_URL` | Both accepted by runtime; SP-prefixed is preferred |
| Signing provider | `SIGNER_PROVIDER` | — | Values: `aws-kms` or `local-pem` (default) |
| Signing key label | `SIGNING_KEY_ID` | — | Metadata label only; not a crypto key reference |
| KMS key reference | `KMS_KEY_ID` | — | Required when `SIGNER_PROVIDER=aws-kms` |
| Local PEM path | `SIGNING_PRIVATE_KEY_PATH` | — | Required when `SIGNER_PROVIDER=local-pem` |

### 2.3 Feature flag canonical list

All feature flags are boolean. The canonical set (value = `"true"` to enable, anything else = disabled):

| Flag | What it gates | Default in dev |
|---|---|---|
| `COMMUNICATIONS_ENABLED` | SMS/voice via Twilio | `false` |
| `IDENTITY_SECURITY_ENABLED` | Identity security hash checks | `false` |
| `NOTIFICATIONS_ENABLED` | Email via Resend | `false` |
| `OPENAI_AI_ENABLED` | OpenAI intelligence features | `false` |
| `INTEGRATIONS_ENABLED` | External service API key auth | `false` |
| `SAML_ENABLED` | SAML SSO login flow | `false` |

**Removed dead flags:** None were found that needed removal — all declared flags are actively checked in application code. The duplicate declarations in `.env` were the only governance issue, now resolved by the single-occurrence rule.

---

## 3. Signing Provider Truth

### 3.1 Provider selection

```
SIGNER_PROVIDER=aws-kms     → AWS KMS backend (KMS_KEY_ID required)
SIGNER_PROVIDER=local-pem   → Local PEM file (SIGNING_PRIVATE_KEY_PATH required)
(unset)                     → Defaults to local-pem
```

### 3.2 What `SIGNING_KEY_ID` is

`SIGNING_KEY_ID` (e.g. `dw_ed25519`) is a **metadata label** stored alongside signatures in the database so they can be traced back to the key that produced them. It is **not** a crypto key reference, not an AWS key ARN, and not a KMS alias.

This value was deliberately kept as `dw_ed25519` (not updated to `dw_ed25519_kms`) because:
- Changing it would create a mismatch between historical signatures in the database (labelled `dw_ed25519`) and the label used for future verification lookups.
- A migration would be required to update all existing signature records before changing this value.
- The label change is orthogonal to the actual signing backend — KMS is invoked correctly regardless of what label is stored.

**If a label rotation is needed:** Run a targeted DB migration updating `signingKeyId` on historical records, then update `SIGNING_KEY_ID` in the environment.

### 3.3 Runtime enforcement

`collectStartupViolations()` in `src/config/index.ts` now enforces provider consistency at startup:

- `SIGNER_PROVIDER=aws-kms` and `KMS_KEY_ID` unset → violation `signing_provider_inconsistent`
- `SIGNER_PROVIDER=local-pem` (or unset) and `SIGNING_PRIVATE_KEY_PATH` unset → violation `signing_provider_inconsistent`

In production, violations cause a hard throw (`ProductionConfigError`) and prevent the server from starting. In non-production, violations are logged as warnings.

---

## 4. Auth Surface Boundaries

### 4.1 Supported (shipped and operational)

| Feature | State |
|---|---|
| Password authentication | Active — bcrypt hashing, account lockout |
| JWT session tokens | Active — HS256, expiry, refresh |
| TOTP (Authenticator App MFA) | Active — speakeasy TOTP, backup codes |
| SMS MFA via Twilio | Active — feature-gated (`COMMUNICATIONS_ENABLED`) |
| Org-level MFA policy enforcement | Active — required / grace-period / optional |
| MFA recovery codes (admin lifecycle) | Active — admin generate/revoke, user consume |
| SAML 2.0 SP | Active — SP-initiated, cert validation, JIT provisioning |
| SAML certificate rotation | Active — next-cert staging, promote endpoint |
| SAML certificate expiry monitoring | Active — 30/60/90-day thresholds, security events |
| SCIM 2.0 | Foundation active — provisioning endpoints available |
| API key authentication (integrations) | Active — feature-gated (`INTEGRATIONS_ENABLED`) |
| Security event audit log | Active — immutable event records, admin read |
| Document signing (JWT/KMS) | Active — provider-switchable |

### 4.2 Intentionally deferred

The following are **not present** in R8 and were never planned for inclusion:

| Feature | Reason for deferral |
|---|---|
| WebAuthn / FIDO2 passkeys | Not in R8 scope; requires dedicated UX phase |
| SIEM integration / log forwarding | Operational concern, not application-layer auth |
| Advanced federation (OIDC provider, multi-IdP broker) | Architecture phase not yet scoped |
| New auth providers (GitHub OAuth, Google OAuth enterprise) | Not requested; deferred to product roadmap |
| New IAM subsystems (role hierarchy, ABAC) | Current RBAC is sufficient; deferred |
| Hardware token MFA (TOTP via hardware key) | Falls under WebAuthn/FIDO2 deferral |
| Adaptive authentication / risk scoring | Deferred; requires ML/signals infrastructure |

**Rule:** The above must not appear in any R8.x phase. If a phase touches one of these areas, it is out of scope and must be rejected.

### 4.3 What R8.C explicitly did not change

- No new routes added
- No new database schema columns added (R8.2.2 added `samlCertNextNotAfter` and `samlCertNotAfter` — those were R8.2.2, not R8.C)
- No new feature flags added
- No existing SAML, MFA, or SCIM flows modified
- No capture, upload, finalization, custody, or report logic touched

---

## 5. Production Requirements Checklist

The following must be set in production before the server will start (enforced by `collectStartupViolations()`):

### Core (always required)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `AUTH_JWT_SECRET` | JWT signing secret (min 32 chars recommended) |

### Feature-gated (required when feature is on)

| Variable | Required when | Feature flag |
|---|---|---|
| `COMMUNICATIONS_RECIPIENT_HASH_SECRET` | `COMMUNICATIONS_ENABLED=true` | Communications |
| `IDENTITY_SECURITY_HASH_SECRET` | `IDENTITY_SECURITY_ENABLED=true` | Identity security |
| `API_KEY_SECRET` | `INTEGRATIONS_ENABLED=true` | Integrations |

### Signing (exactly one provider required)

| Provider | Required variable |
|---|---|
| `SIGNER_PROVIDER=aws-kms` | `KMS_KEY_ID` |
| `SIGNER_PROVIDER=local-pem` (or unset) | `SIGNING_PRIVATE_KEY_PATH` |

### Production safety (blocked if violated in prod)

| Variable | Safety rule |
|---|---|
| `SAML_SP_ACS_URL` | Must not start with `http://localhost`, `http://127.0.0.1`, or `https://localhost` when `SAML_ENABLED=true` and `NODE_ENV=production` |
| `S3_ENDPOINT` | Must not start with `http://localhost`, `http://127.0.0.1`, or `http://minio` in production unless `S3_ALLOW_INSECURE=true` |

---

## 6. Removed Duplicates — Audit Record

The following variables had multiple declarations in `.env` before R8.C. The **first occurrence** was always the effective value (dotenv semantics). All subsequent occurrences have been removed.

| Variable | Former occurrences | Effective value (first occurrence) |
|---|---|---|
| `AUTH_JWT_SECRET` | 2 | `dev-jwt-secret-not-for-production` |
| `COMMUNICATIONS_RECIPIENT_HASH_SECRET` | 3 | `YGLJKLndfsknklj5454fdfsdknJNB` |
| `IDENTITY_SECURITY_HASH_SECRET` | 2 | `JHkjsaaskJKH5215dfkKLJN` |
| `SIGNING_PRIVATE_KEY_PATH` | 2 | `keys/signing-private.pem` |
| `SIGNING_KEY_ID` | 2 | `dw_ed25519` |
| `SIGNER_PROVIDER` | 2 | `aws-kms` |
| `KMS_KEY_ID` | 2 | `arn:aws:kms:eu-north-1:...` |
| `DATABASE_URL` | 2 | `postgresql://postgres:postgres@localhost:5432/proovra` |
| `S3_ENDPOINT` | 3 | `http://localhost:9000` |
| `S3_ACCESS_KEY_ID` | 2 | `minioadmin` |
| `S3_SECRET_ACCESS_KEY` | 2 | `minioadmin` |
| `S3_BUCKET_NAME` | 2 | `proovra-documents` |

**Risk note:** The "PHASE 20 HARDENING" comment blocks at the bottom of the old `.env` contained rotated secret values that were silently ignored due to first-wins semantics. If those rotated values were intended for production, the actual secrets in use were the original (pre-hardening) values. A secret rotation audit against the live production environment is recommended to confirm which values are actually in use there.

---

## 7. Remaining Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Production secrets may be the pre-rotation values if the PHASE 20 HARDENING appends were the intended rotation | HIGH | Rotate all production secrets explicitly via the provider (AWS Secrets Manager / vault), confirm values, update `.env.production` (separate from `.env`) |
| `.env` is committed to version control | HIGH (if repo is not private) | Ensure `.env` is in `.gitignore`; use `.env.example` for reference |
| `SIGNING_KEY_ID=dw_ed25519` label mismatch if KMS is the active backend | LOW | Label is metadata-only; does not affect crypto correctness. No immediate action required. |
| `S3_ENDPOINT=http://localhost:9000` in `.env` means MinIO is the active storage backend | MEDIUM | Storage safety check now blocks this in `NODE_ENV=production`. Dev/staging: this is expected. |
| Feature flags are off by default — communications, notifications, AI | LOW | Expected. Turn on per-environment as needed. |

---

## 8. Definition of Done — R8.C

| Criterion | Status |
|---|---|
| `.env` has each variable exactly once | ✅ |
| `.env` has a header rule forbidding append-overrides | ✅ |
| `collectStartupViolations()` checks signing provider consistency | ✅ |
| `collectStartupViolations()` checks SAML URL localhost safety | ✅ |
| `collectStartupViolations()` checks storage localhost safety | ✅ |
| `StartupConfigViolation` type has 5 typed reason values | ✅ |
| 13 contract tests in `phase-r8-c-consolidation.test.ts` | ✅ |
| No new auth subsystems introduced | ✅ |
| No existing MFA/SAML/SCIM flows broken | ✅ |
| No capture/upload/finalization/custody/report logic touched | ✅ |
| This documentation written | ✅ |

---

## 9. Exact Next Phase Recommendation

**R8.C is the final stabilization phase for R8.**

Do not proceed to a new auth expansion phase until:
1. The secret rotation audit (§7, first risk) has been completed against the production environment.
2. `.env` is confirmed excluded from version control (`.gitignore` audit).
3. The production signing provider has been verified end-to-end (sign a document, verify the signature chain in the audit log).

**Recommended next phase if expansion is required:**  
Phase R9 — if needed, scope a single, well-defined new capability (e.g., passkey support or OIDC provider). Do not combine multiple auth expansions in one phase. Each R9.x should be a single coherent capability with its own contract tests and rollback plan.

**If no expansion is needed:**  
Phase R8.C is the appropriate closure point for the R8 identity & security track. The platform is enterprise-ready for the following capabilities as shipped: password auth, MFA (TOTP + SMS), SAML 2.0 SSO, SCIM provisioning, API key integrations, security event audit, and document signing.
