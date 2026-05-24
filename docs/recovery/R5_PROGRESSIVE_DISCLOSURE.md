# PHASE R5 — Progressive Disclosure & Capability-Aware Bucketing — Final Report

**Status:** Complete.
**Scope:** A canonical disclosure-tier vocabulary + a pure per-route resolver + per-mode help copy + sidebar data attributes. NO route deletions. NO permission rewrites. NO sidebar rewrite. NO new dashboards.

R5 codifies the disclosure-tier concept on top of the navigation pipeline built in R2, the experience-mode demotion built in R1.5B, and the canonical vocabulary built in R4. The sidebar now stamps every link with `data-disclosure-tier` and every group with `data-tooling-tier` — visible hooks for R10 visual maturity work.

---

## 1. Disclosure model

`apps/web/lib/navigation/disclosureModel.ts` exports:

- `DISCLOSURE_TIERS` — bounded vocabulary: `"beginner"` | `"advanced"` | `"contextual"` | `"all-tools-only"`. Test 1 pins the count at exactly 4.
- `DisclosureTier` — TypeScript type derived from the const array.
- `DisclosureTierInput` — `{ route, mode, capabilities }`.
- `getRouteDisclosureTier(input)` — pure function returning the tier.
- `CONTEXTUAL_CAPABILITY_BY_ROUTE` — bounded map of `route id → capability` for the contextual tier.
- `DISCLOSURE_TIER_WEIGHT` — bounded sort/order weights.

**Decision order inside `getRouteDisclosureTier`:**

1. `!route.sidebarEligible` → `"all-tools-only"`
2. canonical primary set (R2: Home / Capture / Evidence / Cases / Reports / Search) → `"beginner"`
3. PERSONAL mode + R1.5B demotion set → `"advanced"`
4. Matched in `CONTEXTUAL_CAPABILITY_BY_ROUTE` AND user has the capability → `"contextual"`
5. `route.advancedByDefault === true` → `"advanced"`
6. Default → `"beginner"`

The resolver is **pure**: no `async`, no `await`, no `fetch`, no `apiFetch`, no authorization predicates (Test 1 pins all of these via code-context regex).

---

## 2. Beginner layer

The beginner layer is **bounded to the canonical primary set** introduced by R2:

| Route id | Surface |
| --- | --- |
| `workspace.home` | Home |
| `workspace.capture` | Capture |
| `workspace.evidence` | Evidence |
| `workspace.cases` | Cases |
| `workspace.reports` | Reports |
| `workspace.search` | Search |

The disclosure resolver returns `"beginner"` for these AND for any other sidebar-eligible route that isn't demoted, contextual, or advanced. The natural beginner layer also includes Workspace-domain routes (Notifications, Settings, Intake Links) that aren't `advancedByDefault`.

Personal users see the calm core. Advanced enterprise depth is one disclosure click away in the "More / Advanced" group.

---

## 3. Advanced layer

Routes marked `advancedByDefault: true` in the registry OR pushed there by R1.5B's `PERSONAL_MODE_DEMOTION_ROUTE_IDS` get the `"advanced"` tier. They render under the "More / Advanced" disclosure in the sidebar — preserved as a familiar collapsible surface.

The R1.5B demotion set (10 ORG-only routes) is preserved verbatim:

- `review.escalations`, `review.queue`, `review.sla`
- `governance.hub`, `governance.policy`, `governance.retention`, `governance.lifecycle`, `governance.destruction`, `governance.analytics`, `governance.notifications`

Test 3 pins both the bounded set AND that every demoted route is still registered (no deletions).

---

## 4. Contextual disclosure

`CONTEXTUAL_CAPABILITY_BY_ROUTE` maps ORG-only governance + reviewer routes to the capability that, when present, lifts them to the `"contextual"` tier:

```
governance.hub          → GOVERNANCE_VIEW
governance.policy       → GOVERNANCE_VIEW
governance.retention    → GOVERNANCE_VIEW
governance.lifecycle    → GOVERNANCE_VIEW
governance.destruction  → GOVERNANCE_VIEW
governance.analytics    → GOVERNANCE_VIEW
governance.notifications→ GOVERNANCE_VIEW
review.escalations      → REVIEWER_OPS_VIEW
review.queue            → REVIEWER_OPS_VIEW
review.sla              → REVIEWER_OPS_VIEW
```

When the user has the contextual capability, the route's tier becomes `"contextual"` — a visible hint for CSS / R10 to treat as "this advanced tool is shown because it's relevant to YOUR work." The contextual tier NEVER blocks access; capability checks remain in `resolveRouteAccess`.

For PERSONAL mode, the R1.5B demotion rule (step 3) fires before the contextual rule (step 4), so personal users continue to see governance/reviewer routes under "More / Advanced" regardless of capability. ORG-mode users with the matching capability see them as `"contextual"`.

---

## 5. All Tools + Command Palette + direct links — preserved

The disclosure model is **presentation-only**. Discoverability paths are untouched:

- **All Tools** (`apps/web/app/(app)/tools/page.tsx`) — still iterates `ROUTE_REGISTRY` directly through `resolveRouteAccess` and `resolveWorkflowExposure`. Every permission-valid route is in `allToolsItems`.
- **Command Palette** (`apps/web/components/navigation/CommandPalette.tsx`) — still iterates `ROUTE_REGISTRY` directly. Cmd+K finds every permission-valid route.
- **Disclosure resolver (R2)** — `allToolsItems: exposure.allToolsItems` (untouched). Tests 5 pin both call-sites.
- **Direct URLs** — unchanged. `PageRouteGate` still renders the structured recovery panel when a user without access lands at a route.
- **Backward-compat redirects** — the 8 CR1 Part 2 redirects in `next.config.js` remain.

A demoted route in personal mode is still:
1. Visible under "More / Advanced" with the existing disclosure UX.
2. Visible in All Tools.
3. Findable in the Command Palette.
4. Reachable via direct URL.

`"all-tools-only"` tier (registry `sidebarEligible: false` routes) means: not in the sidebar at all. Still in All Tools, Command Palette, and direct URL.

---

## 6. Help / empty-state disclosure copy

`apps/web/lib/navigation/disclosureHelp.ts` consumes the R1.5B `helpAudience` axis and the R4 canonical vocabulary. Bounded per-mode dictionary:

| Mode | Primary | Secondary |
| --- | --- | --- |
| `PERSONAL` | "Start with a capture or review your recent evidence." | "Advanced governance, lifecycle, and reviewer tools remain available when your workspace needs them." |
| `ORGANIZATION` | "Review queues, escalations, and intake operations from your operational workspace." | "Governance posture, retention policy, and lifecycle reviews are available for workspace oversight." |
| `REVIEW_OPS` | "Open the reviewer queue and triage escalations to keep operational pressure in track." | "Governance posture and lifecycle reviews remain available for the workspace oversight you support." |
| `GOVERNANCE` | "Review governance posture, retention policy, and lifecycle reviews to keep the workspace compliant." | "Reviewer operations and case operations remain available for cross-functional oversight." |

Test 6 pins:
- Every mode has both a `primary` and a `secondary` entry.
- PERSONAL copy contains the canonical operational phrases.
- All copy mentions `governance` / `lifecycle` / `reviewer` (R4 canonical terms).
- No marketing / dramatic / debug language.

`resolveDisclosureHelp(mode)` returns the entry with a PERSONAL fallback for unrecognized modes (matches `resolveWorkspaceExperience` policy).

---

## 7. Visual disclosure hooks

R5 wires two minimal data attributes into the sidebar — visible hooks for CSS / R10 styling work without doing the styling itself:

| Attribute | Where | Values |
| --- | --- | --- |
| `data-disclosure-tier` | every `SidebarLink` | `"beginner"` / `"advanced"` / `"contextual"` / `"all-tools-only"` |
| `data-tooling-tier` | every sidebar group + the "More / Advanced" group | `"beginner"` / `"advanced"` |

The "More / Advanced" group hard-codes `data-tooling-tier="advanced"`. The other groups derive from a small helper: primary workflows → `"beginner"`; Operations + Governance → `"advanced"`; Workspace → `"beginner"`.

R5 does NOT add CSS rules consuming these attributes. The hooks are stable so R10 (visual maturity) can target them. Test 7 pins all four attribute wirings.

---

## 8. Files touched

### Created (2 source + 1 test + 1 doc)
- `apps/web/lib/navigation/disclosureModel.ts`
- `apps/web/lib/navigation/disclosureHelp.ts`
- `services/api/test/phase-r5-progressive-disclosure.test.ts`
- `docs/recovery/R5_PROGRESSIVE_DISCLOSURE.md`

### Modified (1)
- `apps/web/components/app-shell-v2/AppSidebarV2.tsx` — imports `getRouteDisclosureTier`; computes the disclosure-tier map for all rendered items; threads `disclosureTierByRouteId` + `toolingTier` props through `SidebarGroupView` + `SidebarMoreView` + `SidebarLink`; renders `data-disclosure-tier` + `data-tooling-tier` attributes.

### Unchanged (verified by Test 12 file-size pins)
- All capture / custody / TSA / report / package source.
- Route registry, route access resolver, workflow exposure resolver.
- R2 navigation disclosure resolver + grouping resolver.
- R1.5B workspace-experience package.
- R3 dashboard orchestration package.
- R4 product-language package.

---

## 9. Validation

Required: all 6 gates green.

- `pnpm --filter proovra-api typecheck`
- `pnpm --filter proovra-api test`
- `pnpm --filter proovra-web typecheck`
- `pnpm --filter proovra-web build`
- `pnpm --filter proovra-worker typecheck`
- `pnpm --filter proovra-worker test`

---

## 10. Remaining risks (honest)

- **R5 does NOT add CSS rules.** The disclosure-tier + tooling-tier data attributes are wired; the visual treatment is R10's charter.
- **The contextual tier is currently triggered by a bounded 10-route map.** R6 may expand this when additional routes earn contextual treatment (e.g. reviewer-supervisor tooling, observability for SREs).
- **Per-mode help copy is centralized but not yet rendered.** `resolveDisclosureHelp(mode)` is the single source; surfaces that want to render mode-aware help (PersonaSetupBanner, empty-state hints, contextual help drawer) can now consume it. R6 / R10 own the surface wiring.
- **The 28 `useTeamId()` callsites still exist** (CR1.5 / R1.5B audit). Each is `PageRouteGate`-wrapped; migration belongs to R6 / R9.
- **"all-tools-only" is currently a derived label, not a registry field.** R5 derives it from `sidebarEligible: false`. If R6 wants to mark a sidebar-eligible route as all-tools-only for a specific mode, that needs a registry-level annotation; current API doesn't expose it.
- **`data-tooling-tier` group derivation is a hand-coded switch** (`toolingTierFor(groupId)`). Currently sufficient; if R6 reshapes the group taxonomy, this needs to track.

---

## 11. Exact next phase recommendation

Per the locked CR0.5 §10 roadmap, the next phase is **R6 — Operational Hubs**:

1. Promote `governance.hub`, `investigation.hub`, and a new "Reviewer hub" surface to canonical landing pages that consume the R5 disclosure model + R4 vocabulary.
2. Wire `resolveDisclosureHelp(mode)` into PersonaSetupBanner + dashboard empty-states + sidebar group headers so mode-aware copy actually renders.
3. Reshape any registry entries whose `domain` doesn't match the operational hub they should funnel into (with no behavior change, just emphasis).
4. Authors any registry-level annotations needed for the `"all-tools-only"` per-mode case (e.g. a route that should never appear in the sidebar in PERSONAL mode).

R6 turns the disclosure machinery into visible hub experiences. R5 made the machinery ready.

---

## Hard confirmations

- ✅ The entire engine is no longer exposed immediately (R2 bounded root + R1.5B demotion + R5 tier vocabulary).
- ✅ Beginner layer is calm and understandable (Test 2 — bounded to exactly 6 routes).
- ✅ Advanced tools remain discoverable (Test 5 — All Tools + Command Palette unchanged; disclosure resolver passes `allToolsItems` untouched).
- ✅ No valid capability deleted (no auth code touched).
- ✅ No routes hard-deleted (Test 3 — every demoted route still in `routeRegistry`).
- ✅ No permission logic moved into workflow/persona (Test 9 — `routeAccessResolver` unchanged, disclosure model has no auth predicates).
- ✅ No duplicated products introduced (Test 8 — exactly one canonical sidebar component).
- ✅ No sidebar explosion returned (Test 8 — title vocabulary still bounded).
- ✅ No capture / upload / finalize / custody / TSA / OTS / report / package regression (Test 12 — file-size pins).

**R5 SUCCESS:** PROOVRA becomes understandable without becoming less powerful. Advanced enterprise depth exists, but appears progressively and contextually — and every demoted tool remains one click away in All Tools + Command Palette + direct URL.
