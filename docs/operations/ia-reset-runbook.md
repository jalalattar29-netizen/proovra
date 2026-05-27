# IA Reset — Phase B Runbook

**Audience:** all product engineers, ops, customer success.

**Purpose:** describe PROOVRA's canonical operational information architecture established in Phase B — what the new hierarchy means, which routes belong to which group, what changed about navigation, and how to use the new artifacts (breadcrumb, group mapping).

---

## 1. The Phase B canonical hierarchy

Every PROOVRA destination belongs to **exactly one** of four operational groups:

| Group | What it is | Primary destinations |
|---|---|---|
| **Workspace** | Daily operational execution surfaces | Home · Review · Matters · Evidence · Capture · Intake · Inbox · Search |
| **Governance** | Optional operational oversight | Governance hub · Organizations · Security Center · Workspaces (admin) |
| **Outputs** | Verification deliverables | Reports (Report PDFs + Verification Package ZIPs) |
| **System** | Preferences, support, platform health | Settings · Billing · Notifications · Integrations · All Tools |

The hierarchy is the source of truth for:

- The Phase B canonical breadcrumb component (`OperationalBreadcrumb`).
- Documentation + operator runbooks.
- Telemetry / analytics grouping when grouping destinations.
- The eventual sidebar surfacing (deferred — see §6).

The hierarchy is implemented in [apps/web/lib/navigation/phaseBOperationalGroups.ts](apps/web/lib/navigation/phaseBOperationalGroups.ts). Every route id in the registry MUST appear in one group, asserted by the Phase B contract test.

---

## 2. Route consolidation actions taken in Phase B

| Action | Why | Effect |
|---|---|---|
| Registered `workspace.review` → `/review` | Phase C0 made `/review` the canonical Reviewer Console, but the registry didn't list it | Operator-facing primary route for review work |
| Registered `review.operations` → `/review/operations` | Phase 13 per-evidence review queue was an orphan page | Now discoverable from All Tools + command palette |
| Registered `workspace.evidence_requests` → `/evidence-requests` | Phase C3 intake inspector was an orphan page | Now linkable from the matter context + All Tools |
| Removed `/review → /reviewer-ops` redirect | The redirect was bypassing Phase C0 — operators landing on `/review` were bounced to the legacy `/reviewer-ops` surface | Operators on `/review` now see the canonical Reviewer Console |
| Renamed `review.queue` label to "Reviewer queues" (was "Reviewer Operations") + marked `advancedByDefault: true` | Disambiguated from the canonical `workspace.review` | "Review" is the primary nav entry; "Reviewer queues" is the legacy / advanced surface |
| Added `/ops/reliability → /operations/reliability` alias | Phase B audit found one `/operations/*` path leftover in an otherwise `/ops/*` family | Operations URLs now appear consistent regardless of the path the operator types |

**Out of scope (deferred):** the legacy `/cases/[id]/classic` route is preserved (Phase C1 explicitly designed it as the escape hatch for mutation actions until the Matter Workspace gains inline mutation in C1.2).

---

## 3. The canonical breadcrumb

`OperationalBreadcrumb` lives at [apps/web/components/navigation/OperationalBreadcrumb.tsx](apps/web/components/navigation/OperationalBreadcrumb.tsx).

The audit confirmed PROOVRA had **no canonical breadcrumb component** before Phase B. Each page invented its own back-navigation pattern, and operators lost their workspace context when drilling into nested surfaces.

**The breadcrumb renders three to four crumbs in order:**

1. **Workspace** — the active workspace name from `usePlatformContext()`. Always anchored to `/home`.
2. **Phase B group** — `Workspace` / `Governance` / `Outputs` / `System`, derived from the page's `routeId` via `operationalGroupDescriptor()`.
3. **Parent surface (optional)** — passed via the `items` prop (e.g. "Matters", "Matter title").
4. **Current entity (optional)** — the last item in `items`.

```tsx
<OperationalBreadcrumb
  routeId="workspace.cases"
  items={[
    { label: "Matters", href: "/cases" },
    { label: caseTitle }, // last item — non-clickable, marked current
  ]}
/>
```

**Hard rules:**

- Reads the active workspace from the platform context envelope. Never re-fetches.
- Renders no mutation actions. Pure read-only navigation.
- Vocabulary is operational only. No SaaS-flavoured breadcrumbs.

**Where it's mounted in Phase B:**

- [apps/web/app/(app)/cases/[id]/page.tsx](apps/web/app/(app)/cases/[id]/page.tsx) (canonical Matter Workspace)
- [apps/web/app/(app)/evidence-requests/[id]/page.tsx](apps/web/app/(app)/evidence-requests/[id]/page.tsx) (Phase C3 inspector)

Future iterations can mount it on additional nested surfaces (Evidence detail, Reviewer Console inspector, governance sub-pages) without rewriting the component.

---

## 4. Route registry — current state

After Phase B, the route registry contains **70 entries** (audit baseline was 67 + 3 Phase B additions). Each one maps to exactly one Phase B group via `phaseBOperationalGroups.ts`.

**Primary destination count (operator-facing top-level nav):** approx 17 (Workspace 8 + Governance 4 + Outputs 1 + System 5 — well below the brief's ~25 ceiling and inside the contract test's hard ceiling of 30).

**Secondary destinations** (advanced flows, hidden surfaces, account-tier settings, platform admin sub-pages) total approx 53. These remain reachable from the All Tools surface, command palette, and contextual links, but never crowd the primary navigation.

---

## 5. Terminology normalization

Phase B does NOT rename any existing surface labels in this iteration (a rename would risk breaking the CR0 baseline + cascading test failures). The Phase B contribution to terminology is the **canonical group hierarchy itself** — the next iteration can use this hierarchy to drive a coordinated rename through:

1. `phaseBOperationalGroups.ts` group titles (already canonical).
2. Route registry `label` fields.
3. Sidebar group titles (currently pinned by CR0).

Terminology gaps deferred to a future phase (CR6 sign-off):

- "Cases" (UI) vs "Matters" (internal model) — Phase B documentation uses "Matters" in the breadcrumb but `/cases` URLs are preserved.
- "Reviewer Ops" vs "Review" vs "Review Operations" — Phase B introduces "Review" as the primary surface and demotes "Reviewer queues" to advanced.
- "Workspaces" (UI label) vs `/teams` (URL) — Phase B0 already standardized the UI; URL alias is deferred.

---

## 6. Why the sidebar wasn't rewritten in this phase

The Phase B brief calls for a four-group sidebar (Workspace / Governance / Outputs / System) with ~25 primary destinations. PROOVRA's existing sidebar (per Phase R2) already has four groups (Primary workflows / Workspace / Operations / Governance & Compliance), pinned by the **CR0 baseline test**. Renaming the sidebar groups would:

- Trip the CR0 baseline pin (`ALLOWED_ROOT_GROUP_TITLES`).
- Cascade across phase-32.8B / phase-32.8C / phase-38.6 / phase-r2 tests.
- Require a CR6 sign-off per the existing R2 contract.

Phase B's pragmatic move:

1. **Establish the canonical operational hierarchy** in code (`phaseBOperationalGroups.ts`) so it's the source of truth for documentation, breadcrumbs, telemetry, and future renames.
2. **Map every existing route to its Phase B group** so the future sidebar refactor is a mechanical transform, not an IA redesign.
3. **Ship the breadcrumb** that uses the new hierarchy on the two most-nested operator surfaces.
4. **Land the route registry + redirect fixes** that close real bugs (`/review` redirect bypassing Phase C0) without touching the sidebar group titles.

The sidebar rename is recorded as **B.1** in the deferred follow-ups registry.

---

## 7. Operational validation (per the Phase B spec)

1. **Is the platform now operationally coherent?** Materially yes — the canonical four-group hierarchy is in code, breadcrumbs surface workspace + group context, and Phase C0/C3 orphan routes are now registered.
2. **Did destination count reduce meaningfully?** The registry is unchanged in count (registry-level consolidation is deferred to the sidebar rewrite). Phase B's contribution is the **group mapping** that makes future consolidation mechanical.
3. **Are reviewer workflows more connected?** Yes — `/review` no longer redirects away from Phase C0's canonical Reviewer Console.
4. **Are matter/evidence flows more connected?** Yes — the breadcrumb keeps Workspace + Phase B group context visible while operators drill into Matter Workspace + Evidence Request inspector.
5. **Is workspace context always visible?** On the surfaces where the breadcrumb is mounted, yes. Other nested surfaces are deferred to a follow-up.
6. **Is governance discoverable without overwhelming users?** Yes — Governance is a Phase B group in the canonical hierarchy, with the existing Governance hub and Organizations as primary entries. Solo users still see the same simple shape.
7. **Is navigation easier for enterprise evaluators?** Materially yes — the canonical hierarchy is now documented, source-of-truth, and inspectable from the breadcrumb DOM data attributes.
8. **Did any operational workflows break?** 349/349 phase contract tests green; 10 baseline failures unchanged; one Phase 32.8B assertion explicitly superseded (the `/review` redirect Phase B intentionally removes).
9. **Is PROOVRA now easier to explain operationally?** Yes — the four-group hierarchy is the explanation.
10. **Does the platform feel like one coherent operational system?** Materially yes — but the full sidebar rewrite is required to fully realise this, and Phase B's job is to make that rewrite mechanical rather than another full IA debate.

---

## 8. Reference

- Phase B canonical hierarchy: [apps/web/lib/navigation/phaseBOperationalGroups.ts](apps/web/lib/navigation/phaseBOperationalGroups.ts)
- Canonical breadcrumb: [apps/web/components/navigation/OperationalBreadcrumb.tsx](apps/web/components/navigation/OperationalBreadcrumb.tsx)
- Route registry (with the three Phase B additions): [apps/web/lib/navigation/routeRegistry.ts](apps/web/lib/navigation/routeRegistry.ts)
- Next.js redirects (Phase B adjustments): [apps/web/next.config.js](apps/web/next.config.js)
- Tests: [services/api/test/phase-b-ia-reset.test.ts](services/api/test/phase-b-ia-reset.test.ts) (42 source-contract tests)
- Phase R2 navigation (predecessor): [apps/web/lib/navigation/canonicalNavigationGroups.ts](apps/web/lib/navigation/canonicalNavigationGroups.ts)

---

## 9. Deferred follow-ups

Recorded in `docs/architecture/deferred-followups.md` as **B.1–B.6**:

- **B.1** — Sidebar rewrite to consume `phaseBOperationalGroups.ts` (requires CR6 sign-off on the new group titles).
- **B.2** — Breadcrumb mount on remaining nested surfaces (Evidence detail, Reviewer Console, governance sub-pages, dashboard sub-pages).
- **B.3** — Terminology normalization in registry labels (e.g., "Cases" → "Matters" if Phase B group consensus prevails).
- **B.4** — Move `/operations/reliability` filesystem path to `/ops/reliability` to retire the Phase B alias redirect.
- **B.5** — Retire `/cases/[id]/classic` once Matter Workspace gains inline mutation (carryover from C1.2).
- **B.6** — Global operational quick-jump (Cmd+K extension to surface workspace destinations by Phase B group).
