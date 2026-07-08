# PROOVRA FINAL PRODUCT ARCHITECTURE CONSTITUTION AND CONSOLIDATION PLAN

**The single source of truth for PROOVRA product architecture.**
**Date:** 2026-07-07. **No code modified.** Consolidates: `PROOVRA_ENTERPRISE_PRODUCT_ARCHITECTURE_MASTER_AUDIT.md`, `PROOVRA_MASTER_AUDIT_EXECUTION_ROADMAP.md`, and the plan/workspace/persona/navigation evidence gathered against the live repo. Every disposition is grounded in file:line; nothing is invented.

**Foundational finding (governs everything below):** PROOVRA is **one product whose correct architecture already exists as a specification** (`routeRegistry.ts`, `pillarRegistry.ts`, a test-enforced route×persona matrix, a "Team ≠ Workspace" constitution). It is **partially correct but unfinished** — successive "phase" migrations *hid/redirected* legacy surface instead of deleting it (154 physical pages vs ~90 canonical routes) and left parallel concept systems uncollapsed. **This constitution finalizes the specification and mandates the consolidation. It is not a redesign.**

---

# PART 1 — Global-SaaS Architecture Principles

Extracted patterns common to mature evidence/forensics/eDiscovery/governance/collaboration SaaS (not copied from any one competitor):

1. **One product, tiered by entitlement.** Personal → Team → Organization → Enterprise is the *same* navigation model with progressively unlocked surfaces — never a separate "enterprise app." (GitHub free repo → org → enterprise; Notion personal → workspace → enterprise.)
2. **Four orthogonal axes, never conflated:** **Tenancy/Workspace** = data scope · **Plan** = feature entitlement ceiling · **Role** = permissions · **Persona/use-case** = presentation. Each answers a different question ("whose data?", "which features exist?", "what may I do?", "how is it shown to me?").
3. **Progressive disclosure by (plan × role × persona).** Advanced surfaces are hidden (not 404'd) until the axis unlocks them; discoverable via search/command-palette; never dumped on a first-time user.
4. **One canonical route per capability.** No two URLs render the same feature; legacy URLs 301/308-redirect to the canonical one; re-export shells and byte-identical trees are deleted.
5. **Registry-driven navigation.** A single declarative route registry is the source of truth; the sidebar is a *projection* of it filtered by the four axes. (This is precisely PROOVRA's `routeRegistry.ts` design.)
6. **Settings grouped by domain** (Account · Security · Billing · Workspace · Members · Identity · Developer · Governance), each domain owned once; enterprise settings never buried in personal account settings.
7. **Onboarding is minimal and progressive.** Auto-create the personal space; one optional use-case question; a short "first value" checklist; complexity reveals as the account grows. No enterprise noise on day one.
8. **Upgrade paths are in-product and contextual** (locked surfaces show an upgrade CTA, not a dead end); product-led-growth wedges (e.g. a small free cap) drive conversion.
9. **Product nouns ≠ database model names.** The DB may call the tenancy row `Team`; the UI says "Workspace." Consistency of the *user-facing* noun matters; the backing model name does not have to change.
10. **Enterprise surfaces are gated at two layers** — hidden in nav (UX) *and* enforced at the API (security). Nav hiding is convenience; the API gate is the guarantee. Leaks are cosmetic, never a breach.

---

# PART 2 — Final PROOVRA Product Model

Absolute rules (constitutional): **Persona = presentation only, never permissions. Plan = entitlement ceilings, never per-user permissions. Role = permissions. Workspace = data scope. Organization = enterprise governance grouping. Team = collaboration subgroup inside a workspace/organization.**

| # | Concept | Final definition | Controls | Must NEVER control | User-facing name | Backend model | Owner module | Canonical route | Exists today | Matches final? | Migration |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **User** | A human identity/login | Authentication, session | Data scope, permissions (those come via membership) | User | `User` (`schema.prisma:810`) | `auth`, `identity` | `/settings` | Yes | Yes | No |
| 2 | **Account** | The User's personal container across workspaces | Profile, personal billing, persona toggle | Team/org data | Account | `User` + personal `Team` | `settings`, `billing` | `/settings`,`/billing` | Yes | Yes | No |
| 3 | **Personal Workspace** | Auto-created solo space | Solo data scope | Collaboration/enterprise features | Personal Space | `Team{isPersonal=true}` (`:1055`) | `workspace-billing` | `/home` (in space) | Yes | Yes | No |
| 4 | **Workspace** | The active tenancy space (Personal or Organization) | **Data scope** (which rows you see) | Permissions, entitlement | Workspace | `Team` (`:1004`) projected as `WorkspaceScope` | `workspace-billing`, `platform-context` | `/workspaces` (switcher) | Yes (as `Team` alias) | Partly (naming) | **UI rename only** |
| 5 | **Organization** | Enterprise grouping above workspaces | **Governance inheritance**, org membership, enterprise admin | Data-plane/evidence access | Organization | `Organization` (`:9042`) | `organization`, `org-access` | `/organizations/[id]` | Yes (**half-built**) | Partly | **Finish or freeze** |
| 6 | **Team** | Collaboration subgroup inside a workspace | Collaboration grouping, assignment | Tenancy, billing, evidence ownership | Team | `CollaborationTeam` (`:11142`) | `collaboration-team` | `/collaboration-teams` | Yes | Yes (once `/teams` legacy retired) | **Backend unify (P6)** |
| 7 | **Member** | A user's membership in a workspace/team/org | Membership + role binding | — | Member | `TeamMember`(`:1679`)/`CollaborationTeamMember`/`OrganizationMembership` | `access-policy` | in Members settings | Yes (3 tables) | Partly | Collapse vocab |
| 8 | **Role** | The permission-bearing grade of a membership | **Permissions** (widened by grants) | Feature availability (that's Plan), presentation (Persona) | Role | `TeamRole`→canonical 5-role→86 `Permission` (`permissions.ts`) | `access-policy.service.ts` | — | Yes | Yes (engine correct) | Collapse 3 vocabs |
| 9 | **Plan** | Billing tier | **Entitlement ceilings** (which features exist for the workspace) | Per-user permissions | Plan | `PlanType` FREE/PAYG/PRO/TEAM/ENTERPRISE (`plan-catalog.ts:2`) | `shared-billing`, `billing-enforcement` | `/billing` | Yes | Yes | No |
| 10 | **Persona** | The user's use-case | **Presentation** (nav order, labels, defaults, empty states, recommendations) | Permissions, data, feature availability | Use-case | `WorkspacePersonaProfile` (7 codes, `:8784`) | `platform-context/persona` | `/settings/persona` | Yes (**5 parallel projections**) | Partly | Collapse to 1 |
| 11 | **Capability** | A resolved yes/no for a frontend surface | Nav/envelope hints | Backend authorization | (internal) | `CAPABILITY_KEYS` map (`capability-registry.ts`) | `platform-context` | — | Yes (**+ dead keys**) | Partly | Delete ~15 dead keys; document as UX-only |
| 12 | **Feature Gate** | Plan-based availability check | 402 on locked features | Permissions | (internal) | `enterpriseFeatures` flags + `require-enterprise-feature.ts` | `billing-enforcement` | — | Yes | Yes | No |
| 13 | **Permission** | A specific allowed action | **Authorization** (403 if absent) | Feature availability | (internal) | 86-`Permission` catalog (`permissions.ts:29`) | `access-policy.service.ts` | — | Yes | Yes | No |
| 14 | **Case** | A matter grouping evidence | Evidence grouping, matter workspace | Tenancy/billing | Case | `Case` (`:403`) | `cases` | `/cases`,`/cases/[id]` | Yes | Yes | No |
| 15 | **Evidence** | The core preserved object | Capture→fingerprint→sign→custody | — | Evidence | `Evidence` (`:9`) | `evidence` | `/evidence`,`/evidence/[id]` | Yes | Yes | No |
| 16 | **Report** | Immutable rendered output | Court-ready PDF | — | Report | `Report` (`:606`) | worker `report-v2` | `/reports` | Yes | Yes | No |
| 17 | **Verification Package** | Self-contained offline-verifiable bundle | Third-party verification | — | Verification Package | `VerificationPackage` (`:742`) | worker `verification-package` | `/reports` + `/verify` (public) | Yes | Yes | No |
| 18 | **Review Queue** | Reviewer work assignment surface | Review workflow | Tenancy | Review | reviewer-ops models | `reviewer-ops`, `review-operations` | `/review/*`,`/reviewer-ops/*` | Yes | Yes (layered) | No |
| 19 | **Governance Policy** | Retention/legal-hold/policy rules | Compliance enforcement | Data-plane read scope beyond governance | Governance | governance/lifecycle models | `governance`, `governance-lifecycle` | `/governance/*`,`/evidence-lifecycle/*` | Yes | Yes | No |
| 20 | **Audit / Compliance Surface** | Tamper-evident activity + attestation views | Transparency, compliance | Mutation | Audit | `AdminAuditLog`, custody chains | `platform-audit`, `audit-transparency` | `/audit-transparency`,`/admin/identity/timeline` | Yes | Yes | No |

**Verdict on the model:** the authority axes are **already correct and cleanly separated in code** (Plan≠Role≠Persona≠Workspace). The debt is entirely **naming + duplication** (concepts 4, 5, 6, 7, 10, 11), not authority mixing.

---

# PART 3 — Final Plan Architecture

**Final tiers = the repo's actual tiers (preserve them):** `FREE, PAYG, PRO, TEAM, ENTERPRISE` (`plan-catalog.ts:2`). ("Business/Team" in the brief = **TEAM**; PAYG is a metered personal variant of FREE.) Source of truth = `plan-catalog.ts:130-240`.

### Capability matrix (canonical)
| Capability | Free | PAYG | Pro | Team | Enterprise | Canonical Route | Gate Source | API Enforcement | UI Behavior (non-entitled) |
|---|:--:|:--:|:--:|:--:|:--:|---|---|---|---|
| Home | ✓ | ✓ | ✓ | ✓ | ✓ | `/home` | none | — | visible |
| Capture | ✓ | ✓ | ✓ | ✓ | ✓ | `/capture` | none | quota | visible |
| Evidence | ✓(3 lifetime) | ✓ | ✓(100) | ✓(500/mo) | ✓(∞) | `/evidence` | plan quota | `billing-enforcement` 402 | visible + cap banner |
| Cases | ✓ | ✓ | ✓ | ✓ | ✓ | `/cases` | none | — | visible |
| Reports / Verification Pkg | — | ✓ | ✓ | ✓ | ✓ | `/reports` | `reportsIncluded` | 402 | FREE: upgrade CTA |
| Public Verify | ✓ | ✓ | ✓ | ✓ | ✓ | `/verify` (public) | none | — | visible |
| Search | ✓ | ✓ | ✓ | ✓ | ✓ | `/search` | none | — | visible |
| Teams (collaboration) | — | — | ✓(2) | ✓(5) | ✓(1000) | `/collaboration-teams` | `allowsTeamWorkspace`/`maxOwnedTeams` | 402 | FREE/PAYG: upgrade CTA (never hidden entirely) |
| Intake Links | ✓ | ✓ | ✓ | ✓ | ✓ | `/intake-links` | none | — | visible |
| Investigation | — | — | ·adv | ✓ | ✓ | `/investigation/*` | tier PROFESSIONAL | capability | hidden < PRO |
| Review | — | — | ·adv | ✓ | ✓ | `/review/*`+`/reviewer-ops/*` | `REVIEWER_OPS_VIEW` | 403 | hidden w/o role |
| Intelligence | — | ·(quota) | ✓ | ✓ | ✓ | `/intelligence` | AI ops quota | 402 | quota banner |
| Redaction | — | — | ✓ | ✓ | ✓ | `/redaction/*` | tier | 402/403 | hidden < PRO |
| Governance | — | — | — | — | ✓ | `/governance/*` | `enterpriseFeatures.retentionPolicy` | 402 | hidden |
| Evidence Lifecycle | — | — | — | — | ✓ | `/evidence-lifecycle/*` | `legalHold`/`retentionPolicy`/`objectLock` | 402 + `directAccessPolicy:redirect` | hidden |
| Audit Center | — | — | — | — | ✓ | `/audit-transparency` | `organizationAuditLogs` | 402 | hidden |
| Executive | — | — | — | — | ✓ | `/executive` | tier ENTERPRISE | 402 | hidden |
| Organization admin | — | — | — | — | ✓ | `/organizations/[id]/admin/*` | org role | 403 | hidden |
| Security Center (workspace identity) | — | — | — | — | ✓ | `/security-center` | `ssoScim`/`mfaEnforcement`/`sessionGovernance` | 402 | hidden (account-security lives at `/settings/security` for all) |
| Admin Identity (SSO/SCIM/MFA) | — | — | — | — | ✓ | `/admin/identity/*` | `ssoScim` | 402 | hidden |
| Operations / Ops | — | — | — | — | platform-admin only | `/ops/*`,`/admin/*` | INTERNAL tier | platform-admin | hidden (staff) |
| API / Developer | — | — | ·(keys) | ✓ | ✓ | `/integrations` | tier | 403 | hidden < PRO |
| Billing / Settings / Persona | ✓ | ✓ | ✓ | ✓ | ✓ | `/billing`,`/settings`,`/settings/persona` | none | — | visible |

**Free/Pro users see ONLY:** Home, Capture, Evidence, Cases, Reports, Verify, Search, Teams (as CTA), Billing, Settings, Notifications. **They must NEVER see:** Operations, Organization admin, Governance, Compliance/Audit, SSO/SCIM, Legal Hold, Retention, Enterprise Identity, Internal Ops. (Enforced by wiring the dormant persona/tier visibility filter — Part 15 Phase 1/6.)

---

# PART 4 — Final Workspace / Organization Architecture

### First-login → enterprise (the canonical lifecycle)
1. **New signup →** `Personal Workspace` auto-created (`Team{isPersonal=true}`); no wizard. Land on `/home`.
2. **Create a Team →** at PRO+ (`allowsTeamWorkspace`), from `/collaboration-teams` ("New Team"). A Team is a collaboration subgroup, not a new tenant.
3. **Create/join an Organization →** when a user needs enterprise grouping (invited to one, or upgrades to ENTERPRISE). Org is optional; personal-only users never touch it.
4. **Enterprise mode appears →** when `plan==="ENTERPRISE"` or `isEnterpriseWorkspace` — unlocks Governance/Lifecycle/Identity/Org-admin surfaces *in place*.
5. **Workspace switching →** the space switcher (`/workspaces`) toggles the active `WorkspaceScope` (Personal | each Organization); one active space at a time.
6. **Org contains →** Organization › (Workspaces/Teams) › Members; governance inherits down; evidence tenancy stays on the workspace (`teamId`).

### Persona views (presentation only)
| Persona | Sees | Never sees |
|---|---|---|
| **Journalist / Individual** | Home, Capture, Evidence, Cases, Reports, Verify | Governance, Ops, Org admin, Identity |
| **Solo Lawyer** | + Cases emphasis, Redaction, Review (if role) | Enterprise governance/ops |
| **Investigator** | + Investigation, Intelligence, Graph | Org admin (unless admin) |
| **Small business / Team** | + Teams, Review, Assignments | Enterprise governance/identity |
| **Enterprise Admin** | + Organization, Governance, Identity, Security Center, Audit | Internal platform Ops |
| **Reviewer** | Review queues, assignments (via `REVIEWER_OPS_VIEW`) | Governance/admin unless granted |
| **Compliance Admin** | Governance, Retention, Legal Hold, Audit (via `GOVERNANCE_VIEW`+`SECURITY_CENTER_VIEW`) | Internal Ops |

### Final hierarchy
```
User → Account → Workspace (Personal | Organization) → [Organization grouping if enterprise] → Team (collaboration) → Case → Evidence → Report / Verification Package
```

### Current-vs-final concept comparison
| Concept in code | Status | Action |
|---|---|---|
| `Team` (tenancy) | **correct backing model, misleading product noun** | UI rename → "Workspace/Organization admin"; keep model |
| `CollaborationTeam` | **correct concept, awkward name** | UI = "Team"; keep model |
| `Organization` | **half-built** (governance-only; stale "not read" comment `:1062`) | finish or freeze |
| `TeamMember` | correct | keep |
| `OrganizationMembership` | correct (governance) | keep |
| `WorkspacePersonaProfile` | correct (stored persona) | keep; collapse other 4 projections |
| `/teams` + `/workspaces` | **inverted/duplicate product noun** | delete `/teams` landing; `/workspaces` = admin |

---

# PART 5 — Final Navigation Architecture

Final sidebar = **5 groups** (a cleaner projection of the 8 pillars; today's 4-group `canonicalNavigationGroups.ts` collapses Review+Investigation into Workspace and mixes Governance/Admin). One entry per capability.

| Group | Items (canonical route) | Who sees | Keep/Merge/Delete vs current |
|---|---|---|---|
| **Core** | Home `/home`, Capture `/capture`, Evidence `/evidence`, Cases `/cases`, Reports `/reports`, Search `/search` | all | KEEP |
| **Collaborate** | Teams `/collaboration-teams`, Intake `/intake-links`, Inbox `/inbox` | PRO+ (Teams as CTA below) | KEEP; DELETE `/teams` landing, `/collaboration` redirect |
| **Review & Investigation** | Review `/review`, Investigation `/investigation`, Intelligence `/intelligence`, Redaction `/redaction` | PRO+/role | KEEP; MERGE `/intelligence-platform`→`/intelligence`; unify `/review`+`/reviewer-ops` under one group; DELETE `/reviewer-ops/queue` |
| **Governance** | Governance `/governance`, Retention/Legal-Hold/Lifecycle `/evidence-lifecycle/*`, Audit `/audit-transparency`, Executive `/executive` | ENTERPRISE | KEEP; DELETE `/governance` stub (inline control plane) |
| **Administration** | Organization `/organizations/[id]/admin`, Members, Security Center `/security-center`, Identity `/admin/identity`, Developer `/integrations`, Operations `/ops/*` (platform-admin only) | ENTERPRISE / platform-admin | KEEP; consolidate `/ops`↔`/operations`; DELETE trust-center dupes |
| **System (account menu)** | Settings `/settings`, Billing `/billing`, Notifications `/notifications`, Persona `/settings/persona` | all | KEEP; DELETE `/settings/security/saml` redirect |

Trust: canonical authenticated Trust landing = **`/trust-hub`** (or a single `/trust` authenticated page — Part 0 decision); DELETE `/security/trust-center/*` and `/trust-center/*` shims after redirect verification.

---

# PART 6 — Final Onboarding Architecture

### Current persona/workspace wizard audit (`app/(app)/settings/persona/page.tsx`, 505L)
| Step / element | What it does | Verdict |
|---|---|---|
| Step 1 primaryProfile (7 use-cases) | PATCHes `WorkspacePersonaProfile.primaryProfile` | **KEEP** (move to first-run) |
| Step secondaryUseCases | stored | KEEP (optional) |
| operationalDensityPreference | stored; drives density CSS | KEEP only if it visibly changes UI; else DELETE |
| onboardingCompleted flag | gates wizard replay | KEEP |
| Save handler (`:135-161`) | `PATCH /v1/workspaces/:id/persona` **then `ctx.refresh()`** + emits `persona-profile:saved` | **Mechanism is CORRECT** |

**Why "Save persona appears to do nothing" — proven:** the save *does* persist and *does* refresh the envelope (the historical "flipped the flag without refreshing" bug was fixed — see the R1 Bug B comment at `settings/persona/page.tsx:102-105`, `ctx.refresh()` at `:159`). It *appears* to do nothing because persona currently only drives **nav ordering** (`resolveWorkflowExposure`), dashboard section order, density CSS, and banners/hints/empty-states — **not nav visibility**, since the persona pillar-visibility overlay in `resolveNavigationGroups` is **dormant** (`AppSidebarV2.tsx:667` calls it without `{persona}`, though the option exists: `navigationGroupingResolver.ts:99-110`). The single most visible expected effect — pages appearing/disappearing per use-case — never fires. **Fix = wire the persona option (Part 15 Phase 1).** After that, saving a persona visibly changes which surfaces show.

### Final onboarding flow (Linear/Notion-grade)
1. Signup → auto Personal Workspace (no wizard).
2. One optional screen: "What brings you to PROOVRA?" (6 tiles) → sets `primaryProfile`; skippable → `INDIVIDUAL`.
3. Land `/home` with a 3-step checklist (Capture → Verify → Invite/Upgrade).
4. Complexity reveals by (plan × persona) as the account grows.

**Gap → action:** move the use-case selector out of `/settings/persona` into a post-signup step (reuse the component); keep `/settings/persona` as a settings toggle; delete `operationalDensityPreference` if it has no visible effect (verify first).

---

# PART 7 — Final Settings Architecture

| Section | Canonical route | Owner | Who sees | Plan gate | Role gate | Current duplicates | Decision |
|---|---|---|---|---|---|---|---|
| Account | `/settings` | settings | all | — | — | — | KEEP (finish AccountSecurityCard removal) |
| Security (account) | `/settings/security` | identity | all | — | — | — | KEEP |
| Notifications | `/notifications` | notifications | all | — | — | — | KEEP |
| Billing | `/billing` | billing | all | — | owner/admin | — | KEEP |
| Workspace | `/organizations/[id]/admin/overview` + workspace prefs | workspace-admin | admins | — | admin | — | KEEP |
| Teams | `/collaboration-teams/[teamId]` | collaboration-team | members | PRO+ | team role | `/teams/[id]` (legacy) | MERGE→collab; DELETE legacy (P7) |
| Organization | `/organizations/[id]/admin/*` | organization | org admins | ENT | org role | — | KEEP |
| Members | `/organizations/[id]/admin/members` + team members | access-policy | admins | — | admin | 3-way (intentional tiers) | KEEP |
| Identity & SSO | `/security-center` + `/admin/identity` | identity | ENT admins | ENT (`ssoScim`) | admin | `/settings/security/saml` (redirect) | KEEP; DELETE saml shim |
| Developer / API | `/integrations` | integrations | PRO+ | tier | admin | — | KEEP |
| Governance | `/governance/*` | governance | ENT | ENT | gov role | — | KEEP |
| Compliance/Audit | `/audit-transparency` | audit | ENT | ENT | comp role | — | KEEP |
| Enterprise Admin | `/admin/*` | platform-admin | staff | INTERNAL | platform-admin | — | KEEP |

**Removals:** `/settings/security/saml` (redirect-only, DELETE); enterprise identity must not render inside personal `/settings` (finish the `IA-self-serve-simplification` migration — `settings/page.tsx:13-16`).

---

# PART 8 — Current Repo Gap Analysis (dispositions)

**Decision rule (covers all 154 pages):** any authenticated `page.tsx` **in `routeRegistry.ts` and backed by a live `/v1` API = KEEP**; **byte-identical/redirect-only/stub-no-API/orphan-not-in-registry = DELETE**; **re-export shell = DELETE after canonicalizing the URL**; **superseded landing = MERGE then DELETE**; **externally-shared legacy URL = REDIRECT**. Below are the **explicit non-KEEP dispositions** (everything not listed is KEEP by rule; the full 154-row inventory lives in the Master Audit Phase A).

| Route | File | Final destination | Decision | Reason / evidence | dup | orphan | stub | redirect | shell | in registry | in sidebar | Risk |
|---|---|---|---|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|---|
| `/security/trust-center/*` (6) | `app/(app)/security/trust-center/**` | `/trust-hub` | **DELETE** | byte-identical to `trust-center/*` (~776L) | ✓ | | | | | no | no | LOW |
| `/teams` | `app/(app)/teams/page.tsx` | `/collaboration-teams` / `/workspaces` | **DELETE** | 230L static stub, no API | | | ✓ | | | alias | no | LOW |
| `/governance` | `app/(app)/governance/page.tsx` | inline control-plane | **MERGE→DELETE** | 35L stub, no call | | | ✓ | | | yes | yes | LOW |
| `/intelligence-platform` | `app/(app)/intelligence-platform/page.tsx` | `/intelligence` | **MERGE→DELETE** | 439L, same `/v1/intelligence/*` | ✓ | | | | | yes | yes | MED |
| `/reviewer-ops/queue` | `app/(app)/reviewer-ops/queue/page.tsx` | `/review` | **DELETE** | 16L `redirect("/review")` | | | | ✓ | | dead id | no | LOW |
| `/settings/security/saml` | `app/(app)/settings/security/saml/page.tsx` | `/security-center/sso` | **DELETE+REDIRECT** | 39L redirect only | | | | ✓ | | no | no | LOW |
| `/inspect` | `app/(app)/inspect/page.tsx` | — | **DELETE** | 662L orphan, no registry/nav/Cmd-K | | ✓ | | | | no | no | LOW (gate: grep links) |
| `/verify-references` | `app/(app)/verify-references/page.tsx` | — | **DELETE** | 59L orphan | | ✓ | | | | no | no | LOW |
| `/trust-hub` vs `/trust-center` chain | `app/(app)/trust-hub/page.tsx`, `trust-center/*` | one canonical | **MERGE/REDIRECT** | `/trust` = marketing page; no auth `/trust` page | ✓ | | | ✓ | | mixed | no | MED (hard gate) |
| `/operations/{analytics,automation,media-graph,observability,runbooks,batch-analysis,quotas}` | `app/(app)/operations/**` | `/ops/*`,`/dashboard/*` | **DELETE (shells)** | ~10L `export {default} from …` | | | | | ✓ | yes | some | MED (P4) |
| `/collaboration` | `app/(app)/collaboration/page.tsx` | verify threads first | **KEEP-or-DELETE** | redirects but hits `/v1/collaboration/threads` | | | | ✓ | | legacy id | no | MED (verify) |
| `/teams/[id]` | `app/(app)/teams/[id]/page.tsx` | `/collaboration-teams/[teamId]` | **MOVE (P7)** | 2614L legacy `/v1/teams` backend | | | | | | yes | no | HIGH (backend) |

Everything else (Home, Capture, Evidence, Cases, Reports, Search, `/collaboration-teams/*`, `/governance/{analytics,retention,…}`, `/evidence-lifecycle/*`, `/review/*`, `/reviewer-ops/{escalations,sla,[reviewId]}`, `/investigation/*`, `/admin/identity/*`, `/security-center/*`, `/organizations/[id]/admin/*`, `/ops/*` impls, `/operations/{exports,queues,recovery,reliability,signers}`, `/executive`, `/intelligence-quality`, `/redaction/*`, `/workflows/*`, `/integrations`, `/notifications`, `/communications`, `/audit-transparency`, `/budget-center`, `/exchange`, `/packaging`, `/inbox`, `/settings*`, `/billing`) = **KEEP** — canonical, registered, live API, intentional tiered layering.

---

# PART 9 — Duplicate & Legacy Deletion Plan

For each: exact path · route · reason · **inbound-link grep** (run before delete) · redirect? · dead cascade · risk · rollback.

1. **`app/(app)/security/trust-center/` (dir)** · `/security/trust-center/*` · byte-identical dup · `grep -rn "security/trust-center" apps/web` · redirect→`/trust-hub` (yes, external) · dead: duplicate section components · LOW · git revert.
2. **`app/(app)/teams/page.tsx`** · `/teams` · stub · `grep -rn "\"/teams\"\|'/teams'" apps/web` · redirect→`/workspaces` (only if externally linked) · dead: none · LOW · revert.
3. **`app/(app)/governance/page.tsx`** · `/governance` · stub hub · `grep -rn "GovernanceControlPlane" apps/web` · no (inline) · dead: stub wrapper · LOW · revert.
4. **`app/(app)/intelligence-platform/page.tsx`** · `/intelligence-platform` · dup domain · `grep -rn "intelligence-platform" apps/web` · redirect→`/intelligence` · **merge budget panel first** · MED · revert (2 commits).
5. **`app/(app)/reviewer-ops/queue/page.tsx`** · redirect-only · `grep -rn "reviewer-ops/queue" apps/web` · no · dead: `review.queue` id · LOW · revert.
6. **`app/(app)/settings/security/saml/page.tsx`** · redirect-only · `grep -rn "settings/security/saml" apps/web` · yes→`/security-center/sso` · LOW · revert.
7. **`app/(app)/inspect/page.tsx`** · orphan · `grep -rn "\"/inspect\"\|'/inspect'\|href=\"/inspect" apps/web` · no · LOW · revert.
8. **`app/(app)/verify-references/page.tsx`** · orphan · `grep -rn "verify-references" apps/web` · no · LOW · revert.
9. **7 `operations/*` re-export shells** · re-export · `grep -rn "operations/analytics\|operations/automation\|…" apps/web` · canonicalize URL (P4) · MED · revert.
10. **`lib/navigation-config.ts`** (dead nav) · after migrating legacy tests · `grep -rn "navigation-config" apps/web` · no · dead: `NAVIGATION_GROUPS`,`ACCOUNT_MENU_ITEMS` · LOW · revert.

**Hard gates:** never delete a redirect until its target renders (the `/trust` trap — no `app/(app)/trust/page.tsx`); never delete `/collaboration` until `/v1/collaboration/threads` is confirmed relocated or unused.

---

# PART 10 — Teams / Workspace / Organization Consolidation

| # | Question | Final answer |
|---|---|---|
| 1 | Final user-facing Teams route | **`/collaboration-teams`** (UI label "Teams") |
| 2 | Final Workspace-admin route | **`/workspaces`** (→ `WorkspaceAdministrationHome`) + `/organizations/[id]/admin/*` for org |
| 3 | Final collaboration-team backend | **`/v1/collaboration-teams`** (`CollaborationTeam*` models) |
| 4 | Backend for tenancy/workspace | **`Team` model** (`:1004`) — stays; it backs billing/tenancy/evidence |
| 5 | Pages to delete | `/teams/page.tsx` (P2); `/teams/[id]` (P7 after backend move) |
| 6 | Routes that redirect | `/collaboration`→`/inbox` (exists); `/teams`→`/workspaces` if externally linked |
| 7 | Legacy backend endpoints | `/v1/teams/*` collaboration endpoints; `team-management.routes.ts` (in-memory org stub) |
| 8 | Must NOT touch | `Team` model tenancy/billing columns (`billingPlan`, `includedSeats`), Stripe/PayPal code (constitution) |
| 9 | Avoid breaking users | expand/contract: keep `/v1/teams` live during bake; backfill preserves source rows |
| 10 | Exact migration path | Part 15 Phase 7 (expand → backfill `CollaborationTeamMember` → repoint UI → retire) |

**Do NOT rename the Prisma `Team` model.** UI vocabulary (`Workspace`/`Team`) differs from model names — that is permitted and required.

---

# PART 11 — Enterprise Architecture Without Personal Breakage

Same navigation model; surfaces unlock by tier. What each tier sees, and what must **never** appear:

- **Personal (FREE/PAYG):** Core (Home/Capture/Evidence/Cases/Reports/Search), Billing, Settings, Notifications; Teams as upgrade CTA. **Never:** Governance, Ops, Org admin, Identity, Compliance, Audit, SSO/SCIM.
- **Pro:** + Investigation/Intelligence/Redaction/Review (·advanced), Developer/API, 2 Teams. **Never:** enterprise governance/identity/ops.
- **Team:** + full Teams (5), Review/assignments/routing, collaboration. **Never:** enterprise governance/identity/ops.
- **Enterprise:** + Organization admin, Governance, Retention, Legal Hold, Audit, Executive, Security Center, Admin Identity, SSO/SCIM, MFA enforcement, session governance, delegated admin. **Never:** internal platform Ops (`/ops`,`/admin` = platform-admin/INTERNAL only, even for enterprise customers).

Enterprise is **progressive disclosure of the same product**, not a second app. Every enterprise surface already exists and is KEEP — the fix is correct *gating*, not removal.

---

# PART 12 — Route Registry Constitution

**Rules (enforce forever):** every authenticated route MUST — (1) exist in `routeRegistry.ts`; (2) have exactly one owner module; (3) one pillar/group; (4) one plan tier; (5) one visibility policy (`sidebarEligible`/`commandPaletteVisible`/`allToolsVisible`); (6) one `directAccessPolicy` (`notFound`/`redirect`/`allow`); (7) declared `requiredActiveSpace`; (8) declared `requiredCapabilities` if gated; (9) declared enterprise/internal tier if gated. **Any authenticated `page.tsx` not in the registry is DELETED** (unless an approved dynamic/internal utility).

**Current violations:** orphans not in registry (`/inspect`, `/verify-references`); stale registry metadata (`dashboard.batch-analysis`/`quotas` marked "page does not exist" but pages exist); dead ids (`review.queue`, `workspace.intelligence_platform`); `/operations/*` shells lacking canonical single-owner; dormant persona-visibility not enforced.

**Enforcement tests:** (a) **registry-completeness test** — every `page.tsx` under `app/(app)/` has a registry entry or is on an allowlist; (b) **`phase-r13-route-persona-matrix.test.ts`** — extend to assert tier + persona *visibility* (not just capability); (c) **redirect-integrity test** — every redirect resolves to a 200 with no loop; (d) **no-import test** — no shell imports `navigation-config.ts`.

---

# PART 13 — API / Backend Surface Consolidation

| Concept | Canonical API | Legacy API | Migration | Must NOT touch | Data migration | Tests |
|---|---|---|---|---|---|---|
| Teams (collab) | `/v1/collaboration-teams` | `/v1/teams/*` collab endpoints | P7 expand/contract | `Team` tenancy/billing cols | backfill `CollaborationTeamMember` | parity + reversibility |
| Org admin | real Organization service | `team-management.routes.ts` (in-memory stub) | reroute then delete stub | — | none | org route tests |
| Workspace/tenancy | `Team`-backed `WorkspaceScope` | — | none | billing enforcement | none | billing regression |
| Governance | `/v1/governance/*` | — | none (canonical) | — | none | — |
| Security/Identity | `/v1/admin/identity/*`, `/v1/identity-security/*`, `/v1/auth/saml/*` | — | none | — | none | — |
| Operations | `/v1/ops/*` + `/v1/operations/*` | — | consolidate URL prefix (P4) | — | none | redirect tests |
| Delegated admin | one vocabulary | 2 (`DelegatedAdminTier` vs `DelegatedAdminScopeKind`) | collapse | — | none | — |

---

# PART 14 — Final Target Architecture Blueprint

1. **Noun dictionary:** User · Account · Workspace (Personal|Organization) · Organization · **Team = CollaborationTeam** · Member · Role · Plan · Persona(use-case) · Capability(UX) · Permission(authz) · Case · Evidence · Report · Verification Package · Review · Governance · Audit.
2. **Plan matrix:** Part 3.
3. **Role/permission model:** `TeamRole`→canonical 5-role→86 `Permission` (`access-policy.service.ts`), widened by `MemberCapabilityGrant`+`MemberDelegatedAdminScope`; fail-closed. Single engine — protect it.
4. **Persona model:** one stored `WorkspacePersonaProfile` (7 use-cases); presentation only; other 4 projections derived, not parallel.
5. **Workspace/org/team model:** Part 4 hierarchy.
6. **Navigation groups:** Core · Collaborate · Review&Investigation · Governance · Administration (+ System account menu). Part 5.
7. **Authenticated route map:** the ~90 registry routes minus the Part-9 deletions (≈128 pages final).
8. **Settings map:** Part 7.
9. **Onboarding map:** Part 6.
10. **Upgrade path:** FREE(3 evidence)→PAYG/PRO(personal power)→TEAM(collaboration)→ENTERPRISE(governance+identity), in-product CTAs on locked surfaces.
11. **Enterprise expansion:** create Organization → SSO/SCIM/MFA → Governance/Lifecycle/Legal-Hold → Org admin/delegated tiers.
12. **Deletion list:** Part 9 (10 items).
13. **Merge list:** `intelligence-platform`→`intelligence`; `governance` stub→control-plane; trust-center trees→one trust landing; `operations/*` shells→canonical.
14. **Redirect list:** `/security/trust-center/*`→`/trust-hub`; `/settings/security/saml`→`/security-center/sso`; `/teams`→`/workspaces` (if linked); existing `/dashboard`,`/collaboration`,`/operations` redirects.
15. **Backend migration list:** `/v1/teams`→`/v1/collaboration-teams`; delete `team-management.routes.ts`; collapse delegated-admin vocab; finish/freeze Organization.
16. **Test suite plan:** registry-completeness, extended persona-matrix (tier+visibility), redirect-integrity, no-`navigation-config`-import, billing regression, collab-team parity, migration reversibility.

---

# PART 15 — Execution Roadmap (8 phases)

Refines `PROOVRA_MASTER_AUDIT_EXECUTION_ROADMAP.md`. Low-risk deletion first; backend migration last; no destructive DB change before Phase 7.

| Phase | Scope | Modify | Delete | Routes/APIs | Risk | Rollback | Tests | User result | Must NOT touch |
|---|---|---|---|---|---|---|---|---|---|
| **0 Baseline** | decisions + test baseline | — | — | — | — | — | full suite green | none | — |
| **1 Persona/sidebar leakage** | wire persona visibility + first-run onboarding | `AppSidebarV2.tsx:667` (pass `{persona}`), `pillarRegistry.ts:340` (audit map), `home/page.tsx` (checklist) | — | all sidebar (visibility) | LOW | revert 1 line | extended persona-matrix; nav unit; persona-neutrality pins | clean nav per persona; persona save visibly works | permission engine |
| **2 Delete duplicates/stubs/orphans** | Part 9 items | `routeRegistry.ts`, `next.config.js` | items 1–8,10 | trust-center dup, teams stub, gov stub, reviewer-ops/queue, saml, inspect, verify-references | LOW–MED | git revert | smoke + build; redirect gates | ~13 dead surfaces gone | `/trust` gate, `/collaboration` gate |
| **3 Nav & registry alignment** | one URL/feature; resolve `/ops`↔`/operations` | `next.config.js` (fix loop), `routeRegistry.ts` (dead ids, stale meta) | `navigation-config.ts`, 7 op shells | `/operations/*`→`/ops/*` | MED | revert | redirect-integrity; smoke | no loops; registry == live | — |
| **4 Onboarding/settings** | move persona to first-run; finish settings de-dup | `settings/persona`, `settings/page.tsx` | density pref if inert | `/settings/*` | LOW–MED | revert | settings snapshot | clean settings domains | billing |
| **5 Teams/workspace/org UI vocabulary** | product-noun standardization (labels) | registry/nav labels, `packages/ui` copy, docs | — | none (labels) | MED | revert labels | vocabulary pin | consistent nouns | Prisma `Team` model |
| **6 Enterprise progressive disclosure** | align tier metadata to plan matrix | `routeRegistry.ts` tiers, `tiers.ts` | — | gated routes | MED | revert tiers | matrix contract per plan; API 402 gates | plan-consistent surface | API gates (keep) |
| **7 Backend/API consolidation** | `/v1/teams`→`/v1/collaboration-teams`; delete org stub | collab-team service, migration, `/teams/[id]` | `team-management.routes.ts`, legacy `/v1/teams` collab, `/teams/[id]` | `/v1/teams`,`/v1/organizations` | HIGH | expand/contract; down-migration | parity; migration reversibility; billing regression | one team backend | `Team` tenancy/billing; Stripe |
| **8 Lock-in tests** | enforce constitution | tests only | — | — | LOW | — | registry-completeness; redirect-integrity; no-import; matrix | regressions blocked forever | — |

---

# PART 16 — Final Brutally Honest Verdict

1. **Fundamentally wrong, or partially correct but unfinished?** **Partially correct but unfinished.** The authority model (Plan≠Role≠Persona≠Workspace) and the navigation system (`routeRegistry` + pillars + persona matrix) are *correctly designed* and better than most Series-B SaaS. The product feels off because migrations hid instead of deleted, and parallel vocabularies were never collapsed.
2. **Global-enterprise-grade without a rewrite?** **Yes.** Zero rewrite. It is consolidation + wiring + one backend migration. The enterprise surfaces already exist and are correct — they need gating, not building.
3. **Top 10 critical inconsistencies:** (1) dormant persona-visibility filter (`AppSidebarV2:667`); (2) 154 pages vs ~90 registry routes; (3) `security/trust-center` byte-identical dir; (4) `/ops`↔`/operations` redirect loop (`next.config` 34 vs 205-225); (5) three "team" surfaces (`/teams`,`/collaboration-teams`,`/workspaces`) + inverted nouns; (6) two team backends (`/v1/teams` vs `/v1/collaboration-teams`); (7) `Organization` half-built + stale "not read" comment (`:1062`); (8) 5 persona projections / 3 role vocabularies / 2 capability catalogs / 2 delegated-admin vocabularies; (9) `/trust` has no authenticated page (marketing page target of auth redirects); (10) stub hubs (`/governance`,`/teams`) + orphan `/inspect`.
4. **Top 10 deletions:** `security/trust-center/` dir; `/teams` stub; `/governance` stub; `/intelligence-platform` (merge); `/reviewer-ops/queue`; `/settings/security/saml`; `/inspect`; `/verify-references`; 7 `operations/*` shells; `navigation-config.ts` + `team-management.routes.ts`.
5. **Top 10 never-delete:** the permission engine (`access-policy.service.ts`); `plan-catalog.ts`; `routeRegistry.ts`/`pillarRegistry.ts`; `Team` tenancy/billing model; `CollaborationTeam*`; `Organization` (finish it); all real governance/lifecycle/identity surfaces; the evidence/report/verification pipeline; `WorkspacePersonaProfile`; the enterprise API gates.
6. **Top 10 risks:** deleting a redirect whose target 404s (`/trust`); `/ops`↔`/operations` loop; breaking billing during team migration; over-hiding a legitimately-entitled surface; losing `/v1/collaboration/threads` if `/collaboration` deleted blindly; persona map errors hiding core routes; registry/`next.config` drift; collapsing role vocabularies changing an authz result; data-migration correctness (P7); test baselines not captured (P0).
7. **Exact final model:** `User → Account → Workspace (Personal|Organization) → [Organization] → Team → Case → Evidence → Report/Verification Package`, with Plan=entitlement, Role=permission, Persona=presentation, Workspace=scope.
8. **Fix before ANY new feature:** wire persona/tier visibility (P1); adopt the registry-completeness rule (P8) so new pages can't bypass the registry.
9. **Fix before public launch:** P1–P4 (persona leakage, delete dead pages, nav/registry alignment, onboarding/settings) — so a normal user sees a clean, coherent product; plus the `/trust` authenticated-landing fix.
10. **Fix before enterprise launch:** P5–P7 (noun standardization, progressive-disclosure enforcement, backend team unification + finish/freeze Organization) — so enterprise surfaces are correctly placed and gated, and there is one team backend.

**Constitutional bottom line:** PROOVRA does not need to be rebuilt or split into a separate enterprise product. It needs to **finish what it already specified**: delete the ~13 proven-dead surfaces, wire the dormant persona/tier filters, standardize the tenancy vocabulary, and unify one backend. Execute Phases 0–8 against this constitution and PROOVRA becomes a single product that scales cleanly from a solo journalist to an enterprise organization — one architecture, one route per capability, no duplicate products.
