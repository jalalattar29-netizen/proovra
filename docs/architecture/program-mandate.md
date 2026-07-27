THIS IS ONE UNIFIED END-TO-END IMPLEMENTATION PROGRAM FOR PROOVRA.

Execute Phases 2 through 12 as one coherent architecture program.

Do not treat these as eleven unrelated tasks.
Do not stop after each phase to ask whether to continue.
Do not produce a completion report after each phase and wait.
Do not redesign the domain independently inside each phase.
Do not create multiple competing canonical services.
Do not leave the repository in a half-new/half-legacy architecture.
Do not claim completion based on isolated tests.

Continue autonomously through Phase 2 → Phase 12 in the required dependency order.

Only stop for user input if actual repository evidence reveals a material commercial/product contradiction for which two choices would produce meaningfully different customer behavior and the target decision is not defined below.

Do not stop for:

- ordinary implementation difficulty;
- a large number of callers;
- test updates;
- existing legacy residue;
- naming decisions already defined here;
- phase-boundary confirmation;
- runtime/database unavailability;
- migration application being unavailable.

No commit.
No push.
No deployment.
Do not apply migrations to production or any shared database.

You may author and statically validate Prisma migrations, backfills, seeds, and repair scripts. Migration application and deployment will happen later after the complete code architecture is reviewed.

Preserve the completed Phase 1 Authorization Closure.

Do not reopen Phase 1 generally. If a Phase 2–12 integration exposes a concrete Phase 1 regression, fix that exact regression and add a test.

============================================================
1. PROGRAM GOAL
============================================================

Transform the current mixed Team/Workspace/Organization implementation into one coherent, world-class Evidence Operations Platform architecture.

PROOVRA must support:

- individual users;
- self-service professionals;
- self-service teams;
- Enterprise Organizations;
- multiple Organization Workspaces;
- evidence capture;
- Cases;
- Reports;
- Review;
- Redaction;
- Intake;
- Evidence requests;
- Retention;
- Legal Holds;
- governed destruction;
- AI policies;
- SSO/SCIM;
- external reviewers;
- public verification;
- secure sharing;
- complete custody and audit history.

The final system must not resemble a generic SaaS team product.

Workspace is an operational, legal, policy, billing, security, and custody boundary.

A wrong Workspace can cause:

- Evidence to be owned by the wrong customer;
- the wrong retention policy to apply;
- the wrong Legal Hold to apply;
- the wrong billing owner to be charged;
- the wrong AI policy to control processing;
- an unauthorized reviewer to receive access;
- a Report to be issued under the wrong Organization;
- an incorrect chain-of-custody record.

All phases must preserve this Evidence Operations meaning.

============================================================
2. FIXED CANONICAL DOMAIN MODEL
============================================================

Use the following target model consistently across schema, services, APIs, workers, web, mobile, navigation, billing, identity, tests, emails, and documentation.

------------------------------------------------------------
2.1 User Account
------------------------------------------------------------

A normal User Account is one global identity.

It may have:

- exactly one Personal Space;
- zero or more Owned Workspaces;
- memberships in zero or more Enterprise Organizations;
- access to zero or more Organization Workspaces.

Joining an Organization must not:

- convert the account;
- remove the Personal Space;
- change the personal plan;
- move personal Evidence;
- silently merge identities.

------------------------------------------------------------
2.2 Personal Space
------------------------------------------------------------

A normal user has exactly one Personal Space.

Canonical kind:

WorkspaceKind.PERSONAL

It:

- is owned by the user;
- remains after Enterprise membership;
- uses personal account entitlements;
- is not an Enterprise Organization;
- cannot be converted into an Organization Workspace;
- stores Personal-scope Evidence separately.

Legacy Personal Evidence with teamId=null may remain temporarily through a documented compatibility adapter, but new canonical writes must bind to the canonical Personal Workspace unless repository constraints prove that a staged migration is required.

------------------------------------------------------------
2.3 Owned Workspace
------------------------------------------------------------

Canonical kind:

WorkspaceKind.OWNED

An Owned Workspace:

- is self-service;
- is owned by a user;
- may be funded by PRO/TEAM behavior;
- may have members;
- is not an Enterprise Organization;
- appears under “Your workspaces”;
- has its own subscription/billing owner where applicable.

TEAM is a self-service Workspace plan, not Enterprise.

------------------------------------------------------------
2.4 Enterprise Organization
------------------------------------------------------------

Canonical Organization kind:

OrganizationKind.CUSTOMER

An Enterprise Organization is the:

- legal boundary;
- contractual boundary;
- billing boundary;
- security boundary;
- identity-management boundary;
- governance boundary.

It may own one or more Organization Workspaces.

It is not itself an Evidence Workspace.

Internal containers used to support Personal or Owned Workspaces must be:

OrganizationKind.SYSTEM

They must never appear as customer Enterprise Organizations.

------------------------------------------------------------
2.5 Organization Workspace
------------------------------------------------------------

Canonical kind:

WorkspaceKind.ORGANIZATION

It:

- belongs to exactly one CUSTOMER Organization;
- is an operational Evidence boundary;
- owns or scopes Cases, Evidence, Reports, Review, Intake, policies, storage, workers, and operational audit;
- requires explicit ACTIVE Workspace membership;
- does not grant access merely from OrganizationMembership.

------------------------------------------------------------
2.6 Memberships
------------------------------------------------------------

OrganizationMembership:

- governance membership;
- Organization roles;
- Organization administration;
- no automatic access to all Organization Workspaces.

WorkspaceMembership, physically TeamMember if retained:

- operational access;
- Workspace role/capabilities;
- ACTIVE/SUSPENDED/REVOKED lifecycle;
- switcher eligibility;
- Evidence access.

CollaborationTeam:

- a group inside a Workspace;
- not a Workspace;
- not an Organization;
- not the TEAM plan.

------------------------------------------------------------
2.7 Evidence hierarchy
------------------------------------------------------------

Canonical hierarchy:

User Account
├── Personal Space
├── Owned Workspaces
└── Organization Memberships
    └── Enterprise Organization
        └── Organization Workspaces
            └── Cases
                └── Evidence

Some Evidence may exist without a Case, but every canonical Evidence record must have an authoritative Workspace scope.

------------------------------------------------------------
2.8 Billing hierarchy
------------------------------------------------------------

Keep separate:

1. Account entitlement:
   - FREE;
   - PAYG;
   - PRO.

2. Owned Workspace subscription:
   - TEAM or another eligible self-service Workspace subscription.

3. Enterprise Organization contract:
   - ENTERPRISE CUSTOM;
   - sales-led;
   - Organization-scoped.

Do not infer one from another.

============================================================
3. CROSS-PHASE IMPLEMENTATION RULES
============================================================

These rules apply to every phase.

1. One canonical implementation per feature family.

Examples:

- one Workspace-kind resolver;
- one membership orchestrator;
- one effective-capability resolver;
- one context-option producer;
- one context-switch mutation;
- one invitation acceptance orchestrator;
- one plan/contract resolver;
- one tenant audit contract;
- one identity-linking policy.

2. Migrate all callers before deleting old implementations.

3. Search the entire repository:

- API;
- Web;
- Mobile;
- Worker;
- shared packages;
- generated clients;
- emails;
- notifications;
- scripts;
- tests;
- seeds;
- fixtures;
- docs.

4. Do not preserve contradictory behavior merely because an old test asserts it.

5. Do not weaken tests.

6. Do not rely primarily on source-regex tests.

7. Every mutation must be idempotent or explicitly concurrency-controlled where repeated execution is possible.

8. Every cross-model write that must remain coherent must use a database transaction.

9. Every tenant-bound operation must derive tenant ownership from persisted data.

10. Every compatibility fallback must have:

- an owner;
- an explicit removal condition;
- a removal phase;
- no permanent silent inference.

11. Keep an implementation ledger during the program containing:

- invariant;
- canonical source;
- migrated producers;
- migrated consumers;
- compatibility residue;
- tests;
- removal status.

Use this ledger to prevent inconsistent decisions between phases.

============================================================
4. PROGRAM EXECUTION AND CHECKPOINTS
============================================================

Execute continuously.

At each phase:

1. Audit only the relevant current code.
2. Build a concise dependency map.
3. Implement the phase completely.
4. Run focused tests.
5. Re-scan for bypasses.
6. Record phase status in the program ledger.
7. Continue automatically to the next phase.

Do not wait for user confirmation.

Run broader integration gates after:

- Phase 4;
- Phase 7;
- Phase 10;
- Phase 12.

If a full suite reveals an unrelated pre-existing failure:

- prove it is unrelated;
- record it;
- do not rewrite unrelated code;
- continue if it does not invalidate the architecture.

============================================================
5. PHASE 2 — DOMAIN CLASSIFICATION CLOSURE
============================================================

Goal: Make PERSONAL, OWNED, and ORGANIZATION explicit and authoritative everywhere.

------------------------------------------------------------
5.1 WorkspaceKind
------------------------------------------------------------

Audit and migrate every Team/Workspace:

- creator;
- updater;
- reader;
- resolver;
- API projection;
- shared type;
- route guard;
- worker;
- fixture;
- seed;
- repair script.

Canonical values:

- PERSONAL;
- OWNED;
- ORGANIZATION.

Do not use:

- isPersonal=false as Organization proof;
- billingPlan=ENTERPRISE as the permanent runtime discriminator;
- Organization presence alone as Organization Workspace proof.

workspaceKind may be temporarily nullable only for migration compatibility.

Final code target:

- all new writes populate it;
- all production readers use it;
- unknown/unprovable classification fails closed;
- compatibility inference is isolated in one adapter;
- the adapter is removed in Phase 12 after all producers/readers migrate.

------------------------------------------------------------
5.2 OrganizationKind
------------------------------------------------------------

Canonical values:

- SYSTEM;
- CUSTOMER.

SYSTEM:

- internal Personal/Owned container;
- not customer-visible;
- no Enterprise admin surface;
- no Enterprise contract;
- no customer Organization switch group.

CUSTOMER:

- real Enterprise Organization;
- Enterprise governance;
- Enterprise billing/identity/security.

------------------------------------------------------------
5.3 Resolve `/v1/orgs`
------------------------------------------------------------

Trace every caller of `/v1/orgs`.

Determine whether it currently means:

- create a customer Organization;
- create a self-service Workspace/container;
- legacy behavior;
- multiple contradictory behaviors.

Do not blindly change SYSTEM to CUSTOMER.

Choose canonical paths:

- self-service Workspace creation creates SYSTEM container + OWNED Workspace;
- Enterprise/customer Organization creation occurs only through authorized Enterprise provisioning;
- customer Organization creation must not occur through a generic self-service route unless explicitly intended.

Migrate callers and retire or rename the ambiguous route only after all dependencies move.

------------------------------------------------------------
5.4 Backfill code
------------------------------------------------------------

Author safe deterministic migration/backfill code.

Do not classify every non-Personal/non-Enterprise-plan row as OWNED without provenance analysis.

Use authoritative signals where available:

- creation provenance;
- Enterprise provisioning state;
- CUSTOMER Organization;
- owner/billing owner;
- Enterprise contract;
- Personal uniqueness;
- existing memberships;
- known legacy route origin.

Ambiguous rows must:

- be reported;
- not be silently guessed;
- fail safe until remediated.

Do not apply the migration.

------------------------------------------------------------
5.5 Migrate legacy classifications
------------------------------------------------------------

Migrate or retire:

- envelope.organizations;
- availableWorkspaces;
- TargetWorkspaceKind;
- AiSection classification;
- every isPersonal-based UI classification;
- every plan-based Organization classification;
- navigation logic;
- billing labels;
- API response types;
- mobile/shared consumers.

Add invariant tests for all valid and invalid combinations.

Phase 2 completion:

- all creation paths write correct kinds;
- all runtime classification consumers use canonical kind;
- no Owned Workspace appears as Organization;
- SYSTEM Organization never appears as customer Organization;
- ambiguous `/v1/orgs` behavior is resolved;
- migration/backfill code is safe and reviewable.

============================================================
6. PHASE 3 — MEMBERSHIP ORCHESTRATOR ADOPTION
============================================================

Goal: Make every membership grant, update, reactivation, suspension, and revocation coherent.

------------------------------------------------------------
6.1 Canonical provisioning intents
------------------------------------------------------------

Create one canonical orchestrator supporting explicit intents such as:

- PERSONAL_BOOTSTRAP;
- OWNED_WORKSPACE_OWNER;
- OWNED_WORKSPACE_INVITE;
- ENTERPRISE_FIRST_OWNER;
- ORGANIZATION_GOVERNANCE_ONLY;
- ORGANIZATION_WITH_WORKSPACE_ASSIGNMENTS;
- WORKSPACE_DIRECT_INVITE;
- SSO_JIT;
- SCIM_PROVISIONING;
- GROUP_MAPPING;
- ADMIN_ASSIGNMENT;
- MEMBER_REACTIVATION;
- MEMBER_SUSPENSION;
- MEMBER_REVOCATION.

Do not force every intent to write both membership layers.

Each intent defines explicitly:

- OrganizationMembership action;
- WorkspaceMembership action;
- Organization role;
- Workspace role;
- grant source;
- actor/source;
- audit event;
- transaction boundary.

------------------------------------------------------------
6.2 Grant sources
------------------------------------------------------------

Persist or reliably model grant provenance:

- MANUAL;
- INVITATION;
- SSO_JIT;
- SCIM;
- IDP_GROUP;
- ENTERPRISE_BOOTSTRAP;
- SELF_SERVICE_OWNER;
- SYSTEM_REPAIR.

A user may have multiple sources granting the same access.

Revoking one source must not remove access still granted by another valid source.

If current membership rows cannot represent multiple sources safely, introduce a normalized grant/assignment model and author a migration.

Do not apply the migration.

------------------------------------------------------------
6.3 Role safety
------------------------------------------------------------

Prevent:

- invite-driven role demotion;
- silent role escalation;
- group mapping overwriting a protected manual role;
- SCIM overwriting Organization owner;
- reactivation restoring the wrong role;
- Platform admin becoming customer member implicitly.

Define deterministic precedence.

------------------------------------------------------------
6.4 Migrate every writer
------------------------------------------------------------

Find every direct write to:

- OrganizationMembership;
- TeamMember;
- collaboration memberships;
- roles;
- statuses.

Migrate:

- Personal bootstrap;
- Owned Workspace creation;
- Enterprise provisioning;
- Enterprise owner acceptance;
- Organization invite acceptance;
- Team invite acceptance;
- SAML JIT;
- OIDC JIT;
- SCIM;
- group mapping;
- admin assignment;
- admin removal;
- self-leave;
- suspension;
- revocation;
- reactivation;
- repair scripts;
- seeds/fixtures where appropriate.

After migration, direct production membership writes outside the orchestrator must be zero or registered system exceptions.

Phase 3 completion:

- one orchestrator;
- all writers migrated;
- grant sources safe;
- source-aware revocation;
- role precedence deterministic;
- transactional/idempotent;
- complete audit coverage.

============================================================
7. PHASE 4 — ENTERPRISE & WORKSPACE LIFECYCLE CLOSURE
============================================================

Goal: Complete every lifecycle, not only classification.

------------------------------------------------------------
7.1 Enterprise activation
------------------------------------------------------------

Implement:

signed/sales-approved contract
→ Enterprise activation
→ CUSTOMER Organization
→ Enterprise contract state
→ initial ORGANIZATION Workspace
→ first owner
→ owner invitation/activation
→ OrganizationMembership
→ WorkspaceMembership
→ seat allocation
→ billing activation
→ setup wizard
→ audit

Define:

- authorized actor;
- idempotency;
- failed-step recovery;
- retry behavior;
- duplicate customer prevention;
- owner-existing versus owner-new behavior;
- region/data-residency input where supported.

------------------------------------------------------------
7.2 Enterprise contract state
------------------------------------------------------------

Do not use only plan strings or pendingEnterpriseSeats as the permanent Enterprise contract.

Create or formalize one canonical Enterprise contract state containing as applicable:

- Organization;
- status;
- effective dates;
- seat contract;
- billing customer/subscription references;
- plan/version;
- storage allocation;
- region;
- contract owner;
- activation state;
- cancellation/termination state.

If an existing model can represent this coherently, use it through one adapter. Otherwise add a dedicated model and migration.

------------------------------------------------------------
7.3 Personal lifecycle
------------------------------------------------------------

Implement and verify:

- exactly one;
- concurrency-safe bootstrap;
- healing if missing;
- duplicate detection;
- cannot convert;
- account closure behavior;
- Personal Evidence preservation;
- plan downgrade;
- storage-over-limit behavior.

------------------------------------------------------------
7.4 Owned Workspace lifecycle
------------------------------------------------------------

Implement:

- eligible creation;
- ownership limit;
- owner membership;
- billing owner;
- Workspace subscription;
- member invitations;
- transfer ownership;
- downgrade;
- cancellation;
- closing;
- archive;
- reopening if supported;
- Evidence/Legal Hold constraints.

------------------------------------------------------------
7.5 Organization Workspace lifecycle
------------------------------------------------------------

Implement:

- create;
- configure;
- rename;
- suspend;
- close;
- archive;
- cancel;
- reopen if supported;
- remove from switcher;
- session/access effects;
- policy preservation;
- member effects;
- job effects.

Evidence must not be hard-deleted because a Workspace or Organization closes.

Legal Hold and immutable storage rules must prevail.

------------------------------------------------------------
7.6 Organization lifecycle
------------------------------------------------------------

Implement coherent behavior for:

- ACTIVE;
- SUSPENDED;
- ARCHIVED;
- closing/terminated state if represented.

Define effects on:

- Workspaces;
- memberships;
- sessions;
- SSO;
- SCIM;
- invites;
- API credentials;
- billing;
- Evidence;
- jobs;
- audit.

Phase 4 completion:

- Enterprise can be provisioned end-to-end;
- every Workspace family has a complete lifecycle;
- closure never violates custody;
- Enterprise state is explicit;
- first owner can complete setup.

Run full API/Web/Worker/shared typechecks and tests after Phase 4.

============================================================
8. PHASE 5 — INVITATION & EXTERNAL ACCESS COMPLETION
============================================================

Goal: Complete every internal and external access lifecycle.

------------------------------------------------------------
8.1 Organization invitations
------------------------------------------------------------

Support:

- governance-only;
- selected Workspace assignments;
- role per assignment;
- existing user;
- new user;
- multiple Workspaces;
- expiration;
- revocation;
- resend;
- idempotent acceptance;
- concurrent acceptance;
- archived/closed target denial;
- email binding;
- complete audit.

------------------------------------------------------------
8.2 Existing-user experience
------------------------------------------------------------

After acceptance:

- preserve Personal Space;
- preserve personal plan;
- refresh context;
- consume assignedWorkspaceIds;
- show Organization name;
- show assigned Workspaces;
- show “Open Workspace”;
- show chooser for multiple assignments;
- governance-only success without fake switch target;
- no unintended automatic switch.

------------------------------------------------------------
8.3 New-user experience
------------------------------------------------------------

Implement:

invite
→ registration/login
→ invitation token preservation
→ email/identity verification
→ OAuth/SSO return
→ account/Personal bootstrap where applicable
→ acceptance
→ membership orchestration
→ success/open Workspace

Do not lose the token through redirect.

Do not allow a different verified account to accept the invitation.

------------------------------------------------------------
8.4 Other invitation families
------------------------------------------------------------

Complete and preserve distinction between:

- Owned Workspace invite;
- Organization invite;
- Enterprise owner invite;
- Collaboration-team invite;
- Reviewer invite;
- external portal access;
- Evidence request recipient;
- Intake submission.

------------------------------------------------------------
8.5 External access
------------------------------------------------------------

For:

- reviewers;
- Intake submitters;
- Evidence request recipients;
- signed share users;
- public verification;
- portal users;

implement:

- scoped token/grant;
- tenant and resource binding;
- expiry;
- revocation;
- intended permissions;
- no Organization browsing;
- no implicit Workspace membership;
- access audit;
- download/comment/review controls.

Migrate web and mobile flows where applicable.

Phase 5 completion:

- every invitation works for existing and new identities;
- external access is explicit and scoped;
- all acceptance surfaces consume backend results;
- no token is lost through authentication.

============================================================
9. PHASE 6 — EVIDENCE SCOPE, CUSTODY & POLICY CLOSURE
============================================================

Goal: Bind every Evidence Operations object to authoritative ownership, policy, storage, and custody scope.

------------------------------------------------------------
9.1 Data ownership map
------------------------------------------------------------

Audit and canonicalize ownership for:

- Evidence;
- Cases;
- Reports;
- Verification packages;
- Intake links/submissions;
- Evidence requests;
- Review workflows;
- coding schemas;
- Redactions;
- AI outputs;
- Retention policies;
- Legal Holds;
- destruction actions;
- Audit events;
- notifications;
- shares;
- API keys;
- integration configs;
- storage add-ons;
- Worker jobs.

Every operational object must have an authoritative path to Workspace.

------------------------------------------------------------
9.2 Upload and finalize binding
------------------------------------------------------------

Bind:

upload session
→ intended Workspace
→ Evidence record
→ storage key
→ uploader
→ policy context
→ completion request
→ Worker jobs

The Workspace selected at upload start must not change silently at finalize.

Finalize must verify:

- user remains authorized;
- upload session Workspace;
- Evidence Workspace;
- storage tenant/key;
- request context/version;
- expected parts/hash;
- policies.

------------------------------------------------------------
9.3 Case/Evidence/Report scope
------------------------------------------------------------

Prevent:

- linking Evidence to Case in another Workspace;
- generating a Report under a different Workspace;
- packaging Evidence from mixed tenants;
- bulk cross-Workspace mutations;
- cross-Organization exports without governed workflow.

------------------------------------------------------------
9.4 Policy hierarchy
------------------------------------------------------------

Implement one canonical policy precedence model:

platform safety baseline
→ Organization policy
→ Workspace policy
→ Case-specific restriction
→ Evidence-specific Legal Hold

Define for:

- retention;
- Legal Hold;
- destruction;
- AI;
- sharing;
- export;
- MFA/session where relevant;
- data residency;
- storage lock.

Child scope may strengthen but not illegally weaken mandatory parent policy.

Legal Hold always prevents conflicting destruction.

------------------------------------------------------------
9.5 Policy version/snapshot
------------------------------------------------------------

Record the applicable policy/version or decision context for custody-sensitive actions where required.

Do not allow a later policy edit to rewrite historical meaning.

------------------------------------------------------------
9.6 No implicit transfer
------------------------------------------------------------

Never transfer Evidence by editing teamId/workspaceId.

Personal → Organization, Workspace A → B, or Organization A → B requires a future or existing explicit governed copy/export/transfer workflow with:

- authorization;
- policy validation;
- new custody event;
- source preservation;
- destination provenance.

If no governed transfer exists, deny transfer.

------------------------------------------------------------
9.7 Worker/storage scope
------------------------------------------------------------

Ensure every Worker:

- loads persisted object;
- derives Workspace;
- validates related objects;
- writes output to the same tenant;
- preserves retry tenant;
- cannot redirect via job payload.

Phase 6 completion:

- every object ownership path is explicit;
- upload/finalize cannot cross context;
- Case/Evidence/Report relationships cannot cross tenant;
- policy precedence is canonical;
- custody history is preserved.

============================================================
10. PHASE 7 — CONTEXT SAFETY & OPERATIONAL NAVIGATION
============================================================

Goal: Make context switching safe across the entire application and make navigation reflect operational authority.

------------------------------------------------------------
10.1 Dirty-state registry
------------------------------------------------------------

Wire all relevant forms:

- Capture;
- upload;
- finalize;
- Case create/edit;
- Intake;
- Evidence requests;
- Report composition;
- Review;
- Redaction;
- Retention;
- Legal Hold;
- Workspace settings;
- Organization settings;
- billing changes.

Prompt before switching with unsaved Workspace-scoped work.

------------------------------------------------------------
10.2 Cache and draft isolation
------------------------------------------------------------

Tenant-key:

- data caches;
- draft storage;
- localStorage;
- sessionStorage;
- IndexedDB;
- optimistic state;
- polling state;
- upload state.

Old Workspace data must disappear immediately after switch.

------------------------------------------------------------
10.3 In-flight isolation
------------------------------------------------------------

Implement:

- context generation/version;
- request abort where possible;
- stale response rejection;
- mutation context assertion;
- upload/finalize context binding;
- polling cancellation/restart.

------------------------------------------------------------
10.4 Route behavior
------------------------------------------------------------

After switch:

- record-scoped pages go to safe Workspace home unless ownership in new context is proven;
- account-wide settings may remain;
- Organization admin routes re-evaluate;
- no previous-tenant record remains mounted.

------------------------------------------------------------
10.5 Context visibility
------------------------------------------------------------

Keep the persistent context chip.

Add clear context banners/labels on:

- Capture;
- Evidence finalize;
- new Case;
- Report;
- Share;
- Retention;
- Legal Hold;
- Workspace billing;
- Organization administration.

Show:

- Workspace;
- Organization;
- applicable policy where important.

------------------------------------------------------------
10.6 Operational navigation
------------------------------------------------------------

Build navigation from:

- active context kind;
- Workspace membership;
- Organization role;
- capabilities;
- account plan;
- Workspace subscription;
- Enterprise contract;
- route availability.

Separate:

- Personal navigation;
- Owned Workspace navigation;
- Organization Workspace operations;
- Organization administration;
- Platform administration.

Do not use scattered plan literals.

Phase 7 completion:

- safe switching across all workflows;
- no stale tenant UI;
- active context obvious;
- navigation matches real authority.

Run full integration gates after Phase 7.

============================================================
11. PHASE 8 — SSO/SCIM CLOSURE
============================================================

Goal: Complete current Enterprise identity implementation safely.

------------------------------------------------------------
11.1 Existing mappings
------------------------------------------------------------

Audit every pre-remediation ExternalIdentityMapping.

Revalidate:

- connection;
- Organization;
- immutable subject;
- verified domain;
- email;
- account linkage.

Quarantine mappings that cannot satisfy the current policy.

Repeat login must not bypass the new linking guard.

------------------------------------------------------------
11.2 SAML
------------------------------------------------------------

Require:

- signature;
- consumed signed assertion;
- issuer pinned;
- audience required;
- InResponseTo;
- replay prevention;
- time conditions;
- certificate handling;
- normalized/verified identity claims.

Legacy missing issuer/audience must fail closed and enter remediation state.

------------------------------------------------------------
11.3 OIDC
------------------------------------------------------------

Behaviorally test:

- signature/JWKS;
- issuer;
- audience;
- expiry;
- nonce;
- state;
- subject;
- userinfo-sub equality;
- verified email;
- tenant restrictions;
- key rotation.

------------------------------------------------------------
11.4 SCIM through orchestrator
------------------------------------------------------------

SCIM create/activate/deactivate must use the Phase 3 orchestrator.

Support:

- Organization membership policy;
- selected Workspace assignments;
- roles;
- externalId;
- idempotency;
- reactivation;
- source-aware access.

------------------------------------------------------------
11.5 Group mapping
------------------------------------------------------------

Implement:

- Organization role mapping;
- Workspace assignment mapping;
- Workspace role mapping;
- review/collaboration mapping where supported;
- deterministic precedence;
- source-aware removal.

Remove/disable any UI that stores mappings runtime ignores.

------------------------------------------------------------
11.6 Deprovisioning
------------------------------------------------------------

On SCIM deactivate/removal:

- revoke/suspend governed access;
- remove switch targets;
- heal context;
- revoke sessions;
- revoke Organization-controlled API credentials;
- stop new operations;
- preserve Evidence/audit;
- release seats according to Phase 9 rules;
- reassign open responsibilities where supported.

Phase 8 completion:

- old mappings cannot bypass policy;
- SAML/OIDC fail closed;
- SCIM is coherent;
- group mapping works;
- deprovisioning is complete.

============================================================
12. PHASE 9 — BILLING, PLAN & CONTRACT CANONICALIZATION
============================================================

Goal: Establish one source of truth for commercial scope and effective capabilities.

------------------------------------------------------------
12.1 Canonical resolver
------------------------------------------------------------

Create one canonical resolver producing:

- account plan;
- Personal entitlements;
- Owned Workspace subscription;
- Enterprise Organization contract;
- Workspace allocation;
- effective limits;
- effective capabilities;
- billing owner;
- seat consumption.

All API/navigation/UI/checkout consumers must use it.

------------------------------------------------------------
12.2 Account plans
------------------------------------------------------------

Canonical:

- FREE;
- PAYG;
- PRO.

Define:

- limits;
- storage;
- owned Workspace eligibility;
- billing owner;
- downgrade behavior.

------------------------------------------------------------
12.3 Workspace subscriptions
------------------------------------------------------------

TEAM applies to Owned Workspace behavior.

Define:

- owner;
- members;
- limits;
- storage;
- cancellation;
- transfer;
- downgrade;
- over-limit behavior.

TEAM must never provision Enterprise.

------------------------------------------------------------
12.4 Enterprise contract
------------------------------------------------------------

Use the Phase 4 canonical contract.

Define:

- Organization;
- seats;
- storage;
- Workspaces;
- billing owner;
- contract state;
- effective date;
- cancellation/termination;
- feature entitlements.

------------------------------------------------------------
12.5 Billing surfaces
------------------------------------------------------------

`/billing`:

- account/personal;
- Owned Workspace subscriptions owned by user;
- personal payment methods/invoices;
- no customer owner leakage.

Organization Billing:

- Enterprise contract;
- seats;
- Organization invoices;
- allocations;
- capability-gated.

------------------------------------------------------------
12.6 Checkout and lifecycle
------------------------------------------------------------

Unify:

- checkout validation;
- plan transitions;
- cancellation;
- downgrade;
- failed payment;
- subscription status;
- grace periods;
- Workspace operational effects;
- Evidence preservation.

Billing failure must not destroy Evidence.

------------------------------------------------------------
12.7 Seats
------------------------------------------------------------

Define exact rules for:

- ACTIVE;
- SUSPENDED;
- REVOKED;
- governance-only user;
- security/billing admin;
- external reviewer;
- multi-Workspace user;
- same-Organization multi-Workspace user;
- managed identity.

Implement consistently in contract, billing UI, enforcement, and tests.

Phase 9 completion:

- one resolver;
- no contradictory plan sources;
- TEAM distinct from Enterprise;
- Billing pages consistent;
- seats deterministic.

============================================================
13. PHASE 10 — ENTERPRISE IDENTITY ADVANCED
============================================================

Goal: Support mature Enterprise and high-security identity modes.

------------------------------------------------------------
13.1 Mandatory SSO
------------------------------------------------------------

Implement Organization-scoped enforcement.

When accessing an Organization context that requires SSO:

- password/OAuth/magic-link authentication not satisfying policy must not authorize that context;
- existing sessions re-evaluate;
- invite acceptance does not bypass;
- recovery/break-glass is explicit.

Normal Personal context may remain accessible for normal linked accounts.

------------------------------------------------------------
13.2 Managed identity
------------------------------------------------------------

Add explicit identity/account mode such as:

- STANDARD;
- MANAGED_ENTERPRISE.

MANAGED_ENTERPRISE may support:

- Organization ownership;
- no Personal Space;
- SSO-only;
- controlled email/profile;
- no personal export;
- Organization-controlled lifecycle;
- immediate deprovisioning;
- session policy;
- account deletion restrictions.

Do not silently convert existing Standard accounts.

------------------------------------------------------------
13.3 Government/high-security mode
------------------------------------------------------------

Support policy profile for:

- managed-only identities;
- mandatory SSO;
- restricted sessions;
- no Personal Space;
- stricter export/share;
- data residency;
- break-glass;
- stronger audit;
- support-access restrictions.

------------------------------------------------------------
13.4 Break-glass
------------------------------------------------------------

Implement:

- protected emergency identity/process;
- step-up authentication;
- reason;
- limited scope;
- duration;
- alerting;
- full audit;
- post-use review.

------------------------------------------------------------
13.5 Domain/session policies
------------------------------------------------------------

Implement:

- globally conflict-safe domain claims;
- verification lifecycle;
- recheck/expiry;
- session lifetime;
- concurrent session policy;
- session revocation;
- identity-provider requirements.

------------------------------------------------------------
13.6 Platform support access
------------------------------------------------------------

Implement separate audited support access:

request
→ reason
→ target Organization/Workspace
→ approval/policy
→ limited capability scope
→ expiration
→ visible support-mode banner
→ audit
→ explicit exit/revoke

Do not use ordinary Workspace membership or Platform-admin bypass.

Phase 10 completion:

- mandatory SSO real;
- managed identity real;
- Government mode coherent;
- break-glass/support access explicit;
- domain/session policy enforced.

Run full integration gates after Phase 10.

============================================================
14. PHASE 11 — URL, DEEP-LINK & UNIFIED AUDIT
============================================================

Goal: Make tenant context explicit in navigation and reconstructable in audit.

------------------------------------------------------------
14.1 Workspace-aware URLs
------------------------------------------------------------

Migrate sensitive operational routes toward:

/w/{workspaceSlugOrId}/home
/w/{workspaceSlugOrId}/capture
/w/{workspaceSlugOrId}/cases/{caseId}
/w/{workspaceSlugOrId}/evidence/{evidenceId}
/w/{workspaceSlugOrId}/reports/{reportId}

URL context is not authorization.

Always validate:

- Workspace access;
- resource ownership;
- URL/resource match.

------------------------------------------------------------
14.2 Deep links
------------------------------------------------------------

When opening a link under a different active context:

- derive owning Workspace;
- authorize;
- offer/perform safe explicit context transition;
- prevent stale state;
- deny without existence leakage if unauthorized.

------------------------------------------------------------
14.3 Emails and notifications
------------------------------------------------------------

Migrate:

- invitation links;
- Evidence links;
- Case links;
- Report links;
- Review links;
- Legal Hold links;
- Evidence request links;
- notification targets.

Carry canonical Workspace context where appropriate.

Preserve public token routes separately.

------------------------------------------------------------
14.4 Unified audit contract
------------------------------------------------------------

Create one canonical tenant audit event contract containing where applicable:

- organizationId;
- workspaceId;
- actor;
- actor type;
- target;
- action;
- previous state;
- new state;
- request ID;
- timestamp;
- result;
- source;
- identity source;
- policy version;
- custody relevance.

Use appropriate durable/immutable sinks without destroying existing audit history.

------------------------------------------------------------
14.5 Event coverage
------------------------------------------------------------

Migrate:

- membership;
- invitations;
- Workspace switching;
- Enterprise lifecycle;
- SSO/SCIM;
- identity linking;
- sessions;
- support/break-glass;
- Evidence operations;
- review;
- redaction;
- retention;
- Legal Hold;
- destruction;
- reports;
- sharing;
- billing.

Phase 11 completion:

- sensitive links are context-aware;
- deep links safe;
- email/notifications migrated;
- audit is tenant-coherent;
- custody events reconstructable.

============================================================
15. PHASE 12 — REPOSITORY CONVERGENCE & DEPLOYMENT READINESS
============================================================

Goal: Remove the hybrid architecture and prove one final canonical system.

------------------------------------------------------------
15.1 Remove legacy projections
------------------------------------------------------------

Migrate all consumers and remove:

- old envelope.organizations if superseded;
- availableWorkspaces;
- empty accountMenu compatibility projection;
- old context types;
- old classification adapters;
- plan-literal navigation;
- old membership helpers;
- old invitation projections.

------------------------------------------------------------
15.2 Remove fallbacks
------------------------------------------------------------

After all producers/readers migrate:

- make workspaceKind non-null if target migration supports it;
- remove runtime plan/isPersonal inference;
- remove Organization-kind inference;
- remove temporary compatibility adapters;
- remove old SSO/linking fallback;
- remove deprecated URL fallbacks after caller migration.

------------------------------------------------------------
15.3 Remove duplicates/dead code
------------------------------------------------------------

Repository-wide:

- obsolete routes;
- duplicate components;
- dead helpers;
- legacy APIs;
- generated twins;
- redirects;
- stale docs;
- stale fixtures;
- stale tests;
- approximately 287 inert `.js` test twins.

Delete only after proving zero dependencies.

Do not delete valid CollaborationTeam behavior or TEAM billing behavior because of naming overlap.

------------------------------------------------------------
15.4 Migrate every surface
------------------------------------------------------------

Prove completion across:

- API;
- Web;
- Mobile;
- Worker;
- shared packages;
- generated clients;
- emails;
- notifications;
- middleware;
- scripts;
- seeds;
- factories;
- docs;
- tests.

------------------------------------------------------------
15.5 Migration code review
------------------------------------------------------------

Do not apply migrations.

Statically verify:

- clean-database order;
- legacy backfill order;
- constraints;
- ambiguous-row handling;
- indexes;
- FKs;
- rollback/forward strategy;
- no destructive data loss;
- seed/factory compatibility.

------------------------------------------------------------
15.6 Final architecture audit
------------------------------------------------------------

Audit the final code—not prior reports.

Prove:

- one Account model;
- Personal/Owned/Organization separation;
- one membership orchestrator;
- complete Enterprise lifecycle;
- invitations complete;
- Evidence ownership/custody complete;
- safe context switching;
- SSO/SCIM complete;
- Billing canonical;
- managed identity complete;
- URLs/audit complete;
- zero active legacy architecture.

============================================================
16. REQUIRED CROSS-PHASE TEST SCENARIOS
============================================================

By the end, code/tests must cover:

1. FREE Personal only.
2. PAYG Personal only.
3. PRO Personal only.
4. PRO with Owned Workspace.
5. TEAM Owned Workspace owner.
6. TEAM member.
7. Existing PRO user joins Enterprise Organization.
8. New user accepts Enterprise invitation.
9. Governance-only Organization member.
10. Member assigned to one of several Organization Workspaces.
11. Reviewer.
12. Billing admin without Evidence access.
13. Security admin without Evidence access.
14. Organization owner.
15. Suspended member.
16. Revoked member.
17. Archived Organization.
18. Closed Workspace.
19. Platform admin without customer access.
20. Explicit support access.
21. SSO JIT.
22. SCIM provision.
23. SCIM deactivate.
24. Managed Enterprise identity.
25. Government/high-security identity.
26. Personal → Organization switch.
27. Organization → Personal switch.
28. Switch during Capture.
29. Switch during upload/finalize.
30. Switch during Case/Report/Review.
31. Cross-Workspace Evidence/Case linking denied.
32. Cross-tenant Report/package denied.
33. Legal Hold blocks destruction.
34. Policy precedence enforced.
35. Billing and seats consistent.
36. Deep link to authorized different Workspace.
37. Unauthorized deep link concealed.
38. Worker output remains in source tenant.
39. No implicit Evidence transfer.
40. Audit reconstructs the operation.

Use behavioral/service/integration tests wherever possible.

============================================================
17. VALIDATION GATES
============================================================

At final completion run all available non-destructive gates:

- Prisma validate;
- Prisma generate;
- migration static validation;
- shared packages typecheck/build;
- API typecheck/build;
- API full tests;
- Worker typecheck/build/tests;
- Web typecheck/tests/build;
- Mobile typecheck/tests/build where supported;
- generated-client drift checks;
- repository static contracts;
- final legacy searches.

Do not apply migrations.
Do not deploy.
Do not commit or push.

If database-dependent runtime scenarios cannot run:

- mark runtime application BLOCKED;
- do not invalidate code completion;
- do not claim live DB proof;
- provide the exact later deployment checklist.

============================================================
18. REQUIRED FINAL REPORT
============================================================

Return one report only after Phase 12.

Include:

1. Executive result.
2. Final domain graph.
3. Phase 2 implementation.
4. Phase 3 implementation.
5. Phase 4 implementation.
6. Phase 5 implementation.
7. Phase 6 implementation.
8. Phase 7 implementation.
9. Phase 8 implementation.
10. Phase 9 implementation.
11. Phase 10 implementation.
12. Phase 11 implementation.
13. Phase 12 convergence.
14. Schema/migration files authored.
15. Canonical services and contracts.
16. All migrated producers.
17. All migrated consumers.
18. Web/mobile/worker status.
19. Tests added/updated.
20. Exact validation commands/results.
21. Files added/changed/deleted.
22. Legacy files removed.
23. Compatibility fallbacks remaining.
24. Blocked runtime/deployment items.
25. Remaining risks.
26. Confirmation that nothing was committed/pushed and no migration was applied.

For each phase label:

- COMPLETE;
- INCOMPLETE;
- BLOCKED;
- NOT APPLICABLE.

============================================================
19. FINAL DEFINITION OF DONE
============================================================

The unified program is complete only if:

- WorkspaceKind is authoritative.
- OrganizationKind is authoritative.
- `/v1/orgs` ambiguity is resolved.
- all creators/readers use canonical classification.
- all membership writers use one orchestrator.
- grant sources and revocation are coherent.
- Enterprise activation works end-to-end.
- every Workspace family has a complete lifecycle.
- invitations work for new and existing users.
- external access is scoped.
- every object has authoritative Workspace ownership.
- upload/finalize cannot cross context.
- custody/policy precedence is coherent.
- context switching is safe across all forms/requests.
- navigation reflects actual context and capabilities.
- SSO/SAML/OIDC/SCIM are closed.
- Billing/plan/contract sources are canonical.
- mandatory SSO and managed identity are real.
- Government mode and support access are explicit.
- URLs/deep links are Workspace-aware.
- tenant/custody audit is unified.
- legacy projections/fallbacks are removed.
- all repository consumers are migrated.
- duplicate/dead code is removed after zero-dependency proof.
- all static tests/typechecks/builds pass.
- migrations are ready for later application.

If any phase remains incomplete, do not claim the unified program is complete.

Begin with the Phase 2 dependency map, then continue through Phase 12 without pausing at phase boundaries.