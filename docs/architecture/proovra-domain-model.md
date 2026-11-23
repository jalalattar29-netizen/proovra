# PROOVRA Canonical Domain Model

**Status:** Constitutional (Phase 1.5 approved). Future phases must justify deviations against this document. Companion docs:
- `architecture-invariants.md` — hard rules enforced by tests
- `current-to-target-domain-map.md` — current state vs target state
- `domain-debt-register.md` — known legacy debt

> **Model correction (2026-11-23).** The Personal Workspace, Organization Workspace, Subscription, billing and seat statements below were written for a model in which a TEAM customer created a separate multi-user workspace. That model is retired. Verified against code on branch `team/review-remediation` (base `110e576d6`):
> - **Team is bought for the subscriber's Personal Workspace.** Checkout takes no workspace target and refuses one with `CHECKOUT_TARGET_NOT_SUPPORTED` (`services/api/src/routes/billing.routes.ts:336-348`). FREE → PRO → TEAM are tiers of the same Personal Workspace.
> - **Self-service creation of additional or organization workspaces is retired.** `POST /v1/teams` always answers 409 `WORKSPACE_CREATION_NOT_SELF_SERVICE` (`services/api/src/routes/teams.routes.ts:590-631`); `POST /v1/orgs` answers 403 `org_self_service_creation_retired` (`services/api/src/routes/organizations.routes.ts:901-933`). Organization Workspaces are created only by Enterprise provisioning (`services/api/src/services/enterprise-provisioning.service.ts`).
> - **The effective plan is resolved by workspace kind** (`packages/shared-billing/src/plan-catalog.ts:796-846`, `resolveWorkspaceEffectivePlan`) — see §2a.
> - **The Personal Workspace is multi-member.** A PRO/TEAM owner invites members into it; for an invitee the active space is still `type: "PERSONAL"`, carrying the workspace's name, the invitee's real role and `shared: true` (`services/api/src/services/platform-context/platform-context.service.ts:1478-1506`).
> - **Seats are capped per Collaboration Team, not workspace-wide.** PRO: 2 Collaboration Teams × 5 accepted non-owner members; TEAM: 5 × 10; FREE/PAYG: none (`plan-catalog.ts:320-355, 607-608, 644-645`). `maxAdditionalWorkspaceMembers` is `0` for FREE/PAYG and `null` (no workspace-wide pool) for PRO/TEAM/ENTERPRISE; only an Enterprise contract that states a seat count bounds a workspace as a whole.
> - **Team review eligibility (R1/R2) and decision authority (R3)** are stated in §2b.
>
> Sections changed: §1 principle 6, §2 Workspace / Personal Workspace / Organization Workspace / Subscription, new §2a–§2b, §3, §4, §6 invariant 5. The workspace-kind statements describe the *target* model; the schema enum still carries the legacy `OWNED` value (see §2a).

---

## 1. The bedrock principles

1. **PROOVRA is personal-first.** A single user must be able to use the platform without creating an Organization.
2. **There are exactly two first-class Workspace kinds: `PERSONAL` and `ORGANIZATION`.** No other workspace kind is allowed.
3. **`Team` is a collaboration sub-unit inside a Workspace.** It is never a tenancy boundary, never a runtime workspace, never the unit of billing or identity.
4. **`Organization` is the governance + identity federation + commercial umbrella.** It owns SSO/SCIM, Departments, Policies, Compliance, Audit Federation, but **never directly owns Evidence** — Workspace owns operational artifacts.
5. **`Workspace` owns operational state** (Evidence, Cases, Reports, Reviews, Trust assets, billing). Workspace is the operational tenancy unit by which API queries are filtered.
6. **`Account` (User) is the cross-tenant identity.** A user may participate in many Workspaces: their own Personal Workspace, other people's Personal Workspaces they were invited into, and N Organization Workspaces. *(2026-11-23: invited Personal Workspaces added.)*

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
- **Kind:** `PERSONAL` | `ORGANIZATION` — **no other values allowed** for new rows. *(2026-11-23: the schema enum `WorkspaceKind` also carries `OWNED` — `services/api/prisma/schema.prisma:4132-4136` — for grandfathered self-service workspaces that nothing creates any more; see §2a.)*
- **Authority:** owns Evidence, Cases, Reports, Reviews, Trust assets, billing subscription, storage add-ons
- **Relationships:** N:M Account (via WorkspaceMembership); optional 1:1 Organization (NULL for Personal); 1:N Teams

### Personal Workspace
A Workspace with `kind = PERSONAL`. The user's auto-bootstrapped private work area.

- **Owned by:** Account
- **organizationId:** must be NULL (target). Today the Stage 6 schema forces an auto-bootstrapped synthetic Org; that is documented legacy debt.
- **Created:** automatically on first sign-in
- **Lifecycle:** active for the life of the Account
- **Authority:** owns Evidence, Cases, Reports, Reviews, Trust artifacts; its commercial subject is the owner's account (Entitlement / internal plan grant), including optional storage add-ons
- **Membership:** the owner (role = Owner) plus any members the owner invites on PRO or TEAM. Invitees see it as a shared Personal Workspace (`activeSpace.shared = true`, their real role). *(2026-11-23: was "exactly one member".)*
- **Teams:** Collaboration Teams (sub-units) capped by the owner's plan per workspace: PRO 2 × 5 accepted non-owner members, TEAM 5 × 10, FREE/PAYG none. There is no workspace-wide seat pool. *(2026-11-23: was "soft cap".)*
- **Plan:** the owner's effective personal plan — FREE by default; Entitlement or internal grant may give PAYG / PRO / TEAM. **TEAM is bought for this workspace**; it does not create another one. *(2026-11-23: TEAM added.)*

### Organization Workspace
A Workspace with `kind = ORGANIZATION`. A shared, multi-user evidence operations workspace owned by an Organization.

- **Owned by:** Organization
- **organizationId:** non-NULL
- **Created:** only by Enterprise provisioning against a signed contract (one workspace per Organization contract). Self-service creation is retired. *(2026-11-23: was "explicitly by an account holder".)*
- **Authority:** owns shared Evidence, Cases, Reports, Reviews, Trust assets, governance assets (inherited from parent Org), workspace billing (contract coverage)
- **Membership:** N members via WorkspaceMembership (roles: Owner / Admin / Member / Viewer)
- **Teams:** many Teams as collaboration sub-units
- **Plan:** ENTERPRISE under a live customer contract, or TEAM where a live TEAM workspace subscription exists; otherwise FREE (fail closed). *(2026-11-23: was "TEAM (or ENTERPRISE)".)*

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
The workspace-level billing record (`Team.billingPlan` / `billingStatus`).

- **Owned by:** Workspace
- **Lifecycle:** active / past_due / canceled
- **Authority:** drives the effective plan of an ORGANIZATION workspace (ENTERPRISE contract or TEAM) and of a grandfathered OWNED workspace (TEAM only). It does **not** govern a PERSONAL workspace — the owner's Entitlement does. No self-service checkout writes a new workspace subscription: checkout's subject is the person. *(2026-11-23: was "drives workspace.plan; seat count".)*

---

## 2a. Effective plan by workspace kind (added 2026-11-23)

One resolver decides it: `resolveWorkspaceEffectivePlan` (`packages/shared-billing/src/plan-catalog.ts:796-846`). "Live" means billing status ACTIVE or PAST_DUE.

| Workspace kind | Effective plan | Source |
|---|---|---|
| `PERSONAL` | The owner's personal plan: an active internal plan grant, else the owner's Entitlement plan (FREE / PAYG / PRO / TEAM) | `resolvePersonalEffectivePlan` |
| `OWNED` (legacy, grandfathered) | TEAM only with a live TEAM workspace subscription; an `ENTERPRISE` plan string fails closed to FREE; otherwise FREE. The owner's personal plan never covers it | workspace's own billing |
| `ORGANIZATION` | ENTERPRISE under a live customer contract; TEAM with a live TEAM subscription; otherwise FREE | contract / workspace billing |
| unknown | FREE (fail closed) | — |

Existing OWNED workspaces are not archived, downgraded or hidden; nothing creates new ones (`teams.routes.ts:590-604`).

## 2b. Team review eligibility and decision authority (added 2026-11-23)

Binding decisions R1–R3 of the Team review remediation (`D:\pw\review-ops-audit-2026-11-22\TEAM-SPEC.md` §1):

- **R1 — eligibility.** Team review tools work in the *active workspace whose effective plan is TEAM or above*, whatever its stored kind (PERSONAL included). No invited member is needed to unlock them; membership count never decides entitlement, configuration never disappears when a member leaves, and the workspace kind is never relabelled. Each operation still enforces the active workspace's effective entitlement, active membership plus the required permission, evidence/case reach and assignment, and second-review independence. FREE and PRO Personal Workspaces gain nothing; Enterprise organizations keep their own entitlements.
- **R2 — what R1 unlocks.** QC, the Reviewer Workspace, coding schemas, disagreements and review metrics are gated by `reviewQueuesIncluded` / `REVIEW_TASKS_AND_QUEUES` (TEAM and ENTERPRISE: `plan-catalog.ts:634, 670`), **not** `ADVANCED_REVIEW_WORKFLOWS`, so Enterprise-only workflow capabilities stay Enterprise. The reviewer-ops reconcile/escalation automation runs only for workspaces still entitled (`reviewer-operations-engine.service.ts:1670`); see `review-escalation-notifications.md`.
- **R3 — decision authority.** FIRST decision (and request-info): the current assignee holding decision permission (`evidence_request.review`) and reach. SECOND decision: the current assignee after an authorized assignment manager reassigns to a *different* eligible reviewer — never the first reviewer; reassignment grants no permission. ADJUDICATION: a separate explicit action by an OWNER/ADMIN who made neither decision and has reach; ordinary Approve/Reject cannot adjudicate or skip a stage. With no eligible reviewer or adjudicator the workflow stays pending with a staffing explanation; the required number of reviews is never reduced. All of this is enforced atomically on the server (`services/api/src/services/reviewer-ops/review-decision.service.ts`).

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
| User-level Entitlement (PAYG/PRO/TEAM) | **Account** | Survives workspace switches; governs the owner's Personal Workspace |
| Workspace Subscription (ENTERPRISE contract; TEAM on Organization / legacy Owned workspaces) | **Workspace** | Contract coverage of a provisioned workspace *(2026-11-23: a self-service TEAM purchase is an Account Entitlement, not a Workspace Subscription)* |
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
| **Account** | User (Entitlement) — applies to the owner's Personal Workspace | Solo professionals and small teams (FREE/PAYG/PRO/TEAM) |
| **Organization** | Org-level enterprise contract, represented as the provisioned ORGANIZATION workspace's billing | Enterprise buyers (ENTERPRISE) |

*(2026-11-23 correction.)* TEAM is a tier of the subscriber's Personal Workspace, bought by the person (`billing.routes.ts:336-348`); there is no self-service per-workspace subscription tier any more. The per-user plan survives workspace switches. Collaboration capacity is counted per Collaboration Team (accepted non-owner members; PRO 2 × 5, TEAM 5 × 10), not per active WorkspaceMembership; only an Enterprise contract that states a seat count bounds a workspace as a whole (`plan-catalog.ts:320-355`). Legacy OWNED workspaces with a live TEAM subscription keep it (grandfathered).

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
5. **Teams are core collaboration features, available to all users.** Teams are NOT enterprise-only. A Personal Workspace user may create Collaboration Teams within the plan's caps (PRO 2 × 5, TEAM 5 × 10; FREE/PAYG none). *(2026-11-23: was "soft caps".)*
6. **SSO/SCIM at Organization only.** No new code may scope identity federation at Workspace or Team.
7. **No new workspace types.** The workspace kind enum is closed.
8. **Visible UI must lead to working surfaces.** No new navigation may render a route that 404s or that the persona cannot use without "Requires organization" chip noise on personal users.
9. **Capability names must not imply fake workspace types.**
10. **Account-tier Entitlements (PRO/PAYG) survive workspace switches.** No code may erase user-level PRO based on workspace plan.

---

## 7. What is NOT in this document

This document is the constitutional reference. It does NOT specify:
- Implementation order
- Current state contradictions (see `current-to-target-domain-map.md` and `domain-debt-register.md`)
- Phase-specific work scope (each phase has its own plan)
- API contracts or schema (those are derived from this document)

**This document is the source of truth for what PROOVRA's architecture is supposed to be.**
