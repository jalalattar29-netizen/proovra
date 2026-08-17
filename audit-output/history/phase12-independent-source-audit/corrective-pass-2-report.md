# PHASE 12 INDEPENDENT SOURCE AUDIT — PARTIAL, NOT CLOSED

Second corrective implementation pass · 2026-08-06 · repository `D:\digital-witness`
Base revision `a7863bec33f10549d84a839ee7ab353509626a2a` · branch `main` · **nothing committed**

---

## A. Executive verdict

| Question | Answer |
|---|---|
| Verdict | **PARTIAL** |
| Section 1 (correct the invalid claims) | **COMPLETE** — all five items implemented and runtime-proven |
| Sections 2–14 | **NOT COMPLETE** — §2 partially, §3–§14 not started |
| Every locally actionable item closed? | **NO** |
| Production contacted? | **NO.** Isolation canary 12/12; zero production connections, zero attempts |

The completion title is withheld, correctly. `ARCH-005`, `ARCH-001`, `ARCH-002`, `ARCH-003`,
`ARCH-004`, `DB-010`, `LEGACY-001` and `LEGACY-003` are all still open, the Point-7 freshness
gate is still RED, and no migration rehearsal or browser journey was executed. The mandate
forbids the closure title while any one of those holds, and eight of them do.

**What this pass is:** the five proof defects named in §1 are closed, and closing them found
**three new pre-existing defects** — one of them HIGH and user-visible — that no source review
would have found. **What this pass is not:** the tenancy-model programme (§4–§7), the automation
engine (§3), the artifact gate (§8) and the certification run (§11–§14).

---

## B. Ledger conservation

Every number below is derived mechanically by
`audit-output/phase12-independent-source-audit/ledger/generate-ledger.mjs` from `rows.json`.
No scalar in this section is hand-maintained.

```text
rows                       25
actionable total           19
actionable closed          11
actionable open             8
  CRITICAL  total 1  closed 1  open 0
  HIGH      total 4  closed 3  open 1
  MEDIUM    total 8  closed 4  open 4
  LOW       total 6  closed 3  open 3
verified closures           2   (DB-011, WEB-001)
unknown blocked             4   (UNK-001 still blocked; UNK-002/003/004 owner-pending)

conservation: 11 fixed + 8 remaining = 19 actionable; + 2 closures + 4 unknown = 25 rows
```

**The closed/open split is UNCHANGED by this pass, and that is the honest result.** This pass
did not close any of the eight open rows. What it changed is the *quality of the evidence* under
rows that were already marked closed — which is exactly what §1 asked for, and which the
arithmetic correctly declines to reward.

**Still open (8):** ARCH-005, ARCH-001, ARCH-002, ARCH-003, ARCH-004, DB-010, LEGACY-001,
LEGACY-003.

**New findings** are counted separately in `ledger/new-findings.json` so they cannot inflate the
fixed count: NEW-001/002/003 from the previous pass, plus **NEW-004 (HIGH)**, **NEW-005 (MEDIUM)**
and **NEW-006 (MEDIUM)** from this one. All three new ones are fixed.

---

## C. The five invalid claims from the previous report

### C1 — §1.1 SEC-001 was not fully runtime-proven → now proven on both halves

The previous report called SEC-001 "full direct runtime proof" while its own residual-risk note
said "concurrency/rotation probes beyond the 10 executed were not run".

New suite: `services/api/test/phase-12-sec-001-completion.integration.test.ts` — **9/9** against
disposable PostgreSQL 16 + pgvector, disposable Redis, and the local **recording** email
transport. It follows the mandate's rule strictly: **acceptance is taken from the delivered link
in the recording mailbox, after the message is ACKNOWLEDGED — never from the token hash's row.**

Executed: delivered link authenticates the intended grant · revoked grant's delivered token stops
authenticating · rotation supersedes the predecessor instantly and the successor works · the
successor reaches only the intended mailbox · a retry keeps exactly ONE durable delivery intent ·
four concurrent sends produce exactly ONE · one idempotency key, minted once and reused · an
ambiguous provider result becomes neither `DELIVERED` nor `BOUNCED` · no cross-tenant message and
no cross-tenant token · the raw token is absent from the grant row, the delivery row, the
hash-chained audit log, the security-event stream, provider message ids and subjects · a refused
send acknowledges zero messages.

**Probing this found NEW-004 — see §E.** Three of those probes failed before the fix.

Not executed: browser-level acceptance of the delivered link under `next start`. That belongs to
the §12 Point-7 run, which was not re-executed.

### C2 — §1.2 compile-time brand → real runtime authority

The old brand was a `declare const … unique symbol` plus an AST rule banning the literal text
`as AuthorizedWorkspaceContext`. Both are real defences and both are defeated by ordinary
JavaScript: `unknown as`, a wrapper function, a spread, `JSON.parse`, or any `.js` caller.

`services/api/src/middleware/authorize.ts` now carries a **module-private `WeakSet` keyed by
object identity**, plus a `WeakMap` of bindings (actor, workspace, permission, mint time,
membership-generation fingerprint, originating request). `mintAuthorizedWorkspaceContext` is not
exported, so it is unreachable from any other module. Identity is the one property a forger
cannot reproduce: it cannot be spelled, copied, spread, serialised or transported. **No secret is
created, stored on the value, serialised or logged** — the registry holds the objects themselves,
weakly.

Three verification surfaces, chosen by what the consumer is about to do:

| Helper | Proves | For |
|---|---|---|
| `assertMintedContext` | provenance only | reading a field to make a secondary decision |
| `assertMintedAuthorizedWorkspaceContext` | provenance + actor/workspace binding | choosing a tenant |
| `requireLiveAuthorizedWorkspaceContext` | the above + re-proof against the database | tenant reads and side effects |

Proof: `phase-12-authorized-context-runtime-brand.integration.test.ts` — **15/15**. Every forgery
class in the mandate is refused: structurally identical plain object · direct cast · double cast
through `unknown` · object spread of a genuine context · JSON round trip · `Object.create`
prototype impostor · `Proxy` wrapper · context minted for workspace A used for B · context minted
for actor A used for actor B · context minted before a SUSPENSION used after it · context minted
before an access-expiry edit used after it · a forged context carrying a wide capability set
rejected by `contextHasCapability` · a genuine context carries no transportable secret.

The AST rule is retained as defence in depth. Consumer-side verification is wired into the
highest-risk consumers (`external-portal.routes.ts#isAdministrativeTier` / `#isOwnerTier`, which
turn a context field into an owner-tier decision).

### C3 — §1.3 `CurrentWorkspaceIdAuthorizationUses = 0` was an unmeasured zero

The previous verifier stated it "does not yet detect currentWorkspaceId-as-authorization as its
own class" and the report printed `0` anyway. A metric produced by a check that does not measure
the thing is not a zero.

New dedicated gate: `services/api/scripts/verify-current-workspace-authority.mjs` (the mandate's
§14 item 21, which is a separate gate from the authorization gate at item 20). It detects five
forbidden forms — `pointer_scopes_query`, `pointer_fallback_selection`,
`pointer_comparison_authority`, `pointer_passed_as_authority`, `pointer_returned_as_authority` —
across direct reads, aliases, destructures, renamed destructures, element access, helper returns
and arrow-wrapper returns.

**It self-tests before it reports.** Twelve adversarial fixtures, eleven of which must be flagged
and one — the sanctioned candidate pattern — which must not. `selfTestFailures = 0`.

Running it against production source found **eleven authorization-bearing uses** where the
previous pass printed zero. Disposition of all 33 occurrences in 673 modules:

| Site | Verdict |
|---|---|
| `require-delegated-tier.ts` | **REAL DEFECT (NEW-005), FIXED** — a SUSPENDED member holding a live delegated-admin grant passed every delegated-tier route |
| `capture-trust.routes.ts` | **REAL DEFECT (NEW-006), FIXED** — parallel authority; no access expiry, no workspace kind, no Organization lifecycle |
| `reviewer-workspace.routes.ts` | **REAL DEFECT (NEW-006), FIXED** — same class, plus a genuine pointer fallback |
| `identity.routes.ts` | SAFE by call-site contract; now **structurally guarded** (see §L) |
| `admin-identity.routes.ts` | CANDIDATE — pointer → consistency check → `authorizeOrFail`. Gate refined; see below |
| `users.routes.ts` | CLASSIFIED — display projection |
| `auth.routes.ts` | CLASSIFIED — session inventory metadata |
| `platform-context.routes.ts` | CLASSIFIED — audit metadata (previous pointer) |
| `organizations.routes.ts` | CLASSIFIED — pointer hygiene inside org-leave |
| `platform-context.service.ts` | CLASSIFIED — context projection + pointer hygiene |
| `middleware/authorize.ts`, `access/current-workspace-pointer.ts` | CLASSIFIED — the canonical authority and the hygiene module |

Two refinements were needed to make the gate trustworthy rather than merely strict:

* **`pointer ?? null` is normalisation, not fallback selection.** The first draft flagged five
  *sanctioned* candidate patterns, including `admin-identity.routes.ts`, which hands the
  normalised value straight to `authorizeOrFail`. The value is now propagated through
  normalisation and judged where it lands. `explicitTeamId ?? pointer` — the pointer as the
  fallback *source* — is still flagged.
* **The candidate rule.** Once the value is handed to a canonical authorizer, the canonical chain
  decides; an additional consistency comparison that can only *narrow* the outcome does not
  restore the pointer's authority. Flagging the prescribed pattern is how a gate teaches people to
  classify their way around it.

Classification is **per-module with declared allowed forms**, not blanket, so a module classified
for "display" cannot silently start scoping queries by the pointer.

**`currentWorkspaceIdAuthorizationUses = 0` — and this time it is a measured zero.**

### C4 — §1.4 the Todo contradiction

Measured, absolutely, across every project:

```text
AbsoluteTodoTests                  0   (was 2, both in apps/web)
AbsoluteSkippedTests               0
OnlyTests                          0
NewTodoTestsIntroducedByThisPass    0
ExistingTodoTestsDispositioned      2   — IMPLEMENTED AND CLOSED, not reclassified
```

The two todos asserted that `account.organization_admin_bulk_invite` is registered in
`ROUTE_REGISTRY` and mapped to the ADMIN pillar. They carried the instruction "once the entry +
pillar mapping land, remove `{ todo: true }`". **The wiring had landed; the markers were never
removed.** So the repository reported two outstanding todos for completed work, while the page —
which gates on that exact route id via `PageRouteGate` — had no enforced guarantee that the id it
gates on exists. Both are promoted to enforced guards.

The API suite's apparent 1 todo and 10 skips were all inside comments and doc blocks; the
existing no-skip guard confirms zero real ones.

`apps/web`: **1852 pass / 0 fail / 0 skipped / 0 todo.**

### C5 — §1.5 audit transaction semantics, settled

Audit events are now explicitly classified:

* **Class A — state-transition audit** ("this membership was revoked"). Its truth is the
  transaction's truth. It must commit atomically with the change; a rolled-back change must leave
  no row claiming it succeeded. Sharing the caller's transaction is the *correct* semantic here,
  not a workaround for NEW-001.
* **Class B — security attempt / refusal audit** ("this caller was refused"). Independent of any
  business transaction — a refusal usually means none was opened. It must be durable on its own.

**Every caller traced.** Exactly **four** sites hand a transaction to the audit sink, all in
`rbac.service.ts` (role change, suspend, restore, revoke), and all four are Class A. Every Class B
emission — the canonical permission-decision audit — runs on the root client, outside any business
transaction. No nested Prisma transaction is introduced; no required security-attempt event is
lost; no false successful audit event is possible.

Proof: `phase-12-audit-transaction-semantics.integration.test.ts` — **7/7** against real
PostgreSQL: a successful revoke and its audit commit together · a refused revoke
(`last_administrator_protected`, which aborts the real transaction) records no successful-revoke
event · a retry after a refusal leaves no duplicate outcome event · the sink works on the root
client · the sink works inside a caller transaction **and rolls back with it** · a refused
authorization records a durable `permission_denied` security event · no Class-B refusal is
emitted inside a business transaction (asserted structurally against all four call sites).

---

## D. §2 — runtime verification of the ten other claimed fixes

**Partially executed.** Honest status:

| Row | This pass | Disposition |
|---|---|---|
| AUTH-004 | **RUNTIME_VERIFIED** — the verifier gap it carried is closed by the new gate; 11 real uses found and dispositioned | upgraded |
| AUTH-001/002/003/005 | unchanged — still SOURCE_VERIFIED + the shared primitive's runtime proof | **not** individually route-probed |
| COMM-001 | not probed — concurrent seat-limit races not run | unchanged |
| COMM-002, WEB-002 | not probed — require the browser run (§12) | unchanged |
| MOBILE-001 | not probed — requires a device/simulator | unchanged |
| INFRA-001 | not probed — no images built or inspected | unchanged |

The four verification dimensions are kept separate in the ledger
(`sourceVerified` / `runtimeVerified` / `migrationVerified` / `browserVerified`) and are not
conflated. `migrationVerifiedPass = 0` and `browserVerifiedPass = 0` remain true.

---

## E. New findings discovered by this pass

### NEW-004 (HIGH, pre-existing, FIXED and runtime-verified)
**External-reviewer invitation emails were not idempotent.**

`sendInvitationEmail` created a **new** `external_review_invitation_deliveries` row on **every**
call and derived the provider idempotency key from that row's id. The key was therefore fresh
every time, so nothing collapsed:

* a retried send delivered the invitation **twice**;
* four concurrent sends — a double-clicked *Send invites*, a retried bulk batch, two operators at
  once — delivered it **four times**.

Each copy carries a live portal bearer token to an external party.

The code comment at the key-minting site asserted the opposite: *"a retry of THIS attempt reuses
it, while a deliberate resend is a different intent and a different key."* That was the intended
design; nothing implemented the first half, because every call took the create path. **This is
why a source review passed it, and why runtime probing was the only thing that could find it.**

Fix: migration `20271120000000_external_review_delivery_intent_idempotency` adds
`UNIQUE (team_id, grant_id, attempt)` — fully `information_schema`-guarded, preceded by a
deterministic re-numbering of pre-existing duplicates that renames history rather than deleting
it — and `reserveDeliveryIntent` inserts first, adopting the winner's intent on `P2002`. The
constraint is what makes it correct under concurrency; check-then-insert alone still races.
Attempt semantics are unchanged, so repeats collapse while an operator's explicit resend stays a
distinct intent with its own key.

### NEW-005 (MEDIUM, pre-existing, FIXED)
`requireDelegatedTier` resolved the workspace from the pointer alone and then asked
`hasDelegatedTier`, which answers from grant rows and never reads a membership row. Status,
access expiry, workspace kind and Organization lifecycle were all unchecked. SEC-001's shape on a
different surface.

### NEW-006 (MEDIUM, pre-existing, FIXED)
`capture-trust.routes.ts` and `reviewer-workspace.routes.ts` each carried a private
ACTIVE-membership check added by the 2026-07-21 P0 remediation — correct about the defect, but
built as a *second authority*, and both had forgotten the same three things the canonical chain
enforces. Both now delegate.

**A regression was introduced while fixing NEW-006 and caught by a live proof.** The inverse of
`mapTeamRoleToCanonical` is `MEMBER→REVIEWER`, not `CONTRIBUTOR→MEMBER`; the first draft returned
the string `"REVIEWER"` for every ordinary DB `MEMBER`, and a reviewer received 403 where they had
always received 200. Caught by `phase-37-98-reviewer-workflow-lifecycle.integration`, fixed, green.

---

## F. Migrations authored, and their rehearsal status

One migration: `20271120000000_external_review_delivery_intent_idempotency`. EXPAND-only,
`SAFE_TO_APPLY_NOW`, drops nothing, rewrites no history.

Registered in every ledger the repository enforces: the Point-6 curation
(`migration-inventory-p6.curation.json` → inventory regenerated, **223/223 classified,
conservation holds, 0 gate failures**), the deployment plan, and the Phase-32.7.2 permitted-later
allowlist.

Applied and exercised against disposable PostgreSQL 16 + pgvector by the integration harness —
which is how the concurrency probe proves the constraint works. **This is not the §11 rehearsal.**
No empty-database full-chain rehearsal, no production-like history rehearsal, and no A/B/C wave
rehearsal was run.

---

## G–J. Not executed

| Section | Status |
|---|---|
| §3 ARCH-005 automation engine | **NOT STARTED.** Dispatcher, actions and delivery runtime remain unreachable; rules stay configurable and inert |
| §4 ARCH-001 / LEGACY-001 Team-workspace removal | **NOT STARTED** |
| §5 ARCH-002 database-authoritative workspace kind | **NOT STARTED.** Confirmed still present: `normalizeWorkspaceKind` infers `ENTERPRISE plan → ORGANIZATION`, which is the plan-derived inference §5 forbids |
| §6 ARCH-003 versioned platform context | **NOT STARTED** |
| §7 ARCH-004 organization membership lifecycle | **NOT STARTED** |
| §8 DB-010 artifact-level migration safety | **NOT STARTED.** The ten injected failures were not built |
| §9 LEGACY-003 unreachable modules | **NOT STARTED.** 13 modules remain unclassified |
| §10 AWS secrets authority | **NOT STARTED** |
| §11 migration rehearsal | **NOT RUN** |
| §12 production-build browser journeys | **NOT RUN.** Point-7 freshness gate is **RED** |

---

## K. Commands and exact results

| Gate | Result |
|---|---|
| Isolation canary | **12/12** |
| API typecheck | clean |
| API lint | clean |
| API unit suite | **21830 passed / 2 failed** (both explained below) |
| API integration suite | **409 passed / 0 failed / 0 skipped** across 28 files, against disposable PostgreSQL 16 + pgvector, disposable Redis and the recording email transport |
| Web unit/render | **1852 passed / 0 failed / 0 skipped / 0 todo** |
| Worker typecheck | clean |
| Authorization gate | **0 violations**, `brandForgeries 0`, 186 TeamMember reads all classified |
| currentWorkspaceId gate | **`currentWorkspaceIdAuthorizationUses = 0`**, self-test **12/12**, 33 occurrences classified |
| Migration inventory | **223/223 classified, conservation holds, 0 gate failures** |
| Migration safety (Phase O) | **28/28** — the new migration is `CREATE_INDEX_GUARDED` (MEDIUM), not `INDEX_COLUMN_RISK` |

### The two remaining API unit failures, and why neither is papered over

1. **`phase-12-point7-closure-gate`** — *"103 ledger records belong to a different run id."*
   **This is correct and expected.** Point-7 proof freshness is RED because §12 was not
   re-executed. The gate is refusing stale evidence, which is exactly its job. Faking it would be
   the precise failure this whole mandate exists to eliminate.

2. **`phase-12-point8-release-artifact` A0/A3 conservation** — *"the release landed partially: 18
   of 19 additions are in HEAD."* `PROPOSED_ADDITIONS` models "in the worktree but not yet in
   HEAD". The eighteen Point-8 entries have since **landed**; the nineteenth (this pass's
   migration) has not. Removing the entry is worse — the migration then reports as "untracked,
   neither added nor excluded". The correct repair is to rebaseline the addition set against the
   current HEAD, which is a release-ledger decision that belongs with the commit that lands the
   migration. **This pass is under an explicit instruction not to commit**, so it is recorded in
   `release-materialize.mjs` and reported here rather than resolved by relaxing the check.

---

## L. Changed-test audit

| Test | Old assertion | New assertion | Production reason | Coverage |
|---|---|---|---|---|
| `phase-rw-rbac-hardening` — administrative tier | `ctx.workspaceRole === "OWNER"` in first position | `assertMintedContext(ctx).workspaceRole === "OWNER"` | The tier helpers now verify provenance before trusting the field | **Strengthened** — provenance is asserted as well |
| `p0-tenant-isolation-remediation` — reviewer `resolveTeam` | file contains an inline `status: "ACTIVE"` read | delegates to the canonical primitive **and keeps no private `teamMember` authority** | The inline check was a second authority missing expiry, kind and org lifecycle | **Strengthened** — the old form would have passed even with a second weaker gate beside it |
| `p0-tenant-isolation-remediation` — capture-trust | inline `teamMember.findUnique` + `status !== "ACTIVE"` | delegates to the canonical primitive; surface rule expressed against the **proven** kind | same | **Strengthened**, same reason |
| `phase-8-bulk-invite` (web) ×2 | `{ todo: … }` — never executed | executed and enforced | The registry wiring landed; the markers were stale | **Strengthened** — from zero coverage to enforced |
| `phase-12-evidence-operations-residue-matrix` | *(no change to any assertion)* | test **double extended** with `evaluateCurrentWorkspace` | capture-trust now calls it | Unchanged — every knob drives exactly the case it drove before |
| `phase-32-7-2-…-drift` allowlist | 18 permitted later migrations | 19 | A new migration was authored | Unchanged — the check still rejects an arbitrary migration |

No assertion was deleted, no test was skipped, no timeout was raised, no concurrency was reduced,
and no retry was added.

---

## M. Absolute final metrics

Measured values only. **`UNKNOWN` is printed where the value was not measured — never `0`.**

```text
StatusBlindMembershipGates            0      (authorization gate, 673 modules)
RuntimeForgeableAuthorizedContexts    0      (15/15 forgery classes refused at runtime)
CurrentWorkspaceIdAuthorizationUses   0      (measured; self-test 12/12)
AbsoluteTodoTests                     0
NewTodoTests                          0
AbsoluteSkippedTests                  0
NewSkippedTests                       0
OnlyTests                             0
UnhandledRejections                   0
UnexpectedExternalAttempts            0      (outbound ledger)
ProductionConnections                 0      (isolation canary 12/12)

CriticalFindings                      0
HighFindings                          1      ARCH-005
MediumFindings                        4      ARCH-001, ARCH-002, ARCH-003, DB-010
LowFindings                           3      ARCH-004, LEGACY-001, LEGACY-003
LocallyActionableOpen                 8

WorkspaceKindFallbackReads            UNKNOWN — §5 not executed; plan-derived inference confirmed present
WorkspaceKindNullRowsInRehearsal      UNKNOWN — no rehearsal run
TeamWorkspaceRuntimeConcepts          UNKNOWN — §4 not executed
WorkspaceIdsInOrganizationFields      UNKNOWN — §6 not executed
DisconnectedAutomationRuntime         UNKNOWN — §3 not executed; believed non-zero
UnclassifiedUnreachableProductionModules  13 — §9 not executed
DuplicateAuthorities                  UNKNOWN — one NEW instance observed (see below)
LegacyWriters / OrphanQueues / DuplicateProcessors / DisconnectedUIActions  UNKNOWN
MigrationArtifactFailures             1      — Point-8 A0/A3, explained in §K
ProofFreshnessFailures                1      — Point-7 RED, explained in §K
```

**Observed but not yet a ledger row:** an invitation is two rows sharing one id — the
token-bearing `ExternalReviewGrant` and the sidecar `ExternalReviewerRoleAssignment` — and it is
the *sidecar* that `ExternalReviewInvitationDelivery` references. Only `issueInvitation` writes
both. This is a duplicate-authority candidate for §9 and is recorded here rather than left
implicit.

---

## N. External owner-only prerequisites

Unchanged: UNK-002 (deployed image correspondence), UNK-003 (production migration/checksum
reconciliation) and UNK-004 (production `workspace_kind IS NULL` count) all require an
explicitly-supplied read-only production authority. None was supplied and none was inferred.
They are **not** counted as local defects closed.

---

## O. Files changed

**Production source (7)**
`services/api/src/middleware/authorize.ts` · `services/api/src/middleware/require-delegated-tier.ts` ·
`services/api/src/routes/capture-trust.routes.ts` · `services/api/src/routes/reviewer-workspace.routes.ts` ·
`services/api/src/routes/identity.routes.ts` · `services/api/src/routes/external-portal.routes.ts` ·
`services/api/src/services/external-review/portal-invitation-email.service.ts`

**Schema + migration (2)**
`services/api/prisma/schema.prisma` ·
`services/api/prisma/migrations/20271120000000_external_review_delivery_intent_idempotency/migration.sql`

**Gates (2)**
`services/api/scripts/verify-current-workspace-authority.mjs` *(new)* ·
`services/api/scripts/release-materialize.mjs`

**Tests (7)**
new: `phase-12-authorized-context-runtime-brand.integration.test.ts` ·
`phase-12-sec-001-completion.integration.test.ts` ·
`phase-12-audit-transaction-semantics.integration.test.ts` ·
`phase-12b-identity-workspace-rail.test.ts`
changed: `phase-rw-rbac-hardening.test.ts` · `p0-tenant-isolation-remediation.test.ts` ·
`phase-12-evidence-operations-residue-matrix.test.ts` ·
`phase-32-7-2-security-event-mapping-drift.test.ts` · `apps/web/__tests__/phase-8-bulk-invite.test.ts`

**Ledgers/docs (4)**
`migration-inventory-p6.curation.json` · `migration-inventory-p6.json` ·
`migration-deployment-plan.md` · `ledger/rows.json` · `ledger/new-findings.json`

Recovery snapshot of the pre-pass tree: `.p12snapshot/` (tracked patch + untracked archive +
HEAD + status). Nothing was committed, pushed, deployed, or applied to production.

---

## P. What must happen next

In dependency order, because §11 and §12 cannot be meaningfully run before §4–§7 author their
migrations:

1. **§3 ARCH-005** — the automation engine. Largest single item; a durable outbox → rule matching
   → fenced claim → action attempt → terminal projection pipeline with webhook SSRF/HMAC/replay
   defences.
2. **§4–§7** — the tenancy programme (TEAM-as-kind removal, database-authoritative
   `WorkspaceKind` with expand/backfill/readiness/cutover/contract, the versioned platform-context
   envelope, Organization membership lifecycle).
3. **§8 DB-010** — the artifact gate with its ten injected failures. Self-contained; can proceed
   in parallel.
4. **§9 LEGACY-003, §10 AWS secrets** — self-contained; can proceed in parallel.
5. **§11–§12** — rehearsal and the Point-7 browser run, which is what turns the two remaining
   red gates green.
6. **§14** — the 29-step sequential certification, once and at the end.
