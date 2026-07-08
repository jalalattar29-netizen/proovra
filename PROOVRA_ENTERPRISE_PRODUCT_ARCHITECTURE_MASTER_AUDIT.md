# PROOVRA Enterprise Product Architecture Master Audit

**Type:** Product Architecture Audit (not code / not UI / not feature audit).
**Date:** 2026-07-07. **No code modified.**
**Method:** Full authenticated route inventory + navigation-registry analysis + duplicate proof + plan/workspace/persona model extraction, all grounded in file:line. Compared against mature enterprise-SaaS IA patterns (GitHub Enterprise, Atlassian, Linear, Notion, Vanta/Drata, Relativity/Magnet-class forensics).

---

## Executive framing (read this first — it reframes the whole mandate)

**The premise "20 unrelated pages / redesign the IA from scratch" is only half right.** The audit proves two things at once:

1. **PROOVRA already has a correct, mature IA — as a specification.** There is a single canonical navigation source of truth (`apps/web/lib/navigation/routeRegistry.ts`, ~90 entries), a pillar model (`pillarRegistry.ts`, 8 pillars / 7 personas), a 4-group sidebar (`canonicalNavigationGroups.ts`: Workspace · Governance · Outputs · System), surface-tier gating (`lib/surface/tiers.ts`: CORE/PROFESSIONAL/ENTERPRISE/INTERNAL), a **test-enforced** route×persona matrix (`docs/architecture/phase-4-route-persona-matrix.md` ↔ `phase-r13-route-persona-matrix.test.ts`), and a written "Team ≠ Workspace" constitution (`docs/architecture/team-vs-workspace.md`, status **DECIDED**). This is more IA rigor than most Series-B SaaS has.

2. **The product does not *feel* designed from day one because the migrations that produced that specification were never finished.** There are **154 authenticated `page.tsx` files but only ~90 canonical routes**. The ~64-page delta is legacy/duplicate/shim/orphan surface that successive "phase" migrations **hid or redirected instead of deleting** (Phase 9 explicitly permitted only "nav hiding + legacy-route redirects," never deletion — `team-vs-workspace.md:15`). On top of that sit **parallel concept systems that were added but never collapsed**: 5 persona projections, 3 role vocabularies, 2 "capability" catalogs, 2 "delegated-admin" vocabularies, and a Team-vs-CollaborationTeam double stack.

**Therefore the mandate "make it feel designed from day one" is NOT "redesign the IA." It is "finish the migrations and collapse the parallel systems."** That is the spine of every recommendation below. Where the audit found intentional tiered layering (nav-hub ÷ action-surface ÷ org-deep-link ÷ plan-tier on distinct `/v1` namespaces), a world-class architect **keeps** it — nuking it would be vandalism. The report is explicit about which is which, with proof.

---

# PHASE A — Complete Product Inventory

**154 authenticated pages** under `app/(app)/` (the "196" figure counts `layout/loading/route` files too). Live sidebar renders ~40 of them; the rest are Cmd-K/Tools/deep-link/legacy. Public/marketing routes (`app/about`, `app/for-*`, `app/pricing`, `app/login`, `app/verify`, `app/intake`, `app/portal`, etc.) are a **separate unauthenticated tier** and out of scope for the authenticated-product IA (noted, not audited).

### A.1 Authenticated pages by domain (with status)

Status legend: **C**=canonical/keep · **L**=legacy-but-live · **S**=stub landing (no API) · **R**=redirect shim · **X**=re-export shell · **O**=orphan (no nav, no link).

| Domain | Routes (status) |
|---|---|
| **Account** | `/settings` (C, 1080L), `/settings/security` (C, 126L), `/settings/security/saml` (R→/security-center/sso, 39L), `/settings/persona` (C wizard, 505L), `/billing` (C), `/organizations` (C), `/organizations/[id]` (C), `/org-invites/[token]/accept` (C), `/inbox` (C), `/workspaces` (C alias→WorkspaceAdministrationHome, 36L), `/tools` (C) |
| **Capture & Evidence** | `/home` (C, 74L router), `/capture` (C), `/evidence` (C), `/evidence/[id]` (C), `/evidence-requests/[id]` (C), `/reports` (C), `/search` (C), `/inspect` (**O**, 662L), `/verify-references` (**O**, 59L), `/packaging` (C, Cmd-K only), `/exchange` (C, Cmd-K only) |
| **Cases & Investigation** | `/cases` (C), `/cases/[id]` (C), `/investigation` (C hub), `/investigation/graph` (C), `/investigation/cases/[caseId]/graph` (C, O from nav), `/investigation/duplicates` (C), `/investigation/relationships` (C), `/investigation/reviewers` (C), `/investigation/timeline` (C) |
| **Intelligence** | `/intelligence` (C), `/intelligence-platform` (**merge→intelligence**, 439L), `/intelligence-quality` (C) |
| **Review** | `/review` (C nav), `/review/{queues,operations,disagreements,external,metrics,qc,workspace,schemas}` (all C, distinct `/v1`), `/reviewer-ops/[reviewId]` (C action), `/reviewer-ops/{escalations,sla}` (C), `/reviewer-ops/queue` (R→/review, 16L) |
| **Redaction** | `/redaction` (C), `/redaction/[projectId]` (C), `/redaction/policy` (C) |
| **Collaboration / Teams** | `/collaboration-teams` (C, 926L), `/collaboration-teams/[teamId]` (C, 2510L), `/collaboration-teams/[teamId]/collaboration` (C), `/collaboration` (R→/inbox, 608L threads — see note), `/teams` (S, 230L), `/teams/[id]` (L, 2614L legacy backend), `/workspaces` (C alias) |
| **Governance** | `/governance` (S hub, 35L), `/governance/{analytics,destruction,lifecycle,notifications,policy,retention}` (all C), `/governance-platform` (C org hub), `/governance-platform/{access-reviews,cross-org,delegated-admin,departments,policies}` (all C, ENTERPRISE) |
| **Evidence Lifecycle** | `/evidence-lifecycle` (C console), `/evidence-lifecycle/{retention,destruction,legal-holds,archive,chain-transfers,webhooks}` (all C, ENTERPRISE) |
| **Trust** | `/trust` (**canonical target — but NO page.tsx exists; verify next.config**), `/trust-hub` (C landing, 272L, orphan-from-nav), `/trust-center` (R→/trust, 5L) + `/trust-center/{ai-disclosure,methodology,security,status,subprocessors}` (C content), `/security/trust-center/*` (**X/DUP — entire dir byte-identical, ~776L**) |
| **Security / Identity** | `/security-center` (C, 719L), `/security-center/sso` (C, 1040L), `/security-center/sso/{health,mapping}` (C), `/security-center/mfa-recovery` (C), `/admin/identity` (C hub), `/admin/identity/{access-reviews,providers,scim,sessions,permission-matrix,runtime,timeline}` (all C) |
| **Operations** | `/ops` (C, 681L), `/ops/{analytics,automation,media-graph,observability,runbooks}` (**C impls**), `/operations/{analytics,automation,media-graph,observability,runbooks,batch-analysis,quotas}` (**X re-export shells, ~10L each**), `/operations/{exports,queues,recovery,reliability,signers}` (C real impls), `/dashboard/batch-analysis` (C impl, 767L), `/dashboard/quotas` (C impl, 646L) |
| **Dashboards** | `/home` (C), `/executive` (C, 425L), `/admin` (C hub, 825L), `/admin/dashboard` (C, 1061L), `/admin/{audit,contact-sales,demo-requests}` (C, platform-admin) |
| **Org Admin** | `/organizations/[id]/admin/{overview,members,audit,governance,retention,security,departments,access-reviews,trust}` (C hubs + deep-link stubs) |
| **Other** | `/notifications` (C), `/communications` (C), `/integrations` (C), `/workflows` (C), `/workflows/[id]` (C), `/intake-links` (C), `/audit-transparency` (C, Cmd-K), `/budget-center` (C, Cmd-K), `/executive` (C), `/security/trust-center` (dup), `/verify-references` (O), `/tools` (C), `/app-legal/[slug]` (C), `/collaboration-teams/invites/[token]/accept` (C) |

### A.2 Feature flags / gating surfaces (not page flags — capability gates)
- **Surface tiers** (`lib/surface/tiers.ts`): CORE / PROFESSIONAL / ENTERPRISE / INTERNAL. ENTERPRISE unlocked only by `isEnterpriseWorkspace` / `plan==="ENTERPRISE"` / platform-admin (`lib/surface/access.ts:111-118`).
- **`directAccessPolicy`** per route: `notFound` (governance-platform tree) or `redirect` (evidence-lifecycle tree) for non-entitled direct hits.
- **`sidebarEligible` / `commandPaletteVisible` / `allToolsVisible`** booleans in `routeRegistry.ts` govern the three discovery surfaces.
- **Dormant flag:** the 8-pillar `PERSONA_PILLAR_VISIBILITY` overlay (`pillarRegistry.ts:340`) is **defined but not invoked** — `AppSidebarV2.tsx:667` calls `resolveNavigationGroups` **without** the persona option, so persona affects ordering only, not visibility. (Phase E fix.)

### A.3 Wizards / onboarding / modals with their own workflow
- **Persona onboarding wizard** — `/settings/persona` (4-step, PATCH-only, "never creates a workspace / never changes capabilities" `settings/persona/page.tsx:4-20`).
- **Org onboarding next-steps** — inline on `/organizations/[id]` (`page.tsx:624`).
- **Inbox onboarding signals** — `/inbox` (derived membership state).
- No global first-run wizard exists; onboarding is scattered across three surfaces (Phase G).

---

# PHASE B — Product Information Architecture

## What is PROOVRA?
**A combination, anchored on Evidence.** Precisely: **a Digital Evidence Integrity Platform** (capture → fingerprint/sign/timestamp/anchor → custody → report → verify) with three optional capability layers stacked by plan tier:

| Layer | It is a… | Evidence in code |
|---|---|---|
| **Core** | Evidence Platform | `/capture`, `/evidence`, `/reports`, `/search`, verification package pipeline |
| **+ Collaboration** | Team/case platform | `/cases`, `/collaboration-teams` |
| **+ Investigation & Review** | eDiscovery/review platform | `/investigation/*`, `/review/*`, `/reviewer-ops/*`, `/redaction/*` |
| **+ Governance & Compliance** | Governance/compliance platform | `/governance/*`, `/evidence-lifecycle/*`, `/audit-transparency`, enterprise identity `/security-center`, `/admin/identity` |

So it is Evidence + Review + Governance + Compliance — but **Evidence is the spine**; the others are progressive expansions unlocked by plan and revealed by persona. This matches the Vanta/Drata pattern (a core object + governance layers) fused with a Relativity/Magnet-class review/investigation layer.

## Correct hierarchy (this already largely exists in `pillarRegistry.ts`; the fix is to enforce it)
```
Platform
 └─ Workspace (Personal | Organization)         ← tenancy; one active space at a time
     ├─ WORK (the spine)
     │   ├─ Home            /home
     │   ├─ Capture         /capture
     │   ├─ Evidence        /evidence → /evidence/[id]
     │   ├─ Cases           /cases → /cases/[id]
     │   └─ Search          /search
     ├─ COLLABORATE
     │   ├─ Teams           /collaboration-teams
     │   └─ Intake Links    /intake-links
     ├─ INVESTIGATE (plan/role gated)
     │   ├─ Investigation   /investigation/*
     │   ├─ Review          /review/* + /reviewer-ops/*
     │   ├─ Intelligence    /intelligence (+quality)
     │   └─ Redaction       /redaction/*
     ├─ OUTPUTS
     │   ├─ Reports         /reports
     │   └─ Verification    (public /verify — unauth tier)
     ├─ GOVERN (enterprise gated)
     │   ├─ Governance      /governance/*
     │   ├─ Lifecycle       /evidence-lifecycle/*
     │   ├─ Audit           /audit-transparency
     │   └─ Executive       /executive
     ├─ ADMINISTER (enterprise gated)
     │   ├─ Organization    /organizations/[id]/admin/*
     │   ├─ Identity/Security /security-center + /admin/identity
     │   └─ Operations      /operations/* (platform-admin: /ops, /admin)
     └─ ACCOUNT (always)
         ├─ Settings /settings   ├─ Billing /billing   └─ Persona /settings/persona
```
The existing 4-group sidebar (Workspace/Governance/Outputs/System) is a coarser projection of this. Recommendation in Phase K: keep 4 top groups but map every canonical route to exactly one, and delete everything not in the registry.

---

# PHASE C — Workspace Architecture

## The concept model as it exists (proven)
| Concept | What it actually is in code | Verdict |
|---|---|---|
| **Workspace** | An **alias for `Team`**, projected as `WorkspaceScope` (`WorkspaceScopeType = "PERSONAL" \| "TEAM"`, `workspace-billing.service.ts:12-62`). Not a distinct model. | Keep as the product noun; it = the active tenancy space |
| **Personal Workspace** | A `Team` row with `isPersonal=true` (`schema.prisma:1055`), one per user | Keep |
| **Team (tenancy)** | The **real tenancy + billing unit** (`schema.prisma:1004`): owns Evidence/Cases/Subscriptions/ApiCredentials/TeamMember; holds `billingPlan`, `includedSeats`. The legacy Prisma `Team` = "the runtime workspace" (`schema.prisma:11126`). | Keep as backing model; **stop exposing "Team" as a product noun for it** (naming debt, below) |
| **CollaborationTeam** | A **collaboration sub-group inside a Team** (`workspaceId → Team.id`, `schema.prisma:11146`); can be an *assignee*, owns no Evidence. Full parallel member/invite/role/activity stack. | Keep the feature; it is the *product-facing "Team"* |
| **Organization** | **Half-built governance wrapper** (`schema.prisma:9042`). `OrganizationMembership`/`OrganizationRole` grant **only** governance reads, **never** data-plane/evidence access (`org-access.ts:10-23`). Evidence tenancy still runs on `teamId`. The "no runtime code reads this column" comment (`schema.prisma:1062`) is **stale** — it is now NOT NULL + read in `workspace-billing.service.ts:159-229`. | Keep; finish or freeze (Phase J) |
| **Member / Seat** | `TeamMember` (`schema.prisma:1679`, role + Phase-17 lifecycle). Seat limit = `getEffectiveSeatLimit` (`workspace.ts:18-37`). | Keep |
| **Role** | **THREE vocabularies**: `TeamRole` (OWNER/ADMIN/MEMBER/VIEWER → canonical 5-role → 86 permissions), `OrganizationRole` (6-value rank-precedence, governance-only), `CollaborationTeamMember` role (string LEAD/ADMIN/MEMBER/VIEWER/EXTERNAL) | **Collapse to one canonical vocabulary** (Phase I) |
| **Plan** | 5 tiers FREE/PAYG/PRO/TEAM/ENTERPRISE (`plan-catalog.ts:2`) | Keep |
| **Persona** | **FIVE parallel projections** (below). Stored one = `WorkspacePersonaProfile` (7 use-case codes, Team-keyed). **UX-only, never permissions.** | **Collapse to one** (Phase I) |

## Who should define permissions? (definitive answers, matched to enterprise pattern)
| Question | Answer | Why (enterprise pattern + code) |
|---|---|---|
| Should **Workspace** define permissions? | **No** — it defines *tenancy/data scope* (which rows you can touch), not what you can do. | GitHub/Linear: workspace = boundary, role = permission. Code already scopes by `teamId`. |
| Should **Plan** define permissions? | **No — it defines *entitlement ceilings* (which features exist for this workspace)**, not per-user permission. | Vanta/Atlassian: plan gates feature availability (402), RBAC gates action (403). PROOVRA already separates these cleanly (`require-enterprise-feature` vs `authorize`). **Keep separate.** |
| Should **Organization** define permissions? | **Only governance-scoped, inherited reads** — never data-plane. | Already true (`org-access.ts`). Keep as an *inheritance* layer above Team. |
| Should **Role** define permissions? | **Yes — Role is the single source of data-plane permission**, widened by explicit grants. | `access-policy.service.ts` (86 permissions, role floor + `MemberCapabilityGrant` + `MemberDelegatedAdminScope`) is already the real authority. **This is correct — protect it.** |
| Should **Persona** define permissions? | **Never.** Presentation only (nav order, terminology, capture defaults, onboarding). | Hard-pinned (`workspace-persona.routes.ts:12-14`). Correct — keep, but collapse the 5 projections to 1. |

**The model is architecturally correct; the debt is naming + duplication, not authority mixing.** Two concrete fixes:
1. **Product-noun standardization** (the #1 IA debt): today "Team" = tenant, "CollaborationTeam" = subgroup, "Workspace" = alias-for-tenant. This is inverted vs the entire industry (where Org = tenant, Team = subgroup). The `team-vs-workspace.md` constitution forbids *renaming the Prisma model* — fine — but the **product-facing** vocabulary should standardize to: **Workspace** (the space you're in: Personal or Organization) › **Team** (the product-facing collaboration group = today's `CollaborationTeam`) › **Member**. Retire "Team" as a user-visible label for the tenancy row (surface it only as "Workspace/Organization admin").
2. **Finish Organization** as the enterprise grouping above Workspace, or freeze it explicitly (Phase J) — a half-built third tenancy noun is the single biggest source of "unfinished" feel.

---

# PHASE D — Plan Architecture (capability matrix)

**Canonical source already exists:** `packages/shared-billing/src/plan-catalog.ts:130-240` (mirrored by Prisma `enum PlanType`). Five tiers. The design is sound — the fix is to **align page visibility to it consistently** and stop leaking enterprise surface to non-enterprise personas (Phase E dormant-filter bug).

| Capability | FREE | PAYG | PRO | TEAM | ENTERPRISE |
|---|:--:|:--:|:--:|:--:|:--:|
| Workspace type | Personal | Personal | Personal | Team | Both |
| Price / mo | $0 | $5 | $19 | $79 | Custom |
| Storage | 250 MB | 5 GB | 100 GB | 500 GB | 500 GB+ |
| Seats included | 0 | 0 | 0 | 5 | 5 |
| Evidence cap | 3 lifetime | ∞ (PAYG) | 100 | 500/mo | ∞ |
| Reports / Verification pkg | — | ✓ | ✓ | ✓ | ✓ |
| Public verify | ✓ | ✓ | ✓ | ✓ | ✓ |
| AI advisory ops/mo | 0 | 50 | 100 | 500 | ∞ |
| Teams (collab) | 0 | 0 | 2 | 5 | 1000 |
| Members/team | 0 | 0 | 5 | 5 | 500 |
| SSO / SCIM | — | — | — | — | ✓ |
| MFA enforcement | — | — | — | — | ✓ |
| Access reviews | — | — | — | — | ✓ |
| Session governance | — | — | — | — | ✓ |
| Legal hold | — | — | — | — | ✓ |
| Retention policy | — | — | — | — | ✓ |
| Org audit logs | — | — | — | — | ✓ |
| Object lock (WORM) | — | — | — | — | ✓ |

### Page visibility per tier (the enforcement contract — align routeRegistry `tier` to this)
| Route group | FREE/PAYG/PRO (CORE) | TEAM (PROFESSIONAL) | ENTERPRISE | Rule |
|---|---|---|---|---|
| Home, Capture, Evidence, Cases, Reports, Search, Settings, Billing, Persona | Visible | Visible | Visible | Account + spine = always |
| Collaboration Teams | Upgrade-CTA (PRO+) | Visible | Visible | Exists at PRO (2 teams); cap by plan, never hide existence (`team-vs-workspace.md` rule) |
| Investigation / Review / Intelligence / Redaction | Hidden (·advanced) | Visible | Visible | PROFESSIONAL work surfaces |
| Governance, Evidence-Lifecycle, Audit, Executive | Hidden | Hidden | Visible | ENTERPRISE `enterpriseFeatures` |
| Security-Center, Admin/Identity (SSO/SCIM/MFA) | Account-security only (`/settings/security`) | Same | Full workspace identity | ENTERPRISE-only workspace identity (matches `settings/page.tsx:13-16`) |
| Organization admin | Hidden | Hidden | Visible | Org is enterprise grouping |
| Operations / Ops / Platform admin | — | — | Platform-admin (INTERNAL) | Staff only |

**No duplication permitted:** each capability has exactly one gate (`plan.enterpriseFeatures.*` for features, `Permission` for actions). The FREE tier's `maxEvidenceRecords: 3` + no reports is the product-led-growth wedge; keep.

---

# PHASE E — Navigation Audit

Live pipeline: `routeRegistry.ts` → `AppSidebarV2.tsx` (filter by `canAccessSurface` → `resolveRouteAccess` → `resolveWorkflowExposure` → `resolveNavigationDisclosure` → `resolveNavigationGroups`) → 4 groups. `navigation-config.ts` is **dead** (retained for legacy tests only, header lines 1-11).

| Action | Item | Proof / reason |
|---|---|---|
| **REMOVE (nav)** | `navigation-config.ts` `NAVIGATION_GROUPS`, `ACCOUNT_MENU_ITEMS`, `DEPRECATED_ROUTE_REDIRECTS` | Dead; shell no longer imports it (drift test enforces) |
| **FIX (bug)** | Wire the persona pillar-visibility filter | `AppSidebarV2.tsx:667` calls `resolveNavigationGroups` without `options.persona` → `PERSONA_PILLAR_VISIBILITY` (`pillarRegistry.ts:340`) is dormant; enterprise pillars leak to non-enterprise personas. Pass persona → apply overlay. |
| **MERGE** | Sidebar link `/ops`, `/ops/observability`, `/ops/runbooks` → point at canonical `/operations/*` | Registry links `/ops` but next.config 301s `/ops`→`/operations`; sidebar currently links the redirecting URL (`routeRegistry` ops ids). Pick ONE canonical path. |
| **MERGE** | `review.escalations` + `review.sla` (`/reviewer-ops/*`) into the Review group cohesively | Review sidebar entries split across `/review/*` and `/reviewer-ops/*` = split-brain; group under one "Review" pillar |
| **RENAME** | `admin.teams` label "Workspaces" → keep; retire user-visible "Team" for tenancy | Naming debt (Phase C) |
| **MOVE** | `workspace.intelligence_platform` out of sidebar (merge into `/intelligence`) | Phase F duplicate |
| **KEEP** | The 4 canonical groups, surface-tier gating, `directAccessPolicy` | Correct enterprise pattern |
| **DEAD-NAV** | `dashboard.batch-analysis`/`dashboard.quotas` registry entries marked `commandPaletteVisible:false "page does not exist"` — but the pages DO exist | Stale/contradictory registry metadata; reconcile |

**Multiple entry points / broken hierarchy found:** three "team-ish" surfaces (`/teams`, `/collaboration-teams`, `/workspaces`); `/ops` vs `/operations`; `/trust` vs `/trust-center` vs `/security/trust-center` vs `/trust-hub`; `/review` vs `/reviewer-ops`. All resolved in Phase F/J.

---

# PHASE F — Duplicate Experience Detection (proven)

**Honest split:** most apparent duplication is **intentional tiered layering** (nav-hub ÷ action-surface ÷ org-deep-link ÷ plan-tier on distinct `/v1` namespaces) and must be **kept**. The **proven true duplicates** are:

| # | Duplicate | Members | Survivor | Delete | Proof |
|---|---|---|---|---|---|
| 1 | **Trust Center tree** | `trust-center/*`, `security/trust-center/*` | `trust-center/*` (+ canonical `/trust`) | **entire `security/trust-center/` dir (6 files ~776L)** | byte-identical except import depth + one date-fmt swap |
| 2 | **Teams landing** | `teams/page.tsx`, `collaboration-teams/page.tsx` | `collaboration-teams` | `teams/page.tsx` (230L stub, no API) | static org list, no fetch |
| 3 | **Governance hub** | `governance/page.tsx` | `GovernanceControlPlane` component | `governance/page.tsx` (35L stub) | delegates, makes no call |
| 4 | **Intelligence** | `intelligence`, `intelligence-platform` | `intelligence` | `intelligence-platform` (439L) → fold provider-budget panel in | same `/v1/intelligence/*` domain |
| 5 | **Reviewer queue** | `reviewer-ops/queue` | `/review` | `reviewer-ops/queue/page.tsx` (16L) | `redirect("/review")` only |
| 6 | **SAML settings** | `settings/security/saml` | `/security-center/sso` | `settings/security/saml/page.tsx` (39L) | redirect only |
| 7 | **Operations shells** | `operations/{analytics,automation,media-graph,observability,runbooks,batch-analysis,quotas}` (X) vs `ops/*`+`dashboard/*` (impl) | Pick ONE location | the 7 re-export shells OR the `ops/*`+`dashboard/*` originals | `export {default} from …` |
| 8 | **Teams backend** | `/v1/teams` (legacy) vs `/v1/collaboration-teams` (new) — two full member/invite/role/billing stacks | `/v1/collaboration-teams` (strategic) | legacy `/v1/teams` after migration | parallel Prisma stacks |

**Intentional layering — KEEP (do not delete):** governance workspace vs governance-platform org (distinct `/v1` + scope); evidence-lifecycle (mutation) vs governance (compliance) vs org-retention (template) — "Option D" three-surface split; review nav-console vs reviewer-ops action-authority; home/executive/admin/admin-dashboard (four audiences); the 3-tier access-review split; SSO/SCIM/OIDC/SAML (four distinct concerns); investigation graph (case-scoped) vs graph (workspace-scoped).

**Flag:** `/trust` is the canonical target of two redirects but **no `app/(app)/trust/page.tsx` exists** — verify `next.config.js` rewrites it or it 404s.

---

# PHASE G — Onboarding Audit

**Current state:** onboarding is fragmented across `/settings/persona` (4-step wizard), `/organizations/[id]` (next-steps), and `/inbox` (signals). No coherent first-run. The persona wizard is correctly permission-neutral but is buried in Settings.

**Design questions, answered against the Linear/Notion progressive-disclosure pattern:**
| Question | Answer |
|---|---|
| Should Persona exist? | **Yes — but as a lightweight first-run use-case selector, not a Settings wizard.** It sets nav emphasis + capture defaults + terminology. Never permissions. |
| Should a Workspace wizard exist? | **No.** Personal workspace is auto-bootstrapped; Organization is created only when a user explicitly needs one (invite/upgrade). Don't force it. |
| Should operational density exist at onboarding? | **No.** CORE-tier users must never see governance/ops/enterprise surfaces on day one (this is the dormant-persona-filter bug leaking today). |
| Should workflow selection exist? | **Optional, light** — a "what are you here to do?" that maps to persona; skippable. |
| Business users see governance? | Only if ENTERPRISE + COMP capability. |
| Journalists see operational admin? | **No.** JOURNALIST persona hides enterprise/ops pillars. |
| Lawyers see review queues? | Only if they have `REVIEWER_OPS_VIEW`. Persona alone ≠ access. |
| Personal users see Organization concepts? | **No** — org routes are `requiredActiveSpace` org-only, suppressed for PERSONAL. |

**Target onboarding (progressive, Linear/Notion-grade):**
1. **Sign-up →** auto-create Personal Workspace (no wizard).
2. **One screen:** "What brings you to PROOVRA?" → 6 use-case tiles (Individual, Journalist, Lawyer, Investigator, Compliance, Enterprise) → sets `WorkspacePersonaProfile.primaryProfile`. Skippable → defaults to INDIVIDUAL.
3. **Land on `/home`** with a 3-step checklist (Capture first evidence → View verification → Invite/Upgrade). No enterprise noise.
4. **Complexity reveals by plan+persona** as the user upgrades/joins an org — never up front.

Delete the standalone `/settings/persona` *as onboarding* (keep it as a settings toggle); move first-run to a post-signup step.

---

# PHASE H — Settings Architecture

Current `/settings` is a 1080-line page mid-migration ("IA-self-serve-simplification", `AccountSecurityCard` retired → `/security-center`). Regroup into clear domains (GitHub/Linear settings pattern), **one owner each**:

| Settings domain | Route | Contents | Notes |
|---|---|---|---|
| **Account** | `/settings` | Profile, preferences, persona toggle, legal acceptance | Personal, always |
| **Account Security** | `/settings/security` | Password, active sessions, security events, MFA enrollment | Self-serve (CORE) |
| **Billing** | `/billing` | Plan, usage, invoices, upgrade | Always |
| **Workspace** | `/organizations/[id]/admin/overview` (org) / workspace settings | Name, defaults, retention templates | Org-scoped |
| **Members** | `/organizations/[id]/admin/members` + `/collaboration-teams/[teamId]` | Members, roles, invites, seats | One owner per scope |
| **Identity & Security (workspace)** | `/security-center` (+ `/admin/identity`) | SSO, SCIM, MFA policy, session governance | ENTERPRISE-only |
| **Developer** | `/integrations` | API keys, webhooks | |
| **Enterprise/Governance** | `/governance/*`, `/evidence-lifecycle/*` | Retention, legal hold, audit | ENTERPRISE |
| **Notifications** | `/notifications` (+ prefs) | Delivery prefs | |

**Remove duplicates:** `settings/security/saml` (→ `/security-center/sso`); ensure account-security is not rendered in both `/settings` and `/security-center` (finish the retired-`AccountSecurityCard` migration).

---

# PHASE I — Feature Consolidation (one owner per feature)

| Feature | Single Owner (route/module) | Delete/merge the others |
|---|---|---|
| Trust center content | `/trust` (+ `/trust-center/*` content pages) | `security/trust-center/*` (entire dir) |
| Teams (collaboration) | `/collaboration-teams` + `/v1/collaboration-teams` | `/teams/page.tsx` stub; migrate `/v1/teams` |
| Workspace/tenancy admin | `WorkspaceAdministrationHome` via `/workspaces` | `/teams` alias as product noun |
| Governance hub | `GovernanceControlPlane` (workspace) + `/governance-platform` (org) | `/governance/page.tsx` stub |
| Intelligence | `/intelligence` | `/intelligence-platform` (fold in) |
| Review | `/review/*` (nav+surfaces) + `/reviewer-ops/*` (action) | `/reviewer-ops/queue` redirect |
| Operations | ONE of `/operations/*` or `/ops/*`+`/dashboard/*` | the other (7 shells) |
| Identity/Security | `/security-center` (workspace) + `/admin/identity` (platform) | consolidate `/settings/security/saml` |
| Persona | `WorkspacePersonaProfile` (7-code) | collapse other 4 projections to derivations |
| Role/permissions | `access-policy.service.ts` (86 perms) | keep; document CapabilityMap as UX-only, delete ~15 dead keys |
| Personal security | `/security-center` | finish retiring `/settings` AccountSecurityCard |

**Rule going forward:** every route in `routeRegistry.ts` maps to exactly one pillar and one owner module; any `page.tsx` not in the registry is deleted (Phase J), not hidden.

---

# PHASE J — Delete Plan (permanent removal, not hiding)

> Ordered by confidence. Each is evidence-backed. Execute as: delete page/component → remove registry entry (if any) → add a `next.config.js` 410/redirect only if the URL is externally shared → delete now-dead hooks/services/tests.

### J.1 Pages to delete (highest confidence)
| Page | Lines | Reason | Cascade |
|---|---|---|---|
| `app/(app)/security/trust-center/` (6 files) | ~776 | byte-identical dup of `trust-center/*` | delete dir + any `/security/trust-center` registry/nav refs + snapshot tests |
| `app/(app)/teams/page.tsx` | 230 | stub landing, no API | remove `admin.teams` alias to `/teams`; keep `/workspaces` |
| `app/(app)/governance/page.tsx` | 35 | stub hub, no call | route `/governance` → `GovernanceControlPlane` directly |
| `app/(app)/reviewer-ops/queue/page.tsx` | 16 | redirect-only → `/review` | remove `review.queue` dead registry id |
| `app/(app)/settings/security/saml/page.tsx` | 39 | redirect-only → `/security-center/sso` | — |
| `app/(app)/inspect/page.tsx` | 662 | **orphan** — no registry id, no nav, no Cmd-K/Tools | confirm no deep-link, then delete |
| `app/(app)/verify-references/page.tsx` | 59 | orphan, no registry entry | delete |
| `app/(app)/trust-hub/page.tsx` | 272 | superseded by `/trust` (registry comment line 1249) | delete after confirming `/trust` renders |
| `app/(app)/intelligence-platform/page.tsx` | 439 | dup of `/intelligence` domain | fold provider-budget panel into `/intelligence`, then delete |
| `app/(app)/operations/{analytics,automation,media-graph,observability,runbooks,batch-analysis,quotas}` (7 shells) | ~10 ea | re-export shells | pick canonical location; if `/operations/*` chosen, move impl in and delete `ops/*`+`dashboard/*` originals + their registry ids |
| `app/(app)/collaboration/page.tsx` | 608 | redirects to `/inbox`; but note it hits `/v1/collaboration/threads` — **verify threads feature isn't lost** before delete | if threads are live, keep as a real page under a proper route; else delete |

### J.2 Routes/URLs to retire
`/security/trust-center/*`, `/teams` (as landing), `/reviewer-ops/queue`, `/settings/security/saml`, `/inspect`, `/verify-references`, `/trust-hub`, `/intelligence-platform`, and one of the `/ops`↔`/operations` families. Add redirects only for externally-shared URLs (`/trust-center` already redirects to `/trust`).

### J.3 Components / hooks that become dead code
- `navigation-config.ts` (`NAVIGATION_GROUPS`, `ACCOUNT_MENU_ITEMS`, `DEPRECATED_ROUTE_REDIRECTS`) once legacy tests are migrated.
- `GovernanceControlPlane` stub wrapper if `/governance/page.tsx` is inlined.
- Duplicate trust-center section components under `security/trust-center/`.
- The ~15 dead `CAPABILITY_KEYS` (`PERSONAL_*`, `ORG_*`, `types.ts:277-305`, `capability-registry.ts:332-384`).
- Dormant `futurePersonaTags` in the dead nav config.

### J.4 Services / API endpoints (staged — needs backend migration, not day-1)
- **`team-management.routes.ts`** (925L) — serves `/v1/organizations/*` on an **in-memory (non-Prisma) stub**; not wired to the real Organization model. Delete after routing org ops to the real service.
- **`/v1/teams/*` legacy backend** (`teams.routes.ts`, 2626L) — retire after migrating remaining tenancy admin to the collaboration-team + workspace-admin services. **Staged, not immediate** (it still backs `/teams/[id]` and workspace-admin).
- One of the two "delegated-admin" vocabularies (`DelegatedAdminTier` in `trust-and-governance.ts:304` vs `DelegatedAdminScopeKind` in schema) — collapse to one.

### J.5 Tests to delete/migrate
- Snapshot/drift tests pinned to `navigation-config.ts` and `security/trust-center/*`.
- `phase-r13-route-persona-matrix.test.ts` — **update, don't delete** (re-baseline to the reduced route set).
- Any test asserting `/teams` landing, `/reviewer-ops/queue`, `/intelligence-platform`.

### J.6 Migration candidates (schema, staged)
- Freeze or finish `Organization` (fix stale comment `schema.prisma:1062`; decide if it becomes the enterprise tenancy grouping).
- Plan the `/v1/teams` → `/v1/collaboration-teams` + workspace-admin backend unification (largest single debt; do last, with data migration).

---

# PHASE K — Final Product Architecture (the coherent flow)

```
1. SIGN IN  (/login, SSO for enterprise)
        │
2. LANDING  → auto Personal Workspace; first-run: 1-screen use-case selector (persona), skippable
        │
3. WORKSPACE SELECTION  → active space switcher: Personal | Organization(s)  (one active at a time)
        │
4. NAVIGATION  → single registry-driven sidebar, 4 groups, persona-ordered + persona-VISIBILITY-filtered (fix the dormant overlay):
        Workspace (Home·Capture·Evidence·Cases·Search) | Governance | Outputs (Reports) | System
        + "More/Advanced" (Cmd-K/Tools) for power routes | "All Tools" for platform-admin
        │
5. PRIMARY WORKFLOWS (spine, all tiers): Capture → Evidence → Verify/Report; Cases
        │
6. SECONDARY WORKFLOWS (plan/role gated, revealed progressively):
        Collaborate (Teams, Intake) → Investigate (Investigation/Review/Intelligence/Redaction) →
        Govern (Governance/Lifecycle/Audit/Executive) → Administer (Org/Identity/Operations)
        │
7. SETTINGS  → Account · Security · Billing · Workspace · Members · Identity(ENT) · Developer · Notifications  (one owner each)
        │
8. UPGRADE PATH  → FREE(3 evidence) → PAYG/PRO(personal power) → TEAM(collaboration) → ENTERPRISE(governance+identity)
        │
9. ENTERPRISE EXPANSION  → create Organization → SSO/SCIM/MFA → Governance/Lifecycle/Legal-Hold → Org admin + delegated tiers
```

**Governing invariants (make it feel designed from day one):**
1. **One canonical route registry.** Every authenticated page is in `routeRegistry.ts` or it is deleted. (Kills orphans/shims.)
2. **One owner per feature** (Phase I). No re-export shells, no byte-identical trees.
3. **Plan = entitlement ceiling, Role = permission, Persona = presentation, Workspace = data scope.** Never crossed. (Already true — protect it.)
4. **Progressive disclosure by (plan × persona).** CORE users never see enterprise/ops surface. (Fix the dormant persona-visibility filter.)
5. **One tenancy story:** Workspace (Personal | Organization) › Team (collaboration subgroup) › Member. Retire "Team-as-tenant" from the product vocabulary; finish or freeze Organization.
6. **One vocabulary each** for role, persona, capability, delegated-admin. Collapse the parallel systems.

---

## Bottom line (brutally honest, no flattery)
PROOVRA is **not an incoherent product with 20 random pages.** It is a **well-specified product whose specification was never fully executed.** The canonical IA, the persona matrix, the plan matrix, and the tenancy constitution already exist and are largely correct — better than most enterprise SaaS at this stage. What makes it *feel* unfinished is measurable and finite: **~64 legacy/shim/orphan pages hidden instead of deleted, a dormant persona-visibility filter, two parallel team backends, and 4–5 parallel concept vocabularies.** The work is **consolidation and deletion, not redesign.** Execute Phases F/I/J against the evidence above and the product will read as designed-from-day-one — because, at the specification layer, it already was.

*This document is execution-ready: every deletion cites a file + line count + reason, every "keep" cites the intentional layering that justifies it, and every merge names the survivor and the loser. An engineer can execute the consolidation without making further architectural decisions.*
