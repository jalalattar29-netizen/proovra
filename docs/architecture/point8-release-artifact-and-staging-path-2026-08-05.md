# PHASE 12 — POINT 8: release-artifact repair and the Staging delivery path

**Date:** 2026-08-05 · **Base commit** `36b871dcd926968128a800483980c94bf03f3297`
**Approval latches present:** none.

```text
PHASE 12 — POINT 8 READY FOR LIVE EXECUTION — CONSOLIDATED OWNER ACTION REQUIRED
```

All four approval latches are absent, so this pass did everything that does not
require them and stopped cleanly at each boundary: nothing was provisioned,
nothing deployed, nothing committed, nothing pushed. Parts A, B and C1 are
complete and executed. Part D — the fourteen live gates — remains 0/14, blocked
on one consolidated owner action.

What changed materially: **the release artifact is repaired and the repair is
gated**, **a Staging delivery path exists and cannot reach production**, and
**three further defects were found by actually building and running the
artifact** rather than by reading the working tree.

---

## Part A — release-artifact integrity

### A0 — the three source views, and conservation between them

| view | migrations | what it is |
|---|--:|---|
| `HEAD_ARTIFACT` | 204 | what `actions/checkout` + `docker build` ship today |
| `SETTLED_WORKTREE` | 222 | this machine, incl. 1,311 files of unrelated work |
| `PROPOSED_RELEASE_ARTIFACT` | 222 | HEAD + 18 justified additions, minus nothing |

```text
ConservationErrors                    = 0
MigrationInventoryFilesystemMismatch  = 0
UntrackedMigrationUnknowns            = 0
```

Recovery snapshot re-verified and extended before any edit
(`D:\p8-recovery-snapshot\`: `git bundle verify` → *complete history*, plus a
1,027-file archive of the working state). Isolation canary **12/12**.

A first attempt to build these views was wrong in a way worth recording: parsing
HEAD's migration list by first path segment counted `migration_lock.toml` as a
migration and reported 205. Corrected to key on `…/migration.sql`.

### A1 — all 17 untracked migrations classified

Every one is dispositioned in `release-materialize.mjs` and carries its reason
into the artifact:

| disposition | n | which |
|---|--:|---|
| `REQUIRED_RELEASE_MIGRATION` | 12 | the EXPAND/REPAIR/BACKFILL set |
| `REQUIRED_LATER_CONTRACT_MIGRATION` | 5 | the Release-D contracts, incl. the persona guard |

None classified `SCRATCH_OR_INVALID`, `SUPERSEDED_NEVER_APPLIED` or
`DUPLICATE_OF_TRACKED_MIGRATION`, so nothing was deleted or renamed. Production
applied-state stays `UNKNOWN_AWAITING_SNAPSHOT` for all of them.

### A2 — the guard chain, repaired and gated

The defect: `20270924000000_drop_workspace_persona_profiles` is **tracked** and
issues a bare `DROP TABLE IF EXISTS … CASCADE`. Its only safety is
`20270923500000_persona_profiles_removal_precondition`, which measures dependent
foreign keys and views and RAISEs — and which is **untracked**.

Proven executably against an empty PostgreSQL 16.14 + pgvector 0.8.6:

1. the guard sorts before the drop;
2. with a synthetic dependent FK present, `migrate deploy` **stopped at the
   guard**, naming the exact constraint, and `workspace_persona_profiles`
   survived intact;
3. the guard is read-only — it executes no `CREATE/ALTER/INSERT/UPDATE`;
4. the refusal left a `FAILED` row; `migrate resolve --rolled-back` cleared it;
5. once the dependency was legitimately removed, Release D applied and the table
   was dropped — 222/222 applied, `raw-schema-verify` **OK (865 objects, 0
   divergences)**, `drift-check` **OK**;
6. readiness zero (0 dependent FKs, 0 dependent views) is required; the row
   count is explicitly *not* a blocking category, which is the documented
   product-approved historical-data disposition;
7. no runtime caller references the table.

The gate that enforces this discovers destructive statements by scanning SQL and
finds the guard by the guard *naming what it guards* — not from a maintained
list, because a maintained list fails the same way the artifact did. It **fails
against `HEAD_ARTIFACT`** and **passes only against the proposal**, and both
directions are asserted.

```text
TrackedDropWithoutGuard (HEAD_ARTIFACT)   = 1   ← the defect, still measurable
TrackedDropWithoutGuard (PROPOSED)        = 0
MigrationOrderConflicts                   = 0
CleanArtifactMissingMigrations            = 0
```

**Absence was the wrong mechanism.** The Point-6 runbook kept Release-D
migrations safe by leaving them out of the artifact, and that is precisely what
separated the guard from its drop. The artifact now carries all 222; the wave is
chosen at deploy time.

### Three further defects, found by building and running the artifact

**1 — `prisma migrate deploy` cannot be bounded by `--schema`.**
The wave selector staged 203 migrations, Prisma reported *"All migrations have
been successfully applied"*, and the database recorded **221** — including three
Release-D contract migrations. Prisma 7 loads `services/api/prisma.config.ts`,
whose `migrations.path` pins `prisma/migrations` and wins over `--schema`. A
tool that had trusted its own report would have been worse than no tool. The
deployer now generates a dedicated config, runs with the stage as cwd, and then
**asks the database what it recorded**, refusing on any migration outside the
wave. That last check is what caught it.

**2 — line endings break Prisma checksums across build hosts.**
`core.autocrlf=true` with no `.gitattributes`: `git archive` on this machine
injected 21 CR bytes into a migration whose canonical blob has none, and 31
worktree migration files carry CRLF while git reports them unmodified (it
normalises on comparison). `_prisma_migrations.checksum` is over raw bytes, so
an artifact built here and one built on CI's Linux runner carry different
checksums for the same commit — and deploying one against a database migrated
from the other fails with *"migration was modified after it was applied"*. Fixed
at both levels: `.gitattributes` pins `*.sql` to LF, and the materializer pins
`core.autocrlf=false` so it reproduces the canonical blob anywhere.

**3 — the pgvector block is a permanent no-op on every fresh database.**
`20260620100000_phase24_31_consolidated_drift_patches` creates
`evidence_search_documents.embedding` and its IVFFLAT index inside
`IF has_pgvector … ELSE RAISE NOTICE 'skipped'`. `CREATE EXTENSION vector` is
not issued until `20270701000000_phase15_semantic_search` — **a year later in
lexical order**. The guard is false when evaluated, both objects are skipped
forever, and the datamodel goes on declaring
`embedding Unsupported("vector(384)")?`. Production drifted into correctness
because the extension was installed out of band; a rebuild does not.

It survived a year of CI because `schema-reproducibility.yml` runs on
`postgres:16-alpine`, where `CREATE EXTENSION` fails into
`WHEN OTHERS THEN RAISE NOTICE` and every extension-conditional check is
vacuous. Fixed with `20271119000000_search_document_embedding_after_extension`
(additive, idempotent, and it **RAISES** rather than skipping — silence is what
hid this), and by moving the CI service image to `pgvector/pgvector:pg16`.

Also corrected at the canonical authority: the Point-6 inventory scanner built
its destructive-statement list from object NAMES, so
`EXECUTE format('DROP TABLE %I', …)` in
`20271117000000_point4_schema_authority_contract` contributed nothing and the
migration was recorded with **zero** destructive statements — which is what
`UnguardedDestructiveStatementsPending = 0` was computed from. It now records
dynamic-identifier destruction with a null object rather than dropping it.

### A4 — the clean materialization

Built from `git archive`, never from the working tree. Against it: Prisma
`validate` ✓, `format --check` ✓, wave A/B → 204 applied with 18 deferred and
the persona table intact, wave D → 222 applied, `raw-schema-verify` OK,
`drift-check` OK.

Not run: API/Worker boot and the Web production build. The proposal changes
migrations, CI configuration and test tooling only — no application source — so
neither would exercise the change. Stated rather than skipped silently.

### A5 — the commit manifest (nothing was committed)

`P8_STAGING_GIT_COMMIT_APPROVED` is absent. `docs/architecture/point8-commit-manifest.json`
records the exact set:

```text
proposed branch  release-candidate/p8-artifact-integrity   (never main)
files to add     55   incl. all 18 migration.sql files and the persona guard
files to modify   3
files to delete   0
unrelated working-tree entries deliberately NOT staged   1311
migration checksums recorded                               18
```

The manifest is an allowlist, not `git add -A`: this tree carries 1,311
uncommitted files of unrelated work, and a release commit must not sweep them
up. An early version silently dropped all seventeen migrations because git
reports an untracked directory as one trailing-slash entry — caught by checking
the count.

---

## Part B — the Staging delivery path

### B1 — the deployment graph, derived not read

| workflow | triggers | automatic | effects |
|---|---|:--:|---|
| `ci.yml` | push, pull_request | yes | — |
| `deploy-images.yml` | push(main), workflow_dispatch | yes | publishes image, **publishes `:latest`** |
| `deploy-staging.yml` | workflow_dispatch | **no** | applies migrations |
| `playwright-e2e.yml` | push, pull_request | yes | applies migrations |
| `schema-reproducibility.yml` | push, pull_request | yes | applies migrations |

```text
UnknownDeploymentTriggers        = 0
productionDeliveryPaths          = [deploy-images.yml]
StagingPathCanTriggerProduction  = false
```

### B2 — `deploy-staging.yml`

Manual only — no `push:` trigger of any kind. Bound to the `staging` GitHub
environment (the approval gate and the only source of staging secrets). Requires
an immutable release-candidate tag. Runs the credential preflight *before*
anything is applied. Applies migrations only through the wave selector. Rolls
back on failure.

The eight refusals are enforced by a function, not by the YAML being read
carefully, and each is proved by a negative case (18 executed):

| # | refusal | # | refusal |
|--:|---|--:|---|
| 1 | `main`/`master`/`production`/`release` target | 5 | preflight not green |
| 2 | production (or non-staging) environment | 6 | deferred Contract wave without explicit rehearsal opt-in |
| 3 | production secret **name** or `PROD_*` reference | 7 | mixed or missing build ids |
| 4 | mutable tag (`latest`) or no tag | 8 | **a clean staging configuration is accepted** |

A ninth case drives every rule and asserts the reached set is complete, and a
tenth proves the *source* guard refuses a workflow mutated to trigger on `main`
into `production` — without which the source check could be vacuous.

`staging-deploy-cli.mjs --deploy|--health|--rollback` **refuse with exit 12** and
name the owner prerequisite. They do not simulate: a deploy that reports success
without deploying is the failure mode Point 8 exists to prevent.

---

## Part C — Staging credentials

### C1 — the 23 unknowns, resolved

`CONFIGURED_BUT_UNKNOWN` was honest but not actionable. A Staging deployment
reads `STAGING_*` names **only**, which resolves every row:

| classification | n |
|---|--:|
| `MISSING` — no staging input exists | 19 |
| `OWNER_CONFIRMATION_REQUIRED` — configured value names a remote host of indeterminate tenancy | 10 |
| `PRODUCTION_FORBIDDEN` — a live provider marker | 2 |
| `SANDBOX_OR_STAGING_VERIFIED` | **0** |

```text
ConfiguredButUnknown          = 0
ProductionForbiddenSelected   = 0
VerifiedStagingCredentials    = 0/31
MissingRequiredStagingInputs  = 29
```

`OWNER_CONFIRMATION_REQUIRED` is not a soft pass — it blocks the preflight
exactly as `CONFIGURED_BUT_UNKNOWN` did. It just says who can resolve it.

### C3 — preflight

`staging-preflight-cli.mjs --require-green` exits **10**: all 11 required
`STAGING_*` inputs absent. Proven to ignore the unprefixed production names that
this machine's environment carries, so a staging run cannot inherit them.

---

## Part D — live gates

**0/14 executed.** Nothing was deployed, so nothing is claimed. The Point-8
manifest records all fourteen as `BLOCKED_OWNER_PREREQUISITE` with their
specific unmet inputs.

---

## Metrics

```text
UntrackedMigrationUnknowns            = 0
TrackedDropWithoutGuard               = 0     (HEAD_ARTIFACT still measures 1)
MigrationInventoryFilesystemMismatch  = 0
CleanArtifactMissingMigrations        = 0
MigrationOrderConflicts               = 0
UnknownDeploymentTriggers             = 0
StagingPathCanTriggerProduction       = false

ConfiguredButUnknown                  = 0
ProductionForbiddenSelected           = 0
VerifiedStagingCredentials            = 0/31
MissingRequiredStagingInputs          = 29
ProductionDestinationsAttempted       = 0
ProductionDestinationsConnected       = 0

PostgresLive … ProductionLikeCookiesCors = BLOCKED_OWNER_PREREQUISITE (14)
StagingProductPlansProven             = 0/5
RequiredLiveGateSkips                 = 14
MockArtifactsCreditedAsLive           = 0
Point8Failures                        = 0
TemporaryArtifacts                    = 0

Suites: 98/98 (4 Point-8 + Point-6 closure + Point-4 raw-schema)
Lint 0 · typecheck 0 · IsolationCanary 12/12
```

Cleanup: rehearsal container removed, wave staging directories removed,
scratch artifacts removed. No Staging or Production resource was created, so
none is retained.

---

## Consolidated owner action

One bundle. Everything below is required; nothing is requested incrementally,
and **no secret value should be sent in chat** — place them in the `staging`
GitHub environment.

| # | Approval latch | Staging resource / configuration | Secret variable name | Provider mode | Owner action | Blocked gates |
|--:|---|---|---|---|---|---|
| 1 | `P8_STAGING_GIT_COMMIT_APPROVED` | — | — | — | Approve the commit manifest; create `release-candidate/p8-artifact-integrity` and stage exactly its 55+3 files. **Never `main`.** | all |
| 2 | `P8_STAGING_GIT_PUSH_APPROVED` | — | — | — | Push that branch only. Pushing `main` triggers a **production** GHCR build. | all |
| 3 | `P8_STAGING_PROVISIONING_APPROVED` | PostgreSQL 16+ with `pgvector` | `STAGING_DATABASE_URL` | dedicated staging instance | Provision; grant API and Worker the same database | 1, 11, 12 |
| 4 | ″ | Redis | `STAGING_REDIS_URL` | dedicated staging instance | Provision; reachable by API and Worker | 2, 11 |
| 5 | ″ | Object storage | `STAGING_S3_ENDPOINT`, `STAGING_S3_BUCKET`, `STAGING_S3_ACCESS_KEY`, `STAGING_S3_SECRET_KEY` | dedicated bucket, versioning + Object Lock | Create; issue a credential scoped to it alone — **not** the existing AWS long-term key | 3, 11, 12 |
| 6 | ″ | Stripe | `STAGING_STRIPE_SECRET_KEY`, `STAGING_STRIPE_WEBHOOK_SECRET`, `STAGING_STRIPE_PRICE_IDS` | **test mode** | Create test-mode prices for all five plans; register the staging webhook | 4, 14 |
| 7 | ″ | PayPal | `STAGING_PAYPAL_API_BASE`, `STAGING_PAYPAL_CLIENT_ID`, `STAGING_PAYPAL_SECRET`, `STAGING_PAYPAL_WEBHOOK_ID` | **sandbox** | Create a sandbox app + plans | 5, 14 |
| 8 | ″ | SAML test IdP | `STAGING_SAML_METADATA_URL`, `STAGING_SAML_IDP_CERT`, `STAGING_SAML_IDP_ENTITY_ID` | dedicated test tenant | Create tenant/app; register the staging ACS URL | 6 |
| 9 | ″ | OIDC test application | `SsoConnection` row (issuer, client id, secret) | test/sandbox tenant | Register with the staging redirect URI; create the connection in the running app | 7 |
| 10 | ″ | SCIM client | Staging Organization + bearer token | same test tenant | Enable SCIM against the staging SCIM base | 8 |
| 11 | ″ | Email | `STAGING_EMAIL_TRANSPORT`, `STAGING_EMAIL_SENDER`, `STAGING_TEST_MAILBOX` | staging sender domain, controlled mailbox | Verify a staging sending domain; supply a mailbox this run controls | 9 |
| 12 | ″ | Webhook receiver | `STAGING_WEBHOOK_RECEIVER`, `STAGING_WEBHOOK_SECRET` | controlled for the run | Stand it up; register the endpoint | 10 |
| 13 | ″ | HTTPS origins | `STAGING_WEB_BASE`, `STAGING_API_BASE` | behind the staging reverse proxy | Publish staging Web/API origins with strict CSP | 13, 14 |
| 14 | `P8_STAGING_DEPLOY_APPROVED` | GitHub environment `staging` | — | — | Create the environment with required reviewers and the secrets above, then run `deploy-staging.yml` with an immutable RC tag and wave `A_B` | all |

Once 1–14 are in place, `deploy-staging.yml` runs the preflight, refuses on any
production selection, applies only the approved wave, and Part D executes
against the existing Point-8 manifest and its fifteen-refusal gate.

## Carried separately — not advanced by this pass

```text
OWNER PRODUCTION QUEUE INCIDENT AUDIT
POINT 6 PRODUCTION MIGRATION RECONCILIATION
```

Both remain owner read-only prerequisites. No production database, Redis, queue,
bucket, payment account, email account, identity tenant or Sentry project was
contacted; no production migration was applied; nothing was pushed.
