# PHASE 12 — POINT 7: PRODUCT BEHAVIOR BY COMMERCIAL PLAN — CENSUS

> Step 0 ground truth, recorded once. Later steps execute this census; they do
> not rediscover it. Baseline commit `36b871dc`, worktree carries the
> uncommitted Phases 2–12 work described in the program ledger.

## 1. Commercial catalogs — classification

| Location | Class | Notes |
|---|---|---|
| `packages/shared-billing/src/plan-catalog.ts` → `PLAN_CAPABILITIES` | **CANONICAL server authority** | The only place a plan's limits/features are declared. 5 plans: FREE, PAYG, PRO, TEAM, ENTERPRISE. |
| `packages/shared-billing/src/plan-catalog.ts` → `resolveWorkspaceEffectivePlan` | **CANONICAL pure policy** | Subject-correct effective-plan decision (PERSONAL/OWNED/ORGANIZATION/UNKNOWN). |
| `packages/shared-billing/src/plan-catalog.ts` → `COLLABORATION_TEAM_PLAN_LIMITS` / `getCollaborationTeamPlanLimits` | **projection (adapter)** | Zero-decision projection of `PlanCapabilities`. Marked "Phase 12 target: delete". Its *client* use is a duplicate authority (§4). |
| `services/api/src/services/plan-catalog.service.ts` | re-export shim | 15 lines, delegates to shared-billing. |
| `services/api/src/services/workspace-billing.service.ts` | **input adapter** | Loads persisted rows, delegates the decision. Carries one silent substitution (§3, D4). |
| `services/api/src/services/billing/commercial-context.service.ts` → `resolveCommercialContext` | **CANONICAL composer** | Plan + capabilities + seats + lifecycle/grace + record caps + enterprise contract, per explicit `CommercialSubject`. |
| `services/api/src/services/organization/enterprise-contract.service.ts` | **CANONICAL** | Enterprise contract state (§7.2). |
| `services/api/src/services/platform-context/platform-context.service.ts` | **server projection** | Builds `PlatformContextEnvelope` (planFeatures, capabilities, navigation, contextOptions, operationalEligibility). |
| `services/api/src/services/billing-enforcement.service.ts` | enforcement chokepoint | Record caps, storage, PAYG credit debit. |
| `services/api/src/services/collaboration-team/billing-guards.ts` | enforcement | CollaborationTeam create/member/invite limits. |
| `apps/web/lib/surface/tiers.ts`, `lib/api/billing-summary.ts`, `components/billing/*` | presentation | Labels/checkout selection. |
| `apps/web/.../collaboration-teams/**` | **DUPLICATE client authority** | See §4. |

`PlanType` vocabulary is pinned in three places that must agree: the Prisma
enum, `packages/shared-billing` `PlanType`, and
`platform-context/types.ts` `WORKSPACE_PLANS`.

## 2. Workspace / Organization context resolvers

| Resolver | Role |
|---|---|
| `services/api/src/services/identity/workspace-kind.ts` → `resolveWorkspaceKind` | canonical kind classifier (fail-closed UNKNOWN) |
| `workspace-billing.service.ts` → `getPersonalWorkspaceScope` / `getTeamWorkspaceScope` | persisted-scope loaders |
| `platform-context.service.ts` → `buildPlatformContext` | active-context selection + envelope |
| `platform-context/workspace-bootstrap.service.ts` → `ensurePersonalWorkspace` | personal-space creation |
| `identity/identity-mode.service.ts` → `personalSpaceAllowed` / `assertPersonalSpaceAllowed` | personal-space permission (identity-mode keyed) |
| `identity/enterprise-security-policy.policy.ts` → `evaluatePersonalSpaceAllowed` | personal-space permission (org-policy keyed) — **zero production callers** |
| `routes/platform-context.routes.ts` `POST /switch-workspace` | explicit context establishment |
| web `lib/platform-context/PlatformContextProvider.tsx` + `tenantStorage.ts` | client context cache / restoration |

## 3. Production defects found (Point-7 classification)

| # | Defect | Layer-A trace | Contract clause violated |
|---|---|---|---|
| **D1** | `noPersonalSpace` is persisted, editable (`PUT /v1/enterprise/security/policy`) and set by HIGH_SECURITY activation, but **nothing enforces it**. `evaluatePersonalSpaceAllowed` has no production caller; the only enforced rule is `identityMode === STANDARD`. | policy row → `coerceSecurityPolicy` → `evaluatePersonalSpaceAllowed` → *(dead end)* | ENTERPRISE: "`noPersonalSpace = true` prevents Personal Workspace creation, restoration, selection, routing, and server-side fallback." |
| **D2** | `buildPlatformContext` Step 2 silently falls back to the personal Team whenever the selected workspace is missing/stale/non-member **and durably writes `user.currentWorkspaceId = personalTeamId`**, without consulting any personal-space permission. | GET `/v1/platform/context` → `platform-context.service.ts:257-335` | ENTERPRISE: "must not land in a fabricated Personal Workspace when the Organization is unavailable"; global: `SilentPersonalFallbacks = 0`. |
| **D3** | `availableWorkspaces` (legacy envelope section) lists the personal workspace unconditionally, while `contextOptions.personalSpace` is correctly gated by `personalSpaceAllowedFlag`. | `platform-context.service.ts:903-912` | ENTERPRISE: `noPersonalSpace` prevents *selection*. |
| **D4** | `getPersonalWorkspaceScope` substitutes **PRO** for any plan whose `allowsPersonalWorkspace` is false (i.e. TEAM), inventing a plan that no catalog row grants. | `getPersonalWorkspaceScope` → `personalPlan = … : PlanType.PRO` | FREE/PAYG/PRO: "No silent fallback to PRO, TEAM, ENTERPRISE, PAYG, or an owner's plan." |
| **D5** | Owned-Workspace creation counts **every** `Team` owned by the user — including the Personal Team and provisioned Organization workspaces — against `maxOwnedTeams`. A PRO account (`maxOwnedTeams = 2`) can create only **one** Owned Workspace. | `POST /v1/teams` → `assertUserCanCreateAnotherTeam` → `prisma.team.count({ where: { ownerUserId } })` | PRO: "The user can create Owned Workspaces only within the canonical limit." |
| **D6** | Client-side limit authority + account-plan fallback: `MembersTab`, `InvitesTab`, `collaboration-teams/page.tsx` call `getCollaborationTeamPlanLimits(account.accountPlan)` and gate the invite affordance on the result. The account plan is not the workspace's commercial subject. | `useAccount().accountPlan` → `getCollaborationTeamPlanLimits` → `disabled` | `ClientLimitAuthorities = 0`, `OwnerPlanFallbacks = 0`. |

## 4. Client-side authorities (Step-5 targets)

| File | Authority reconstructed | Disposition |
|---|---|---|
| `app/(app)/collaboration-teams/[teamId]/_tabs/MembersTab.tsx` | `maxMembersPerTeam`, `atCapacity` from `accountPlan` | migrate to server projection |
| `app/(app)/collaboration-teams/[teamId]/_tabs/InvitesTab.tsx` | `useResolvedCollaborationTeamPlanLimits`, `useResolvedActivePlanTier` (3-level `?? accountPlan` fallback) | migrate to server projection |
| `app/(app)/collaboration-teams/page.tsx` | `planForCapacity` → `maxTeams` | migrate to server projection |
| `components/billing/*`, `lib/surface/*`, `lib/settings/settingsUiContext.ts` | plan **labels** and checkout target selection | presentation — retained |

## 5. Browser entry points in scope

`/login`, `/home`, `/capture`, `/evidence`, `/evidence/[id]`, `/cases`,
`/cases/[id]`, `/verify/[id]`, `/reports`, `/collaboration-teams`,
`/collaboration-teams/[teamId]`, `/intake-links`, `/search`, `/teams`,
`/teams/[id]`, `/organizations`, `/organizations/[id]/admin/*`, `/billing`,
`/settings/*`, `/org-invites/[token]/accept`, workspace switcher
(`AppAccountToolbar`).

## 6. Existing infrastructure to reuse (never rebuild)

* `services/api/test/integration-harness.ts` — real Fastify + disposable
  PostgreSQL 16 via `@testcontainers/postgresql`, refuses `DATABASE_URL`.
* `services/api/vitest.integration.config.ts` — one run id per run.
* `services/api/test/point5/family-coverage-manifest.ts` — the anti-cheating
  artifact/gate pattern (suite SHA + run id + binding hash) that Point 7
  mirrors for scenarios.
* `playwright.config.ts` + `e2e/helpers/*` — real-stack browser runner.
* `packages/shared-billing` — the plan catalog. Point 7 adds **no** new catalog.

## 7. Safety boundary for this point

`services/api/.env` and `.env` carry `NODE_ENV=production` and a remote
`rediss://…upstash.io` REDIS_URL; `apps/web/.env.local` points
`NEXT_PUBLIC_API_BASE` at `https://api.proovra.com`. Every Point-7 process is
started with those three variables **explicitly overridden in the process
environment** (dotenv and `@next/env` never override an already-set variable),
and the integration harness independently refuses to read `DATABASE_URL`.
No production database, Redis, or deployment is contacted.
