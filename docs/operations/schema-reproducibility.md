# Schema Reproducibility & Truth Model

**Phase 0 — Platform Reproducibility & Schema Truth Recovery.**
**Status:** active (2026-05-26).
**Owner:** Platform / Infra.

This document describes how a PROOVRA database is brought up from
source, what the single source of truth is, how out-of-band SQL
drift-patches are handled, and how CI protects the reproducibility
contract.

It exists because a runtime audit on 2026-05-26 proved that PROOVRA
could not previously be rebuilt from source: `prisma migrate deploy`
failed on a clean database, and even with the schema patched in,
the API refused to boot due to `SCHEMA_DRIFT_CRITICAL`. The audit
showed that ~30 hand-written SQL files were being applied to
production outside the Prisma migration history. That is no longer
the case.

---

## TL;DR — Quick rebuild

```bash
# 1. Bring up local infra
docker compose -f infra/docker/docker-compose.yml up -d

# 2. Migrate the schema. NO manual SQL is needed.
DATABASE_URL=postgresql://USER:PASS@localhost:5432/DB \
  pnpm --filter proovra-api prisma migrate deploy

# 3. Generate the Prisma client
pnpm --filter proovra-api prisma generate

# 4. Seed the signing-key row (required for verify endpoints)
DATABASE_URL=... pnpm --filter proovra-api prisma:seed

# 5. Boot the API. The runtime validator must report
#    `runtime.schema_validation.healthy` (checked: 102).
pnpm --filter proovra-api dev
```

If any of these steps fail or the validator does not report `healthy`,
**stop** and fix the underlying issue before continuing. Do NOT bypass
with `SCHEMA_VALIDATION_FAIL_FAST=false`.

---

## The single source of truth

After Phase 0, the canonical schema chain is:

```
services/api/prisma/schema.prisma       (Prisma model declarations)
services/api/prisma/migrations/**       (canonical SQL migration history)
services/api/src/runtime/schema-validation.ts (102-object runtime catalog)
```

Every schema object the application expects must be created by a
migration in `services/api/prisma/migrations/`. The runtime validator
inspects the live database against the catalog at process startup and
refuses to boot if a CRITICAL object is missing.

**Never** add a schema object only to `schema.prisma` without also
creating a migration. `prisma db push` is a diagnostic tool for local
exploration — it is **not** a production deployment path.

---

## Out-of-band SQL: the historical drift patches

Two directories contain hand-written SQL files written during the
2026-05 production-drift incident:

```
services/api/prisma/sql/
  2026-05-08-evidence-operations-workspace-drift-fix.sql
  2026-05-18-production-drift-multi-phase-fix.sql
  2026-05-18-production-drift-multi-phase-fix-v2.sql

services/api/sql/drift-patches/
  2026-05-19-evidence-ocr-text.sql
  2026-05-19-evidence-transcripts.sql
  2026-05-19-evidence-upload-multipart.sql
  2026-05-19-evidence-upload-session-bridge.sql
  2026-05-19-evidence-upload-sessions.sql
  2026-05-19-external-review-grants.sql
  2026-05-19-saved-search-views-scope.sql
  2026-05-19-search-audit-log.sql
  2026-05-19-search-fts-pgvector.sql
  2026-05-20-evidence-part-derived-assets.sql
  2026-05-20-evidence-part-exif-summaries.sql
  2026-05-20-investigation-graph.sql
  2026-05-20-media-intelligence-runs.sql
  2026-05-20-media-intelligence-signals.sql
  2026-05-20-ocr-transcript-indexed-signals.sql
  2026-05-20-reviewer-ops-phase25-consolidation.sql
```

**Their contents are now fully represented in the canonical migration
chain.** Specifically, migration
`20260620100000_phase24_31_consolidated_drift_patches` absorbs the
16 files in `services/api/sql/drift-patches/`, and the corrective
migration `20260417000000_create_verification_source_enum` plus
several later migrations cover the contents of the 3 files in
`services/api/prisma/sql/`.

These files are kept on disk **as historical artifacts only**. Do
not apply them by hand on a new environment. Do not modify them.

They will be moved to `docs/recovery/archive/drift-patches/` in a
future tidy-up commit (Phase 0+).

---

## What Phase 0 actually changed

| Change | File | Why |
|---|---|---|
| New migration | `services/api/prisma/migrations/20260417000000_create_verification_source_enum/migration.sql` | Creates 17 enums (`VerificationSource`, `CaptureMethod`, `IdentityLevel`, `VerificationStatus`, ...) that were declared in `schema.prisma` but never emitted by any migration. Also adds two snapshot columns (`reports.reviewer_summary_version`, `reports.verification_package_version`) that a later migration tried to index without creating. |
| Bug fix | `services/api/prisma/migrations/20260620100000_phase24_31_consolidated_drift_patches/migration.sql` | 7 `DO $$ ... $$` blocks were missing the `BEGIN` keyword and 1 `DO $$ DECLARE ... $$` block was missing `BEGIN` after `DECLARE`. Postgres rejected these as syntax errors on a clean DB. |
| Comment-syntax fix | `services/api/prisma/migrations/20260802000000_phase_e3_2_webhook_delivery/migration.sql` | 14 lines used Prisma doc-comment syntax (`///`) instead of SQL line-comment syntax (`--`). |
| Extended seed | `services/api/src/seed-signing-key.ts` | Now supports both `aws-kms` (existing) and `local-pem` (new). Required so the public-verify and review-workspace endpoints don't 404 on a fresh environment with `SIGNER_PROVIDER=local-pem`. |
| New CI job | `.github/workflows/schema-reproducibility.yml` | Runs on every push/PR: clean Postgres → `prisma migrate deploy` → boot API → assert `runtime.schema_validation.healthy`. Fails CI if drift is reintroduced. |
| This document | `docs/operations/schema-reproducibility.md` | Documents the truth model. |

No existing migrations were deleted. No existing migration's SQL was
modified except for the two bug-fixes listed above (which were never
correctly applied on any environment — production environments
worked around the broken syntax with hand-applied drift-patches).

---

## How `prisma migrate deploy` interacts with existing environments

If production has been running by manually applying drift-patches
and using `prisma migrate resolve --applied <name>` to mark broken
migrations as applied, the new corrective migration
`20260417000000_create_verification_source_enum` will be detected
by Prisma as "pending" (timestamped earlier than the most recent
applied migration). When `prisma migrate deploy` runs:

* The corrective migration is **idempotent** — every `CREATE TYPE`
  is guarded by `pg_type` existence check, every `ADD COLUMN` uses
  `IF NOT EXISTS`. On a production environment that already has
  these objects, the migration is a no-op and is recorded in
  `_prisma_migrations`. Future deploys are clean.

* The two corrected migrations (`20260620100000_phase24_31_consolidated_drift_patches`
  and `20260802000000_phase_e3_2_webhook_delivery`) have new content
  hashes. Prisma will detect this on deploy and emit a warning.
  Production operators should run:

  ```bash
  pnpm --filter proovra-api prisma migrate resolve \
    --applied 20260620100000_phase24_31_consolidated_drift_patches
  pnpm --filter proovra-api prisma migrate resolve \
    --applied 20260802000000_phase_e3_2_webhook_delivery
  ```

  after the next deploy, ONCE per environment. This is safe because
  on those environments the actual schema state was already
  established by the manually-applied drift-patches; only the
  `_prisma_migrations` hash needs alignment.

* On environments that never applied the drift-patches (DR rebuild,
  CI, new dev), the migrations apply cleanly from zero.

---

## How CI protects the contract

The workflow `.github/workflows/schema-reproducibility.yml` runs on
every push and PR. It:

1. Spins up an empty `postgres:16-alpine` service.
2. Runs `prisma migrate deploy` against it. Fails CI if any migration
   errors.
3. Runs the new `prisma:seed` script. Fails CI if the local-pem
   signing key cannot be seeded.
4. Builds the API and boots it with `SCHEMA_VALIDATION_FAIL_FAST=true`.
5. Greps the API log for `runtime.schema_validation.healthy`. Fails
   CI if the line is absent or if any
   `runtime.schema_validation.critical` / `.degraded` line appears.

A failure in this job means a new environment cannot be brought up
from source. **Treat it as a release blocker.**

The existing `ci.yml` `build-test` job continues to run alongside,
covering the broader integration / E2E surface. The two jobs are
complementary: schema-reproducibility is fast and isolates the
schema concern; build-test exercises the application surface.

---

## What `prisma db push` IS and ISN'T

`prisma db push` is a **diagnostic tool** for local development.
It writes the schema declared in `schema.prisma` directly to a
database, bypassing the migration history. It is useful for:

* exploring "what would the schema look like if I added this model?"
* recovering a corrupted local dev DB

It is **not** acceptable for:

* deploying to production
* CI verification of reproducibility
* CR / DR rebuilds

The runtime validator catalog encodes the contract; only migrations
keep that contract honest across environments. `db push` will skip
raw-SQL artifacts that some validator targets depend on (custom
CHECK constraints, GIN/IVFFLAT indexes, partial indexes, default
expressions Prisma cannot represent).

---

## Why the runtime validator stays strict

`services/api/src/runtime/schema-validation.ts` checks 102 schema
objects across 7 subsystems (`core_evidence`, `governance_lifecycle`,
`reviewer_ops`, `workflow_engine`, `integrations`,
`operational_incidents`, `search_discovery`). Critical objects fail
startup; important objects degrade the relevant subsystem; optional
objects log info.

`SCHEMA_VALIDATION_FAIL_FAST=false` is permitted in `services/api/.env.example`
**only for local diagnosis when a drift is being investigated**. It
must never be set in production. The CI job sets it to `true`
explicitly and would fail if a drift were introduced.

The validator catalog is updated when a new migration adds a
runtime-critical object. The list of expected objects is encoded as
a typed value in the source file; every update requires a code review.

---

## Local signing-key seed (Phase 0 addition)

`services/api/src/seed-signing-key.ts` now branches on
`SIGNER_PROVIDER`:

* `aws-kms` (production): reads the public key from AWS KMS
  `GetPublicKey`. Requires `AWS_REGION`, `KMS_KEY_ID`.
* `local-pem` (dev / CI / new env): reads the PEM at
  `SIGNING_PUBLIC_KEY_PATH` (default `keys/signing-public.pem`).
  Validates Ed25519. Refuses to seed garbage.

The script is idempotent. It also seeds the package-signing key row
(`PACKAGE_SIGNING_KEY_ID` / `PACKAGE_SIGNING_KEY_VERSION`) when
those env vars are set, mirroring the evidence key material when
the two share the same physical key.

Without this seed, every `/v1/evidence/:id/review-workspace`,
`/public/verify/:id`, and verification-package signature path
returns 404 "Signing key not found" — even when evidence was just
signed using the same key on the same machine.

---

## What still needs follow-up (deferred from Phase 0)

The following items were intentionally NOT addressed in Phase 0 and
remain on the roadmap. They do not affect clean-DB reproducibility:

* **13 raw-SQL tables not modeled in `schema.prisma`**:
  `evidence_upload_sessions`, `evidence_upload_session_parts`,
  `media_intelligence_signals`, `media_intelligence_runs`,
  `external_review_grants`, `search_audit_logs`, `evidence_ocr_text`,
  `evidence_transcript_segments`, `manual_relationships`,
  `investigation_graph_nodes`, `investigation_graph_edges`,
  `evidence_part_exif_summaries`, `evidence_part_derived_assets`.
  These are accessed via `$queryRaw` in the application; they are
  created by migrations and validated at startup. Adding Prisma
  models for them would give the application typed access.
* **Move historical drift-patches** from
  `services/api/sql/drift-patches/` and `services/api/prisma/sql/`
  to `docs/recovery/archive/drift-patches/`. Their contents are now
  in migrations; the files are kept only for historical audit.
* **Phase 1 — Forensic trust closure** (sign custody events, verify
  evidence signatures at read time, demote SIGNED evidence on TSA
  failure). Tracked in the runtime audit report.

---

## Rollback

If the new corrective migration or the consolidation bug fixes need
to be rolled back:

1. `git revert` the Phase 0 commit.
2. In each affected environment, run
   `prisma migrate resolve --rolled-back 20260417000000_create_verification_source_enum`
   to remove the new migration from history. The DB schema itself is
   unaffected (every operation in the corrective migration is
   idempotent and additive).
3. Apply the corresponding drift-patches by hand again. The files in
   `services/api/sql/drift-patches/` and `services/api/prisma/sql/`
   are unchanged.

This should not normally be needed — the corrective migration is
strictly additive and idempotent — but the option exists.
