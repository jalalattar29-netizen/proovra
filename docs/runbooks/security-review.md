# Security review / procurement checklist

> A checklist for procurement and security-review teams. It links the
> platform's existing, **honest** documentation and summarizes posture
> by area. It uses honest language only.
>
> **No-certification disclaimer.** Unless a specific attestation has
> been **separately obtained and independently verified**, this
> platform does **not** claim SOC 2, ISO 27001, or any other
> third-party certification, and does **not** claim to have passed a
> penetration test. This checklist reports **configuration posture**,
> not certification.

## Authoritative source documents

The following documents are maintained in the repository and are the
authoritative text. This checklist only summarizes and links them.

| Area | Document |
|------|----------|
| Security overview | `apps/web/content/legal/en/security.md` |
| Incident response | `apps/web/content/legal/en/incident-response.md` |
| Technical & organizational measures (TOMs) | `apps/web/content/legal/en/toms.md` |
| Data processing agreement (DPA) | `apps/web/content/legal/en/dpa.md` |
| Subprocessors | `apps/web/content/legal/en/subprocessors.md` |
| Verification methodology | `apps/web/content/legal/en/verification-methodology.md` |
| Evidence handling | `apps/web/content/legal/en/evidence-handling.md` |
| Public trust center | `apps/web/app/trust/page.tsx` |

## Posture summary by area

### Evidence integrity
- Evidence is hashed and signed; verification packages and reports are
  deterministic and reproducible. See `verification-methodology.md` and
  the reproducibility verifier
  (`POST /v1/operations/exports/:id/verify`).
- Immutable preservation via S3 Object Lock, honestly surfaced (a
  bucket that does not support Object Lock reports
  `claimed-but-unsupported`, never a fake "verified").

### Encryption
- Transport and at-rest encryption posture is described in
  `security.md` / `toms.md`. Storage endpoint safety is enforced at
  startup (production refuses insecure/localhost S3 endpoints unless
  explicitly acknowledged — `services/api/src/config/index.ts`).

### SSO / SCIM / MFA
- SSO (SAML / OIDC), SCIM provisioning, and MFA are supported and
  configured per-tenant. SSO health is probed operationally.
  Configuration surfaces are linked from the org security tab; see
  `security.md`.
- **Known limitation:** in-memory login/MFA-attempt throttling is
  per-instance — multi-instance deployments should front with a shared
  rate-limiter (`services/api/src/services/rate-limit.ts`).

### Audit
- A hash-chained platform audit log records sensitive access (chain
  verification via `verifyAdminAuditChain`). Access to the readiness
  posture itself emits a platform audit event.

### Retention
- Retention policies (including immutable retention) are enforced by
  the retention engine; destruction of immutable records is refused.
  See `evidence-handling.md`.

### External reviewer access
- Scoped, time-limited external reviewer portal access is supported.
  See `security.md` / `verification-methodology.md`.

### Backup & DR
- Evidence object preservation: **configured** (Object Lock, verifiable
  live status).
- Database backup: **managed-platform assumption** — there are no
  repo-level automated backup scripts; the managed platform's backup
  facility must be configured and test-restored by the operator. See
  `docs/runbooks/disaster-recovery.md`.
- Full DR rehearsal / cross-region failover: **infrastructure-layer**,
  out of application scope.

## Reviewer checklist

- [ ] Reviewed `security.md`, `incident-response.md`, `toms.md`,
      `dpa.md`, `subprocessors.md`, `verification-methodology.md`,
      `evidence-handling.md`.
- [ ] Reviewed the live posture at `/operations/readiness`
      (platform-admin) or `GET /v1/operations/readiness`.
- [ ] Confirmed Object Lock live status and DB-backup honesty label.
- [ ] Confirmed SSO/SCIM/MFA configuration for the tenant.
- [ ] Acknowledged the stated known limitations.
- [ ] Understood that **no** certification or penetration-test pass is
      claimed unless separately and independently verified.

## What this document does NOT claim

- No SOC 2 / ISO 27001 certification.
- No penetration-test pass.
- No uptime percentage or SLA.
