# PROOVRA Phase 4 — Navigation, Persona & Onboarding Readiness

> **Status:** READY ▸ pending board approval of the Phase 4 charter.
> **Author:** Architecture (Phase 3 closure).
> **Date:** 2026-06-01.
> **Predecessors:** Phase 2 (architecture guardrails),
>   Phase 3 (runtime model alignment).
> **Supersedes nothing.**

This document is the bridge from the **Phase 3 closure state** to a
safe, additive **Phase 4** that consolidates the navigation surface,
the persona projection, and the onboarding/upgrade flow on top of the
canonical Phase 3 helpers — *without* breaking the constitutional
target operating model (TOM).

The Phase 3 prompt's non-negotiables remain in force in Phase 4:

1. `Team` must remain available to normal users.
2. `Team` must NOT require `Organization`.
3. `Team` must NOT become `Workspace`.
4. `Team` must NOT become Enterprise-only.
5. `Organization` must remain optional.
6. Personal users must remain fully supported.
7. No new workspace kind may be introduced.
8. No new architecture layer may be introduced.
9. No new product feature may be added.
10. No schema-level migration unless explicitly required and approved.
11. No production data mutation.
12. No global rename of `teamId`.
13. No SSO/SCIM migration.
14. No Evidence/Case ownership migration.
15. No `Team` UI build.
16. No sidebar redesign.

Phase 4 inherits all 16 and treats them as the floor.

---

## 1. What Phase 3 delivered

Phase 3 hardened the runtime model into a single canonical alignment
spine without changing user-visible behaviour. Every Phase 3
deliverable is pinned by the Phase R12 source-contract test
(`services/api/test/phase-r12-runtime-alignment.test.ts`, 33 tests
green).

| Stage | Deliverable                                                                       | File(s)                                                                                                                                                                                |
|-------|-----------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 2     | Canonical FE workspace-id hook (`useActiveWorkspaceId`)                           | `apps/web/lib/platform-context/useTeamWorkspaceGate.ts`, `apps/web/lib/platform-context/useTenantModel.ts`                                                                              |
| 3     | Canonical `DenialReason` + 3 mappers (`AccessState` / `AccessGateKind` / `AuthorizationDenialCode`) | `packages/shared/src/architecture/denial-vocabulary.ts`                                                                                                                                |
| 4     | Canonical 8-persona TOM projection (`projectTomPersona`)                          | `packages/shared/src/architecture/canonical-persona.ts`                                                                                                                                |
| 5     | `WorkspaceScope` inline duplicates marked `@deprecated`                           | `apps/web/components/workspace-admin/types.ts`, `apps/web/components/command-center/types.ts`, `services/api/src/services/workspace-admin/workspace-admin.service.ts`, `services/api/src/services/dashboard/command-center.service.ts`, `services/api/src/services/dashboard/persona-resolver.service.ts` |
| 6     | Dead `PERSONAL_*` + `ORG_*` capability keys marked `@deprecated`                  | `apps/web/lib/platform-context/types.ts`, `services/api/src/services/platform-context/types.ts`, `services/api/src/services/platform-context/capability-registry.ts`                  |
| 7     | Backend canonical workspace resolver + denial bridge                              | `services/api/src/services/access/canonical-workspace-resolver.ts`                                                                                                                     |
| 8     | Phase R12 source-contract test (33 tests)                                         | `services/api/test/phase-r12-runtime-alignment.test.ts`                                                                                                                                |

The Phase 3 work was deliberately **additive**:

- No existing hook was removed.
- No existing denial vocabulary was rewritten.
- No existing persona system was deleted.
- No capability grant was removed.
- No route handler was refactored.

Every legacy surface continues to operate exactly as before. The new
canonical helpers exist alongside them, ready to absorb new code.

---

## 2. What Phase 4 should consolidate

The Phase 1 audit identified four user-visible drift areas that
**Phase 4** can now close without violating the non-negotiables, because
Phase 3 has installed the canonical helpers they need.

### 2.1 Navigation surface consolidation

Today the sidebar / topbar consume three of the four persona
projection systems, two of the three denial vocabularies, and four of
the workspace-id hooks. Phase 4 should:

- Migrate `apps/web/components/app-shell-v2/AppSidebarV2.tsx`,
  `AppTopbarV2.tsx`, `WorkspaceSwitcher`, and the
  `CommandPalette` to consume **only** the Phase 3 canonical
  symbols (`useActiveWorkspaceId`, `projectTomPersona`,
  `denialReasonHeadline`).
- Leave the legacy hooks/vocabularies in place — they are still
  used by team-only surfaces (Reviewer Ops, Governance,
  Recovery) that are NOT being migrated in Phase 4.
- Validate via a single Phase R13 source-contract test that the
  navigation shell does not import a deprecated hook.

**Estimated reach:** ~12 components, ~700 LoC.
**Risk:** LOW — every import target already exists; tests pin the
behaviour.

### 2.2 Onboarding & upgrade flow

The Personal-first bootstrap (R9) and the PRO entitlement (R10)
landed; the onboarding flow still hard-codes copy and CTAs for a
single "team" persona. Phase 4 should:

- Replace hard-coded onboarding strings in
  `apps/web/components/onboarding/*` with TOM persona-aware copy
  driven by `projectTomPersona`.
- Replace hard-coded upgrade CTAs ("upgrade to Team") with
  `denialReasonHeadline("UPGRADE_REQUIRED")` /
  `denialReasonGuidance(...)`.
- Wire the persona-selection step to `WORKSPACE_PERSONA_PROFILES`
  (existing Phase 38 surface) and emit the resulting profile back
  through the existing `/v1/workspace-persona` route — NO new
  schema, NO new feature.

**Estimated reach:** ~6 components, ~400 LoC.
**Risk:** LOW — pure copy + projection change; route already exists.

### 2.3 Denial-panel consolidation

`PageRouteGate` and `AccessGate` render visibly different copy for
what is, semantically, the same denial (e.g. `NEEDS_PERSONAL_OR_ORG`
vs `WORKSPACE_REQUIRED` both currently render "Activate in a
workspace…" but with different button labels and tone). Phase 4
should:

- Route all rendered copy through `denialReasonHeadline` /
  `denialReasonGuidance`.
- Keep the route resolver + gate component as separate code paths
  (they have different lifecycles) — only the copy is unified.
- Add a Phase R13 contract test that asserts the rendered copy for
  any of the three vocabulary inputs converges on one of the 11
  canonical `DenialReason` strings.

**Estimated reach:** 2 components, ~200 LoC.
**Risk:** LOW — pure render-layer change; no auth path moves.

### 2.4 Capability registry namespace cleanup

The dead `PERSONAL_*` + `ORG_*` keys remain granted but
`@deprecated`. Phase 4 (or, more likely, Phase 5) may choose to:

- Remove the dead keys from `CAPABILITY_KEYS` arrays.
- Remove the grants in `capability-registry.ts`.
- Update the R11 + R12 tests to remove the "still granted"
  assertions.

This requires a destructive change to the capability surface area,
so it is **deferred to a separate explicit phase**. Phase 4 should
NOT take it on.

---

## 3. What Phase 4 must NOT do

| ❌ Out of scope                                            | Why                                                              |
|-----------------------------------------------------------|------------------------------------------------------------------|
| Rename `teamId` to `workspaceId` in the database          | Constitutional rule 12.                                          |
| Migrate Evidence/Case ownership to a new `Workspace` row  | Constitutional rule 14.                                          |
| Introduce SSO/SCIM for non-Enterprise tiers               | Constitutional rule 13.                                          |
| Build a `Team` configuration UI (settings, members)       | Constitutional rule 15.                                          |
| Redesign the sidebar layout                               | Constitutional rule 16.                                          |
| Add a 9th TOM persona                                     | Constitutional rule 7.                                           |
| Remove dead capability keys                               | Stage 6 explicitly defers this to a later phase.                 |
| Delete any of the 4 legacy persona systems                | Phase 3 Stage 4 explicitly keeps them; Phase 4 inherits this.    |
| Rewrite `routeAccessResolver.ts` or `AccessGate.tsx`      | Phase 3 Stage 3 explicitly keeps both vocabularies authoritative. |

---

## 4. Phase 4 gating preconditions

Before Phase 4 may begin, the following MUST be true. As of
2026-06-01 every box is checked.

- [x] `pnpm --filter @proovra/shared build` clean.
- [x] `pnpm --filter proovra-api typecheck` clean.
- [x] `pnpm --filter proovra-web typecheck` clean.
- [x] `pnpm --filter proovra-web build` clean.
- [x] Phase R9 source-contract test green (32 tests).
- [x] Phase R10 source-contract test green (46 tests).
- [x] Phase R11 source-contract test green (21 tests).
- [x] Phase R12 source-contract test green (33 tests).
- [x] `useActiveWorkspaceId` is exported from
      `apps/web/lib/platform-context/useTeamWorkspaceGate.ts`.
- [x] `DENIAL_REASONS`, `projectTomPersona`,
      `accessStateToDenialReason`,
      `authorizationDenialCodeToDenialReason`,
      `accessGateKindToDenialReason`, `anyDenialToCanonical`,
      `denialReasonHeadline`, `denialReasonGuidance`,
      `TOM_PERSONA_KINDS`, `tomPersonaLabel`,
      `tomPersonaShortLabel`, `isSoloTomPersona`,
      `isOrgTomPersona` are all re-exported from `@proovra/shared`.
- [x] `services/api/src/services/access/canonical-workspace-resolver.ts`
      exposes `resolveActiveOperationalWorkspace` and
      `mapAuthorizationDenial`.
- [x] No new Prisma migration was created in Phase 3 (only
      `_phase_o_*` migrations remain from R3/R7).

---

## 5. Phase 4 deliverable shape (proposed)

Phase 4 follows the same 10-stage shape Phase 3 used. The proposed
stages — to be approved by the architecture board — are:

| Stage | Title                                                                              |
|-------|------------------------------------------------------------------------------------|
| 1     | Pre-flight audit + safety check (READ-ONLY)                                        |
| 2     | Sidebar / topbar / workspace-switcher migrate to canonical hooks                   |
| 3     | Command palette + global search migrate to canonical denial copy                   |
| 4     | Onboarding screens consume `projectTomPersona`                                     |
| 5     | Upgrade CTAs consume `denialReasonHeadline("UPGRADE_REQUIRED")`                    |
| 6     | `PageRouteGate` + `AccessGate` render via canonical copy helpers                   |
| 7     | Persona-aware empty states across 8 pillars (HOME, CAPTURE, …, TRUST)              |
| 8     | Phase R13 source-contract test (analogue of R12, for the navigation surface)       |
| 9     | Run validations (shared build / API + web typecheck / web build / R9-R13 tests)   |
| 10    | Phase 5 readiness report                                                           |

No stage adds a product feature. No stage opens a database
transaction. No stage rewrites a route handler.

---

## 6. Rollback strategy

Phase 3 added only:

- 2 new files in `packages/shared/src/architecture/`.
- 1 new file in `services/api/src/services/access/`.
- 1 new test file under `services/api/test/`.
- `@deprecated` JSDoc on 5 inline `WorkspaceScope` declarations.
- `@deprecated` JSDoc on 14 capability keys (no behaviour change).
- `@deprecated` JSDoc on 3 hooks (no behaviour change).
- Promoted JSDoc on `useActiveWorkspaceId` (no behaviour change).

Rollback is **trivial**: revert the 3 new files and the JSDoc
edits. No data, no schema, no runtime surface changed.

Phase 4 should preserve the same property — every change MUST be a
copy / projection / import migration, never a behaviour swap.

---

## 7. Open questions for the architecture board

1. Should Phase 4 include the 9th persona "MEDIA_OUTLET" or remain
   strictly at the constitutional 8? **Recommendation: 8.** The
   constitution is explicit, and `JOURNALIST` already covers solo
   reporters embedded in an outlet.

2. Should the dead capability key removal land in Phase 4 alongside
   the navigation work, or in its own Phase 4.5? **Recommendation:
   Phase 4.5.** Phase 4 is a non-destructive consolidation; the
   removal is a destructive surface change and deserves its own
   review window.

3. Should the worker (`services/worker/`) participate in Phase 4 or
   wait for Phase 5? **Recommendation: wait.** Phase 4 is
   user-facing; the worker has no persona projection or sidebar.
