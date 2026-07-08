# PROOVRA — Phase 1.5: Final Product Model Consolidation

**Purpose:** Define the final PROOVRA product model from first login to enterprise usage, so every later delete/merge/navigation decision rests on the correct architecture.
**Date:** 2026-07-08. **No code. No deletion. No implementation.**
**Source of truth:** the Product Constitution, Master Audit, Execution Roadmap, and verified code facts already gathered. Nothing re-audited from scratch; nothing invented.

**Governing sentence (the model in one line):**
> **PROOVRA is one evidence-centered SaaS product where a Workspace is the user's active data scope (Personal or Organization), a Team is a collaboration subgroup inside a workspace, an Organization is the enterprise governance grouping, Plan unlocks which capabilities exist, Role grants permissions, and Persona only tunes presentation — the same product scaling from a solo journalist to an enterprise, never a second app.**

---

## 1. What is a Workspace?

- **It is the user's active data scope** — the tenancy boundary that decides *whose evidence/cases/reports you see*. Exactly one active workspace at a time.
- **Personal Workspace is auto-created** on signup (a `Team` row with `isPersonal=true`); no wizard.
- **Workspace = the backend `Team` model** (aliased). `WorkspaceScopeType = "PERSONAL" | "TEAM"` is a projection over a `Team` row. This is a naming difference, not two systems — the Prisma `Team` table backs tenancy + billing and is **not** renamed.
- **What users see:** the word **"Workspace"** (Personal Space, or an Organization workspace) as the active-context label and the space switcher. Users never see the word "Team" used for tenancy.

**Verdict:** correct and shipped. The only debt is vocabulary (below), not architecture.

## 2. What is a Team?

- **Yes — a Team is a collaboration group** (a subgroup *inside* a workspace: `CollaborationTeam.workspaceId → Team.id`). It owns no evidence; it can be an *assignee*.
- **`/collaboration-teams` is the final Teams surface** (backed by `/v1/collaboration-teams` + `CollaborationTeam*` models).
- **`/teams` should be removed later** — the `/teams` landing is a stub, and `/teams/[id]` is the legacy tenancy detail on the old `/v1/teams` backend (retired in Phase 7). The `/teams` URL becomes a redirect to `/collaboration-teams`.
- **Free users: Teams should be VISIBLE as an upgrade CTA, not hidden or PRO-gated** (recommendation — see §10.D). Rationale: the Team-vs-Workspace constitution explicitly forbids gating Team *existence* behind a plan; product-led-growth favors showing Teams-as-CTA; it is not an enterprise surface. *Capacity* is plan-gated (FREE `maxOwnedTeams=0`), so a FREE user sees Teams and an "Upgrade to create a team" CTA, but cannot create one until PRO.

## 3. What is an Organization?

- **It appears at Enterprise** — created/joined only when a user needs enterprise grouping (invited, or on the ENTERPRISE plan). Optional; personal-only users never touch it.
- **It is Enterprise-only** (`/organizations` is tier ENTERPRISE, `directAccessPolicy: notFound` for self-serve).
- **It is the governance/admin grouping** — `OrganizationMembership`/`OrganizationRole` grant governance-scoped reads only, **never** data-plane/evidence access.
- **Relationship:** `Organization` groups one or more **Workspaces**; within a workspace, **Teams** are collaboration subgroups; **Members** belong to workspaces/teams/org. Evidence tenancy stays on the workspace (`teamId`); the Organization is an inheritance layer above it.
- **Status:** half-built (governance inheritance real; data-plane deliberately excluded). Finish or freeze is a later decision, not a Phase-2 blocker.

## 4. First login by user type

All users: Personal Workspace auto-created → land on `/home` → data-driven "capture-first" checklist for zero-data users. Persona is an optional, dismissible presentation tuner (never grants access). Enterprise surfaces are hidden by the tier gate for everyone below ENTERPRISE.

| User type | Landing | Visible nav | Hidden nav | Upgrade CTA | Workspace | Team | Org | Settings | First action |
|---|---|---|---|---|---|---|---|---|---|
| **Individual (FREE)** | /home | Home, Capture, Evidence, Cases, Reports, Search, Settings, Billing, Teams(CTA) | Governance, Ops, Org, Identity, Audit, Review, Investigation | Reports, Teams-create, Evidence-cap | Personal only | Teams as CTA | none | Account, Security, Billing, Persona | Capture first evidence |
| **Lawyer (PRO/persona=LAWYER)** | /home | Core + Cases emphasis, Redaction, Review*(if role) | Enterprise gov/ops/identity | Team, Enterprise governance | Personal | Teams (2) | none | + Developer | Create a case, capture |
| **Journalist (persona=JOURNALIST)** | /home | Core (Capture/Cases emphasis) | Governance, Ops, Org, Review, Investigation | Reports, Team | Personal | Teams as CTA | none | Account/Billing | Capture first evidence |
| **Investigator (persona=INVESTIGATOR)** | /home | Core + Investigation, Intelligence, Graph (PRO+) | Enterprise gov/ops/org | Team, Enterprise | Personal | Teams (2–5) | none | + Developer | Start investigation / capture |
| **Small-team owner (TEAM)** | /home | Core + Teams, Intake, Review, Assignments | Enterprise gov/identity/org-admin | Enterprise governance/SSO | Personal (+ team collab) | Create/manage Teams (5) | none | + Members | Invite a teammate, capture |
| **Enterprise invitee (ORG member)** | /home (org workspace) | Core + Teams + assigned surfaces (Review/Governance per role) | Ops (internal); admin unless granted | — | Org workspace | Assigned teams | member (read) | Account/Security | Open assigned work |
| **Enterprise admin (ORG admin)** | /home or /executive | Core + Teams + Organization, Governance, Lifecycle, Audit, Security Center, Identity, Executive | Internal Platform Ops | — | Org + switch | Manage teams | admin | + Org/Identity/Governance | Configure org/identity |

*Review/Governance require the capability (`REVIEWER_OPS_VIEW`/`GOVERNANCE_VIEW`), not just persona.

## 5. Final model by plan

| | Appears | Never appears | Teams |
|---|---|---|---|
| **FREE / PAYG** | Home, Capture, Evidence (cap 3), Cases, Reports*(PAYG+), Verify, Search, Settings, Billing, Notifications | Governance, Lifecycle, Audit, Org admin, Identity, SSO/SCIM, Legal Hold, Retention, Review/Investigation, Ops, Platform admin, Executive | **Visible as upgrade CTA** (create gated) |
| **PRO** | + Investigation, Intelligence, Redaction, Review*(role), Developer/API, Intake, Inbox, Teams (2) | All ENTERPRISE governance/identity/org + Internal Ops | Visible + usable (2) |
| **TEAM / BUSINESS** | + full Teams (5), Assignments, Routing, collaboration | All ENTERPRISE governance/identity/org + Internal Ops | Full collaboration |
| **ENTERPRISE** | + Organization admin, Governance, Retention, Legal Hold, Audit, Executive, Security Center, Admin Identity, SSO/SCIM, MFA enforcement, session governance, delegated admin | Internal Platform Ops (`/ops`,`/operations`,`/admin` platform-admin only) | Teams (1000) + org |

*Reports at PAYG+ (`reportsIncluded`); Review requires role.

## 6. Final route decisions

| Route | Decision | Why |
|---|---|---|
| `/workspaces` | **KEEP** (fix redirect) | Workspace admin/switcher (ENTERPRISE tier). Its self-serve redirect currently targets `/teams` (a stub being deleted) — **repoint the redirect** off `/teams` when the stub goes. |
| `/teams` (landing) | **DELETE + REDIRECT** | `teams/page.tsx` is a stub; delete it and redirect the `/teams` URL → `/collaboration-teams` (canonical). |
| `/teams/[id]` | **MOVE (later)** | Legacy tenancy detail on `/v1/teams`; migrate to `/collaboration-teams/[teamId]` in **Phase 7 (backend)**. Do NOT touch in Phase 2. |
| `/collaboration-teams` | **KEEP** | Canonical Teams product surface. |
| `/collaboration-teams/[teamId]` | **KEEP** | Canonical Team detail. |
| `/organizations` | **KEEP** | Enterprise org surface (ENTERPRISE, notFound). |
| `/organizations/[id]` | **KEEP** | Org detail. |
| `/organizations/[id]/admin` | **KEEP** | Org admin hub. |
| `/settings/persona` | **KEEP** | Persona settings/wizard (presentation-only). |
| `/home` | **KEEP** | Canonical dashboard/landing. |
| `/dashboard` | **REDIRECT (already)** → `/home`; `/dashboard/{batch-analysis,quotas}` **KEEP** (canonical-location pending Phase 3) | Bare `/dashboard` already 301s; the two real sub-consoles stay until the `/dashboard`↔`/operations` decision. |
| `/executive` | **KEEP** | Enterprise executive dashboard. |
| `/governance` | **MERGE (not delete route)** | `governance/page.tsx` is a 35L stub — inline `GovernanceControlPlane` as the `/governance` page. The URL + sub-pages stay. |
| `/governance-platform` | **KEEP** | Org-level governance (ENTERPRISE). |
| `/security-center` | **KEEP** | Enterprise workspace identity. |
| `/admin/identity` | **KEEP** | SSO/SCIM/MFA admin (ENTERPRISE). |
| `/ops` | **KEEP** | Canonical internal Platform Ops (INTERNAL, platform-admin only). |
| `/operations` | **MERGE/CONSOLIDATE (Phase 3)** | Re-export shells → delete after picking `/ops` vs `/operations` canonical; the 5 real `/operations/*` impls (exports/queues/recovery/reliability/signers) stay. **Not Phase 2.** |

## 7. Final user-facing vocabulary

| Concept | UI label | Backend model | Controls | Must never control |
|---|---|---|---|---|
| Workspace | **Workspace** (Personal Space / Organization) | `Team` (projected as `WorkspaceScope`) | **Data scope** | Permissions, entitlement, presentation |
| Personal Workspace | **Personal Space** | `Team{isPersonal=true}` | Solo data scope | Collaboration/enterprise features |
| Organization | **Organization** | `Organization` | **Enterprise governance grouping** | Data-plane/evidence access |
| Team | **Team** | `CollaborationTeam` | **Collaboration subgroup**, assignment | Tenancy, billing, evidence ownership |
| Member | **Member** | `TeamMember` / `CollaborationTeamMember` / `OrganizationMembership` | Membership + role binding | — |
| Role | **Role** | `TeamRole` → canonical role → `Permission` | **Permissions** (widened by grants) | Feature availability, presentation |
| Plan | **Plan** | `PlanType` (FREE/PAYG/PRO/TEAM/ENTERPRISE) | **Entitlement ceilings** (which features exist) | Per-user permissions |
| Persona | **Use-case** | `WorkspacePersonaProfile` | **Presentation** (nav order/visibility, labels, defaults, empty states) | Permissions, data, feature availability |
| Capability | (internal) | `CAPABILITY_KEYS` (frontend envelope) | Nav/UX hints | Backend authorization |
| Permission | (internal) | 86-`Permission` catalog (`access-policy`) | **Authorization** (403 if absent) | Feature availability |

## 8. Final navigation model (by audience)

Single registry (`routeRegistry.ts`) → tier + capability + active-space + persona filter → 4 groups. Gate legend: **P**=plan/tier · **R**=role/capability · **W**=workspace/active-space · **O**=org · **I**=internal.

| Audience | Visible items | Hidden items | Upgrade-CTA items | Gate |
|---|---|---|---|---|
| **Personal / FREE** | Home, Capture, Evidence, Cases, Reports, Search, Settings, Billing, Notifications, Teams(CTA) | Governance, Lifecycle, Audit, Org, Identity, Review, Investigation, Ops, Executive | Reports (if PAYG-off), Teams-create, Evidence-cap | P |
| **Pro** | + Investigation, Intelligence, Redaction, Review*, Intake, Inbox, Developer/API, Teams(2) | Enterprise governance/identity/org, Internal Ops | Enterprise governance/SSO | P + R |
| **Team / Business** | + Teams(5), Assignments, Routing, collaboration | Enterprise governance/identity/org-admin, Internal Ops | Enterprise plan | P + R |
| **Enterprise** | + Organization, Governance, Retention, Legal Hold, Audit, Executive, Security Center, Identity/SSO/SCIM, Delegated admin | Internal Platform Ops | — | P + R + O |
| **Platform Admin** | + `/ops`, `/operations`, `/admin`, `/tools` (All Tools), platform analytics | — | — | I |

Groups (constant across audiences; items filtered in/out): **Core** (Home/Capture/Evidence/Cases/Reports/Search) · **Collaborate** (Teams/Intake/Inbox) · **Review & Investigation** (Review/Investigation/Intelligence/Redaction) · **Governance** (Governance/Lifecycle/Audit/Executive) · **Administration** (Organization/Members/Security Center/Identity/Developer/Ops·platform-admin) · **System** (Settings/Billing/Notifications/Persona).

## 9. Final deletion impact (re-confirmed against the model)

| Candidate | Model verdict | Confirm / change |
|---|---|---|
| `security/trust-center/**` | **DELETE** | Byte-identical dup of `/trust-center/*`. Safe — canonical trust content stays at `/trust-center/*` (+ public `/trust`). **Gate:** confirm the `/trust` redirect chain still resolves before deleting. |
| `teams/page.tsx` | **DELETE + add `/teams`→`/collaboration-teams` redirect** | Stub; Teams canonical is `/collaboration-teams`. **Gate:** grep inbound `/teams` links; keep `/teams/[id]` (Phase 7). |
| `governance/page.tsx` | **MERGE, not delete** | It's a 35L stub for a route we keep — inline `GovernanceControlPlane`. The `/governance` route survives. Reclassify from "delete" to "merge-into-canonical". |
| `reviewer-ops/queue/page.tsx` | **DELETE** | Redirect-only → `/review`. Safe. |
| `settings/security/saml/page.tsx` | **DELETE + redirect** | Redirect-only → `/security-center/sso`. Safe. |
| `inspect/page.tsx` | **DELETE** | Orphan (no registry/nav/Cmd-K). **Gate:** grep inbound `/inspect` links first. |
| `verify-references/page.tsx` | **DELETE** | Orphan, no registry entry. Safe. |
| `intelligence-platform/page.tsx` | **MERGE FIRST, then delete** | Same `/v1/intelligence/*` domain — fold the provider-budget panel into `/intelligence`, *then* delete. **Not a pure delete; wait until merge lands.** |
| operations re-export shells | **WAIT (Phase 3)** | Deleting them requires the `/ops`↔`/operations` canonical decision + moving the 5 real `/operations/*` impls. Not Phase 2. |

## 10. Final decisions

**A. Should Phase 2 deletion proceed immediately after this?**
**Yes — for the safe subset only, with the stated gates.** The pure orphan / redirect-only / byte-identical deletions are safe now. The merges (governance stub, intelligence-platform) and the operations-shell consolidation are **not** pure deletions and must not ride in the same step.

**B. Safe to delete first (pure, low-risk, no merge):**
1. `security/trust-center/**` (after confirming `/trust` renders)
2. `reviewer-ops/queue/page.tsx`
3. `settings/security/saml/page.tsx` (add redirect)
4. `inspect/page.tsx` (after inbound-link grep)
5. `verify-references/page.tsx`
6. `teams/page.tsx` (after adding `/teams`→`/collaboration-teams` redirect + inbound-link grep)

**C. Must wait:**
- `governance/page.tsx` — it's a **merge** (inline control plane), not a delete.
- `intelligence-platform/page.tsx` — **merge the budget panel into `/intelligence` first**, then delete.
- operations re-export shells — **Phase 3** (`/ops`↔`/operations` canonical decision).
- `/teams/[id]` + `/v1/teams` backend — **Phase 7**.
- `/workspaces` redirect target — repoint off `/teams` when the `/teams` stub is deleted.

**D. Unresolved policy decision — Teams visibility for FREE:**
Two of your own specs conflict: the **pricing brief** (`tiers.ts` comment) says the FREE sidebar excludes Teams; the **Team-vs-Workspace constitution** says Team *existence* must not be plan-gated. Current code shows `/collaboration-teams` as CORE (visible to FREE). **Recommendation: keep Teams VISIBLE to FREE as an upgrade CTA** (constitution wins; PLG-positive; not an enterprise leak), with creation gated by plan capacity (FREE `maxOwnedTeams=0`), and update the stale pricing-brief comment to match. If you instead want it hidden until PRO, that's a one-line tier change (`/collaboration-teams` → PROFESSIONAL). **This is a founder/product call — it does not block the safe Phase-2 deletions in (B).**

**E. Final architecture sentence:**
> **PROOVRA is one evidence-centered SaaS product where a Workspace is the active data scope (Personal or Organization), a Team is collaboration within a workspace, an Organization is enterprise governance, Plan unlocks which capabilities exist, Role grants permissions, and Persona only tunes presentation — one product scaling from a solo journalist to an enterprise, never a second app.**
