# Current-to-Target Domain Mapping

**Status:** Honest mapping. **Current implementation is NOT yet aligned with the Target Domain Blueprint.** This document records the gap. It does NOT claim the implementation is already fixed.

Source-of-truth:
- Target: `proovra-domain-model.md` (constitutional, Phase 1.5)
- Current state evidence: Phase 1 audit (see in-repo task history #197-#211, plus the prior Section 14 contradiction list)

---

## How to read this document

| Column | Meaning |
|---|---|
| **Concept** | The architectural concept under discussion |
| **Current** | What the code does today (file:line evidence) |
| **Target** | What the Target Domain Blueprint specifies |
| **Gap** | What is missing or wrong |
| **Migration phase** | Which future phase is expected to close the gap |

This document is **descriptive, not prescriptive**. The migration order is owned by `phase-3-runtime-refactor-readiness.md`.

---

## 1. Workspace

| Concept | Current | Target | Gap | Phase |
|---|---|---|---|---|
| Workspace as a model | Does not exist as a distinct model. The `Team` table (`schema.prisma:893`) plays this role. | First-class `Workspace` model with `kind: PERSONAL \| ORGANIZATION` | Need to either rename `Team` → `Workspace` (165 dependent tables) OR introduce a Workspace view/alias over Team. Phase 1 documented the rename as Stage A/B. | 3+ |
| Workspace scope vocabulary | `WorkspaceScope = "PERSONAL" \| "TEAM"` in `services/api/src/services/platform-context/types.ts:98` (declared 9× across api/web/worker/shared) | `WorkspaceKind = "PERSONAL" \| "ORGANIZATION"` | Value rename `TEAM → ORGANIZATION`; consolidate 9 declarations | 3 |
| Workspace identifier | `users.current_workspace_id` → Team.id (`schema.prisma:745`) | `users.current_workspace_id` → Workspace.id (semantically; column name may stay) | The column already does the right thing structurally; only the FK target name changes once Team is renamed | 3 |
| Personal Workspace | `Team(isPersonal=true)` row with a paired auto-bootstrapped `Organization` (`workspace-bootstrap.service.ts:148-189`) | `Workspace(kind=PERSONAL, organizationId=NULL)` | Need to relax `Team.organizationId NOT NULL` (Stage 6 constraint) AND retire the synthetic auto-bootstrapped Organization for personal users | 3+ |
| Organization Workspace | `Team(isPersonal=false)` row with `organizationId NOT NULL` | `Workspace(kind=ORGANIZATION, organizationId=<real Org>)` | Mechanical rename | 3 |

---

## 2. Team

| Concept | Current | Target | Gap | Phase |
|---|---|---|---|---|
| Team as collaboration sub-unit | **Does not exist.** No row, no FK, no service implements "a team within a workspace". The current `Team` table IS the Workspace. | First-class `Team` model: `{ workspaceId, name, role-grading members, assignments, etc. }` | A new `Team` model must be introduced after `Team` is renamed to `Workspace`. This is genuinely new entity work. | 3+ (with Team feature blueprint per Phase 1.5 Deliverable 5) |
| Team-as-tenancy assumption | 738 Prisma queries filter by `teamId` across 230 files. 87 `prisma.teamMember.findUnique` calls in 51 files. | Workspace-as-tenancy. Team becomes per-workspace collaboration. | Service-layer rename + the new Team entity needs members/assignments. Phase 1 documented this as the dominant migration risk. | 3-4 |
| Team available in Personal Workspace | Today: a Personal Workspace IS a Team. The user is the sole TeamMember. No way to add additional users to a Personal Workspace today. | Personal Workspace owners can create Teams within their Personal Workspace (subject to soft caps, e.g. 5 teams × 5 members). | Genuinely new product capability: enable multi-user Personal Workspaces. Not in Phase 2 scope. | 4+ |
| Team feature surface | Members, invites, roles only (per the current `TeamMember` + `TeamInvite` models). | World-class team feature blueprint (Phase 1.5 Deliverable 5): membership + invitations + roles + ownership transfer + suspension + delegation + shared work + assignments + activity feed + notifications + mentions + audit + access reviews + external collaboration + enterprise sync + department mapping + SSO group mapping. | Substantial product work. Phase 5+. | 5+ |

---

## 3. Organization

| Concept | Current | Target | Gap | Phase |
|---|---|---|---|---|
| Organization as governance container | Exists (`schema.prisma:8484`) with `OrganizationMembership`, `OrganizationInvite`, `OrganizationAuditEvent`, `OrganizationPolicy`. Tied to Team via `Team.organizationId NOT NULL`. | Same role — governance + identity federation + commercial umbrella | Mostly aligned. Cleanup: collapse `OrganizationPolicy` + `GovernancePolicy` into one unified Policy entity (Phase 3+) | 3+ |
| Synthetic Organization per Personal user | Every signup mints an `Organization` row + `OrganizationMembership(ORG_OWNER)` paired with the personal Team (`workspace-bootstrap.service.ts:155-169`) | Personal Workspaces have NO Organization | Relax `Team.organizationId` to nullable; backfill personal workspaces to NULL; archive synthetic Orgs | 3 (Stage B) |
| Organization owns Evidence directly | No — Evidence is teamId-scoped (which is workspaceId-scoped). Org has only a denormalized `Evidence.organizationId?` column. | Workspace owns Evidence (correct); Organization aggregates governance and audit, does NOT own evidence content | Aligned in spirit; the denormalized `organizationId` column on Evidence is a drift indicator | 3+ |
| Multi-Workspace per Org | Schema supports it (1:N `Organization.workspaces` relation), but every personal user generates a 1:1 pairing, so multi-workspace-per-org is rare in production data today | First-class: an Org may have many Workspaces under it (e.g. law firm with practice areas) | Cleanup of synthetic Orgs + UI for multi-workspace orgs | 4+ |

---

## 4. Identity (SSO / SCIM)

| Concept | Current | Target | Gap | Phase |
|---|---|---|---|---|
| SSO Connection scope | `SsoConnection.teamId NOT NULL` (`schema.prisma:6190-6196`) | `SsoConnection.organizationId NOT NULL` | **CRITICAL migration.** Customer-facing IdP reconfiguration required. Per-customer coordination plan needed. | 4+ (Stage E) |
| SCIM Provisioning Token scope | `ScimProvisioningToken.teamId NOT NULL` (`schema.prisma:6341-6346`) | Per Organization | Same CRITICAL risk as SSO | 4+ (Stage E) |
| SAML connection lookup | `?teamId=...&connectionId=...` query param contract | `?organizationId=...&connectionId=...` | API contract change; need alias support for 1 release | 4+ |
| Per-Org MFA / session policy | Today: per-Team (because Team = Workspace = Org-equivalent in 1:1 mapping) | Per-Organization | Cleanup after SSO migration | 4+ |
| Personal Workspace SSO | Not applicable. Personal users sign in via email+password or OAuth (Google/Apple). | Same — no SSO for Personal | Already correct ✅ | n/a |

---

## 5. Permissions / Roles / Capabilities

| Concept | Current | Target | Gap | Phase |
|---|---|---|---|---|
| Capability registry | 63 keys, ~27 dead (PERSONAL_* + ORG_* namespaced set granted but never consumed; mutation-act keys granted but never gate routes) | Consolidated to ~30-40 keys, single namespace, all consumed | Dead-key cleanup; namespace consolidation | 3 (Stage A) |
| Role hierarchy | `TeamRole = {OWNER/ADMIN/MEMBER/VIEWER}`, `OrganizationRole = {ORG_OWNER/ORG_ADMIN/ORG_BILLING_OWNER/ORG_SECURITY_ADMIN/ORG_BILLING_ADMIN/ORG_AUDITOR/ORG_MEMBER}`, no TeamSubUnitRole | Workspace + Org + Team (sub-unit) + Delegated tiers | TeamMembership needs to be split into WorkspaceMembership (renamed from TeamMember) + a NEW TeamSubUnitMembership | 3+ |
| Delegated admin tiers | `DelegatedAdminGrant` with 4-column scope overlap (`teamId NOT NULL` + `organizationId?` + `departmentId?` + `workspaceId?`) | Single `scopeKind` enum + `scopeId` | Collapse 4-column overlap; same for `AccessReviewCampaign` and `CrossOrgReviewGrant` | 3 (Stage C) |
| Custom roles | Not supported | v2 design space reserved (Linear / GitHub Enterprise pattern) | Not in scope until Phase 5+ | 5+ |
| Denial vocabulary | 3 parallel: `AccessState` (resolver, 7 codes), `AccessGateKind` (component, 7 codes), `AuthorizationDenialCode` (middleware, 14 codes) | Unified vocabulary with a mapping table | Cleanup task | 3 (Stage A) |

---

## 6. Ownership / Tenancy columns

| Entity | Current tenancy | Target tenancy | Phase |
|---|---|---|---|
| Evidence | `teamId?` + `organizationId?` + `ownerUserId` | `workspaceId` (single source of truth); `ownerUserId` retained for actor record | 3 (rename teamId → workspaceId) |
| Case | `teamId?` + `ownerUserId` | `workspaceId?` + `ownerUserId` | 3 |
| Report / VerificationPackage | inherits via `evidenceId` | inherits via `evidenceId` → Workspace | ✅ already correct |
| CodingSchema / Field / Value / Disagreement / QcSample | `teamId NOT NULL` (5 tables) | `workspaceId NOT NULL` | 3 |
| GovernancePolicy | `teamId NOT NULL` | `organizationId` (re-scope from workspace to org level) | 3 (Stage C) |
| OrganizationPolicy | `organizationId NOT NULL` (separate model) | Merge into unified Policy | 3 (Stage C) |
| TrustCenterArticle | `teamId?` (nullable global) | `organizationId?` (nullable platform-default) | 3 (Stage C) |
| Subprocessor | `teamId?` | `organizationId?` | 3 (Stage C) |
| StatusComponent / Incident / MaintenanceWindow | `teamId?` | `organizationId?` | 3 (Stage C) |
| DelegatedAdminGrant | 4-column scope overlap | single scope | 3 (Stage C) |
| AccessReviewCampaign | 4-column scope overlap | single scope | 3 (Stage C) |
| CrossOrgReviewGrant | `teamId NOT NULL` (issuing) + `invitingOrganizationId?` | `invitingOrganizationId NOT NULL` | 3 (Stage C) |
| Entitlement | `userId NOT NULL` | unchanged ✅ | n/a |
| Subscription | `userId` + `teamId?` | `userId` + `workspaceId?` | 3 |
| WorkspaceStorageAddon | `ownerUserId` + `teamId?` + `workspaceType: "PERSONAL" \| "TEAM"` | `ownerUserId` + `workspaceId?` + `workspaceType: "PERSONAL" \| "ORGANIZATION"` | 3 |
| Department / DepartmentMembership | `organizationId?` (R7-additive, optional today) | `organizationId NOT NULL` | 3 |
| SsoConnection / ScimProvisioningToken | `teamId NOT NULL` | `organizationId NOT NULL` | 4 (Stage E — CRITICAL) |
| Audit tables (5 fragmented) | 5 separate models (`CustodyEvent` / `TeamActivity` / `AdminAuditLog` / `OrganizationAuditEvent` / `EvidenceLifecycleEvent`) | One unified `AuditEvent` with scope discriminator | 5+ |

---

## 7. Frontend hooks + envelope

| Concept | Current | Target | Gap | Phase |
|---|---|---|---|---|
| Workspace-id hooks | 4 coexisting: `useTeamId` (returns null for personal users), `useWorkspaceId` (legacy workspace), `useActiveWorkspaceId` (post-R10 personal-aware), `useActiveSpaceId` (tenant model) — all return the same Team.id today | Single `useActiveWorkspaceId` returning Workspace.id, with deprecation aliases for the others | Hook consolidation; 57 call sites to migrate | 3 (Stage A) |
| Envelope shape | `envelope.workspace` (legacy, deprecated comment), `envelope.activeSpace`, `envelope.personalSpace`, `envelope.organizations[]`, `envelope.availableWorkspaces` (deprecated) | `envelope.activeSpace` (canonical), `envelope.personalSpace`, `envelope.organizations[]`. Drop legacy fields after consumer migration. | Retire deprecated fields after consumer migration | 4+ |
| Schema versions | `NAVIGATION_SCHEMA_VERSION=2` (aligned in R10), `ACCEPTED_*_SCHEMA_VERSIONS` whitelists allow rolling upgrades | Same pattern continues | ✅ already correct | n/a |
| Workspace switcher | `apps/web/components/app-shell-v2/AppTopbarV2.tsx:182-583` — switches Team ids | Same UI, switches Workspace ids (semantically same value after rename) | Nominal | 3 |

---

## 8. Navigation + access gates

| Concept | Current | Target | Gap | Phase |
|---|---|---|---|---|
| Route registry | `apps/web/lib/navigation/routeRegistry.ts` — single source of truth for client gates | Unchanged | ✅ correct | n/a |
| Page route gate | `PageRouteGate` reads canonical envelope; dev-only warning on unknown routeId (added R10) | Unchanged | ✅ correct | n/a |
| Resolve route access | `resolveRouteAccess` accepts `workspace + personalSpace` fragments (R9 personal-first rescue) | Unchanged | ✅ correct | n/a |
| Sidebar / Cmd-K / Tools | All consult routeRegistry + resolveRouteAccess (R10) | Unchanged | ✅ correct | n/a |
| Hardcoded ops links | Gated by capability checks (R10) | Unchanged | ✅ correct | n/a |
| Operations Center / Observability / Escalations / Runbooks | Properly hidden from personal users (R10) | Unchanged | ✅ correct | n/a |

---

## 9. Audit / observability

| Concept | Current | Target | Gap | Phase |
|---|---|---|---|---|
| Audit tables | 5 fragmented (see Section 6) | Single unified `AuditEvent` model | Schema redesign + observability tooling migration (Grafana/Datadog) | 5+ |
| AdminAuditLog tenancy | No tenant column (cross-tenant audit) | Acceptable as a platform-tier log | Acceptable; add `organizationId?` for tenant-attributable rows | 5+ |
| Verification package manifest writers | 5 already wired through verification package pipeline (Phase 4A Closure) | Unchanged | ✅ correct | n/a |

---

## 10. Billing

| Concept | Current | Target | Gap | Phase |
|---|---|---|---|---|
| User-level Entitlement | `Entitlement.userId` — already user-level | Unchanged | ✅ correct | n/a |
| Subscription | `Subscription.userId` + nullable `teamId?` | `Subscription.userId` + nullable `workspaceId?` | Nominal rename | 3 |
| `WorkspaceStorageAddon.workspaceType` | `"PERSONAL" \| "TEAM"` (string column) | `"PERSONAL" \| "ORGANIZATION"` | String backfill `TEAM → ORGANIZATION` | 3 |
| Stripe webhook | Receives events keyed by Stripe IDs; updates `Entitlement` + `Subscription` | Unchanged structurally; just consume renamed FK | ✅ correct | n/a |
| Enterprise contracts | No explicit Org-level contract model today | Future overlay (Phase 7) | Not in scope | 7+ |

---

## 11. What is already correct (do NOT touch)

These items are already aligned with the Target Domain Blueprint:

- Eager personal-workspace bootstrap (`ensurePersonalWorkspace` from `email-password-auth.service.ts` and `auth.service.ts`)
- `User.currentWorkspaceId` self-healing on stale pointers
- Capability registry pure function (`resolveCapabilities`)
- Route registry as single source of truth for navigation gates
- `PageRouteGate` with personal-first rescue fallback
- `resolveRouteAccess` accepting workspace + personalSpace fragments
- User-level Entitlement
- Eager personal-Org bootstrap is the wrong shape (synthetic Org) but the personal-workspace half is correct
- Phase R10 regression tests pinning all of the above

---

## 12. Risk-classified gap summary

| Risk class | Count | Examples |
|---|---|---|
| **CRITICAL** | 2 | SSO/SCIM migration; Evidence access query narrowing |
| **HIGH** | 7 | Platform-context envelope rebuild; Switch endpoint; Backend route guards; Reviewer artifacts re-scoping; Trust/Subprocessor re-scoping; Governance policy merge; Audit table unification |
| **MEDIUM** | 6 | Auth bootstrap (retire synthetic Org); Capability registry rename; Frontend hook consolidation; Switcher UI; Billing rename; External portal grant rebinding |
| **LOW** | 3 | Route resolver internals; Departments (already org-scoped); Deploy artifacts (vocabulary-free) |

The Phase 1 audit's contradiction list, the Phase 1.5 blueprint, and this mapping document together constitute the constitutional reference for Phase 3+.
