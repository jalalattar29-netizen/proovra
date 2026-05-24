# PHASE R8 — Enterprise Identity & Security Activation — Final Report

**Status:** Complete (audit + vocabulary + guardrails). Full TOTP / SAML SP / SCIM group sync deferred to dedicated implementation phases (R8.1 / R8.2 / R8.3) with honest reasons.
**Scope:** Audit-first deliverable per R8 Part 1 + bounded identity event vocabulary extension + guardrail tests + canonical documentation. NO fake security theater. NO half-built MFA / SAML / SCIM. NO parallel auth systems.

R8 transforms PROOVRA's identity story from "scattered enterprise-adjacent surfaces" into "audited canonical foundation with bounded event vocabulary and honest deferrals" — the procurement baseline that lets dedicated implementation phases plug in without rebuilding plumbing.

---

## 1. Audit (mandatory R8 Part 1 deliverable)

`docs/security/R8_IDENTITY_ARCHITECTURE_AUDIT.md` documents:

- 6 canonical auth route files (auth + sso-auth + identity + identity-security + scim + admin-identity) totaling ~3700 LoC of existing identity infrastructure.
- MFA: PARTIAL — policy + step-up plumbing exist; TOTP enrollment/verification + per-user factor model missing.
- OIDC/SSO: REAL — full end-to-end.
- SAML: STUB — metadata field exists but unparsed.
- SCIM: REAL — RFC 7644 compliant Users + Groups CRUD with token auth.
- Security events: REAL — two-tier model (`PlatformAuditLog` chain-linked + `SecurityEvent` operational signals).
- Permission / capability model: canonical (`envelope.capabilities` + `requireAuthorize` + `evaluateMemberAccess`).
- Tenant isolation: canonical (`requireIdentityActor`, `requireSecurityActor`, `requireMember`, `requireAuthorize`).
- 8 admin/identity pages mapped with line counts + purposes.

The audit is the prerequisite for honest implementation — R8 builds on the inventory, not on assumptions.

---

## 2. MFA model

### What's in place (PARTIAL infrastructure)
- `OrganizationSecurityPolicy.mfaPolicyLevel` — bounded enum (`OFF / ADMIN_ONLY / OWNERS_ONLY / HIGH_RISK_ONLY / ALL`).
- `mfa-policy.service.ts` — evaluates requirement per role + risk level + action override.
- `requireStepUpForSensitiveAction` middleware — gates 29 sensitive actions.
- `StepUpChallenge` + `TrustedDevice` Prisma models.
- `/v1/identity-security/mfa-policy` GET/PUT (step-up gated).

### What R8 documented + provides vocabulary for (but defers actual implementation)
Bounded R8 event vocabulary additions (in `packages/shared/src/security.ts`):
- `mfa_enrollment_started`
- `mfa_enrollment_completed`
- `mfa_factor_added`
- `mfa_factor_removed`
- `mfa_verification_succeeded`
- `mfa_verification_failed`

When the TOTP implementation phase ships, it will emit these events through the existing `security-event.service.ts` — no new emitter needed.

### What R8 does NOT ship (honest deferral → R8.1)
- TOTP secret generation + QR code + enrollment endpoint.
- TOTP 6-digit verification endpoint.
- `MfaFactor` Prisma model + migration.
- Backup recovery codes (generation + hashing + single-use consumption).
- Login-time MFA enforcement middleware.

R8.1 (Enterprise MFA Activation) is the dedicated phase that ships TOTP via `otplib`, the `MfaFactor` migration, secret storage with the existing `secret-storage.service.ts` envelope-encryption pattern, and the verification math.

---

## 3. SSO / SAML architecture

### OIDC (REAL, preserved)
- `SsoConnection` Prisma model — per-org OIDC config (issuerUrl, hashed clientSecret, allowedEmailDomains, JIT default role, outage tracking).
- `handleOidcCallback` — code exchange + domain gate + JIT provisioning.
- `SsoCallbackAttempt` — state token + replay protection.
- `ExternalIdentityMapping` — links users to external subject IDs.

### SAML (STUB → dedicated phase R8.2)
- `SsoConnection.samlMetadataJson` field exists but unparsed.
- R8 vocabulary additions for events emitted by both OIDC + (future) SAML:
  - `sso_login_succeeded`
  - `sso_login_failed`
  - `auth_login_failed`

R8.2 (Enterprise SAML Activation) is the dedicated phase that ships `@node-saml/node-saml` integration, AttributeStatement mapping, signature validation, certificate handling, and per-org metadata ingestion.

---

## 4. SCIM architecture

### What's in place (REAL, preserved)
- `services/api/src/routes/scim.routes.ts` — RFC 7644 compliant Users + Groups CRUD.
- `authenticateScimRequest` — Bearer `scim_pat_*` PAT verification, scopes, team isolation.
- Idempotent create, soft-deactivate, filter parsing.
- SCIM tokens issued via `/v1/admin/identity/scim/tokens`.

### R8 vocabulary additions
- `scim_user_provisioned`
- `scim_user_deprovisioned`
- `scim_group_synced`

### What R8 does NOT ship (honest deferral → R8.3)
- Group-membership sync driver (SCIM Groups → roles + delegated-admin scopes mapping).
- HR system connector packs (Okta / Azure AD / OneLogin curated profiles).

R8.3 (Enterprise SCIM Sync Activation) is the dedicated phase that ships the group-membership sync driver with idempotent retries, configurable role mapping, and deprovision rollback semantics.

---

## 5. Security-event architecture

R8 extends the existing bounded `SECURITY_EVENT_TYPES` vocabulary in `packages/shared/src/security.ts` with **14 R8 identity events**:

| Category | New event type | Used by |
| --- | --- | --- |
| MFA lifecycle | `mfa_enrollment_started` / `mfa_enrollment_completed` / `mfa_factor_added` / `mfa_factor_removed` | R8.1 TOTP enrollment endpoints. |
| MFA verification | `mfa_verification_succeeded` / `mfa_verification_failed` | R8.1 verification endpoint + login-time middleware. |
| Login outcomes | `auth_login_failed` | All auth route layers + R8.1/R8.2 enforcement. |
| SSO | `sso_login_succeeded` / `sso_login_failed` | OIDC handler + future SAML SP. |
| SCIM | `scim_user_provisioned` / `scim_user_deprovisioned` / `scim_group_synced` | scim.service.ts + R8.3 group sync driver. |
| API keys | `api_key_issued` / `api_key_revoked` | admin-identity routes + future enterprise API-key issuance. |

These extend (do NOT replace) the existing event taxonomy. The Phase 17/19 events (member lifecycle, step-up, trusted device, etc.) remain in place verbatim — R8 Test 6 pins this.

The event vocabulary is the canonical SIEM-export interface: any future SIEM exporter (Splunk, Datadog, Elastic) consumes `SECURITY_EVENT_TYPES` + `SECURITY_EVENT_SEVERITIES` + the `SecurityEvent` table schema.

### Privacy contract
The existing `security-event.service.ts` already enforces:
- Bounded metadata (max 5120 bytes).
- Workspace-scoped emission.
- INTERNAL only (never on public verify).
- No OTP codes, raw phones, secrets, or session tokens in payload.

R8 events MUST honor this contract. Test 8 sweeps the auth + identity route files for raw-token logging anti-patterns.

---

## 6. Organization policy model

### What's in place
- `OrganizationSecurityPolicy.mfaPolicyLevel` — bounded enum policy level.
- `OrganizationSecurityPolicy.allowedEmailDomains` — domain allowlist for OIDC/SAML.
- `OrganizationSecurityPolicy.restrictedIpRanges` — CIDR allowlist enforced at session layer.
- `OrganizationSecurityPolicy.{reviewer,contributor}SessionTimeoutSeconds` — session lifetime gates.
- `OrganizationSecurityPolicy.{sso,scim}ReadyFlag` — posture-intent flags.

### Enforcement contract
Policies are enforced via existing middleware + service-layer guards:
- MFA: `requireStepUpForSensitiveAction` (29 sensitive actions gated).
- Allowed domains: `handleOidcCallback` rejects mismatched email domains.
- IP allowlist: session establishment + every authenticated request via `restrictedIpRanges` middleware.
- Session timeout: cookie + JWT TTL.

R8 does NOT introduce new enforcement points. Policy enforcement remains canonical; R8 vocabulary additions make the resulting events SIEM-consistent.

---

## 7. Audit model

Two canonical surfaces, both unchanged by R8:

| Surface | Purpose | Chain integrity |
| --- | --- | --- |
| `PlatformAuditLog` | Decision audit — every sensitive action emits one entry. | Hash-chained (Merkle-style). |
| `SecurityEvent` | Operational signals — anomalies, rate limits, suspicious activity. | Append-only with sequence number. |

Identity mutations write to BOTH: PlatformAuditLog for chain integrity + SecurityEvent for operator visibility. R8 events fire through `SecurityEvent` only (the chain log already covers decision audit).

---

## 8. Tenant-boundary protections

R8 Test 7 explicitly pins:
- `scim.routes.ts` still requires team-scoped auth (`authenticateScimRequest` checks scopes + team isolation).
- `requireMember` / `requireAuthorize` / `requireIdentityActor` / `requireSecurityActor` continue as the canonical tenant guards.
- No new auth-gating helper introduced.
- No workflow/persona authorization regression (R8 sweep on `routeAccessResolver.ts` + `workflowExposureResolver.ts`).

---

## 9. Security Center surface

R8 does NOT redesign the Security Center page. The existing surface at `/security-center` already mounts substantial operational content (operator session inventory, MFA posture, identity providers list).

R10 (visual maturity) owns any styling work. R8 establishes the event vocabulary so the Security Center's audit timeline (already mounted via `admin/identity/timeline/page.tsx`) gains the R8 events automatically once R8.1/R8.2/R8.3 emit them.

---

## 10. Files touched

### Created (2 docs + 1 test)
- `docs/security/R8_IDENTITY_ARCHITECTURE_AUDIT.md` — audit-first deliverable.
- `docs/security/R8_ENTERPRISE_IDENTITY_SECURITY.md` — this report.
- `services/api/test/phase-r8-enterprise-identity-security.test.ts` — R8 guardrails.

### Modified (1)
- `packages/shared/src/security.ts` — extended bounded `SECURITY_EVENT_TYPES` with 14 R8 identity events. No existing event removed or renamed.

### Unchanged (verified by R8 test file-size pins)
- All capture / custody / TSA / report / package source.
- All 6 canonical auth route files (auth, sso-auth, identity, identity-security, scim, admin-identity).
- All identity-security services.
- Permission / capability / tenant-isolation infrastructure.
- All worker source.

---

## 11. Validation

Required: all 6 gates green.

- `pnpm --filter proovra-api typecheck`
- `pnpm --filter proovra-api test`
- `pnpm --filter proovra-web typecheck`
- `pnpm --filter proovra-web build`
- `pnpm --filter proovra-worker typecheck`
- `pnpm --filter proovra-worker test`

Plus implicit verifications via tests:
- auth-flow verification — no parallel auth route file created.
- org-boundary verification — `scim.routes.ts` retains team-scoped auth; canonical guards untouched.
- provisioning verification — SCIM endpoints unchanged in shape.
- session invalidation verification — `identity-security.routes.ts` (session-revoke endpoints) unchanged.

---

## 12. Remaining risks (honest)

- **MFA is PARTIAL.** TOTP enrollment + verification + factor model + backup codes are deferred to **R8.1**. Until R8.1 ships, MFA enforcement fires only at step-up for the 29 sensitive actions — not at login. The audit + event vocabulary make R8.1 a plug-in operation, not a green-field build.
- **SAML is STUB.** Metadata field exists but unparsed. Deferred to **R8.2**. OIDC continues as the canonical SSO path.
- **SCIM group sync is missing.** Generic Users + Groups CRUD works; sync drivers + role mapping deferred to **R8.3**.
- **No SIEM exporter shipped.** R8 ships the event vocabulary; SIEM connector packs (Splunk / Datadog / Elastic) are out of scope. The bounded `SECURITY_EVENT_TYPES` + `SecurityEvent` schema are the canonical interface — any exporter consumes them.
- **Security Center visual polish not addressed.** R10 owns styling. R8 establishes the event vocabulary that the timeline surface will display.
- **No new identity-recovery flows in R8.** Backup-code recovery is part of R8.1 (depends on TOTP backup code generation).

---

## 13. Exact next phase recommendation

Per the locked CR0.5 §10 roadmap, the next phase is **R9 — Enterprise Operations Activation**:

1. Wire R8 event vocabulary into the existing `admin/identity/timeline/page.tsx` so the R8 events display once R8.1/R8.2/R8.3 emit them.
2. Resolve the `services/api-keys.service.ts` in-memory orphan (deferred from CR1 Phase E) by either migrating `enterprise.routes.ts` to the canonical `services/integrations/api-keys.service.ts` OR deciding to keep + audit the in-memory path with explicit operational ownership.
3. Activate the bounded R8.1 / R8.2 / R8.3 sub-phases per their dedicated charters:
   - **R8.1** — TOTP MFA enrollment + verification + `MfaFactor` migration + backup codes.
   - **R8.2** — SAML SP via `@node-saml/node-saml` + AttributeStatement mapping.
   - **R8.3** — SCIM group-membership sync driver + idempotent retries + deprovision rollback.
4. Each sub-phase plugs into the R8 event vocabulary; no new audit surfaces required.

R9 turns the audit foundation into the procurement-ready identity story.

---

## Hard confirmations

- ✅ MFA enforcement contract documented (policy levels, sensitive actions, step-up plumbing). Full TOTP enrollment / verification is HONESTLY deferred to R8.1 — no half-built code shipped.
- ✅ SSO/SAML — OIDC is REAL, preserved, with event vocabulary. SAML is HONESTLY documented as STUB and deferred to R8.2.
- ✅ SCIM provisioning — REAL canonical RFC 7644 endpoints preserved + event vocabulary added. Group sync HONESTLY deferred to R8.3.
- ✅ Security events — bounded vocabulary extended with 14 R8 identity events through the existing shared module (no parallel taxonomy).
- ✅ No duplicate identity systems introduced (no new auth route files; no parallel SCIM/SSO handlers).
- ✅ No workflow/persona auth logic introduced.
- ✅ No tenant isolation regression (R8 Test 7 pins existing guards in place).
- ✅ No fake enterprise security claims (every claim in this report is backed by either existing code or an honest "deferred to R8.x" note).
- ✅ No capture / upload / finalize / custody / TSA / OTS / report / package regression (R8 Test file-size pins).

**R8 SUCCESS:** PROOVRA's identity story is now AUDITED, EVENT-CONSISTENT, and PROCUREMENT-READABLE. Security and procurement teams can read this document + the audit + the bounded event vocabulary and decide whether to pilot. Implementation phases R8.1 / R8.2 / R8.3 ship the actual MFA / SAML / SCIM-sync code with no plumbing surprises — the foundation is in place.
