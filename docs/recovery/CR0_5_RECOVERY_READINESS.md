# CR0.5 — Recovery Readiness & State Dependency Closure

**Status:** ACTIVE — this document binds CR1 and R1 execution.
**Predecessor:** `CR0_SYSTEM_FREEZE_BASELINE.md`
**Companion tests:** `services/api/test/phase-cr0-5-recovery-readiness.test.ts`
**Generated:** Phase CR0.5 (after 7 parallel deep-trace dependency audits).

CR0 froze the surface. CR0.5 maps the **wires inside** so CR1 (purge) and R1
(product state recovery) can execute without blind symptom patching.

CR0.5 does not fix the product. It diagnoses + locks the next-phase plan.

The most consequential CR0.5 findings: **two single-line bugs explain most of
the visible user pain.**

---

## 1. State reader/writer map (Part 1)

The canonical state pipeline is:

```
GET /v1/platform/context
  → buildPlatformContext()  [services/api/src/services/platform-context/platform-context.service.ts:93]
  → PlatformContextEnvelope
  → PlatformContextProvider  [apps/web/lib/platform-context/PlatformContextProvider.tsx:204]
  → usePlatformContext()  → every downstream consumer
```

State machine: `IDLE → LOADING_CONTEXT → READY → SWITCHING → READY/FAILED`.
`refresh()` (provider.ts:233) is the ONLY hydration trigger.
`switchWorkspace()` (provider.ts:274) POSTs `/v1/platform/context/switch-workspace`.

### Domain table

| # | State Domain | Canonical Source | Writers | Top Readers | Persistence | Hydration | Failure Fallback | Duplicate Risk | Owning Phase |
|---|---|---|---|---|---|---|---|---|---|
| 1 | activeSpace | `platform-context.service.ts:583-598` | `prisma.user.update({currentWorkspaceId})` at `platform-context.service.ts:228,290`; client trigger `switchWorkspace()` at `PlatformContextProvider.tsx:274` | `useActiveSpace`, `useActiveSpaceId` (`useTenantModel.ts:66,76`); `AppTopbarV2.tsx:113`; `AppSidebarV2.tsx:528`; `settings/persona/page.tsx:93` | DB `User.currentWorkspaceId` + in-memory provider state | Provider mount + after switchWorkspace; NEVER after persona mutate | Synthetic personal-mode `platform-context.service.ts:303-315`; previous envelope on switch failure | LOW — single source | EMERGENCY-RECOVERY / 32.8 |
| 2 | workspace switcher state | `AppTopbarV2.tsx:157` local `workspaceOpen` | `setWorkspaceOpen` lines 250, 339, 410 | Same file | None (ephemeral) | `useState` init | Closed on route change (`useEffect:175`) | LOW | 32.8 |
| 3 | personal workspace | `platform-context.service.ts:533-547` (PersonalSpace shape) | `ensurePersonalWorkspace` (bootstrap); stale-heal at line 228 | `usePersonalSpace` (`useTenantModel.ts:46`); `AppTopbarV2.tsx:190,320` | DB `Team.isPersonal=true` + `User.currentWorkspaceId` | Every `/v1/platform/context` call; idempotent | Synthetic personal mode | LOW; duplicate-personal heuristic at lines 480-524 surfaces drift | EMERGENCY-RECOVERY |
| 4 | organization workspace | `platform-context.service.ts:413-470` | `prisma.teamMember.findMany:423`; mutations via `routes/teams.routes.ts` | `useOrganizations` (`useTenantModel.ts:55`); `AppTopbarV2.tsx:191,400`; `teams/[id]/page.tsx` | DB `Team` + `TeamMember` | Per envelope | Per-section degrade `availableWorkspacesStatus:469` | MEDIUM — legacy `envelope.availableWorkspaces:605` still rebuilt | 32.8 |
| 5 | persona/workflow profile | `persona-profile.service.ts:111` | `PATCH /v1/workspaces/:teamId/persona` at `workspace-persona.routes.ts:96` | `usePersonaProfile` (`usePersonaProfile.ts:37`); `AppShellV2.tsx:60-63`; `AppSidebarV2.tsx:525`; `AppTopbarV2.tsx:270`; `PersonaSetupBanner.tsx:37`; `CommandCenter.tsx:40` | DB `WorkspacePersonaProfile` keyed on `teamId` | Embedded in every `/v1/platform/context`; **NEVER refreshed after PATCH** | `DEFAULT_PROFILE` (`usePersonaProfile.ts:25`) | **HIGH — see §3 Stale Risk #1** | PHASE 38 / R1 |
| 6 | onboarding completion | `personaProfile.onboardingCompleted` (same as #5) | Same PATCH | `PersonaSetupBanner.tsx:79`; `settings/persona/page.tsx:97` | Same DB row | Same as #5 | `false` default | HIGH — banner only re-hides on full envelope refresh / localStorage dismiss (`PersonaSetupBanner.tsx:29`) | R1 |
| 7 | density preference | `personaProfile.operationalDensityPreference` (same as #5) | Same PATCH | `AppShellV2.tsx:60` (writes `data-operational-density`); CSS in `app-shell-v2.css`; capture/help panels | DB column + DOM attribute | Same as #5 | `"comfortable"` | HIGH — wizard literally says **"Reload to see updated navigation and labels"** (`settings/persona/page.tsx:418`) | R1 |
| 8 | route access state | `routeAccessResolver.ts:85` (pure fn) | None | `AppSidebarV2.tsx:545`; `PageRouteGate.tsx` | None | Computed per render | `accessState: RECOVERY_REQUIRED` etc. | LOW | 38.6 |
| 9 | sidebar exposure | `workflowExposureResolver.ts` (pure fn) | None | `AppSidebarV2.tsx:563` | None | Per render | Empty groups | MEDIUM — legacy `envelope.navigation.groups` still populated at `platform-context.service.ts:389`; topbar account menu still reads `envelope.navigation.accountMenu.items:583` | 38.9 |
| 10 | dashboard / CommandCenter | Backend: `command-center.service.ts`; Frontend: `CommandCenter.tsx` (`LoadState:62`) | None | `home/page.tsx` mounts `<CommandCenter/>` | None — local useState | `useEffect` on `workspace.workspaceId` change | `{status:"unavailable"}` | MEDIUM — own LoadState keyed on `workspaceId` only; persona/plan changes leave it stale | 32.8C / R3 |
| 11 | capability/permission | `capability-registry.ts:67` `resolveCapabilities` | Pure derivation in `platform-context.service.ts:358` | `useCan` (`useTenantModel.ts:88`); `PageRouteGate`; sidebar; resolver | None | Per envelope | Empty map fail-closed (`useTenantModel.ts:90`) | LOW | 32.8 |
| 12 | billing/plan gate | `billing-enforcement.service.ts` + `Team.billingPlan` + `Entitlement` | `billing.service.ts`; routes/billing*.ts | `billing-enforcement.service.ts:27,91,104`; envelope overlay at `platform-context.service.ts:323-340,554-561` | DB | Per request (enforcement) + per envelope (display) | 402/409 | MEDIUM — two reads (workspace + Entitlement) merged | 32.8 |
| 13 | governance availability | `governance-control-plane.service.ts` `runGovernanceControlPlane` | governance routes | `GovernanceControlPlane.tsx`; `governance/retention/page.tsx`; `governance/destruction/page.tsx` | DB governance tables | Per page fetch | Capability `GOVERNANCE_VIEW` gates | LOW | various |
| 14 | reviewer/ops availability | `reviewer-operations-engine.service.ts` | reviewer-ops routes | `ReviewerCommandConsole.tsx`; `review/operations/page.tsx` | DB | Per page | `REVIEWER_OPS_VIEW` gate | LOW | 32.7 / 25 |

### Critical findings (state map)

- **Stale Risk #1 (SEVERE)** — Persona save does NOT invalidate the envelope. `settings/persona/page.tsx:130` PATCHes the API. **The handler does not call `usePlatformContext().refresh()`, `router.refresh()`, or `window.location.reload()`.** The success banner literally tells the user to reload (`page.tsx:418`). Every persona-driven surface (sidebar order, density, banner, dashboard band order, terminology, hint copy) shows stale state until manual reload.

- **Three FE files self-fetch `/v1/users/me`** outside the envelope — drift class:
  - `apps/web/app/providers.tsx:79` — `AuthContext.fetchMe()` runs parallel to `envelope.user`
  - `apps/web/app/(app)/settings/page.tsx:269`
  - `apps/web/app/(app)/teams/[id]/page.tsx:463`

- **Legacy/canonical envelope-field drift:**
  - `envelope.workspace` (legacy) vs `envelope.activeSpace` (canonical) — topbar/sidebar/`useTeamWorkspaceGate` still read the legacy one
  - `envelope.availableWorkspaces` (legacy) vs `envelope.organizations` + `personalSpace`
  - `envelope.navigation.groups` (legacy) vs `navigation.sidebar.groups`/`accountMenu.items`
  - `envelope.persona.resolvedPersona` (role-derived) vs `envelope.personaProfile.primaryProfile` (UX persona)

---

## 2. Workspace model ownership map (Part 2) — including the "No workspace selected" bug

### Canonical sources (verified)

- **Active workspace** — server-built `envelope.activeSpace` (`PlatformContextActiveSpace` at `types.ts:229-241`, built at `platform-context.service.ts:583-598`).
- **Personal workspace** — `envelope.personalSpace` (built at `platform-context.service.ts:533-542`).
- **Organization workspace** — `envelope.organizations[]` (only `isPersonal=false`).
- **Persistence** — `User.currentWorkspaceId` (FK to `Team.id`). Not cookie, not localStorage, not URL.
- **Hydration** — on provider mount (`PlatformContextProvider.tsx:323-327`); on `switchWorkspace()` (provider.ts:292-298). Sequence-guarded against out-of-order responses via `fetchSequenceRef`.

### The bug — diagnosis is conclusive

**Reported behavior:** Topbar shows "Personal Space"; dashboard shows "No workspace selected" on the same render.

**Root cause:** `CommandCenter.tsx:70` calls `useTeamWorkspaceGate()`. That hook is a TEAM-only narrowing of the envelope; for personal users it returns `{ status: "no-workspace", reason: "personal" }` (`useTeamWorkspaceGate.ts:127-129`). CommandCenter then maps `workspace.status === "no-workspace"` to its own `LoadState.no_workspace` (`CommandCenter.tsx:78-81`), discarding the `reason` discriminant. The "no_workspace" branch renders `<NoWorkspaceState/>` (`CommandCenter.tsx:4723-4748`) with the literal title **"No workspace selected"**.

Meanwhile the topbar (`AppTopbarV2.tsx:110-116`) reads `envelope.activeSpace` directly — sees `type: "PERSONAL"`, renders "Personal Space / Personal • Owner".

**Both surfaces read the same envelope in the same state.** No race, no stale data, no schema mismatch. CommandCenter just consumes the wrong hook.

The fix (deferred to R1) is one line: replace `useTeamWorkspaceGate()` with `useActiveSpaceId()`. The backend already supports personal-flavored dashboard rendering (`command-center.service.ts` docstring at line 22-23: "Personal-workspace renders the same envelope but team-only sections return `not_applicable`").

### R1 must change

- `apps/web/components/command-center/CommandCenter.tsx:70` — migrate to `useActiveSpaceId()`.
- Delete or repurpose `<NoWorkspaceState/>` (lines 4723-4748) — for personal users with a valid `activeSpace`, this branch should never render.

### R1 must NOT touch

- `useTeamWorkspaceGate.ts` — its `reason: "personal"` contract is correct; other team-only surfaces depend on it.
- `PlatformContextProvider.tsx`, `types.ts`, `useTenantModel.ts` — envelope shape correct.
- `platform-context.service.ts` — envelope construction correct.
- `AppTopbarV2.tsx`, `home/page.tsx` — already canonical.

### R1 acceptance tests

1. Component test: render CommandCenter with `envelope.activeSpace.type === "PERSONAL"` and `personalSpace.id` set → assert "No workspace selected" string is absent.
2. Component test: same with `activeSpace.type === "ORGANIZATION"` → assert dashboard fetches with org id.
3. Source-contract grep: `CommandCenter.tsx` MUST NOT import `useTeamWorkspaceGate`.
4. Topbar/dashboard parity: single envelope rendered through both — when topbar reads PERSONAL, dashboard renders dashboard, not empty state.

### Remaining `useTeamWorkspaceGate()` live call sites (confirmed by grep)

| File | Status |
|---|---|
| `apps/web/components/command-center/CommandCenter.tsx:70` | **THE BUG** — R1 target |
| `apps/web/app/(app)/ops/page.tsx:142` | Legitimate (team-only operator surface; wrapped in `PageRouteGate routeId="platform.ops_center"`) |
| `apps/web/lib/platform-context/useTeamWorkspaceGate.ts:64` | Internal self-reference (`useTeamId` convenience wrapper) — canonical |

The Phase 38.18 allow-list said 4 consumers remained; in fact only 2 production call sites remain. CR1 reaffirms.

---

## 3. Onboarding / persona / workflow persistence map (Part 3)

### Flow trace

1. **Hydration** — `settings/persona/page.tsx:93-94` reads `useActiveSpace()` + `usePersonaProfile()` from the envelope; seeds local `useState` from current persona at lines 97-109 (one-time snapshot — never re-syncs).
2. **Save** — `persistProfile()` at lines 121-150 PATCHes `/v1/workspaces/{teamId}/persona` (line 130-140). On success: `setSaved(true)` and **nothing else** (line 141).
3. **Backend** — `routes/workspace-persona.routes.ts:96-213` upserts `WorkspacePersonaProfile` (line 133-179), writes audit `workspace.persona.updated` (line 182-203), returns `{ profile }` (line 207-211).
4. **Storage** — `schema.prisma:7343-7363` table `workspace_persona_profile`, PK `team_id`.
5. **Provider** — `PlatformContextProvider.tsx:323-327` fetches envelope on mount via `refresh()`. The only triggers for refresh are: initial mount, explicit `refresh()`, or `switchWorkspace()`. **The persona wizard calls none.**
6. **Consumers** — `usePersonaProfile.ts:37-40` returns `envelope?.personaProfile ?? DEFAULT_PROFILE`. Pure envelope reads — they cannot see new persona until envelope itself changes.

### Answers

| # | Q | A |
|---|---|---|
| 1 | API endpoint | `PATCH /v1/workspaces/:teamId/persona` |
| 2 | Storage | `WorkspacePersonaProfile` table, PK `team_id` |
| 3 | Local UI state after save | **No.** Only `setSaved(true)` flips a boolean |
| 4 | Cache invalidation | **None** |
| 5 | App-shell/sidebar/dashboard refresh | **None.** All read envelope.personaProfile which is unchanged in-memory |
| 6 | User stays on screen | Yes — wizard never navigates, never reloads |
| 7 | Empty dashboard | `getPersonaSectionOrder()` returns OLD order because `usePersonaProfile()` returns the stale envelope's persona |
| 8 | Sidebar doesn't adapt | Same root cause |
| 9 | Is "reload to see" acceptable? | **No** — Phase 38 frames persona as live UX. The hint copy at `page.tsx:418` is a confessional bug, not design |
| 10 | R1 fix | See below |

### R1 fix (single file)

In `apps/web/app/(app)/settings/persona/page.tsx`:

1. Import `usePlatformContext` alongside the existing persona helpers.
2. Inside `PersonaWizardPageInner`, grab `const { refresh } = usePlatformContext();`.
3. After successful PATCH (after `setSaved(true)` at line 141), `await refresh()` so the envelope is re-pulled.
4. Remove the "Reload to see updated navigation and labels." copy at line 418.
5. Optional polish: on `overrides?.onboardingCompleted === true`, after refresh `router.push('/home')`.

### R1 acceptance tests

1. Unit (Vitest, JSDOM): mount wizard with mocked provider; click Save → assert `refresh` mock called once after `apiFetch` PATCH.
2. Integration: PATCH endpoint, then GET `/v1/platform/context` → assert `envelope.personaProfile.primaryProfile` reflects PATCH within the same session.
3. Source-contract: `"Reload to see"` (or any "reload to" copy variant) MUST NOT appear under `settings/persona/`.
4. Source-contract: `settings/persona/page.tsx` MUST contain `usePlatformContext` and at least one `refresh(` call.
5. Banner test: rendering `PersonaSetupBanner` with `onboardingCompleted: true` + `source: "team"` returns `null`.
6. Sidebar/dashboard: re-rendering provider with updated envelope re-derives band ordering without route change.

---

## 4. Sidebar / navigation dependency map (Part 4)

### What the sidebar reads (verified)

- `ROUTE_REGISTRY` (`routeRegistry.ts:100-833`)
- `resolveRouteAccess` (`routeAccessResolver.ts:85-179`)
- `resolveWorkflowExposure` (`workflowExposureResolver.ts:80-155`)
- `envelope.activeSpace.type`, `envelope.platform.isPlatformAdmin`, `envelope.capabilities`, `envelope.account.accountPlan`
- `usePersonaProfile()` → `primaryProfile` + `secondaryUseCases`

### Why Personal Space shows org/governance clutter (two-step root cause)

**Step A** — `routeAccessResolver.ts:110-123` explicitly returns `canSeeNav: true` for org-only routes when a personal user is active. Comment at line 115-116: *"Still nav-visible so the user can discover the surface… never silently hidden."*

**Step B** — `workflowExposureResolver.ts:99-131` buckets any `canSeeNav: true` + `sidebarEligible: true` item into a visible bucket, ignoring `access.canLoad`. So every org-only sidebar-eligible route ends up in `primaryItems`/`secondaryItems`/`moreAdvancedItems` for personal users:
`review.queue`, `review.sla`, `review.escalations`, `governance.hub`, `governance.retention`, `governance.policy`, `governance.analytics`, `governance.lifecycle`, `governance.destruction`, `governance.notifications`.

`buildSidebarGroups` (`AppSidebarV2.tsx:281-340`) materializes those as the "Operations" and "Governance & Compliance" groups.

### Why "Access"/"Org" chips appear user-facing

`degradationChip()` in `AppSidebarV2.tsx:408-421` returns:
- `"Org"` for `NEEDS_ORGANIZATION`
- `"Setup"` for `NEEDS_PERSONAL_OR_ORG`
- `"Access"` for `DENIED_NO_CAPABILITY`
- `"Upgrade"` for `NEEDS_UPGRADE`

Rendered as `<span data-sidebar-degradation-chip data-tone="neutral">` at `AppSidebarV2.tsx:384-403`. Phase 38.9 added these as structured affordances. On Personal Space they collectively turn the sidebar into a wall of "you can't use this" stamps.

### Phase ownership

| Change | Phase |
|---|---|
| Drop root-level "Operations" + "Governance & Compliance" groups from Personal Space (gate `buildSidebarGroups` on activeSpaceType) | **R2** |
| Make `degradationChip()` return `null` when `accessState === "NEEDS_ORGANIZATION"` AND activeSpace is PERSONAL (one consolidated "Explore organization features" CTA instead) | **R5** |
| Add `personalScopeOnly` flag to exposure resolver that demotes ORGANIZATION_ONLY routes to `moreAdvancedItems` (or excludes them) when personal | **R5** |
| Add `parentRouteId` / `hubChild: true` to `RouteDefinition`; hub children become `sidebarEligible: false` while staying palette + All Tools visible | **R6** |
| Hub-aware All Tools sub-listing | **R6** |

### CR0 guardrails that MUST remain

1. Workflow profile never gates access — only re-orders.
2. `canLoad: false` cannot be flipped to `true` by the exposure layer.
3. `requiredActiveSpace: "NONE"` routes (settings, billing, persona, teams, tools) never hide on workspace issues.
4. Every capability-allowed route reachable from at least one of {sidebar, All Tools, command palette}.
5. No raw capability codes user-facing.
6. PLATFORM_ADMIN routes stay invisible to non-admins.
7. Sidebar does not call `apiFetch` and does not derive role/persona locally.
8. Denied-but-visible items still link to canonical href; PageRouteGate renders recovery at destination.

---

## 5. Dashboard / CommandCenter dependency map (Part 5)

Cross-references §2 above. Adds:

- CommandCenter's own `LoadState` (`CommandCenter.tsx:62`) keys off `workspaceId` only; same-workspace persona/plan changes leave it stale.
- Backend `command-center.service.ts:21-23` docstring **already supports personal**: "Personal-workspace renders the same envelope but team-only sections return `not_applicable` neutral note."
- So R1 just needs to migrate the hook + trust the per-section degradation that's already there.

### R3 changes (after R1)

- Per-workflow section relevance scoring so layout (not just strip ordering) reflects priority.
- Remove `<NoWorkspaceState/>` (`CommandCenter.tsx:4723-4748`) once R1 lands; or repurpose only for the genuinely unresolved case (authenticated user with zero `Team` rows — should be impossible post personal-workspace bootstrap).

### R3 tests

- Personal-space dashboard renders non-empty content.
- Topbar/dashboard label parity: `data-cc-workspace-scope` matches topbar label.
- Active-space-id round-trip: dashboard issues GET with personal-space id.
- Forbid `useTeamWorkspaceGate` import in `components/command-center/*`.

---

## 6. Route registration & production risk map (Part 6)

55 routes registered in `server.ts:468-616`. Most are clean. The risky/orphan inventory:

| Route/Register | File | Production Registered? | Auth Guard? | Env Guard? | Used By FE? | Risk | CR1 Action |
|---|---|---|---|---|---|---|---|
| `opsSeedRoutes` | `routes/ops-seed.routes.ts` | server.ts:469 | requireAuth + admin perm + shared secret | NO (service-layer 503 only) | NO | MEDIUM (defense-in-depth) | Add env guard at registration site |
| `webhookRoutes` (legacy) | `routes/webhook.routes.ts` | server.ts:511 | requireAuthAndLegal | NO | NO (zero FE consumers) | HIGH (in-memory, redundant with canonical `/v1/integrations/webhooks`) | DELETE file + import + register |
| `auditRoutes` (no-op shim) | `routes/audit.routes.ts` | NOT IMPORTED | n/a | n/a | NO | LOW | DELETE file (zero references) |
| `securityRoutes` | `routes/security.routes.ts` | YES | requireAuth + OWNER/ADMIN 404 | NO | NO (UI uses `/v1/identity-security/*`) | LOW | KEEP + document (subsystem real; not consumed yet) |
| `runtimeReadinessRoutes` | `routes/runtime-readiness.routes.ts` | YES | requireAuth + `audit.read` | NO | YES (`ops/observability`, `RuntimeStatusBanner`, `useGlobalRuntimeState`) | LOW | KEEP |
| **`auditMiddleware`** (NOT a route — `addHook` at server.ts:342) | `middleware/audit.middleware.ts` | YES — runs on every POST/PATCH/PUT/DELETE | n/a | NO | n/a | **HIGH** — calls in-memory `getAuditService()` (`services/audit.service.ts` tombstone) on every state mutation in production. Lost on every restart. Canonical writer (`platform-audit-log.service.ts`) is already wired into each route. | **DELETE hook + middleware + service** |

### Orphan service grep counts

- `services/webhook.service.ts` — 2 importers: `routes/webhook.routes.ts` (CR1 delete target) + **`routes/enterprise.routes.ts`** (LIVE; used indirectly by `dashboard/api-keys`, `dashboard/batch-analysis`).
- `services/api-keys.service.ts` (root — distinct from `services/integrations/api-keys.service.ts`) — 1 importer: `routes/enterprise.routes.ts:11`. The other `api-keys.service` hits in grep point to the canonical `services/integrations/api-keys.service.ts` (KEEP).
- `services/audit.service.ts` — 1 importer: `middleware/audit.middleware.ts`.

### Safe CR1 deletion order

**Phase A — Pure orphans (zero live consumers):**
1. Delete `routes/audit.routes.ts` (zero importers).

**Phase B — Legacy webhook surface:**
2. Delete `routes/webhook.routes.ts` + import at `server.ts:39` + register at `server.ts:511`.

**Phase C — Enterprise keystone decision (UNBLOCKS Phase E):**
3. Decide: migrate `enterprise.routes.ts`'s webhook + API-key + batch-analysis blocks to canonical services, OR delete `dashboard/api-keys` + `dashboard/batch-analysis` frontend pages + excise corresponding `enterprise.routes.ts` endpoints.
4. Drop imports of legacy `apiKeyService` + `getWebhookService` from `enterprise.routes.ts`.

**Phase D — Audit hook + service:**
5. Remove `app.addHook("onRequest", auditMiddleware)` at `server.ts:342`.
6. Delete `middleware/audit.middleware.ts` (only importer is `server.ts:14`).
7. Delete `services/audit.service.ts` (only importer was the middleware).

**Phase E — Final orphan service sweep:**
8. Delete `services/webhook.service.ts` (now zero importers).
9. Delete `services/api-keys.service.ts` (root, not integrations).

**Phase F — Defense in depth:**
10. Wrap `await app.register(opsSeedRoutes)` at `server.ts:469` with `if (process.env.OPERATIONAL_SEEDING_ENABLED === "true")`.

### Hidden HIGH-RISK callout

The `auditMiddleware` at `server.ts:342` is NOT a route registration — it's an `onRequest` hook. **It runs on every state-mutating request in production against an in-memory tombstone.** Canonical audit chain (`platform-audit-log.service.ts`) is wired into each route's handler. The middleware is pure tech debt that LOOKS like it's doing something. CR1 Phase D removes it.

---

## 7. CR1 legacy purge execution plan (Part 7)

For each CR1 target, full row:

| # | Target | Why legacy | Canonical replacement | Importers | Must pass before delete | Order | Risk | Rollback |
|---|---|---|---|---|---|---|---|---|
| 1 | `routes/audit.routes.ts` | no-op shim | `routes/admin-audit.routes.ts` | 0 | API tests + typecheck | A1 | LOW | Git revert |
| 2 | `routes/webhook.routes.ts` | Per-org webhooks; in-memory; redundant with canonical | `routes/integrations.routes.ts` + `services/integrations/webhooks.service.ts` | 1 (server.ts:39, 511) | API tests + typecheck + grep zero FE consumers | B2 | MEDIUM (production-registered) | Git revert |
| 3 | `enterprise.routes.ts` webhook + api-keys blocks | Use orphan services | `services/integrations/*` OR excise pages | n/a (decision) | Web build + FE smoke for `dashboard/api-keys` + `dashboard/batch-analysis` | C3-4 | MEDIUM | Git revert |
| 4 | `services/audit.service.ts` | In-memory tombstone | `services/platform-audit-log.service.ts` | 1 (audit.middleware.ts) | After Phase D deletes hook + middleware | D7 | LOW | Git revert |
| 5 | `middleware/audit.middleware.ts` | Writes to tombstone | Per-route audit calls already exist | 1 (server.ts:14) | API tests + typecheck | D6 | MEDIUM (hook runs in prod) | Git revert |
| 6 | `services/webhook.service.ts` | In-memory orphan | `services/integrations/webhooks.service.ts` + `webhook-dispatcher.ts` | 2 (B2 + C3 delete first) | After B + C complete | E8 | LOW | Git revert |
| 7 | `services/api-keys.service.ts` (root) | In-memory orphan | `services/integrations/api-keys.service.ts` | 1 (enterprise.routes; C delete first) | After C complete | E9 | LOW | Git revert |
| 8 | `ops-seed.routes.ts` (production registration) | Seed routes shipped in prod | Env-guarded registration | n/a | API tests | F10 | LOW | Git revert |
| 9 | `app/(app)/dashboard/page.tsx`, `archive/page.tsx`, `deleted/page.tsx`, `locked/page.tsx`, `operations/page.tsx`, `review/page.tsx`, `reviewer-ops/policy/page.tsx`, `security/page.tsx` (8 redirect pages) | Phase 32.8B redirects | Move to `next.config.js` redirects | Each: only Next.js routing | Web build + smoke FE redirect | A or B (parallel) | LOW | Git revert |
| 10 | `app/(app)/share/[id]/page.tsx` | Explicit deprecation stub ("Not Active") | Either delete or rewire to real share flow (defer real flow to R7) | n/a | Web build | A | LOW | Git revert |
| 11 | `app/(app)/identity/page.tsx` | Phase 17 legacy operator page | Fold into `/admin/identity` OR wrap in PageRouteGate | n/a | Web build + grep | C (after admin/* decision) | LOW | Git revert |
| 12 | `app/(app)/review/operations/page.tsx` | Phase 13 legacy review-ops | Fold into `/reviewer-ops` OR wrap | n/a | Web build + grep | C | LOW | Git revert |
| 13 | Duplicate custody-events code (`services/api/services/custody-events.service.ts` ↔ `services/worker/src/custody-events.ts`) | Same logic written twice; drift risk | Extract to `@proovra/shared/custody` package | many call sites (128) | Custody chain integrity test before + after | CR1.5 prerequisite | HIGH (correctness) | Git revert |
| 14 | Unused schema enums (PUSH, YEAR_1/5, UNDER_REVIEW, ABANDONED, UPLOAD_STARTED, REPLACEMENT_FILE, WITNESS_STATEMENT, PSEUDONYMOUS_SOURCE, EVIDENCE_OVERRIDE, CASE_OVERRIDE, JOURNALISM/RESEARCH/FIELD_OPERATIONS) | Phase 39 audit flagged as unused | Migration to drop | Verify zero consumers via grep | DB migration | After all code purges | MEDIUM (migration) | DB restore |

### Acceptance criteria for CR1 close-out

- 6/6 validation green.
- Allow-list test now allows fewer files (CR0.5 documents 2 active consumers, not 4).
- CR0 `DOCUMENTED_EXEMPTIONS` list updated to remove deleted redirect/legacy pages.
- New CR1 tests: assert deleted files no longer exist; assert no consumers of deleted services.

---

## 8. Frontend/backend parity prep map (Part 8)

15 capabilities, bucketed by owning phase. Detailed rows (endpoints, missing UI, acceptance tests, priority) live in §8 of this document — kept here for CR2 execution.

### CR2 (immediate FE/BE parity)

1. **Intake-link SMS/email send** — `POST /v1/workflow/intake-links/:id/send` backend ready; wire button inside `RawTokenRevealModal` (`intake-links/page.tsx:524`). Pre-fill `recipientPhone` from link row. Acceptance: stub Twilio + assert `CommunicationMessage` + audit row.
2. **External-review console + reviewer SPA** — new operator page `apps/web/app/(app)/external-review/page.tsx` + reviewer public route `apps/web/app/external-review/access/[token]/page.tsx`. Backend complete (935 LoC).
3. **SSO login button** — add `GET /v1/auth/sso/discover?email=...` (new endpoint) + login page domain-match button.
4. **SCIM PATCH compliance + discovery** — extend `scim.routes.ts:191` 501 branch; add `/ServiceProviderConfig`, `/Schemas`, `/ResourceTypes`.
5. **Per-tenant audit chain verify** — new `GET /v1/audit/teams/:teamId/verify-chain?limit=N` + admin UI.
6. **Webhook delivery log viewer UI** — backend `GET /v1/integrations/webhooks/:id/deliveries` exists; build drawer.
7. **API-key usage log viewer UI** — backend write exists; add `GET /v1/integrations/api-keys/:id/usage` route + UI.

### R7 (identity hardening)

8. **TOTP MFA** — `otplib` + new `MfaFactor` table + `/v1/identity-security/mfa/totp/*` routes + settings/security page.
9. **WebAuthn / passkey** — `@simplewebauthn/server` + `WebAuthnCredential` table.
10. **Full SAML 2.0** — `@node-saml/node-saml` + ACS + metadata endpoint.

### R8 (enterprise security + reviewer ops)

11. **SIEM audit forwarder** — new `audit-forwarder/` module + adapters (Splunk HEC / Datadog / Sumo Logic / generic) + `AuditForwarderTarget` table + admin page.
12. **Reviewer auto-assignment** — `ReviewerAssignmentPolicy` table + `auto-assignment.service.ts` (round-robin minimum).
13. **Business-hours SLA calendars** — `BusinessHoursPolicy` table + `addBusinessMinutes` in `sla-policy.service.ts`.

### R9 (mobile parity)

14. **Mobile multipart + streaming hash + background uploads** — replace `upload-utils.ts` MD5 with `expo-crypto` streaming SHA-256; switch to `services/api/src/routes/upload-sessions.routes.ts`; add `expo-background-fetch`/`expo-task-manager`.
15. **Mobile intake-link redemption** — new `apps/mobile/app/(public)/intake/[token].tsx` + deep links + universal links.

---

## 9. Recovery roadmap lock (Part 9)

**The phase order below is locked. No phase may skip ahead unless the previous phase has a final report and validation green.**

| # | Phase | Predecessor | Owner artifact |
|---|---|---|---|
| 1 | **CR0** — System Freeze & Safety Baseline | — | `docs/recovery/CR0_SYSTEM_FREEZE_BASELINE.md` |
| 2 | **CR0.5** — Recovery Readiness & State Dependency Closure | CR0 | `docs/recovery/CR0_5_RECOVERY_READINESS.md` (this doc) |
| 3 | **CR1** — Legacy & Duplicate System Purge | CR0.5 | TBD |
| 4 | **CR1.5** — State & Orchestration Observability | CR1 | TBD |
| 5 | **R1** — Product State Recovery | CR1.5 | TBD |
| 6 | **R1.5B** — Workspace Experience Segmentation | R1 | TBD |
| 7 | **R4** — Product Language & UX Coherence | R1.5B | TBD |
| 8 | **CR6** — Product Orchestration Layer | R4 | TBD |
| 9 | **R2** — Navigation Collapse & IA Recovery | CR6 | TBD |
| 10 | **R5** — Progressive Disclosure | R2 | TBD |
| 11 | **R6** — Operational Hubs | R5 | TBD |
| 12 | **R3** — Dashboard Orchestration | R6 | TBD |
| 13 | **CR2** — Frontend/Backend Parity | CR0.5 §8 | TBD |
| 14 | **CR5** — Capture Safety Extraction | R5 | TBD |
| 15 | **CR3** — Operational Reliability | CR1.5 | TBD |
| 16 | **CR4** — Verify Decomposition | CR3 | TBD |
| 17 | **R7** — Mobile & External Workflow Hardening | CR2 | TBD |
| 18 | **R8** — Enterprise Identity & Security | CR2 | TBD |
| 19 | **R9** — Enterprise Operations Activation | R7, R8 | TBD |
| 20 | **R9.5** — Design Primitive Consolidation | R9 | TBD |
| 21 | **R10** — Design System & Visual Maturity | R9.5 | TBD |
| 22 | **R11** — Browser QA & Accessibility | R10 | TBD |
| 23 | **CR8** — Pilot & Operator Readiness | R11 | TBD |

---

## 10. Guardrails added in CR0.5 (Part 10)

`services/api/test/phase-cr0-5-recovery-readiness.test.ts` adds source-contract tests for:

1. CR0.5 readiness doc exists at canonical path + non-trivial.
2. Recovery roadmap order present + locked in the doc.
3. CR0 guardrails still pass (defense in depth — re-asserts existence).
4. No new useTeamWorkspaceGate callsites — extends the existing Phase 38.7 allow-list (now narrowed to 2 production sites).
5. No new direct "Unknown" fallback in primary shell without CR0-allowed comment (extends CR0).
6. CommandCenter still uses `useTeamWorkspaceGate` — pinned as known-bug awaiting R1 (test asserts the import IS present, so if R1 removes it the test must be updated as part of R1 — forces the migration to be reflected in tests).
7. settings/persona save handler still does NOT call `refresh` — pinned as known-bug awaiting R1 (test asserts the file does NOT contain `refresh(` so R1's fix will trigger test failure → forces the update).
8. No new production seed/debug route registration outside acknowledged list.
9. No workflow/persona authorization gate introduced (no `if (persona.* !== "X") return null` in (app)/ pages).
10. No capture upload/finalization files changed in CR0.5 — pinned content hashes for `services/api/src/services/evidence-complete.service.ts` length tier (within ±5%) + custody-events service file presence.

---

## 11. Honest residual risks (post-CR0.5)

1. **CR0.5 still documents — does not fix.** R1 fixes the two headline bugs (CommandCenter + persona refresh). Those single-line changes are blocked behind CR1 per roadmap order.
2. **The keystone-coupling in `enterprise.routes.ts`** means CR1 cannot delete orphan services without first making a design decision on enterprise.routes.ts blocks (Phase C). That decision should be documented before CR1 execution begins.
3. **The `auditMiddleware` hidden risk** is per-request on every state mutation in production. It's writing to a tombstone for nothing. Until CR1 Phase D lands, every audit signal that flows through that hook is lost on restart — but per-route canonical audit writes are intact, so user-visible audit data is not lost.
4. **Three FE files still self-fetch `/v1/users/me`** — minor drift class, R1 cleanup.
5. **`envelope.workspace` (legacy) + `envelope.activeSpace` (canonical)** still both populated. R1+R3 should converge consumers onto `activeSpace`.
6. **Five unused enum values** flagged in CR0 + 8 new ones found in CR0.5 audits — CR1 schema cleanup pass.
7. **No browser verification** remains; manual QA checklist from Phase 38.16 still pending R11.

---

## CR0.5 confirmation checklist

- [x] No features added.
- [x] No UI redesigned.
- [x] No sidebar collapsed.
- [x] No dashboard redesigned.
- [x] No onboarding rewritten.
- [x] No legacy purged.
- [x] No risky capture refactor performed.
- [x] No upload / finalization / custody / TSA / OTS / report / package logic changed.
- [x] CR1 is now executable from §7's safe deletion order.
- [x] R1 is now diagnosable — the two headline bugs (CommandCenter, persona refresh) have one-line fixes pinpointed to exact line numbers.

End of CR0.5.
