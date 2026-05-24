# PHASE R2 — Navigation Collapse & Information Architecture Recovery — Final Report

**Status:** Complete.
**Scope:** Information-architecture recovery via a canonical navigation pipeline. NO feature removal. NO permission rewrite. NO sidebar rewrite from scratch. NO new features. The sidebar component is the same `AppSidebarV2`; the grouping logic is now a formal canonical pipeline.

R2 transforms the sidebar from a feature-heavy enterprise debug console into a layered operational product. Same routes, same authorization, same discoverability — but the primary surface is bounded to the six canonical workflows and architecture leakage in degraded-route chips is gone.

---

## 1. Canonical root navigation

The root **"Primary workflows"** group is now bounded to six route ids:

| Route id | Surface |
| --- | --- |
| `workspace.home` | Home |
| `workspace.capture` | Capture |
| `workspace.evidence` | Evidence |
| `workspace.cases` | Cases |
| `workspace.reports` | Reports |
| `workspace.search` | Search |

Pre-R2, workflow / persona could promote ANY route into `primaryItems` (root nav). After R2, the disclosure resolver routes non-canonical workflow-promoted items into their domain group instead (`Workspace` / `Operations` / `Governance & Compliance` / `More / Advanced`). They remain visible — just not at root.

The bounded set lives in `apps/web/lib/navigation/canonicalNavigationGroups.ts` as `CANONICAL_PRIMARY_ROUTE_IDS`. Adding or removing an id is a deliberate IA decision; R2 Part 1 test pins the count at exactly 6.

---

## 2. Canonical operational groups

| Group | Title | Source-registry domains |
| --- | --- | --- |
| `SIDEBAR_GROUP_PRIMARY` | Primary workflows | n/a (bounded by route id) |
| `SIDEBAR_GROUP_WORKSPACE` | Workspace | `PERSONAL_WORKSPACE`, `ORGANIZATION_WORKSPACE`, `TEAM_ONLY` |
| `SIDEBAR_GROUP_OPERATIONS` | Operations | `REVIEW_OPERATIONS`, `OPS` |
| `SIDEBAR_GROUP_GOVERNANCE` | Governance & Compliance | `GOVERNANCE` |

Plus the two canonical disclosure surfaces preserved unchanged:

- "More / Advanced" — rendered by `SidebarMoreView` from the refined `moreAdvancedItems` bucket.
- "All Tools" — rendered inline in the sidebar; consumed from the unchanged `allToolsItems`.

The titles are pinned by CR0 (`phase-cr0-system-freeze-baseline.test.ts` Part 2) AND by R2 (Part 2 here). The CR0 scan was updated in R2 to include `canonicalNavigationGroups.ts` so the bounded vocabulary stays enforced as the source of truth moved.

---

## 3. Contextual operational hubs

The hub routes already exist in `routeRegistry.ts`. R2 does NOT delete or rebuild them — instead it lets the canonical pipeline route them appropriately:

- **Investigation hub** (`investigation.hub`) — domain `OPS`. Renders under Operations.
- **Governance hub** (`governance.hub`) — domain `GOVERNANCE`. Renders under Governance & Compliance.
- **Review queue hub** (`review.queue` / `review.escalations` / `review.sla`) — domain `REVIEW_OPERATIONS`. Renders under Operations.

For Personal Space, R1.5B's `PERSONAL_MODE_DEMOTION_ROUTE_IDS` set continues to push the governance + review hubs into "More / Advanced" (so they're discoverable but not noise). R2 keeps this exact behavior; the disclosure resolver folds the R1.5B demotion in as one step of the canonical pipeline.

---

## 4. Canonical navigation resolution pipeline

```
ROUTE_REGISTRY                       (data; lib/navigation/routeRegistry.ts)
    ↓
resolveRouteAccess()                 (authorization; unchanged)
    ↓
resolveWorkflowExposure()            (workflow bucketing; unchanged)
    ↓
resolveWorkspaceExperience()         (R1.5B mode + demotion set)
    ↓
resolveNavigationDisclosure()        (R2 — bounded primary + experience demotion fold-in)
    ↓
resolveNavigationGroups()            (R2 — bounded sidebar groups)
    ↓
AppSidebarV2                         (render only)
```

The new R2 resolvers live in:

- `apps/web/lib/navigation/canonicalNavigationGroups.ts` — bounded primary route ids, group definitions, chip-label dictionary.
- `apps/web/lib/navigation/navigationDisclosureResolver.ts` — pure transform that bounds primary + folds in experience demotion.
- `apps/web/lib/navigation/navigationGroupingResolver.ts` — pure transform that builds the sidebar groups from the refined disclosure result.

Pure functions. No authorization. No fetches. No async.

---

## 5. Progressive disclosure

Personal Space gets calmer root navigation:

- Only the 6 canonical primary routes appear in "Primary workflows".
- 10 ORG-only routes (governance.* + review.queue/escalations/sla) move into "More / Advanced" via the R1.5B demotion set.
- Workflow-promoted non-canonical routes fall into their domain group instead of root.

For ORGANIZATION sub-modes (`ORGANIZATION` / `REVIEW_OPS` / `GOVERNANCE`), the demotion set is empty — all current sidebar behavior is preserved. ORG operators keep their full operational surface.

The disclosure result includes `stats` for observability:

- `primaryBoundedCount` — items kept in primary (≤ 6).
- `primaryOverflowCount` — workflow-promoted items that fell to their domain group.
- `experienceDemotedCount` — R1.5B demoted items.

---

## 6. All Tools / Command Palette / direct links preservation

The disclosure resolver returns `exposure.allToolsItems` and `exposure.recommendedItems` **untouched**. Test 5 pins this.

- **All Tools** (`apps/web/app/(app)/tools/page.tsx`) — still iterates ROUTE_REGISTRY directly through `resolveRouteAccess` + `resolveWorkflowExposure`. Every permission-valid route is discoverable.
- **Command Palette** (`apps/web/components/navigation/CommandPalette.tsx`) — same. Cmd+K finds every permission-valid route by name.
- **Direct URLs** — unchanged. `/governance/policy`, `/reviewer-ops/escalations`, etc. continue to navigate to the same pages where `routeAccessResolver` decides what to render.
- **Backward-compat redirects** — the 8 CR1 Part 2 redirects in `next.config.js` are still in place (Test 10 pins this).

No discoverability collapse. No dead routes.

---

## 7. Raw architecture chips → operational language (Part 7)

The sidebar previously returned bare architecture words for the degraded-route chips:

| State | Before | After (R2) |
| --- | --- | --- |
| `NEEDS_ORGANIZATION` | "Org" | "Requires organization" |
| `NEEDS_PERSONAL_OR_ORG` | "Setup" | "Setup needed" |
| `DENIED_NO_CAPABILITY` | "Access" | "Requires permission" |
| `NEEDS_UPGRADE` | "Upgrade" | "Upgrade required" |

The labels live in `canonicalNavigationGroups.ts` as `DEGRADATION_CHIP_LABELS`, so a future copy update touches one place. R2 Part 7 test pins both the new labels' presence and the absence of the old raw strings.

R2 deliberately does NOT rename route labels in `routeRegistry.ts` ("Governance Analytics" → "Governance Insights" etc. from the spec examples). Route label canonicalization is R4's charter; R2 only cleaned the chips because they were clearly architecture leakage.

---

## 8. Sidebar structure refactor

The previously-inline `buildSidebarGroups()` function inside `AppSidebarV2.tsx` was extracted to `lib/navigation/navigationGroupingResolver.ts` as `resolveNavigationGroups()`. The behavior is byte-equivalent — the same groups appear in the same order, populated from the same domain sources. The extraction makes the pipeline testable and consumable.

R2 also:
- Removed the inline `SidebarGroup` type; the canonical type lives in the grouping resolver module and is re-imported.
- Removed `applyExperienceEmphasis` direct import — it's now consumed indirectly through the disclosure resolver.
- Renamed the local `demoted` variable to `disclosure` to reflect the new pipeline step.

`AppSidebarV2.tsx` is now ~110 lines shorter and reads as: read envelope → run pipeline → render groups. No inline IA logic.

---

## 9. Dashboard / navigation coherence

R1.5B already wired `resolveWorkspaceExperience` into the CommandCenter (sets `data-cc-experience-mode` + `data-cc-dashboard-emphasis`). R2 doesn't change the dashboard — it just confirms (Part 9 test) that CommandCenter and the sidebar consume the same resolver, so their experience-mode reading is guaranteed coherent.

Visual emphasis orchestration on the dashboard (per-mode section ordering, hero copy variants) belongs to R3. R2 only locks the coherence contract.

---

## 10. What moved into hubs

Nothing was actually deleted or relocated. The route registry is unchanged. The hub structure is the existing routeRegistry domain assignment (`investigation.hub`, `governance.hub`, `review.queue` etc.).

What changed: how those routes are EMPHASIZED in personal mode. They now consistently render under "More / Advanced" instead of competing for primary attention.

---

## 11. What remains discoverable

For every demoted / non-primary route:

- The route appears in **All Tools** (full list, with degradation chip if not currently usable).
- The route is findable in the **Command Palette** by name.
- The **direct URL** navigates to the page; the route-access resolver renders the structured "Create organization" or "Requires permission" CTA per its existing contract.
- The route appears in **search** if it has a registry entry.
- The route appears under **"More / Advanced"** in the sidebar (the disclosure surface is still rendered).

No legitimate tooling was hidden.

---

## 12. What R2 intentionally did NOT do

| Out of scope | Owner |
| --- | --- |
| Route label canonicalization ("Governance Analytics" → "Governance Insights") | R4 |
| Per-mode dashboard section ordering / hero copy | R3 |
| Per-mode help / empty-state copy | R4 |
| Hide demoted routes from All Tools too (a real UX decision) | R5 |
| Mega-menus / nested sidebars / floating architecture panels | NEVER |
| Workflow/persona authorization gates | NEVER |
| Hard-deleting any route | NEVER |
| Changing capture / custody / TSA / OTS / report / package | NEVER |

---

## 13. Files touched

### Created (3 source + 1 test + 1 doc)
- `apps/web/lib/navigation/canonicalNavigationGroups.ts`
- `apps/web/lib/navigation/navigationDisclosureResolver.ts`
- `apps/web/lib/navigation/navigationGroupingResolver.ts`
- `services/api/test/phase-r2-navigation-ia-recovery.test.ts`
- `docs/recovery/R2_NAVIGATION_IA_RECOVERY.md`

### Modified (3)
- `apps/web/components/app-shell-v2/AppSidebarV2.tsx` — replaced inline `buildSidebarGroups` + `applyExperienceEmphasis` with canonical pipeline; softened degradation chips via `DEGRADATION_CHIP_LABELS`.
- `services/api/test/phase-cr0-system-freeze-baseline.test.ts` — updated the title-literal scan to include `canonicalNavigationGroups.ts` as the new source of truth.
- `services/api/test/phase-r1-5b-workspace-segmentation.test.ts` — flipped two assertions to match the extracted pipeline (`resolveNavigationDisclosure` import; `items={disclosure.moreAdvancedItems}` render).

### Unchanged (verified by Test 12 file-size pins)
- All capture / custody / TSA / report / package source.
- Route registry, route access resolver, workflow exposure resolver, workspace-experience package.

---

## 14. Validation

Required: all 6 gates green.

- `pnpm --filter proovra-api typecheck`
- `pnpm --filter proovra-api test`
- `pnpm --filter proovra-web typecheck`
- `pnpm --filter proovra-web build`
- `pnpm --filter proovra-worker typecheck`
- `pnpm --filter proovra-worker test`

---

## 15. Remaining risks (honest)

- **R2 does NOT touch label copy beyond the chip dictionary.** "Governance Analytics", "Destruction Internals" etc. retain their existing labels. R4 owns canonicalization.
- **All Tools still shows every permission-valid route to personal users.** This is intentional (discoverability) but it means a personal user with curious clicking can still drill into governance / reviewer-ops via All Tools. R5 may decide to filter All Tools by experience mode too.
- **The 10-route demotion set (R1.5B) is conservative.** R5/R6 may expand or contract it after a real progressive-disclosure design pass.
- **No per-mode CSS rules consume `data-workspace-experience-mode` yet.** The attribute is wired; the styling is downstream (R3/R5/R6).
- **The 28 `useTeamId()` callsites remain.** R1.5B documented; R2 deferred migration. Each is PageRouteGate-wrapped so personal users don't load the page. R5/R6 may revisit.

---

## 16. Exact next phase recommendation

Per the locked CR0.5 §10 roadmap, the next phase is **R3 — Dashboard Orchestration**:

1. Consume `data-cc-experience-mode` + `data-cc-dashboard-emphasis` to orchestrate per-mode dashboard section ordering, hero copy, and recommended actions.
2. Personal mode emphasizes quick capture / recent evidence / reports / activity. ORG modes emphasize reviewer ops / governance posture / intake. One canonical dashboard, different orchestration.
3. Add source-contract tests pinning the per-mode orchestration contract so future drift surfaces in PR review.

R3 is the "make the dashboard feel like a focused workspace not a SOC dump" phase. R2 unlocked it by ensuring the sidebar and dashboard read the same experience mode.

---

## Hard confirmations

- ✅ Sidebar no longer feels like an internal debug console (root nav bounded to 6; raw architecture chips replaced).
- ✅ Personal Space root navigation is calm and understandable (6 primary routes; ORG-only routes under More/Advanced).
- ✅ Enterprise tooling still exists and remains discoverable (All Tools + Cmd+K + direct URLs + search).
- ✅ No duplicated products introduced (Test "no second sidebar component").
- ✅ No permission logic moved into workflow/persona (Test 10 — disclosure + grouping resolvers carry no auth predicates; routeAccessResolver unchanged).
- ✅ No routes hard-deleted (Test 3 — hubs + sub-surfaces still in registry).
- ✅ No discoverability collapse (Test 5 — disclosure resolver returns allToolsItems untouched; Test 6 — All Tools + Command Palette unchanged).
- ✅ No capture / upload / finalize / custody / TSA / OTS / report / package regression (Test 12 — file-size pins).

**R2 SUCCESS:** PROOVRA finally feels like a layered enterprise product. One canonical pipeline. Bounded root. Architecture leakage gone from chips. Personal Space stops looking like a debug console. ORG users keep the full operational surface. Same canonical product, different layer of polish.
