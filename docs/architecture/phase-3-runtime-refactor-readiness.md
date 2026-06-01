# Phase 3 Runtime-Refactor Readiness

**Status:** Forward-looking. Defines what Phase 3 may safely change, what it may NOT touch, prerequisites, sequencing, and rollback strategy. Source: Phase 1 audit + Phase 1.5 blueprint + Phase 2 debt register.

This document is the gate document. Phase 3 begins only when the prerequisites listed here are met.

---

## 1. What Phase 3 CAN safely change

Phase 3 scope is **Stage A** (Nominal Alignment) from the Phase 1 stabilization order — LOW-risk renames + consolidations that do not touch tenancy semantics.

### Stage A — Nominal Alignment

| Change | Files affected | Risk |
|---|---|---|
| Consolidate 4 workspace-id hooks (`useTeamId`, `useWorkspaceId`, `useActiveWorkspaceId`, `useActiveSpaceId`) into single `useActiveWorkspaceId` with deprecation aliases | `apps/web/lib/platform-context/useTeamWorkspaceGate.ts`, `useTenantModel.ts`, ~57 call sites | LOW (alias-friendly) |
| Unify 3 denial vocabularies (`AccessState` / `AccessGateKind` / `AuthorizationDenialCode`) behind a mapping table | `apps/web/lib/navigation/routeAccessResolver.ts`, `apps/web/components/access/AccessGate.tsx`, `services/api/src/middleware/authorize.ts` | LOW (mapping additive) |
| Consolidate 2 persona projection systems into one explicit primary projection | `apps/web/lib/platform-context/types.ts:201-203` + `types.ts:310-318` | LOW |
| Collapse 9 duplicate `WorkspaceScope` enum declarations to a single source | api, web, worker, shared-billing | LOW |
| Remove 12 dead `PERSONAL_*` + `ORG_*` capability keys (granted but never consumed) | `services/api/src/services/platform-context/capability-registry.ts:299-348` | LOW (verified by Phase 2 source-contract test) |
| Either implement `NEEDS_UPGRADE` access state OR remove from `AccessState` | `routeAccessResolver.ts:24-33` | LOW |
| Begin using `@proovra/shared` `isPersonalWorkspaceKind` / `isOrganizationWorkspaceKind` helpers in NEW code (8 components today inline-check `workspace.scope`) | various | LOW (additive; existing inline checks stay until Phase 3 closes them) |

### Stage B — Schema preparation (no data move)

| Change | Files affected | Risk |
|---|---|---|
| Add `Workspace` as a view/alias over `Team` in Prisma (or formally rename column-by-column with `@map` preservation) | `services/api/prisma/schema.prisma` | MEDIUM |
| Introduce new `Team` table for collaboration sub-unit (no consumers yet — pure additive schema) | `schema.prisma` | LOW |
| Add `Workspace.kind` enum derived from `Team.isPersonal` | `schema.prisma` | LOW (computed column or view) |

### Stage C — Re-scope governance entities (HIGH risk — irreversible)

Phase 3 may attempt Stage C ONLY after Stage A + Stage B land cleanly and are verified in production for at least one full release cycle.

| Change | Risk | Prerequisite |
|---|---|---|
| Re-scope `TrustCenterArticle`, `Subprocessor`, `StatusComponent` from `teamId` → `organizationId` | HIGH | Multi-team-per-org data migration plan written and reviewed |
| Merge `GovernancePolicy` + `OrganizationPolicy` into unified `Policy` entity | HIGH | Policy engine refactor + dual-read window |
| Collapse 4-column scope overlap on `DelegatedAdminGrant`, `AccessReviewCampaign`, `CrossOrgReviewGrant` | HIGH | Service-layer rewrite + audit replay plan |

---

## 2. What Phase 3 MUST NOT touch

The following items are explicitly out of scope for Phase 3. They are deferred to Phase 4+ with the indicated risk level.

| Item | Phase | Reason |
|---|---|---|
| SSO `teamId` → `organizationId` rebinding | Phase 4 (Stage E) | **CRITICAL.** Customer-facing IdP reconfiguration. Requires per-customer coordination plan and migration windows. |
| SCIM `teamId` → `organizationId` rebinding | Phase 4 (Stage E) | Same. |
| Evidence/Cases access query narrowing (`memberTeamIds` union → active-workspace-only) | Phase 4 (Stage D) | **CRITICAL.** Silent privacy regression risk if mishandled. Tests today don't catch cross-workspace isolation. |
| `Team.organizationId NOT NULL` relaxation (Stage 6 invariant) | Phase 4 (Stage B continued) | Re-opens partial-state class that Stage 6 closed. Needs migration safety gate review. |
| Audit table unification (5 tables → 1 `AuditEvent`) | Phase 5 | Coordinated change with observability tooling (Grafana/Datadog reference `team_id`). |
| Retire synthetic per-personal-user Organization rows | Phase 3 (Stage F) but only AFTER constraint relaxation | Dependent on `Team.organizationId` becoming nullable. |
| API contract changes (`?teamId=` → `?workspaceId=`) | Phase 4 | Requires alias support window for SDK consumers. |
| Frontend rename of `useTeamId` to deprecate (vs alias) | Phase 4 | After all 57 call sites migrated to `useActiveWorkspaceId`. |
| Custom roles per Organization | Phase 5+ | New feature; not refactor. |
| Enterprise Account tier above Organization | Phase 7+ | New feature; not refactor. |
| Regional data residency per Organization | Phase 6+ | New feature + deployment plane. |
| Postgres RLS (row-level security) introduction | Phase 4+ | Defense-in-depth additive; high coordination cost. |
| WORM audit storage abstraction | Phase 5+ | Compliance-driven; new requirement. |
| DSAR (Data Subject Access Request) workflow | Phase 5+ | New feature. |
| Real-time collaboration features | Phase 8+ | New feature. |

---

## 3. Files at highest risk

These files have the most leverage. Any change here must have:
- Pre-change architecture invariant test in place (Phase R11 + dedicated extensions)
- Post-change regression test
- Manual smoke check on dev DB

| File | Lines | Reason |
|---|---|---|
| `services/api/src/services/platform-context/platform-context.service.ts` | ~828 | Central envelope builder; every workspace derivation flows through it |
| `services/api/src/services/platform-context/capability-registry.ts` | ~350 | Capability grant table — touched by any role/scope change |
| `services/api/src/services/platform-context/workspace-bootstrap.service.ts` | ~230 | Eager bootstrap; touches Org + Team + Memberships atomically |
| `services/api/prisma/schema.prisma` | ~10,500 | 222 models; renames here cascade |
| `services/api/src/routes/evidence.routes.ts` | central evidence routes incl. `:2063-2152` access context | **CRITICAL** — query narrowing happens here |
| `services/api/src/services/access/tenant-access.helpers.ts` | resource-resolved tenancy guards | Cross-cutting access control |
| `services/api/src/middleware/authorize.ts` | denial vocabulary + central authorization | Touched by Stage A vocabulary unification |
| `services/api/src/middleware/require-delegated-tier.ts` | reads `currentWorkspaceId` directly | Tier check; coordinate with backend gate unification |
| `apps/web/lib/platform-context/PlatformContextProvider.tsx` | envelope state machine + version compat | Schema version contracts |
| `apps/web/lib/platform-context/useTeamWorkspaceGate.ts` | hook consolidation source | Stage A target |
| `apps/web/components/navigation/PageRouteGate.tsx` | the central frontend gate | Touch only via well-tested fallbacks |

---

## 4. Tests that must exist BEFORE Phase 3 runtime refactor begins

### Already in place (Phase R10 + R11)

- `phase-r9-personal-first-rescue.test.ts` — 32 tests pinning personal-first fallback
- `phase-r10-personal-first-regression.test.ts` — 46 tests pinning the navigation/access regression fixes (schema versions, resolver call sites, capability registry, runtime pill, redirects, etc.)
- `phase-r11-domain-stabilization.test.ts` — INV-1 through INV-10 + documentation existence (Phase 2)
- `phase-emergency-recovery-bootstrap.test.ts` — 28 tests pinning workspace-bootstrap behavior
- `phase-o-migration-safety-gate.test.ts` — 28 tests catching CREATE TABLE IF NOT EXISTS / SET NOT NULL / etc.
- `phase-38-6-route-exposure.test.ts` — 31 tests pinning route registry shape + integrity

### Must be added before Stage A begins (Phase 3 prerequisite)

| Test | Pins | Why needed |
|---|---|---|
| `phase-12-hook-consolidation.test.ts` | `useTeamId` callers migrated to `useActiveWorkspaceId`; deprecation alias present; no NEW callers of `useTeamId` | Ensures Stage A hook consolidation doesn't regress |
| `phase-12-denial-vocab-mapping.test.ts` | Mapping table from `AccessState` ↔ `AccessGateKind` ↔ `AuthorizationDenialCode` exists and is exhaustive | Required by Stage A vocabulary unification |
| `phase-12-capability-dead-key-cleanup.test.ts` | List of REMOVED capabilities; assert no consumer references them | Required by Stage A dead-key cleanup |
| `phase-12-workspace-kind-helper-adoption.test.ts` | At least N components use `isPersonalWorkspaceKind` / `isOrganizationWorkspaceKind` instead of inline `workspace.scope === "..."` | Pins Phase 3 progress |

### Must be added before Stage C (HIGH-risk re-scoping)

| Test | Pins |
|---|---|
| `phase-13-trust-org-scope.test.ts` | TrustCenterArticle / Subprocessor moved to `organizationId` |
| `phase-13-policy-unified.test.ts` | GovernancePolicy + OrganizationPolicy merged into Policy with scope discriminator |
| `phase-13-delegated-admin-scope-collapsed.test.ts` | 4-column scope overlap removed |
| `phase-13-evidence-access-narrowed.test.ts` | **CRITICAL.** Evidence list query no longer unions all member team ids; scoped to active workspace |
| `phase-13-cross-workspace-isolation.test.ts` | **CRITICAL.** A user with membership in 2 workspaces cannot see workspace A's evidence when on workspace B |

### Must be added before Phase 4 SSO/SCIM rebinding (CRITICAL)

| Test | Pins |
|---|---|
| `phase-14-sso-org-scope.test.ts` | SsoConnection scoped at organizationId |
| `phase-14-scim-org-scope.test.ts` | ScimProvisioningToken scoped at organizationId |
| `phase-14-saml-org-routing.test.ts` | SAML endpoints accept `?organizationId=` (with alias for `?teamId=`) |
| `phase-14-migration-dual-read.test.ts` | Service layer dual-reads during migration window |

---

## 5. Migration order (safest)

```
Phase 3 [Stage A — Nominal Alignment]
  1. Hook consolidation
  2. Denial vocabulary unification
  3. Persona system consolidation
  4. WorkspaceScope declaration consolidation
  5. Capability dead-key cleanup
  6. (NEW code begins adopting @proovra/shared workspace-kind helpers)
       ↓
Phase 3 [Stage B — Schema Preparation]
  7. Add Workspace as alias over Team (or column-by-column rename with @map)
  8. Introduce new Team table for sub-unit (no consumers)
  9. Add Workspace.kind enum (computed or stored)
       ↓
   (one full release cycle of stability)
       ↓
Phase 3 [Stage C — Re-scope Governance] (HIGH RISK)
 10. Re-scope Trust/Subprocessor/Status to organizationId
 11. Merge GovernancePolicy + OrganizationPolicy
 12. Collapse 4-column scope overlap on Phase 4A tables
       ↓
   (one release cycle)
       ↓
Phase 4 [Stage D — Tenancy Migration] (CRITICAL)
 13. Evidence/Cases access query narrowing — CRITICAL
 14. Backend gate strategy unification — workspaceId everywhere
 15. Migration of `users.current_workspace_id` FK target rename
 16. Relax `Team.organizationId NOT NULL` constraint
       ↓
Phase 4 [Stage E — Identity Migration] (CRITICAL — CUSTOMER COORDINATION)
 17. Customer communication window opens
 18. SsoConnection rebind teamId → organizationId
 19. ScimProvisioningToken rebind teamId → organizationId
 20. SAML query alias period
       ↓
Phase 5 [Stage F — Cleanup]
 21. Retire synthetic per-personal-user Organization rows
 22. Retire deprecated envelope fields (workspace, availableWorkspaces, navigation.groups)
 23. Unify 5 audit tables into AuditEvent
 24. Coordinate Grafana/Datadog dashboard migration
```

---

## 6. Rollback strategy

### Stage A rollback (LOW risk)

- All Stage A changes are alias-additive. The original hook names still exist; the consolidated `useActiveWorkspaceId` is the new canonical. To roll back, revert the deprecation comments and leave the old hooks in place. No data impact.
- Capability dead-key cleanup is a code revert — restore the granted-but-unused keys. No data impact.

### Stage B rollback (MEDIUM risk)

- Adding `Workspace` as a view over `Team` is reversible by dropping the view.
- Adding the new `Team` table (sub-unit) is reversible by dropping the table; no consumers depend on it yet.
- Computed `Workspace.kind` enum can be derived ad-hoc if removed.

### Stage C rollback (HIGH — partial)

- Re-scoped `teamId → organizationId` rows on Trust/Subprocessor/etc. are reversible by keeping the original `teamId` column (`@map` preserves DB column) and swapping the Prisma model field name back. Data lives on the right rows already.
- Policy unification is **harder to reverse**: once two stores merge, splitting again requires backups + audit replay. Plan a 2-week dual-write window before fully cutting over.
- 4-column scope collapse on DelegatedAdminGrant requires careful Prisma migration; rollback feasible within 24 hours of cutover.

### Stage D rollback (CRITICAL)

- Evidence access query narrowing: ROLLBACK is "revert the query OR-union change". The danger is that consumers have already adapted to the narrower visibility (e.g. UI shows fewer items); rolling back widens visibility silently, which is the regression case we were trying to avoid. Plan: keep the narrowing behind a feature flag for 1 week before commit.

### Stage E rollback (CRITICAL — customer-facing)

- SSO migration is the worst-case rollback scenario because customer IdPs are reconfigured. Plan:
  - Per-customer maintenance window (announced 2 weeks ahead)
  - Dual-route SAML handlers (accept both old and new ACS URLs)
  - SCIM dual-token period
  - 24-hour smoke window before declaring success
  - Documented rollback runbook per customer

---

## 7. Privacy / security risks per stage

| Stage | Risk | Mitigation |
|---|---|---|
| A | None substantive | Standard testing |
| B | None substantive | Standard testing |
| C | Policy merge could expand effective permissions in edge cases | Dry-run policy evaluation; emit diff log per user; review before commit |
| D | **Evidence access query narrowing**: if mishandled, can silently leak across workspaces OR silently hide legitimate access | Feature flag + dual-read + per-tenant smoke test |
| E | **SSO rebinding**: in-flight SAML assertions could fail signature verification during migration window | Customer-coordinated maintenance window |
| F | Synthetic Org cleanup could orphan governance audit rows if not migrated | Pre-flight orphan check + migration order |

---

## 8. Pre-Phase-3 prerequisites (gate checklist)

Phase 3 may begin only when ALL of the following are true:

- [ ] Phase R11 source-contract test is green on main
- [ ] No new violations of INV-1 through INV-10 introduced post-Phase 2
- [ ] Architecture board has reviewed and approved `proovra-domain-model.md`
- [ ] Architecture board has reviewed and approved `architecture-invariants.md`
- [ ] The `current-to-target-domain-map.md` debt inventory is acknowledged
- [ ] The Stage A test files listed in §4 are in place and passing
- [ ] At least one full release cycle has passed since Phase 2 to validate constitutional locks
- [ ] A communication plan exists for any user-facing rename surface (e.g. "Team" label → "Workspace" in UI copy — if approved separately)

---

## 9. Decision log (open questions for Phase 3 planning)

These decisions remain open and must be answered BEFORE Stage A begins:

1. **Reviewer artifact scope:** per-Workspace OR per-Team-sub-unit (Phase 1 deliverable 8, §9 of debt register). Both arguments documented; pick one or build dual-key support.
2. **UI vocabulary rename:** does "Team" in the UI become "Workspace" simultaneously with the schema rename, or stay "Team" indefinitely? Customer impact: high. Recommend keeping UI label "Workspace" only post-Stage D.
3. **Migration of existing synthetic personal Orgs:** delete on next signup OR keep them as historical artifacts? Recommend keeping (audit trail) and stop creating new ones.
4. **Phase 4 SSO migration timeline:** is it 1 quarter, 2 quarters, or a per-customer rolling schedule? Recommend per-customer with a 12-month sunset.

---

**Phase 3 cannot begin until the gate checklist (§8) passes AND the decision log (§9) is resolved.**
