# PHASE 12 — POINT 8: external/live Staging gates

**Date:** 2026-08-05 · **Release candidate** `ad077c1d24a1dffd…`
**Git** `36b871dcd926968128a800483980c94bf03f3297` (branch `main`, uncommitted)

```text
PHASE 12 — POINT 8 PARTIALLY VERIFIED — OWNER STAGING PREREQUISITES PENDING
```

Point 8 exists to prove the system against **real external Staging/Sandbox
infrastructure**. This repository has none. Not "misconfigured" — absent:
there is no staging environment file, no `STAGING_*` variable anywhere, no
staging deployment target, and no sandbox credential for any of the five
external providers. Of the 31 required credentials, **0 classify as
`SANDBOX_OR_STAGING_VERIFIED`**.

So all fourteen live gates are blocked, and the Step-2 preflight — which the
mandate forbids proceeding without — cannot be green.

What *was* executed is everything Point 8 asks for that does not need a
provider: the release candidate is preserved and identified, the credential
census is complete and machine-checked, the preflight is built and each of its
seven production refusals is proved, and the Step-5 evidence gate is built with
all fifteen of its refusals proved by negative case. The moment Staging exists,
the gates are runnable and creditable — and a fake cannot be credited in their
place.

**No production destination was attempted or connected by any product process
in this pass.** The only external attempts were the isolation canary's three
deliberate, blocked ones.

---

## Step 0 — the release candidate is preserved and identified

| | |
|---|---|
| Git commit | `36b871dcd926968128a800483980c94bf03f3297` |
| Branch | `main` — **a production auto-deploy branch** (`deploy-images.yml` builds and pushes `latest` to GHCR on every push) |
| Working tree at Step 0 | not clean: 1,334 entries — 1,047 modified/untracked files, 31 deletions |
| Working tree after this pass | 1,341 entries (this pass's own Point-8 artifacts) |
| Recovery snapshot | `D:\p8-recovery-snapshot\` — outside the repository, taken **before** any of this pass's work |
| … history | `history-36b871dc.bundle` (474 MB, `git bundle verify` → *records a complete history*) |
| … working state | `uncommitted-36b871dc.tar.gz` — 1,016 files; the other 31 are deletions, recorded by name in `deleted-files.txt` and recoverable from the bundle |
| Isolation canary | **12/12 PASS** (re-executed this pass) |

### Build identifiers

Point 7's build id came from outside the repository (`POINT7_BUILD_ID`), so it
could not be recomputed and could not be checked against the tree it described.
Point 8 has to reject *mixed build IDs*, which is only meaningful if a build id
is **derived** from what it identifies. Each is now a content digest:

```text
apiBuildId            1269de0d661fc963…   674 source files
workerBuildId         5cb2c1c4ec78a6d1…   127 source files
webBuildId            8add31fa64bc437e…   741 source files
sharedPackagesDigest  016507b740faaaa9…
releaseCandidateId    ad077c1d24a1dffd…   (composite of the four)
nextBuildIdOnDisk     CAe8zv7WzecU48TntHenl
```

The digests cover shipped sources only, which is why `releaseCandidateId` is
unchanged by this pass's own test and documentation artifacts — the identifier
tracks the release candidate, not the working directory.

### Migration boundary — and a real finding

The Point-6 inventory's boundary is unchanged: 221 migrations, of which 18
`SAFE_TO_APPLY_NOW` (Release A/B), 12 `WAIT_FOR_BACKFILL_READINESS` (C), 6
`CONTRACT_DROP_LATER` (D), 185 historical-preserve. `FirstDeploymentContractDrops`
is 0 *in the inventory*.

Step 0.8 asks for confirmation that no Contract/Drop migration is silently
included in the first Staging wave. It would be — by two different routes:

**All 221 migration directories are present in the worktree, and 17 of them are
untracked.** A Staging deploy from the current worktree therefore hands
`prisma migrate deploy` all six Release-D contract migrations.

Worse, the only automated artifact mechanism that exists — the GHCR image, built
by `actions/checkout` from a clean tree and copying `services/api/prisma` — sees
only the 204 tracked directories. And the split falls in the worst possible place:

| Migration | tracked | destructive | guarded |
|---|---|---|---|
| `20270923500000_persona_profiles_removal_precondition` | **no** | 0 (it *is* the guard: 2 `RAISE`s) | — |
| `20270924000000_drop_workspace_persona_profiles` | **yes** | 1 — bare `DROP TABLE … CASCADE` | **no** — safety comes entirely from the row above |

An image or `git archive HEAD` artifact carries the **unguarded drop without its
guard**. Point 6 designed the guard as a lexically-preceding migration precisely
because the drop is tracked and its Prisma checksum must not change; that design
only holds if both ship together.

Classification: `STAGING_CONFIGURATION_DEFECT` (release-artifact composition).
It is not fixed here — the fix is either committing the guard or excluding the
drop from the artifact, and both need commit authorization this pass does not
have.

### Deployment mechanism (Step 0.9)

None of the four options is configured. `vercel.json` builds the web app with no
environment binding; `deploy-images.yml` pushes `api` and `worker` images to
GHCR on push to `main` only; there is no staging branch, no staging job, no
staging artifact. `scripts/verify-integrations-staging.sh` (Phase 6) expects
`STAGING_API_BASE` / `STAGING_ADMIN_TOKEN` / `STAGING_TEAM_ID` — none are set,
and its `api.staging.…` reference is a comment example, not configuration.

Step 0.10: no commit or push was made. Pushing `main` would trigger a production
image build, so it is reported once as an owner prerequisite and nothing else.

---

## Step 1 — credential census

`services/api/test/point8/staging-census.mjs` reads the env files from disk (not
`process.env`), classifies, and **never emits a value** — hosts become
categories, and where a provider prefix carries the sandbox/live distinction the
*classification* is emitted and the prefix is not. A test asserts the artifact
contains no `sk_live_`/`sk_test_`/`re_`/`AKIA`/`whsec_` shape and no absolute
URL of any scheme.

Artifact: [`point8-credential-census.json`](point8-credential-census.json).

```text
censusItems 31   SANDBOX_OR_STAGING_VERIFIED 0
                 CONFIGURED_BUT_UNKNOWN     23
                 PRODUCTION_FORBIDDEN        2
                 MISSING                     6
```

### Production-bearing env files — never selectable by a Staging run

| File | live markers |
|---|---:|
| `.env` | 17 |
| `services/api/.env` | 17 |
| `services/worker/.env` | 1 |
| `apps/web/.env.local` | 1 |

These carry live-mode Stripe, the live PayPal endpoint, AWS long-term keys, a
remote Redis, a remote S3 endpoint, a remote Sentry project, a real Resend key,
a real Twilio account and `NODE_ENV=production`. This is the file set the
Point-7 outbound guard was written against: `services/api/src/db.ts` opens with
`import "dotenv/config"`, so any process started from that directory loads
`services/api/.env`, and `dotenv` does not overwrite an already-set variable —
which made safety depend on having remembered to override each one.
`.env.audit-local`,
`services/api/.env.local`, `services/api/.env.audit-local` and
`infra/docker/.env` carry **no** live marker and remain the only safe local
selection — but loopback is not Staging, and none of them can credit a live gate.

### Readiness

| Gate | Classification | Ready | Blocker | Owner action |
|---|---|:--:|---|---|
| 1 PostgreSQL | CONFIGURED_BUT_UNKNOWN | no | no staging DB | provision a Staging PostgreSQL (16+, `pgvector`) |
| 2 Redis/BullMQ | CONFIGURED_BUT_UNKNOWN | no | no staging Redis | provision a Staging Redis reachable by API **and** Worker |
| 3 S3/R2 | PRODUCTION_FORBIDDEN (access authority) | no | only AWS long-term keys exist | dedicated Staging bucket + scoped credential + Object Lock |
| 4 Stripe | PRODUCTION_FORBIDDEN (live key); price IDs MISSING | no | no test-mode key with price IDs | Stripe **test mode** secret, webhook secret, 5 price IDs |
| 5 PayPal | CONFIGURED_BUT_UNKNOWN | no | sandbox client/secret empty | PayPal **sandbox** app credentials + webhook id |
| 6 SAML | CONFIGURED_BUT_UNKNOWN | no | only a remote IdP of unknown tenancy | dedicated test IdP tenant + app |
| 7 OIDC | MISSING | no | no issuer/client anywhere | test OIDC app, configured as an `SsoConnection` on a Staging Organization |
| 8 SCIM | MISSING | no | no base/token | Staging Organization + SCIM token minted in the running app |
| 9 Email | CONFIGURED_BUT_UNKNOWN; mailbox MISSING | no | no controlled mailbox | Staging sender domain + controlled test mailbox |
| 10 Webhooks | CONFIGURED_BUT_UNKNOWN | no | receiver is a remote host of unknown tenancy | Staging-controlled receiver + secret |
| 11 Redaction | — | no | needs the deployed Staging app | gates 1/2/3 first |
| 12 Digest/download | — | no | needs the deployed Staging app | gates 1/3 first |
| 13 Cookies/CORS | CONFIGURED_BUT_UNKNOWN | no | no HTTPS Staging origins | deploy web+api behind the Staging proxy |
| 14 Product journeys | — | no | needs 4/5/13 | the above |

**OIDC and SCIM are not capability gaps.** Both are implemented — `sso-auth.routes.ts`
issues `sso_oidc` sessions, `scim.routes.ts` serves the SCIM surface — and both
are configured *per Organization in the database* (`SsoConnection.issuerUrl` /
`clientId` / `clientSecretHash`), which is why no env variable exists to find.
Their blocker is a Staging environment plus a registered test application, not a
missing setting.

---

## Step 2 — the preflight, built and proved, and not green

`preflight()` computes the mandate's eight booleans from a *proposed selection*
rather than from ambient `process.env`, and derives the allowlist from the
verified selection instead of maintaining a list of forbidden hosts — a list
someone has to keep complete is exactly how the Point-7 incident happened.

Seventeen executed cases in
[`phase-12-point8-staging-preflight.test.ts`](../../services/api/test/phase-12-point8-staging-preflight.test.ts):
one proving a wholly Staging-named selection *is* green (without which the rest
would be vacuous), then eight proving each boolean turns true when the selection
is production in exactly that one way — remote database, remote Redis, an
AWS-hosted S3 endpoint, an `AKIA` key, `sk_live_`, the live PayPal endpoint, an
unknown-tenancy IdP, a real webhook receiver — plus the email-audience check
(judged by the recipient domain, because the Point-7 lesson is that a send can
be genuinely delivered somewhere real).

Against this repository:

```text
ProductionDatabaseSelected      = false
ProductionRedisSelected         = false
ProductionStorageSelected       = false
ProductionPaymentModeSelected   = false
ProductionIdentityTenantSelected= false
ProductionEmailAudienceSelected = false
ProductionWebhookReceiverSelected = false
UnknownCredentialSelections     = 23      ← not zero
preflightGreen                  = false
```

The seven containment booleans are false only because **nothing is selected at
all**. That is not readiness. `UnknownCredentialSelections = 23` is the gate,
and the mandate is explicit: do not run Point 8 until the preflight is green.

---

## Steps 3, 4 — not started

No Staging release candidate was deployed or started. No migration was applied
to any database. No gate was executed, and none is claimed.

---

## Step 5 — the evidence gate, built and proved

The cheap fakes all look like success: a unit test over the same code with a
stub, a recording provider that acknowledges because it was told to, an HTTP 200
with nothing durable behind it, a row inserted straight into the database, a
screenshot, a dashboard. Point 7 was bitten twice by exactly this — a
browser-verified claim asserted of processes where it was false, and an
invitation journey that "passed" by reading the token out of `team_invites` in a
run where every send had been refused at the socket.

So `evaluatePoint8Manifest()` is written to refuse, and each of the fifteen
refusals the mandate names is proved by corrupting a valid manifest in exactly
that one way. **19 executed cases, all green**, in
[`phase-12-point8-manifest-gate.test.ts`](../../services/api/test/phase-12-point8-manifest-gate.test.ts):

| # | Refusal | # | Refusal |
|--:|---|--:|---|
| R0 | the baseline is genuinely clean | R8 | database-only proof |
| R1 | a unit/mock artifact credited as live | R9 | a skipped required provider |
| R2 | production provider mode | R10 | an unknown credential classification |
| R3 | mixed build IDs | R11 | a missing cleanup disposition |
| R4 | an old run id | R12 | a connection to a production destination |
| R5 | a missing provider acknowledgement | R13 | PASS without the required scenario ids |
| R6 | missing durable state evidence | R14 | a provider fake credited as Sandbox |
| R7 | browser-only proof | R15 | a run that never touched a Staging environment |

A final case drives all fifteen and asserts the reached set is exactly
`[1…15]` — no refusal is dead code. Two further cases pin the honest state: an
empty manifest is refused and names all fourteen absent gates, and declaring the
fourteen gates `BLOCKED_OWNER_PREREQUISITE` yields `gatesPassed = 0` rather than
manufacturing a pass.

R14 deserves a note. The tell for a provider fake is an artifact claiming a live
*provider* request whose destination category is loopback — the exact shape a
stub server produces. That is what stops a local container being credited as
Sandbox, and it is why standing up a disposable PostgreSQL here (Docker 29.2.1
is available) would not have produced a creditable Gate 1: real PostgreSQL, but
not Staging, and the gate is built to say so.

Manifest: [`point8-manifest.json`](point8-manifest.json) — derived, never
hand-written, with each gate's `blockedBy` naming its specific unmet
prerequisites.

---

## Metrics

```text
PostgresLive                 = BLOCKED_OWNER_PREREQUISITE
RedisBullMQLive              = BLOCKED_OWNER_PREREQUISITE
ObjectStorageLive            = BLOCKED_OWNER_PREREQUISITE
StripeSandbox                = BLOCKED_OWNER_PREREQUISITE
PayPalSandbox                = BLOCKED_OWNER_PREREQUISITE
SamlTestIdp                  = BLOCKED_OWNER_PREREQUISITE
OidcTestProvider             = BLOCKED_OWNER_PREREQUISITE
ScimLiveClient               = BLOCKED_OWNER_PREREQUISITE
EmailStagingDelivery         = BLOCKED_OWNER_PREREQUISITE
WebhookLiveDelivery          = BLOCKED_OWNER_PREREQUISITE
RedactionRealFiles           = BLOCKED_OWNER_PREREQUISITE
ObjectDigestDownload         = BLOCKED_OWNER_PREREQUISITE
ProductionLikeCookiesCors    = BLOCKED_OWNER_PREREQUISITE
StagingProductPlansProven    = 0/5

ProductionDestinationsAttempted   = 0    (product processes; canary made 3 deliberate blocked attempts)
ProductionDestinationsConnected   = 0
UnknownCredentialSelections       = 23   ← blocks the Step-2 preflight
MockArtifactsCreditedAsLive       = 0
MissingProviderAcknowledgements   = 0    (no gate claims one)
MissingDurableStateEvidence       = 0    (no gate claims one)
CrossTenantExternalEffects        = 0
DuplicateExternalEffects          = 0
RequiredLiveGateSkips             = 14
Point8ManifestUnknowns            = 23
Point8Failures                    = 0    (nothing executed and failed)
TemporaryArtifacts                = 0
IsolationCanary                   = 12/12
```

Point 8 is **not** closed. Point 9 must not begin.

---

## Owner prerequisites

| Missing Staging/Sandbox item | Required variable / configuration | Provider environment | Exact owner action | Blocks |
|---|---|---|---|:--:|
| Staging PostgreSQL | `STAGING_DATABASE_URL`, `STAGING_DIRECT_URL` | dedicated staging instance, PG 16+ with `pgvector` | provision; grant API and Worker the **same** database | 1, 11, 12 |
| Staging Redis | `STAGING_REDIS_URL` | dedicated staging instance | provision; reachable by API and Worker | 2, 11 |
| Staging object storage | `STAGING_S3_OR_R2_ENDPOINT`, `STAGING_STORAGE_BUCKET`, `STAGING_STORAGE_REGION`, `STAGING_STORAGE_ACCESS_AUTHORITY`, `STAGING_OBJECT_LOCK_CONFIGURATION` | dedicated staging bucket, versioning + Object Lock | create bucket; issue a credential scoped to it only — **not** the existing AWS long-term key | 3, 11, 12 |
| Stripe sandbox | `STRIPE_SANDBOX_SECRET`, `STRIPE_SANDBOX_WEBHOOK_SECRET`, `STRIPE_SANDBOX_PRICE_IDS` | Stripe **test mode** | create test-mode prices for all five plans; register the staging webhook endpoint | 4, 14 |
| PayPal sandbox | `PAYPAL_SANDBOX_CLIENT`, `PAYPAL_SANDBOX_SECRET`, `PAYPAL_SANDBOX_WEBHOOK_ID`, `PAYPAL_API_BASE` | PayPal **sandbox** | create a sandbox app + plans; point `PAYPAL_API_BASE` at the sandbox endpoint | 5, 14 |
| SAML test IdP | `SAML_TEST_IDP_METADATA`, `SAML_TEST_CERTIFICATE`, `SAML_TEST_ENTITY_ID`, `SAML_TEST_ACS_CONFIGURATION` | dedicated test IdP tenant | create the tenant/app; register the Staging ACS URL | 6 |
| OIDC test application | `SsoConnection` row (issuer, client id, client secret) on a Staging Organization | test/sandbox OIDC tenant | register the app with the Staging redirect URI; create the connection in the running app | 7 |
| SCIM test client | Staging Organization + SCIM bearer token | same test identity tenant | enable SCIM provisioning against the Staging SCIM base | 8 |
| Staging email | `STAGING_EMAIL_TRANSPORT`, `STAGING_EMAIL_SENDER`, `STAGING_TEST_MAILBOX` | staging sender domain, controlled mailbox | verify a staging sending domain; supply a mailbox this run controls | 9 |
| Staging webhook receiver | `STAGING_WEBHOOK_RECEIVER`, `STAGING_WEBHOOK_SECRET` | receiver controlled for the run | stand up the receiver; register the endpoint | 10 |
| Staging web/API origins | `STAGING_WEB_BASE`, `STAGING_API_BASE` | HTTPS behind the staging reverse proxy | deploy the release candidate with strict CSP and production-like cookies | 13, 14 |
| Deployment authorization | — | — | approve a staging deploy mechanism (branch, artifact or image). Pushing `main` triggers a **production** GHCR build and is not a staging path | all |
| Release-artifact composition | — | — | ship `20270923500000_persona_profiles_removal_precondition` with `20270924000000_drop_workspace_persona_profiles`, or exclude the drop from the artifact | 1 |

Do not paste any secret into chat or into this repository. Place them in the
approved Staging secret store or environment.

## Carried, and not reclassified as Point-8 passes

```text
OWNER PRODUCTION QUEUE INCIDENT AUDIT
POINT 6 PRODUCTION MIGRATION RECONCILIATION
```

Both remain owner read-only prerequisites. Neither is resolved, advanced or
substituted for by anything in this pass.
