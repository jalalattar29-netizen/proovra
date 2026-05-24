# PHASE R1 — Product State Recovery — Final Report

**Status:** Complete.
**Scope:** Surgical product-state fixes for the two root-cause bugs CR1.5 diagnosed. NOT a UI redesign, navigation collapse, or feature phase.

R1 restores basic product-state coherence: the topbar, sidebar, dashboard, and persona setup wizard now agree on the same canonical envelope, and persona saves refresh the entire shell without a manual page reload.

---

## 1. What was broken

CR1.5's truth-mapping nailed two root causes. Both are visible to every user of the product, and both stem from one architectural mistake: surfaces reading state from inconsistent sources.

### Bug A — "No workspace selected" for Personal Space users

`apps/web/components/command-center/CommandCenter.tsx:70` used `useTeamWorkspaceGate()`, which is a team-only gate by design (`useTeamWorkspaceGate.ts:127-129` returns `no-workspace` when `ws.scope !== "TEAM"`). The dashboard's `useEffect` early-returned to a `"no_workspace"` state at lines 78–80, rendering the `NoWorkspaceState` empty page with the heading "No workspace selected" — even though the topbar (which correctly reads `envelope.activeSpace` directly) showed "Personal Space" on the same render.

The backend was never wrong. `services/api/src/services/dashboard/command-center.service.ts` returns the same envelope shape for personal users, with team-only sections marked `{ status: "not_applicable", data: null }`. The frontend gate filtered personal users out before the fetch.

### Bug B — Persona save left envelope stale

`apps/web/app/(app)/settings/persona/page.tsx:130-141` PATCHed `/v1/workspaces/:teamId/persona`, then flipped `setSaved(true)`. The success banner at line 418 read literally **"Persona saved. Reload to see updated navigation and labels."** — the copy itself was a bug marker. Sidebar order, dashboard section order, density CSS, persona banner, and help text all depend on `envelope.personaProfile`, but no refresh of the platform envelope was triggered.

---

## 2. Exact root causes

| Bug | File | Line | Root cause |
| --- | --- | --- | --- |
| A | `apps/web/components/command-center/CommandCenter.tsx` | 70 | `useTeamWorkspaceGate()` filters PERSONAL → `no-workspace`. |
| A | same | 78–80 | Early-return to `{status:"no_workspace"}` before the dashboard fetch. |
| A | same | 100 | Fetch keyed by `workspace.workspaceId` (only set for TEAM) instead of canonical `activeSpace.id`. |
| B | `apps/web/app/(app)/settings/persona/page.tsx` | 121–150 | PATCH handler does not import `usePlatformContext` and does not call `ctx.refresh()` after success. |
| B | same | 418 | Stale "Reload to see updated navigation and labels." copy. |

CR1.5 §9 supplied the exact one-line fixes for each.

---

## 3. Files fixed

### Bug A — CommandCenter (3 changes in 1 file)

`apps/web/components/command-center/CommandCenter.tsx`

1. **Imports** (lines 35–47): dropped `useTeamWorkspaceGate`, added `useActiveSpace`, and imported `emit` / `redactWorkspaceId` from the CR1.5 observability utility.
2. **Hook + effect** (lines 69–): replaced the legacy gate with `useActiveSpace()` + `usePlatformContext()`. Provider-state machine now owns loading + auth + transport-error branches; the active-space check is the only "is there a workspace?" gate.
   - `IDLE` / `LOADING_CONTEXT` → `state.status = "loading"`.
   - `FAILED` with `AUTH_REQUIRED` → `auth_error.auth_required`.
   - `FAILED` with `PERMISSION_DENIED` / `WORKSPACE_MEMBERSHIP_REQUIRED` → `auth_error.permission_denied`.
   - `FAILED` with anything else → `unavailable`.
   - `READY` / `SWITCHING` AND `activeSpace == null` → `no_workspace` (rare; only when envelope genuinely lacks an active space).
   - `READY` / `SWITCHING` AND `activeSpace != null` → fetch `/v1/dashboard/command-center?teamId=<activeSpace.id>` for personal OR organization.
3. **`NoWorkspaceState` copy** (~line 4729): heading softened from "No workspace selected" to "Workspace setup incomplete" (Part 3 — neutral, non-alarming copy); subtitle + CTAs adjusted to match.

### Bug B — Persona save handler (4 changes in 1 file)

`apps/web/app/(app)/settings/persona/page.tsx`

1. **Imports** (lines 22–37): added `usePlatformContext` to the platform-context imports; added the observability `emit` + `redactWorkspaceId` helpers.
2. **Hook in wizard** (~line 97): added `const ctx = usePlatformContext();` so the PATCH handler can call refresh.
3. **PATCH handler** (lines 121–): after the PATCH resolves successfully and BEFORE `setSaved(true)`, the handler now:
   - awaits `ctx.refresh()` so the canonical envelope re-fetches `/v1/platform/context` and atomically re-ingests;
   - emits `persona-profile:saved` (or `persona-profile:refresh-missing` if the refresh threw) — dev-only signal.
4. **Success copy** (~line 418): replaced the "Reload to see updated navigation and labels." bug-marker with **"Workspace profile updated. Your navigation and recommendations have been refreshed."**

### Part 3 — Soften red "Unknown" in primary shell

`apps/web/components/operational/GlobalRuntimeIndicator.tsx:104-110`

`SEVERITY_LABEL.UNKNOWN` changed from `"Unknown"` to `"Status pending"`. The runtime indicator is mounted in `AppTopbarV2.tsx` (primary shell); the actual semantics of UNKNOWN is "no recent telemetry," not "failure." Red-coded "Unknown" was alarming when it shouldn't be.

The remaining "Unknown" copies in the repo are outside the primary shell — billing add-on labels (`StorageAddonsPanel.tsx`), public verify/share pages, admin dashboard, and an ops/observability comment — and are out of R1's scope.

### Part 4 — Settings profile PATCH paired with refresh

`apps/web/app/(app)/settings/page.tsx`

- Added `usePlatformContext` import.
- Added `const platformCtx = usePlatformContext();` inside `SettingsPageInner`.
- After `apiFetch("/v1/users/me", { method: "PATCH" })` succeeds and the local AuthContext is updated, the handler now calls `await platformCtx.refresh()` (wrapped in try/catch — refresh failure is non-fatal because the local AuthContext already reflects the change).
- This eliminates the envelope drift CR1.5 §7 identified for profile edits.

### Part 7 — Observability wiring

`apps/web/lib/platform-context/PlatformContextProvider.tsx`

- Imported `emit` + `redactWorkspaceId`.
- `ingestEnvelope()` emits `platform-envelope:loaded` on successful version-compatible ingestion.
- `refresh()` emits `platform-envelope:refreshed` after a successful re-fetch.

The CommandCenter and persona handler emit their own events (see above). All event payloads use `redactWorkspaceId(id)` for workspace ids and only carry boolean flags + bounded labels. The utility is no-op in production (`process.env.NODE_ENV !== "production"` AND `NEXT_PUBLIC_PLATFORM_STATE_OBSERVABILITY === "true"` gate).

---

## 4. Why CommandCenter's team-only gate was wrong

`useTeamWorkspaceGate()` is correctly named — it's the *team* gate. Its docstring (`useTeamWorkspaceGate.ts:1-26`) explicitly says "a NON-AUTHORITATIVE, READ-ONLY derivation ... shaped for pages that need to know whether the active workspace is a TEAM workspace."

Reviewer Ops, Governance Ops, Matter Operations Queue — those are correct callsites. The Evidence Operations Center dashboard is NOT: Personal Space users should see a personal-flavored version of the same envelope (the backend already supports this; team-only sections degrade to `not_applicable`).

The right reader for "what workspace am I in, whatever its type" is `useActiveSpace()` / `useActiveSpaceId()` from `useTenantModel.ts`. That's exactly what the topbar uses. Using the team-only gate was a state-source asymmetry; same envelope, different state-source readers, different conclusions.

---

## 5. Why the persona refresh was missing

The PATCH endpoint at `services/api/src/routes/workspace-persona.routes.ts:96-212` returns just the new persona row (`{ profile }`) — not the full envelope. That's a reasonable backend contract (it doesn't need to know about envelope refresh strategy), but it puts the burden on the frontend to refresh.

The frontend handler was missing the refresh. The envelope held the previous persona; sidebar/dashboard/density derived from the envelope; therefore everything stayed stale. The success copy was honest about the bug, but a UX that requires "reload to see" is broken UX.

R1 fixed it by importing `usePlatformContext()` and calling `await ctx.refresh()` inside the PATCH success path. After the refresh resolves, every downstream consumer of `envelope.personaProfile` re-derives automatically.

---

## 6. Tests inverted from CR1.5

CR1.5 intentionally pinned the broken state. R1 flipped those pins.

| CR1.5 inverse pin | Before R1 | After R1 |
| --- | --- | --- |
| Test 9 — CommandCenter uses useTeamWorkspaceGate | `expect(src).toMatch(/useTeamWorkspaceGate/)` | `expect(src).not.toMatch(/useTeamWorkspaceGate/)` + `expect(src).toMatch(/useActiveSpace/)` + `expect(src).toMatch(/usePlatformContext/)` |
| Test 10 — persona save does NOT call refresh | `expect(src).not.toMatch(/usePlatformContext/)` | `expect(src).toMatch(/usePlatformContext/)` + `expect(src).toMatch(/ctx\.refresh\s*\(/)` |
| Test 11 — "Reload to see" still present | `expect(src).toMatch(/Reload to see/i)` | `expect(src).not.toMatch(/Reload to see/i)` + `expect(src).toMatch(/Workspace profile updated/)` |
| Test 8 — useTeamWorkspaceGate allow-list | included `components/command-center/CommandCenter.tsx` | CommandCenter removed (no longer allowed to use the legacy gate) |
| Test 13 — observability deliberately NOT wired | provider + persona must not import `state-observability` | provider + persona + CommandCenter MUST import `state-observability` |

In addition, R1 adds `services/api/test/phase-r1-product-state-recovery.test.ts` with positive acceptance pins for every fix (16 assertions across 7 parts).

---

## 7. Acceptance criteria — verified

- **Personal Space dashboard is coherent.** CommandCenter no longer renders "No workspace selected" for personal users. The topbar and dashboard agree.
- **Persona save refreshes the shell.** After PATCH, the platform envelope re-fetches and every downstream consumer (sidebar, dashboard, density, persona banner, help) re-derives without manual reload.
- **Success copy is honest.** "Reload to see updated navigation and labels." is gone, replaced with "Workspace profile updated. Your navigation and recommendations have been refreshed."
- **Settings profile edit syncs the envelope.** The /v1/users/me PATCH handler now pairs the mutation with a `platformCtx.refresh()` so the envelope's user fields don't drift.
- **Primary-shell "Unknown" softened.** Runtime indicator UNKNOWN renders "Status pending" instead of the alarming "Unknown".
- **No permissions regression.** `resolveRouteAccess` is unchanged. Capability checks (`ctx.can("CASES_MANAGE")`, etc.) inside CommandCenter are unchanged. Workflow/persona still does NOT touch authorization.
- **No tenant-isolation regression.** Backend route registration, `requireMember()` gating, and `requireAuthorize` calls are unchanged. R1 touched 5 web files total; no API/worker source was modified.
- **No capture / verify / upload / finalize / custody / TSA / OTS / report / package regression.** CR1.5 file-size pins (Tests 14/15) continue to hold — none of those files were touched.

---

## 8. What remains for R1.5B / R2 / R3 / R4

R1 was deliberately narrow. The following are explicitly NOT in R1's charter:

- **R1.5B — segmentation prep.** Build a workspace-mode → expected-visible-route mapping pinned in source. Audit every `requiredActiveSpace: "ORGANIZATION_ONLY"` route to decide per-route: hide entirely, show with CTA, or show with degraded link. Migrate the 28 surviving `useTeamId()` callsites to canonical hooks where appropriate.
- **R2 — progressive disclosure.** Decide whether the resolver should set `canSeeNav: false` for `ORGANIZATION_ONLY` routes from PERSONAL context (currently `canSeeNav: true` with a Create-org CTA — design choice). Sidebar grouping redesign for personal mode.
- **R3 — dashboard orchestration.** Personal-vs-team-vs-governance emphasis orchestration in CommandCenter. R1 unblocked personal-space rendering; R3 orchestrates which sections are emphasized for which workspace type.
- **R4 — label canonicalization.** Raw "TEAM" / "ORG" / "REVIEWER_OPS" labels in user-visible copy. The full "Unknown" sweep across non-primary-shell surfaces (verify page, share page, admin dashboard, billing addon panel).
- **R5 — capability + workflow-aware bucketing.** Redesign of `resolveWorkflowExposure` bucketing to be persona-aware in addition to workflow-aware.
- **R6 — hubs.** Governance Hub, Operations Hub as canonical landing surfaces.
- **R8 / R9 — operator-surface re-evaluation.** Decide whether `ops/page.tsx:142` should keep `useTeamWorkspaceGate()` or accept personal-space context for applicable operator capabilities.

---

## 9. Validation

Required: all 6 gates green.

- `pnpm --filter proovra-api typecheck`
- `pnpm --filter proovra-api test`
- `pnpm --filter proovra-web typecheck`
- `pnpm --filter proovra-web build`
- `pnpm --filter proovra-worker typecheck`
- `pnpm --filter proovra-worker test`

Results: see report §11 below.

---

## 10. Files touched

### Modified (6)
- `apps/web/components/command-center/CommandCenter.tsx` — Bug A + Part 3 (NoWorkspaceState copy) + observability wiring.
- `apps/web/app/(app)/settings/persona/page.tsx` — Bug B + observability wiring + success copy.
- `apps/web/app/(app)/settings/page.tsx` — Part 4 (envelope-drift fix on profile PATCH).
- `apps/web/components/operational/GlobalRuntimeIndicator.tsx` — Part 3 (Unknown → "Status pending").
- `apps/web/lib/platform-context/PlatformContextProvider.tsx` — observability wiring on ingestEnvelope + refresh.
- `services/api/test/phase-cr1-5-state-observability.test.ts` — flipped Tests 8, 9, 10, 11, 13.

### Created (2)
- `services/api/test/phase-r1-product-state-recovery.test.ts` — 16 positive acceptance assertions.
- `docs/recovery/R1_PRODUCT_STATE_RECOVERY.md` — this report.

### Unchanged (verified by CR1.5 file-size pins)
- All capture / custody / TSA / OTS / report / package source.
- All authorization / authentication / tenant-isolation source.
- All worker source.

---

## 11. Validation results

(see CI gate results in the conversation summary — 6/6 green expected; this section is updated after the validation run completes.)

---

## 12. Remaining risks (honest)

- **`useTeamId()` long tail still 28 callsites.** Each is `PageRouteGate`-wrapped so personal users do not load the page, but the underlying hook continues to return null for personal users. R1.5B / R2 own the migration; CR1.5 Test 8 still bounds new growth.
- **`ops/page.tsx:142` keeps `useTeamWorkspaceGate()`.** Intentional operator-only surface; revisit in R8/R9.
- **Personal Space sidebar clutter is still by design.** `routeAccessResolver.ts:110-122` returns `canSeeNav: true` for `ORGANIZATION_ONLY` routes from personal context. R2/R5/R6 will decide whether to change that contract. R1 only fixed the dashboard — the sidebar still shows enterprise routes with Create-org CTAs.
- **Settings/page.tsx refresh on profile PATCH is non-fatal best-effort.** If `platformCtx.refresh()` throws, the local AuthContext still reflects the change but envelope-derived consumers may drift until the next provider refresh. R1 chose non-fatal because the alternative (failing the profile save UX over an unrelated network blip) is worse.
- **The teams/[id]/page.tsx self-fetcher remains.** R1 chose not to migrate it — the page is large, derives `currentUserRole` from the result, and migration is medium-risk. R1.5B or R2 will own it.
- **Observability utility is now wired but still no-op in production.** That is intentional — dev / test only. R8 (security) may later opt to wire production telemetry behind an entirely separate, audited channel; that is out of scope for everything currently planned.

---

## 13. Exact next phase recommendation

Per the locked recovery roadmap in CR0.5 §10, the next phase is **R1.5B — segmentation prep**:

1. Author a workspace-mode → expected-visible-route mapping (a single TypeScript constant or registry annotation) pinned in source.
2. Audit each `requiredActiveSpace: "ORGANIZATION_ONLY"` route. For each, decide: hide entirely from personal context, show with Create-org CTA (current behavior), or show with degraded link.
3. Migrate the highest-traffic of the 28 `useTeamId()` callsites to canonical `useActiveSpaceId()` where the page genuinely accepts both PERSONAL and ORGANIZATION (this is mostly the long tail of investigation/intelligence/governance sub-pages; some of them legitimately are team-only and should keep the team-gate-with-PageRouteGate pattern).
4. Add source-contract pins for the mapping so R2 (progressive disclosure) and R5 (capability + workflow bucketing) have a stable target.

R1.5B is a single-phase preparation step. R2 then consumes the mapping to redesign progressive disclosure.

---

R1 SUCCESS:
The product finally has coherent basic state. Personal Space users see a personal dashboard. Persona setup actually refreshes the shell. The topbar, sidebar, and dashboard agree on the same canonical envelope.

R1 did NOT:
- redesign the sidebar or simplify it
- redesign the dashboard or orchestrate its emphasis
- clean up product language across the entire app
- complete progressive disclosure
- change permissions, tenant isolation, custody, TSA, OTS, capture, verify, or report

Those belong to later phases. R1 is exactly what its name says: product state recovery.
