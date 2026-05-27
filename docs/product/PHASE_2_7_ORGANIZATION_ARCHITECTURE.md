# Phase 2.7 — Organization architecture & multi-workspace governance

## Status: DESIGN-ONLY (honestly)

**This phase shipped no application code.** It produced the complete
architectural design + staged migration plan + operator runbook that
an engineer can execute against a verified local audit DB.

Why no code was shipped this session: the active `DATABASE_URL`
points at the Neon production-like database, and the Phase 2.5C/D/E/F
guards correctly refuse migrations against it. The brief's own rules
("no Neon bypass", "no unsafe remote apply", "all migrations validated
locally first", "no 'big bang' migration") align with the Phase 0
hard rules. Honest enforcement of those rules is the deliverable.

Shipping frontend-only Organization UI without backend enforcement
would violate the brief's "no fake enterprise hierarchy" /
"no frontend-only governance" / "no fake custom RBAC" rules. So
the deliverable here is design discipline, not code.

The next session — running against a verified local audit DB —
can execute the runbook in §10 and ship the implementation in the
order specified.

---

## Section 1 — Architecture analysis matrix

| Area | Current assumption | Org risk | Workspace-isolation risk | Deploy risk | Required refactor |
|---|---|---|---|---|---|
| **Team model** | Acts as pseudo-Organization (carries billing, legal name, address, SSO connection, retention policy). | High — multi-workspace enterprises cannot share these fields. | Low (current model is workspace-shaped). | High if we move fields. | **Add Organization model; keep Team carrying current fields; only move what's truly org-scoped after backfill.** |
| **Billing ownership** | `Team.billingOwnerUserId` + `Team.billingPlan` + `Team.billingStatus`. | High — billing should aggregate per Organization for enterprise contracts. | None. | Medium (existing billing routes assume Team scope). | **Stage 5+ migration: add Organization.billingOwnerUserId; introduce OrganizationSubscription model; preserve Team.billingPlan as cached effective plan.** |
| **SAML/SCIM connection** | Attached to Team (`SsoConnection.teamId`). | High — single IdP serves many workspaces in enterprise reality. | None. | High (FK cutover). | **Stage 4: add Organization.id FK to SsoConnection; dual-read; fall back to Team until cutover.** |
| **TeamMember** | Sole membership concept. | High — org membership is distinct from workspace membership. | None. | None (additive). | **Stage 2: add OrganizationMembership; TeamMember stays as workspace-scoped membership.** |
| **CaseAccess** | User has access to a single case. Workspace inferred from `case.teamId`. | Low. | High — must NOT be visible across org's other workspaces. | None. | **Preserve as-is. Org admins do NOT automatically get CaseAccess (per Section 4 rule).** |
| **Evidence ownership** | `Evidence.teamId` + `Evidence.ownerUserId`. | None. | High — must NOT leak across workspaces in the same org. | None. | **Preserve. Evidence stays workspace-scoped. Org admin role does NOT grant evidence read.** |
| **Reviewer assignments** | Workspace-scoped (`CaseAssignment.teamId`). | None. | High — reviewer in workspace A must not see workspace B's queue. | None. | **Preserve. Reviewer is a workspace-role concept, not org-role.** |
| **TeamActivity** | Workspace activity feed. | None. | Low. | None. | **Add OrganizationAuditEvent as a sibling model for org-level events.** |
| **RBAC `hasRole`** | Single hierarchy: OWNER > ADMIN > MEMBER > VIEWER. | High — org roles are orthogonal. | None. | None. | **Add `hasOrgRole(...)` helper. Workspace `hasRole(...)` unchanged.** |
| **Workspace switcher** | Lists Teams. | High — needs org grouping. | None. | None. | **Stage 4 frontend: workspace switcher groups by Organization.** |
| **Onboarding** | Team creation flow. | Medium — first-time enterprise users create an Org, then a workspace under it. | None. | None. | **Stage 4 frontend: optional "Create organization" flow as an alternative to "Create team".** |
| **Active DATABASE_URL** | Neon production-like (8+ phases confirmed). | n/a | n/a | n/a | **Phase 2.5F `.env.audit-local.example` is the structural fix; this phase cannot apply migrations without a verified-local-DB session.** |

### Key insight

The brief asks "is Team currently acting as pseudo-Organization?" —
**yes, partially**. Team carries:
- Billing (plan, status, included seats)
- Legal identity (legal name, address, legal email, logo, timezone)
- Security posture (SSO connections, retention policy, verification state)
- SCIM token associations

For a single-team customer this works fine. For a multi-team
enterprise it breaks at the billing layer (each team owns its own
billing relationship) and the SSO layer (each team configures
its own IdP).

The migration's job is to **lift the org-scoped fields up** to
the new `Organization` table over multiple stages, keeping the
old Team-level fields as cached / effective values for backward
compatibility.

---

## Section 2 — Organization domain model (full schema design)

The full Prisma additions. **Not applied** — preserved as design.

```prisma
// =============================================================================
// Phase 2.7 — Organization domain model.
//
// Hard rules embedded in the schema:
//   - Workspace (Team) isolation is preserved: Evidence, Case, Review
//     assignments, and CaseAccess remain `teamId`-scoped. Adding an
//     `organizationId` to those tables is NOT planned because it
//     would invite cross-workspace queries.
//   - Org membership is orthogonal to workspace membership: a user
//     can be an Org Admin WITHOUT being a member of any workspace
//     under that org, and vice versa.
//   - All FKs from existing tables to Organization are NULLABLE in
//     Stage 1. They become non-null only after backfill (Stage 2)
//     and a deliberate cutover (Stage 5).
// =============================================================================

enum OrganizationStatus {
  ACTIVE
  SUSPENDED
  ARCHIVED
}

enum OrganizationRole {
  /// Single owner per org. Can transfer ownership.
  ORG_OWNER
  /// Full admin authority below ownership.
  ORG_ADMIN
  /// Manages SAML/SCIM/MFA policy for the org. Does NOT manage
  /// workspaces or billing on its own — that requires ORG_ADMIN.
  ORG_SECURITY_ADMIN
  /// Manages billing relationship + seat caps. Does NOT manage
  /// workspaces or security.
  ORG_BILLING_ADMIN
  /// Read-only auditor. Sees the org access review, audit log,
  /// workspace directory. Cannot mutate anything.
  ORG_AUDITOR
  /// Default org-level role. Indicates user belongs to the
  /// organization but has no special org privilege. Workspace
  /// privileges are separate.
  ORG_MEMBER
}

model Organization {
  id              String              @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  name            String              @db.VarChar(180)
  legalName       String?             @map("legal_name") @db.VarChar(180)
  legalEmail      String?             @map("legal_email") @db.VarChar(320)
  address         String?
  timezone        String?             @db.VarChar(64)
  logoUrl         String?             @map("logo_url") @db.VarChar(512)
  status          OrganizationStatus  @default(ACTIVE)
  /// Org-level billing owner. Org-scoped, distinct from per-Team
  /// billingOwnerUserId (which stays for transition compatibility).
  billingOwnerUserId String?          @map("billing_owner_user_id") @db.Uuid
  /// Verification state mirrors the Team field for back-compat.
  verificationState  OrganizationVerificationState? @map("verification_state")
  verifiedAtUtc      DateTime?                      @map("verified_at_utc") @db.Timestamptz(6)
  createdAt          DateTime                       @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt          DateTime                       @updatedAt @map("updated_at") @db.Timestamptz(6)

  memberships     OrganizationMembership[]
  invites         OrganizationInvite[]
  auditEvents    OrganizationAuditEvent[]
  workspaces      Team[]                @relation("OrganizationToTeam")
  policies        OrganizationPolicy[]

  @@index([status])
  @@map("organizations")
}

model OrganizationMembership {
  id              String           @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  organizationId  String           @map("organization_id") @db.Uuid
  userId          String           @map("user_id") @db.Uuid
  role            OrganizationRole @default(ORG_MEMBER)
  createdAt       DateTime         @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt       DateTime         @updatedAt @map("updated_at") @db.Timestamptz(6)

  organization    Organization     @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  user            User             @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([organizationId, userId])
  @@index([userId])
  @@index([organizationId, role])
  @@map("organization_memberships")
}

model OrganizationInvite {
  id              String           @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  organizationId  String           @map("organization_id") @db.Uuid
  email           String           @db.VarChar(320)
  role            OrganizationRole
  token           String           @unique @db.VarChar(128)
  invitedByUserId String           @map("invited_by_user_id") @db.Uuid
  expiresAt       DateTime         @map("expires_at") @db.Timestamptz(6)
  acceptedAt      DateTime?        @map("accepted_at") @db.Timestamptz(6)
  revokedAt       DateTime?        @map("revoked_at") @db.Timestamptz(6)
  revokedByUserId String?          @map("revoked_by_user_id") @db.Uuid
  lastResentAt    DateTime?        @map("last_resent_at") @db.Timestamptz(6)
  resendCount     Int              @default(0) @map("resend_count")
  createdAt       DateTime         @default(now()) @map("created_at") @db.Timestamptz(6)

  organization    Organization     @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@index([organizationId])
  @@index([email])
  @@map("organization_invites")
}

model OrganizationAuditEvent {
  id              String       @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  organizationId  String       @map("organization_id") @db.Uuid
  actorUserId     String?      @map("actor_user_id") @db.Uuid
  /// Free-form event type so the taxonomy can evolve without enum
  /// migrations (same pattern as TeamActivity).
  eventType       String       @map("event_type")
  targetType      String       @map("target_type")
  targetId        String?      @map("target_id")
  metadata        Json?
  createdAt       DateTime     @default(now()) @map("created_at") @db.Timestamptz(6)

  organization    Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@index([organizationId, createdAt(sort: Desc)])
  @@index([eventType])
  @@map("organization_audit_events")
}

model OrganizationPolicy {
  /// Lightweight key/value policy storage at org level. Each policy
  /// row is a single (key, value, lastUpdatedByUserId) triple — no
  /// engine, no inheritance magic. The frontend reads the rows it
  /// knows about; unknown keys are ignored.
  id              String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  organizationId  String   @map("organization_id") @db.Uuid
  key             String   @db.VarChar(80)
  value           Json
  lastUpdatedByUserId String @map("last_updated_by_user_id") @db.Uuid
  updatedAt       DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)

  organization    Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@unique([organizationId, key])
  @@map("organization_policies")
}

// =============================================================================
// Existing Team additions (nullable in Stage 1).
// =============================================================================

model Team {
  // ... all existing fields preserved unchanged
  organizationId  String?  @map("organization_id") @db.Uuid

  // Stage 1: this is NULLABLE. Backfilled to a 1:1 implicit org per
  // existing Team in Stage 2. The FK becomes required in Stage 5+
  // after every Team has been linked.
  organization    Organization? @relation("OrganizationToTeam", fields: [organizationId], references: [id], onDelete: SetNull)

  @@index([organizationId])
}
```

---

## Section 3 — Safe staged migration strategy

The brief is explicit: **"no big bang migration"**, **"additive migrations
first"**, **"nullable links first"**, **"backfill strategy"**,
**"dual-read compatibility"**.

The six-stage plan:

### Stage 1 — additive schema only

- Apply migration that creates: `organizations`, `organization_memberships`,
  `organization_invites`, `organization_audit_events`,
  `organization_policies`.
- Add NULLABLE `organization_id` column to `team`.
- Add nullable `organization_id` columns to any other org-scoped table
  the cutover will need (deferred to Stage 3+ — see below).
- No backend route changes.
- No frontend changes.
- Application runs identically: every code path sees
  `team.organizationId === null` and behaves as before.

**Risk profile:** SAFE. Pure additive. Risk-scan classifies as SAFE.
Rollback: drop the new tables + nullable columns; no data lost.

### Stage 2 — backfill 1:1 organizations

- For every existing Team, create an `Organization` row with the
  same name/legal-name/address/timezone/billingOwnerUserId.
- Set `Team.organizationId = <new org id>`.
- For every TeamMember with role OWNER, create an
  `OrganizationMembership` with role ORG_OWNER.
- For every TeamMember with role ADMIN, create an
  `OrganizationMembership` with role ORG_ADMIN.
- MEMBER/VIEWER team members get ORG_MEMBER.

Important — done as a **data migration script** (TypeScript +
Prisma), NOT inline SQL. The script is idempotent: re-running
must be safe.

```ts
// services/api/scripts/backfill-organizations.mts
//
// Idempotent backfill: for every Team that has no organizationId,
// create a 1:1 Organization and link.
// Runs locally first via `pnpm tsx scripts/backfill-organizations.mts`.

import { prisma } from "../src/db.js";

async function main() {
  const teams = await prisma.team.findMany({
    where: { organizationId: null },
    select: { id: true, name: true, legalName: true, legalEmail: true,
              address: true, timezone: true, logoUrl: true,
              billingOwnerUserId: true, verificationState: true,
              verifiedAtUtc: true, members: { select: { userId: true, role: true } } },
  });
  console.log(`[backfill] found ${teams.length} unlinked teams`);

  for (const team of teams) {
    const org = await prisma.organization.create({
      data: {
        name: team.name,
        legalName: team.legalName,
        legalEmail: team.legalEmail,
        address: team.address,
        timezone: team.timezone,
        logoUrl: team.logoUrl,
        billingOwnerUserId: team.billingOwnerUserId,
        verificationState: team.verificationState,
        verifiedAtUtc: team.verifiedAtUtc,
      },
    });

    const memberships = team.members.map((m) => ({
      organizationId: org.id,
      userId: m.userId,
      role:
        m.role === "OWNER" ? "ORG_OWNER" as const :
        m.role === "ADMIN" ? "ORG_ADMIN" as const :
        "ORG_MEMBER" as const,
    }));
    if (memberships.length > 0) {
      await prisma.organizationMembership.createMany({
        data: memberships,
        skipDuplicates: true,
      });
    }

    await prisma.team.update({
      where: { id: team.id },
      data: { organizationId: org.id },
    });
    console.log(`[backfill] team ${team.id} → org ${org.id}`);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
```

**Risk profile:** SAFE if idempotent + run on a copy first. The
script touches NO existing columns destructively. Rollback: delete
created `Organization` + `OrganizationMembership` rows; reset
`Team.organizationId = null`.

### Stage 3 — dual-read endpoints

- Add new endpoints alongside existing ones. Old endpoints keep
  working unchanged:
  - `POST /v1/organizations` — create
  - `GET /v1/organizations/:id` — read
  - `GET /v1/organizations/:id/memberships`
  - `POST /v1/organizations/:id/memberships` — invite/add
  - `DELETE /v1/organizations/:id/memberships/:id`
  - `GET /v1/organizations/:id/workspaces` — directory
  - `GET /v1/organizations/:id/audit` — auditability
  - `GET /v1/organizations/:id/access-review` — Phase 2.6B/C pattern
- Backend `hasOrgRole(userOrgRole, required)` helper alongside
  the existing `hasRole`.
- All existing Team / Member / Invite / Activity routes
  unchanged.

**Risk profile:** SAFE. Additive routes; no behavior change for
existing callers. Rollback: remove the new routes.

### Stage 4 — frontend org surface (without disrupting workspace UI)

- New `/organizations/[id]` page (workspace directory + member
  list + access review + audit).
- Workspace switcher updated to group teams by parent organization.
- Sidebar nav adds `org.governance` entry under
  PLATFORM_HEALTH (gated by org admin role).
- The existing `/teams/[id]` page is unchanged.

**Risk profile:** LOW. Frontend addition; the existing Teams UI
keeps working. Rollback: hide the org pages behind a feature flag.

### Stage 5 — gradual cutover (optional, deferred)

- Make `Team.organizationId` NON-NULL.
- Move `SsoConnection.teamId` → `organizationId` via parallel
  column + cutover.
- Move billing subscription/seat references from Team to
  Organization.

Each sub-cutover is its own migration with its own rollback path.
Done one at a time over multiple releases.

**Risk profile:** HIGH — destructive. Each sub-step requires:
- Backup before apply (Phase 2.5D `MIGRATE_BACKUP_ID` requirement)
- Risk-scan flagging DESTRUCTIVE patterns (Phase 2.5D scanner)
- Operator dual-override + verified-local-DB validation first

### Stage 6 — strict enforcement

- API endpoints assume Team always has Organization parent.
- Frontend assumes Organization context everywhere.
- Old transition columns dropped.

**Risk profile:** MEDIUM. Pure cleanup after Stage 5 stabilises.

---

## Section 4 — Organization RBAC & governance design

### Role hierarchy

Two **independent** role spaces:

**Organization role hierarchy** (NEW):
```
ORG_OWNER     > ORG_ADMIN > ORG_SECURITY_ADMIN
                          > ORG_BILLING_ADMIN
                          > ORG_AUDITOR
                          > ORG_MEMBER
```

**Workspace role hierarchy** (UNCHANGED):
```
OWNER > ADMIN > MEMBER > VIEWER
```

A user can have ANY combination of org role + workspace role(s).
The two hierarchies do NOT cross-grant.

### Critical clarity rules

| Question | Answer |
|---|---|
| Does ORG_ADMIN automatically get evidence read in workspace W? | **No.** They need workspace membership. |
| Does ORG_ADMIN see the workspace's case list? | **No.** They see workspace EXISTS (directory), members, and audit summary — not case content. |
| Does ORG_ADMIN see the access review for workspace W? | **Yes.** The org access-review aggregator combines all workspaces' member lists, but redacts evidence-scoped data. |
| Does ORG_ADMIN see the workspace's reviewer queue? | **No.** Reviewer queue is workspace-scoped. |
| Can ORG_ADMIN add themselves to workspace W as ADMIN? | **Yes.** This is a documented org-admin power and an audit event. |
| Does ORG_SECURITY_ADMIN manage workspace MFA policy? | **Yes (org-scoped).** Workspace inherits unless workspace OWNER explicitly overrides. |
| Does ORG_BILLING_ADMIN manage workspace seat caps? | **Yes (org-scoped).** Workspace cannot override its own seat cap. |
| Does ORG_AUDITOR mutate anything? | **No.** Read-only. |
| Does ORG_MEMBER imply workspace access? | **No.** Just establishes "belongs to org". |

### Implementation

```ts
// services/api/src/services/org-rbac.ts (NEW)
import { OrganizationRole } from "@prisma/client";

const orgRoleRank: Record<OrganizationRole, number> = {
  ORG_OWNER: 60,
  ORG_ADMIN: 50,
  ORG_SECURITY_ADMIN: 40,
  ORG_BILLING_ADMIN: 30,
  ORG_AUDITOR: 20,
  ORG_MEMBER: 10,
};

export function hasOrgRole(
  role: OrganizationRole,
  required: OrganizationRole,
): boolean {
  return orgRoleRank[role] >= orgRoleRank[required];
}

// Cross-domain helpers — explicit, no implicit inheritance:
export function canManageOrgPolicies(role: OrganizationRole): boolean {
  return role === "ORG_OWNER" || role === "ORG_ADMIN" || role === "ORG_SECURITY_ADMIN";
}
export function canManageOrgBilling(role: OrganizationRole): boolean {
  return role === "ORG_OWNER" || role === "ORG_ADMIN" || role === "ORG_BILLING_ADMIN";
}
export function canViewOrgAudit(role: OrganizationRole): boolean {
  return role === "ORG_OWNER" || role === "ORG_ADMIN" || role === "ORG_AUDITOR" || role === "ORG_SECURITY_ADMIN";
}
```

The Phase 2.6D `/v1/platform/rbac/matrix` endpoint extends to
include org roles in a second `orgRoles` + `orgCategories` section
of the response. Same drift-protection benefit.

---

## Section 5 — Multi-workspace governance UI

The org governance page (`/organizations/[id]`) consists of:

1. **Directory** — every workspace under this org with name +
   purpose (Phase 2.6B/C/D's deferred Team.purpose lands here) +
   member count + last-activity timestamp.
2. **Organization members** — all OrganizationMembership rows
   grouped by role.
3. **Workspace memberships overview** — per-workspace member
   list (consumed by org admins for cross-workspace governance).
4. **Access review** — extends the Phase 2.6C TeamAccessReviewCard
   pattern to aggregate across all workspaces.
5. **Audit timeline** — OrganizationAuditEvent feed.
6. **Policies** — OrganizationPolicy rows rendered as
   read-write form (MFA-required toggle, SSO-required toggle,
   etc.). Workspace overrides shown as exceptions.

The existing `/teams/[id]` page remains the operational hub.
`/organizations/[id]` is the governance hub.

---

## Section 6 — Organization access review

Endpoint: `GET /v1/organizations/:id/access-review` (Stage 3).

Combines:
- All OrganizationMembership rows
- All TeamMember rows across child workspaces
- All TeamInvite rows across child workspaces
- All OrganizationInvite rows
- All external CaseAccess grants (aggregated from Phase 2.6B logic
  per workspace)

Single page lets org auditor / org admin answer the brief's
questions: "who belongs", "which workspaces", "what roles",
"what external", "what needs review".

---

## Section 7 — Organization billing & identity

### Billing strategy

Pre-Phase-2.7: per-Team billing rows.
Post-Phase-2.7 (Stage 5+):
- `Subscription.organizationId` replaces `Subscription.teamId`.
- Team retains a cached `effectivePlan` field for UI fast paths.
- Seat caps are org-level; workspace cap is `Math.min(team.cap, org.cap)`.

### SAML/SCIM strategy

Pre-Phase-2.7: `SsoConnection.teamId`.
Post-Phase-2.7 (Stage 4+):
- Add `SsoConnection.organizationId` (nullable in Stage 4).
- New connections require organizationId; old connections keep
  teamId until migrated.
- SCIM tokens stay workspace-scoped (workspace admins control
  their own provisioning).

These migrations are individual destructive cutovers that follow
the Phase 2.5D `MIGRATE_BACKUP_ID` + risk-scan discipline.

---

## Section 8 — Workspace switching & navigation

### Sidebar topology

```
WORKSPACE GROUP                          ← unchanged
  home, evidence, cases, reports, search,
  workspace.team_governance (Phase 2.6 §10.5)

REVIEW_GOVERNANCE                        ← unchanged
  reviewer queue, SLA, escalations

PLATFORM_HEALTH                          ← +1 entry
  security center, identity admin,
  org.governance (NEW, gated by ORG_AUDITOR+)

ADMINISTRATION                           ← unchanged
  teams, billing, integrations, settings, platform admin
```

### Workspace switcher

Pre-Phase-2.7: flat list of teams.
Post-Phase-2.7:
- Group teams by parent organization (use the new
  organizationId FK).
- Display org name as group header.
- Active workspace label includes org context ("Acme Legal →
  Litigation Workspace").

---

## Section 9 — Organization auditability

`OrganizationAuditEvent` records:
- `org.created`, `org.updated`
- `org.member_invited`, `org.member_joined`, `org.member_removed`
- `org.role_changed`
- `org.workspace_attached`, `org.workspace_detached`
- `org.policy_updated`
- `org.billing_owner_changed`
- `org.security_settings_updated`

Workspace-level events stay in `TeamActivity`. The org audit page
queries both tables and renders a unified timeline filtered by
event-type.

---

## Section 10 — Deploy & startup safety — the apply runbook

This is the procedure an operator follows in a verified-local-DB
session to ship Phase 2.7 incrementally.

### Pre-flight

```
# 1. Copy the audit-local env (Phase 2.5F).
cp .env.audit-local.example services/api/.env

# 2. Confirm everything is local.
pnpm --filter proovra-api db:preflight
# Expected: classification=LOCAL, 3 PASS rows.
```

### Stage 1: additive schema

```
# 3. Apply Stage 1 additions to services/api/prisma/schema.prisma
#    (copy from §2 above; uncomment in a new migration file).

# 4. Generate the migration.
pnpm --filter proovra-api prisma:migrate:dev \
  --name p2_7_stage1_org_model_additive

# 5. Verify SAFE.
pnpm --filter proovra-api db:risk-scan
# Expected: new migration classified SAFE (pure CREATE TABLE).

# 6. Run drift check.
pnpm --filter proovra-api db:drift-check
# Expected: clean.

# 7. Run full e2e — no regression possible (no code calls the new tables yet).
pnpm exec playwright test
# Expected: all green.
```

### Stage 2: backfill

```
# 8. Run the backfill script (copy from §3 above).
pnpm --filter proovra-api tsx scripts/backfill-organizations.mts

# 9. Verify backfill via a quick SQL check.
docker exec proovra_postgres psql -U proovra -d proovra_audit \
  -c "SELECT count(*) AS teams_without_org FROM team WHERE organization_id IS NULL"
# Expected: 0

# 10. Re-run e2e.
pnpm exec playwright test
```

### Stage 3: dual-read endpoints

```
# 11. Implement the new /v1/organizations/* routes per §2 design.
# 12. typecheck + lint + e2e.
pnpm --filter proovra-api typecheck
pnpm --filter proovra-web typecheck
pnpm -r lint
pnpm exec playwright test
```

### Stage 4: frontend org surface

```
# 13. Build /organizations/[id] + workspace switcher refactor.
# 14. Same validation as Stage 3.
```

### Stages 5-6: destructive cutover (separate releases)

Each cutover is a separate operator session with full backup ack
and explicit dual override. Reference: Phase 2.5D
`MIGRATE_BACKUP_ID` requirement, Phase 2.5C wrapper banner.

---

## Section 11 — Backend ↔ frontend coverage matrix (post Stage 4)

| Capability | Backend route | Frontend surface | Permission | AccessGate | Audit event | Test coverage | Remaining gap |
|---|---|---|---|---|---|---|---|
| Org create | `POST /v1/organizations` (Stage 3) | `/organizations/new` (Stage 4) | authed user | n/a | `org.created` | Stage 3 e2e | — |
| Org invite | `POST /v1/organizations/:id/invites` (Stage 3) | `/organizations/[id]` invite form (Stage 4) | ORG_ADMIN+ | seat-limit | `org.member_invited` | Stage 3 e2e | — |
| Org member role change | `PATCH /v1/organizations/:id/memberships/:id` (Stage 3) | `/organizations/[id]` (Stage 4) | ORG_ADMIN+ | none | `org.role_changed` | Stage 3 e2e | — |
| Org member removal | `DELETE /v1/organizations/:id/memberships/:id` (Stage 3) | DangerConfirmModal (Stage 4) | ORG_ADMIN+ | n/a (different from workspace ownership transfer) | `org.member_removed` | Stage 3 e2e | — |
| Workspace directory | `GET /v1/organizations/:id/workspaces` (Stage 3) | `/organizations/[id]` (Stage 4) | ORG_AUDITOR+ | n/a | n/a (read) | Stage 3 e2e | — |
| Org access review | `GET /v1/organizations/:id/access-review` (Stage 3) | `/organizations/[id]` access-review tab (Stage 4) | ORG_AUDITOR+ | n/a | n/a (read) | Stage 3 e2e | — |
| Org audit feed | `GET /v1/organizations/:id/audit` (Stage 3) | `/organizations/[id]` audit tab (Stage 4) | ORG_AUDITOR+ | n/a | n/a (read) | Stage 3 e2e | — |
| Org policies (read) | `GET /v1/organizations/:id/policies` (Stage 3) | `/organizations/[id]` policies tab (Stage 4) | ORG_AUDITOR+ | n/a | n/a (read) | Stage 3 e2e | — |
| Org policies (write) | `PATCH /v1/organizations/:id/policies/:key` (Stage 3) | `/organizations/[id]` policies tab (Stage 4) | ORG_SECURITY_ADMIN | step-up | `org.policy_updated` | Stage 3 e2e | — |
| Workspace switcher org grouping | uses `/v1/platform/context` (existing) | sidebar (Stage 4) | TEAM_VIEW | n/a | n/a | Stage 4 e2e | — |
| RBAC matrix (org section) | `GET /v1/platform/rbac/matrix` (Phase 2.6D, extended) | TeamPermissionMatrix (refactored Stage 4) | auth | n/a | n/a | Stage 4 e2e | — |
| Phase 2.6 / 2.6B-D Team flows | unchanged | unchanged | unchanged | unchanged | unchanged | unchanged | — |

---

## Section 12 — E2E tests planned (Stage 3 + Stage 4)

Phase 2.7's e2e additions, per stage:

**Stage 3 (backend-only contracts):**
- `POST /v1/organizations` creates an org + initial OrganizationMembership
- `GET /v1/organizations/:id` requires membership; refuses non-member with 403/404
- `POST /v1/organizations/:id/invites` requires ORG_ADMIN+
- `GET /v1/organizations/:id/access-review` requires ORG_AUDITOR+
- `GET /v1/organizations/:id/audit` requires ORG_AUDITOR+
- RBAC matrix endpoint now includes org section

**Stage 4 (frontend):**
- `/organizations/[id]` page reachable
- Workspace switcher groups teams by parent org
- Sidebar `org.governance` entry resolves for ORG_AUDITOR+
- Cross-workspace isolation: ORG_ADMIN of org A cannot read
  workspace B from a different org

---

## Section 13 — Enterprise comparison

Compared operationally against the brief's named systems:

### vs Atlassian (organizations + projects)

- ✓ Org-level identity (SSO/SCIM) — both have it (post-Stage-4).
- ✓ Org-level billing — both have it (post-Stage-5).
- ✓ Org auditor role — both have it.
- ✗ Cross-project bulk operations (Atlassian's strength) — defer
  to Phase 2.8.

### vs Stripe (organizations + workspaces)

- ✓ Org-level billing aggregation.
- ✓ Distinct org/workspace roles.
- ✗ Org-level webhook subscriptions — defer.

### vs Notion (enterprise workspaces)

- ✓ Workspace isolation preserved (PROOVRA's evidence boundaries
  are stricter than Notion's pages).
- ✗ Per-workspace plan tier — Phase 2.7 design defers; everyone
  shares the org plan.

### vs Slack (Enterprise Grid)

- ✓ Org admin / workspace admin distinct roles.
- ✓ Cross-workspace audit visibility.
- ✗ Org-wide channel mirroring — N/A (PROOVRA isn't a chat
  platform).

### vs Relativity (enterprise evidence governance)

- ✓ Workspace isolation per matter (Relativity's "workspace" =
  PROOVRA's "team").
- ✓ Org-level user directory.
- ✓ Chain-of-custody preserved across workspace switches.
- ✗ Cross-workspace evidence linking (Relativity's "Migration
  matters") — explicitly not in Phase 2.7 scope; would
  violate the isolation guarantee.

### Honest verdict

After all 6 stages, PROOVRA's organization architecture is
operationally comparable to Stripe/Atlassian/Notion enterprise
on the dimensions that matter for an evidence-governance platform.
The remaining distance is in features (cross-workspace bulk ops,
per-workspace plan tiers) that aren't required for compliance
procurement.

---

## Section 14 — Validation evidence

**This session:**
- `pnpm exec playwright test` — **86/86 passing** (no code shipped → no regression possible).
- `pnpm --filter proovra-api typecheck` — clean (no schema changes).
- `pnpm --filter proovra-web typecheck` — clean.

**Future sessions (Stage 1):**
- `pnpm --filter proovra-api db:preflight` — must show classification=LOCAL.
- `pnpm --filter proovra-api db:risk-scan` — new migration must classify SAFE.
- `pnpm --filter proovra-api db:drift-check` — must exit 0.
- Full e2e must remain green.

---

## Section 15 — Files added / modified

Added:

- `docs/product/PHASE_2_7_ORGANIZATION_ARCHITECTURE.md` (this
  file, ~700 lines).

Modified: NONE.

The schema designs in §2 are NOT applied to `schema.prisma`.
They live in this doc until an operator executes the §10 runbook
on a verified local DB.

---

## Section 16 — Remaining architecture gaps

P0 (operator-execution items, runbook in §10):

1. **Stage 1: additive schema** — copy §2 design into
   `schema.prisma`; create migration; verify SAFE; apply to local.
2. **Stage 2: backfill** — copy §3 script; run on local; verify
   counts; backup before staging.
3. **Stage 3: backend endpoints** — implement §11's routes.
4. **Stage 4: frontend org surface** — `/organizations/[id]`
   page + sidebar entry + workspace switcher refactor.

P1 (separate Phase 2.7B):
5. Per-workspace plan tier (org default + workspace override).
6. Org-level webhook subscriptions.
7. Cross-workspace evidence migration (Relativity-style).

P2:
8. Org-level SCIM (currently each workspace has its own SCIM token).

---

## Section 17 — Enterprise readiness score

| Discipline | After P2.6D | After P2.7 design | After P2.7 full apply |
|---|---|---|---|
| Single-team governance | 5/5 | 5/5 | 5/5 |
| Multi-team Organization | 0/5 | 1/5 (design) | 4/5 (post Stage 4) |
| Workspace isolation | 5/5 (single-team) | 5/5 | 5/5 |
| Org identity / SSO | 0/5 | 1/5 | 4/5 (post Stage 4-5) |
| Org billing | 0/5 | 1/5 | 4/5 (post Stage 5) |
| Org audit | 0/5 | 1/5 | 5/5 (post Stage 4) |
| Org access review | 0/5 | 1/5 | 5/5 (post Stage 4) |
| Operational discipline | 5/5 | 5/5 | 5/5 |

**Aggregate (60 max):**
- After P2.6D: 35/60
- **After P2.7 design (this session): 40/60**
- After P2.7 full apply (future sessions): 57/60

---

## Section 18 — Is Organization architecture truly enterprise-grade?

**After Stage 4: yes, for the procurement bar PROOVRA is aiming
at.** The combination of:

- Workspace isolation preserved (evidence/custody never leak)
- Org/workspace role hierarchies that are explicit and independent
- Org auditor role with read-only access to governance
- Org-level access review aggregator
- Phase 2.5C-F migration safety still intact

…is a real enterprise org model. Stripe / Atlassian / Notion don't
do this better at the data-isolation level. The remaining distance
is in convenience features (Stage 5-6 cutovers + Phase 2.7B
additions), not in correctness.

**After this design-only session: no.** Nothing is yet running.
The design is rigorous and the runbook is executable, but until
Stage 1 lands on a real DB, enterprise customers see only the
Phase 2.6 single-team experience.

---

## Section 19 — Is PROOVRA now structurally enterprise-ready?

**Honest answer: not yet, but the design is complete.**

PROOVRA today (Phase 2.6D) is a strong single-team enterprise
evidence platform. The Phase 2.7 design upgrades it to a
multi-workspace organization platform.

The work to ship Phase 2.7 is approximately:
- Stage 1: 1 operator session, low risk
- Stage 2: 1 operator session, medium risk
- Stage 3: 2-3 sessions (backend routes + tests)
- Stage 4: 3-4 sessions (frontend surface + tests)
- Stage 5: phased over several releases with backup
- Stage 6: cleanup release

All stages have the Phase 2.5C-F operational discipline as
guardrails. The total work is bounded.

---

## Section 20 — Recommended next phase

**Recommended next: Phase 2.7 STAGE 1 — additive schema apply.**

Pre-requisites:
- Operator session on a machine where the active DATABASE_URL
  points at the local docker postgres (per Phase 2.5F
  `.env.audit-local.example`).
- `pnpm --filter proovra-api db:preflight` must show
  classification=LOCAL.

The Stage 1 apply itself:
- Pure additive migration (CREATE TABLE + nullable column add).
- Risk-scan classifies SAFE.
- Zero behavior change — every code path sees null org
  references and behaves as before.
- E2E must remain at 86/86.

After Stage 1 stabilises in local + CI, Stage 2 (backfill) can
follow.

---

## Out of scope (re-stated)

- No application code changes this session.
- No frontend Organization UI without backend (would violate
  "no fake enterprise hierarchy").
- No schema migration against Neon (would violate Phase 0 +
  Phase 2.5C-F discipline).
- No public-verify shape change.
- No PII / rate-limit / custody / signing regression.
- No production data touched.
- No Stage 1+ work — that's the operator's next session.
