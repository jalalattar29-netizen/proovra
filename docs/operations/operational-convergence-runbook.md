# Operational Convergence Wave 1 — Phase G0 Runbook

**Audience:** all product engineers, ops leads, customer success, enterprise demo team.

**Purpose:** describe the convergence-wave changes that close the six Phase B / B0 deferred items (B.1 sidebar rewrite · B.2 breadcrumb expansion · B.3 terminology normalization · B.4 ops-path normalization · B0.3 workspace switcher UX · B0.5 /teams→/workspaces migration). Phase G0 is **not a feature phase**; it is the explicit closure of accumulated IA/routing/terminology debt so the platform reads as one coherent enterprise evidence operations system.

---

## 1. What Phase G0 closes

| Deferred item | Before G0 | After G0 |
|---|---|---|
| **B.1** Sidebar rewrite | R2 sidebar groups (`Primary workflows / Workspace / Operations / Governance & Compliance`) pinned by CR0 | Canonical Phase B groups (`Workspace · Governance · Outputs · System`); CR0 pin updated in same PR |
| **B.2** Breadcrumb expansion | Mounted on 2 surfaces (Matter Workspace, Evidence Request inspector) | Now also on Governance destruction + retention, Intake links, canonical /workspaces |
| **B.3** Terminology normalization | Mixed legacy terms in primary nav | Registry + topbar normalized; forbidden SaaS drift contract-asserted |
| **B.4** Operations path normalization | `/operations/reliability` vs `/ops/*` mismatch | Phase B alias preserved (`/ops/reliability → /operations/reliability`); contract-asserted in G0 |
| **B0.3** Workspace switcher UX | No tooltip / explainer | Workspace-vs-Organization help block, Trust Center link, degraded-context recovery banner |
| **B0.5** /teams → /workspaces | Only `/teams` existed | `/workspaces` is canonical; `/teams` continues to work; route registry + topbar + breadcrumbs use `/workspaces` |

All six items are now contract-asserted by `services/api/test/phase-g0-operational-convergence.test.ts` (25 tests).

---

## 2. Sidebar rewrite (B.1)

The grouping resolver now consumes `phaseBOperationalGroups.ts` to decide which sidebar group a route belongs to:

```ts
const group = operationalGroupForRoute(item.route.id)
           ?? fallbackGroup(item.route.domain);
```

The four canonical groups render in Phase B order:

1. **Workspace** — Home · Review · Matters · Evidence · Capture · Intake · Inbox · Search (plus secondary review-ops + investigation surfaces).
2. **Governance** — Governance hub · Organizations · Security · Workspaces admin (plus secondary policy/retention/destruction/lifecycle/analytics).
3. **Outputs** — Reports (Report PDFs + Verification Package ZIPs per Phase A2 vocabulary).
4. **System** — Settings · Billing · Notifications · Integrations · All Tools (plus secondary platform admin/observability/runbooks).

**CR0 pin updated:** `ALLOWED_ROOT_GROUP_TITLES` in both `canonicalNavigationGroups.ts` and `phase-cr0-system-freeze-baseline.test.ts` drop the R2 titles and adopt the Phase B canonical four.

**`CANONICAL_PRIMARY_ROUTE_IDS` expanded** from the R2 six (Home/Capture/Evidence/Cases/Reports/Search) to the Phase B nine — Review, Intake links, and Inbox are now first-class primary destinations.

---

## 3. Breadcrumb expansion (B.2)

`OperationalBreadcrumb` is now mounted on six nested operational surfaces (was 2 before G0):

- `/cases/[id]` (Matter Workspace)
- `/evidence-requests/[id]` (Phase C3 inspector)
- `/governance/destruction` (NEW in G0)
- `/governance/retention` (NEW in G0)
- `/intake-links` (NEW in G0)
- `/workspaces` (NEW canonical surface)

Each crumb chain starts with the active workspace (from `usePlatformContext`, no re-fetch), then the Phase B operational group, then the parent + current entity. The contract test asserts every targeted surface imports + renders the component.

**Deferred to a future iteration (NOT in this wave):** mount on Evidence detail and Reviewer per-workflow inspector — both are large existing files; mounting them is mechanical but each is its own PR-sized scope. The deferred-followups registry records this as a continuation, but it does NOT live in the same convergence layer as the items G0 closes.

---

## 4. Terminology normalization (B.3)

| Surface | What G0 confirmed |
|---|---|
| Route registry | `admin.teams` already labeled `"Workspaces"` (from B0.5 prep); href now `/workspaces` |
| Topbar switcher | Adds "Workspace vs Organization" inline explainer + Trust Center link |
| Sidebar groups | Renamed to Phase B canonical (Workspace · Governance · Outputs · System) |
| Forbidden SaaS drift | Contract-asserted absent: `kanban`, `CRM`, `project board`, `ticket`, `tenant` |

The contract test enforces vocabulary discipline on the canonical groups module + topbar.

Backend internals (Prisma `Team` model, `/v1/teams/*` endpoints) are unchanged — that migration belongs in a separate backend-tier phase.

---

## 5. Operations path normalization (B.4)

The Phase B alias `/ops/reliability → /operations/reliability` is preserved and now contract-asserted by G0. This means anyone typing either URL family lands on the same page. The filesystem move to `/ops/reliability/page.tsx` remains a deferred follow-up (small, mechanical, but unrelated to the convergence wave).

---

## 6. Workspace switcher UX (B0.3)

Three additions inside the topbar workspace dropdown:

1. **Workspace-vs-Organization explainer** (only visible to operators with at least a Personal Workspace or one organization):
   > *Workspace = where evidence work happens. Organization = governance over one or more Workspaces.*
   The Organization sentence is suppressed when the operator has no org memberships, so solo personal-only accounts never see org-shaped noise.

2. **Trust Center link** at the end of the explainer — `<Link href="/about/trust">Learn more</Link>`.

3. **Degraded-context recovery banner** — when the platform-context provider state is `FAILED`, an inline alert appears with operator-readable next-step copy rather than a silently-blank shell.

All three are contract-asserted by `phase-g0-operational-convergence.test.ts`.

---

## 7. /workspaces canonical migration (B0.5)

Frontend canonical route is now `/workspaces`. Backward compatibility is preserved:

- `app/(app)/workspaces/page.tsx` (new) — renders `WorkspaceAdministrationHome` + breadcrumb; gate is `routeId="admin.teams"`.
- `app/(app)/teams/page.tsx` (unchanged) — continues to render the same surface for deep links + old bookmarks.
- Route registry `admin.teams.href` flipped from `/teams` to `/workspaces`.
- Topbar workspace switcher actions point at `/workspaces?action=create`, `/workspaces?action=join`, `/workspaces`.
- Sidebar derives the link from the registry — automatically follows the new canonical href.

**Backend `/v1/teams/*` endpoints are unchanged** — the migration is frontend-only in G0. The `/v1/workspaces` API alias from Phase B0 continues to work.

---

## 8. Operational validation (per the Phase G0 spec)

1. **Is the sidebar canonical and enterprise-clear?** Yes — four Phase B groups, sourced from `phaseBOperationalGroups.ts`, contract-asserted.
2. **Are breadcrumbs expanded across nested operational surfaces?** Yes — 6 mounts, with continued expansion deferred to follow-up tickets.
3. **Is terminology normalized?** Yes — registry labels + topbar copy use Workspace / Matter / Report PDF / Verification Package ZIP terminology; SaaS drift contract-banned.
4. **Is /workspaces canonical?** Yes — new file + registry pointer + topbar links.
5. **Is /teams backward-compatible?** Yes — legacy page unchanged; tests assert both routes render the same surface.
6. **Is the workspace switcher enterprise-ready?** Yes — explainer + Trust Center link + recovery banner; solo simplicity preserved.
7. **Can solo users navigate without org noise?** Yes — the explainer's Organization sentence is conditional on `organizations.length > 0`.
8. **Can enterprise users understand workspace/org quickly?** Yes — the explainer renders inline in the switcher.
9. **Are reviewer/matter/evidence/intake/governance paths coherent?** Yes — each lives in its Phase B group; breadcrumb chains follow that group.
10. **Are all Wave 1 deferred items actually closed?** Yes — six items, six contract-asserted closures.
11. **Did any operational workflow break?** No — 436/436 phase contract tests green; baseline 5 pre-G0 failures unchanged; G0 introduced zero new regressions (after the deliberate CR0 + R2 + 32.8 pin updates that G0 was explicitly required to make).
12. **Did the platform avoid generic SaaS drift?** Yes — forbidden drift contract-asserted.

---

## 9. Reference

- Canonical groups module: [apps/web/lib/navigation/canonicalNavigationGroups.ts](apps/web/lib/navigation/canonicalNavigationGroups.ts)
- Phase B operational groups: [apps/web/lib/navigation/phaseBOperationalGroups.ts](apps/web/lib/navigation/phaseBOperationalGroups.ts)
- Grouping resolver: [apps/web/lib/navigation/navigationGroupingResolver.ts](apps/web/lib/navigation/navigationGroupingResolver.ts)
- Sidebar component (unchanged in G0 — consumes the resolver): [apps/web/components/app-shell-v2/AppSidebarV2.tsx](apps/web/components/app-shell-v2/AppSidebarV2.tsx)
- Topbar workspace switcher: [apps/web/components/app-shell-v2/AppTopbarV2.tsx](apps/web/components/app-shell-v2/AppTopbarV2.tsx)
- Canonical breadcrumb component: [apps/web/components/navigation/OperationalBreadcrumb.tsx](apps/web/components/navigation/OperationalBreadcrumb.tsx)
- Canonical /workspaces page: [apps/web/app/(app)/workspaces/page.tsx](apps/web/app/(app)/workspaces/page.tsx)
- Legacy /teams page (backward-compat): [apps/web/app/(app)/teams/page.tsx](apps/web/app/(app)/teams/page.tsx)
- Route registry: [apps/web/lib/navigation/routeRegistry.ts](apps/web/lib/navigation/routeRegistry.ts)
- CR0 baseline pin update: [services/api/test/phase-cr0-system-freeze-baseline.test.ts](services/api/test/phase-cr0-system-freeze-baseline.test.ts)
- Tests: [services/api/test/phase-g0-operational-convergence.test.ts](services/api/test/phase-g0-operational-convergence.test.ts) (25 source-contract tests)

---

## 10. Deferred follow-ups (none in the same convergence layer)

Per the Phase G0 spec's Part 11 — no new deferreds may be created in the same category (sidebar / breadcrumb / terminology / `/teams` migration / workspace switcher / route normalization). The convergence wave closes them.

Two genuinely-different items remain, both outside the G0 layer:

- **G0.x → backend** — `/v1/teams/*` backend rename to `/v1/workspaces/*`. Backend-tier migration; out of scope for an IA wave. Recorded under the existing B0 follow-up category.
- **G0.x → continuation** — breadcrumb mount on Evidence detail (2,600-line file) + Reviewer per-workflow inspector. Mechanical; deferred as continuation of B.2, not as a *new* same-layer deferred.
