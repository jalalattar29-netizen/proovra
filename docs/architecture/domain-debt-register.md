# PROOVRA Domain Debt Register

**Status:** Honest inventory of legacy concepts that violate the Target Domain Blueprint but are not yet refactored. Companion to `current-to-target-domain-map.md`. Source of truth: Phase 1 audit.

Each entry is classified:
- **SAFE-KEEP** — temporarily acceptable; will be retired in a later phase but does not require immediate attention
- **WRAP** — should be wrapped by a compatibility helper before further changes
- **PHASE-3** — must be fixed in Phase 3 (Stage A or B of the stabilization order)
- **PHASE-4+** — must be fixed in a later phase
- **CRITICAL** — high-impact debt that requires customer coordination or special handling

The Phase R11 source-contract test (`services/api/test/phase-r11-domain-stabilization.test.ts`) forbids NEW occurrences of forbidden patterns. Existing occurrences enumerated here are allowlisted via path allowlists in the test.

---

## 1. Team table conflated with Workspace

| Item | Location | Classification | Notes |
|---|---|---|---|
| `Team` is the runtime workspace | `services/api/prisma/schema.prisma:893` | **PHASE-3** | The single largest piece of debt. Rename Team → Workspace; introduce new Team table as collaboration sub-unit. |
| 165 tables FK to `teamId` | various | **PHASE-3** | Mechanical rename `teamId → workspaceId`. |
| `Team.isPersonal Boolean` | `schema.prisma:944` | **PHASE-3** | Replaced by `Workspace.kind` enum after rename. |
| `Team.organizationId NOT NULL` (Stage 6) | `schema.prisma:961` | **PHASE-3 (CRITICAL)** | Must become nullable to support Personal Workspaces without synthetic Orgs. |
| `users.current_workspace_id → Team.id` | `schema.prisma:745` + 17 consumer files | **PHASE-3** | FK target rename. |
| `prisma.teamMember.findUnique` raw calls (87 in 51 files) | `services/api/src/` | **PHASE-3** | Will become `workspaceMember.findUnique` after rename. |
| Frontend hooks `useTeamId`, `useWorkspaceId`, `useActiveWorkspaceId`, `useActiveSpaceId` | `apps/web/lib/platform-context/useTeamWorkspaceGate.ts` (lines 63, 83, 109) + `useTenantModel.ts:76` | **PHASE-3** | Consolidate to single `useActiveWorkspaceId`. ~57 call sites. |
| `WorkspaceScope = "PERSONAL" \| "TEAM"` enum (9 duplicate declarations) | api, web, worker, shared-billing | **PHASE-3** | Rename `TEAM → ORGANIZATION`; consolidate to one declaration. |

---

## 2. Auto-bootstrapped synthetic Organization per Personal user

| Item | Location | Classification | Notes |
|---|---|---|---|
| `ensurePersonalWorkspace` mints Organization + OrganizationMembership + Team + TeamMember atomically | `services/api/src/services/platform-context/workspace-bootstrap.service.ts:148-189` | **PHASE-3** | The synthetic Org is required only because `Team.organizationId NOT NULL`. Retiring the constraint allows retiring the synthetic Org. |
| Personal-workspace Organization row | runtime data | **SAFE-KEEP** | Existing data is fine; new signups should stop creating it once the constraint is relaxed. Migration cleanup later. |

---

## 3. Trust + Subprocessor + Status assets scoped to Team

| Item | Location | Target scope | Classification |
|---|---|---|---|
| `TrustCenterArticle.teamId?` (nullable global) | `schema.prisma:9632` | `organizationId?` | **PHASE-3** |
| `Subprocessor.teamId?` | `schema.prisma:9691` | `organizationId?` | **PHASE-3** |
| `StatusComponent.teamId?` | `schema.prisma:9741` | `organizationId?` | **PHASE-3** |
| `StatusIncident.teamId?` | `schema.prisma:9766` | `organizationId?` | **PHASE-3** |
| `StatusIncidentUpdate.teamId?` | `schema.prisma:9786` | `organizationId?` | **PHASE-3** |
| `MaintenanceWindow.teamId?` | `schema.prisma:9804` | `organizationId?` | **PHASE-3** |
| `TrustCenterArticleVersion.teamId?` | `schema.prisma:9667` | `organizationId?` | **PHASE-3** |

---

## 4. Governance policy duality

| Item | Location | Classification | Notes |
|---|---|---|---|
| `GovernancePolicy` (per-team, has engine + audit) | `schema.prisma:9863-9886` | **PHASE-3** | Re-scope to organizationId; merge with OrganizationPolicy. |
| `OrganizationPolicy` (per-org, key/value bag) | `schema.prisma:8584-8600` | **PHASE-3** | Merge into unified Policy entity. |
| `OrganizationPolicy.organizationId NOT NULL` reads | `services/api/src/routes/organizations-governance.routes.ts:147,157,223`, `services/api/src/services/organization/retention-inheritance.service.ts:155` | **PHASE-3** | Move to unified Policy reader. |
| `GovernancePolicy.teamId NOT NULL` reads | `services/api/src/services/governance/governance-policy.service.ts:210` | **PHASE-3** | Same. |

---

## 5. Delegated admin / Access review / Cross-org 4-column scope overlap

| Item | Location | Classification | Notes |
|---|---|---|---|
| `DelegatedAdminGrant`: `teamId NOT NULL` + `organizationId?` + `departmentId?` + `workspaceId?` | `schema.prisma:9834-9861` | **PHASE-3** | Collapse to single `scopeKind` + `scopeId`. |
| `AccessReviewCampaign`: same 4-column pattern | `schema.prisma:9943-10033` | **PHASE-3** | Same collapse. |
| `CrossOrgReviewGrant.teamId NOT NULL` + `invitingOrganizationId?` + `invitedOrganizationId?` | `schema.prisma:10004-10033` | **PHASE-3** | Rebind to `invitingOrganizationId NOT NULL`. |
| Existing R7-additive columns | various R7 migrations | **SAFE-KEEP** | These columns are forward-compat already; consumers transitioning gradually. |

---

## 6. SSO / SCIM (CRITICAL)

| Item | Location | Classification | Notes |
|---|---|---|---|
| `SsoConnection.teamId NOT NULL` | `schema.prisma:6190-6196` | **CRITICAL — PHASE-4+** | Customer-facing IdP reconfiguration required. Per-customer coordination plan needed before migration. |
| `ScimProvisioningToken.teamId NOT NULL` | `schema.prisma:6341-6346` | **CRITICAL — PHASE-4+** | Same. |
| SSO `@@unique([teamId, provider, status])` | `schema.prisma:6333` | **CRITICAL — PHASE-4+** | Constraint must become `[organizationId, provider, status]`. |
| `services/api/src/routes/admin-identity.routes.ts:202` `listSsoConnections({ teamId })` | API contract | **CRITICAL — PHASE-4+** | API contract change; alias `?organizationId=` needed for one release. |
| `services/api/src/routes/identity-operations-completion.routes.ts:14` `?teamId=` SAML query | API contract | **CRITICAL — PHASE-4+** | Same. |
| `services/api/src/services/access-control/sso-hardening.service.ts:30` consumer | service | **CRITICAL — PHASE-4+** | Same. |

---

## 7. Reviewer artifacts (per-Team, may stay per-Team or move to per-Workspace)

| Item | Location | Classification | Decision pending |
|---|---|---|---|
| `CodingSchema.teamId NOT NULL` | `schema.prisma:9180` | **PHASE-3** | Decision: per-Workspace (shared across all reviewers in workspace) OR per-Team (per sub-team). Phase 1 documented both arguments. |
| `CodingField.teamId NOT NULL` | `schema.prisma:9212` | **PHASE-3** | Same decision. |
| `CodingValue.teamId NOT NULL` | `schema.prisma:9242` | **PHASE-3** | Same. |
| `ReviewerDisagreement.teamId NOT NULL` | `schema.prisma:9264` | **PHASE-3** | Same. |
| `QcSample.teamId NOT NULL` | `schema.prisma:9302` | **PHASE-3** | Same. |

---

## 8. Evidence access query — silent privacy regression risk

| Item | Location | Classification | Notes |
|---|---|---|---|
| `getAccessibleEvidenceContext` builds `memberTeamIds` from every TeamMember the user has, OR-unions in evidence list | `services/api/src/routes/evidence.routes.ts:2063-2152` | **CRITICAL — PHASE-4** | Currently a user sees evidence from EVERY team they've ever joined. Workspace switching does not narrow visibility. Demoting Team to sub-unit MUST be paired with narrowing this query. |
| Same pattern in `requireEvidenceAccess`, `requireCaseAccess`, `requireReportAccess`, `requirePackageAccess` | `services/api/src/services/access/tenant-access.helpers.ts:118-228` | **CRITICAL — PHASE-4** | Per-resource ACL helpers; coordinated change with the list query. |

---

## 9. Backend gate strategy split

| Item | Location | Classification | Notes |
|---|---|---|---|
| `requireOpsActor` / `requireReviewerActor` / `requireReadinessActor` (read `req.query.teamId`) | `services/api/src/routes/ops.routes.ts:74`, `operations-queues.routes.ts:52`, `operations-recovery.routes.ts:27`, `operations-signers.routes.ts:51`, `runtime-readiness.routes.ts:34`, `reviewer-ops.routes.ts:108` | **PHASE-3** | Unify behind the canonical `authorizeOrFail` flow. |
| `requireDelegatedTier` (reads `user.currentWorkspaceId`) | `services/api/src/middleware/require-delegated-tier.ts:44-49` | **PHASE-3** | Different strategy than the actor gates. Consolidate. |
| `evaluateMemberAccess` consumers pass `teamId` | 9 files | **PHASE-3** | Rename to `workspaceId` after Team is renamed. |
| 87 raw `prisma.teamMember.findUnique({ teamId_userId })` calls | 51 files | **PHASE-3** | Rename to `workspaceMember.findUnique` after model rename. |

---

## 10. Billing nominal drift

| Item | Location | Classification | Notes |
|---|---|---|---|
| `Subscription.teamId?` | `schema.prisma:1665` | **PHASE-3** | Rename to `workspaceId?`. |
| `WorkspaceStorageAddon.teamId?` | `schema.prisma:1505` | **PHASE-3** | Rename to `workspaceId?`. |
| `WorkspaceStorageAddon.workspaceType: "PERSONAL" \| "TEAM"` (string column) | `services/api/src/services/workspace-billing.service.ts:98,175`, `workspace-usage.service.ts:27-67`, `services/worker/src/workspace-billing.ts:85,127` | **PHASE-3** | Rename `"TEAM" → "ORGANIZATION"`; string backfill. |
| `Team.billingPlan` / `Team.billingOwnerUserId` | `schema.prisma:918`, `:897` | **PHASE-3** | Becomes `Workspace.billingPlan` / `Workspace.billingOwnerUserId`. |

---

## 11. Audit table fragmentation

| Item | Location | Classification | Notes |
|---|---|---|---|
| `CustodyEvent` (`evidenceId`-keyed) | `schema.prisma:499` | **SAFE-KEEP** | Evidence-anchored is correct. |
| `TeamActivity` (`teamId NOT NULL`) | `schema.prisma:1606` | **PHASE-5** | Becomes `WorkspaceActivity` after rename. Observability dashboards (Grafana/Datadog) impact requires coordination. |
| `AdminAuditLog` (no tenant key) | `schema.prisma:1818` | **PHASE-5** | Acceptable as platform-tier audit. Future: optional `organizationId?` for tenant-attributable rows. |
| `OrganizationAuditEvent` (`organizationId NOT NULL`) | `schema.prisma:8565` | **SAFE-KEEP** | Already correctly scoped. |
| `EvidenceLifecycleEvent` (`teamId NOT NULL`) | `schema.prisma:6833` | **PHASE-3** | Rename to `workspaceId` with Evidence. |
| Phase 1.5 target: unified `AuditEvent` model | n/a | **PHASE-5** | Major schema consolidation; coordinated with observability tooling. |

---

## 12. UI / frontend nominal drift

| Item | Location | Classification | Notes |
|---|---|---|---|
| `envelope.workspace` (legacy field, marked deprecated) | `services/api/src/services/platform-context/types.ts:598-603` | **PHASE-4** | Retire after consumer migration. |
| `envelope.availableWorkspaces` (deprecated, no production consumer) | `types.ts:609-611` | **PHASE-4** | Safe to remove once envelope schema bumps. |
| `envelope.navigation.groups` (deprecated, replaced by sidebar.pillars + accountMenu) | `types.ts:362-367` | **PHASE-4** | Stop emitting after consumer migration. |
| 8 components consult `workspace.scope === "PERSONAL" \| "TEAM"` | AppTopbarV2, AppSidebarV2, ReviewerCommandConsole, CommandCenter, GovernanceControlPlane, GlobalRuntimeIndicator, WorkspaceAdminPanel, CapabilityDegradedPanel | **PHASE-3** | Replace with `isPersonalWorkspaceKind` / `isOrganizationWorkspaceKind` from `@proovra/shared` (added Phase 2). |
| `useActiveWorkspaceId` "documented as removed but still defined" | `apps/web/lib/platform-context/index.ts:7-12` (comment) + `useTeamWorkspaceGate.ts:90,109` | **PHASE-3** | Reconcile documentation vs reality. |

---

## 13. Capability registry dead keys

| Item | Location | Classification | Notes |
|---|---|---|---|
| 12 namespaced `PERSONAL_*` + `ORG_*` keys granted but never consumed | `services/api/src/services/platform-context/capability-registry.ts:299-348` | **PHASE-3 (Stage A)** | Remove from grant table; remove from `CapabilityKey` type. |
| 14 mutation-act keys granted but never gate routes (`EVIDENCE_MANAGE`, `CASES_MANAGE`, `CASE_ASSIGN`, `CASE_STATUS_CHANGE`, etc.) | `capability-registry.ts:130-265` | **PHASE-3 (Stage A)** | Either wire to routes that should require them OR remove. |
| `NEEDS_UPGRADE` access state declared but never emitted | `apps/web/lib/navigation/routeAccessResolver.ts:24-33` | **PHASE-3 (Stage A)** | Either implement plan-gated routes OR remove. |

---

## 14. Three denial vocabularies

| Item | Location | Classification |
|---|---|---|
| `AccessState` (7 codes) | `routeAccessResolver.ts:24-33` | **PHASE-3 (Stage A)** |
| `AccessGateKind` (7 codes) | `apps/web/components/access/AccessGate.tsx:27-34` | **PHASE-3 (Stage A)** |
| `AuthorizationDenialCode` (14 codes) | `services/api/src/middleware/authorize.ts:70-89` | **PHASE-3 (Stage A)** |
| **Action:** unify behind a mapping table. | | |

---

## 15. Two persona projection systems

| Item | Location | Classification |
|---|---|---|
| `resolvedPersona: Persona` (role-derived: INDIVIDUAL/WORKSPACE_OWNER/TEAM_ADMIN/TEAM_MEMBER/TEAM_VIEWER) | `apps/web/lib/platform-context/types.ts:201-203` | **PHASE-3 (Stage A)** |
| `WorkspacePersonaProfile` (UX use-case: LAWYER/INSURANCE/INVESTIGATOR/JOURNALIST/ENTERPRISE_COMPLIANCE/ADMIN_OPERATOR) | `types.ts:310-318` | **PHASE-3 (Stage A)** |
| **Action:** consolidate to a single explicit primary projection. | | |

---

## 16. Schema constraints to relax (Phase 3+)

| Constraint | Why relax | Risk |
|---|---|---|
| `Team.organizationId NOT NULL` (Stage 6) | Personal Workspaces should have NULL organizationId | HIGH — reopens partial-state class that Stage 6 closed |
| `@@unique([teamId, provider, status])` on SsoConnection | Becomes per-Organization | CRITICAL — customer-side IdP impact |
| `TrustCenterArticle @@unique([teamId, kind, slug])` | Becomes `[organizationId, kind, slug]` | MEDIUM |

---

## Summary roll-up

| Classification | Count |
|---|---|
| SAFE-KEEP | 4 |
| WRAP | 0 (no wrap needed in Phase 2; helpers added) |
| PHASE-3 | ~40 items (Stage A/B/C of stabilization order) |
| PHASE-4+ | ~10 items (audit unification, SSO migration, envelope retirement) |
| PHASE-5+ | ~3 items (custom roles, WORM audit, DSAR) |
| CRITICAL | 3 items (SSO/SCIM migration, Evidence access query, Stage 6 relaxation) |

**Total documented debt items:** ~60.

**Net:** The codebase already does the right thing structurally in most places. Most debt is nominal (rename teamId → workspaceId) rather than semantic. The two genuinely difficult migrations are SSO/SCIM rebinding (CRITICAL, customer-coordinated) and Evidence access query narrowing (CRITICAL, silent privacy regression risk if mishandled).
