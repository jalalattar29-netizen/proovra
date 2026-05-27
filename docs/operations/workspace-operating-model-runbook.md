# Workspace / Team / Organization Operating Model — Phase B0 Runbook

**Audience:** product, support, sales-engineering, and customer success.

**Purpose:** explain PROOVRA's operational tenancy model in less than five minutes.

---

## 1. The three layers

| Layer | What it is | Required? | Owns |
|---|---|---|---|
| **Account / User** | The human operator. Has identity, MFA, login. | Yes | Personal settings, billing identity. |
| **Workspace** | The **primary operational unit**. Owns evidence, cases, reviewer queues, intake workflows, reports, verification packages. Auto-created as "Personal Workspace" for every user on first login. | Yes (auto-created) | Evidence, Cases, Reports, Verification Packages, Reviewer queues, Intake, Discussions. |
| **Organization** | An **optional governance overlay** that contains one or more workspaces. Provides retention templates, member governance, billing rollup, audit feeds. | No | Org-level policies, org members, org audit events. **Never owns evidence directly.** |

**One sentence to remember:** *Workspaces do the work. Organizations govern.*

---

## 2. Four real-world examples

### Solo journalist
- 1 Personal Workspace.
- No Team Workspace, no Organization.
- Captures, verifies, generates reports — never sees the word "Organization".

### Lawyer / small firm
- 1 Team Workspace.
- No Organization (optional).
- Invites colleagues by email; they get workspace memberships.

### Insurance enterprise
- 1 Organization ("Acme Insurance Co").
- 3 Team Workspaces under the org: "Auto Claims", "Property Claims", "Liability Review".
- Each workspace owns its own evidence + reviewer queue.
- The Organization publishes a single retention template (e.g., 7 years for claims evidence). All three workspaces inherit it unless their own admin overrides.

### Mixed enterprise + solo
- A user can have a Personal Workspace AND be a member of one or more Team Workspaces, AND belong to one or more Organizations. The top-bar workspace switcher moves between them.

---

## 3. What changed in Phase B0

### Backend
- New `/v1/workspaces/*` URL aliases. Every legacy `/v1/teams/*` endpoint is now reachable under the new path. The DB column `team_id` and the table `teams` are unchanged.
- New `x-platform-context-version: 3` request header. Clients sending it receive an envelope stamped `authoritySchemaVersion: 3` and are expected to consume only the canonical sections (`account`, `personalSpace`, `organizations[]`, `activeSpace`). Default remains `2` for non-breaking compatibility.
- Three new organization-governance endpoints:
  - `POST /v1/orgs/:id/policies/retention` — publish org retention template (ORG_ADMIN+).
  - `GET /v1/orgs/:id/policies/retention` — read template + inheritance summary (any member).
  - `GET /v1/orgs/:id/billing/rollup` — workspace billing counts (ORG_BILLING_ADMIN+).
- New retention inheritance resolver (`resolveTeamRetentionPolicy`) that returns one of three deterministic outcomes per workspace:
  - `team_policy` — workspace has its own active retention policy (wins).
  - `org_policy_inherited` — workspace inherits the org template.
  - `none` — no policy applied; indefinite retention.

### Frontend
- Sidebar label "Teams" → **"Workspaces"** everywhere. URL paths kept as `/teams` for backwards compatibility.
- No URL breaking changes for any existing client.

### What did NOT change in Phase B0
- The DB tables (`team`, `team_members`, `team_invites`, `organization_*` all unchanged).
- Existing `/v1/teams/*` endpoints continue to work identically.
- Evidence ownership semantics (workspace-scoped via `team_id`) unchanged.
- Reviewer / case / capture / verify / report / package flows unchanged.
- No new RBAC layers, no sub-teams, no nested orgs.

---

## 4. Operator checks

### "Is workspace X under an organization?"

Query: `GET /v1/orgs/:orgId/workspaces` returns the list of workspaces bound to an org.
Or read `Team.organizationId` directly. Post-Phase-A1 it is NOT NULL — every workspace belongs to some organization (a personal workspace has a personal organization).

### "Why does workspace X have retention Y days?"

```sh
# Via the API:
GET /v1/orgs/:orgId/policies/retention
# Returns the org template + inheritance count.

# Via direct resolver (test fixture):
import { resolveTeamRetentionPolicy } from "services/api/src/services/organization/retention-inheritance.service";
const r = await resolveTeamRetentionPolicy(teamId);
console.log(r.source); // "team_policy" | "org_policy_inherited" | "none"
```

### "How do I check the operating model in the wire envelope?"

```sh
# v3 envelope:
curl -H "x-platform-context-version: 3" \
  -H "Authorization: Bearer $TOKEN" \
  https://api.proovra.com/v1/platform/context
# Response includes account, personalSpace, organizations[], activeSpace.
# authoritySchemaVersion will be 3.
```

---

## 5. Operator must-NOT-do list

- Do NOT tell a customer their evidence "belongs to" an organization. It belongs to a workspace; the organization governs the workspace.
- Do NOT use "Team" and "Workspace" interchangeably in customer-facing copy. New copy: "Workspace". Legacy URL `/teams/*` is acceptable in documentation only when the audience needs to recognize an old link.
- Do NOT promise org-level evidence read across workspaces. Org admin sees governance metadata only — never evidence content.
- Do NOT add nested orgs. PROOVRA's model is intentionally flat: User → Workspace → Organization (one level).

---

## 6. The five-minute enterprise pitch

> "PROOVRA models a single operational unit — the **Workspace** — where evidence lives, cases are managed, reviewers work. Solo investigators have a personal workspace. Teams collaborate inside a workspace. Enterprises layer **Organizations** on top to govern one or more workspaces with retention policies, member governance, and an audit feed. Workspaces remain the operational owner; organizations remain the governance overlay. The two never collapse."

That sentence, in customer language, is the whole model.

---

## 7. Reference

- Plugin: `services/api/src/routes/workspace-alias.plugin.ts`
- Envelope types: `services/api/src/services/platform-context/types.ts`
- Envelope service: `services/api/src/services/platform-context/platform-context.service.ts`
- Org governance write surfaces: `services/api/src/routes/organizations-governance.routes.ts`
- Retention inheritance resolver: `services/api/src/services/organization/retention-inheritance.service.ts`
- Tests: `services/api/test/phase-b0-workspace-operating-model.test.ts`
- Sidebar terminology: `services/api/src/services/platform-context/navigation-registry.ts` + `apps/web/lib/navigation-config.ts`
