# Evidence output lifecycle (2026-09-29)

Branch `fix/evidence-output-lifecycle`. **Nothing here is deployed, migrated
in production, backfilled, or pushed to `main`.** The live incident (Sentry
150024171, `InvalidRequest … Content-MD5`, report v7 / package failed) is
**not resolved** until a deployed worker publishes and verifies a package in
the real Object Lock bucket.

## 1. Policy (fixed decisions)

| | Rule |
|---|---|
| **A** | Original evidence is established at **finalization** (hash, signature, TSA, OTS, custody). A Free record is finalized fully and shows **Not issued** for the report and package. After a **confirmed paid** subscription, the first report and its package are scheduled automatically and idempotently, dated on the day they are issued. A downgrade preserves issued artifacts; re-upgrading issues nothing twice. Credits fund new evidence capacity only. |
| **B** | Basic public Verify is independent of the owner's subscription: per component `verified / pending / failed / not issued / not checked`, with no bytes, title, filename, case, personal data or URL. The rich view and downloads stay gated. |
| **C** | One lifecycle coordinator; each component is independently retryable. Recovery repairs **only the missing component** (report v7 + package v2 → package **v7**, never report v8). An updated report is a separate, explicit action with a reason. TSA/OTS and billing changes never mint report versions. |

## 2. The one issuance decision

`resolveOutputIssuanceEntitlement({ plan, funding, lifecycle })`
(`packages/shared-billing/src/plan-catalog.ts`) returns
`ENTITLED | NOT_ENTITLED | UNRESOLVED` with a basis. Its inputs are read by
the shared `readCommercialLifecycle` (`packages/shared-runtime`) through two
thin adapters: the API's `evidence-output-eligibility.service.ts` and the
worker's `output-issuance.ts`.

* `UNRESOLVED` (any input unreadable) → nothing is issued; the worker retries
  later; the UI says **Subscription check pending**. The old guard failed open.
* `mayIssueHistoricalFirstOutputs` is true **only** for `PAID_SUBSCRIPTION` or
  an evidence credit. Trial, payment grace and pending checkouts schedule
  nothing retroactively.

## 3. Coordinator and component state

* **Writer:** `ReportGenerationRequest` with keys `REPORT:<id>:v<N>` /
  `VERIFICATION_PACKAGE:<id>:v<N>`. A repeat tick, a second replica or a racing
  click collapses onto one row.
* **Stages:** `REPORT_RESERVED` → `REPORT_COMMITTED` → `PACKAGE_PUBLISHED`.
  * The report is reserved in one transaction.
  * It is rendered, published and verified with **no transaction open**.
  * It is committed in a second transaction.
  * A lost reservation retries; it never double-issues.
* **Run modes:** `NEW_REPORT`, `PACKAGE_FOR_VERSION`.
* **Producers:**
  * Finalize.
  * `runFirstIssuanceReconciliation` (behind `withCronLock("lifecycle-recovery")`).
  * The user's explicit **Issue updated report** (`purpose: updated_report`, `reason` required, 3–120 characters).
  * Operator recovery.
* **Retired producers:**
  * OTS upgrade forced regeneration.
  * `enqueueReportJob`.
  * Regeneration in the TSA repair script.
* **Projection:** the shared projection is `packages/shared/src/evidence-output-lifecycle.ts`. It includes `ENTITLEMENT_UNAVAILABLE`, and a pair is complete when the package is `NOT_INCLUDED` or present at the latest report version.

## 4. Publication and package format

`publishImmutableArtifact` (`services/worker/src/immutable-publication.ts`):

* **Single write.** One PUT with `ChecksumSHA256`, `If-None-Match: *` and the Object Lock mode and retain-until. There is no staging PUT and no CopyObject (these were the two failing calls).
* **412 handling.** A 412 is accepted only when the stored checksum equals ours.
* **Deterministic refusals.** Codes such as `InvalidRequest` throw the non-retriable `VERIFICATION_PACKAGE_STORAGE_REJECTED` and raise a CRITICAL incident, `PACKAGE:<id>:v<N>:<class>`.
* **Read-back.** A HEAD by `VersionId` with checksum mode compares size, SHA-256, lock mode and retain-until.
* **Persisted fields.** The row stores `s3_version_id`, `package_sha256`, `package_format_version`, `report_issued_at_utc` and `custody_through_sequence`.
* **Download pinning.** Downloads pin `VersionId`.

**Package format 5 (sealed):**

* `package-seal.json` binds the SHA-256 of `package-checksums.json`, which lists every entry, including the embedded report PDF, whose digest must equal `reports.pdf_sha256`.
* The seal is signed with Ed25519 over the 32 raw digest bytes.
* `verifySealedPackageEntries` checks presence, signature, index binding, entry match, no unlisted entries, and report binding.
* Older packages carry a NULL format and are labelled as unsealed.

## 5. Migration

`20280730000000_evidence_output_lifecycle` and
`20280731000000_evidence_ots_anchor_check` (the nullable
`evidence.ots_anchor_check`, §12; separate because a committed migration is
never edited) — both EXPAND, additive, nullable, no backfill. Registered in the
deployment plan, curation, inventory (285 migrations, 0 gate failures) and the
security-event drift allowlist. Apply both before deploying the API and worker.

**Clean-boot rehearsal (2026-09-29):**

* **Environment.** Disposable `pgvector/pgvector:pg16`.
* **Migrations.** `prisma migrate deploy` from an empty database reported "All migrations have been successfully applied".
* **Drift check.** `db:drift-check` OK.
* **Raw schema check.** `db:raw-schema-verify` OK: 881 objects, 0 unregistered divergences.

## 6. Rollout order (each step needs separate owner authorization)

1. Apply the migration (EXPAND; safe before code).
2. Deploy the API, then the worker. Both flags default OFF, so no backfill
   starts. New finalizations and recent (≤7-day) confirmed-paid records are
   issued automatically.
3. **Validate on the real Object Lock bucket.** Have the deployed worker
   publish one package, and confirm the `VersionId`, checksum and retention by
   HEAD. Only after this succeeds may the incident be called resolved.
4. Run `output-reconciliation-dry-run.ts` against production (read-only) and
   review the groups and the repair plan with the owner.
5. Set `OUTPUT_PACKAGE_RECOVERY_ENABLED=true`. This repairs the missing
   package at the latest report version, including the v7/v2 incident record.
   Watch `pipeline.package_generation_failed`.
6. Set `OUTPUT_HISTORICAL_FIRST_ISSUANCE_ENABLED=true` only for confirmed-paid
   subjects (the decision already enforces this).
7. Run `destruction-certificate-audit.ts` (read-only). Correcting any V2
   certificate is a separate, authorized procedure: it is never automatic.

**Rollback:** code first. The flags go OFF immediately, and the columns are
inert to older builds.

## 7. Historical classification and read-only queries

The incident cards "Reports not requested: 26" and "Packages not requested:
95" mixed correct states (a Free record with nothing issued) with real gaps.
The new cards separate them:

* **Not issued (plan)**
* **First issuance pending**
* **Package missing for latest report**
* **Subscription check pending**

The summary and the list share one finalized population: not deleted, and not
trashed, pending destruction or destroyed.

```sql
-- 26: finalized, usable records with no report, by the owner's latest
-- subscription row (a hint only; the dry run applies the real decision)
SELECT coalesce(s.plan::text, 'NONE') AS plan, coalesce(s.status::text, 'NONE') AS status, count(*)
  FROM evidence e
  LEFT JOIN LATERAL (SELECT plan, status FROM subscriptions
                      WHERE user_id::text = e.owner_user_id::text
                      ORDER BY updated_at DESC LIMIT 1) s ON true
 WHERE e.status IN ('SIGNED','REPORTED') AND e.deleted_at IS NULL
   AND e.lifecycle_state IN ('ACTIVE','UNDER_REVIEW','ON_HOLD','RETENTION_LOCKED')
   AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.evidence_id = e.id)
 GROUP BY 1, 2 ORDER BY 3 DESC;

-- 95: latest report has no package at the same version (older package or none)
SELECT CASE WHEN older.v IS NULL THEN 'NO_PACKAGE' ELSE 'OLDER_PACKAGE_ONLY' END AS kind,
       count(*)
  FROM evidence e
  JOIN LATERAL (SELECT max(version) v FROM reports WHERE evidence_id = e.id) lr ON lr.v IS NOT NULL
  LEFT JOIN LATERAL (SELECT max(version) v FROM verification_packages WHERE evidence_id = e.id) older ON true
 WHERE e.deleted_at IS NULL
   AND e.lifecycle_state IN ('ACTIVE','UNDER_REVIEW','ON_HOLD','RETENTION_LOCKED')
   AND NOT EXISTS (SELECT 1 FROM verification_packages vp
                    WHERE vp.evidence_id = e.id AND vp.version = lr.v)
 GROUP BY 1;

-- Latest request state for those gaps (operator vs automatic)
SELECT q.artifact_type, q.state, q.terminal_reason_code, count(*)
  FROM report_generation_requests q
 WHERE q.created_at_utc = (SELECT max(created_at_utc) FROM report_generation_requests
                            WHERE evidence_id = q.evidence_id)
 GROUP BY 1,2,3 ORDER BY 4 DESC;
```

The authoritative per-record answer, which applies the real issuance decision
rather than the plan column, is the dry run:

```
pnpm --filter proovra-api ops:output-reconciliation-dry-run -- [--json]
```

The dry run writes nothing, prints ids truncated to 8 characters, and prints
the batches per rollout flag.

## 8. Updated report (correction procedure)

**Issue updated report** asks for a reason (web textarea; mobile input with
confirm disabled under 3 characters). The API returns 400
`UPDATED_REPORT_REASON_REQUIRED` without it. The new report records:

* `issue_kind = UPDATED_REPORT`
* `issue_reason`
* `previous_report_version`

It is dated on the day it is issued. Earlier versions stay unchanged, keep
their own dates, and remain downloadable, each pinned to its own S3 version.

## 9. Destruction

The destruction executor now works per object version:

* **Inventory first.** It inventories every object version before deleting anything.
* **Blocked cases.** A retained or legal-hold version blocks destruction (`OBJECT_LOCK_RETENTION_ACTIVE` / `LEGAL_HOLD_ACTIVE`).
* **Deletion.** Every version is deleted, then the versions are re-listed.
* **Certificate.** Certificate V3 records `destroyedVersionCount` and `ALL_OBJECT_VERSIONS_ABSENT`.
* **Past certificates.** V2 certificates are only inventoried, by `destruction-certificate-audit.ts`.

## 10. Clients, caching, locales

* **Web and PWA.** No service worker is registered (the manifest only), so there is no offline cache of Reports or Verify to invalidate. The public Verify response is `Cache-Control: no-store`.
* **Mobile.** The Basic Verify view, the "Not issued" copy, and the updated-report reason are at parity with web.
* **Locales.** The product ships English copy only; no i18n catalogues exist to update. The new strings live in the shared copy modules (`output-action-copy.ts`, `user-facing-errors.ts`).
* **Accessibility.** The reason input has a label and an accessible name. Summary cards that carry a filter are real buttons.

## 11. OTS state transitions

One pure rule, `decideOtsTransition` (`services/worker/src/ots-state.ts`),
decides how an observation changes a record's OTS state. The upgrade processor
applies every write compare-and-set (`applyOtsTransition`) against the exact
snapshot it decided from. A delayed job, a duplicate delivery or a concurrent
worker therefore cannot overwrite newer OTS facts; a stale observation is
discarded.

| Observation | Established by | Effect |
|---|---|---|
| `ANCHOR_PROVEN` | `ots verify` against the chain (`BITCOIN_VERIFIED`), or `ots info` offline showing the proof commits to this record's hash with a Bitcoin block attestation (`PROOF_STRUCTURE`) | `ANCHORED`, with the check recorded in `evidence.ots_anchor_check`. A stronger check replaces a weaker one, never the reverse. The anchor time is the block time when the chain check reports it, else the existing anchor time, else the observation time. |
| `PENDING` | a valid proof not (yet) anchored: incomplete or unknown | Never demotes a checked anchor. A legacy `ANCHORED` row whose anchor was never checked and which the re-check cannot confirm is demoted to `PENDING`, keeping its proof. An `ANCHORED` label is not kept just to avoid a downgrade. |
| `TRANSIENT_ERROR` | the attempt failed (network, timeout, calendar, missing binary) | **No OTS column changes.** An `OTS_ATTEMPT_ERROR` custody event is written and the job throws into its retry budget. This replaces the old behaviour of writing `FAILED` and clearing the anchor time. |
| `PROOF_INVALID` | the proof commits to another hash (`PROOF_HASH_MISMATCH`), or it is not an OpenTimestamps proof (`MALFORMED_PROOF`) | `FAILED` with that code; the stored proof is preserved. Terminal: never retried or resurrected. |
| `BUDGET_EXHAUSTED` | a `PENDING` proof that did not anchor within the global budget | `FAILED`, plus a CRITICAL incident. Never applied to an anchored row. |

The text-only "legacy heuristic" is removed: `ots upgrade` output alone no
longer promotes to `ANCHORED`. OTS recovery touches OTS only. It requests no
report and rewrites no issued PDF, and custody events are written only for
material changes.

## 12. The anchoring claim (`publicAnchoringVerified`)

`resolveOtsAnchorClaim` (`packages/shared/src/ots.ts`) is the only source of
the claim. The claim is **VERIFIED** only for an anchored record whose anchor
was verified against the Bitcoin chain. The other claims are:
- **ANCHORED_NOT_CHECKED**: a proof-structure anchor, or a historical anchor whose check was never recorded.
- **PENDING**: this includes an `ANCHORED` label with no anchor time.
- **FAILED**
- **UNAVAILABLE** and **NOT_CONFIGURED**

A status string, a txid, an anchor time or a pending operation never makes the
claim VERIFIED.

The same claim feeds every surface:
- the package manifest (`publicAnchoringVerified`, plus an explicit `anchoringClaim`);
- `anchor.json` and `opentimestamps.json` (`anchorCheck`, `anchorClaim`, `publicAnchoringVerified`);
- the package README;
- report PDF labels;
- the trust decision's `anchoringStatusLabel`;
- evidence intelligence;
- public Verify's basic tier (`not_checked` with basis `PROOF_COMMITS_TO_RECORD_CHAIN_NOT_CHECKED`);
- the web and mobile technical appendix, which prefer the server's `anchorClaim`.

The format-5 seal binds the manifest, so flipping the value is detected
(`ENTRIES_MATCH_INDEX`).

Historical packages are immutable and are not re-signed. Packages issued before
format 5 signed `publicAnchoringVerified` from "a txid or anchor time exists".
Every package in production today is in that set. The artifact history labels
them "older format; anchoring not chain-checked" rather than repeating their
claim.

## 13. Record conditions with no workspace row

A report/package failure for a Personal record stored with `team_id` NULL is
recorded as `LEGACY_UNSCOPED` with `team_id` NULL. It is deduplicated by
fingerprint and never shown on a tenant surface.

`resolveEvidenceWorkspaceId` (`packages/shared-runtime/src/workspace-scope.ts`)
is the exact inverse of the existing personal-workspace widening: such a record
belongs to its owner's personal workspace. The row is never assigned a team.
That workspace is used to:
- scope the durable request, both in the writer and in the worker's run-time
  tenancy re-check. Previously no request could ever be written for such a
  record;
- read the condition's source (`resolveIncidentSourceWorkspace`) for a manual
  resolve and for the scheduled `sweepUnscopedSourceTruthRecoveries`.

A platform operator (`requirePlatformAdmin`) can:
- list the condition with its exact target (component and report version);
- open `GET /v1/admin/incidents/:id` for the target, the record's workspace,
  the live source activity and recent events;
- invoke `POST /v1/admin/incidents/:id/remediate` with a required reason, audited.

Remediation runs the same canonical `requestOutputRecovery` as workspace
remediation, targeting exactly package vN. Without `supersede` it never retries
a deterministic terminal failure. The condition closes only when the probe
proves that exact component and version repaired; a wrong-version repair
leaves it open. The admin operations page shows the target and a Recover action.

## 14. Exchange packages

Every exchange kind, the provenance lookup and the manifest read through the
canonical workspace scope. A Personal record stored with `team_id` NULL is
included, with its latest report version and metadata. A stale or forged
package row naming another owner's or workspace's record builds without it:
the manifest records only an `excludedOutOfScope` count, never the ids.

At creation, a request naming a foreign or missing id is refused with one
answer (`INVALID_EVIDENCE`). A named case must be in the workspace and visible
to the requester under the restricted-case rule (`caseVisibleToWhere`, now
shared with Reports); otherwise the answer is `INVALID_CASE`.

## 15. Open gates

* Real AWS Object Lock validation. MinIO accepts a checksum-less PUT into a
  default-retention bucket, so it cannot reproduce the AWS refusal. The live
  incident is not resolved until a deployed worker publishes and verifies a
  package in the real bucket.
* Whether the image that raised the incident actually contained the defect.
  The deployed SHA is unknown; the first image containing the defect is
  `4579c997` (2026-09-18).
* TSA token signature verification is not performed; the label says
  "not checked" instead of "verified".
* Worker containers have no Bitcoin node, so new anchors will normally be
  `PROOF_STRUCTURE` ("not checked against the chain"). `BITCOIN_VERIFIED`
  requires a Bitcoin RPC for `ots verify`.
