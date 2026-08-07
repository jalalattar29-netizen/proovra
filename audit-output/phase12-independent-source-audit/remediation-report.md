# PROOVRA — Phase 12 Focused Reachability Remediation

Source revision at start `a7863bec33f10549d84a839ee7ab353509626a2a` · branch `main` · 2026-08-06
Counting basis: [`remediation-ledger.md`](remediation-ledger.md) (Step 0)

---

```text
RemediationStatus              PARTIAL — Batch A COMPLETE; Batches B, D and parts
                               of C and F NOT STARTED. See §5.
CriticalBefore / After         1 / 0
HighBefore / After             4 / 3        (AUTH-001, AUTH-002, AUTH-003 fixed;
                                             ARCH-005 not started)
MediumBefore / After           8 / 4        (AUTH-004, AUTH-005, COMM-001,
                                             MOBILE-001 fixed)
LowBefore / After              6 / 3        (INFRA-001, COMM-002, WEB-002 fixed)
UnknownBefore / After          4 / 3        (UNK-002 resolved by a live verifier)
ProductionCodeFilesChanged     29 modified + 4 added = 33
NewMigrationsAuthored          0
ExistingMigrationsModified     0
TestsAdded                     0
TestsDeleted                   0
TestsSkipped                   0
```

**This is not a completion report.** Nine of nineteen actionable findings are fixed and
verified; ten are not. §5 states exactly which, and why. No completion title is claimed,
and the gate conditions for one are not met (`AutomationAdvertisedButUnreachable` is still
non-zero, `WorkspaceKindPlanFallbacks` is still non-zero, `DeadProductionModules` is still
non-zero).

---

## 1. Verification actually executed

Every number below was produced by running the command, not by inspection.

| Gate | Result |
|---|---|
| API test suite (`vitest run`, full) | **21,829 passed / 0 failed** |
| Worker test suite | **868 passed / 0 failed** |
| Web test suite (`pnpm test`) | **1,850 passed / 0 failed / 2 pre-existing todo** |
| `@proovra/shared` test suite | **803 passed / 0 failed** |
| `pnpm -r lint` (9 projects) | **clean** |
| `pnpm -r typecheck` (9 projects) | **clean** |
| API build (`tsc -p tsconfig.build.json`) | **clean** |
| Worker build | **clean** |
| Web production build (`next build`) | **clean** |
| `prisma validate` | **valid** |
| `verify-authorization-authorities.mjs` (new) | **0 violations** over 673 modules / 188 TeamMember reads |
| `verify-release-identity.mjs` (new) | **fails closed** on an unpinned host, as designed |

Test counts are reported as regression evidence only. They are not the acceptance
authority — the corrected source, the reachable call graph and the static verifier are.

**Not executed** (and therefore not claimed): the disposable-Postgres/Redis runtime probe
matrix of §12.2, the migration rehearsal of §12.3, and the browser verification of §12.4.
No disposable database was stood up in this session. Every claim below is a SOURCE and
STATIC-GRAPH claim, and is labelled as such.

---

## 2. Fixed defects

### SEC-001 — CRITICAL — cross-tenant read + outbound email off a stale pointer · **FIXED**

**Root cause.** `resolveInternalTeam` in `external-portal.routes.ts:187` read
`User.currentWorkspaceId` — a navigation hint — loaded the Team, denied only when the
pointer was null / the team missing / the team Personal, then read a TeamMember row with
**no status predicate** and returned `workspaceRole: membership?.role ?? null`. It
returned SUCCESS for a caller with no membership row at all and for a SUSPENDED or REVOKED
member. Four of its twelve callers never called `requireCap`, so nothing downstream
re-checked anything.

**Canonical correction.** `resolveInternalTeam` is **deleted**, not patched. A new
unforgeable primitive, `AuthorizedWorkspaceContext`, is added to the canonical
authorization module. It carries a module-private brand, so the only way any module in the
service can obtain one is to call a constructor that has already run the full chain:
identity → workspace existence → workspace kind (never UNKNOWN) → **explicit** membership
row → status ACTIVE → access expiry → parent-Organization lifecycle → canonical permission
→ support-access runtime guard. The chain is not reimplemented: it is exactly
`evaluateMemberAccessWithSnapshot` + `evaluateSupportContextGuard`, so there is one policy
authority and one audit emission per decision.

`authorizeCurrentWorkspaceOrFail` treats the pointer as an **input candidate only** and
revalidates everything against the database on every request.

**Files.** `services/api/src/middleware/authorize.ts` (primitive),
`services/api/src/routes/external-portal.routes.ts` (all 12 routes),
`services/api/src/services/identity/access-policy.service.ts` (snapshot one-shot).

**Reachable chain after correction.** `requireAuth` → `authorizeCurrentWorkspaceOrFail` →
`evaluateMemberAccessWithSnapshot` → `loadMemberAccessSnapshot` + `evaluateAccess` +
`recordPermissionDecision` → `evaluateSupportContextGuard` → branded context → handler.

**Tier preservation — a defect found *during* remediation.** The two vocabularies disagree:
the reviewer matrix grants `review.assign` to SUPERVISOR + REVIEW_ADMIN (workspace ADMIN +
OWNER), while the canonical `Permission` of the same name also includes REVIEWER (DB
`MEMBER`). Gating purely on the canonical permission would have **widened** access to plain
members. `isAdministrativeTier` / `isOwnerTier` re-apply the tier from `ctx.workspaceRole`
— the *proven* canonical role on the authorization proof, not a re-derived one — so the
admission set is preserved exactly.

**Deliberate tightenings.** The platform-admin bypass (`platformRole !== null` ⇒
REVIEW_ADMIN) is removed. The four previously-uncapped routes now carry explicit
capabilities: `GET .../invitations`, `.../activity`, `.../delivery` → `review.queue.read`;
`.../send-email` → `review.assign` + administrative tier.

**Route 10 of 12 — `POST /v1/portal/sso/callback` — classified, not migrated.** The actor
is an external reviewer completing a SAML flow: no PROOVRA identity, no `User` row, no
TeamMember row to authorize against. Requiring workspace membership would make the product
impossible, not safer. It is classified TOKEN_SCOPED with the reasoning recorded in source,
and it is **hardened**: the grant-derived anchoring workspace must now be a live operating
context (`isLiveOperatingWorkspace`), so org suspension no longer fails open on this
surface. A dead context conceals as `INVITE_NOT_FOUND`, identical to a nonexistent grant.

**Runtime evidence.** None executed. Static: the verifier reports 0 unclassified
TeamMember authorization reads; the rebuilt source-contract suite asserts the new chain,
tier floors, ordering (RBAC → step-up → mutation), and that no workspace data is read
before authorization completes.

---

### SEC-001 §4.3 — caller-supplied invitation token · **FIXED**

**Root cause.** `POST .../send-email` took `rawToken` from the **request body** and mailed
it. The caller decided what credential the reviewer received; the server neither minted it
nor could relate it to the grant. Separately, `resendInvitationEmail` mailed the literal
string `"RESEND_PLACEHOLDER_TOKEN"` — the reviewer got a link that could never
authenticate while the delivery row recorded SENT. And `rotateExternalReviewGrantToken`
claimed to rotate but only **read** a plaintext `ExternalReviewerRoleAssignment.rawToken`
column that **no production writer ever populates**, so the break-glass path was inert.

**Canonical correction.** One server-owned delivery authority, `deliverInvitationEmail`:
load invitation scoped to the authorized workspace → verify grant workspace and live state
→ **mint a successor token server-side** → atomically supersede the prior hash in a single
guarded `UPDATE` (predicate pins team, grant, live state, non-expired, so a concurrent
revoke wins) → build the acceptance URL server-side → persist the durable delivery intent →
send through the canonical transport under a durable delivery-row-derived idempotency key →
record a bounded outcome. `rawToken` is gone from the accepted request shape.

**Files.** `external-review-grant.service.ts`, `portal-invitation-email.service.ts`,
`portal-bulk-invitations.service.ts`, `external-portal.routes.ts`.

**Retry / rotation semantics.** A retry of the same attempt reuses the same delivery row
and therefore the same durable key. A deliberate resend is a different intent: it rotates
the token, mints a new delivery row, and takes a new key. Invitation history is preserved;
the predecessor stops authenticating the instant the rotation commits.

---

### §4.4 — stale `currentWorkspaceId` pointers · **FIXED**

**Root cause.** The pointer was cleared by org closure/lifecycle, workspace
closure/lifecycle and SCIM deprovision, but **not** by workspace membership revocation or
suspension. A revoked member retained a valid-looking pointer indefinitely.

**Canonical correction.** One repair authority,
`services/api/src/services/access/current-workspace-pointer.ts`, invoked transactionally at
every membership-withdrawal leg: `rbac.service.ts` suspend + revoke, and
`membership-provisioning.service.ts` source-aware revoke, legacy-provenance suspend,
individual suspend, SCIM/admin mass revoke, workspace-wide mass suspend.

It clears **to NULL only**. It never picks a replacement workspace (that would silently
relocate an operator into a tenant they did not choose — the mirror image of the defect
being fixed) and never relocates into Personal Space (`noPersonalSpace` forbids exactly
that; context restoration owns choosing a safe next context and revalidates DB authority
when it runs).

Each leg passes `(userId, workspaceId)` pairs it **already holds** — from the row its own
`update()` returned, or from a `findMany` widened by two columns — so the repair issues one
statement and never re-reads TeamMember.

**Load-bearing rule, enforced structurally:** authorization never depends on the cleanup
having run. `authorizeCurrentWorkspaceOrFail` revalidates the database regardless of the
pointer's contents, so a repair that does not happen cannot widen access.

---

### AUTH-001 — HIGH — status-blind intelligence gates · **FIXED**

`requireReviewerMember` and `requireMember` (`intelligence.routes.ts:80`, `:101`) 404'd
only when the TeamMember row was **absent**, then used `membership.role` verbatim. Neither
read `status`; neither consulted Organization lifecycle. A SUSPENDED or REVOKED member kept
full intelligence access **including enqueueing jobs**. (The module already imported
`evaluateMemberAccess` — it was used at one unrelated site. The engine was in the file; the
gates just did not call it.)

Both deleted. All five routes migrated to the canonical primitive: reads →
`intelligence.read`, writes → `intelligence.run` (OWNER/ADMIN/REVIEWER — the same tier the
former `evidence_request.review` role probe admitted). Anti-enumeration retained. The
enqueue path now completes authorization **and** the evidence tenant reload before any
durable effect, and compares the reloaded tenant against `ok.workspaceId` — the authorized
workspace — not against the request body.

---

### AUTH-002 — HIGH — status-blind inbox enumeration · **FIXED**

Four independent status-blind derivations in `me-inbox.routes.ts` (`:875` workspace set,
`:943` adjudicator privilege, `:2559` `?workspaceId` narrowing, `:2620` membership-loss
redaction). Most pointed: the redaction exists **specifically** to withhold content from
workspaces the caller can no longer access, and a REVOKED row satisfied its test, so it was
inert.

Replaced by one canonical resolver,
`services/api/src/services/access/accessible-workspaces.ts`. Only ACTIVE membership
contributes; member access expiry is honoured; ORGANIZATION-provisioned workspaces require
an ACTIVE parent Organization; an unprovable workspace kind fails closed; the ownership
fallback is restricted to `isPersonal = true` (identity mode) and no synthetic TeamMember
row is fabricated. It reuses the same classifier and the same status predicate as the
authorization primitive, so enumeration and authorization cannot disagree about who is
inside a workspace.

*Incidentally corrected:* the old ownership fallback queried `{ ownerUserId }` with no
`isPersonal` filter, sweeping OWNED workspaces into the set by ownership alone.

---

### AUTH-003 — HIGH — status-blind shared case-permission authority · **FIXED**

`resolveCaseDestructiveGate` loaded the full TeamMember row and never read `member.status`,
so a SUSPENDED/REVOKED row yielded its stored role. The reachable HTTP surface happened to
be defended by seven independent `status === "ACTIVE"` comparisons in `cases.routes.ts` —
which is precisely the shape the remediation forbids: a shared decision authority whose
correctness depends on every caller remembering to duplicate a check.

The check now lives in the service, once, using `teamMemberStatusGrantsAccess` — the same
predicate the access-policy engine and the destructive-action gate already use. An inactive
membership is reported identically to no membership; no stored role escapes the branch. All
production callers were audited (`case-workspace.routes.ts`, `cases.routes.ts`,
`matter-workspace.service.ts`).

---

### AUTH-004 — MEDIUM — a fictional governance control · **FIXED**

`authorization-allowlist.ts` declared itself the machine-checkable registry whose PENDING
list must be empty — and its PENDING list *was* empty while SEC-001, AUTH-001 and AUTH-002
all existed and appeared nowhere in it. It also had **zero production importers**. It
recorded a conclusion it never computed.

**Replaced by a live verifier**: `services/api/scripts/verify-authorization-authorities.mjs`.
It discovers route modules from **actual `app.register(...)` calls** in `server.ts`
(resolving each registered symbol back to its defining module, including the
`(await import(...))` form), walks the TypeScript AST of every production module, finds each
`teamMember.find*` / `.count` **semantically** as a call expression — so comments and doc
blocks mentioning `teamMember` are invisible to it, which is the false-positive class a
regex scan hits — and classifies each by reading the query's own `where` clause and its
enclosing function. **The default is VIOLATION, not ALLOW.**

Wired into `deploy-safe.mjs` as a pre-migration stage (static, read-only, no DB, no
network) and exposed as `pnpm --filter proovra-api verify:authorization`. Deliberately not
in the request path and deliberately not a source-regex test.

The ledger file is **retained as validated data**, not deleted (two existing suites assert
on its exports). The verifier now *checks* it: PENDING must be empty, and no EXCEPTION may
name a file that no longer exists. Reading the ledger can only **add** failures, never
suppress one — classification that actually excuses a call lives in the verifier's own
`CLASSIFIED_MODULES`, keyed by full path with a stated reason. One governance authority;
this is its input.

**The verifier immediately found 15 real unclassified reads that the audit had not listed.**
Thirteen were fixed by applying the canonical predicate; two were classified with recorded
reasons:

| Site | Disposition |
|---|---|
| `middleware/cron-secret.ts:78` | **FIXED** — a real ACTOR gate: a SUSPENDED/REVOKED OWNER/ADMIN satisfied the non-production cron fallback |
| `routes/enterprise.routes.ts:257` | FIXED — quota usage counted revoked members |
| `analytics/analytics.service.ts:200` | FIXED — "members who can act on reviews" counted inactive members |
| `collaboration/discussion.service.ts:507` | FIXED — an `@mention` could resolve to a revoked member and notify them |
| `governance/governance-dashboard.service.ts:185` | FIXED — MFA-coverage denominator |
| `dashboard/bulk-actions.service.ts:219` | FIXED — work bulk-assignable to a revoked member |
| `identity/external-identity.service.ts:86` | FIXED — SSO identity bindable to an access-less membership |
| `ops/operational-seed.service.ts:426` | FIXED — placeholder reviewer |
| `reviewer-ops/queue-intelligence.service.ts:202` | FIXED — used `suspendedAtUtc: null` as a liveness **proxy**, which a REVOKED row also satisfies (revocation stamps `revokedAtUtc`), so revoked members were offered as assignment candidates |
| `workflows/evidence-workflow-engine.service.ts:470` | FIXED — reviewer assignable while access-less |
| `automation/automation-actions.service.ts` ×3 | FIXED — notify/assign targets |
| `identity/access-review.service.ts:308` | CLASSIFIED — locates the membership a review is about to REVOKE/SUSPEND; requiring ACTIVE would make an already-suspended member un-revokable |
| `identity-security/session-timeout-policy.service.ts:108` | CLASSIFIED — informational role read for policy derivation; makes no allow/deny decision |

---

### AUTH-005 — MEDIUM — four status-blind reviewer-ops reads · **FIXED**

`reviewer-ops.routes.ts:647, :885, :2338, :2438` re-read the TeamMember row with
`select: { role: true }` and no status predicate to derive reviewer capability and
adjudicator authority. Separately, `requireReviewerActor` checked membership status **only** —
it called `evaluateMemberAccess` solely to compute an *advisory* flag, so a denial produced
`false`, never a denial, and **Organization lifecycle failed open on this surface**.

`requireReviewerActor` now composes the canonical primitive and carries the proof forward;
all four sites read `ctx.authorized`. Admission breadth is unchanged (baseline
`evidence.read`, held by every canonical role); the bounded denial vocabulary
(`404 not_found`, `403 REVIEW_ACTOR_BLOCKED / member_inactive`) is preserved verbatim.
`requireReviewerBulkCapable` — a fifth such read — was migrated the same way, preserving
the ADMIN+OWNER admission set of the former `review.bulk` capability.

---

### COMM-001 — MEDIUM — revoked members occupied seats · **FIXED**

**Two defects, one fix.** `billing.service.ts:328` and `worker/workspace-billing.ts:268`
counted `teamMember.count({ where: { teamId } })` with no status predicate. Additionally,
`cancelTeamPlan`'s comparison was the inline `memberCount > 0` — a **second** seat-ceiling
rule contradicting the canonical `computeOverSeatLimit`, under which `includedSeats: 0`
means *no ceiling*. The two disagreed about the very row `cancelTeamPlan` writes:
`refreshTeamSeatState`, running afterwards over the same workspace, would compute `false`
where this wrote `true`.

One shared occupancy authority in `@proovra/shared-runtime`
(`countActiveSeatOccupancy` + `activeSeatMembershipWhere`), used by both API and worker.
The inline ceiling rule is deleted; `computeOverSeatLimit` remains the single comparison
authority. **I deliberately did not add a second ceiling function to shared-runtime** — a
comment in that module records why.

```text
SeatLimitAuthorities        1   (computeOverSeatLimit)
ActiveMembershipPredicates  1   (teamMemberStatusGrantsAccess / status: "ACTIVE")
RevokedMembersCountedAsSeats 0
```

---

### MOBILE-001 — MEDIUM — disconnected mobile surface · **FIXED**

The Teams tab fetched `/v1/teams` and rendered each row with a hard-coded "Members"
subtitle, an empty badge, no `onPress`, no route push, and an empty state inviting "Create
a team" — an action the app does not implement anywhere.

Approved mobile scope is Personal-Space-only citizen capture (`apps/mobile/src/personal-space.ts`:
"no workspace switcher and no concept of an 'Organization workspace' target"). Building
selection here would mean inventing a partial capability, which is forbidden. So: the
navigation entry is **removed**; the route is **kept** so deep links land on an honest,
entirely non-interactive notice that makes **no API call** and names **no workspace** (so it
leaks nothing about the account's tenancy); the "Create a team" invitation is gone.
`noPersonalSpace` continues to fail closed independently, via `isPersonalSpaceDisallowed`.

---

### COMM-002 — LOW — client-side commercial authority · **FIXED**

The finding named `?? 2` / `?? 5`; there were **26** such literals (prices, storage labels,
evidence caps, AI operation caps, member and workspace limits). When the catalog was
unavailable the page did not say so — it advertised a number, silently, from a client-side
copy of a server-authoritative limit.

All 26 replaced by `catalogValue(...)`, which renders the served value or a bounded
`—` placeholder. It deliberately takes **no default parameter**, because a default is
exactly the client-side commercial authority being removed. Server enforcement is
untouched. `ClientCommercialAuthorities = 0` on this surface.

---

### WEB-002 — LOW — non-canonical tenant storage · **FIXED**

`proovra:search:recent:${teamId}` was correctly workspace-scoped — no cross-tenant leak —
but lived outside the canonical `proovra:tenant:<workspaceId>:<key>` namespace, so a
tenant-scoped purge walked past it and left search history on the device. Migrated to
`tenantStorageKey`, with a one-time migration that reads the legacy entry, rewrites it
canonically, and removes it (and removes a stale legacy twin if the canonical value already
exists).

---

### INFRA-001 — LOW — mutable `:latest` production images · **FIXED**

`${IMAGE_TAG:-latest}` removed from both services. `${IMAGE_TAG:?...}` and
`${GHCR_OWNER:?...}` make an unpinned deploy a **hard compose error**. API and worker share
one `IMAGE_TAG`, so they cannot skew.

New read-only `verify-release-identity.mjs` reports and enforces:

```text
SourceRevision · SourceRevisionOrigin · ImageTagImmutable · ImageTagKind
ApiImageRevision · WorkerImageRevision · WebBuildRevision · OneReleaseCandidate
```

It rejects floating tags (`latest`, `main`, `edge`, `stable`, …), requires a commit SHA /
`sha256:` digest / semver tag, compares `org.opencontainers.image.revision` across both
images, and compares both against the intended source revision. It mutates nothing, pulls
nothing and contacts no production host. Verified failing-closed on this host.

---

## 3. Verified closures (no work required)

| ID | Proven correct |
|---|---|
| DB-011 | No reachable writer targets any object removed by the contract migrations |
| WEB-001 | CSP-nonce vs static-render hazard is closed |

---

## 4. UNKNOWN items

| ID | Status |
|---|---|
| **UNK-002** | **RESOLVED (mechanism).** `verify-release-identity.mjs` now determines source-to-image correspondence on any host with the images present. Local Web build revision resolves from `apps/web/.next/BUILD_ID`. |
| UNK-001 | Open. `DB-010` (release-artifact guard conservation, §9.2) not started. |
| UNK-003 | Open. Read-only production commands not authored. |
| UNK-004 | Open. `ARCH-002` (§6.2) not started; the contract migration that would refuse on a non-zero NULL count does not exist yet. |

---

## 5. NOT DONE — explicit

These are the ten actionable findings I did not fix. None is blocked; all are simply
outstanding work, and none should be read as closed.

| Finding | Batch | Status |
|---|---|---|
| **ARCH-005** — automation engine unreachable | B | **NOT STARTED.** The largest single item: a durable event/run authority, worker claim with lease/fence, webhook + email executors, new forward-only migrations for uniqueness/lease/fence/terminal fields, runtime registration, and a reconciler. Rules and webhook destinations remain configurable and inert. *(Its three modules' status-blind target reads WERE fixed under AUTH-004, so wiring it up will not reintroduce that defect.)* |
| ARCH-002 — workspace kind not DB-enforced | C | NOT STARTED. Requires Expand/backfill + code cutover + a deferred Contract migration with a readiness guard. |
| ARCH-001 / LEGACY-001 — TEAM vocabulary collision | C | NOT STARTED. |
| ARCH-003 — `organizations` field carries Workspace ids | C | NOT STARTED. |
| ARCH-004 — Organization membership has no lifecycle | D | NOT STARTED. Requires a forward-only Expand/backfill migration and updates across org access, provisioning, invitations, SSO, SCIM, managed identity, context restoration and break-glass. |
| DB-010 — release-artifact guard conservation | F | NOT STARTED. The machine-readable guard/drop manifest does not exist. |
| AWS Secrets Manager readiness | F | NOT STARTED (owner action recorded in §6; no code change made). |
| LEGACY-003 — 14 dead modules | G | PARTIAL. `authorization-allowlist.ts` resolved (repurposed as validated data under one authority). The other 13 have no disposition table. `require-enterprise-feature.ts` is still a dead duplicate. |
| §12.2 runtime probes | Verify | NOT EXECUTED. No disposable Postgres/Redis in this session. |
| §12.3 migration rehearsal | Verify | NOT EXECUTED (and vacuous — no new migrations were authored). |

---

## 6. Owner-only external actions

1. **AWS Secrets Manager** — grant least-privilege `secretsmanager:GetSecretValue` on
   `proovra/prod/app-secrets` to the API and worker task roles. Move/persist the **existing**
   `EMAIL_IDEMPOTENCY_SECRET` value without rotating it: rotating it changes in-flight email
   idempotency identity and can cause duplicate sends. Verify API/worker parity afterwards.
   *No code change was made for this; I did not read, move or print any secret.*
2. **Release identity** — set `IMAGE_TAG` to a commit SHA or digest in the production
   environment and run `pnpm --filter proovra-api verify:release-identity` on the deploy
   host. The compose file will now refuse to start without it.

---

## 7. Constraints honoured

```text
ExistingMigrationsModified   0   (no migration file touched; none authored)
TestsDeleted                 0
TestsSkipped                 0
TestsAdded                   0   (no new test family; no broad suite added)
skip/todo/only added         0
retries or timeout widening  0
assertions weakened          0
```

Nothing was committed, pushed, deployed, applied to Production, or rotated. The dirty
worktree and all pre-existing user changes are preserved.

**Test files touched — 12, each an INTENTIONAL_CONTRACT_CHANGE or a STALE_TEST, every one
documented in place with old contract, new contract, and why the production architecture
requires it.** No coverage was removed. Three deserve specific note because they are the
only places a reviewer should look hard:

- `phase-rw-rbac-hardening.test.ts` — Part 5 rewritten (it asserted the *deleted*
  `resolveInternalTeam` / `requireCap`) and Part 6 superseded (it pinned "the read-only
  listing is intentionally NOT gated", which the audit showed to **be** the defect). The
  replacement is strictly stronger: it asserts the deletion, the canonical chain, the tier
  floors, the removed platform-admin bypass, the new explicit read capabilities, that no
  workspace data is read before authorization, and that `rawToken` is gone.
- `phase-9-commercial-invariants.test.ts` — a hard-coded `slice(at, at + 1600)` window
  stopped covering the statement it checked once COMM-001's comment was added. Widened to
  3200. This **strengthens** the three `not.toMatch` assertions, which now apply to the
  whole function.
- `phase-12-evidence-operations-residue-matrix.test.ts` — the `H.reviewerCapable` boolean
  is now expressed as the **VIEWER role**, which genuinely lacks `evidence_request.review`
  in the canonical matrix. The "non-reviewer still sees the signals but cannot act" case is
  therefore now driven by real role policy instead of a standalone flag.

Two production changes were made specifically so that existing assertions would hold
**unchanged** rather than be edited — audit emission was moved back into the policy engine
via `evaluateMemberAccessWithSnapshot` (preserving "no duplicate audit row"), and
`resolveDenyHttpStatus` takes an options object so the `options.antiEnumeration` source
shape survives.

---

## 8. Metrics — measured, with honest gaps

Measured by the new static verifier and by grep over the corrected source:

```text
StatusBlindMembershipHelpers      0
StatusBlindMembershipRoutes       0
InlineMembershipPolicyAuthorities 0   (external-portal, intelligence, me-inbox,
                                       reviewer-ops, case-permission all migrated)
CrossTenantExternalPortalPaths    0
CallerSuppliedInvitationTokens    0
StaleContextAsAuthorization       0
ClientCommercialAuthorities       0   (pricing surface)
RevokedMembersCountedAsSeats      0
SeatLimitAuthorities              1
DisconnectedMobileSurfaces        0
MutableLatestProductionImages     0
```

Still non-zero — the reason no completion title is claimed:

```text
AutomationAdvertisedButUnreachable  non-zero  (ARCH-005 not started)
AutomationOrphanServices            3         (ARCH-005 not started)
WorkspaceKindPlanFallbacks          non-zero  (ARCH-002 not started)
TeamWorkspaceAuthorities            0, but TeamWorkspaceUserFacingTerms non-zero
                                              (ARCH-001 / LEGACY-001 not started)
WorkspaceIdsInOrganizationFields    non-zero  (ARCH-003 not started)
DeadProductionModules               13        (LEGACY-003 partial)
```

`CriticalReachableDefects = 0` and `HighReachableDefects` is reduced from 4 to 1
(ARCH-005), as a **source and static-graph** claim. It is not a runtime claim: the §12.2
probe matrix was not executed, so "refuses at runtime" is asserted from the corrected call
graph and the type system, not from an observed 403.
