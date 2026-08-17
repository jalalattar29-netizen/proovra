# PROOVRA — Phase 12 Focused Reachability Closure Audit

Source revision `a7863bec33f10549d84a839ee7ab353509626a2a` · branch `main` · clean worktree · read-only
Supersedes the prior `PARTIAL_BASELINE` pass. Corrections to it are itemised in §16 and in `findings.json`.

---

```text
FocusedAuditStatus            COMPLETE — reachable graph closed
TargetArchitectureVerdict     IMPLEMENTED AT THE AUTHORITIES, BREACHED AT ONE EDGE
ReachableNodesMapped          1658 production files + 1081 API routes + 15 worker units
                              + 242 web entrypoints + 1346 web actions + 18 mobile screens
                              + 43 mobile actions + 1093 reachable DB write sites
                              + 25 decision authorities
UnclassifiedReachableNodes    0
Critical                      1
High                          5
Medium                        8
Low                           6
UnknownBlocked                4
```

**The one sentence that matters.** A user who has been suspended or removed from a workspace, and whose
last selected context was that workspace, can still read its external-reviewer invitations and trigger an
outbound invitation email on its behalf — because `resolveInternalTeam` in
[external-portal.routes.ts:187](services/api/src/routes/external-portal.routes.ts:187) authorizes off the
`User.currentWorkspaceId` navigation pointer without re-checking membership, and four of its twelve
callers add no capability check either. This is a **named, already-remediated bug class in this codebase**
— [capture-trust.routes.ts:531](services/api/src/routes/capture-trust.routes.ts:531) carries the P0 fix
and its explanatory comment — with exactly one consumer left un-remediated.

**Second.** The entire automation execution engine is unreachable from every runtime entrypoint. Rules and
webhook destinations can be created, enabled and displayed; nothing can ever fire.

---

## 1. Approved target architecture

```text
One global account identity
├── Personal Space
├── Owned Workspaces
└── Organization memberships
    └── Enterprise Organization
        ├── Organization-provisioned Workspace A
        └── Organization-provisioned Workspace B

Categories: PERSONAL · OWNED · ORGANIZATION_PROVISIONED       (no "Team Workspace")
TEAM      = plan/capability bundle operating inside an Owned Workspace
```

## 2. Code-derived actual architecture

```text
User (users)                              one row per identity; no path mints a second
 ├── Entitlement(userId, plan)            the PERSONAL_ACCOUNT commercial subject only
 └── TeamMember(teamId,userId,status,role)  written from exactly 2 files
      └── Team (teams)  ═ THE WORKSPACE     created from exactly 4 sites
           ├── workspaceKind PERSONAL|OWNED|ORGANIZATION   (nullable — ARCH-002)
           ├── isPersonal    boolean                        (legacy co-discriminator)
           ├── billingPlan / billingStatus / includedSeats  (commercial state on the workspace)
           └── organizationId → Organization  NOT NULL, FK Restrict
                                └── kind SYSTEM | CUSTOMER
                                    status ACTIVE | SUSPENDED | ARCHIVED
                                    └── OrganizationMembership(role)   no status column
```

Every `Team`, including a FREE Personal Space, is Organization-backed at the DB level; `OrganizationKind`
separates the internal 1:1 bootstrap container (`SYSTEM`) from a customer governance boundary
(`CUSTOMER`). That is a faithful physical encoding of the approved model.

## 3. Exact target/actual mismatches

| ID | Sev | Mismatch | Where |
|---|---|---|---|
| SEC-001 | **CRITICAL** | Stale-pointer tenancy with no membership requirement; cross-tenant read + outbound email | [external-portal.routes.ts:187](services/api/src/routes/external-portal.routes.ts:187), routes at :341 :430 :637 :1033 |
| ARCH-005 | HIGH | Automation execution engine unreachable — 14 routes + 1 page configure an inert capability | `services/api/src/services/automation/{dispatcher,actions,delivery-runtime}` |
| AUTH-001 | HIGH | Intelligence routes: membership existence = validity | [intelligence.routes.ts:80,101](services/api/src/routes/intelligence.routes.ts:80) |
| AUTH-002 | HIGH | `/v1/me/inbox` status-blind enumeration; loss-redaction inert | [me-inbox.routes.ts:875](services/api/src/routes/me-inbox.routes.ts:875) :943 :2559 :2620 |
| AUTH-003 | HIGH | Case permission service resolves role without status | [case-permission.service.ts:309](services/api/src/services/cases/case-permission.service.ts:309) |
| AUTH-004 | HIGH | Policy re-implemented per file; the ledger meant to prevent it is stale **and unreachable** | `middleware/authorize.ts` vs ~30 helpers; `identity/authorization-allowlist.ts` |
| AUTH-005 | MED | 28 routes use raw inline membership checks; 4 reviewer-ops sites status-blind | reviewer-ops.routes.ts :647 :885 :2338 :2438 |
| COMM-001 | MED | Seat counts include SUSPENDED/REVOKED | billing.service.ts:328 · worker/workspace-billing.ts:268 |
| ARCH-001 | MED | `workspaceType` (PERSONAL\|TEAM) parallel vocabulary, 82 sites | shared-billing/plan-catalog.ts:1 |
| ARCH-002 | MED | Kind not DB-enforced; NULL branch infers kind from plan | schema.prisma · shared/workspace-kind.ts:53 |
| ARCH-003 | MED | Envelope field `organizations` carries Team ids | platform-context.service.ts:715 |
| DB-010 | MED | Contract migrations correct; **artifact-assembly** is the residual risk | see §13 |
| INFRA-001 | MED | Prod compose defaults both images to `:latest` | docker-compose.prod.yml:16,93 |
| MOBILE-001 | MED | Teams tab lists workspaces, offers no action | apps/mobile/app/(tabs)/teams.tsx |
| LEGACY-003 | LOW | 11 further unreachable production modules | see `reachable-graph.json` |
| LEGACY-001 / COMM-002 / WEB-002 / ARCH-004 / WEB-001 | LOW | terminology · pricing fallback · storage-key convention · org-membership asymmetry · (CSP proven closed) | — |

## 4. Identity / Workspace / Organization verdict — PROVEN_MATCH at the authorities

One global identity: `User` is written from 15 files but no path mints a second identity for an
Organization membership. Workspace creation has exactly four writers, all setting `workspaceKind`
explicitly. `TeamMember` is written from **only two** files, `OrganizationMembership` from **one**,
`CaseEvidenceLink` from **one**, `EvidenceLegalHold` from **one** — the tenancy writers are genuinely
canonical. Owned-workspace creation excludes Personal Space and CUSTOMER-org workspaces and serialises
with `pg_advisory_xact_lock` plus an in-transaction re-count.

**`guestIdentityId`** is an association only; `Evidence` still carries `teamId`. It is never tenant
authority. **TeamWorkspaceAuthorities = 0**: every `TEAM`/`teamId`/`allowsTeamWorkspace` reference was
traced to either legacy physical naming for the canonical Workspace or a commercial entitlement.

## 5. Plans / commercial verdict — PROVEN_MATCH

One catalog (`PLAN_CAPABILITIES`), one effective-plan decision (`resolveWorkspaceEffectivePlan`), one API
envelope (`resolveCommercialContext`, discriminated subject, 409 on declared-kind mismatch). The direction
of inference is **kind → plan**, never plan → kind. PERSONAL resolves from the owner entitlement; OWNED
honours only a live TEAM subscription and fails closed on a legacy ENTERPRISE string; ORGANIZATION
resolves from the CUSTOMER contract; UNKNOWN → FREE. **PAYG is never promoted** to a recurring workspace
plan. ClientCommercialAuthorities = 1 (COMM-002, display-only). Two seat counts are status-blind
(COMM-001).

## 6. Context / session verdict — PARTIAL_IMPLEMENTATION

`User.currentWorkspaceId` is explicitly a *navigation rail*. Five consumers were traced:
`governance.routes.ts:130`, `admin-identity.routes.ts:285`, `identity.routes.ts:213` hand it straight to
`authorizeOrFail`; `capture-trust.routes.ts:513` re-checks ACTIVE membership explicitly; **only
`external-portal.routes.ts:199` does neither** (SEC-001). The rail is cleared by org closure/lifecycle,
workspace closure/lifecycle and SCIM deprovision — but **not** by ordinary membership revocation or
suspension, which is what makes SEC-001 reachable. The platform-context envelope self-heals a stale
pointer on build, and refuses to heal into Personal when `noPersonalSpace` applies — but self-healing is
not an authorization boundary for a caller who never loads the web app.

## 7. Backend verdict — 526 of 1,081 routes reach the canonical primitive

| Gate class | Routes |
|---|---|
| CANONICAL_VIA_HELPER (helper body read and confirmed) | 419 |
| CANONICAL_INLINE | 101 |
| STATUS_AWARE_HELPER | 89 |
| PUBLIC_OR_FILE_LEVEL | 77 |
| PLATFORM_ADMIN | 38 |
| INLINE_MEMBERSHIP_CHECK | 28 |
| **STATUS_BLIND_HELPER** | **17** |
| CRON_SECRET / TOKEN_SCOPED / POLICY_ENGINE / INTERNAL | 29 |
| AUTHENTICATED_ONLY | 283 |

The 283 `AUTHENTICATED_ONLY` are account-scoped or resource-derived: sampled mutating members
(`DELETE /v1/evidence/:id`) resolve tenancy from the persisted row through shared canonical resolvers such
as `resolveEvidenceDestructiveAccess`, which my per-file helper detector cannot see. The 17
`STATUS_BLIND_HELPER` routes decompose into exactly three helpers, all read: `resolveInternalTeam` (12,
SEC-001), `requireReviewerMember` (4) and `requireMember` (1) in intelligence.routes.ts (AUTH-001).

The canonical primitive itself remains correct: status, access expiry, `workspaceKind !== UNKNOWN`,
`Organization.status === ACTIVE` for ORGANIZATION workspaces, bounded reason codes, 503-fail-closed,
anti-enumeration, and a `permission_denied` SecurityEvent on every deny.

## 8. Database writer verdict — PROVEN_MATCH with two orphan writers

1,188 write call sites discovered mechanically; **1,093 reachable**, 95 unreachable. 269 raw-SQL sites,
252 reachable. 256 distinct models written. The tenancy/identity/commercial writers are tightly held
(§4). **DatabaseWriterBypasses = 0** for `TeamMember`, `OrganizationMembership`, `CaseEvidenceLink` and
`EvidenceLegalHold`. Two models have writers that exist but can never execute: `AutomationRun` and
`AutomationWebhookDelivery` (ARCH-005).

## 9. Web verdict — PROVEN_MATCH

242 entrypoints, 723 reachable files, **1,346 interactive actions** (1,278 `onClick`, 68 `onSubmit`), 731
distinct `/v1` endpoints referenced. Four empty-handler candidates were read and all four are legitimate
conditional handlers → **DisconnectedWebActions = 0**. No API route family lacks a web or mobile consumer.
Tenant browser storage is namespaced by `tenantStorage.ts` with a generation stamp and an `isStale`
predicate; the one exception is workspace-scoped anyway (WEB-002). The CSP-nonce/prerender hazard is
provably closed (WEB-001). The historical client-side plan authorities are gone and the code records their
removal at `collaboration/page.tsx:1176` and `intake-links/page.tsx:469`.

## 10. Mobile verdict — PARTIAL_IMPLEMENTATION

18 screens, 45 reachable files, 43 `onPress` handlers, **0 empty**, 24 distinct `/v1` endpoints. Tokens in
`expo-secure-store`, not AsyncStorage. `apps/mobile/src/api.ts` carries no tenant parameter — the app is
Personal-Space-only by design and fails closed rather than relocating a `noPersonalSpace` identity. One
disconnected surface (MOBILE-001).

## 11. Evidence / Case / custody verdict — PROVEN_MATCH

Tenant is the canonical Workspace throughout; `evaluateCrossTeamAttach` refuses `case.teamId !=
evidence.teamId`; storage bucket/key are server-derived. The legacy `evidence.case_id` column has **no
Prisma model and no reachable writer** — `matter-queue.service.ts:127` reads `case_evidence_links` and
documents the removal. Legacy `case_legal_holds` / `legal_holds` likewise have no model and no writer.
Destructive delete runs `resolveEvidenceDestructiveAccess` → lock/retention assertions →
`runDestructiveActionGate`, which downgrades a non-ACTIVE member to role-less
(`destructive-action-gate.service.ts:99`).

## 12. Worker / queue verdict — PROVEN_MATCH

17 `Queue` objects, 15 `Worker` registrations, 2 DLQ sinks processor-free by design, 17 registry
`QUEUE_NAMES`. Runtime wiring was discovered independently *then* compared with the registry.
**OrphanQueueUnits = 0**; producer-without-processor = 0; processor-without-producer = 0. API-side
producers build queues from the same shared constants, so name drift is structurally impossible. The one
non-queue background unit that is unreachable is the automation dispatcher (ARCH-005).

## 13. Schema / migration verdict — PROVEN_MATCH (prior conclusion withdrawn)

**The prior pass's claim that destructive DDL existed "only in comments" was false and is withdrawn.** It
stripped only `--` lines and treated `DROP TABLE IF EXISTS` as guarded, so it never surfaced the
deliberate CONTRACT_DROP class — and dynamic SQL inside `DO $$ … EXECUTE format(...)` was invisible to it
entirely.

Read in full this pass, the contract migrations are **best-in-class**:

- **Persona drop** — `DROP TABLE … CASCADE` is preceded, lexically and therefore in apply order, by a
  dedicated precondition migration that RAISEs if any FK or view depends on the table. The file explains
  why the guard is separate: the drop is already tracked in git, so rewriting it would change its Prisma
  checksum and break `migrate deploy`.
- **`evidence.case_id` removal** — RAISEs unless `case_evidence_links` exists, both FKs are present *and
  `convalidated`*, every non-null legacy pointer has a canonical link, no link crosses a workspace
  boundary, and the legacy pointer's workspace agrees with the link's.
- **Legal-hold legacy removal** — RAISEs unless the canonical table exists with all seven columns and the
  `(source_store, source_row_id)` idempotency key, and unless every legacy row is converted.
- **Point-4 authority contract** — drops five duplicate columns only when no row holds a NOT NULL
  duplicate that disagrees with its canonical twin, and three superseded singular tables only when empty.

**No guard was found positioned after the statement it protects.** The residual risk is not in the SQL: it
is that the persona guard is a *separate* migration and the Point-4 contract carries a banner forbidding
its presence in Release A/B/C. Both are artifact-assembly properties, and the staging directory
(`services/api/.p8-release-wave/`) is untracked — hence UNK-001.

## 14. Security / config verdict — one CRITICAL, otherwise sound

SEC-001 is the only cross-tenant path found. Elsewhere: tenant IDs are never trusted from the request on
the audited mutating routes; integration APIs derive tenancy from `req.apiCredential.teamId`;
anti-enumeration is first-class and used; denials are bounded reason codes with no driver-error leakage;
support and break-glass run through one server-issued, actor-bound, session-bound token chain. Production
startup fails closed on CRITICAL schema drift. `INFRA-001` leaves the deployed revision unpinned.
No secret values were read or printed.

## 15. UI/UX implementation verdict

Interactive controls classified: **CONNECTED_CORRECTLY 1,345 web / 43 mobile · DISCONNECTED 1 (mobile
Teams tab) · DEAD 0 · DUPLICATE 0 · CONNECTED_WRONG_AUTHORITY 0**. Personal/Owned/Organization labelling
flows from the server `contextOptions` projection; no "Team Workspace" terminology reaches the UI. Org
admin tab visibility was moved out of the browser into `org-access.ts` (which records that the browser
version failed *open* while the role loaded).

## 16. Legacy / dead / disconnected verdict — corrected

The prior pass reported `OrphanServices 0` on the strength of file *classification*. That was not a
reachability measurement and the number was wrong. Import-graph closure from runtime entrypoints finds:

```text
ReachableProductionFiles      1658   (API 776 · Web 723 · Worker 111 · Mobile 48)
DEAD_UNREACHABLE                14   (automation trio + 11, all verified by exact-path grep)
SCRIPT_ONLY                     52
BUILD_ONLY                      11
TYPE_ONLY                        5
UNREACHABLE_CANDIDATE→triaged   41 → 14 DEAD, 27 script/build/type
```

## 17. Ordered remediation (recommendations only — nothing was fixed)

1. **SEC-001** — make `resolveInternalTeam` deny on non-ACTIVE or absent membership, mirroring
   `capture-trust.routes.ts:531`; add `requireCap` to the four uncapped routes. Separately, clear
   `User.currentWorkspaceId` in the membership revoke/suspend path so no stale rail survives anywhere.
2. **ARCH-005** — decide: wire the automation dispatcher to a scheduler/queue, or remove the routes and
   the page. Shipping a configurable capability that cannot fire is the worse of the two.
3. **AUTH-002** — add `status: "ACTIVE"` to the four `me-inbox` membership reads.
4. **AUTH-001** — route intelligence.routes.ts's two helpers through `authorizeOrFail`
   (`collaboration.routes.ts:71` is the correct shape).
5. **AUTH-003 / AUTH-005** — apply `teamMemberStatusGrantsAccess` in case-permission.service.ts and the
   four reviewer-ops sites.
6. **COMM-001** — add the ACTIVE predicate to the two seat counts.
7. **AUTH-004** — make the allowlist reachable from production (or delete it and enforce structurally),
   and convert the remaining per-file helpers into thin wrappers so a status-blind gate is unwritable.
8. **UNK-001 / INFRA-001** — assert guard/contract co-presence in the artifact and pin `IMAGE_TAG`.
9. **ARCH-002** — `SET NOT NULL` on `teams.workspace_kind` once UNK-004 is answered, then delete the
   plan-inference branch.
10. ARCH-001, ARCH-003, MOBILE-001, LEGACY-003, then the LOW set.

---

## Measured metrics

```text
ArchitectureMismatches            5      (ARCH-001..005)
TeamWorkspaceAuthorities          0
WorkspaceKindInferences           1      (bounded NULL-row plan fallback)
DuplicateAuthorities              4      (ARCH-001, ARCH-003, WEB-002, require-enterprise-feature)
RawInlineDecisions               28
StatusBlindMembershipGates        3 helpers / 17 routes (+ 4 reviewer-ops inline sites)
CrossTenantPaths                  1      (SEC-001)
ClientCommercialAuthorities       1      (display-only)
SilentFallbacks                   0
DatabaseWriterBypasses            0
DisconnectedWebActions            0
DisconnectedMobileActions         1
UnscopedCaches                    0
OrphanQueueUnits                  0
LegacyWriters                     0
DeadReachableRoutes               0
MissingAuditEvents                0      (in the authorization path)
UnboundedErrors                   0
UnknownBlocked                    4

ApiEntrypointsDiscovered/Mapped         1081 / 1081
WorkerUnitsDiscovered/Mapped              15 / 15
WebRoutesDiscovered/Mapped               242 / 242
WebActionsDiscovered/Mapped             1346 / 1346
MobileScreensDiscovered/Mapped            18 / 18
MobileActionsDiscovered/Mapped            43 / 43
DatabaseWritersDiscovered/Mapped        1093 / 1093   (reachable; 95 further sites unreachable)
AuthorityDecisionsDiscovered/Mapped       25 / 25
ReachableProductionFiles                1658
DeadOrBuildOnlyFiles                     109
UnclassifiedReachableNodes                 0
```

## Exclusions

No test file was read, executed, created, modified, or cited. No production file, schema, migration or
configuration was modified. No migration was applied. No external system was mutated. No secret was read
or printed. The only writes are the artifacts in this directory.

**Audit complete ≠ system correct.** The reachable graph is closed; 1 CRITICAL, 5 HIGH, 8 MEDIUM, 6 LOW
findings and 4 named unknowns remain open.
