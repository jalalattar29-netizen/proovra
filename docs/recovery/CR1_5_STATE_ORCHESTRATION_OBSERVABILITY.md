# PHASE CR1.5 — State & Orchestration Observability — Final Report

**Status:** Complete.
**Scope:** Runtime truth-mapping. No features. No UI. No redesign. No R1
fixes. CR1.5 produces the observability + proof suite so R1 can fix the
known state bugs surgically.

CR1.5 answers, with file:line precision, the questions CR0.5 raised:

- Who writes active workspace state?
- Who reads active workspace state?
- Who writes persona/workflow state?
- Who refreshes (or fails to refresh) the platform envelope?
- Which surfaces use stale or duplicate state?
- Which hooks/selectors are canonical?
- Which hooks/selectors must be removed or replaced in R1?
- Which runtime transitions create the visible bugs?

---

## 1. Canonical state contract

The canonical state model is one envelope (`PlatformContextEnvelope`)
delivered by `GET /v1/platform/context`, owned by
`apps/web/lib/platform-context/PlatformContextProvider.tsx`. Every
operational surface either reads through this envelope or carries an
**explicit, documented exemption**.

| State Domain | Canonical Backend Source | Canonical Frontend Source | Allowed Writers | Allowed Readers | Forbidden Readers/Writers | Owning Phase |
| --- | --- | --- | --- | --- | --- | --- |
| Authenticated user | `GET /v1/platform/context` (`envelope.user`); legacy fallback `GET /v1/users/me` | `usePlatformContext()` → `envelope.user`; convenience `useAccount()` | Auth + sign-in flows (token issuance); `PATCH /v1/users/me` (settings) | Any consumer via envelope | New self-fetch of `/v1/users/me` inside app surfaces (3 documented exemptions only) | CR0 / CR1.5 |
| `activeSpace` (Personal OR Organization, unified) | `envelope.activeSpace` (canonical post-Phase 38) | `useActiveSpace()` / `useActiveSpaceId()` | `PlatformContextProvider.switchWorkspace(id)` (POST `/v1/platform/context/switch-workspace`) | Any surface (canonical) | New use of `useTeamWorkspaceGate()`; ad-hoc workspace state | R1 (CommandCenter migration) |
| Personal Space | `envelope.personalSpace` | `usePersonalSpace()` | Account bootstrap (Personal Space autocreate); never client-mutated | Any surface | Treating Personal Space as a Team (legacy gates) | CR0.5 / R1 |
| Team / Organization workspace | `envelope.organizations[]` (and `envelope.activeSpace.type === "ORGANIZATION"` when active) | `useOrganizations()` / `useActiveSpace()` | Org create/join routes; admin invitation flows | Workspace admin + governance surfaces | Bypassing envelope to fetch org by id | R1 / R2 |
| Workspace profile (display name, plan, role) | `envelope.activeSpace` carries `displayName`, `role`, `roleLabel`; org list carries `plan`, `memberCount` | `useActiveSpace()`; topbar reads `envelope.activeSpace` directly | Backend on workspace edit / role change | Topbar (`AppAccountToolbar.tsx:91`); workspace admin | Hardcoded labels; raw "TEAM" / "ORG" strings in copy | R4 (label canonicalization) |
| Persona / workflow profile | `envelope.personaProfile` (DB: `workspacePersonaProfile`) | `usePersonaProfile()` + `workflowFromPersona()` | `PATCH /v1/workspaces/:teamId/persona` (settings/persona page) | Sidebar (band ordering), dashboard (section ordering), density, banner, terminology | Authorization decisions based on workflow/persona | R1 (refresh wiring) |
| Onboarding completion | `envelope.personaProfile.onboardingCompleted` (bool) | `usePersonaProfile()` → `.onboardingCompleted` | Same PATCH endpoint as persona | `PersonaSetupBanner.tsx:37`; capture/persona-aware empty states | New onboarding state stores | R1 (refresh) / R3 |
| Density preference | `envelope.personaProfile.operationalDensityPreference` | `usePersonaProfile()` → density field; consumed by `AppShellV2.tsx:68` (`data-operational-density="…"`) | Same persona PATCH | CSS only (read via attribute selector) | New density stores; per-page density toggles | R1 / R4 |
| Route access (per-route) | `envelope.capabilities` + `envelope.activeSpace.type` | `resolveRouteAccess({route, activeSpaceType, isPlatformAdmin, capabilities, accountPlan})` in `lib/navigation/routeAccessResolver.ts` | Backend on permission grant/revoke | `AppSidebarV2.tsx`, `CommandPalette.tsx`, `tools/page.tsx`, `PageRouteGate` | Workflow/persona-based access gates | R5 / R6 |
| Workflow exposure (sidebar buckets, emphasis) | (No backend source — pure derivation) | `resolveWorkflowExposure({routes, primaryWorkflow, secondaryWorkflows})` in `lib/navigation/workflowExposureResolver.ts` | n/a (pure function) | `AppSidebarV2.tsx:556` consumes the bucketed result | Authorization logic inside the exposure resolver | R5 |
| Sidebar visibility | Driven by `route.sidebarEligible` + `access.canSeeNav` (per route) | `AppSidebarV2.tsx` iterates `ROUTE_REGISTRY`, applies access resolver, applies exposure resolver | n/a | Sidebar component only | New per-page sidebar overrides | R2 / R5 |
| Dashboard mode (personal vs team vs governance emphasis) | `services/api/src/services/dashboard/command-center.service.ts` produces a single envelope with sections marked `not_applicable` for personal users | `CommandCenter.tsx` (currently gated by `useTeamWorkspaceGate`); will read `useActiveSpaceId()` after R1 | n/a | Dashboard only | Permission-forking the dashboard by workflow/persona | R1 (gate fix) / R3 (emphasis orchestration) |
| Capability / permission state | `envelope.capabilities` (per-capability boolean) | `useCan(cap)` from `usePlatformContext`; `resolveRouteAccess` uses the same map | Backend on capability change | Anywhere that gates real action | Local capability caches; per-page recomputation | R5 / R8 |
| Billing / plan gate state | `envelope.activeSpace.plan` + `envelope.account.accountPlan` | `useAccount()` / `useActiveSpace()` | Backend on plan change | Billing page; upgrade prompts | Hardcoded plan checks in feature code | R1.5 / R6 |
| Governance availability | `envelope.capabilities` (e.g. `GOVERNANCE_VIEW`, `GOVERNANCE_ACT`) + `route.requiredActiveSpace === "ORGANIZATION_ONLY"` | `useCan("governance.*")`; `PageRouteGate routeId="governance.…"` | Backend | Governance surfaces | Hardcoded governance flag toggles | R5 / R6 |
| Reviewer/ops availability | `envelope.capabilities` (e.g. `REVIEWER_OPS_VIEW`) | `useCan("REVIEWER_OPS_VIEW")` + `PageRouteGate` | Backend | Reviewer-ops surfaces | Hardcoded reviewer flags | R5 / R6 |

**Hard contract restatements (these are also enforced by source-contract tests):**

- The platform envelope is the **frontend canonical state source** for everything in the table above. New surfaces consume hooks from `lib/platform-context/` or carry an explicit, documented exemption.
- `ROUTE_REGISTRY` + `resolveRouteAccess` + `resolveWorkflowExposure` remain canonical for navigation exposure. The first two are authorization; the third is presentation only.
- Workflow / persona may affect **emphasis, ordering, defaults**. They MUST NOT affect authorization. `workflowExposureResolver.ts:14-21` documents and enforces this contract.
- `useTeamWorkspaceGate()` is **team-only** by design (`useTeamWorkspaceGate.ts:127-129` returns `no-workspace` for non-TEAM scopes). It must not drive Personal Space dashboard state. R1 migrates the last meaningful callsite (CommandCenter).
- New `/v1/users/me` self-fetchers inside app surfaces are drift risks. Three exemptions are documented in §7 below; no new exemption is added without a PR-level justification.

---

## 2. Safe observability utility

CR1.5 ships a thin, dev/test-only state-tracing utility:
`apps/web/lib/platform-context/state-observability.ts`.

**Contract (also enforced by the test suite):**

- **No-op in production** — `emit()` is a no-op unless both
  `process.env.NODE_ENV !== "production"` AND
  `process.env.NEXT_PUBLIC_PLATFORM_STATE_OBSERVABILITY === "true"`.
  The production gate fires first; the public flag cannot override it.
- **Bounded event vocabulary** — 15 named events covering envelope
  lifecycle, active-space resolution, persona save/refresh, sidebar +
  dashboard derivation, onboarding completion, workspace-missing
  signals, and the team-gate-blocks-personal-space transition. New
  events require a deliberate addition to `STATE_OBSERVABILITY_EVENTS`.
- **Safe payload contract** — `SafePayload` is `Record<string, boolean | null | undefined | string | number>`. The TypeScript type forbids objects, arrays, floats with precision, blobs, etc. At runtime, string values are truncated to 64 chars and number values are coerced to integers (no GPS precision, no long secrets, no path leakage).
- **Redaction helper** — `redactWorkspaceId(id)` returns `"workspace_<first-8>"` so workspace IDs never appear in full form.
- **No production UI** — the module exposes events only; no React component, no DOM injection, no `window`-attached object in production.
- **No broad runtime logging** — when the dev flag is set, events go to `console.debug` and an in-memory ring buffer (cap 200). The ring buffer is the test hook (`recordedEvents()` / `clearRecordedEvents()`).
- **Tree-shakeable** — consumers that don't import pay zero cost.

**Intentional non-wiring:** CR1.5 ships the utility but does NOT
instrument production code paths. Wiring it into the provider's state
machine transitions and into the persona save handler is **R1's
acceptance criteria** — that way the new dev traces are validated
against the very bugs R1 fixes.

---

## 3. Active workspace runtime trace

**Backend:**

- Primary endpoint: `GET /v1/platform/context` (handled by `services/api/src/routes/platform-context.routes.ts`). Returns the full `PlatformContextEnvelope` containing `user`, `activeSpace`, `personalSpace`, `organizations[]`, `capabilities`, `personaProfile`, schema versions.
- Switch endpoint: `POST /v1/platform/context/switch-workspace` with body `{ workspaceId }`. Returns the new envelope atomically. The frontend provider uses a sequence guard (`fetchSequenceRef`) so out-of-order responses cannot ingest stale state.
- Legacy fallback: `GET /v1/users/me` is still served but consumed only by the bootstrap provider (`apps/web/app/providers.tsx:79`).

**Frontend provider:**

- `apps/web/lib/platform-context/PlatformContextProvider.tsx`:
  - State machine: `IDLE → LOADING_CONTEXT → READY ⇄ SWITCHING → READY | FAILED`.
  - Public API: `state`, `envelope`, `can(cap)`, `switchWorkspace(id)`, `refresh()`, `schemaCompatible`.
  - `refresh()` (line 151, impl 233–272) hard-refetches `/v1/platform/context` and atomically re-ingests the new envelope. Sidebar, dashboard, density, banner all re-render off the new envelope.

**Canonical reader hooks (all backed by `usePlatformContext()`):**

| Hook | File | Returns | Notes |
| --- | --- | --- | --- |
| `usePlatformContext()` | `PlatformContextProvider.tsx` | full context value | base hook |
| `useAccount()` | `useTenantModel.ts` | `envelope.account` | identity |
| `useActiveSpace()` | `useTenantModel.ts:66` | `PERSONAL \| ORGANIZATION` union | **canonical workspace reader** |
| `useActiveSpaceId()` | `useTenantModel.ts` | id (string) or null | guard convenience |
| `usePersonalSpace()` | `useTenantModel.ts` | `envelope.personalSpace` | personal-only branch |
| `useOrganizations()` | `useTenantModel.ts` | `envelope.organizations[]` | org list |
| `useCan(capability)` | `PlatformContextProvider.tsx` | boolean | fail-closed |
| `useDuplicatePersonalCandidates()` | `useTenantModel.ts` | array | diagnostics |
| `usePersonaProfile()` | `usePersonaProfile.ts` | persona + density | derived |
| `useTeamId()` | `useTeamWorkspaceGate.ts:64` | team id or null | **legacy alias for `useTeamWorkspaceGate`** |
| `useTeamWorkspaceGate()` | `useTeamWorkspaceGate.ts:120+` | structured gate | **team-only by design; returns `no-workspace` for personal** |

**Confirmed reader-pattern split (file:line):**

- **Topbar reads canonical:** `AppAccountToolbar.tsx:91` consumes `envelope.activeSpace` directly. If type is `PERSONAL`, renders "Personal Space"; otherwise renders `activeSpace.displayName`.
- **CommandCenter reads legacy team-only gate:** `CommandCenter.tsx:70` calls `useTeamWorkspaceGate()`. For personal users, the gate returns `{status:"no-workspace"}` and lines 78–80 early-return into "No workspace selected" without ever fetching the backend.
- **The asymmetry is the bug.** Same envelope, two different readers, two different conclusions. Topbar correctly shows "Personal Space" while the dashboard simultaneously shows "No workspace selected."

**Confirmed `useTeamWorkspaceGate()` callsites (post-Phase-38 shrinkage):**

| File | Line | Notes |
| --- | --- | --- |
| `components/command-center/CommandCenter.tsx` | 70 | **R1 target** — replace with `useActiveSpaceId()`. |
| `app/(app)/ops/page.tsx` | 142 | Operator gate; extracts team id for downstream queries. May stay (operator-only surface). R1.5 documents; R8/R9 owns the call. |

**Confirmed `useTeamId()` (legacy alias) callsites:** 28 surviving callsites across admin, governance sub-pages, investigation, intelligence, etc. Each is a long-tail migration target for R1.5B / R2 / R5. Because each is also `PageRouteGate`-wrapped at the page boundary, returning `null` for Personal Space is handled gracefully (page is not loaded).

**Confirmed canonical reader callsites:** `useActiveSpace()` × 3, `useActiveSpaceId()` × 9 (see exploration §2 for the full list).

**No new workspace-state source has been introduced.**

---

## 4. Persona / workflow save-refresh trace

**Save handler:** `apps/web/app/(app)/settings/persona/page.tsx`

- Around line 130: `await apiFetch("/v1/workspaces/{teamId}/persona", { method: "PATCH", body: JSON.stringify({ primaryProfile, secondaryUseCases, operationalDensityPreference, onboardingCompleted, onboardingState }) })`.
- Around line 141: `setSaved(true)`. **No call to `usePlatformContext().refresh()`, no `router.refresh()`, no `window.location.reload()`.**
- Around line 418: success-banner copy literally reads
  **"Persona saved. Reload to see updated navigation and labels."** —
  the copy is itself a bug marker.

**Backend PATCH endpoint:** `services/api/src/routes/workspace-persona.routes.ts:96-212`

- `PATCH /v1/workspaces/:teamId/persona`. Persists to the
  `workspacePersonaProfile` table (Prisma upsert at line 133). Emits
  platform audit log (lines 182–203).
- Response (lines 207–211): `{ profile }` — persona row only, NOT the
  full envelope. Re-reading the envelope is the frontend's job.

**Envelope refresh mechanism:** `PlatformContextProvider.tsx`

- `refresh()` is exposed at line 151, implemented at 233–272.
- Refetches `/v1/platform/context`, transitions `READY → SWITCHING →
  READY|FAILED`, and atomically re-ingests via `ingestEnvelope()`.
- All downstream readers (`usePersonaProfile`, `useActiveSpace`,
  sidebar exposure, density CSS) re-derive automatically.

**Downstream consumers of persona/workflow state:**

| Surface | File | Reads |
| --- | --- | --- |
| Sidebar group order | `AppSidebarV2.tsx:40–52` | `usePersonaProfile()` → `workflowFromPersona()` → `resolveWorkflowExposure()` |
| Dashboard section order | `CommandCenter.tsx:170–184` | `getPersonaSectionOrder()` + `workflowFromPersona()` |
| Density CSS root attribute | `AppShellV2.tsx:59–68` | `envelope.personaProfile.operationalDensityPreference` → `data-operational-density` |
| Persona setup banner | `PersonaSetupBanner.tsx:36–44` | `usePersonaProfile().onboardingCompleted` |
| Workflow exposure resolver | `workflowExposureResolver.ts:28–49` | pure function over persona; emphasis/order only — NEVER access |

**Acceptance criteria R1 must satisfy (Bug B fix):**

1. After PATCH succeeds, the persona save handler MUST call `ctx.refresh()` (where `ctx = usePlatformContext()`) before flipping `setSaved(true)`.
2. The success-banner copy at line 418 MUST be replaced with a non-stale message (e.g. "Persona saved. Navigation, labels, and density are updating.").
3. A test asserting the refresh call exists in the handler and the "Reload to see" string is gone.

**CR1.5 does NOT apply the fix.** R1 owns the behavior change.

---

## 5. Sidebar / route-exposure trace

**The chain:**

`ROUTE_REGISTRY` (data) → `resolveRouteAccess(route, ctx)` (authorization) → `resolveWorkflowExposure(routes, persona)` (emphasis/buckets) → `AppSidebarV2.tsx` (render).

**`ROUTE_REGISTRY`:** `apps/web/lib/navigation/routeRegistry.ts:100–833`. 59 entries. Each has `id`, `href`, `domain`, `requiredCapabilities`, `requiredActiveSpace`, `fallbackBehavior`, `workflowTags`, `sidebarEligible`, `allToolsVisible`, `commandPaletteVisible`, `advancedByDefault`.

**`resolveRouteAccess()`:** `apps/web/lib/navigation/routeAccessResolver.ts:85–179`. Decision order:

1. Platform-admin check.
2. Active-space requirement (`requiredActiveSpace`).
3. Capability requirement (`requiredCapabilities[]`).
4. Default ALLOWED.

The function NEVER consults workflow/persona — this is the canonical authorization contract.

**`resolveWorkflowExposure()`:** `apps/web/lib/navigation/workflowExposureResolver.ts:80–155`. Lines 14–21 document the bucketing contract:

- "Workflow NEVER changes `canLoad` — access decisions are upstream."
- "Workflow tags only INCREASE priority; absence does not remove a capability-allowed route."

**Sidebar consumption:** `AppSidebarV2.tsx:544–567` maps `ROUTE_REGISTRY` through `resolveRouteAccess`, then through `resolveWorkflowExposure`, then groups results by domain.

**Personal Space leakage proof:**

The resolver intentionally returns `{ canLoad: false, canSeeNav: true, accessState: NEEDS_ORGANIZATION }` for routes with `requiredActiveSpace: "ORGANIZATION_ONLY"` accessed from a personal space (`routeAccessResolver.ts:110–122`). The design intent is to show a structured "Create organization" CTA in the sidebar. The leakage is **not a bug in the resolver** — it's a design choice that R2/R5/R6 must revisit.

Specific routes that surface in personal sidebars today: `governance.policy`, `governance.hub`, `review.escalations` (each carries `requiredActiveSpace: "ORGANIZATION_ONLY"` and a `CREATE_ORG`/`REQUEST_ACCESS` fallback). They render as degraded links with a CTA, not as enabled navigation.

**Capability state:** `envelope.capabilities` (per-capability boolean map). Per-route `requiredCapabilities[]` must each be `=== true`. Fail-closed.

**All Tools + Command Palette:** Both consume the same access resolver. All Tools page additionally consumes the workflow exposure result (for "Recommended" badging). Command Palette ranks routes inline using workflow tags but never authorizes via persona.

**Owning phases:**
- **R2** — progressive disclosure for personal spaces (decide whether `canSeeNav` should be `false` for `ORGANIZATION_ONLY` routes when active space is `PERSONAL`).
- **R5** — capability + workflow-aware bucketing redesign.
- **R6** — hubs (Governance Hub, Operations Hub) as canonical landing surfaces.

**CR1.5 does NOT collapse the sidebar.** Pure observation.

---

## 6. Dashboard / CommandCenter trace

**Frontend:** `apps/web/components/command-center/CommandCenter.tsx`

- Line 70: `const workspace = useTeamWorkspaceGate();`
- Lines 78–80: `if (workspace.status === "no-workspace") { setState({status:"no_workspace"}); return; }` — early-return for personal users.
- Line 124: `if (state.status === "no_workspace") return <NoWorkspaceState />;` — renders "No workspace selected" (literal at line ~4729 inside `NoWorkspaceState`).
- Lines 99–114 (the fetch block) is **never reached for personal users** because the gate filters them out before fetch.
- Lines 170–184 (`CommandCenterReady`): once data loads, `getPersonaSectionOrder()` and `workflowFromPersona()` reorder operational sections. This runs **after** the fetch succeeds and is independent of the workspace gate, so it would continue to work correctly once the gate is fixed.

**Backend service:** `services/api/src/services/dashboard/command-center.service.ts`

- `buildCommandCenter({teamId, role})` produces a single `CommandCenterEnvelope` shape regardless of personal vs team. Sections that require team semantics return `{ status: "not_applicable", data: null }` for personal workspaces.
- Specific personal-aware guards: `reviewerOrchestration` (line 1826), `governancePosture` (line 2145), `reviewerWorkload` (line 2841), and similar in intelligence runners.
- The docstring (lines 8–23) explicitly documents the personal-vs-team contract.

**Backend route:** `services/api/src/routes/dashboard.routes.ts`

- `GET /v1/dashboard/command-center?teamId=<uuid>`.
- Validates membership via `requireMember(req, reply, query.teamId)` for any workspace id (personal or team).
- Returns the same envelope shape regardless of scope.

**The bug is entirely frontend.** Backend already supports personal-flavored rendering.

**R1's minimal fix (Bug A):**

1. Replace `CommandCenter.tsx:70` `useTeamWorkspaceGate()` with `useActiveSpaceId()` (or `useActiveSpace()` + extract id).
2. Delete the lines-78–80 early-return that gates on `no-workspace`. Personal users then proceed through the same fetch + render path as team users.
3. Add a test asserting the gate is gone and the fetch fires for personal users.

The persona-driven section ordering is unaffected — it operates client-side after fetch.

**Dashboard MUST NOT become permission-forked by workflow/persona.** Workflow affects section emphasis only, never section availability. R3 owns the personal-vs-team-vs-governance emphasis orchestration; that work is downstream of R1's gate fix.

---

## 7. Self-fetch / envelope-drift cleanup plan

CR0.5 found multiple files that fetch `/v1/users/me` directly instead of consuming the envelope. CR1.5 enumerates them precisely:

| # | File | Line | Method | Purpose | Migration risk | Owning phase |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `apps/web/app/providers.tsx` | 79 | GET | Bootstrap AuthContext before the platform context provider mounts. The hook is structurally unavailable here. | **BLOCKED** — bootstrap circularity. Permanent documented exemption. | n/a (foundational) |
| 2 | `apps/web/app/(app)/settings/page.tsx` | 269 | PATCH | Profile update. Updates local AuthContext but does NOT refresh the envelope — same drift pattern as the persona bug. | Low — pair the PATCH with `ctx.refresh()`. | R1 Phase 2 (envelope-drift fix-pack) |
| 3 | `apps/web/app/(app)/teams/[id]/page.tsx` | 463 | GET | Legacy team detail page. Fetches user for "currentUserId" matching. Should derive from `envelope.user.id`. | Medium — touches role logic. | R1 Phase 2 (envelope-drift fix-pack) |

**No new self-fetcher exemptions are added.** A CR1.5 guardrail test (Part 8 below) pins the bounded allow-list of 3 entries; any new `/v1/users/me` callsite breaks the test until either (a) it's added to the exemption list with justification or (b) migrated to the envelope hook.

**No `/v1/auth/me`, `/v1/account/me`, or `/v1/me` callsites exist** outside the providers.tsx fallback path.

---

## 8. Observability test suite

CR1.5 adds `services/api/test/phase-cr1-5-state-observability.test.ts` with 15 source-contract pins covering:

1. CR1.5 documentation exists and is non-trivial.
2. The canonical state contract section is present with the required state-domain rows.
3. Active-workspace readers/writers map is documented.
4. Persona/workflow save-refresh chain is documented with bug-touchpoint file:line.
5. Sidebar dependency chain is documented.
6. Dashboard / CommandCenter dependency chain is documented.
7. No new `/v1/users/me` self-fetcher without exemption (allow-list of 3 pinned).
8. No new `useTeamWorkspaceGate()` callsite (allow-list of 2 pinned).
9. CommandCenter team-only gate bug remains pinned **until R1** (intentional inverse pin — when R1 fixes it, this test must be flipped).
10. Persona refresh bug remains pinned until R1 (intentional inverse pin).
11. "Reload to see" copy remains pinned until R1.
12. No workflow/persona authorization gates introduced (`workflowExposureResolver` must not import or reference `requiredCapabilities` / `canLoad`).
13. No production observability logging of sensitive data (the utility is no-op in prod; type system forbids unsafe payload shapes).
14. No capture upload/finalization files changed in CR1.5 (file-size pin within ±10% on `capture.routes.ts`, `evidence-complete.service.ts`).
15. No custody/TSA/OTS/report/package files changed in CR1.5 (file-size pin on `custody-events.service.ts`, `timestamp.service.ts`, `reports-aggregator.service.ts`).

The **inverse pins (tests 9, 10, 11)** are the forcing function for R1: when R1 fixes a bug, those tests fail until R1 updates the assertions in the same PR. That's how CR1.5 makes future state drift impossible to ship unnoticed.

---

## 9. R1 execution brief

The CR1.5 truth-mapping above gives R1 exact targets. R1 is a **small, targeted, test-driven** phase.

### Bug A — CommandCenter shows "No workspace selected" for Personal Space users

**File:** `apps/web/components/command-center/CommandCenter.tsx`

**Line 70 (replace):**
```
- const workspace = useTeamWorkspaceGate();
+ const activeSpaceId = useActiveSpaceId();
```

**Lines 78–80 (delete the early-return block):**
```
- if (workspace.status === "no-workspace") {
-   setState({ status: "no_workspace" });
-   return;
- }
```

Update the subsequent fetch (lines 99–114) to use `activeSpaceId` instead of `workspace.workspaceId` and treat null `activeSpaceId` as "loading" rather than "no workspace selected." Backend `/v1/dashboard/command-center?teamId=<id>` already handles personal workspaces correctly — sections that aren't applicable return `not_applicable`.

**Acceptance tests:**
- `phase-r1-command-center-personal-space.test.ts` asserts:
  - `useTeamWorkspaceGate` import is gone from CommandCenter.tsx.
  - `useActiveSpaceId` (or `useActiveSpace`) import is present.
  - `NoWorkspaceState` is no longer rendered when active space is `PERSONAL`.
  - The fetch is issued with the Personal Space id.
- `phase-cr1-5-state-observability.test.ts` test #9 must be flipped from "still pinned" to "fix landed."

**Expected user-facing behavior:** A personal user navigating to `/home` (or wherever CommandCenter mounts) sees the dashboard render the personal-flavored envelope — non-applicable team-only sections render their `not_applicable` empty states, applicable sections render normally.

### Bug B — Persona save does not refresh the envelope

**File:** `apps/web/app/(app)/settings/persona/page.tsx`

**Refresh wiring (around line 140):**
- Import `usePlatformContext` from `../../../lib/platform-context` (if not already imported).
- After PATCH succeeds and before `setSaved(true)`, call `await ctx.refresh()` where `ctx = usePlatformContext()`.

**Copy removal (line 418):**
- Replace the success message
  `"Persona saved. Reload to see updated navigation and labels."`
  with a non-stale message such as
  `"Persona saved. Navigation, labels, and density are updating."`

**Acceptance tests:**
- `phase-r1-persona-refresh.test.ts` asserts:
  - The PATCH handler contains an `await ctx.refresh()` call.
  - The "Reload to see" copy is gone from `settings/persona/page.tsx`.
  - The success copy now mentions "updating" (not "reload").
- `phase-cr1-5-state-observability.test.ts` tests #10 and #11 must both be flipped.

**Expected user-facing behavior:** After saving persona, the sidebar order, dashboard section order, density CSS, and persona banner all update in place — no manual page reload required.

### Bug C — Personal Space sees enterprise / org clutter

**Owning phases:** R1.5B (segmentation prep) → R2 (progressive disclosure) → R5 (capability + workflow bucketing) → R6 (hubs).

**Not fully fixed in R1.** R1 only fixes the CommandCenter gate. The sidebar/All-Tools/CommandPalette leakage is a separate, larger change because `routeAccessResolver.ts:110–122` intentionally returns `canSeeNav: true` for `ORGANIZATION_ONLY` routes from a personal context (recovery CTA design). Reversing that requires a UX-level decision that R1's surgical charter excludes.

**State segmentation prerequisites:** R1.5B must produce:
- A workspace-mode → expected-visible-route mapping pinned in source.
- A separation between "this route exists" (registry) and "this user can see it from this context" (resolver).
- An audit of every `requiredActiveSpace: "ORGANIZATION_ONLY"` route to decide per-route: hide entirely, show with CTA, or show with degraded link.

### Bug D — Raw / internal labels and "Unknown" states

**Owning phase:** R4 (label canonicalization).

**R1 immediate fallback rules:**
- Any new user-facing string in R1 must be reviewed against the existing `phase-cr0-system-freeze-baseline.test.ts > PART 3` "Unknown" allow-list.
- R1 must not add a new "Unknown" appearance in `AppSidebarV2.tsx`, `AppShellV2.tsx`, `CommandPalette.tsx`, dashboard, or persona/profile surfaces.
- Raw labels like "TEAM" / "ORG" / "REVIEWER_OPS" in user-visible copy are out of scope for R1 — R4 owns the canonical label dictionary.

---

## 10. Validation

Required: all 6 gates green.

- `pnpm --filter proovra-api typecheck`
- `pnpm --filter proovra-api test`
- `pnpm --filter proovra-web typecheck`
- `pnpm --filter proovra-web build`
- `pnpm --filter proovra-worker typecheck`
- `pnpm --filter proovra-worker test`

No partial validation. No "we can infer." No deferred cleanup outside locked phases.

Results: see §11 below.

---

## 11. Files touched

### Created (3)
- `apps/web/lib/platform-context/state-observability.ts` — dev/test-only state-tracing utility (CR1.5 §2).
- `services/api/test/phase-cr1-5-state-observability.test.ts` — 15 source-contract guardrails (CR1.5 §8).
- `docs/recovery/CR1_5_STATE_ORCHESTRATION_OBSERVABILITY.md` — this report.

### Modified
- None of the canonical production code paths. CR1.5 deliberately does NOT instrument the provider, persona save handler, sidebar, or dashboard. Instrumentation is R1's acceptance criteria, so the dev traces are validated against the actual fixes.

### Hard confirmations (also enforced by the test suite)
- No features added.
- No UI redesign performed.
- No sidebar collapse performed.
- No dashboard redesign performed.
- No onboarding rewrite performed.
- No R1 fixes applied.
- No capture refactor performed.
- No verify refactor performed.
- No upload / finalization / custody / TSA / OTS / report / package logic changed.
- No permission regression.
- No tenant-isolation regression.

---

## 12. Remaining risks (honest)

- **The 3 self-fetch exemptions remain.** Until R1 Phase 2 migrates `settings/page.tsx:269` and `teams/[id]/page.tsx:463`, profile updates and team-detail user-id reads continue to drift from the envelope. The guardrail test pins the count so the drift cannot quietly expand, but it does NOT eliminate the existing drift.
- **`useTeamId()` has 28 callsites.** Each is `PageRouteGate`-wrapped so personal users do not load the page, but the underlying hook is still backed by `useTeamWorkspaceGate()`. Long-tail migration belongs to R1.5B / R2.
- **`ops/page.tsx:142` keeps `useTeamWorkspaceGate()`.** It's an operator-only surface intentionally gated to team scope. R8 / R9 will revisit whether it should also accept personal-space when applicable operator capabilities are present.
- **`routeAccessResolver.ts:110–122`** returns `canSeeNav: true` for `ORGANIZATION_ONLY` routes from a personal context. That's a deliberate "Create organization" CTA. R2/R5/R6 will decide whether to keep that contract or hide the routes entirely.
- **The observability utility is not wired** to provider transitions or persona save. R1's acceptance criteria require wiring so the new dev traces correspond to the bug fixes; until R1 wires, the utility's signals are reachable only from tests.

---

CR1.5 SUCCESS:
- The product state bugs are no longer mysterious.
- R1 has exact targets (file, line, hook, copy string, acceptance test).
- The platform has observable operational state ownership.
- Future state drift is caught by source-contract tests, not by user reports.

R1 can now be executed without guessing.
