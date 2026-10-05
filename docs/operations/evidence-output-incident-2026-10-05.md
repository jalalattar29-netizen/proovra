# Evidence-output incident — 2026-10-05

Record `c30b0572-96d8-44fb-80d0-94f4520b8980` · account `reem.ammar@hotmail.com` ·
workspace "Reem Ammar's Personal Space". Status **SIGNED**, no Report PDF, no
Verification Package, notification "Trusted timestamp failed … no timestamp trust anchor is
configured", attention items *Storage protection incomplete*, *Public verification not
configured*, *Imported upload*, *No case assigned*.

## What this investigation could and could not see

The investigating session had **no Production credentials** (the only ones on the machine are
in `services/api/.env`, which it may not read) and the API/worker run on a hand-operated VPS.
Production was contacted **read-only, unauthenticated, GET only**:

| Probe | Answer | What it proves |
|---|---|---|
| `GET https://api.proovra.com/health` | 200 | API up, database reachable |
| `GET https://api.proovra.com/readyz` | **503 `{"status":"degraded","reason":"tsa_trust_configuration_incomplete"}`** | TSA is ENABLED in the API and its trust configuration is incomplete (`tsaTrustConfigurationIssues`) |
| `GET /v1/admin/billing/internal-plan-grants` | **401** (a nonexistent sibling: 404) | the deployed API **contains the internal-grant routes** — it runs a build at or after `7ebcc974`; the image revision itself is not exposed |

Nothing in Production was modified. No database row, log, queue, Sentry event or S3 object
was read, so every persisted-state verdict below that needs one is **UNDECIDABLE** with that
reason, and §5 gives the exact read-only commands that decide it.

## 1. Deployment matrix

| Component | Expected | Actual | Compatible | Evidence |
|---|---|---|---|---|
| Web | `origin/main` | `1b65859` (Vercel `proovra-web` success on that SHA) | yes | commit status |
| API | `1b65859` | **contains internal-grant code** (≥ `7ebcc974`); exact SHA undecidable | yes, if it is `1b65859` | 401-vs-404 route probe |
| Worker | same as API | undecidable (port 8090 is not public) | undecidable | — |
| Database schema | all migrations through `20281002000000` | undecidable; the API serving Personal plan resolution without `UNRESOLVED` is consistent with `plan_grants` existing | undecidable | `ops:internal-grant-rollout verify-schema` (§5) |

## 2. Root causes

### Report — not issued: **SKIPPED_BY_POLICY** (by the current entitlement), not a pipeline failure
* The sentence "No report has been issued … under its current plan" is `OUTPUT_STATE_COPY.NOT_INCLUDED`,
  chosen by `deriveEvidenceOutputState` (`packages/shared/src/evidence-output-lifecycle.ts`) only when
  the **current** eligibility (`resolveEvidenceOutputEligibility` → `resolveCommercialPlan`, grant-aware)
  is `NOT_INCLUDED`.
* For a record in a PERSONAL workspace, an **active** TEAM grant resolves `ENTITLED`
  (`resolveWorkspaceEffectivePlan` → `resolvePersonalEffectivePlan`; integration-tested), which
  would render `ELIGIBLE_NOT_GENERATED` ("First issuance pending" + Generate), not this sentence.
  With the deployed API carrying the grant code, the sentence therefore means: **at read time the
  account's effective plan did not include reports — provider plan FREE and no active grant.**
  Grant state: *merged and deployed; activation not performed* (the owner had not run §6 of the
  rollout runbook; this session never activated it).
* At finalization the same resolver decides `shouldEnqueueReport`; a FREE plan enqueues nothing and
  persists **nothing** that records the skip (no request row, no event). So "was a job produced?" →
  **NOT_ATTEMPTED by policy**, provable only by the absence of a `report_generation_requests` row (§5).
* Plan at creation / finalization / now: **FREE (provider entitlement), no grant** — inferred from
  the UI state + deployed code, not read from the database; `snapshot` in §5 proves "now".

### Verification Package — not issued: **NOT_ATTEMPTED (follows the report)**
A package is produced inside the report job at the same version and needs both entitlements;
with no report the package action is `NONE / FOLLOWS_REPORT`. It is not independently plan-blocked,
not TSA-blocked, and not hidden by the UI (both download buttons are real `<button disabled>` with
the reason in `title`/`aria-describedby`; their handlers are never invoked while disabled).

### Trusted timestamp — **BLOCKED_BY_CONFIGURATION**
TSA is enabled in Production (`/readyz` proves it) and the API — the only service that requests
and validates RFC 3161 replies, synchronously inside finalize — has **no trust bundle it can read**:
`docker-compose.prod.yml` gave `proovra-api` **no volume at all**, so any `TSA_TRUST_BUNDLE_PATH` in
the env file named a file that cannot exist in the container → `tsa_trust_anchor_not_configured`.
The reply was **granted and kept** (`tsaTokenBase64`, serial, genTime, imprint, policy), so it can
be validated later without re-contacting the authority. Whether there were *additional* failures
(policy OID, imprint, chain) is UNDECIDABLE until a bundle exists — the dry-run in §5 answers it.
The container healthcheck probes `/health`, so nothing stopped this deploy; the rollout runbook's
deploy script waits for `/readyz` and would have refused.

TSA failure blocks neither the report nor the package (by design): reports state the failure,
packages omit `timestamp.tsr` and say why.

### OTS — independent of TSA
OTS stamps the canonical fingerprint, reads no `tsa*` column, and is shown as a separate row
(Integrity tab, report, inbox). Its state for this record is UNDECIDABLE here (`smoke` in §5).

### Storage protection incomplete — **OTHER_WITH_PROOF (product read-model defect) + undecidable fact**
The review summary returns `verified: false` for every record whose Object Lock was RECORDED at
sealing (ET-PKG-06: recorded ≠ observed), and the alert fired on `!verified`. So the alert appears
**whether or not the object is protected**: it cannot distinguish a COMPLIANCE lock in force from
no lock. Whether this record's object actually carries retention is UNDECIDABLE here; `smoke` (§5)
prints the recorded mode / retain-until / legal hold and the classification. Fixed (§3).

### Public verification not configured — **product defect**
It did **not** mean "no share link". It was `publicVerifyState NOT_PUBLISHED` **and**
`Boolean(ANCHOR_PROVIDER)` false — the unrelated external-anchor provider (not TSA, not OTS, not
Public Verify). The intelligence layer had already dropped that coupling; the route still carried
it. The record is simply private (every record finalizes `NOT_PUBLISHED`). Fixed (§3).

### Imported upload / No case assigned — correct, informational
`PROOVRA_WEB_UPLOAD` without a folder path; no case the viewer can open.

## 3. Code defects fixed (branch `fix/evidence-output-incident`)

| # | Defect | Fix |
|---|---|---|
| 1 | Storage alert fired on `!verified` — a recorded, in-force lock read "not fully configured" | ONE classifier `classifyStorageProtection` (`@proovra/shared`): PROTECTED / RETENTION_EXPIRED / NOT_APPLIED / UNCONFIRMED; review alert, status label, summary `protection` field |
| 2 | Integrity tab showed "Not exposed in current API response" for a recorded lock | describes mode, retain-until and provenance from the same classifier |
| 3 | Library "protected" filter + page count used `verified`; workspace counter used "any lock column non-null" (expired / OFF hold counted) | both use the classifier; DB predicates written NULL-safely |
| 4 | "Public verification not configured" derived from `ANCHOR_PROVIDER` | availability no longer reads it; unpublished = private, info severity, truthful copy (API + web) |
| 5 | Report PDF said "Trusted timestamp could not be obtained" for a reply that WAS obtained but not validated | callout reads `tokenPresent`: "received but not validated" (+ the no-trust-anchor cause); still a failure tone, never "recorded" |
| 6 | Two `TSA_ENABLED` readers ("true" vs "true"/"1", trimmed vs not) | one `isTsaEnabled` |
| 7 | TSA remediation guidance said every failure "could not be obtained … cannot be corrected" | states both classes: never re-contacted; a kept reply can be validated once trust is configured |
| 8 | `proovra-api` had no way to read a trust bundle | read-only mount `/opt/proovra/app/secrets/tsa → /run/proovra/tsa`, `TSA_TRUST_BUNDLE_PATH` fixed to the mounted file |
| 9 | Artifacts panel rendered nothing for `ENTITLEMENT_UNAVAILABLE` | a status panel that says it is neither a plan refusal nor a failure |
| 10 | "not issued … under its **current plan**" read as the record's plan | names the workspace's current plan (web, mobile, API, generation outcome) |
| 11 | `smoke-evidence-forward-path` flagged every current FAILED-TSA row as a violation (stale Issue-#8 probe) and omitted the failure code / version id | probe matches what finalize writes; prints `tsaFailureCode`, never-validated check, storage classification, version-id presence |

**Product findings (not changed — a rule is needed, not a guess):**
* An output earned under an internal grant records its basis as `PAID_SUBSCRIPTION` and, as an
  earned fact, survives the grant's expiry. Whether grant-earned outputs persist after expiry, and
  whether the basis should read `INTERNAL_GRANT`, is a commercial decision.
* The first-issuance reconciler's "recently activated" pass reads only `subscription.activatedAtUtc`;
  a grant-only account is reached by the global scan, and records signed > 7 days earlier need
  `OUTPUT_HISTORICAL_FIRST_ISSUANCE_ENABLED`. The manual **Generate** action covers this record.
* Ordering: a commercial NOT_INCLUDED outranks a past technical failure in `deriveEvidenceOutputState`
  (documented design). It is truthful while eligibility is computed from the current plan; revisit if
  that changes.

## 4. Remediation shipped (2026-10-05, second pass)

* **TSA contract** (`docs/operations/tsa-trust-configuration.md`): only the
  official trust bundle is required; `TSA_TRUST_ANCHOR_SHA256` (pin over the
  bundle's roots) and `TSA_ACCEPTED_POLICY_OIDS` (allowlist) are optional and
  enforced when set; `/readyz` names the exact issue in `issues`.
* **`scripts/install-tsa-trust-bundle.sh`** installs exactly GLOBALTRUST 2015
  (root, `416b1f9e…b3cc`) + GLOBALTRUST 2015 QUALIFIED TIMESTAMP 1
  (`94552234…3fc9`) from globaltrust.eu, verified by fingerprint and chain.
* **Kept-token validation** (`repair-tsa-failed-with-token`) preserves the
  recorded serial / genTime / imprint and refuses a token that contradicts them.
* **`ops:recover-evidence-outputs`** (`status` / `recover`): first issuance and
  package recovery through the canonical report authority; proven end to end
  against the real worker processor (FREE skip → grant → one report + one
  package → replay creates nothing).

## 5. Owner procedure

The exact, ordered copy-paste commands: [reem-team-grant-tsa-output-procedure.md](reem-team-grant-tsa-output-procedure.md)
(trust bundle → compose render → schema → deploy with `/readyz == 200` → grant with
before/after snapshots and replay → kept-timestamp validation → output recovery → proof →
rollback). Nothing in it deletes evidence, reports or packages.
