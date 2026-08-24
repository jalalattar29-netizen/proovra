# Workspace-scope and Operations data convergence

Status: **IN PROGRESS.** Sections 0–6 of the convergence brief are implemented and
gated; sections 7–18 are not started. This document records what was proven, what
changed, and exactly what remains, so the next pass starts from evidence rather
than from a re-reading of the code.

Branch: `fix/workspace-scope-convergence`, cut from `09767811` (= `origin/main`).

---

## 1. The defect, stated once

`Evidence.team_id` and `Case.team_id` are **NULLABLE**. Until Phase
HOME-DATA-OWNERSHIP the write paths used that — personal records were stored with
`team_id = NULL` and "NULL means personal". Both write paths now stamp a real
workspace id on every new row (`cases.routes.ts` bootstraps the owner's personal
workspace rather than writing NULL; the capture path does the same), and
`scripts/backfill-personal-team-ownership.ts` migrates the legacy rows.

Reads cannot assume the backfill has run. A read written as

```ts
prisma.evidence.count({ where: { teamId: activeWorkspaceId, … } })
```

omits every legacy row. The omission is invisible: it returns a **smaller number,
not an error**. That is how Operations rendered "workspace clear" over a
workspace whose Home was simultaneously reporting CRITICAL conditions.

The correction is not "add `OR teamId: null`". An unbound NULL arm returns every
tenant's orphan rows to whoever asks — strictly worse than the omission. The NULL
arm must always be conjoined with the workspace's single owner.

---

## 2. Reuse-first inventory

Classified against the real tree, not from memory.

| Responsibility | Where it lives | Classification |
| --- | --- | --- |
| Active workspace resolver | `middleware/authorize.ts` → `evaluateCurrentWorkspace` / `authorizeCurrentWorkspaceOrFail` | CANONICAL_AND_REUSED |
| Workspace context object | `AuthorizedWorkspaceContext` (runtime-branded, WeakSet-registered) | CANONICAL_AND_REUSED — **extended**, not replaced |
| Physical workspace record | legacy `Team` row | LEGACY_TRANSITIONAL (unchanged by design) |
| Membership / authorization | `services/identity/access-policy.service.ts` → `evaluateMemberAccessWithSnapshot` | CANONICAL_AND_REUSED |
| Capability envelope | `projectEffectiveCapabilities` in `authorize.ts` | CANONICAL_AND_REUSED |
| `workspaceEvidenceWhere` | was `services/api/src/services/workspace-personal-scope.service.ts` | CANONICAL_BUT_BYPASSED → **moved** to `@proovra/shared-runtime` |
| `workspaceCaseWhere` | same module | was **zero-consumer**; now consumed |
| Durable reconciliation / lease / run authority | `packages/shared-runtime/src/reconciliation-run.ts` + `GovernanceReconciliationRun` | CANONICAL_AND_REUSED — **not yet used for Operations** |
| Operations incident generator | `services/dashboard/incident-generator.service.ts` | CANONICAL_BUT_BYPASSED (lazy, Home-triggered — see §7 below) |
| Operations remediation registry | `services/operations/remediation-registry.ts` | CANONICAL_AND_REUSED |
| Operations summary/list/detail | `services/operations/operations-summary.service.ts`, `observability/incident.service.ts` | CANONICAL_AND_REUSED |
| Home operational summary | `services/dashboard/command-center.service.ts` | CANONICAL_BUT_BYPASSED → converged |
| Notifications aggregation | `routes/me-inbox.routes.ts` | CANONICAL_BUT_BYPASSED → converged |
| Search index reconciliation | `packages/shared-runtime/src/search-index-reconciliation.ts` | CANONICAL_AND_REUSED (precedent for the Operations run kind) |
| Report/package aggregation | `services/reports/reports-aggregator.service.ts` | CANONICAL_BUT_BYPASSED → converged |
| Analytics aggregation | `services/analytics/analytics.service.ts` | CANONICAL_BUT_BYPASSED → converged |

### Write conventions, proven before changing anything

| Model | `team_id` | Writer evidence | Verdict |
| --- | --- | --- | --- |
| `Evidence` | NULLABLE | capture path stamps a real id; legacy NULL rows remain | mixed ownership — canonical scope required |
| `Case` | NULLABLE | `cases.routes.ts:240` — `body.teamId ?? ensurePersonalWorkspace(...).teamId` | same contract as Evidence — `workspaceCaseWhere` is correct and is now consumed |
| `CaseComment` | **NOT NULL** | schema | strict `teamId` is correct — **retained**, not changed |
| `EvidenceReviewWorkflow` | NULLABLE | `reviewer-workflow.service.ts:243` writes `teamId: params.teamId ?? null` | mixed ownership, and it has **no owner column** — must be scoped through its `@unique` `evidence` relation, not its own column |
| 165 other models | NOT NULL | schema | strict `teamId` is correct — **untouched** |

Only 33 of 199 models with a `teamId` are nullable, and only `Evidence` and
`Case` are tenant-data populations among them. The convergence is therefore
narrow by construction; it is not a global `teamId` rewrite.

---

## 3. What changed

### Canonical workspace context (§3)

`AuthorizedWorkspaceContext` gained four fields and one alias. It was **not**
replaced — a second resolver would be exactly the second authority the brief
forbids.

* `physicalWorkspaceId` — same value as `workspaceId`, named for what it is, so
  a storage predicate points at the field that would change if the physical home
  ever moved.
* `membershipId` — the proven `TeamMember` row, so a consumer that must record
  which membership authorized an action does not re-read and possibly get a
  different row.
* `personalOwnerUserId` — the owner of a PERSONAL workspace, `null` for every
  other kind. Never an authorization input.
* `CanonicalWorkspaceContext` — an alias for the vocabulary in the brief.

Two deliberate deviations from the brief's literal shape, both to avoid a
parallel enum:

* `lifecycle` is carried as the two facts the chain actually proves —
  `membershipStatus` and `organizationLifecycle` — rather than collapsed into one
  string that would lose which was proven.
* `workspaceKind` keeps its canonical **three** values. `OWNED` is a real kind in
  this schema, not a synonym for either of the other two.

`MemberAccessSnapshot` now carries `workspaceOwnerUserId`, selected in the query
the authorization chain already runs — so the scope and the permission come from
one read of one row and cannot drift between two.

### Scope authority moved to `@proovra/shared-runtime` (§4)

The rule lived in `services/api`. The Worker cannot import from there, so the
Worker's org-health refresh, archive-tier sweep and graph reconciliation each
wrote their own `where: { teamId }` — a background job reading a smaller
population than the page it feeds. It now lives in
`packages/shared-runtime/src/workspace-scope.ts` (same reason the seat-occupancy
and secrets authorities moved there), and the API-local copy is deleted.

Exports:

* `evidenceScopeFor(ctx)` / `caseScopeFor(ctx)` — **pure**, no query, for callers
  holding a proven context.
* `evidenceScopeForMany(ctxs)` — the multi-workspace union, built per workspace
  so each NULL arm keeps its own owner binding. An empty list matches **nothing**
  (`{ id: { in: [] } }`), because Prisma treats `{ OR: [] }` as unconstrained.
* `evidenceRelationScopeFor(ctx)` — for dependent models (review workflows,
  reviewer comments, annotations, parts) whose ownership authority is their
  Evidence row.
* `workspaceEvidenceWhere` / `workspaceCaseWhere` / `workspaceEvidenceWhereMany`
  — LEGACY_TRANSITIONAL resolvers for callers that still hold only a workspace
  id. Thin wrappers over the same projections, not a second rule.

The scope types are **branded** (`WorkspaceEvidenceScope`, `WorkspaceCaseScope`).
The brand is a phantom optional property — never written at runtime, invisible to
Prisma — and it does two jobs: the architecture verifier can recognise a scope
that has travelled across a function boundary, and `tsc` rejects passing an
Evidence scope to a Case query. The second caught four real model mismatches
during this pass.

### Consumers converged (§5)

`services/api`, `services/worker` and `packages/shared-runtime`, verified by AST:

| | before | after |
| --- | ---: | ---: |
| raw mixed-ownership population reads (VIOLATION) | 112 | **22** |
| canonical-scoped | 15 | **97** |

Converged: `command-center.service.ts` (45 sites, via one population resolved per
envelope and threaded through 17 sections), `reports-aggregator.service.ts`
(summary **and** list now share one filter — the divergence is closed as well as
the omission), `analytics.service.ts`, `me-inbox.routes.ts` (TSA/OTS sources),
`refresh-org-health.service.ts`, `subsystem-queue-processors.ts` (worker),
`graph-builder.service.ts`, `org-health`, `queue-telemetry`,
`integrity-snapshot`, `executive-metrics`, `investigation-diagnostics`,
`governance-analytics`, `governance-control-plane`, `retention-sweeper`,
`retention-engine`, `archive-tier` (+ worker sweep), `lifecycle-orchestrator`,
`destruction-review`, `operational-seed`, `siu-export-bundle`, `siu-preflight`,
`workspace-admin`.

`analytics.service.ts` additionally moved its review-workflow count off
`EvidenceReviewWorkflow.team_id` onto the `evidence` relation, per the proof
above.

Every resolver call now passes the caller's own Prisma client, so a scope
resolved inside a transaction reads the same connection as the query it bounds.

### Architecture gate (§6)

`services/api/scripts/verify-workspace-scope-authorities.mjs` — AST, not regex.
It reads each Prisma call's own `where` **tree**, descending through `AND`/`OR`/
`NOT` arms and array literals, and treats shorthand `{ teamId }` and longhand
`{ teamId: x }` identically. (Shorthand is what hid all 45 command-center sites
from the first version of the scan.)

Classifications: `CANONICAL`, `RELATION_SCOPED`, `RECORD_LOOKUP`,
`OWNER_INCLUSIVE` (an `OR` tree with an owner arm already reaches the NULL-team
rows — rewriting it would *narrow* the query), `CROSS_TENANT`, `ALLOWLISTED`,
`VIOLATION`. It independently flags any `teamId: null` not conjoined with an
owner predicate.

The allowlist carries a stated reason per entry and matches on **file + enclosing
symbol**, so adding a new query to an allowlisted file does not inherit the
exception.

```bash
node services/api/scripts/verify-workspace-scope-authorities.mjs
```

---

## 4. What is NOT done

**Sections 7–18 of the brief are not started.** Specifically:

* §7 Durable Operations reconciliation. `GovernanceReconciliationRun` +
  `runGovernanceReconciliation` is the authority to reuse (DB-enforced partial
  unique index on `(kind, lock_key) WHERE status = 'RUNNING'`, a 1-hour lease,
  contention as a truthful no-op, terminal states). `SEARCH_INDEX` is the
  precedent for adding a `WORKSPACE_OPERATIONS` kind. Operations still depends on
  Home calling `generateIncidentsForWorkspace` lazily.
* §8 `OperationsReadiness` freshness contract and the false-clear rules.
* §9 Source-registry totality. `remediation-registry.ts` + the generated
  disposition table (`scripts/operations-disposition-table.mjs`) already cover 15
  category/subtype rows; the brief's list is wider.
* §10 TSA boundary tests (the registry already declares
  `NO_SAFE_REMEDIATION_AUTHORITY` for `tsa_failure`; zero-provider-call tests are
  not written).
* §11 Grouped incident projection.
* §12 `OperationalIncident.teamId = NULL` scope discriminator + migration.
* §13–16 Cross-surface conservation, the 24-context matrix, live-PostgreSQL
  behavioural tests, UI states.
* §17–18 Full gate run and artifact regeneration.

### Remaining scope violations (22)

Left deliberately, each needing a judgement the codemod must not make:

* `teams.routes.ts` ×13 — workspace-admin surfaces. Needs a decision on whether a
  `Team` reached through these routes can be personal.
* `analytics.routes.ts` ×2 — `groupBy({ by: ["teamId"] })` **cannot** attribute a
  NULL-team row to a workspace. The correct fix is the backfill, not a wider
  read; this needs an allowlist entry stating that, plus convergence of the
  sibling `findMany`.
* `ai-search.routes.ts` ×2, `cases.routes.ts` ×1 (`teamId: evidence.teamId`),
  `integrations-api.routes.ts` ×1 (`cred.teamId`),
  `admin-organizations.service.ts` ×2 (org workspaces, likely provably strict),
  `billing-enforcement.service.ts` ×1 (allowlisted — metering, not a tenant read).

### Defects found in passing, not fixed

* **Duplicate org-health authority.** `services/worker/src/subsystem-queue-processors.ts`
  (`processOrgHealthRefreshJob`) recomputes the `OrgHealthProjection` row with its
  own arithmetic instead of calling `refreshOrgHealthProjection`, and the two
  **disagree**: the API version filters `status: { in: ["SIGNED","REPORTED"] }`
  before counting "pending report" (Phase HOME-TRUTH-FIX), the worker version does
  not. Its own comment says "or extract to a shared package". Both now read the
  same *population*; they still compute different *numbers*. Fix: move
  `refreshOrgHealthProjection` into `@proovra/shared-runtime` and have the worker
  call it.

---

## 5. Gate status

| Gate | Result |
| --- | --- |
| `tsc --noEmit` — api, worker, shared-runtime | **green** |
| `shared-runtime` build | **green** |
| API vitest (22,720 tests) | **22,716 pass / 4 fail** |
| Workspace-scope verifier | 22 violations (see above) |

The 4 failures and 3 collection errors are **generated-artifact staleness**
gates — `phase-0-audit-engine-governance`, `phase-12-capability-analyzer-adversarial`,
`phase-12-closure-gate`, `phase-12-coverage-manifest`, `phase-12-wiring-registry`,
`phase-12b-evidence-operations-entry-matrix`. They compare a stored hash against
the current tree and are expected to fail while the tree is still moving. Per the
brief, proof artifacts are **not** regenerated until the product tree is
quiescent; `pnpm audit:architecture` is the regeneration step, and it must run
alone (no concurrent artifact writers).

Test-fixture changes made, all recorded in-place with their reason: three stub
Prisma clients gained the `team.findUnique` the scope resolver reads (defaulting
to a non-personal workspace, so every existing assertion keeps its exact
meaning), and six source-contract assertions that pinned a literal `teamId` were
retargeted at the canonical scope. Two of those are now **stronger** than before
— `phase-37-98` additionally asserts that the module resolves the canonical
authority, so an `AND` arm alone cannot satisfy it.

Nothing is committed. Nothing is pushed. No production data was touched.
