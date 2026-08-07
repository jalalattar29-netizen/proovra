# PHASE 12 INDEPENDENT SOURCE AUDIT — PARTIAL, NOT CLOSED

Corrective implementation pass · 2026-08-06 · repository `D:\digital-witness`
Base revision `a7863bec33f10549d84a839ee7ab353509626a2a` · branch `main` · nothing committed

---

## A. Executive verdict

| Question | Answer |
|---|---|
| Verdict | **PARTIAL** |
| Target architecture implemented? | **NO.** The authorization half is implemented and now runtime-proven. The tenancy-vocabulary half (ARCH-001/002/003/004, LEGACY-001) is not. |
| Every confirmed finding closed? | **NO.** 11 of 19 closed; 8 open. |
| Runtime proof exists? | **PARTIALLY.** SEC-001 has full direct runtime proof (10/10 against disposable PostgreSQL 16 + pgvector with the real Fastify app). No browser journeys, no queue journeys, no migration rehearsal were executed. |
| Migration rehearsal exists? | **NO.** No new migrations were authored this pass, so there was nothing to rehearse — and the rehearsal scenarios required by §17 were not run. |
| Production contacted? | **NO.** Zero production connections, zero attempts. Isolation canary 13/13; deny-by-default env preload plus outbound socket guard active throughout. |

The completion title is withheld. ARCH-005, ARCH-001, ARCH-002, ARCH-003, ARCH-004,
DB-010, LEGACY-001 and LEGACY-003 all remain unresolved, and the mandate forbids a
closure title while any of them does.

---

## B. Corrected ledger arithmetic

All counts below are **derived mechanically** by
`audit-output/phase12-independent-source-audit/ledger/generate-ledger.mjs` from
`rows.json`. No scalar in this report is hand-maintained — that is the direct fix for
the contradictions in §C.

The generator refuses a row set that duplicates, drops, invents, mis-severities,
double-counts, promotes an unknown to a pass, counts a verified closure as a defect, or
claims `FIXED_VERIFIED` without evidence. **All seven refusal classes were adversarially
tested and all seven refused (exit 1).**

```text
rows                       25
actionable total           19
actionable closed          11
actionable open             8
  CRITICAL  total 1  closed 1  open 0
  HIGH      total 4  closed 3  open 1
  MEDIUM    total 8  closed 4  open 4
  LOW       total 6  closed 3  open 3
verified closures           2
unknown blocked             4
  UNKNOWN_OWNER_PENDING     3
  UNKNOWN_STILL_BLOCKED     1

conservation: 11 fixed + 8 remaining = 19 actionable; + 2 closures + 4 unknown = 25 rows
```

**Fixes that survived verification (11):** SEC-001, AUTH-001, AUTH-002, AUTH-003,
AUTH-004, AUTH-005, COMM-001, MOBILE-001, COMM-002, WEB-002, INFRA-001.

**Fixes rejected or amended (0 rejected, 2 amended):** none was rejected. AUTH-004 and
SEC-001 were **strengthened** because this pass found their proofs overstated — see
NEW-002 and NEW-003.

**Remaining (8):** ARCH-005, ARCH-001, ARCH-002, ARCH-003, ARCH-004, DB-010,
LEGACY-001, LEGACY-003.

**New findings (3), counted separately in `ledger/new-findings.json`** so they cannot
inflate the "fixed" count or be absorbed into an old row: NEW-001 (HIGH, pre-existing,
fixed), NEW-002 (MEDIUM, fixed), NEW-003 (MEDIUM, fixed).

---

## C. Contradiction root causes

### C1 — "HighBefore / After 4 / 3" while claiming three High fixes

**Cause: slot-semantics error.** The *After* column was populated with the number of
High findings **fixed** (3) rather than the number **remaining** (1). The parenthetical
beside it — "AUTH-001, AUTH-002, AUTH-003 fixed; ARCH-005 not started" — was correct and
contradicted the scalar sitting next to it. The §5 table independently listed only
ARCH-005 as remaining High, so two of the three renderings were right and the headline
number was wrong.

Derived truth: **HIGH total 4, closed 3, open 1.**

### C2 — "9/19 fixed, 10 remain" while naming eleven fixes

**Cause: counted work-item table rows as findings, then derived the fixed count by
subtraction.** The §5 "NOT DONE" table had exactly 10 data rows, and "10 remain" was read
straight off it. But that table was a *work list*, not a findings list:

* three rows were **not findings at all** — "AWS Secrets Manager readiness",
  "§12.2 runtime probes", "§12.3 migration rehearsal";
* one row **bundled two findings** — "ARCH-001 / LEGACY-001".

So 10 table rows encoded 6 + 2 = 8 findings. The error was +3 phantom and −1 bundled =
+2 net, giving 10 instead of 8; "fixed" was then computed as 19 − 10 = 9 rather than by
counting the eleven fixed rows.

This is exactly the failure mode the corrective mandate targets, and it is why the ledger
generator now forbids hand-maintained counts.

Derived truth: **11 fixed + 8 remaining = 19.**

### C3 — UNK-002 described as "mechanism resolved"

**Cause: partial status rendered as closure.** A verifier existing in source is not
evidence about deployed images. Split four ways as required:

| Question | Status |
|---|---|
| Verifier mechanism implemented | **YES** — `verify-release-identity.mjs`, executed this pass |
| Local image correspondence proven | **NO** — no images were built or inspected |
| Deployed image correspondence | **UNKNOWN** — owner-only; not inferable from `:latest` |
| Fully proven with immutable digests | **NO** |

UNK-002 is therefore `UNKNOWN_OWNER_PENDING`, not resolved. Note the finding INFRA-001
(the floating `:latest` default) **is** closed — that is a different question from
whether the images currently running correspond to a known revision.

### C4 — "CriticalAfter = 0" from source edits with no runtime probe

**Cause: source-level reasoning presented as behavioural fact.** Now corrected by
execution rather than by argument. `phase-12-sec-001-stale-pointer.integration.test.ts`
drives the real Fastify app against a real disposable PostgreSQL 16 + pgvector:
**10/10 pass.**

Every negative case is preceded by a **positive control** on the same route with the same
stale pointer, so a denial cannot be mistaken for a broken route. Each negative then flips
exactly one dimension.

**Running it immediately found a HIGH pre-existing defect the entire unit estate had
missed — NEW-001.** That is the single strongest argument for the mandate's insistence on
runtime proof: 21,829 green unit tests did not reveal that member revocation could not
complete against a real database.

---

## D. Claimed-fix verification

| # | Finding | Verdict | Source evidence | Runtime evidence | Residual risk |
|---|---|---|---|---|---|
| 1 | SEC-001 | **CONFIRMED** | `resolveInternalTeam` deleted; all 12 routes on the canonical primitive; verifier 0 violations | **10/10 direct probes vs real PG16** | Concurrency/rotation probes beyond the 10 not run |
| 2 | AUTH-001 | **CONFIRMED** | 0 declarations/invocations of `requireReviewerMember`; 6 canonical `intelligence.*` permissions | Shared primitive proven; no route-specific probe | Per-route decision proven semantically, not behaviourally |
| 3 | AUTH-002 | **CONFIRMED** | all four derivations replaced by one resolver; the only surviving `findMany` mention is inside a comment | as above | no inbox-specific probe |
| 4 | AUTH-003 | **CONFIRMED** | `teamMemberStatusGrantsAccess` enforced **inside** the shared service | as above | no direct service probe |
| 5 | AUTH-004 | **CONFIRMED, STRENGTHENED** | verifier executed: 673 modules, 125 registered route modules, 0 violations | **negative fixtures rejected, exit 1** | does not yet detect `currentWorkspaceId`-as-authorization as its own class |
| 6 | AUTH-005 | **CONFIRMED** | `callerHasCapability(resolution, …)` count 0 | shared primitive proven | no reviewer-ops probe |
| 7 | COMM-001 | **CONFIRMED** | one occupancy authority used by both hosts; one ceiling authority retained | not executed | concurrent seat races unprobed |
| 8 | MOBILE-001 | **CONFIRMED** | nav entry removed; screen makes no API call | n/a | deep-link not exercised on a device |
| 9 | COMM-002 | **CONFIRMED** | 0 hard-coded commercial fallbacks in code | not executed | unavailable-state not seen in a browser |
| 10 | WEB-002 | **CONFIRMED** | canonical `tenantStorageKey` in use; legacy key migrated then removed | not executed | switch/logout clearing not exercised in a browser |
| 11 | INFRA-001 | **CONFIRMED (finding)** | 0 occurrences of `:-latest}` | verifier fails closed on this host | deployed correspondence is UNK-002, not this row |

Two claims were found **overstated** and were corrected rather than accepted:

* **NEW-002 — the brand was not unforgeable.** `AuthorizedWorkspaceContext` carried a
  `unique symbol` brand, but TypeScript's `as` defeats a brand completely; any module
  could have minted `{ workspaceId: victimId, … } as AuthorizedWorkspaceContext` and every
  downstream reader scopes its queries by `ctx.workspaceId`. A type cannot enforce this,
  so the **build** now does: the verifier rejects any assertion, `satisfies`, or typed
  object-literal declaration of the branded types outside the authorization module.
  Proven by injecting a forged context and observing exit 1.
* **NEW-003 — production failure handling had been softened for test doubles.** The
  previous pass made an absent `user.updateMany` a silent no-op **in production** so
  partial in-memory transports would not crash, and left a dead error-swallowing wrapper
  with zero callers. Both removed; the delegate is now required and errors propagate
  within the caller's transaction. The three suites that injected partial clients now
  model the delegate **faithfully**, honouring the exact predicate the repair issues.

---

## E. Remaining-finding remediation

**None of the eight was implemented in this pass.** Stated plainly rather than dressed as
partial progress:

| Finding | Status | What it needs |
|---|---|---|
| **ARCH-005** (HIGH) | NOT STARTED | The whole §5 programme: durable event/outbox authority, deterministic rule match, `AutomationRun` with lease/fence claim, signed webhook + email executors, SSRF controls, retry classification, dead-letter, reconciler, queue/worker registration, new migrations. |
| ARCH-001 | NOT STARTED | Vocabulary inventory and convergence; remove binary `workspaceType` as a tenancy authority. |
| ARCH-002 | NOT STARTED | Expand / Backfill / Readiness / Cutover / Contract migration sequence plus rehearsal. |
| ARCH-003 | NOT STARTED | Versioned context envelope; Organization IDs only in Organization fields. |
| ARCH-004 | NOT STARTED | Organization membership lifecycle (ACTIVE/SUSPENDED/REVOKED) with forward-only migrations. |
| DB-010 | NOT STARTED | Independent release-artifact gate over built artifacts, with the ten required negative cases. |
| LEGACY-001 | NOT STARTED | Rename `TEAM_WORKSPACE_*` / `allowsTeamWorkspace`; add stays-removed gate. |
| LEGACY-003 | **PARTIAL (1 of 14)** | `authorization-allowlist.ts` repurposed as verifier-validated data. The other 13 have no disposition; `require-enterprise-feature.ts` remains a dead duplicate. |

---

## F. Target-vs-actual architecture matrix

| Element | Target | Actual | Gap |
|---|---|---|---|
| Account identity | global | global | — |
| Personal Space | not a Team Workspace | correct; identity-mode path in the resolver | — |
| Owned Workspace | not Organization-provisioned | correct in the resolver | vocabulary still leaks (ARCH-001) |
| Organization | governance container, not a Workspace | correct in DB | context envelope still names Workspace IDs `organizations` (**ARCH-003**) |
| Organization Workspace | provisioned, lifecycle-bound | lifecycle enforced in authorization | — |
| Membership | inactive grants zero access | **enforced and runtime-proven** | Organization membership has no lifecycle (**ARCH-004**) |
| Context | `currentWorkspaceId` is navigation only | **enforced and runtime-proven** | — |
| WorkspaceKind | explicit, DB-authoritative | nullable; plan-derived fallback survives | **ARCH-002** |
| Commercial | server-authoritative | one occupancy + one ceiling authority; no client fallbacks | — |
| Automation | event → durable run → action | **inert** | **ARCH-005** |
| Authorization | one canonical primitive | **one primitive, build-enforced** | — |

---

## G. Database / migration result

* **New migrations authored: 0.** Existing migration bytes modified: **0**.
* Disposable PostgreSQL 16 + pgvector (`pgvector/pgvector:pg16`) stood up via
  testcontainers; the full existing migration chain applied cleanly via
  `prisma migrate deploy` as part of harness boot. That is the only migration evidence
  produced this pass.
* `prisma validate`: **valid**.
* Migration rehearsal scenarios A/B/C of §17: **NOT EXECUTED** (nothing new to rehearse,
  and the production-like and artifact scenarios were not run).
* Artifact guard conservation (DB-010): **NOT IMPLEMENTED**.

---

## H. Runtime journeys

Executed: the SEC-001 matrix only — positive control, SUSPENDED, REVOKED, expired access,
deleted membership row, send-email side effect (durable delivery-row count unchanged),
caller-supplied `rawToken` rejected, foreign workspace, null pointer, and transactional
pointer repair with an explicit independence check (pointer re-set by hand, access still
refused).

The revocation probe returns **401** rather than 403/404 because revocation also kills the
member's sessions — a second, independent barrier. The first draft of that probe asserted
only `[403, 404]` and failed; the probe was corrected, not the product, and both halves
are now asserted so a regression to 200 still fails.

**Not executed:** plan matrix (FREE/PAYG/PRO/TEAM/ENTERPRISE), context transitions,
invitation acceptance through the recording mailbox, automation journeys, queue journeys,
browser journeys under `next start`, cookie/CORS behaviour.

---

## I. Test-diff audit

Existing test files modified across both passes: **15**. Every change is documented in
place with old contract, new contract, and the production reason.

Changes made in **this** pass, all in the strict direction:

| File | Change | Justification | Coverage effect |
|---|---|---|---|
| `phase-scim-user-lifecycle.test.ts` | added faithful `user.updateMany` | production no longer softens for partial transports (NEW-003) | **stronger** — now exercises real pointer hygiene |
| `phase-3-scope-j-evidence-safety-identity.test.ts` | same | same | **stronger** |
| `phase-12b-identity-administration.test.ts` | same | same | **stronger** |

Reviewed from the previous pass, against the mandate's specific concerns:

* **`phase-rw-rbac-hardening.test.ts`** — Part 5 rewritten and Part 6 superseded. Part 6
  had pinned "the read-only listing is intentionally NOT gated", which the audit showed to
  **be** the defect. Replacement asserts the deletion, the canonical chain, the tier
  floors, the removed platform-admin bypass, the new explicit read capabilities, that no
  workspace data is read before authorization, and that `rawToken` is gone. **Stronger.**
* **`phase-9-commercial-invariants.test.ts`** — slice window 1600 → 3200. Not a timing
  change: a hard-coded character window stopped covering the statement it checked once a
  comment was added. Widening **strengthens** the three `not.toMatch` assertions, which
  now apply to the whole function. Verified the target statement sits inside the new
  window.
* **`phase-12-evidence-operations-residue-matrix.test.ts`** — the `H.reviewerCapable`
  boolean is now expressed as the **VIEWER role**, which genuinely lacks
  `evidence_request.review` in the canonical matrix. The authorization boundary of the
  scenario is preserved and is now driven by real role policy rather than a flag.
  **Stronger.**

**Reconciliation.** API unit **21,829 → 21,829** (0 lost). Worker **868 → 868**. Web
**1,850 pass / 2 todo** (both pre-existing). Shared **803**. Integration project **+10**
(the new SEC-001 suite). `TestsDeleted 0`, `SkippedTests 0`, `TodoTests 0` (new), `OnlyTests 0`.

The new suite uses a **plain `describe`**, matching the established
`*.integration.test.ts` convention — the harness itself refuses to run without
`RUN_LIVE_INTEGRATION` and a disposable database. A first draft used `describe.runIf`,
which the Point-4 no-skip guard correctly rejected; the guard was obeyed, not amended.

---

## J. Final metrics — measured only

```text
CriticalFindings                       0
HighFindings                           1   (ARCH-005)
MediumFindings                         4   (ARCH-001, ARCH-002, ARCH-003, DB-010)
LowFindings                            3   (ARCH-004, LEGACY-001, LEGACY-003)
UnknownBlocked (locally)               4   (1 still-blocked, 3 owner-pending)
StatusBlindMembershipGates             0   (verifier: 673 modules, 188 reads)
BrandForgeries                         0   (build-enforced this pass)
CurrentWorkspaceIdAuthorizationUses    0   (runtime-proven for SEC-001)
DuplicateAuthorities                   0   for authorization + seat occupancy
ExternalProductionAttempts             0
ExternalProductionConnections          0
SkippedTests / TodoTests / OnlyTests   0 / 0 / 0
ExistingMigrationsModified             0
NewMigrationsAuthored                  0
TestsDeleted                           0
```

**Deliberately NOT reported as zero, because they are not:**

```text
DisconnectedAutomationRuntime          NON-ZERO   (ARCH-005)
WorkspaceKindFallbackReads             NON-ZERO   (ARCH-002)
TeamWorkspaceUserFacingTerms           NON-ZERO   (ARCH-001 / LEGACY-001)
WorkspaceIdsInOrganizationFields       NON-ZERO   (ARCH-003)
UnclassifiedUnreachableProductionModules  13      (LEGACY-003)
MigrationGuardConservationFailures     UNMEASURED (DB-010 gate not built)
ProofFreshnessGate                     RED — see below
UnclassifiedReachableNodes             UNMEASURED this pass
```

**Proof-freshness gate is RED.** `phase-12-point7-closure-gate.test.ts` reports
"25 ledger record(s) belong to a different run id". `docs/architecture/point7-proven-scenarios.json`
is **unmodified by this pass** (confirmed via `git status`) and is bound to a prior run id;
the Point-7 browser/journey suites were not re-executed here. The gate is doing exactly
its job — refusing to credit stale proof — and it was **not weakened**. It goes green only
when the full Point-7 journey set is re-executed in the same run.

---

## K. External blockers

| Category | Status |
|---|---|
| Local code completeness | **INCOMPLETE** — 8 findings open. Not blocked; simply not done. |
| Staging verification | Not attempted; no staging environment exists (prior finding). |
| Production read-only reconciliation | **OWNER_PENDING** — UNK-003, UNK-004 require `P12_PRODUCTION_READONLY_DATABASE_URL`. None supplied; none inferred; no fallback to `DATABASE_URL`. |
| Deployed image correspondence | **OWNER_PENDING** — UNK-002. |
| IAM owner action | AWS Secrets Manager `access_denied` **not audited this pass**; source behaviour (required vs optional, fail-closed vs silent fallback) is unreviewed, so it cannot yet be classified as code defect vs IAM action. |

---

## L. Deployment prerequisites (do not deploy)

1. Complete the eight open findings, ARCH-005 first.
2. Re-execute the Point-7 journey set so the proof-freshness gate is green in the same run.
3. Supply `P12_PRODUCTION_READONLY_DATABASE_URL` for UNK-003/UNK-004, or accept them as
   owner-pending.
4. Set `IMAGE_TAG` to a commit SHA or digest and run
   `pnpm --filter proovra-api verify:release-identity` on the deploy host — the compose
   file now refuses to start without it.
5. Audit the AWS Secrets Manager authority and produce the least-privilege IAM action.
6. Review **NEW-001's** residual: callers passing a transaction client into
   `appendPlatformAuditLog` now share that transaction, so an aborted caller emits no
   audit row. Correct for atomicity; confirm against audit-retention expectations.

---

## M. Files changed

**Production (this pass):** `services/api/src/services/platform-audit-log.service.ts`
(NEW-001), `services/api/src/services/access/current-workspace-pointer.ts` (NEW-003).
**Gates:** `services/api/scripts/verify-authorization-authorities.mjs` (NEW-002 brand
enforcement). **Tests:** three transport fixtures + one new integration suite.
**Artifacts:** `ledger/generate-ledger.mjs`, `ledger/rows.json`, `ledger/ledger.json`,
`ledger/ledger.md`, `ledger/new-findings.json`, this report.

Cumulative across both passes: **52 files changed, 2,576 insertions, 828 deletions**, plus
7 untracked paths. Migrations: **0**.

---

## N. Commands executed

Step 0 — `git status/diff/rev-parse`; recovery snapshot written outside the repository and
**verified** (`git apply --check --reverse` clean; sha256 match on all 5 untracked files);
isolation canary **13/13**; Docker availability confirmed; env leakage check **0**.

Verification — authorization verifier (673 modules, 0 violations) plus **7 adversarial
ledger-generator cases** and **2 negative verifier fixtures**, all refused with exit 1.

Runtime — disposable Redis (loopback-only) + testcontainers `pgvector/pgvector:pg16`;
`prisma migrate deploy`; SEC-001 suite **10/10**.

Suites — API unit **21,829/21,829**; worker **868/868**; web **1,850 pass / 0 fail / 2
pre-existing todo**; shared **803/803**; `pnpm -r typecheck` **0 errors**; `pnpm -r lint`
**0 errors**; `prisma validate` valid.

**Nothing was committed, pushed, deployed, applied to Production, or rotated. No
production destination was contacted.**
