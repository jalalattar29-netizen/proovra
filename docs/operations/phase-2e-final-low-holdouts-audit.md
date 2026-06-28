# Phase 2E — Final LOW Holdouts Audit

## Scope

- Audit only the final 5 LOW holdouts left after Phase 2C-D.
- Do not implement holdout fixes here.
- Do not create migrations for holdouts here.
- Do not modify holdout runtime logic here.

## Holdouts

1. `TeamMember.accessGrantedAtUtc`
2. `WorkspaceGovernancePolicy.metadataRedactionDefault`
3. `EvidenceExchangePackageDelivery.deliveredAtUtc`
4. `Department.organizationId`
5. `DelegatedAdminGrant.organizationId`

## Evidence Base

- Preserved live audit snapshot: `D:\digital-witness\tmp_phase2b_audit.json`
- Preserved Phase 2C-A precheck artifact: `D:\digital-witness\tmp_phase2c_a_db_prechecks.json`
- Current Prisma schema: [schema.prisma](/D:/digital-witness/services/api/prisma/schema.prisma)
- Current runtime paths under `services/api/src`
- Migration history under `services/api/prisma/migrations`

## Important Limitation

- A fresh read-only DB rerun was attempted on June 28, 2026.
- Docker was unavailable in this session and direct Postgres resolution for host `postgres` failed with `getaddrinfo ENOTFOUND postgres`.
- Because of that, fresh read-only `COUNT(*) WHERE column IS NULL` queries could not be rerun in-session for these 5 holdouts.
- This audit therefore uses preserved live audit metadata plus direct runtime and migration-path review.

## Phase 2C-D Runtime Safety Review

Reviewed runtime files changed during Phase 2C-D:

- `services/api/src/services/evidence-complete.service.ts`
- `services/api/src/services/intelligence/entity-extraction.service.ts`
- `services/api/src/services/intelligence/extraction.service.ts`
- `services/api/src/services/intelligence/semantic.service.ts`
- `services/api/src/services/intelligence/similarity.service.ts`
- `services/api/src/services/reliability/upload-session.service.ts`
- `services/api/src/services/security/file-security-scan.service.ts`

Verdict:

- The runtime diffs reviewed in Phase 2C-D are mechanical/type-only.
- They tighten local TypeScript assumptions around already-canonical non-null workspace ownership fields.
- No reviewed diff changed write semantics, branching, persistence shape, tenancy rules, or lifecycle rules.
- The remaining edits needed in this task are limited to stale test expectations and this audit document.

## Holdout Audit Table

| Field | Preserved DB signal | Runtime write/read evidence | Meaning of null today | Final decision | Safe to implement now |
| --- | --- | --- | --- | --- | --- |
| `TeamMember.accessGrantedAtUtc` | Live audit recorded `NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL` | Membership create/upsert paths in `workspace-bootstrap.service.ts`, `scim.service.ts`, `saml-user-mapping.service.ts`, and `teams.routes.ts` do not set it. `identity/rbac.service.ts` reads it as `Date | null`, and `restoreMember` does not restamp it. Repo migration `20260526100000_add_identity_phase17` adds the column with no repo-visible default. | Null still means "grant timestamp not authoritatively captured by the app path." | Manual/design decision. Do not tighten Prisma or relax DB until live default/backfill semantics are directly inspected. | No |
| `WorkspaceGovernancePolicy.metadataRedactionDefault` | Prior live drift included a type mismatch history; current LOW state is only the optionality mismatch. Repo migration `20260517100000_add_governance_phase9` created JSONB, and `20270906060000_phase_2b_7_json_semantic_repairs` only auto-converts if all live booleans are null. | `governance.service.ts::loadRedactionPolicy` selects only this field and returns `DEFAULT_REDACTION_POLICY` whenever it is absent/falsy or unreadable. No active authoring path was confirmed in this audit. | Null/absence still means "no override; use default policy." | Intentional mismatch for now. Keep Prisma optional until a real authoring surface exists and the live stored shape is re-inspected directly. | No |
| `EvidenceExchangePackageDelivery.deliveredAtUtc` | Live audit recorded `NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL`. Repo migration `20261230000000_phase_4b_packaging_and_lifecycle` created it `NOT NULL DEFAULT NOW()`. | `exchange/evidence-exchange.service.ts::recordPackageDelivery` creates delivery rows without explicitly writing `deliveredAtUtc`. `exchange/signed-delivery.service.ts` still projects `r.deliveredAtUtc ?? r.deliveredAt`. | Prisma-side optionality still reflects duplicate timestamp-era fallback semantics between `deliveredAtUtc` and legacy `deliveredAt`. | Manual/design decision. First collapse the canonical ownership of the two delivery timestamps, then revisit Prisma tightening. | No |
| `Department.organizationId` | Live audit recorded `NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL`. Repo migration `20261220000000_phase_4a_trust_and_governance` created `departments.organization_id` as `UUID NOT NULL` with org-scoped indexes. | `governance/department.service.ts::createDepartment` requires and writes `organizationId`. `listDepartments` still coalesces `r.organizationId ?? ""` and carries an old additive-nullability comment. | Null no longer appears to be a desired business state; the nullable behavior in code looks like compatibility scaffolding, not an active model. | Prisma should match DB, but audit-only for now. This looks like a likely-safe future Prisma tightening once the stale compatibility comment/projection is cleaned up in the same narrow change. | Not in this task |
| `DelegatedAdminGrant.organizationId` | Live audit recorded `NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL`. Repo migration `20261220000000_phase_4a_trust_and_governance` created `delegated_admin_grants.organization_id` as `UUID NOT NULL` with org-scoped indexes. | `governance/delegated-admin.service.ts::grantDelegatedAdmin` requires and writes `organizationId`. However, `listDelegatedGrants` still coalesces `r.organizationId ?? ""` and comments claim org-less grants may exist for `WORKSPACE_ADMIN`. | Runtime writers treat org as required, but comments/projection still describe an older org-less mental model. | Manual/design decision. The writer/DB shape and the service commentary conflict, so the intended semantic model must be explicitly settled before tightening Prisma. | No |

## Decision Summary

- `Prisma should match DB`: 1 clear candidate now
  - `Department.organizationId`
- `Intentional mismatch`: 1
  - `WorkspaceGovernancePolicy.metadataRedactionDefault`
- `Manual/design decision`: 3
  - `TeamMember.accessGrantedAtUtc`
  - `EvidenceExchangePackageDelivery.deliveredAtUtc`
  - `DelegatedAdminGrant.organizationId`

## Which Items Are Safely Fixable

Potentially safe after one narrow follow-up review:

- `Department.organizationId`

Why it is the closest safe candidate:

- The DB and create path already treat it as required.
- The model itself is organization-rooted by design.
- The remaining nullable behavior is confined to compatibility comments and projection coalescing.

Why it still is not implemented here:

- This task is audit-only.
- Fresh live DB inspection was unavailable in-session.
- The narrow follow-up should intentionally clean up the stale nullable compatibility language at the same time so the contract becomes unambiguous.

## Which Items Must Remain Intentional

- `WorkspaceGovernancePolicy.metadataRedactionDefault`

Reason:

- The runtime default-resolution path still treats the override as optional.
- The field has prior semantic type-drift history.
- There is no confirmed active authoring flow in this audit to prove the stored non-null shape is the canonical application contract.

## Which Items Need Manual or Explicit Design Review

- `TeamMember.accessGrantedAtUtc`
  - Needs direct live inspection of default/backfill history before changing either DB or Prisma.
- `EvidenceExchangePackageDelivery.deliveredAtUtc`
  - Needs timestamp-surface canonicalization between `deliveredAtUtc` and legacy `deliveredAt`.
- `DelegatedAdminGrant.organizationId`
  - Needs an explicit decision on whether org-less workspace-scoped grants are still part of the intended governance model or just stale comments.

## Recommended Safe Subset Prompt

Only one holdout looks like a candidate for a later narrow safe change, and it still should be done as its own follow-up:

```text
TASK: Final LOW holdout cleanup — Department.organizationId only

Audit basis:
- docs/operations/phase-2e-final-low-holdouts-audit.md

Goal:
- Tighten Prisma only for Department.organizationId so it matches the live DB and current department create path.

Rules:
- Do not touch the other 4 holdouts.
- Do not create any DB migration unless fresh live inspection proves one is needed.
- Prefer a schema-only Prisma tightening if the live DB still shows departments.organization_id as NOT NULL with no null rows.
- If typecheck requires it, make only tiny mechanical follow-up edits in department projection/comments to remove stale nullable compatibility wording.
- Do not change runtime behavior or department authorization logic.

Validation:
- pnpm --filter proovra-api exec prisma validate
- pnpm --filter proovra-api exec prisma generate
- pnpm --filter proovra-api run typecheck
- run only focused governance tests that cover department creation/listing and department-scope enforcement

Final report:
- whether Department.organizationId was tightened in Prisma
- whether any tiny projection/comment cleanup was needed
- validation results
- confirmation the other 4 holdouts were untouched
```

## Final Conclusion

- The Phase 2C-D runtime changes reviewed here remain mechanical/type-only.
- No holdout should be changed blindly from this audit alone.
- `Department.organizationId` is the only holdout that currently looks like a strong future safe candidate.
- `WorkspaceGovernancePolicy.metadataRedactionDefault` should remain intentionally mismatched for now.
- `TeamMember.accessGrantedAtUtc`, `EvidenceExchangePackageDelivery.deliveredAtUtc`, and `DelegatedAdminGrant.organizationId` still require either direct live inspection or an explicit semantic decision before any implementation step.
