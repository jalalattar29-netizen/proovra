# Phase 2C-C — Final LOW Drift Audit for Remaining 22 Findings

## Scope

- This audit covers only the remaining **22 LOW** findings left after Phase 2C-B and Phase 2C-B test cleanup.
- No schema changes, no migrations, and no runtime edits were made in this step.

## Evidence Base

- Preserved live schema-audit snapshot: `D:\digital-witness\tmp_phase2b_audit.json`
- Preserved Phase 2C-A DB precheck artifact: `D:\digital-witness\tmp_phase2c_a_db_prechecks.json`
- Current Prisma schema: `services/api/prisma/schema.prisma`
- Current runtime write/read paths under `services/api/src`

## Important Limitation

- A fresh local DB rerun was attempted on June 28, 2026, but `localhost:5432` was not reachable and Docker Desktop never exposed a working engine/socket in this session.
- Because of that, this document uses the preserved live audit snapshot as the DB source of truth for the 22 findings.
- For **21** of these 22 findings, the live snapshot class is `NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL`. That means the live DB-side metadata already established the column as `NOT NULL`; effective null-row count is therefore `0` by constraint, even though a fresh standalone `COUNT(*) WHERE col IS NULL` rerun was blocked in this session.
- For `media_intelligence_records.provider_confidence`, the preserved Phase 2C-A precheck artifact additionally captured concrete metadata and `nullRows = 0`.

## Decision Summary

- `1. Prisma should match DB`: **16**
- `2. DB should match Prisma`: **1**
- `3. Intentional mismatch`: **1**
- `4. Defer/manual`: **4**

## Per-Item Audit

| # | Item | DB evidence used here | Runtime path audit | Business meaning of `null` vs required | Decision | Recommended final action | Safe now |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `team_members.access_granted_at_utc` | Live snapshot says `NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL` | `workspace-bootstrap.service.ts`, `scim.service.ts`, `sso.service.ts`, and `teams.routes.ts` create/upsert memberships without explicitly setting `accessGrantedAtUtc`; `identity/rbac.service.ts` reads it and `restoreMember` does not restamp it | `null` originally meant “grant time not explicitly tracked” for pre-Phase-17 / bootstrap / invite / JIT flows; forcing Prisma required would bless synthetic grant dates without first reviewing default/backfill history | `4` | Keep out of automatic cleanup; inspect live default/backfill semantics first | No |
| 2 | `workspace_governance_policies.metadata_redaction_default` | Live snapshot says both prior type-drift history and current LOW optionality; LOW class still means DB-side `NOT NULL` | No current route/service authoring path writes this field; `governance.service.ts::loadRedactionPolicy` treats missing/falsy override as “use default policy” | App-layer meaning is still “override may be absent”; the feature is effectively dormant and the field is not part of the current policy update payload | `3` | Leave intentionally mismatched for now; revisit only when a real metadata-redaction authoring surface is added and live stored value shape is directly inspected | No |
| 3 | `upload_sessions.team_id` | Live snapshot says DB `NOT NULL` | `evidence.service.ts` calls `ensureUploadSession` with `effectiveTeamId`; `upload-session.service.ts` mirrors evidence ownership and all read paths are workspace-scoped | `null` is only stale defensive typing on the service input; current business meaning is always workspace-owned, including personal workspaces | `1` | Tighten Prisma to required; optionally tighten helper input type from `string | null` to `string` | Yes |
| 4 | `evidence_intelligence_jobs.team_id` | Live snapshot says DB `NOT NULL` | `intelligence/extraction.service.ts` creates job rows with `teamId: input.teamId` on every path | `null` no longer carries active meaning; jobs are workspace-anchored operational rows | `1` | Tighten Prisma to required | Yes |
| 5 | `evidence_extracted_texts.team_id` | Live snapshot says DB `NOT NULL` | `intelligence/extraction.service.ts` writes `teamId` on skipped, failed, and completed rows; later comment mentions null only for legacy enqueue defensiveness | `null` is legacy baggage, not a live writer contract | `1` | Tighten Prisma to required | Yes |
| 6 | `evidence_entities.team_id` | Live snapshot says DB `NOT NULL` | `intelligence/entity-extraction.service.ts` `createMany` writes `teamId: input.teamId` for every row | `null` has no current domain meaning; entity extraction is workspace-scoped | `1` | Tighten Prisma to required | Yes |
| 7 | `evidence_semantic_chunks.team_id` | Live snapshot says DB `NOT NULL` | `intelligence/semantic.service.ts` creates every chunk with `teamId: input.teamId`; downstream search is explicitly team-scoped | `null` is stale defensive typing only | `1` | Tighten Prisma to required | Yes |
| 8 | `evidence_similarities.team_id` | Live snapshot says DB `NOT NULL` | `intelligence/similarity.service.ts` accepts nullable input, but actual detectors derive `teamId` from canonical evidence rows and all reads are workspace-scoped | `null` is not a real live business state anymore; it is a legacy helper signature | `1` | Tighten Prisma to required; mechanically tighten helper input type if needed | Yes |
| 9 | `discussion_threads.team_id` | Live snapshot says DB `NOT NULL` | `collaboration/discussion.service.ts::createDiscussionThread` writes `teamId`, and the service rejects cross-workspace thread use | `null` has no intended meaning on canonical discussion threads | `1` | Tighten Prisma to required | Yes |
| 10 | `discussion_messages.team_id` | Live snapshot says DB `NOT NULL` | `collaboration/discussion.service.ts::postMessage` writes `teamId: thread.teamId` | `null` is not part of the active message model | `1` | Tighten Prisma to required | Yes |
| 11 | `discussion_participants.team_id` | Live snapshot says DB `NOT NULL` | `collaboration/discussion.service.ts` writes `teamId` on creator, assignee, and contributor participant rows | `null` has no active business meaning on the participant roster | `1` | Tighten Prisma to required | Yes |
| 12 | `evidence_exchange_package_deliveries.channel` | Live snapshot says DB `NOT NULL` | `exchange/evidence-exchange.service.ts::recordPackageDelivery` always writes `channel`, defaulting to `"SIGNED_URL"` | `null` is not meaningful; delivery channel is always known at write time | `1` | Tighten Prisma to required | Yes |
| 13 | `evidence_exchange_package_deliveries.delivered_at_utc` | Live snapshot says DB `NOT NULL` | `recordPackageDelivery` does not explicitly write `deliveredAtUtc`; `signed-delivery.service.ts` still falls back to legacy `deliveredAt` when projecting | `null` on the Prisma side still represents “use legacy deliveredAt fallback”; this duplicate timestamp surface is not yet cleanly canonicalized | `4` | Defer until `deliveredAt` vs `deliveredAtUtc` ownership is simplified and the live default/backfill strategy is reviewed | No |
| 14 | `trust_center_articles.team_id` | Live snapshot says DB `NOT NULL` | `trust/trust-center.service.ts` upserts by `(teamId, kind, slug)` and all reads are workspace-filtered | `null` has no live tenancy meaning on trust articles | `1` | Tighten Prisma to required | Yes |
| 15 | `trust_center_article_versions.team_id` | Live snapshot says DB `NOT NULL` | `trust/trust-center.service.ts` writes `teamId: input.teamId` on every version row | `null` is not a current business state | `1` | Tighten Prisma to required | Yes |
| 16 | `subprocessors.team_id` | Live snapshot says DB `NOT NULL` | `trust/subprocessor.service.ts` upserts by `(teamId, slug)` and always writes `teamId` | `null` no longer reflects the runtime model | `1` | Tighten Prisma to required | Yes |
| 17 | `subprocessor_versions.team_id` | Live snapshot says DB `NOT NULL` | `trust/subprocessor.service.ts` writes `teamId: input.teamId` for every version row | `null` is not an active semantic state | `1` | Tighten Prisma to required | Yes |
| 18 | `status_components.team_id` | Live snapshot says DB `NOT NULL` | `trust/status-page.service.ts::upsertStatusComponent` upserts by `(teamId, key)` and always writes `teamId` | `null` is stale optionality; status components are per-workspace | `1` | Tighten Prisma to required | Yes |
| 19 | `departments.organization_id` | Live snapshot says DB `NOT NULL` | `governance/department.service.ts::createDepartment` requires `organizationId`, but schema/service comments still describe this as additive nullable legacy shape and projections coalesce null | `null` may still represent old org-unbound rows in historical/runtime assumptions; governance hierarchy semantics are too important to tighten blindly | `4` | Defer for direct live inspection plus follow-up cleanup of the nullable-legacy assumptions in service comments/projections | No |
| 20 | `delegated_admin_grants.organization_id` | Live snapshot says DB `NOT NULL` | `governance/delegated-admin.service.ts::grantDelegatedAdmin` requires `organizationId`, but the same file still documents org-less grants for workspace-only tiers and projections coalesce null | Current code comments and runtime contract disagree; this is a real semantic conflict, not just stale Prisma optionality | `4` | Defer/manual; resolve whether org-less delegated grants are still allowed before changing either side | No |
| 21 | `media_intelligence_records.provider_confidence` | Preserved Phase 2C-A precheck shows DB `NOT NULL / double precision / default null`, `totalRows = 0`, `nullRows = 0` | `media-intelligence.service.ts` usually writes a number, but `intelligence-quality.service.ts` explicitly models `providerConfidence` as nullable and skip-null averages are intentional | `null` is a real business state: provider omitted confidence, or legacy rows never had one. Treating null as 0 would distort analytics | `2` | Relax DB to nullable and keep Prisma optional | Yes |
| 22 | `security_claim_checks.last_verified_at` | Live snapshot says DB `NOT NULL` | `trust/security-claim-check.service.ts::runSecurityClaimChecks` always writes `lastVerifiedAt: now` on create and update; list path falls back to `createdAt` only for legacy safety | `null` is not part of the current business contract; it is just backward-compatible projection logic | `1` | Tighten Prisma to required | Yes |

## Count by Decision

- `1. Prisma should match DB`: 16
- `2. DB should match Prisma`: 1
- `3. Intentional mismatch`: 1
- `4. Defer/manual`: 4

## Safe Fixes

These **17** items can be safely fixed without reopening broader architectural questions:

### Safe Prisma tightenings

- `UploadSession.teamId`
- `EvidenceIntelligenceJob.teamId`
- `EvidenceExtractedText.teamId`
- `EvidenceEntity.teamId`
- `EvidenceSemanticChunk.teamId`
- `EvidenceSimilarity.teamId`
- `DiscussionThread.teamId`
- `DiscussionMessage.teamId`
- `DiscussionParticipant.teamId`
- `EvidenceExchangePackageDelivery.channel`
- `TrustCenterArticle.teamId`
- `TrustCenterArticleVersion.teamId`
- `Subprocessor.teamId`
- `SubprocessorVersion.teamId`
- `StatusComponent.teamId`
- `SecurityClaimCheck.lastVerifiedAt`

### Safe DB relaxation

- `MediaIntelligenceRecord.providerConfidence`

## Must Remain Intentional for Now

- `WorkspaceGovernancePolicy.metadataRedactionDefault`

Reason:

- Current runtime semantics still model this as “override may be absent”.
- There is no active authoring path for it in `governance.routes.ts`.
- The field also has prior type-drift history, so forcing either side now would be higher-risk than simply documenting the intentional mismatch.

## Defer / Manual Review Items

- `TeamMember.accessGrantedAtUtc`
- `EvidenceExchangePackageDelivery.deliveredAtUtc`
- `Department.organizationId`
- `DelegatedAdminGrant.organizationId`

## Recommended Safe Implementation Order

1. Ship the **16 schema-only Prisma tightenings** first.
2. Validate and typecheck.
3. Ship the **single DB-only** `provider_confidence` relaxation separately.
4. Leave the 5 non-safe items alone until their narrower follow-on audit is done.

## Exact Implementation Prompt for the Safe Subset Only

```text
TASK: Phase 2C-D — Implement the final safe LOW drift subset only

Context:
Use docs/operations/phase-2c-c-final-low-drift-audit.md as the source of truth.
Do NOT touch the deferred/manual items and do NOT touch the intentional-mismatch item.

Safe subset to implement:

Schema-only Prisma tightenings:
- UploadSession.teamId
- EvidenceIntelligenceJob.teamId
- EvidenceExtractedText.teamId
- EvidenceEntity.teamId
- EvidenceSemanticChunk.teamId
- EvidenceSimilarity.teamId
- DiscussionThread.teamId
- DiscussionMessage.teamId
- DiscussionParticipant.teamId
- EvidenceExchangePackageDelivery.channel
- TrustCenterArticle.teamId
- TrustCenterArticleVersion.teamId
- Subprocessor.teamId
- SubprocessorVersion.teamId
- StatusComponent.teamId
- SecurityClaimCheck.lastVerifiedAt

DB-only relaxation:
- media_intelligence_records.provider_confidence -> DROP NOT NULL

Do NOT change:
- TeamMember.accessGrantedAtUtc
- WorkspaceGovernancePolicy.metadataRedactionDefault
- EvidenceExchangePackageDelivery.deliveredAtUtc
- Department.organizationId
- DelegatedAdminGrant.organizationId

Rules:
- Keep the 16 Prisma tightenings schema-only unless a tiny mechanical compile fix is strictly required.
- If helper/service input types still say `string | null` for fields whose live writers are now canonical `string`, tighten only those local types mechanically; do not change runtime behavior.
- Put `provider_confidence` in its own tiny additive-safe migration batch.
- Do NOT bundle unrelated LOW findings.
- Do NOT change runtime semantics.
- Do NOT invent historical timestamps.

Validation:
- pnpm --filter proovra-api exec prisma validate
- pnpm --filter proovra-api exec prisma generate
- pnpm --filter proovra-api run typecheck
- run focused tests for upload/reliability, intelligence, collaboration, exchange, trust, and security-claim-check surfaces

Final report:
- exact fields tightened in Prisma
- exact migration created for provider_confidence
- any tiny mechanical type fixes required
- validation results
- focused test results
- confirmation the 5 holdout items were untouched
```

## Final Recommendation

- The remaining LOW drift does **not** need one more blanket cleanup.
- The safe subset is now clear:
  - 16 schema-only Prisma tightenings
  - 1 DB relaxation (`provider_confidence`)
- `metadataRedactionDefault` should remain intentional until the feature is reactivated with a real write surface.
- The 4 deferred items should wait for narrower, semantics-first follow-up tasks.
