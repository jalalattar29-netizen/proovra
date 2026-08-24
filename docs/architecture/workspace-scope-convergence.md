# Workspace-scope and Operations data convergence

Branch: `fix/workspace-scope-convergence`, cut from `09767811`, integrated onto
`origin/main` at `6e1fbfc7`.

---

## 1. The defect, stated once

`Evidence.team_id` and `Case.team_id` are both **NULLABLE**. Both write paths
now stamp a real workspace id on every new row — `cases.routes.ts:240`
bootstraps the owner's personal workspace rather than writing NULL — and
`scripts/backfill-personal-team-ownership.ts` migrates the legacy rows.

Reads cannot assume the backfill has run. A read written as

```ts
prisma.evidence.count({ where: { teamId: activeWorkspaceId, … } })
```

omits every legacy row, and the omission is invisible: it returns a **smaller
number, not an error**. Operations rendered "workspace clear" over a workspace
whose Home simultaneously reported CRITICAL.

Two independent faults produced that. The first is the scope omission above.
The second is that Operations discovery ran **only as a side effect of opening
Home**, so a workspace nobody visited was never scanned at all — and "zero
conditions" and "never examined" rendered identically.

---

## 2. Ownership model (unchanged by this work)

| Fact | Sole authority |
| --- | --- |
| Physical workspace record | legacy `Team` row |
| Active workspace selection | `evaluateCurrentWorkspace` → `AuthorizedWorkspaceContext` |
| Membership / authorization | `evaluateMemberAccessWithSnapshot` + projected capability envelope |
| Evidence / TSA / OTS truth | `Evidence` + integrity records |
| Case truth | `Case` + case-link records |
| Report / Package truth | canonical report/package records |
| Review truth | `EvidenceReviewWorkflow` |
| Intake / delivery truth | intake + delivery records |
| Search truth | source records + derived index |
| Operational workflow facts | `OperationalIncident`, assignment, ack, suppression, SLA |
| Notification read/archive | `InboxItemState` (per user) |
| Reconciliation freshness | `GovernanceReconciliationRun` only |

Nothing new was created in any row. `CanonicalWorkspaceContext` is a **transient
alias** of `AuthorizedWorkspaceContext`, not a model.

---

## 3. Write conventions, proven before anything was changed

| Model | `team_id` | Evidence | Verdict |
| --- | --- | --- | --- |
| `Evidence` | NULLABLE | capture path stamps; legacy NULL rows remain | mixed ownership — canonical scope |
| `Case` | NULLABLE | `cases.routes.ts:240` | same contract — `workspaceCaseWhere` **consumed** |
| `CaseComment` | **NOT NULL** | schema | strict is correct — **retained** |
| `EvidenceReviewWorkflow` | NULLABLE | `reviewer-workflow.service.ts:243` writes `params.teamId ?? null`; **no owner column** | scoped through its `@unique` `evidence` relation |
| 165 others | NOT NULL | schema | strict is correct — **untouched** |

Only 33 of 199 models with a `teamId` are nullable, and only `Evidence` and
`Case` are tenant populations among them. The convergence is narrow by
construction.

---

## 4. What changed

### Canonical workspace context (§3)

`AuthorizedWorkspaceContext` **extended**, not replaced — a second resolver
would be the second authority the brief forbids. Added `physicalWorkspaceId`,
`membershipId`, `personalOwnerUserId`; `CanonicalWorkspaceContext` is an alias.
`MemberAccessSnapshot` carries `workspaceOwnerUserId`, selected in the query the
authorization chain already runs, so scope and permission come from one read of
one row.

Two deliberate deviations, both to avoid a parallel enum: `lifecycle` stays as
the two facts actually proven (`membershipStatus`, `organizationLifecycle`), and
`workspaceKind` keeps its canonical **three** values (`OWNED` is a real kind).

### Scope authority (§4)

Moved to `packages/shared-runtime/src/workspace-scope.ts`; the API copy is
deleted. It had to move: the Worker cannot import from `services/api`, which is
why its org-health refresh, archive sweep and graph reconcile each wrote their
own predicate. Scope types are **branded**, so `tsc` rejects an Evidence scope
in a Case query — that caught four real model mismatches during the migration.

There is deliberately **no** relation-scope helper. Dependent models spell
`{ evidence: <scope> }` inline; two exported wrappers for it had zero callers,
and an exported rule nobody invokes is the state `workspaceCaseWhere` was in.

### Consumers (§5)

Raw mixed-ownership population reads **112 → 0**; canonical **15 → 117**.
`reports-aggregator` also had summary and list building separate filters; both
now share one.

### Incident scope (§12)

`OperationalIncident.team_id = NULL` meant both "no tenant" and "orphan of a
deleted workspace" (`ON DELETE SET NULL`). Seven tenant reads unioned the
unbound NULL bucket, returning other tenants' orphans. `IncidentScope`
(`WORKSPACE` / `PLATFORM` / `LEGACY_UNSCOPED`) splits them.

The backfill claims **nothing** as PLATFORM. No writer in this codebase records
a deliberate platform incident — the only producer of a NULL team id is
`security-event.service.ts`, whose `input.teamId ?? null` is an account-tier
event. Every existing NULL row becomes `LEGACY_UNSCOPED`: retained in full,
invisible to tenant *and* platform surfaces, available for deliberate
reclassification.

### Durable reconciliation and readiness (§7, §8)

Discovery is a scheduled run under `GovernanceReconciliationRun` — the same
authority Search joined, giving per-`(kind, lock_key)` exclusion via a partial
unique index, a lease, terminal states and append-only history. Home is demoted
to a read consumer that *ensures* freshness without running discovery inline.

`OperationsReadiness` = `NEVER_RUN | RUNNING | READY | PARTIAL | STALE | FAILED
| STALLED`. **Clear** now requires a fresh `READY` run with every required
source succeeded and nothing truncated. Incident-read completeness alone no
longer licenses it — that is the exact substitution that produced the original
false all-clear.

### Source registry and grouping (§9, §11)

22 sources, each with owner, scope authority, discovery, fingerprint,
resolution, reopen behaviour, capability, disposition and per-surface
visibility. Sources that are real but not swept are listed anyway, so none
disappears silently.

Grouping is a **read-side projection**: 34 TSA failures render as one group with
`affectedCount: 34` while all 34 stay individually addressable. This is
presentation grouping, never causal merging —
`evidence-integrity-correlation.ts` still forbids reason/filename/provider/date
as evidence of shared causation, and closing a group is not an operation.

---

## 5. Defects found and fixed on the way

* **`recordIncident` crashed on a null teamId.** The compound unique
  `(teamId, fingerprint)` cannot be queried with a null; an `as never` cast hid
  it from the compiler, so every account-tier security event threw instead of
  recording. It could not have deduplicated either — PostgreSQL treats NULLs as
  distinct, so the constraint never excluded those rows at all.
* **Seven unbound NULL-team incident reads**, five of them found only by the
  authority verifier (causality, operational-graph, org-health,
  workflow-generator, governance-control-plane).
* **`mayAssertAllClear` was a copy of `complete`** — true over a workspace with
  a thousand unresolved conditions. Two integration tests encoded that meaning
  and were inverted.
* **Direct timestamp formatting in new UI**, caught by the shared timestamp
  policy guard before it shipped.
* **An index referencing a column created in the same migration**, caught by the
  migration safety gate; now wrapped in a column-existence guard naming every
  column it touches, because a partial guard proves nothing.

### Still open, deliberately not fixed here

`processOrgHealthRefreshJob` (worker) duplicates `refreshOrgHealthProjection`
(API) and the two compute **different** numbers — the API version status-filters
before counting "pending report", the worker version does not. Both now read the
same *population*; the arithmetic still disagrees. Fixing it means moving the
projection into shared-runtime, which is a separate change with its own
migration-free but behaviour-visible risk.

---

## 6. Gates

| Gate | Result |
| --- | --- |
| `tsc --noEmit` — api, worker, shared-runtime, web | green |
| `pnpm -r lint` | 0 errors (1 pre-existing warning in `SurfaceGate.tsx`) |
| `verify-workspace-scope-authorities.mjs` | CLEAN — 0 violations, 4 reviewed exceptions |
| `verify-operations-authorities.mjs` | CLEAN — 11/11 authority audits |
| `migration-risk-scan.mjs` | both migrations SAFE / WARNING, 0 blocking, 0 destructive |
| API unit | 22,767 tests |
| API integration (live PG 16) | full project |
| Worker | 877 |
| Web render | operations workbench incl. 7 new state cases |

The four reviewed scope exceptions each state why the raw predicate is correct
there, and are matched on **file + enclosing symbol**, so adding a query to an
allowlisted file does not inherit the exception.

Both verifiers read **code with comments stripped**. A docblock explaining a
removed defect must not fail the check that documents it — the first run of the
operations verifier flagged two modules whose only offence was explaining the
defect they had fixed, and the same fragility broke a `take: 200` distance
assertion in `phase-32-8-c-workflow-causality`.

---

## 7. Deployment ordering

Two expand-only migrations, both idempotent, both safe to apply before the code:

1. `20271220000000_workspace_operations_reconciliation_kind` — adds the
   `WORKSPACE_OPERATIONS` enum value. **Must land in its own transaction**:
   PostgreSQL will not let a value added by `ALTER TYPE … ADD VALUE` be used in
   the transaction that adds it. Deploying code first produces
   `invalid input value for enum` on every sweep tick — the failure mode that
   killed Search's reconciler at its first workspace, every tick, silently.
2. `20271221000000_operational_incident_scope` — adds `IncidentScope`, the
   `scope` column (default `WORKSPACE`), the backfill to `LEGACY_UNSCOPED`, and
   the guarded index.

Rollback for (2) is stated in the migration: drop the index, column and type. No
incident row is destroyed, and re-applying reproduces the identical
classification from `team_id` alone — the backfill is a pure function of data
that is still present. The `ON DELETE SET NULL` foreign key is deliberately left
alone; proving the retention and deletion requirements that would justify
changing it is separate work, and a destructive FK change made on the way past is
how incident history disappears.

Runtime configuration: `OPERATIONS_RECONCILER_ENABLED` (default on),
`OPERATIONS_RECONCILER_INTERVAL_MS` (default 900000),
`OPERATIONS_RECONCILER_STARTUP_DELAY_MS` (default 45000, plus per-process
jitter). Safe in multiple replicas — losers record contention and do nothing,
which is why there is no leader election.
