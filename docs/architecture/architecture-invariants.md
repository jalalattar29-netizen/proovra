# PROOVRA Architecture Invariants

**Status:** Constitutional. Enforced by source-contract tests in `services/api/test/phase-r11-domain-stabilization.test.ts`. Violations break CI.

Each invariant has:
- A short ID (`INV-N`) referenced by the test suite
- A statement of the rule
- The rationale
- The pinned test name

To add, change, or relax any invariant: amend this document AND the test, AND obtain architecture board approval. The two must move together.

---

## INV-1 — Target workspace kinds are closed

**Rule:** The target `WorkspaceKind` vocabulary is exactly `{ "PERSONAL", "ORGANIZATION" }`. No other values are permitted in new code. The existing runtime `WorkspaceScope = "PERSONAL" | "TEAM"` is documented legacy debt (current state); new code that encodes the TARGET model must use the canonical constants in the compatibility module.

**Rationale:** Phase 1.5 Target Domain Blueprint, Deliverable 2 — exactly two first-class workspace kinds.

**Pinned by:** `INV-1: TARGET_WORKSPACE_KINDS is exactly ["PERSONAL", "ORGANIZATION"]`

---

## INV-2 — Team is not a Workspace

**Rule:** No new code, type, identifier, comment, or UI string may introduce any of the following terms as if they were workspace types:
- `TeamWorkspace`
- `ReviewerWorkspace`
- `GovernanceWorkspace`
- `OperationsWorkspace`

The strings `"team workspace"`, `"reviewer workspace"`, `"governance workspace"`, and `"operations workspace"` (case-insensitive) are similarly forbidden in new UI copy.

**Allowlist:** Existing legacy occurrences in pre-Phase 2 files are documented in `domain-debt-register.md` and grandfathered. New occurrences in files modified after Phase 2 fail the test.

**Rationale:** Team is a collaboration sub-unit (Phase 1.5 Deliverable 4). Reviewer/Governance/Operations are roles/features/areas, not workspaces.

**Pinned by:** `INV-2: no new code introduces fake workspace terminology`

---

## INV-3 — Personal users are not forced into Organizations

**Rule:** No new core-product route may require Organization membership. The set of "core personal surfaces" includes `/home`, `/capture`, `/evidence`, `/search`, `/cases`, `/reports`, `/trust`, `/settings`, `/billing`. All of these must be reachable by a Personal Workspace user without joining or creating an Organization.

**Rationale:** Phase 1.5 bedrock principle 1: "PROOVRA is personal-first."

**Pinned by:** `INV-3: core personal routes require active space PERSONAL_OR_ORG (not ORGANIZATION_ONLY)`

---

## INV-4 — Teams are core collaboration features, not enterprise-only

**Rule:** Team creation, team invitations, and team membership management must be available in BOTH Personal Workspaces and Organization Workspaces. No new code may gate team-feature access behind Organization membership.

**Rationale:** Phase 1.5 Deliverable 4: "Teams may exist inside a Personal Workspace OR inside an Organization Workspace." Personal Workspaces support small Teams (subject to soft caps).

**Pinned by:** `INV-4: no new capability requires ORGANIZATION scope for Team operations`

---

## INV-5 — SSO/SCIM at Organization only

**Rule:** New SSO Connection schema, SCIM Token schema, or identity federation API must be scoped at the Organization level. New code must not introduce `SsoConnection.teamId` or `ScimToken.workspaceId` semantics.

**Allowlist:** Existing `SsoConnection.teamId` and `ScimProvisioningToken.teamId` columns are documented in `domain-debt-register.md` (CRITICAL). Phase 3+ will rebind them. New schema must scope to `organizationId`.

**Rationale:** Phase 1.5 Deliverable 9. Fortune-500 IT requires per-customer (per-Org) IdP binding.

**Pinned by:** `INV-5: no new SSO/SCIM identifier scopes at Team or Workspace level` (advisory; manual review required for schema changes until Phase 3)

---

## INV-6 — Account-tier Entitlements survive workspace switches

**Rule:** User-level Entitlements (PRO/PAYG) must always be derived from `Account.id` (i.e. `Entitlement.userId`), never from `Team.billingPlan` or `Workspace.plan`. The `flags.isProAccount` field in the platform-context envelope must derive from `account.accountPlan`, not `workspace.plan`.

**Rationale:** Phase R10 personal-first regression fix; reaffirmed in Phase 1.5 Deliverable 8.

**Pinned by:** `INV-6: isProAccount derives from accountPlan, not workspace.plan` (already pinned by `phase-r10-personal-first-regression.test.ts`)

---

## INV-7 — Visible UI must not lead to 404 or "Requires organization" for personal users

**Rule:** No new sidebar item, navigation link, or visible CTA may render for a Personal Workspace user if the target route would 404 (because the page is missing or redirected to a nonexistent destination) OR if the route is ORGANIZATION_ONLY (which would render the "Requires organization" panel).

**Rationale:** Phase 1.5 Persona 1 (Individual) information architecture: "What they don't see: governance/access reviews/departments — entirely hidden, not 'Requires organization' chipped."

**Pinned by:** `INV-7: routeRegistry has no new dead next.config.js redirects` (already pinned by `phase-r10`)

---

## INV-8 — Capability names must not imply fake workspace types

**Rule:** New capability keys may not contain the substring `TeamWorkspace`, `ReviewerWorkspace`, `GovernanceWorkspace`, or `OperationsWorkspace`. Capability tier prefixes (`ACCOUNT_*`, `WORKSPACE_*`, `ORG_*`, `TEAM_*`) are allowed and encouraged.

**Rationale:** Phase 1.5 Deliverable 7 — single capability registry, namespaced cleanly. No leakage of fake workspace concepts via capability names.

**Pinned by:** `INV-8: capability registry contains no fake-workspace-type capability names`

---

## INV-9 — The canonical denial vocabulary is closed

**Rule:** The frontend access-state vocabulary is fixed at the set declared in `apps/web/lib/navigation/routeAccessResolver.ts` (`ACCESS_STATES`). New denial states require explicit addition with corresponding test coverage. The values `NEEDS_TEAM_WORKSPACE`, `NEEDS_REVIEWER_WORKSPACE`, etc. are forbidden.

**Rationale:** Three parallel denial vocabularies coexist today (AccessState / AccessGateKind / AuthorizationDenialCode). Phase 3+ will unify them. Until then, no NEW vocabulary entries may introduce fake workspace concepts.

**Pinned by:** `INV-9: ACCESS_STATES has no fake-workspace-type entries`

---

## INV-10 — Organization is optional

**Rule:** No new signup flow, no new account-creation route, no new "first-time user" experience may require the user to create an Organization before reaching their Personal Workspace. The eager personal-workspace bootstrap (from Phase R10) must remain in place.

**Rationale:** Phase 1.5 bedrock principle 1.

**Pinned by:** `INV-10: registerWithEmailPassword + upsertUserWithEmailLink eagerly call ensurePersonalWorkspace` (already pinned by `phase-r10`)

---

## INV-11 — Invite channels remain extensible

**Rule:** Team and Organization invite mechanisms must remain channel-agnostic in their service-layer contract so future channels (e.g. SMS, magic-link, in-app, SSO group push) can be added without rewriting the invite domain. Today's email-only invite is acceptable; new invite features must extend the existing service layer rather than fork a parallel system.

**Rationale:** Phase 1.5 Deliverable 5 (Team Feature Blueprint) — invite channel matrix includes email + link + SCIM auto-provision; future SMS/magic-link must integrate cleanly.

**Pinned by:** advisory — no test today; documented for future enforcement.

---

## INV-12 — Audit trail integrity per scope

**Rule:** No new mutation path may bypass audit emission. The unified `AuditEvent` model (Phase 1.5 target) accepts events at workspace, organization, or evidence scope. New mutations must emit an event at the appropriate scope. Today's 5-table audit fragmentation (CustodyEvent / TeamActivity / OrganizationAuditEvent / AdminAuditLog / EvidenceLifecycleEvent) is documented legacy debt; new code should add events to the existing tables until Phase 5 unifies them.

**Rationale:** Compliance + Phase 1.5 Deliverable 12. Audit chain integrity is non-negotiable.

**Pinned by:** advisory — no test today; documented for future enforcement.

---

## INV-13 — Stage 6 NOT NULL constraint is documented legacy

**Rule:** `Team.organizationId NOT NULL` (Stage 6 invariant) is documented legacy debt. Personal Workspaces today carry a synthetic auto-bootstrapped Organization to satisfy this constraint. The target model relaxes this constraint to nullable (Personal Workspaces have no Organization). Phase 3+ will introduce the migration. No new code should rely on `Team.organizationId` being non-NULL for Personal Workspaces, even though it is today.

**Rationale:** Phase 1.5 Deliverable 2 — Personal Workspace has `organizationId = NULL` in the target model.

**Pinned by:** advisory — no test today; documented in `domain-debt-register.md`.

---

## INV-14 — Workspace.kind enum is the canonical scope axis

**Rule:** New service code that needs to branch by workspace kind must read `Workspace.kind` (target) or `Team.isPersonal` (current) — NOT introduce new boolean flags, new enum overlays, or new scope discriminators.

**Rationale:** Phase 1.5 Deliverable 7 (Permission Model) — scope axis is one of: Account, Workspace, Organization, Team, Department, Resource. No new scopes.

**Pinned by:** advisory.

---

## INV-15 — Reviewer / Governance / Operations are roles/features/areas, never workspaces

**Rule:** Reviewer is a role-or-capability surface inside a Workspace. Governance is a feature area inside Organization Workspaces. Operations is a platform-admin area. None of these may be elevated to a Workspace kind, a tenancy boundary, or a billing unit.

**Rationale:** Phase 1.5 Deliverables 1, 2, 4, 6.

**Pinned by:** `INV-2` (same forbidden-terminology grep covers this).

---

## How invariants are amended

1. Open a PR that:
   - Edits this document with the new/changed invariant text
   - Edits the corresponding test in `services/api/test/phase-r11-domain-stabilization.test.ts`
   - Updates the cross-reference doc `current-to-target-domain-map.md` if the change affects the mapping
2. The PR title must start with `arch-invariant:` and the description must justify the change against the Target Domain Blueprint.
3. Architecture board approval is required before merge.

Any invariant marked "advisory" today is a documented intent; tests will be added in a later phase. Removing an advisory marker requires adding an enforcing test.
