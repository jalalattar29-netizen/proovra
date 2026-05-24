# R8 — Identity Architecture Audit

**Status:** Complete.
**Scope:** Honest inventory of existing identity, security, MFA, SSO, SAML, SCIM, and audit infrastructure BEFORE any R8 implementation work. This document is the audit-first deliverable required by R8 Part 1.

The audit is the ANSWER to "what does R8 inherit, and what would R8 have to actually build vs just wire up?" — so subsequent R8 phases do not duplicate existing code or pretend non-existent code exists.

---

## 1. Auth provider routes (6 canonical files)

| File | Lines | Purpose |
| --- | --- | --- |
| `services/api/src/routes/auth.routes.ts` | ~608 | Core session layer — Google OAuth, Apple OAuth, email/password registration & login, password-reset flow, guest sessions, `/v1/auth/me`, logout, `proovra_session` cookie via `signJwt` / `verifyJwt`. |
| `services/api/src/routes/sso-auth.routes.ts` | ~362 | Phase 26.5 end-user SSO entrypoints — OIDC/SAML initiate + callback with state-token replay protection, IdP outage tracking, JIT provisioning, session recording. |
| `services/api/src/routes/identity.routes.ts` | ~906 | Phase 17 operator surface — member lifecycle, role changes, capability grants/revokes, delegated-admin scopes, service-account hardening, contributor-session revocation, org security policy, access-review queue, external-identity mappings. |
| `services/api/src/routes/identity-security.routes.ts` | ~530 | Phase 19 security operations — step-up challenge lifecycle, session revocation, trusted-device management, MFA policy read/update, risk snapshots. |
| `services/api/src/routes/scim.routes.ts` | ~351 | Phase 26 RFC 7644 SCIM v2 — Users + Groups CRUD; token auth via SCIM PAT (never accepts session JWT); idempotent create; soft-deactivate. |
| `services/api/src/routes/admin-identity.routes.ts` | ~954 | Workspace-admin governance — SSO provider lifecycle, permission/role matrices, temporary elevation, SCIM token management, active-session inventory, operator-driven risk remediation. |

**Verdict:** PROOVRA already ships substantial identity infrastructure. R8 must NOT create parallel auth route files.

---

## 2. MFA infrastructure — **PARTIAL**

### What exists
- `OrganizationSecurityPolicy.mfaPolicyLevel` Prisma field (`OFF / ADMIN_ONLY / OWNERS_ONLY / HIGH_RISK_ONLY / ALL`).
- `OrganizationSecurityPolicy.mfaRequiredFlag` boolean (legacy back-compat).
- `StepUpChallenge` Prisma model — initiated-by-userId, purpose, resource scope, status, TTL, approval timestamp. No raw OTP stored.
- `TrustedDevice` Prisma model — deviceIdHash, IP preview, UA preview, TTL-expiry, revocation audit.
- `requireStepUpForSensitiveAction` middleware — gates 29 sensitive actions.
- `mfa-policy.service.ts` — evaluates requirement per role + risk level + action override.
- `/v1/identity-security/mfa-policy` GET/PUT routes (step-up gated).

### What R8 inherits but DOES NOT yet ship
- **TOTP enrollment endpoint** — generate secret, QR code, store factor.
- **TOTP verification endpoint** — verify 6-digit code at login + at step-up.
- **`MfaFactor` Prisma model** — per-user enrolled authenticators.
- **Backup recovery codes** — generation, hashing, single-use consumption.
- **Login-time MFA enforcement middleware** — currently MFA enforcement fires only at step-up for sensitive actions, not at initial login.

R8's MFA deliverable is the **event vocabulary** + the audit acknowledging the gap. Actual TOTP implementation is deferred to a dedicated phase that ships `otplib` integration + `MfaFactor` migration + per-user secret storage + verification math.

---

## 3. SSO / SAML — OIDC is **REAL**, SAML is **STUB**

### OIDC (REAL, working)
- `SsoConnection` Prisma model — per-org OIDC config (issuerUrl, hashed clientSecret, allowedEmailDomains, JIT default role, outage tracking).
- `handleOidcCallback` — OIDC code exchange + domain gate + JIT provisioning.
- `buildOidcAuthorizationUrl` — OIDC authorization URL with state token.
- `SsoCallbackAttempt` model — state token + replay protection.
- `ExternalIdentityMapping` — links users to external subject IDs.

### SAML (STUB only)
- `SsoConnection.samlMetadataJson` field exists but is **never parsed or used**.
- No SAML metadata ingestion endpoint.
- No SAML SP callback.
- No SAML assertion validation.
- No AttributeStatement → claim mapping.

R8's SAML deliverable is the **event vocabulary** + the audit acknowledging the stub. Actual SAML SP implementation is deferred to a dedicated phase that ships `@node-saml/node-saml` (or `passport-saml`) integration + AttributeStatement mapping + signature validation + certificate handling.

---

## 4. SCIM — **REAL**

- `services/api/src/routes/scim.routes.ts` (~351 lines) — RFC 7644 compliant Users + Groups CRUD.
- `authenticateScimRequest` — Bearer `scim_pat_*` PAT verification, scopes, team isolation.
- Idempotent create, soft-deactivate, filter parsing, proper SCIM error envelope.
- Implementation in `scim.service.ts` + `scim-groups.service.ts`.
- SCIM tokens issued via `/v1/admin/identity/scim/tokens` (POST/revoke).

### What R8 inherits but DOES NOT yet ship
- Group-membership sync driver (business-logic mapping SCIM Groups → roles + delegated-admin scopes).
- HR system connectors (Okta / Azure AD / OneLogin metadata flows beyond the generic SCIM endpoint).

R8's SCIM deliverable is the **event vocabulary** (`scim_user_provisioned`, `scim_user_deprovisioned`, `scim_group_synced`) so future sync drivers emit consistent audit events.

---

## 5. Security event / SIEM — **REAL** (two-tier)

### `PlatformAuditLog` (chain-linked, decision audit)
- `services/api/src/services/platform-audit-log.service.ts` (~15 KB).
- Chain-linked entries: userId, action, category, severity, source, outcome, resourceType, resourceId, requestId, sanitized metadata, hash, prevHash (Merkle-style chain).
- Max metadata size 5120 bytes.
- Audit categories include `auth`, `webhook_management`, `enterprise`, `governance`, etc.

### `SecurityEvent` (operational signals)
- `services/api/src/services/security/security-event.service.ts` (~14 KB).
- Workspace-scoped operational signals — rate-limit hits, anomalies, suspicious activity.
- INTERNAL only (never on public verify).
- Event types from bounded `SECURITY_EVENT_TYPES` in `packages/shared/src/security.ts`.
- Severity from `SECURITY_EVENT_SEVERITIES` = `["INFO", "WARNING", "HIGH"]`.
- Best-effort emission; failures don't break flow.

### Existing bounded `SECURITY_EVENT_TYPES`
Categories include capture/upload anomalies, scanner unavailability, communication operations, Phase 17 member lifecycle, Phase 18 communications, Phase 19 step-up + MFA policy, Phase 22 workflow, Phase 24 search, Phase 25.7 governance. The vocabulary already covers most identity-adjacent events.

### What R8 adds
14 new identity-side event types extending `SECURITY_EVENT_TYPES` (covered in §1 of `R8_ENTERPRISE_IDENTITY_SECURITY.md`).

---

## 6. Permission / capability model — canonical

- Capabilities live in **`envelope.capabilities`** (JWT scope; populated by `services/api/src/services/platform-context.service.ts`).
- Route access checked via `requireAuthorize` middleware (`services/api/src/middleware/authorize.ts`) — thin bridge to Phase 17 access-policy engine.
- `evaluateMemberAccess` (`services/api/src/services/access-policy.service.ts`) consults member role + delegated-admin scope + explicit capability grants + governance gates.
- Inline `authorizeOrFail` pattern used in routes like identity.routes.ts and identity-security.routes.ts.

**Hard contract (preserved through R7 + verified in R8 tests):** workflow / persona NEVER drives authorization. Only member role + delegated scope + explicit grant + capability map.

---

## 7. Tenant isolation guards

- **`requireIdentityActor`** (identity.routes.ts ~lines 123-154) — takes `teamId` + `permission`. Checks membership via `prisma.teamMember.findUnique({ teamId_userId: { teamId, userId } })`. Returns 404 if non-member (anti-enumeration). Evaluates `evaluateMemberAccess`. Returns 403 with structured deny reason if denied.
- **`requireSecurityActor`** (identity-security.routes.ts ~lines 98-133) — same pattern for security-center routes.
- **`requireMember`** — generic membership gate used by most operational routes (e.g. dashboard, cases, evidence).
- **`requireAuthorize`** — capability gate used by routes that need a specific permission beyond membership.

All canonical. R8 must NOT introduce new tenant guards that bypass these.

---

## 8. Web admin/identity pages (8 pages under `/admin/identity/`)

| Page | Lines | Purpose |
| --- | --- | --- |
| `admin/identity/page.tsx` | ~118 | Root console — members + service accounts + access-review queue + org security policy (MFA/SSO/SCIM intent flags). |
| `admin/identity/access-reviews/page.tsx` | ~272 | Access-review queue UI — list, filter by status/kind, decision workflow, regenerate trigger. |
| `admin/identity/permission-matrix/page.tsx` | ~297 | Role × permission grid snapshot + subject-user capability grants view. |
| `admin/identity/providers/page.tsx` | ~513 | SSO provider lifecycle — create/edit OIDC/SAML/Okta, manage status, callback hardening, outage tracking. |
| `admin/identity/runtime/page.tsx` | ~449 | Runtime posture — session inventory, risk assessment, quarantine, adaptive auth, geo intelligence. |
| `admin/identity/scim/page.tsx` | ~351 | SCIM token management — list/create/revoke + token preview + scope display. |
| `admin/identity/sessions/page.tsx` | ~289 | Session inventory — list active sessions, revoke, revoke-all, session scoring, device trust. |
| `admin/identity/timeline/page.tsx` | ~257 | Admin audit log + security event timeline — filter by type/severity, actor, resource, chain verification. |

R8 does NOT redesign these surfaces. Visual polish is R10 work.

---

## 9. Phase 17 identity console (workspace-level)

`apps/web/app/(app)/identity/page.tsx` (~427 lines) — workspace member self-view + read-only posture. Distinct from `/admin/identity/*` (which is the operator control plane). Calls `/v1/identity/{members, service-accounts, access-reviews, policy}`.

Per CR1 review, this page was flagged for fold-into `/admin/identity` decision; CR1 deferred to CR2 (UX-level decision). R8 leaves it untouched.

---

## 10. Honest scaffolding-vs-real ratings

| Component | Rating | Reasoning |
| --- | --- | --- |
| **MFA** | **PARTIAL** | Policy + step-up plumbing exist; TOTP enrollment/verification + per-user factor model missing. |
| **OIDC/SSO** | **REAL** | Full end-to-end: discovery, authorization URL, code exchange, JIT, state replay-protection, callback hardening, session recording, external-identity mapping. |
| **SAML** | **STUB** | Metadata JSON field exists but unparsed. No SP bootstrap, no assertion validation, no AttributeStatement mapping. |
| **SCIM** | **REAL** | RFC 7644 compliant Users + Groups CRUD, token auth, soft-deactivate, filter parsing. |
| **Security Events** | **REAL** | Two-tier model in place. R8 extends with bounded identity vocabulary. |
| **Step-up challenges** | **REAL** | Full plumbing — purposes, status, TTL, audit. |
| **Trusted devices** | **REAL** | Model + APIs in place. |
| **Adaptive auth / risk scoring** | **REAL** | Risk snapshots + quarantine + reconciliation cron. |

---

## 11. R8 inheritance summary

R8 inherits a **mature session + OIDC + SCIM + step-up + adaptive-auth foundation**. The step-up + MFA-policy layer is operationally ready; capability authority + tenant isolation are canonical and tested.

What R8 MUST build (deferred to dedicated implementation phases, not this audit):
- TOTP enrollment + verification + per-user factor model + backup codes.
- SAML SP bootstrap (metadata parsing, assertion validation, AttributeStatement mapping).
- SCIM group-membership sync driver.

What R8 builds in THIS phase (documented + tested):
- **Bounded identity-event vocabulary** extension to `SECURITY_EVENT_TYPES`.
- **This audit document** + **the R8 final report** (`R8_ENTERPRISE_IDENTITY_SECURITY.md`).
- **Guardrail tests** pinning no parallel auth, no parallel SCIM, no tenant crossover, no raw secret/token logging anti-patterns, no workflow/persona auth regression.

The platform does NOT pretend to ship full TOTP / SAML SP / SCIM group sync in R8. Each is honestly named as a follow-on implementation phase.
