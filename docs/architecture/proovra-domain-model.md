# PROOVRA Canonical Domain Model

**Status:** Constitutional (Phase 1.5 approved). Future phases must justify deviations against this document. Companion docs:
- `architecture-invariants.md` — hard rules enforced by tests
- `current-to-target-domain-map.md` — current state vs target state
- `domain-debt-register.md` — known legacy debt
- `phase-3-runtime-refactor-readiness.md` — what Phase 3 may safely change

---

## 1. The bedrock principles

1. **PROOVRA is personal-first.** A single user must be able to use the platform without creating an Organization.
2. **There are exactly two first-class Workspace kinds: `PERSONAL` and `ORGANIZATION`.** No other workspace kind is allowed.
3. **`Team` is a collaboration sub-unit inside a Workspace.** It is never a tenancy boundary, never a runtime workspace, never the unit of billing or identity.
4. **`Organization` is the governance + identity federation + commercial umbrella.** It owns SSO/SCIM, Departments, Policies, Compliance, Audit Federation, but **never directly owns Evidence** — Workspace owns operational artifacts.
5. **`Workspace` owns operational state** (Evidence, Cases, Reports, Reviews, Trust assets, billing). Workspace is the operational tenancy unit by which API queries are filtered.
6. **`Account` (User) is the cross-tenant identity.** A user may participate in many Workspaces (1 Personal + N Organization Workspaces).

---

## 2. Canonical entity definitions

### Account (User)
The cross-tenant identity. What a human signs in as.

- **Owned by:** itself
- **Lifecycle:** active / suspended / deleted
- **Authority:** owns its own credentials, MFA factors, sessions, account-level entitlements, persona settings
- **Relationships:** 1:1 Personal Workspace (auto-bootstrapped); N:M Organizations (via OrganizationMembership); N:M Workspaces (via WorkspaceMembership)

### Workspace
The operational tenancy unit. The scope by which API queries are filtered, capabilities are resolved, billing seats are counted, and audit events are partitioned.

- **Owned by:** an Account (for `kind = PERSONAL`) OR an Organization (for `kind = ORGANIZATION`)
- **Lifecycle:** active / suspended / archived
- **Kind:** `PERSONAL` | `ORGANIZATION` — **no other values allowed**
- **Authority:** owns Evidence, Cases, Reports, Reviews, Trust assets, billing subscription, storage add-ons
- **Relationships:** N:M Account (via WorkspaceMembership); optional 1:1 Organization (NULL for Personal); 1:N Teams

### Personal Workspace
A Workspace with `kind = PERSONAL`. The user's auto-bootstrapped private work area.

- **Owned by:** Account
- **organizationId:** must be NULL (target). Today the Stage 6 schema forces an auto-bootstrapped synthetic Org; that is documented legacy debt.
- **Created:** automatically on first sign-in
- **Lifecycle:** active for the life of the Account
- **Authority:** owns Evidence, Cases, Reports, Trust artifacts, billing (optional storage add-ons via user-level Entitlement)
- **Membership:** exactly one member (the owner, role = Owner)
- **Teams:** may have small Teams (collaboration sub-units) — soft cap on team count + member count
- **Plan:** FREE by default; user-level Entitlement may grant PRO/PAYG

### Organization Workspace
A Workspace with `kind = ORGANIZATION`. A shared, multi-user evidence operations workspace owned by an Organization.

- **Owned by:** Organization
- **organizationId:** non-NULL
- **Created:** explicitly by an account holder (with the Organization as parent)
- **Authority:** owns shared Evidence, Cases, Reports, Reviews, Trust assets, governance assets (inherited from parent Org), billing subscription with seats
- **Membership:** N members via WorkspaceMembership (roles: Owner / Admin / Member / Viewer)
- **Teams:** many Teams as collaboration sub-units
- **Plan:** TEAM (or ENTERPRISE for contracted customers)

### WorkspaceMembership
The actor's role binding to a Workspace.

- **Owned by:** Workspace + Account
- **Lifecycle:** active / suspended / revoked
- **Fields:** role, custom capability grants, joined date, last active
- **Uniqueness:** `(workspaceId, userId)`
- **Purpose:** the canonical "is this user in this tenant" join

### Organization
The governance + identity federation + commercial umbrella for one or more Organization Workspaces operated by a single legal/commercial entity (a law firm, agency, company, government bureau).

- **Owned by:** itself (with billingOwnerUserId)
- **Lifecycle:** active / suspended / archived
- **Authority:** owns SSO Connection, SCIM Provisioning Token, Departments, Organization Policies, Compliance posture, TrustCenterArticles, Subprocessors, StatusComponents, Access Review Campaigns, Delegated Admin Grants, Cross-Org Review Grants, Audit Federation
- **Does NOT own:** raw Evidence content; Workspace owns those
- **Relationships:** 1:N Organization Workspaces (initially 1:1; multi-Workspace under one Org supported)

### OrganizationMembership
The account's role binding to an Organization (org-tier permissions distinct from workspace-tier).

- **Owned by:** Organization + Account
- **Lifecycle:** active / suspended / revoked
- **Role:** OrgOwner / OrgAdmin / OrgBillingOwner / OrgSecurityAdmin / OrgComplianceAdmin / OrgAuditor / OrgMember
- **Uniqueness:** `(organizationId, userId)`

### Department
A formal sub-unit of an Organization. Used for governance, data scope, retention overrides, budget boundaries, compliance boundaries.

- **Owned by:** Organization
- **Lifecycle:** active / archived
- **Authority:** scopes evidence visibility (with explicit elevation paths); receives retention policy overrides; holds its own audit slice
- **Relationships:** N:M with Teams; N:M with Accounts (via DepartmentMembership)
- **Personal Workspaces:** Departments do NOT exist in Personal Workspaces

### Team
A collaboration sub-unit inside a Workspace. Used to coordinate work, assign cases/evidence, route reviews, scope notifications, and bind SSO groups.

- **Owned by:** Workspace
- **Lifecycle:** active / suspended / archived
- **Authority:** owns roster, role grading (Lead/Member/Viewer), assignments, shared saved views, team-level notification routing
- **Does NOT own:** Evidence/Cases/Reports (those belong to the parent Workspace); billing (Workspace owns billing); identity (Org owns identity)
- **Availability:** Teams may exist in BOTH Personal Workspaces AND Organization Workspaces. **Teams are NOT enterprise-only.**
- **Relationships:** N members via TeamMembership; N:M with Departments (within an Org Workspace)
- **Never:** a tenancy boundary; a runtime workspace; a billing unit; a workspace

### TeamMembership
A workspace-member's participation in a specific Team.

- **Owned by:** Team + WorkspaceMembership
- **Lifecycle:** active / suspended
- **Role:** Lead / Member / Viewer
- **Constraint:** team membership is a subset of workspace membership

### Case (Matter)
A discrete investigation/matter; the unit of work.

- **Owned by:** Workspace
- **Lifecycle:** open / investigating / on-hold / resolved / closed / archived
- **Authority:** owns its own access list, custody chain, status timeline
- **Relationships:** belongs to Workspace; may be assigned to a Team; references Evidence

### Evidence
A captured/uploaded artifact (image/video/audio/document) with provenance and trust state.

- **Owned by:** Workspace (operational tenancy); ownerUserId records the originating actor
- **Lifecycle:** active / pending-destruction / destroyed
- **Authority:** owns its canonical hash, provenance chain, custody events, trust signals, signed assertions
- **Relationships:** belongs to Workspace; may belong to a Case; may belong to a Department (Org Workspaces only)

### Report / VerificationPackage
Generated deliverables derived from Evidence.

- **Owned by:** Evidence (transitively → Workspace)
- **Lifecycle:** draft / sealed / superseded
- **Authority:** inherits tenancy from Evidence; carries its own signing/version chain
- **Relationships:** references Evidence

### Review
A reviewer's structured judgment on Evidence (coding values, verdicts, disagreements, QC samples).

- **Owned by:** Workspace (with optional Team scope)
- **Lifecycle:** queued / in-review / completed / disagreed / escalated
- **Authority:** coding values + verdicts + QC outcomes + disagreement state
- **Relationships:** belongs to Workspace; assignable to a Team; references Evidence
- **Reviewer is a ROLE/CAPABILITY, NOT a workspace.** The Reviewer Workspace UI is a surface within an existing Workspace.

### Policy
A unified governance rule (retention, redaction, SSO, security, review, intelligence).

- **Owned by:** Organization (org-tier policies) OR Workspace (workspace-tier overrides)
- **Lifecycle:** draft / active / archived
- **Authority:** evaluated by the runtime policy engine; emits POLICY_VIOLATION audit events on violation
- **Target:** one canonical Policy entity (collapsing today's GovernancePolicy + OrganizationPolicy duality)

### Role
Named bundles of permissions, applied at a scope (Workspace, Organization, Team, Department, Resource).

- **System-defined:** WorkspaceRole, OrganizationRole, TeamRole, DelegatedAdminTier
- **Custom roles:** v2 design space reserved (per-Organization custom roles)
- **Capability binding:** roles bundle capabilities; capability registry is canonical

### Capability
A bounded, named permission key (e.g. `EVIDENCE_VIEW`, `GOVERNANCE_ACT`).

- **Source of truth:** the capability registry
- **Applied at:** the appropriate scope (account / workspace / team / org / resource)
- **Never imply fake workspace types:** capability names must not introduce "TeamWorkspace", "ReviewerWorkspace", etc.

### Entitlement (account-tier)
The user-level plan grant (FREE/PAYG/PRO).

- **Owned by:** Account
- **Lifecycle:** active / canceled / expired
- **Authority:** drives `account.accountPlan`; survives workspace switches
- **Constraint:** `Entitlement.userId` only — never `teamId` or `workspaceId`

### Subscription (workspace-tier)
The workspace-level seat/billing record.

- **Owned by:** Workspace
- **Lifecycle:** active / past_due / canceled
- **Authority:** drives `workspace.plan`; seat count; storage add-ons

### SSO Connection / SCIM Provisioning Token
Identity federation bindings.

- **Owned by:** Organization
- **Lifecycle:** active / pending / suspended
- **Authority:** one IdP per Organization (Day 1); SCIM provisions WorkspaceMembership + TeamMembership
- **NEVER:** at Workspace or Team scope

### Access Review Campaign
A periodic review of who has access to what.

- **Owned by:** Organization
- **Lifecycle:** scheduled / running / completed / archived
- **Authority:** spans Workspaces under an Org; per-item evidence trail

### Delegated Admin Grant
A scoped admin elevation (Reviewer Lead, Security Officer, Compliance Officer, Workspace Admin).

- **Owned by:** Organization
- **Lifecycle:** active / revoked / expired
- **Authority:** adds a layer above WorkspaceRole; visible in envelope so frontend can render appropriately

### External Reviewer Role Assignment
An outside-counsel-style grant: time-bounded, watermarked, MFA-gated.

- **Owned by:** Organization (issuing) or Personal Workspace
- **Lifecycle:** active / accepted / revoked / expired
- **Authority:** token + SSO + MFA gated; per-evidence scope; never grants workspace membership

### Audit Event (canonical, unified — target)
A tamper-evident record of every meaningful action.

- **Scope discriminator:** workspaceId | organizationId | evidenceId (anchored)
- **Lifecycle:** append-only
- **Authority:** HMAC-chained per scope; replicated to verification packages
- **Target:** one unified `AuditEvent` model (collapsing today's CustodyEvent + TeamActivity + OrganizationAuditEvent + AdminAuditLog + EvidenceLifecycleEvent fragmentation)

### Device / CaptureSession / CaptureTrustEvent
Provenance primitives.

- **Owned by:** Workspace
- **Lifecycle:** active / revoked
- **Authority:** anchors signed assertions; not a tenancy layer

### TrustCenterArticle / Subprocessor / StatusComponent
Public-facing trust assets.

- **Owned by:** Organization (Org trust) or Platform (global trust)
- **Lifecycle:** draft / published / superseded
- **Authority:** Org publishes its trust posture to customers/regulators
- **Target scope:** `organizationId?` (NULL = platform-default). Today's `teamId?` is documented legacy debt.

---

## 3. Ownership boundary summary

| Asset | Owned by | Reason |
|---|---|---|
| Evidence, Cases, Reports, Reviews | **Workspace** | Operational artifacts belong to the org-unit doing the work |
| Coding Schemas, QC Samples, Disagreements | **Workspace** (with Team scope) | Per-workspace review standards |
| Trust assets (TrustCenterArticle, Subprocessor) | **Organization** | Public trust posture is the entity's, not a per-workspace concern |
| Governance Policies, Access Reviews, Delegated Admin | **Organization** | Governance spans all workspaces under an Org |
| Departments | **Organization** | Formal sub-division of the Org |
| SSO Connection, SCIM Token | **Organization** | Identity federation is per-customer |
| Compliance posture | **Organization** | CJIS/FedRAMP/SOC2 attestations are organizational |
| User-level Entitlement (PRO/PAYG) | **Account** | Survives workspace switches |
| Workspace Subscription (TEAM/ENTERPRISE) | **Workspace** | Per-workspace seat counts and billing |
| Storage add-ons | **Workspace** | Per-workspace quota |
| MFA factors, sessions, credentials | **Account** | Identity belongs to the user |
| Devices, CaptureSessions, TrustEvents | **Workspace** | Capture provenance is per-workspace |
| Workspace audit events | **Workspace** | Workspace-scoped activity log |
| Org governance audit events | **Organization** | Federates across workspaces |
| Notification preferences | **Account** (routing) + **Workspace** (team channels) | Routing belongs to actor; channels belong to workspace |

---

## 4. Billing boundary summary

| Tier | Billable unit | Customer shape |
|---|---|---|
| **Account** | User (Entitlement) | Solo professionals (FREE/PAYG/PRO) |
| **Workspace** | Per-workspace Subscription (seats + storage) | SMB teams (TEAM plan) |
| **Organization** | Org-level enterprise contract (consolidates Workspace Subscriptions) | Fortune-500 buyers (ENTERPRISE) |

Per-user PRO survives workspace switches. Per-workspace seats are counted per active WorkspaceMembership. Org enterprise contracts are an optional overlay; per-workspace billing rolls up.

---

## 5. SSO boundary summary

**SSO and SCIM live at the Organization level. Always.**

- NOT at Workspace level (Fortune-500 IT rejects this)
- NOT at Team level (Team is operational, not identity)
- NOT at Account level (Account uses email+password or OAuth for non-enterprise sign-in)

Personal Workspaces have NO SSO. Personal users sign in via email+password (with MFA) or Google/Apple OAuth.

Future: an Enterprise Account tier above Organization will provide one IdP for many Organizations (cf. GitHub Enterprise Account). Reserved design space.

---

## 6. The locked invariants

The following invariants are constitutional. They are enforced by source-contract tests (`services/api/test/phase-r11-domain-stabilization.test.ts`) and must not be relaxed without architecture board approval. See `architecture-invariants.md` for the full numbered list.

1. **Workspace.kind ∈ {PERSONAL, ORGANIZATION}.** No other values allowed.
2. **Team is not a Workspace.** No new code may introduce `TeamWorkspace`, `team workspace`, or treat Team as a tenancy boundary.
3. **Reviewer, Governance, Operations are not Workspaces.** No new code may introduce `ReviewerWorkspace`, `GovernanceWorkspace`, `OperationsWorkspace`.
4. **Personal users must not be forced into Organizations.** No new code may require Org membership for core personal surfaces (Home, Capture, Evidence, Search, Cases, Reports, Trust, Settings, Billing).
5. **Teams are core collaboration features, available to all users.** Teams are NOT enterprise-only. A Personal Workspace user may create Teams (subject to soft caps).
6. **SSO/SCIM at Organization only.** No new code may scope identity federation at Workspace or Team.
7. **No new workspace types.** The workspace kind enum is closed.
8. **Visible UI must lead to working surfaces.** No new navigation may render a route that 404s or that the persona cannot use without "Requires organization" chip noise on personal users.
9. **Capability names must not imply fake workspace types.**
10. **Account-tier Entitlements (PRO/PAYG) survive workspace switches.** No code may erase user-level PRO based on workspace plan.

---

## 7. What is NOT in this document

This document is the constitutional reference. It does NOT specify:
- Implementation order (see `phase-3-runtime-refactor-readiness.md`)
- Current state contradictions (see `current-to-target-domain-map.md` and `domain-debt-register.md`)
- Phase-specific work scope (each phase has its own plan)
- API contracts or schema (those are derived from this document)

**This document is the source of truth for what PROOVRA's architecture is supposed to be.**
