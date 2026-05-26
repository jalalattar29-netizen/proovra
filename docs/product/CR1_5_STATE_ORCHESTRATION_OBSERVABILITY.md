# PHASE CR1.5 — State & Orchestration Observability (Product Audit)

**Status:** Audit complete. No rewrites. No redesigns. No new features. No backend permission semantics changed. No capture / upload / finalize / custody / TSA / OTS / report / package logic touched. Evidence-backed findings only.

**Date:** 2026-05-25

**Scope:** Truth-mapping of how operational product state flows through PROOVRA today — after R1, R1.5B, R2, R3, R4, R5, R6, R7, R8, R8.1.x, R8.2.x, R8.C have all landed. This document complements `docs/recovery/CR1_5_STATE_ORCHESTRATION_OBSERVABILITY.md` (the original CR1.5 audit) with a re-audit reflecting the current codebase state.

---

## 1. Executive summary

Most of the "operational coherence" bugs visible in the original CR1.5 prompt (red Unknown / "No workspace selected" while topbar shows Personal Space / persona-save requires reload) have been **structurally fixed** in R1 and the Phase 38.x migration arc. The remaining risks are **dead code paths** that could be reactivated by accident and **a small number of legacy self-fetchers** awaiting R2 migration.

Concrete findings (all evidence-backed below):

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | Workspace state has a single canonical source (`PlatformContextEnvelope`) read by every surface that uses the envelope hooks. No localStorage parallel state. | — | ✅ Sound |
| 2 | Persona save now calls `ctx.refresh()` (R1 Bug B fix) — sidebar/dashboard/density/banner all re-render without reload. The "Reload to see" copy is gone. | — | ✅ Fixed |
| 3 | CommandCenter consumes the canonical envelope (R1 Bug A fix) — no longer filters out Personal Space. Topbar ↔ dashboard agreement restored on the home dashboard. | — | ✅ Fixed |
| 4 | `useGlobalRuntimeState` returns `"UNKNOWN"` severity correctly only when probes cannot confirm health (fail-closed). The display label is `"Status pending"` — not the raw `"Unknown"` word — via `RUNTIME_SEVERITY_LABELS.UNKNOWN`. | — | ✅ Bounded |
| 5 | **Three surfaces still declare a dead `"no_workspace"` LoadState branch** (`WorkspaceAdminPanel`, `ReviewerCommandConsole`, `GovernanceControlPlane`). The branch is unreachable today (state is never set), but the `ShellNoWorkspace()` function rendering "No workspace selected" remains exported and could be re-wired by a future PR that didn't read this audit. | MEDIUM | ⚠ Cleanup recommended in R9 |
| 6 | The reviewer-ops `WorkspaceGateState` legitimately renders "No workspace selected" only when `state.reason !== "personal"` — i.e. the user has no Personal Space at all (rare; provider auto-bootstraps Personal Space) AND no organization membership. The "personal" reason renders the structured `CapabilityDegradedPanel`. | LOW | ✅ Correct |
| 7 | Three legacy `/v1/users/me` self-fetchers remain on the documented allow-list (`providers.tsx`, `settings/page.tsx`, `teams/[id]/page.tsx`). R2 owns the migration. | LOW | Tracked |
| 8 | One legacy `useTeamWorkspaceGate()` callsite remains on the allow-list (`ops/page.tsx`). Operator-only surface; gating is intentional. | — | ✅ Bounded |
| 9 | Persona/workflow profile changes ordering + defaults + density + labels — **NOT capability**. The `workflowExposureResolver.ts` contract explicitly forbids authorization concepts in workflow logic. | — | ✅ Contract enforced |

**Bottom line:** PROOVRA's product-state layer is **substantially more coherent than the prompt suggests**. The original CR1.5 symptoms have been fixed in source. What remains is dead-code hygiene (3 dead `no_workspace` branches) and the long-tail self-fetcher migration owned by R2. No new redesign is required to close the perceived coherence gap.

---

## 2. Current state model

### 2.1 Canonical state contract

| State Domain | Backend canonical source | Frontend canonical reader | Persistence | Refresh trigger |
|---|---|---|---|---|
| Authenticated user | `GET /v1/platform/context` → `envelope.user` | `usePlatformContext()` / `useAccount()` | Server (`User` row) + JWT | Provider mount + workspace switch + `ctx.refresh()` |
| Active workspace (Personal or Org, unified) | `envelope.activeSpace` | `useActiveSpace()` / `useActiveSpaceId()` | Server (`User.currentWorkspaceId`) | Workspace switch + provider re-fetch |
| Personal Space | `envelope.personalSpace` | `usePersonalSpace()` | Server (`Team` row with `isPersonal=true`) | Bootstrapped once per user via `ensurePersonalWorkspace()` |
| Team / Organization | `envelope.organizations[]` + `envelope.activeSpace.type === "ORGANIZATION"` | `useOrganizations()` / `useActiveSpace()` | Server (`Team` rows) | Org create/join routes |
| Persona / workflow profile | `envelope.personaProfile` (DB: `WorkspacePersonaProfile`) | `usePersonaProfile()` + `workflowFromPersona()` | Server (`WorkspacePersonaProfile` row keyed by `teamId`) | `PATCH /v1/workspaces/:teamId/persona` → `ctx.refresh()` |
| Onboarding completion | `envelope.personaProfile.onboardingCompleted` | `usePersonaProfile().onboardingCompleted` | Same as persona | Same as persona |
| Density preference | `envelope.personaProfile.operationalDensityPreference` | `usePersonaProfile()` → CSS attribute on `AppShellV2.tsx` | Same as persona | Same as persona |
| Route access (per route) | `envelope.capabilities` + `envelope.activeSpace.type` | `resolveRouteAccess(...)` in `routeAccessResolver.ts` | Server (capability map) | Provider re-fetch |
| Capability / permission | `envelope.capabilities` (boolean map) | `useCan(cap)` from `usePlatformContext` | Server | Provider re-fetch |
| Workflow exposure (sidebar bucketing) | (pure derivation — no backend) | `resolveWorkflowExposure(...)` in `workflowExposureResolver.ts` | n/a | Re-derived on every render |
| Sidebar visibility | `route.sidebarEligible` + `access.canSeeNav` | `AppSidebarV2.tsx` iterates `ROUTE_REGISTRY` | n/a | n/a |
| Dashboard mode | Backend `/v1/dashboard/command-center` envelope; sections marked `not_applicable` for Personal | `CommandCenter.tsx` reads canonical envelope + the fetched section data | n/a | Triggered on activeSpace.id change |
| Runtime health / degraded subsystem state | `GET /admin/runtime/readiness` + `/v1/ops/incidents` + `/v1/reviewer-ops/escalations` | `useGlobalRuntimeState()` → severity `HEALTHY \| DEGRADED \| INCIDENT_ACTIVE \| CRITICAL \| UNKNOWN` | n/a (polled) | 45 s default poll, bounded [15 s, 5 min] |

### 2.2 What is NOT in state

These do not exist as separate state in the web app — there is no client-side cache library, no local workspace cache, no Redux/Zustand, no Recoil:

- **No React Query / SWR / TanStack Query.** `apps/web/lib/api.ts` exposes a thin `apiFetch()` helper. All fetches are explicit.
- **No localStorage workspace keys.** `localStorage` is only used for `proovra-token` (auth), `proovra-locale`, `proovra-locale-mode`. Zero workspace / persona / nav keys.
- **No sessionStorage usage.** Zero `sessionStorage.setItem` calls found in `apps/web/`.
- **No `window.location.reload()` / `router.refresh()` calls.** Refresh is always envelope re-fetch via `ctx.refresh()`.

This is by design (CR0 / CR0.5 / CR1.5 baseline). The envelope is the single source of truth; no parallel caches exist that could disagree with it.

---

## 3. Active workspace lifecycle

### 3.1 End-to-end trace

```
1. User signs in
   → POST /v1/auth/login (or SAML / OAuth)
   → JWT issued, stored as localStorage["proovra-token"]
   → apps/web/app/providers.tsx mounts AuthContext, fetches /v1/users/me (bootstrap)

2. PlatformContextProvider mounts
   → fetches GET /v1/platform/context
   → backend reads User.currentWorkspaceId
   → if set + valid TEAM membership exists → uses it
   → if stale / missing / invalid → bootstraps Personal Space via ensurePersonalWorkspace()
   → returns envelope { user, activeSpace, personalSpace, organizations[], capabilities, personaProfile, ... }
   → provider state: IDLE → LOADING_CONTEXT → READY

3. Topbar reads envelope.activeSpace
   → AppTopbarV2.tsx:96-141 derives the label
   → activeSpace.type === "PERSONAL"  → "Personal Space" / "Personal • Owner"
   → activeSpace.type === "ORGANIZATION" → activeSpace.displayName / roleLabel

4. Sidebar reads ROUTE_REGISTRY + envelope.capabilities + envelope.activeSpace.type
   → AppSidebarV2.tsx invokes resolveRouteAccess() per route
   → routes with canSeeNav=true render, routes with canSeeNav=false hide
   → personal-mode demotion rules promote operational tools into "More / Advanced"

5. Dashboard reads envelope.activeSpace.id
   → CommandCenter.tsx fetches /v1/dashboard/command-center?teamId={activeSpace.id}
   → backend returns sections with status: "ok" | "degraded" | "unavailable" | "not_applicable"
   → personal users: team-only sections render as "not_applicable" with structured notes

6. User clicks workspace switcher
   → AppTopbarV2 calls ctx.switchWorkspace(id)
   → POST /v1/platform/context/switch-workspace
   → backend verifies membership, updates User.currentWorkspaceId, returns new envelope
   → provider state: READY → SWITCHING → READY (with new envelope)
   → fetchSequenceRef guards against out-of-order responses
   → topbar, sidebar, dashboard all re-render automatically
```

### 3.2 Exact answers to CR1.5 prompt questions

**Q: Is "Personal Space" a real workspace, virtual, or UI fallback?**
A: **Real `Team` row** with `isPersonal=true`. Created at signup by `ensurePersonalWorkspace()`. Has a partial unique index `(ownerUserId, isPersonal=true)` to prevent duplicates. The display string `"Personal Space"` is hardcoded in `platform-context.service.ts:537,544,588` and in `AppTopbarV2.tsx:116,132`. Same string both places — no drift risk.

**Q: Where is it created or inferred?**
A: `services/api/src/services/platform-context/platform-context.service.ts` — `ensurePersonalWorkspace()` (around lines 398-524). Bootstrap is concurrency-safe and idempotent.

**Q: Can dashboard disagree with topbar?**
A: **On the canonical home dashboard (`/home` → CommandCenter), no.** Both read `envelope.activeSpace`. The R1 Bug A fix removed the legacy `useTeamWorkspaceGate()` from CommandCenter.

The historical mismatch was: CommandCenter used `useTeamWorkspaceGate()` (returns null for personal), topbar used `envelope.activeSpace` (returns personal). Personal users saw "Personal Space" in topbar + "No workspace selected" in dashboard. **This is now fixed.**

Three dashboards still have **dead `no_workspace` branches** (see §6) — but they are unreachable today.

**Q: What happens if a saved workspace id no longer exists?**
A: Backend heals it. `platform-context.service.ts` detects stale `User.currentWorkspaceId` (deleted team OR user is not an ACTIVE member) and falls through to Personal Space bootstrap, logging `workspaceSource: "personal_bootstrap_after_stale"` in `diagnostics`.

**Q: What happens immediately after persona setup save?**
A: The settings/persona page calls `ctx.refresh()` after the PATCH (settings/persona/page.tsx:157). The envelope is re-fetched, and all downstream consumers (sidebar bucketing, dashboard section order, density CSS, persona banner, contextual help) re-render. **No reload required.** The success copy reads: "Workspace profile updated. Your navigation and recommendations have been refreshed." (line 449-451).

---

## 4. Persona / workflow lifecycle

### 4.1 Save → consume chain

```
1. User edits persona at /settings/persona (or during onboarding)
   → settings/persona/page.tsx persistProfile()  (line 132)
   → PATCH /v1/workspaces/:teamId/persona
   → backend: workspace-persona.routes.ts upserts WorkspacePersonaProfile row
   → backend emits audit log "workspace.persona.updated"

2. Frontend calls ctx.refresh()  (line 157)
   → re-fetches /v1/platform/context
   → backend re-reads persona via readWorkspacePersonaProfile()
   → new envelope injected into React context

3. State observability event emitted:
   → emitStateEvent("persona-profile:saved", ...) on success
   → emitStateEvent("persona-profile:refresh-missing", ...) if refresh fails
   → events go to console.debug + ring buffer (dev-only, gated by NEXT_PUBLIC_PLATFORM_STATE_OBSERVABILITY)

4. Downstream consumers re-render automatically (React hook deps):
   → AppSidebarV2.tsx: reorderByPersona() with new persona
   → CommandCenter.tsx: getPersonaSectionOrder() with new persona
   → AppShellV2.tsx: data-operational-density attribute updates
   → PersonaSetupBanner.tsx: re-evaluates onboardingCompleted

5. Success banner appears: "Workspace profile updated. Your navigation and recommendations have been refreshed."
```

### 4.2 Is persona cosmetic or operational?

**Cosmetic + ordering + defaults + labels — NEVER capability.**

This is a hard contract enforced by `apps/web/lib/navigation/workflowExposureResolver.ts` (header lines 14-21) and asserted by `phase-cr1-5-state-observability.test.ts` Test 12:

```
expect(src).not.toMatch(/\bcanLoad\s*=/);
expect(src).not.toMatch(/requiredCapabilities\b\s*[:?.]/);
expect(src).not.toMatch(/authorize/i);
expect(src).not.toMatch(/forbidden/i);
```

What persona DOES affect:
- Sidebar bucketing (which items appear in primary vs. More/Advanced)
- Dashboard section ordering (which sections appear first)
- Density preference (compact / comfortable / spacious CSS)
- Default capture template
- Persona banner copy

What persona DOES NOT affect:
- Whether a page is reachable (that's `resolveRouteAccess` with capabilities + activeSpaceType)
- Whether a mutation succeeds (that's backend permission middleware)
- Whether a feature exists (that's backend feature flags + plan)

### 4.3 Pages that consume persona

(verified by Grep across `apps/web/`)

| File | What it reads |
|---|---|
| `components/app-shell-v2/AppSidebarV2.tsx` | Reorder bands, expose workflow-tagged items |
| `components/command-center/CommandCenter.tsx` | Section order via `getPersonaSectionOrder()` |
| `components/app-shell-v2/AppShellV2.tsx` | `data-operational-density` attribute → CSS |
| `components/persona/PersonaSetupBanner.tsx` | `onboardingCompleted` boolean |
| `components/contextual-help/ContextualHelp.tsx` | Workflow code → help content selection |
| `components/governance-experience/GovernanceControlPlane.tsx` | Workflow-aware help mount |
| Multiple page surfaces via `ContextualHelp` mount (Phase 38.16/17/18) | Surface-specific help |
| `app/(app)/capture/page.tsx` | Recommended template ordering |

**No "ignore persona" pages found** that would be expected to react. The architecture is complete.

---

## 5. Navigation lifecycle

### 5.1 Single source of truth

`apps/web/lib/navigation/routeRegistry.ts` (≈60 routes) is the **only** declaration of nav items. Each route carries:

```ts
{
  id: string,                                // "workspace.home", "governance.hub", etc.
  href: string,                              // "/home", "/governance"
  label: string,                             // user-facing
  domain: "PERSONAL_WORKSPACE" | "ORGANIZATION_WORKSPACE" | "GOVERNANCE" | "REVIEW_OPERATIONS" | "OPS" | "PLATFORM_ADMIN" | "ACCOUNT",
  requiredCapabilities: CapabilityKey[],     // e.g. ["GOVERNANCE_VIEW"]
  requiredActiveSpace: "NONE" | "PERSONAL_OR_ORG" | "ORGANIZATION_ONLY" | "PLATFORM_ADMIN",
  fallbackBehavior: "ACCESS_DENIED" | "CREATE_ORG" | "UPGRADE_REQUIRED" | "PLATFORM_ADMIN_ONLY",
  workflowTags: string[],                    // affects ordering only
  advancedByDefault: boolean,                // affects bucketing only
  sidebarEligible: boolean,                  // false = command palette + All Tools only
  ...
}
```

The bounded set of 6 canonical primary routes is in `apps/web/lib/navigation/canonicalNavigationGroups.ts` (`CANONICAL_PRIMARY_ROUTE_IDS`): `home, capture, evidence, cases, reports, search`. Adding to this set requires CR sign-off.

### 5.2 Gating mechanism

`resolveRouteAccess()` in `apps/web/lib/navigation/routeAccessResolver.ts` is a pure function of:

```
input  = { route, activeSpaceType, isPlatformAdmin, capabilities, accountPlan }
output = { canLoad: boolean, canSeeNav: boolean, accessState: AccessState }
```

Decision order:
1. Platform-admin check (PLATFORM_ADMIN_ONLY routes hidden from non-admins)
2. Active-space requirement (NEEDS_ORGANIZATION etc.)
3. Capability check (DENIED_NO_CAPABILITY)

No role, persona, or workflow logic in this function. **This is the canonical authorization layer for nav.**

### 5.3 Disclosure tiers (no toggle)

`apps/web/lib/navigation/disclosureModel.ts` defines four tiers — **NOT user-toggleable** as of the current codebase:

- `beginner` — canonical primaries + non-demoted
- `advanced` — `advancedByDefault: true` + personal-mode demoted
- `contextual` — capability-dependent prominence (e.g. governance lifts in org mode)
- `all-tools-only` — `sidebarEligible: false`

There is no localStorage "advancedMode" key. The term "advanced" appears only as a static route property and a static sidebar group label. **No user-facing toggle exists for advanced mode** — this differs from what the CR1.5 prompt implied. If a toggle is intended for R-future, it needs to be designed; nothing exists today.

### 5.4 Hub structure

`apps/web/lib/hubs/hubDefinitions.ts` — 4 hubs, each with 3–4 quick actions + 4–7 member routes:

| Hub | Landing route | Quick actions |
|---|---|---|
| Investigation | `investigation.hub` | timeline, graph, duplicates, reviewers |
| Governance | `governance.hub` | retention, lifecycle, analytics, policy |
| Reviewer Ops | `review.queue` | queue, escalations, sla |
| Operations | `platform.ops_center` | observability, runbooks, integrations |

Hubs are **metadata only** — they do not gate access or change routing. Every quick action `href` is a registered route id; PageRouteGate on the destination enforces authorization.

### 5.5 PageRouteGate consumers

**49 pages** wrap children in `<PageRouteGate routeId="...">` (Phase 38.6+ migration). Source-contract tests prevent drift.

### 5.6 useTeamWorkspaceGate consumers

**1 production callsite** on the allow-list (down from ~30+ at CR0.5 baseline):

- `apps/web/app/(app)/ops/page.tsx` — operator-only surface; team-scope gating intentional.

The hook is also exported from `lib/platform-context/index.ts` (re-export) and defined in `lib/platform-context/useTeamWorkspaceGate.ts`. CR1.5 Test 8 pins this allow-list and rejects new callsites.

### 5.7 useTeamId consumers

`useTeamId()` is a convenience alias backed by the same gate. 28 surviving callsites; all wrapped by PageRouteGate so personal users never load the page. CR1.5 deliberately does NOT pin this larger set — R2 owns the migration to `useWorkspaceId()` for personal-accepting surfaces.

### 5.8 Raw label leakage

Grep across `apps/web/` confirms:
- No bare `"Unknown"` user-facing labels. UNKNOWN severity renders as `"Status pending"` via `lib/platform-context/stateLabels.ts`.
- No bare `"Access"` / `"Org"` labels. Degradation chips use bounded enum `DEGRADATION_CHIP_LABELS` ("Requires organization" / "Requires permission" / "Setup needed" / "Upgrade required").
- No `"Workspace #1"` / `"Team 123"` patterns.

### 5.9 Personal vs team contamination

`apps/web/lib/workspace-experience/personalDemotionRules.ts` defines `PERSONAL_MODE_DEMOTION_ROUTE_IDS` (≈7 routes) explicitly moved to "More / Advanced" in personal mode (review.queue, review.sla, governance.*). These routes declare `requiredActiveSpace: "ORGANIZATION_ONLY"` + `fallbackBehavior: "CREATE_ORG"`. In personal space they still appear in nav but link to `CapabilityDegradedPanel` instead of blank pages.

No leakage of governance/reviewer-ops items into Personal Space dashboard. **Intentional demotion only.**

---

## 6. Dashboard lifecycle

### 6.1 Canonical entry

`apps/web/app/(app)/home/page.tsx` → `<PageRouteGate routeId="workspace.home">` → `<CommandCenter />`. Single canonical dashboard. Sub-routes `/dashboard/*` (api-keys, batch-analysis, insights, quotas) are operational utilities — not "the dashboard."

There is NO separate personal vs. team vs. ops dashboard. The CommandCenter adapts via `workspace.scope` (PERSONAL or ORGANIZATION) returned by the backend; team-only sections render `status: "not_applicable"` for personal users with structured notes.

### 6.2 LoadState machine

```ts
type LoadState =
  | { status: "loading" }
  | { status: "ready"; envelope: CommandCenterEnvelope }
  | { status: "no_workspace" }
  | { status: "auth_error"; code: "auth_required" | "permission_denied" }
  | { status: "unavailable"; message: string; requestId: string | null };
```

**The `"no_workspace"` state IS reachable in CommandCenter** — set when `activeSpace == null` OR `activeSpace.id == null` (during Personal Space bootstrap window). Renders `<NoWorkspaceState />` which displays "Workspace setup incomplete" — **NOT** "No workspace selected".

The string "No workspace selected" exists in 4 files in the repo:

| File | Status | Trigger |
|---|---|---|
| `apps/web/components/workspace-admin/WorkspaceAdminPanel.tsx:774` | **DEAD CODE** | LoadState declares `"no_workspace"` but state machine never sets it. `ShellNoWorkspace()` is unreachable. |
| `apps/web/components/reviewer-experience/ReviewerCommandConsole.tsx:668` | **DEAD CODE** | Same — `"no_workspace"` declared but never set. |
| `apps/web/components/governance-experience/GovernanceControlPlane.tsx:857` | **DEAD CODE** | Same. The component's actual no-team handling is via `CapabilityDegradedPanel` at line 95 (when `!ctx.can("GOVERNANCE_VIEW")`). |
| `apps/web/app/(app)/reviewer-ops/WorkspaceGateState.tsx:119` | **LIVE — but bounded** | Only reached when `state.reason !== "personal"` (i.e. true no-workspace edge case). Personal users get `CapabilityDegradedPanel` at line 100 instead. |

**Recommendation:** R9 (next stabilization phase) should remove the 3 dead `ShellNoWorkspace` functions + their `"no_workspace"` LoadState branches. CR1.5 does **not** remove them — that's source change beyond audit scope. The new contract test (§10 below) pins these locations so they cannot be re-wired.

### 6.3 "Unknown" runtime state

`useGlobalRuntimeState()` returns severity `"UNKNOWN"` when:
- `!teamId` (line 292)
- `loading` (line 293)
- Any probe source errored (line 31-32: `errors.readiness || errors.incidents || errors.escalations`)

**This is fail-closed behavior** — when probes cannot confirm health, do not show HEALTHY.

The display layer translates `UNKNOWN` to `"Status pending"` via `RUNTIME_SEVERITY_LABELS.UNKNOWN` in `apps/web/lib/platform-context/stateLabels.ts` (line 34). The raw word "Unknown" never reaches the user as a runtime status label.

If users are seeing red "Unknown" in production, the most likely cause is:
1. One of the probe endpoints (`/admin/runtime/readiness`, `/v1/ops/incidents`, `/v1/reviewer-ops/escalations`) is failing or unreachable.
2. The probe is timing out and the UI is correctly fail-closed.

Investigation should focus on the runtime probe layer, not the UI label.

### 6.4 Cards & graceful degradation

| Card | Required scope | Degradation |
|---|---|---|
| Operational Pressure | PERSONAL or TEAM | `unavailable` → "temporarily unavailable" |
| Routing Queue | TEAM | `not_applicable` in PERSONAL → structured note |
| Investigation Risk | TEAM | same |
| Reviewer Workload | TEAM | `unavailable` if metrics fail |
| Case Operations | PERSONAL or TEAM | `unavailable` |
| Reviewer Orchestration | TEAM | `not_applicable` in PERSONAL |
| Pipeline Detail | PERSONAL or TEAM | `unavailable` |
| Governance Posture | TEAM | `not_applicable` in PERSONAL |
| Audit Readiness | TEAM | `not_applicable` in PERSONAL |
| Org Intelligence | TEAM | `unavailable` |
| Custody Integrity Watch | TEAM | `unavailable` |
| Recent Evidence | PERSONAL or TEAM | `unavailable` |
| Incidents | TEAM | `unavailable` |

All cards follow the same `SectionStatus` contract:
```ts
{ status: "ok" | "degraded" | "unavailable" | "not_applicable"; data: T | null }
```

---

## 7. Cache / invalidation map

### 7.1 Storage inventory

| Storage | Keys | Used for | Risk |
|---|---|---|---|
| localStorage | `proovra-token` | Auth bearer | LOW — read on init + on apiFetch retry |
| localStorage | `proovra-locale`, `proovra-locale-mode` | Locale preference | NONE |
| sessionStorage | (none) | — | — |
| Cookies (client) | (none non-auth) | Auth handled server-side via `credentials: "include"` | — |
| React Context | `PlatformContextProvider` | Envelope + state machine | Canonical |
| Next.js server cache | `app/api/health/route.ts` + `app/health/route.ts` are `force-dynamic`; everything else uses Next.js defaults | — | LOW |

**Zero workspace / persona / nav state in browser storage.** All state is server-canonical + envelope-cached in React Context. There is no client cache library (no React Query / SWR).

### 7.2 Invalidation matrix

| Trigger | What is invalidated | What is NOT invalidated | Risk |
|---|---|---|---|
| Login | Token set; on next mount, provider fetches envelope | AuthContext fetches `/v1/users/me` in parallel (legacy bootstrap) | Brief duplicate fetch; both succeed |
| Workspace switch | Full envelope re-fetch via `POST /v1/platform/context/switch-workspace`; provider state SWITCHING → READY; fetchSequenceRef prevents out-of-order | Per-page in-flight requests for the old workspace id may complete after switch | LOW — components key on `activeSpace.id` so old responses are visually discarded |
| Persona save | `ctx.refresh()` re-fetches envelope; all consumers re-render | Backend session token unchanged (no need) | NONE |
| Team role change (admin grants role to user) | User must `ctx.refresh()` manually OR navigate to trigger a re-fetch | Capability map is stale until next envelope fetch | MEDIUM — no push channel; user may see stale "DENIED_NO_CAPABILITY" until reload |
| Plan upgrade | Same — no auto-invalidation | Account plan stale until envelope re-fetch | MEDIUM — see above |
| Logout | Token cleared; AuthContext.user set to null | Provider state remains READY until next 401 from a fetch | LOW — visible only in fraction-of-a-second window |
| Settings profile PATCH | None automatic | Envelope.user is stale until next refresh | LOW — settings/page.tsx is on the allow-list; R2 will pair PATCH with `ctx.refresh()` |

**Critical gaps remaining (for R2 / R9):**
1. **No push channel for capability/plan changes.** A user whose admin just granted them a capability won't see it until next page navigation. Acceptable for now (rare event); a WebSocket or SSE-based push is out of scope until R-future.
2. **Settings profile PATCH does not call `ctx.refresh()`.** Stale envelope.user for one page navigation. R2 pairs the call.
3. **Logout does not synchronously tear down provider.** Brief window with stale envelope. R-future hook.

### 7.3 Self-fetcher allow-list (pinned)

3 production exemptions (CR1.5 Test 7 enforces):

```
apps/web/app/providers.tsx               — Bootstrap before provider
apps/web/app/(app)/settings/page.tsx     — Profile PATCH + read
apps/web/app/(app)/teams/[id]/page.tsx   — Legacy fallback for team detail
```

R2 owns migration of (2) and (3) to `envelope.user.id`.

---

## 8. Impossible states discovered

| Impossible state | Today's behavior | Risk |
|---|---|---|
| Topbar shows Personal Space; dashboard says "No workspace selected" | **Cannot happen on canonical home dashboard** (CommandCenter migrated to envelope in R1). Old screenshots from pre-R1 are now stale. | NONE on `/home` |
| Topbar shows Personal Space; GovernanceControlPlane says "No workspace selected" | **DEAD CODE** in `ShellNoWorkspace()`. Component renders `CapabilityDegradedPanel` (line 95) for personal users via capability gate. | NONE today; cleanup recommended |
| Sidebar exposes team-only tool while dashboard says no workspace | Cannot happen — personal-mode demotion rules + canonical envelope make these consistent | NONE |
| Persona saved but banner still prompts indefinitely | Cannot happen — `ctx.refresh()` fires after save; banner reads `envelope.personaProfile.onboardingCompleted` | NONE |
| Workflow profile exists but navigation ignores it completely | Cannot happen — sidebar consumes `usePersonaProfile()` via `reorderByPersona()` | NONE |
| Workspace id saved but workspace list does not contain it | Backend heals stale `currentWorkspaceId` → Personal Space bootstrap; emits `personal_bootstrap_after_stale` diagnostic | LOW |
| Dashboard degraded state remains after healthy runtime checks | `useGlobalRuntimeState` re-derives severity each poll (45s default); transitions HEALTHY ↔ DEGRADED naturally | LOW — observable via Probe latency |
| Raw "Unknown" shown to user when canonical fallback exists | Cannot happen — `RUNTIME_SEVERITY_LABELS.UNKNOWN = "Status pending"` enforced | NONE |

---

## 9. Canonical source-of-truth recommendations

The codebase already implements all of these. They are documented here as the **explicit contract** that future phases must preserve:

1. **`PlatformContextEnvelope` (via `GET /v1/platform/context`) is the frontend canonical state source** for user, activeSpace, organizations, personalSpace, capabilities, personaProfile. New surfaces consume the envelope via hooks in `apps/web/lib/platform-context/`.
2. **`ROUTE_REGISTRY` is the canonical nav source.** New nav items declare a `RouteDefinition` with explicit `requiredCapabilities` + `requiredActiveSpace`.
3. **`resolveRouteAccess()` is the canonical authorization function for routes.** No surface bypasses it. No surface re-implements capability checks.
4. **`workflowExposureResolver()` is presentation only.** Authorization concepts (canLoad, requiredCapabilities, authorize, forbidden) are forbidden from its source — enforced by source-contract test.
5. **`WorkspacePersonaProfile` (DB row keyed by `teamId`) is the canonical persona source.** Mutation is via `PATCH /v1/workspaces/:teamId/persona`. Frontend save must call `ctx.refresh()` immediately after.
6. **`useGlobalRuntimeState` is the canonical runtime severity source.** Display labels come from `RUNTIME_SEVERITY_LABELS`. No surface invents its own runtime status string.
7. **No client-side state library (React Query / SWR / Redux / Zustand) is used.** Adding one requires a CR-level decision because it would create a parallel cache that could disagree with the envelope.
8. **localStorage holds only `proovra-token`, `proovra-locale`, `proovra-locale-mode`.** Adding new state to localStorage requires explicit justification — the envelope is preferred.

---

## 10. Legacy / duplicate state paths to remove later

### 10.1 R9 (next stabilization) — dead-code removal

| Target | Action | Owner |
|---|---|---|
| `WorkspaceAdminPanel.tsx` `ShellNoWorkspace()` + `"no_workspace"` LoadState branch | Remove (unreachable) | R9 |
| `ReviewerCommandConsole.tsx` `ShellNoWorkspace()` + `"no_workspace"` LoadState branch | Remove (unreachable) | R9 |
| `GovernanceControlPlane.tsx` `ShellNoWorkspace()` + `"no_workspace"` LoadState branch | Remove (unreachable, replaced by CapabilityDegradedPanel) | R9 |

### 10.2 R2 — self-fetcher migration

| Target | Action |
|---|---|
| `apps/web/app/(app)/settings/page.tsx` self-fetch of `/v1/users/me` | Pair PATCH with `ctx.refresh()` instead |
| `apps/web/app/(app)/teams/[id]/page.tsx` self-fetch of `/v1/users/me` | Read `envelope.user.id` instead |

### 10.3 R-future — useTeamId → useWorkspaceId migration

| Target | Action |
|---|---|
| 28 surviving `useTeamId()` callsites | Migrate to `useWorkspaceId()` where the page can accept Personal workspace; leave team-only surfaces as-is |

### 10.4 R-future — capability/plan push channel

| Target | Action |
|---|---|
| Capability change requires manual reload to see | Add SSE or polling re-fetch on capability-relevant events |

---

## 11. Safe next phase recommendation

**Phase R9 — Dashboard/Surface dead-code cleanup + capability change push channel.**

Scope:
1. Remove the 3 dead `ShellNoWorkspace()` functions + `"no_workspace"` LoadState branches identified in §6.2. Pure deletion + test update.
2. Migrate the 2 R2-owned self-fetchers to envelope reads. Pair-with-refresh pattern.
3. Add a lightweight capability-change reactivation: a periodic envelope re-fetch (60 s default) when the tab is foregrounded, so admin-granted capabilities propagate without manual reload. Behind a feature flag, default off in dev, on in prod.

**Out of scope:**
- New auth subsystems (WebAuthn, SIEM, etc.)
- New navigation surfaces or hubs
- Backend permission model changes
- Capture / upload / finalize / custody / TSA / OTS / report / package logic

R9 is the appropriate closure point for the "operational coherence" track that CR1.5 opened.

---

## 12. Exact R1 / R1.5B / R2 / R3 fixes unlocked by this phase

This audit confirms the following R-phase deliverables are **complete and verified**:

- **R1 Bug A:** CommandCenter migrated off `useTeamWorkspaceGate()` → reads canonical `useActiveSpace()`. Topbar ↔ dashboard agreement restored. ✅ Pinned by `phase-cr1-5-state-observability` Test 9.
- **R1 Bug B:** Persona save calls `ctx.refresh()`. No more "Reload to see" copy. ✅ Pinned by Test 10 and Test 11.
- **R1 observability wiring:** `state-observability.ts` imported by `PlatformContextProvider`, `CommandCenter`, `settings/persona/page.tsx`. ✅ Pinned by Test 13.
- **R1.5B workspace segmentation:** `personalDemotionRules.ts` defines 7-route demotion set. ✅ Pinned by `phase-r1-5b-workspace-segmentation` tests.
- **R2 navigation IA recovery:** Canonical primary route ids bounded. ✅ Pinned by `phase-r2-navigation-ia-recovery` tests.
- **R3 dashboard orchestration:** Section ordering via `getPersonaSectionOrder`. ✅ Pinned by `phase-r3-dashboard-orchestration` tests.

What is NOT yet shipped (and where to find it):
- **R2 self-fetcher cleanup:** 3 documented allow-list entries; tracked in §7.3.
- **R9 dead-code cleanup:** 3 unreachable `ShellNoWorkspace()` functions; tracked in §6.2.
- **R-future capability push channel:** not yet designed.

---

## Hard confirmations

- ✅ No redesign performed.
- ✅ No broad refactor performed.
- ✅ No new product features added.
- ✅ No capture / upload / finalize / custody / TSA / OTS / report / package logic touched.
- ✅ No auth / security expansion performed.
- ✅ No backend permission semantics changed.
- ✅ No fake state fixes introduced.
- ✅ Findings are evidence-backed from code (file:line precision throughout).
- ✅ Next phase (R9) is ready to act with surgical scope.

## Validation summary

Validation is performed in two halves — file-state contract tests (which catch the dead-code / drift items pinned here) ride on top of the existing `phase-cr1-5-state-observability.test.ts` suite, plus a new `phase-cr1-5b-product-state-reaudit.test.ts` suite with the additional CR1.5 (re-audit) assertions.

See §10 for the canonical contract assertions added by this re-audit.

---

## CR1.6 follow-up status (2026-05-25)

CR1.6 — Surgical State Cleanup — landed the bounded follow-ups identified above. Full detail: `docs/product/CR1_6_SURGICAL_STATE_CLEANUP.md`.

### Resolved by CR1.6

| Item (CR1.5 reference) | Resolution |
|---|---|
| §6.2 — Three dead `ShellNoWorkspace()` functions + `"no_workspace"` LoadState branches | **Removed** from `WorkspaceAdminPanel`, `ReviewerCommandConsole`, `GovernanceControlPlane`. CR1.5B Test 2 flipped to assert removal; CR1.5B Test 13 updated to expect exactly 1 file containing the "No workspace selected" string (the live `WorkspaceGateState.tsx`). |
| §7.3 — `teams/[id]/page.tsx` self-fetches `/v1/users/me` | **Migrated** to `envelope.user.id`. Removed from the CR1.5 self-fetch allow-list. New CR1.6 Test 3 pins the migration. |
| §10.4 — No push channel for admin-granted capability changes (required manual reload) | **Opt-in focus-refresh** added inside `PlatformContextProvider`, gated by `NEXT_PUBLIC_PLATFORM_CONTEXT_FOCUS_REFRESH_ENABLED`, throttled to 60 s, SSR-safe, concurrency-guarded. Default OFF. CR1.6 Test 5 pins the behavior. |

### Still open

| Item | Status |
|---|---|
| `providers.tsx` `/v1/users/me` bootstrap fetch | Intentionally retained — runs before `PlatformContextProvider` mounts; rearchitecting auth bootstrap is out of CR1.6 scope. R-future. |
| `settings/page.tsx` PATCH `/v1/users/me` | Intentionally retained on the allow-list with a refined reason: PATCH-only, paired with `ctx.refresh()`; **not** a stale-read self-fetch. CR1.6 Test 4 enforces the PATCH-only invariant. |
| ~28 surviving `useTeamId()` callsites | Out of scope. R2 / R-future. |
| Focus-refresh staged rollout (flag → staging → prod) | Owner: ops. CR1.6 ships the helper; rollout is operational. |

### Deferred intentionally

| Item | Reason for deferral |
|---|---|
| Real SSE / WebSocket push channel for capability/plan changes | Focus-refresh is the safe MVP. A push channel adds operational complexity (auth, reconnect, backpressure) that is unjustified until focus-refresh data shows the gap. |
| Logout synchronous provider teardown | Sub-second stale-envelope window. R-future. |
| Dashboard redesign / nav redesign | Hard rule (CR1.5 / CR1.6 absolute rules). Not in scope. |
| New auth subsystems (WebAuthn, SIEM, IAM rework) | Hard rule. Not in scope. |

### Net result

The platform-state layer post-CR1.6 carries **zero known dead-code branches** and **two documented self-fetchers** (down from three). The focus-refresh hook closes the user-visible "manual reload required" gap when enabled. The platform is ready for **Phase 32.7 — Final Production Stabilization**.
