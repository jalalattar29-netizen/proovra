# PROOVRA Phase 4 — Route × Persona Visibility Matrix

> **Status:** CANONICAL ▸ enforced by Phase R13 source-contract test.
> **Date:** 2026-06-01.
> **Owner:** Architecture.

This document is the **single source of truth** for "which persona
should see which route, where (sidebar / Cmd-K / Tools page), in
what state (visible / hidden / upgrade-CTA), with what denial
message". Phase R13 (`services/api/test/phase-r13-route-persona-matrix.test.ts`)
asserts the matrix against the live route registry.

If a row here disagrees with `apps/web/lib/navigation/routeRegistry.ts`,
the registry is wrong — fix it.

---

## 1. Personas

| Code | Persona | Definition (from envelope) |
|------|---------|----------------------------|
| **IND-FREE** | Individual Free | `workspace.scope = "PERSONAL"`, `plan ∈ {"FREE"}`, role = "OWNER" of personal team, `isPlatformAdmin = false`. |
| **IND-PRO** | Individual PRO | Same as IND-FREE except `account.plan = "PRO"` (user-level entitlement). |
| **PERS-TEAM** | Personal user with Team collaboration | IND-FREE/PRO who has been INVITED to or created an additional non-personal Team. |
| **ORG-MBR** | Organization Member | `workspace.scope = "TEAM"`, `isPersonal = false`, role ∈ {"MEMBER", "VIEWER"}. |
| **ORG-ADM** | Organization Admin | Same as ORG-MBR but role ∈ {"OWNER", "ADMIN"}. |
| **REV** | Reviewer | Any persona with `REVIEWER_OPS_VIEW` capability (typically org members assigned the reviewer role). |
| **COMP** | Compliance / Security | Any persona with `GOVERNANCE_VIEW` + `SECURITY_CENTER_VIEW`. |
| **PLAT-ADM** | Platform Admin | `User.platformRole = "admin"` → `isPlatformAdmin = true`. Internal staff. |

---

## 2. Visibility legend

| Symbol | Meaning |
|--------|---------|
| **✓** | Visible — route loads normally; sidebar item rendered. |
| **○** | Visible with upgrade CTA — route surface renders but with an intentional Plan-Upgrade or Create-Organization panel. Used sparingly for product-led growth surfaces. |
| **·** | Visible but advanced — route is discoverable in Cmd-K and Tools page, but hidden from sidebar (collapsed under "More" or "Advanced"). |
| **—** | Hidden — route NOT rendered in sidebar OR Cmd-K OR Tools page for this persona. No 404, no denial chip, no upgrade nag. |
| **⌥** | Hidden in sidebar, available in Tools/Cmd-K with structured denial — for routes that are technically reachable but require a capability the persona doesn't yet have (e.g. a reviewer in an org with no Governance role). |

---

## 3. Route × Persona matrix (87 routes)

### 3.1 Account tier (always available to any signed-in user)

| Route | Path | IND-FREE | IND-PRO | PERS-TEAM | ORG-MBR | ORG-ADM | REV | COMP | PLAT-ADM |
|-------|------|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `account.settings` | `/settings` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `account.billing` | `/billing` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `account.persona` | `/settings/persona` | · | · | · | · | · | · | · | · |
| `account.organizations` | `/organizations` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `account.organization-detail` | `/organizations/:id` | — | — | — | ✓ | ✓ | ✓ | ✓ | ✓ |
| `account.org-invite-accept` | `/org-invites/:token/accept` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `account.inbox` | `/inbox` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `admin.teams` | `/workspaces` *(label: "Workspaces" — the personal + org list)* | · | · | · | · | · | · | · | · |
| `workspace.tools` | `/tools` | · | · | · | · | · | · | · | · |

### 3.2 Personal-or-Org core work surfaces (the product)

| Route | Path | IND-FREE | IND-PRO | PERS-TEAM | ORG-MBR | ORG-ADM | REV | COMP | PLAT-ADM |
|-------|------|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `workspace.home` | `/home` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `workspace.capture` | `/capture` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `workspace.evidence` | `/evidence` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `workspace.cases` | `/cases` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `workspace.reports` | `/reports` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `workspace.search` | `/search` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `workspace.notifications` | `/notifications` | · | · | · | · | · | · | · | · |
| `workspace.trust` | `/trust` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `workspace.integrations` | `/integrations` | · | · | · | · | ✓ | · | · | · |
| `workspace.intake_links` | `/intake-links` | · | · | · | · | ✓ | · | · | · |
| `workspace.workflows` | `/workflows` | · | · | · | · | ✓ | · | · | · |
| `workspace.security_center` | `/security-center` | · | · | · | · | ✓ | · | ✓ | · |
| `workspace.communications` | `/communications` | · | · | · | · | ✓ | · | · | · |
| `workspace.intelligence` | `/intelligence` | · | · | · | · | ✓ | · | · | · |
| `workspace.collaboration` | `/collaboration` | · | · | ✓ | ✓ | ✓ | · | · | · |
| `workspace.evidence_requests` | `/evidence-requests` | — | — | — | — | — | — | — | — | *(page missing — Phase 4 hides until built)* |

### 3.3 Investigation surfaces

| Route | Path | IND-FREE | IND-PRO | PERS-TEAM | ORG-MBR | ORG-ADM | REV | COMP | PLAT-ADM |
|-------|------|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `investigation.hub` | `/investigation` | · | · | · | · | ✓ | · | · | · |
| `investigation.timeline` | `/investigation/timeline` | · | · | · | · | · | · | · | · |
| `investigation.relationships` | `/investigation/relationships` | · | · | · | · | · | · | · | · |
| `investigation.graph` | `/investigation/graph` | · | · | · | · | · | · | · | · |
| `investigation.duplicates` | `/investigation/duplicates` | · | · | · | · | · | · | · | · |
| `investigation.reviewers` | `/investigation/reviewers` | — | — | — | · | ✓ | · | · | · |

### 3.4 Dashboard / quotas (page-missing in Phase 4 — hidden everywhere)

| Route | Path | All personas |
|-------|------|:--:|
| `dashboard.quotas` | `/dashboard/quotas` | — |
| `dashboard.insights` | `/dashboard/insights` | — |
| `dashboard.batch_analysis` | `/dashboard/batch-analysis` | — |

### 3.5 Reviewer Operations (REVIEW_OPS_VIEW gated)

| Route | Path | IND-FREE | IND-PRO | PERS-TEAM | ORG-MBR | ORG-ADM | REV | COMP | PLAT-ADM |
|-------|------|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `workspace.review` | `/review` | — | — | — | ⌥ | ✓ | ✓ | — | ✓ |
| `workspace.review_workspace` | `/review/workspace` | — | — | — | — | ✓ | ✓ | — | ✓ |
| `workspace.review_queues` | `/review/queues` | — | — | — | — | ✓ | ✓ | — | ✓ |
| `workspace.coding_schemas` | `/review/schemas` | — | — | — | — | · | · | — | · |
| `workspace.review_qc` | `/review/qc` | — | — | — | — | · | · | — | · |
| `workspace.review_disagreements` | `/review/disagreements` | — | — | — | — | · | · | — | · |
| `workspace.review_metrics` | `/review/metrics` | — | — | — | — | · | · | — | · |
| `workspace.review_external` | `/review/external` | — | — | — | — | ✓ | · | — | · |
| `workspace.review_redaction` | `/redaction` | — | — | — | — | · | · | — | · |
| `review.escalations` | `/reviewer-ops/escalations` | — | — | — | — | · | · | — | · |
| `review.queue` | `/review` | — | — | — | — | — | — | — | — | *(duplicate id of `workspace.review`; Phase 4 removes one)* |
| `review.queue_detail` | `/reviewer-ops/[reviewId]` | — | — | — | — | — | — | — | — | *(deep link only; never in nav)* |
| `review.operations` | `/review/operations` | — | — | — | — | · | · | — | · |
| `review.sla` | `/reviewer-ops/sla` | — | — | — | — | · | · | — | · |

### 3.6 Governance (Organization + GOVERNANCE_VIEW)

| Route | Path | IND-FREE | IND-PRO | PERS-TEAM | ORG-MBR | ORG-ADM | REV | COMP | PLAT-ADM |
|-------|------|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `governance.hub` | `/governance` | — | — | — | — | ✓ | — | ✓ | ✓ |
| `governance.policy` | `/governance/policy` | — | — | — | — | · | — | ✓ | · |
| `governance.analytics` | `/governance/analytics` | — | — | — | — | · | — | ✓ | · |
| `governance.lifecycle` | `/governance/lifecycle` | — | — | — | — | · | — | ✓ | · |
| `governance.destruction` | `/governance/destruction` | — | — | — | — | · | — | ✓ | · |
| `governance.notifications` | `/governance/notifications` | — | — | — | — | · | — | ✓ | · |
| `governance.retention` | `/governance/retention` | — | — | — | — | · | — | ✓ | · |
| `workspace.audit_transparency` | `/audit-transparency` | — | — | — | — | · | — | ✓ | · |
| `workspace.evidence_lifecycle` | `/evidence-lifecycle` | — | — | — | — | · | — | · | · |
| `workspace.governance_platform` | `/governance-platform` | — | — | — | — | · | — | ✓ | · |

### 3.7 Organization platform surfaces (ORGANIZATION_ONLY)

| Route | Path | IND-FREE | IND-PRO | PERS-TEAM | ORG-MBR | ORG-ADM | REV | COMP | PLAT-ADM |
|-------|------|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `admin.identity` | `/settings/security` | — | — | — | — | · | — | · | · |
| `workspace.intelligence_quality` | `/intelligence-quality` | — | — | — | — | · | — | · | · |
| `workspace.trust_center` | `/trust-center` | — | — | — | · | · | — | · | · |
| `workspace.budget_center` | `/budget-center` | — | — | — | — | · | — | — | · |
| `workspace.exchange` | `/exchange` | — | — | — | — | · | — | — | · |
| `workspace.executive` | `/executive` | — | — | — | — | · | — | — | · |
| `workspace.intelligence_platform` | `/intelligence-platform` | — | — | — | — | · | — | — | · |
| `workspace.packaging` | `/packaging` | — | — | — | — | · | — | · | · |
| `security_center.mfa_recovery` | `/security-center/mfa-recovery` | — | — | — | — | · | — | · | · |

### 3.8 Platform Operations (PLATFORM-ADMIN only — constitutional rule 9)

These routes carry `requiredActiveSpace: PLATFORM_ADMIN` (Phase 4 fix)
+ `fallbackBehavior: HIDDEN_IF_NO_CAPABILITY` so a non-platform-admin
sees nothing.

| Route | Path | IND-FREE | IND-PRO | PERS-TEAM | ORG-MBR | ORG-ADM | REV | COMP | PLAT-ADM |
|-------|------|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `platform.admin` | `/admin` | — | — | — | — | — | — | — | ✓ |
| `platform.ops_center` | `/ops` | — | — | — | — | — | — | — | ✓ |
| `platform.observability` | `/ops/observability` | — | — | — | — | — | — | — | ✓ |
| `platform.runbooks` | `/ops/runbooks` | — | — | — | — | — | — | — | ✓ |
| `platform.automation` | `/ops/automation` | — | — | — | — | — | — | — | · |
| `platform.analytics` | `/ops/analytics` | — | — | — | — | — | — | — | · |
| `platform.media_graph` | `/ops/media-graph` | — | — | — | — | — | — | — | · |
| `platform.reliability` | `/operations/reliability` | — | — | — | — | — | — | — | · |
| `platform.queue_ops` | `/operations/queues` | — | — | — | — | — | — | — | · |

---

## 4. Required canonical denial messages (Phase 3 vocabulary)

When a route IS visible but the user lacks capability, the panel
MUST render copy from `@proovra/shared`:

| Persona × Route shape | DenialReason | Headline (from `denialReasonHeadline`) |
|----------------------|--------------|----------------------------------------|
| IND-FREE on org-only governance | `ORGANIZATION_REQUIRED` | "Activate in an organization workspace" |
| IND-FREE on plan-gated surface (rare — most should be hidden) | `UPGRADE_REQUIRED` | "Plan upgrade required" |
| ORG-MBR on admin surface | `PERMISSION_REQUIRED` | "Permission required" |
| Any non-platform-admin on `/admin` | (hidden — never rendered) | n/a |
| Personal user with no active workspace | `WORKSPACE_REQUIRED` | "Workspace setup required" |
| Session revoked | `SESSION_REVOKED` | "Session ended" |

**Forbidden copy strings:**
- "Workspace setup required" rendered to a user who has a healthy
  Personal Space (Phase R9 fixed; Phase 4 R13 re-pins).
- "Requires Permission" on any route the persona should not see at
  all (use Hidden instead).
- "Switch to Team Workspace" anywhere (constitutional rule 4).
- "Team Workspace required" anywhere.
- "Reviewer Workspace" or "Governance Workspace" or "Operations
  Workspace" anywhere.

---

## 5. Page-existence guarantee

Every route marked **✓** OR **○** OR **·** for any persona in §3 MUST
have a corresponding `apps/web/app/(app)/<href>/page.tsx`.

**Page-missing routes** (Phase R13 fails CI if any are visible):

| Route | Path | Phase 4 disposition |
|-------|------|---------------------|
| `dashboard.quotas` | `/dashboard/quotas` | Hidden everywhere |
| `dashboard.insights` | `/dashboard/insights` | Hidden everywhere |
| `dashboard.batch_analysis` | `/dashboard/batch-analysis` | Hidden everywhere |
| `workspace.evidence_requests` | `/evidence-requests` | Hidden everywhere |

These routes remain in the registry (for backwards-compat with API
clients that linked to them historically) but their `sidebarEligible`,
`commandPaletteVisible`, and `allToolsVisible` are forced to `false`
in Phase 4.

---

## 6. Phase 4 registry deltas (the metadata fix-list)

The following registry entries change in Phase 4. Net behaviour delta:
hide enterprise/admin noise from Personal users; hide platform-admin
ops from non-staff; relabel `admin.teams` from "Workspaces" to "Teams".

| Route | Field | Before | After |
|-------|-------|--------|-------|
| `platform.admin` | already correct | — | — |
| `platform.ops_center` | `requiredActiveSpace` | `PERSONAL_OR_ORG` | `PLATFORM_ADMIN` |
| `platform.ops_center` | `fallbackBehavior` | `REQUEST_ACCESS` | `HIDDEN_IF_NO_CAPABILITY` |
| `platform.observability` | `requiredActiveSpace` | `PERSONAL_OR_ORG` | `PLATFORM_ADMIN` |
| `platform.observability` | `fallbackBehavior` | `REQUEST_ACCESS` | `HIDDEN_IF_NO_CAPABILITY` |
| `platform.runbooks` | `requiredActiveSpace` | `PERSONAL_OR_ORG` | `PLATFORM_ADMIN` |
| `platform.runbooks` | `fallbackBehavior` | `REQUEST_ACCESS` | `HIDDEN_IF_NO_CAPABILITY` |
| `platform.automation` | `requiredActiveSpace` | `PERSONAL_OR_ORG` | `PLATFORM_ADMIN` |
| `platform.automation` | `fallbackBehavior` | `REQUEST_ACCESS` | `HIDDEN_IF_NO_CAPABILITY` |
| `platform.analytics` | `requiredActiveSpace` | `PERSONAL_OR_ORG` | `PLATFORM_ADMIN` |
| `platform.analytics` | `fallbackBehavior` | `REQUEST_ACCESS` | `HIDDEN_IF_NO_CAPABILITY` |
| `platform.reliability` | `requiredActiveSpace` | `PERSONAL_OR_ORG` | `PLATFORM_ADMIN` |
| `platform.reliability` | `fallbackBehavior` | `REQUEST_ACCESS` | `HIDDEN_IF_NO_CAPABILITY` |
| `platform.queue_ops` | `requiredActiveSpace` | `PERSONAL_OR_ORG` | `PLATFORM_ADMIN` |
| `platform.queue_ops` | `fallbackBehavior` | `REQUEST_ACCESS` | `HIDDEN_IF_NO_CAPABILITY` |
| `platform.media_graph` | `requiredActiveSpace` | `PERSONAL_OR_ORG` | `PLATFORM_ADMIN` |
| `platform.media_graph` | `fallbackBehavior` | `REQUEST_ACCESS` | `HIDDEN_IF_NO_CAPABILITY` |
| `admin.teams` | (no change — label "Workspaces" is correct; this IS the workspaces list) | — | — |
| `workspace.evidence_requests` | `sidebarEligible` | `true` | `false` *(page missing)* |
| `workspace.evidence_requests` | `commandPaletteVisible` | `true` | `false` |
| `workspace.evidence_requests` | `allToolsVisible` | `true` | `false` |
| `dashboard.quotas` | all visibility | `true` | `false` |
| `dashboard.insights` | all visibility | `true` | `false` |
| `dashboard.batch_analysis` | all visibility | `true` | `false` |
| Org-only routes (`requiredActiveSpace: ORGANIZATION_ONLY`) | (no registry change; sidebar component filters them out for PERSONAL active space) | sidebar shows "Create Org" CTA for personal users | sidebar hides; Tools/Cmd-K still show with Create-Org CTA |
| `review.queue` | (no change — id retained as legacy binding; all visibility already `false`) | — | — |

---

## 7. Test pinning

Phase R13 (`services/api/test/phase-r13-route-persona-matrix.test.ts`)
asserts:

1. The 9 platform-ops routes have `requiredActiveSpace === "PLATFORM_ADMIN"`.
2. The 4 page-missing routes have all three visibility flags `false`.
3. `admin.teams.label === "Teams"`.
4. No route definition contains the forbidden strings "Team
   Workspace", "Reviewer Workspace", "Governance Workspace",
   "Operations Workspace".
5. Every route with `sidebarEligible: true` has a corresponding
   `apps/web/app/(app)/<href>/page.tsx` file.
6. The duplicate `review.queue` id is removed.
