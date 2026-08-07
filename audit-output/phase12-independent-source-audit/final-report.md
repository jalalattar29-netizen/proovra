# PROOVRA — Independent Phase 12 Production Source Audit

Source revision `a7863bec33f10549d84a839ee7ab353509626a2a` · branch `main` · clean worktree · read-only

---

## A. Executive verdict

```text
AuditStatus                    COMPLETE (inventory and comparison closed; the system is not defect-free)
TargetArchitectureImplemented  SUBSTANTIALLY — the tenancy, context, and commercial models match the
                               approved contract at their canonical authorities; the gaps are adoption
                               gaps at the edges, not model gaps at the core
ProductionSourceFilesClassified 2187 / 2187   (Unclassified = 0)
CriticalFindings               0
HighFindings                   4
MediumFindings                 7
LowFindings                    6
UnknownBlocked                 4
```

**The headline.** The approved model is genuinely implemented. `Team` is the Workspace, `workspaceKind`
is the explicit tri-state discriminator with exactly one classifier implementation and exactly four
creation writers, `Organization` is a real governance container with SYSTEM/CUSTOMER separation, and the
commercial model resolves **kind → plan** and never the reverse. Owned-workspace creation excludes both
the Personal Space and provisioned Organization workspaces and is serialized with a Postgres advisory
lock. There is no `TEAM_WORKSPACE` category anywhere in schema or code.

**The gap.** The canonical authorization primitive is correct but is reached by only part of the route
surface. 101 of 1,081 routes call `authorizeOrFail`/`requireAuthorize` directly; the rest authorize
through roughly thirty per-file `requireXActor` helpers. Most of those delegate correctly. Some do not,
and where they do not the failure is always the same shape: **membership existence is treated as
membership validity**, so a `SUSPENDED` or `REVOKED` member keeps access. That is the substance of every
HIGH finding in this report.

No cross-tenant read path, no authentication bypass, no secret exposure, and no duplicate-irreversible-
work path was found — hence zero CRITICAL.

---

## B. Approved architecture (the immutable comparison target)

```text
One global account identity
├── Personal Space              (one, non-collaborative, may be suppressed by noPersonalSpace)
├── Owned Workspaces            (user-created, limited by the server-authoritative plan limit)
└── Organization memberships
    └── Enterprise Organization (governance/contract boundary — not a workspace)
        ├── Organization Workspace A
        └── Organization Workspace B

Workspace categories: PERSONAL · OWNED · ORGANIZATION_PROVISIONED     (there is no "Team Workspace")
Plans:                FREE · PAYG · PRO · TEAM · ENTERPRISE           (TEAM is a plan, not a container)
Commercial state:     belongs to the Workspace
Collaboration:        an entitlement, never a workspace kind
```

---

## C. Code-derived actual architecture

Independently reconstructed from schema, migrations, and call graphs — not from documentation.

```text
User (users)                                        ← one row per identity; no path mints a second
 ├── Entitlement(userId, plan)                      ← the PERSONAL_ACCOUNT commercial subject only
 ├── Subscription(userId)
 └── TeamMember(teamId, userId, status, role)       ← workspace membership WITH lifecycle
      └── Team (teams)  ═ THE WORKSPACE
           ├── workspaceKind  PERSONAL | OWNED | ORGANIZATION      (nullable — see ARCH-002)
           ├── isPersonal     boolean                              (legacy co-discriminator)
           ├── billingPlan / billingStatus / includedSeats         (workspace commercial state)
           └── organizationId → Organization  NOT NULL, FK Restrict
                                └── kind SYSTEM | CUSTOMER
                                    status ACTIVE | SUSPENDED | ARCHIVED
                                    └── OrganizationMembership(role)   ← no status column
```

Every `Team` — including a FREE Personal Space — is Organization-backed at the DB level; the
`OrganizationKind` discriminator is what separates the internal 1:1 bootstrap container (`SYSTEM`) from a
real customer governance boundary (`CUSTOMER`). That is a faithful physical encoding of the approved
model, not a deviation from it.

**Canonical authorities located (full chains in `authority-inventory.json`):**

| Decision | Single implementation |
|---|---|
| Workspace kind | `packages/shared/src/workspace-kind.ts:normalizeWorkspaceKind` |
| Request authorization | `middleware/authorize.ts` → `identity/access-policy.service.ts:evaluateAccess` |
| Org-level authorization | `organization/org-access.ts:checkOrgAccess` |
| Plan catalog | `packages/shared-billing/src/plan-catalog.ts:PLAN_CAPABILITIES` |
| Effective plan | `plan-catalog.ts:resolveWorkspaceEffectivePlan` |
| Commercial envelope | `billing/commercial-context.service.ts:resolveCommercialContext` |
| Active context | `platform-context/platform-context.service.ts` |
| Queue naming | `packages/shared/src/queue-integrity/names.ts` |
| Tenant browser storage | `apps/web/lib/platform-context/tenantStorage.ts` |

---

## D. Target-vs-actual differences

| ID | Sev | Difference | Where |
|---|---|---|---|
| AUTH-001 | HIGH | Intelligence routes authorize on membership *existence*; status and org lifecycle skipped | `routes/intelligence.routes.ts:80-114` (8 call sites) |
| AUTH-002 | HIGH | `/v1/me/inbox` enumerates workspaces with no status predicate; membership-loss redaction never fires | `routes/me-inbox.routes.ts:875,943,2559,2620` |
| AUTH-003 | HIGH | Case permission service derives role without reading `status` | `services/cases/case-permission.service.ts:309-320` |
| AUTH-004 | HIGH | Canonical primitive adopted by 101/1081 routes; policy re-implemented per file | `middleware/authorize.ts` vs `routes/` |
| ARCH-001 | MED | Two workspace vocabularies: `WorkspaceKind` (3-state) and `workspaceType` (PERSONAL\|TEAM), 82 sites | `shared/workspace-kind.ts` vs `shared-billing/plan-catalog.ts:1` |
| ARCH-002 | MED | `workspaceKind` nullable; NULL fallback infers kind from plan | `schema.prisma:1116`, `workspace-kind.ts:53` |
| ARCH-003 | MED | Envelope field `organizations` carries **Team** ids; type comment says otherwise | `platform-context.service.ts:715`, `types.ts:801` |
| ARCH-004 | LOW | Org membership has no lifecycle state; revoke = physical delete | `schema.prisma:10001`, `membership-provisioning.service.ts:908` |
| COMM-001 | MED | Seat counts include SUSPENDED/REVOKED members | `billing.service.ts:328`, `worker/workspace-billing.ts:268` |
| COMM-002 | LOW | Pricing page hard-codes `?? 2` / `?? 5` owned-workspace fallbacks | `apps/web/app/pricing/page.tsx:624-625` |
| MOBILE-001 | MED | Mobile Teams tab lists workspaces with no action, no navigation, no create path | `apps/mobile/app/(tabs)/teams.tsx:9-45` |
| MOBILE-002 | LOW | Mobile is Personal-Space-only — parity gap, documented and fail-closed | `apps/mobile/src/personal-space.ts` |
| WEB-002 | LOW | Search recent-queries bypasses `tenantStorageKey` (still teamId-scoped) | `app/(app)/search/page.tsx:708` |
| INFRA-001 | MED | Prod compose defaults both images to `:latest` | `infra/docker/docker-compose.prod.yml:16,93` |
| DB-002 | LOW | Three duplicate migration timestamps | see `database-migration-matrix.json` |
| LEGACY-001 | LOW | `TEAM_WORKSPACE_*` codes / `allowsTeamWorkspace` — naming only, traced to an entitlement | `plan-catalog.ts:111` + 3 sites |
| LEGACY-002 | LOW | Untracked `.p8-release-wave/A_B/schema.prisma` duplicate on disk | untracked, no runtime effect |

Proven-correct where a deviation was plausible: **WEB-001** (CSP nonce vs static render — closed by
`force-dynamic` on the root layout plus CSP on request headers), **DB-001** (zero unguarded destructive
DDL), **QUEUE-001** (complete topology).

---

## E. Backend verdict — PARTIAL_IMPLEMENTATION

- **125** route modules, **125 reachable** (123 in `server.ts`; `evidence.saved-views.routes` registered
  from `evidence.routes.ts:82`; `_governance-error-bound` is a helper imported by four modules).
  **DeadRouteModules = 0.**
- **1,081** registered routes. 94 carry no `requireAuth` in the handler body; **all 94 were opened and
  verified** to be guarded by a hoisted `preHandler` const, `ADMIN_PRE`, `requireApiKey` + scope, a cron
  secret, a SCIM token, a webhook signature, a portal token — or to be intentionally public
  (auth, SSO/SAML callbacks, health, pricing). **Unauthenticated privileged routes = 0.**
- The canonical primitive is genuinely good: bounded reason-code vocabulary, no Prisma leakage,
  503-fail-closed on evaluation error, optional anti-enumeration, a `permission_denied` SecurityEvent on
  every deny, and a support-context path that is server-issued, actor-bound, session-bound, and
  session-liveness-checked on every request.
- Integration APIs derive tenancy from `req.apiCredential.teamId` — server-authoritative, never from the
  request body.
- The defect is adoption, not design (AUTH-001…004).

One cosmetic inconsistency worth noting: `evaluateAuthorize` returns `httpStatus: 400` for
`missing_team_id` (cast `as never`), and `sendDenyResponse` has no 400 branch, so it emits **403**. The
response stays bounded; only the status code differs from the declared intent.

## F. Frontend verdict — PROVEN_MATCH with local exceptions

- 200 pages, 26 layouts, 6 route handlers, 1 middleware. Full inventory in `page-action-matrix.json`.
- The root layout's `dynamic = "force-dynamic"` plus the middleware's request-header CSP closes the
  nonce/prerender hazard; the matcher `/((?!_next|favicon.ico).*)` covers every page.
- Client-side commercial authority was searched for specifically. The historical instances are gone and
  the code says so at the sites where they were removed — `collaboration/page.tsx:1176` records that
  `plan === "PRO" || plan === "TEAM"` "made the browser the [authority]", and `intake-links/page.tsx:469`
  records the same for `workspace.scope === "TEAM"`. The one survivor is the pricing-page fallback
  (COMM-002), which is display-only.
- Browser storage: `tenantStorage.ts` is the canonical tenant-namespaced helper with a generation stamp
  and an `isStale` predicate for in-flight isolation. Of 20 files using raw storage, all are non-tenant
  (consent, i18n, dismissal flags, token removal) except search recents, which is workspace-scoped by its
  own convention (WEB-002). **Unscoped tenant-sensitive caches = 0.**

## G. Mobile verdict — PARTIAL_IMPLEMENTATION

53 files. Auth token in `expo-secure-store` (not AsyncStorage) — correct. `apps/mobile/src/api.ts`
contains no tenant parameter at all: the app is a Personal-Space-only citizen-capture client by design,
and `personal-space.ts` fails closed rather than relocating a `noPersonalSpace` identity. The Teams tab
(MOBILE-001) is a dead surface that advertises a capability the app does not implement.

## H. Database / migrations verdict — PROVEN_MATCH with two schema-level gaps

- 13,085-line schema, ~330 models, 222 migrations, `provider = postgresql`.
- **Zero** unguarded `DROP TABLE`, **zero** unguarded `RENAME`, 3 `SET NOT NULL` outside DO-block guards
  (all deliberate staged cutovers preceded by their backfills). All eleven migrations that initially
  looked destructive carry those tokens only inside rollback comments.
- The `workspace_kind` discriminator migration backfills deterministically and adds DO-block integrity
  guards that fail the migration rather than ship bad data — but never issues `SET NOT NULL` (ARCH-002).
- Schema-level gaps versus the approved invariants: workspace kind is not DB-enforced, and
  `OrganizationMembership` has no lifecycle column (ARCH-004).
- Runtime protection exists independently: `runtime/schema-validation.ts` refuses to boot on critical
  schema drift, and `runtime/migration-drift.ts` is wired into readiness.

## I. Worker / queue verdict — PROVEN_MATCH

Discovered independently from runtime wiring, then compared with the registry as required:
17 `Queue` objects, 15 `Worker` registrations, 2 DLQ sinks documented as processor-free by design so a
dead-letter queue is not turned into a retry loop. The registry declares exactly 17 `QUEUE_NAMES`.
**ProducerWithoutProcessor = 0. ProcessorWithoutProducer = 0.** API-side producers build their queues
from the same shared name constants, so producer/processor name drift is structurally impossible rather
than merely absent.

## J. Security / privacy verdict — PROVEN_MATCH at the boundaries audited

Tenant isolation holds at the canonical authority; the residual risk is the status-blind subset
(AUTH-001…003), which is a **lifecycle** failure, not a cross-tenant one — every affected path still
requires a real membership row for the workspace in question. Anti-enumeration is implemented as a
first-class option and used. Denials are bounded reason codes; no route was found returning a raw driver
error or a bare UUID. Support and break-glass access run through one authority chain with server-issued
tokens. No secret values were read or printed during this audit.

## K. Legacy / dead / duplicate / disconnected verdict

```text
DeadRouteModules            0
DeadWebPages                0        (200 pages, all reachable from the app router)
OrphanQueueUnits            0
JS/JSX twins shadowing TS   0
TeamWorkspaceConcepts       0        (as a real category — LEGACY-001 is naming only)
Workspace-persona residue   comment-level only, in 4 files; the feature is physically gone
Duplicate route families    trust vs trust-center — distinct public surfaces, not duplicates
DisconnectedUiActions       1        (MOBILE-001)
DuplicateAuthorities        3        (ARCH-001 workspaceType, ARCH-003 organizations field, WEB-002 storage key)
```

## L. Remediation order (recommended only — not implemented in this phase)

1. **AUTH-002** — add `status: "ACTIVE"` to the four `me-inbox` membership reads. Smallest change,
   largest exposure reduction; the redaction path at :2620 exists precisely for this and is currently inert.
2. **AUTH-001** — route `intelligence.routes.ts`'s two helpers through `authorizeOrFail`. The correct
   sibling implementation is `collaboration.routes.ts:71-96`.
3. **AUTH-003** — add the `teamMemberStatusGrantsAccess` downgrade already used by
   `destructive-action-gate.service.ts:99-108`.
4. **COMM-001** — add the ACTIVE predicate to the two seat counts.
5. **AUTH-004** — convert the remaining per-file `requireXActor` helpers into thin wrappers over the
   canonical primitive, so a status-blind gate becomes structurally unwritable rather than reviewer-caught.
6. **ARCH-002** — `SET NOT NULL` on `teams.workspace_kind` after confirming the NULL count is zero
   (UNK-004), then delete the plan-inference branch from `normalizeWorkspaceKind`.
7. **INFRA-001** — pin `IMAGE_TAG` to an immutable digest or release tag.
8. **ARCH-003 / ARCH-001** — rename the envelope's `organizations` field and retire `workspaceType` in
   favour of the canonical kind.
9. **MOBILE-001** — connect or remove the Teams tab.
10. Low-severity items (COMM-002, WEB-002, DB-002, ARCH-004, LEGACY-001/002) as maintenance.

## M. Explicit exclusions

No test file was read, executed, created, modified, skipped, or used as correctness evidence. 1,397
files were excluded on that basis (`test/`, `tests/`, `__tests__/`, `*.test.*`, `*.spec.*`, `e2e/`,
fixtures, mocks, snapshots, docs) and inventoried only to confirm exclusion. No comment, filename, enum
name, UI label, or document was accepted as proof of behavior. No production file was modified; no
migration was applied; no external system was mutated; no secret was read or printed. The only writes
are the eight artifacts in this directory.

## N. Conservation and closure metrics

```text
ProductionFilesDiscovered        2187
ProductionFilesClassified        2187
ProductionFilesUnclassified         0
ProductionFilesExcluded          1397

ArchitectureMismatches              4     (ARCH-001..004)
WorkspaceKindInferences             1     (the bounded NULL-row plan fallback)
TeamWorkspaceConcepts               0
DuplicateAuthorities                3
LegacyWriters                       0     (all 4 Team creation writers are canonical)
StatusBlindMembershipChecks        54     candidates; 3 confirmed as primary access gates
CrossTenantPaths                    0
ClientCommercialAuthorities         1     (COMM-002, display-only)
SilentFallbacks                     0
DeadRoutes                          0
OrphanServices                      0
OrphanQueueUnits                    0
DisconnectedUiActions               1
UnscopedCaches                      0
UnboundedErrors                     0
MissingAuditEvents                  0     (in the authorization path; every deny emits permission_denied)
UnknownFindings                     4
```

**Audit complete ≠ system correct.** The inventory and the target-vs-actual comparison are closed. Four
HIGH defects and four explicitly-named unknowns remain open.
