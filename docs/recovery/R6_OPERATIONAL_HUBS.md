# PHASE R6 — Operational Hubs & Tool Consolidation — Final Report

**Status:** Complete.
**Scope:** A canonical hub-orchestration library + a shared `HubQuickActionsBar` mounted at the top of all 4 existing hub pages (investigation / governance / reviewer-ops / ops). NO portal pages. NO mega-dashboards. NO duplicated tooling. NO permission forks.

R6 turns the four canonical hub pages into coherent **workflow orchestration surfaces** — they keep their existing content, but each now opens with a bounded header that answers "what operational work do I need to do now?" for its domain.

---

## 1. Hub philosophy

A hub is a **workflow orchestration surface**, not a route collection. It answers "what operational work do I need to do now?" — never "what pages exist?".

R6 establishes the canonical vocabulary in code:

| File | Purpose |
| --- | --- |
| `apps/web/lib/hubs/types.ts` | `HubId` union (bounded to 4); `HubDefinition`, `HubQuickAction`, `HubContextResult` types. |
| `apps/web/lib/hubs/hubDefinitions.ts` | The bounded per-hub definition — title, subtitle, ≤4 quick actions, member-route-id list, landing route id. |
| `apps/web/lib/hubs/resolveHubContext.ts` | Pure resolver returning the definition + bounded quick actions. No fetches, no auth predicates. |
| `apps/web/lib/hubs/index.ts` | Barrel. |
| `apps/web/components/hubs/HubQuickActionsBar.tsx` | Bounded shared component — title + subtitle + R5 disclosure help + ≤4 quick actions. |

---

## 2. Investigation Center

**Hub id:** `investigation`. **Landing route:** `investigation.hub` (`/investigation`).

Existing rich Phase 31.12 Investigation Overview content remains unchanged below the bar. The R6 hub bar adds:

| Quick action | Destination | Intent |
| --- | --- | --- |
| Open investigation timeline | `/investigation/timeline` | primary |
| Open relationship graph | `/investigation/graph` | primary |
| Review duplicates | `/investigation/duplicates` | secondary |
| Open reviewer assignments | `/investigation/reviewers` | secondary |

**Member routes** (descriptive, no behavioral change): `investigation.hub`, `investigation.timeline`, `investigation.graph`, `investigation.duplicates`, `investigation.relationships`, `investigation.reviewers`.

---

## 3. Governance Center

**Hub id:** `governance`. **Landing route:** `governance.hub` (`/governance`).

Existing `GovernanceControlPlane` content remains unchanged below the bar.

| Quick action | Destination | Intent |
| --- | --- | --- |
| Review retention policy | `/governance/retention` | primary |
| Review lifecycle actions | `/governance/lifecycle` | primary |
| Open governance insights | `/governance/analytics` (R4-renamed) | secondary |
| Open governance policy | `/governance/policy` | secondary |

**Member routes:** `governance.hub`, `governance.retention`, `governance.lifecycle`, `governance.destruction`, `governance.analytics`, `governance.notifications`, `governance.policy`.

---

## 4. Reviewer Center

**Hub id:** `reviewer`. **Landing route:** `review.queue` (`/reviewer-ops`).

Existing `ReviewerCommandConsole` content remains unchanged below the bar.

| Quick action | Destination | Intent |
| --- | --- | --- |
| Open reviewer queue | `/reviewer-ops` | primary |
| Review escalations | `/reviewer-ops/escalations` | primary |
| Check SLA | `/reviewer-ops/sla` | secondary |

**Member routes:** `review.queue`, `review.escalations`, `review.sla`, `review.queue_detail`.

---

## 5. Operations Center

**Hub id:** `operations`. **Landing route:** `platform.ops_center` (`/ops`).

Existing Phase 21 operations content remains unchanged below the bar.

| Quick action | Destination | Intent |
| --- | --- | --- |
| Open observability | `/ops/observability` | primary |
| Open runbooks | `/ops/runbooks` | primary |
| Manage integrations | `/integrations` | secondary |

**Member routes:** `platform.ops_center`, `platform.observability`, `platform.runbooks`, `platform.reliability`, `workspace.integrations`.

---

## 6. Hub orchestration system

`resolveHubContext({ hubId, capabilities? })` returns `{ definition, quickActions }`. Pure. No fetches. No auth predicates. Capability map is OPTIONAL and never used to filter quick actions — hiding a quick action by capability would be a permission fork (forbidden by R6). The destination route's own `PageRouteGate` handles unauthorized clicks.

Defensive fallback: an unrecognized hub id falls back to `investigation`. The `HUB_QUICK_ACTIONS_MAX = 4` slice protects against future drift in the definitions file.

---

## 7. Hub quick actions

Every quick-action `href` references an EXISTING registered route in `routeRegistry.ts`. Test 2 cross-checks this with a regex sweep. Adding a quick action that points at a non-registered route breaks the build.

Per-hub bounds (Test 2):
- Investigation: 4 actions (max).
- Governance: 4 actions (max).
- Reviewer: 3 actions.
- Operations: 3 actions.

The bound stops feature-cemetery growth and keeps each hub focused on its operational workflow.

---

## 8. Contextual entry-point routing

R6 does NOT introduce new routing logic. Direct routes still work the same way:

- Clicking "Duplicate review" from anywhere navigates to `/investigation/duplicates` — same canonical destination, same PageRouteGate.
- Clicking "Open governance posture" navigates to `/governance` — the Governance Center, where the R6 hub bar greets the operator.
- Clicking "Open reviewer queue" navigates to `/reviewer-ops` — the Reviewer Center.

The hubs are now the **natural workflow homes** because each hub page opens with the bounded quick-action bar that lists the related operational entry points. Operators arriving at any hub page see the workflow context immediately.

R6 does NOT add a router, a redirect map, or any pre-routing layer.

---

## 9. Hub language & UX consistency

The hub bar consumes:

- **R4 canonical vocabulary** (`operationalTerminology.ts`) — title/subtitle copy uses "Investigation Center", "Governance Center", "Reviewer Center", "Operations Center" naming.
- **R5 disclosure help** (`resolveDisclosureHelp(mode)`) — the bar surfaces the mode-aware primary help line so personal users and ORG users see contextually-appropriate hints.
- **R1.5B workspace experience** (`resolveWorkspaceExperience`) — the bar reads the experience mode and exposes it as `data-hub-experience-mode` so R10 styling can target.

No marketing fluff. No dramatic copy. No raw architecture chips (R4 forbidden list scanned by Test 8).

---

## 10. Direct routes + All Tools + Cmd+K — preserved

The hub bar is presentation-only. Discoverability paths are untouched:

- **All Tools** (`apps/web/app/(app)/tools/page.tsx`) — still iterates `ROUTE_REGISTRY` directly. Every hub member route appears (Test 6).
- **Command Palette** — still iterates `ROUTE_REGISTRY` directly. Every hub member route findable.
- **Direct URLs** — unchanged. `PageRouteGate` still gates every hub page.
- **R5 disclosure tier** — every hub member route still has its R5 tier (governance/reviewer routes still demote for PERSONAL mode + lift to "contextual" for ORG with capability).

Test 6 pins every one of the ~20 hub member route ids still exists in the registry — no deletions.

---

## 11. What R6 intentionally did NOT do

| Out of scope | Owner |
| --- | --- |
| Mega-portal pages (`HubPortal.tsx`, `MegaDashboard.tsx`) | NEVER (Test 5 forbids) |
| Per-hub dashboard components (`InvestigationPortal.tsx`, etc.) | NEVER (Test 5 forbids) |
| Capability-filtered quick actions (would be a permission fork) | NEVER |
| Re-routing logic / pre-route middleware | NEVER |
| Hard-deleting any registry entry | NEVER |
| Changing capture / custody / TSA / OTS / report / package | NEVER |
| Visual styling beyond minimal inline header layout | R10 |
| Hub-specific empty-state copy beyond the disclosure help line | R10 / R11 |

---

## 12. Files touched

### Created (5 source + 1 component + 1 test + 1 doc)
- `apps/web/lib/hubs/types.ts`
- `apps/web/lib/hubs/hubDefinitions.ts`
- `apps/web/lib/hubs/resolveHubContext.ts`
- `apps/web/lib/hubs/index.ts`
- `apps/web/components/hubs/HubQuickActionsBar.tsx`
- `services/api/test/phase-r6-operational-hubs.test.ts`
- `docs/recovery/R6_OPERATIONAL_HUBS.md`

### Modified (4 — minimal touch)
- `apps/web/app/(app)/investigation/page.tsx` — imports + 4-line wrapper around existing `InvestigationOverviewPageInner`.
- `apps/web/app/(app)/governance/page.tsx` — imports + 4-line wrapper around existing `GovernanceControlPlane`.
- `apps/web/app/(app)/reviewer-ops/page.tsx` — imports + 4-line wrapper around existing `ReviewerCommandConsole`.
- `apps/web/app/(app)/ops/page.tsx` — imports + 4-line wrapper around existing `OpsPageInner`.

### Unchanged (verified by Test 10 file-size pins)
- All capture / custody / TSA / report / package source.
- All backend services + worker.
- Route registry, route access resolver, workflow exposure resolver.
- R2 navigation pipeline, R1.5B workspace-experience, R3 dashboard orchestration, R4 product-language, R5 disclosure model.

---

## 13. Validation

Required: all 6 gates green.

- `pnpm --filter proovra-api typecheck`
- `pnpm --filter proovra-api test`
- `pnpm --filter proovra-web typecheck`
- `pnpm --filter proovra-web build`
- `pnpm --filter proovra-worker typecheck`
- `pnpm --filter proovra-worker test`

---

## 14. Remaining risks (honest)

- **R6 does NOT add CSS rules.** The hub bar's inline styles are minimal scaffolding; R10 owns visual polish.
- **The 4 hub quick-action sets are conservative.** R7+ may expand or contract as new operational surfaces earn hub placement.
- **Hub bar is mounted at the page top.** It is a HEADER strip, not a left-rail panel — preserves existing page content layout for the 4 large hub pages.
- **No per-mode visibility for the bar.** The bar renders in all experience modes today. A future phase may decide to hide the Governance Center bar for personal users (currently `PageRouteGate` already short-circuits with "Create or switch organization" before the bar mounts in personal context).
- **No registry annotation for hub membership.** The `memberRouteIds` field in each hub definition is the source of truth; if the registry restructures, this list must track manually. Test 6 pins every listed id still exists.
- **No backend orchestration changes.** R6 is frontend-only. Backend continues to expose the same per-domain endpoints.

---

## 15. Exact next phase recommendation

Per the locked CR0.5 §10 roadmap, the next phase is **R7 — Onboarding & Setup Recovery**:

1. Use R6 hub vocabulary + R5 disclosure help to author proper onboarding flows for the 4 experience modes.
2. Replace any remaining generic "complete setup" copy with mode-specific operational guidance.
3. Surface the hub quick-actions in the dashboard onboarding hint so new operators see the canonical entry points.
4. Persist onboarding completion through the existing `workspacePersonaProfile.onboardingCompleted` field.

R7 is the phase where the orchestration layers (R1.5B / R2 / R3 / R5 / R6) start guiding new users through the operational platform via the canonical hubs.

---

## Hard confirmations

- ✅ Hubs are operational workflow surfaces, not route dumps (Test 5 — no portal / mega-dashboard files; bounded ≤4 quick actions per hub).
- ✅ Advanced tooling now feels connected (Test 3 — every hub page mounts the bar with bounded quick actions linking to related routes).
- ✅ No duplicated products introduced (Test 5 — no `HubPortal` / `InvestigationPortal` / `GovernanceDashboard` / etc.).
- ✅ No giant admin-console pages created (Test 5 — bar < 6 KB; no new mega-page files).
- ✅ Direct routes still work (Test 6 — every hub member route still in registry; PageRouteGate still wraps each hub page).
- ✅ All Tools / Cmd+K still expose advanced tooling (Test 6 — both still iterate ROUTE_REGISTRY directly).
- ✅ No permission logic moved into workflow/persona (Test 7 — resolver + definitions carry no auth predicates).
- ✅ No capture / upload / finalize / custody / TSA / OTS / report / package regression (Test 10 file-size pins).

**R6 SUCCESS:** PROOVRA stops feeling like "many enterprise tools" — and starts feeling like one coherent operational platform with four canonical workflow centers (Investigation, Governance, Reviewer, Operations). Each hub page now opens with a bounded header that answers "what operational work do I need to do now?" without inflating into a portal page or duplicating any existing tool.
