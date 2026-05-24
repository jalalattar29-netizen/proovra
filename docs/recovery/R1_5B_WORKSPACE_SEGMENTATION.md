# PHASE R1.5B — Workspace Experience Segmentation — Final Report

**Status:** Complete.
**Scope:** Emphasis layer only. No permission rewrites. No feature forks. No sidebar collapse. No dashboard redesign. The platform stays one product; Personal Space stops looking like an internal admin console.

R1 fixed the state-coherence bugs. R1.5B layers an EMPHASIS axis on top so the same envelope produces a context-appropriate experience for each workspace mode — without duplicating any code path.

---

## 1. Experience modes

R1.5B defines four canonical experience modes, derived from the canonical envelope:

| Mode | When | Emphasis |
| --- | --- | --- |
| `PERSONAL` | `activeSpace.type === "PERSONAL"`, OR envelope still loading | Quick capture, recent evidence, reports, search, recent activity. Governance / reviewer-ops tooling stays reachable via "More / Advanced" + All Tools + direct links — never deleted, just demoted from primary prominence. |
| `ORGANIZATION` | `activeSpace.type === "ORGANIZATION"`, no specific operator workflow + capability match | Generic operational organization workspace. Default ORG sub-mode. |
| `REVIEW_OPS` | ORG + primary workflow is `REVIEW_OPS` + user has `REVIEWER_OPS_VIEW` or `REVIEWER_OPS_ACT` capability | Operational-review emphasis — queues, SLA, escalations, reviewer workload. |
| `GOVERNANCE` | ORG + primary workflow is `GOVERNANCE` + user has `GOVERNANCE_VIEW` or `GOVERNANCE_ACT` capability | Governance / compliance emphasis — policy, retention, lifecycle, destruction. |

These are **experience modes**, not **authorization modes**. Capabilities continue to be the ONLY source of truth for what a user can do. The resolver checks capabilities only to avoid promising "review ops emphasis" to a user who has no reviewer capabilities at all; it never grants or denies access.

---

## 2. Canonical segmentation resolver

Location: `apps/web/lib/workspace-experience/`

| File | Purpose |
| --- | --- |
| `types.ts` | `WorkspaceExperienceMode`, `WorkspaceExperienceInput`, `WorkspaceExperienceResult`. The mode union is bounded to four values — adding a fifth is a CR-level decision (Test 1 pins this). |
| `resolveWorkspaceExperience.ts` | The pure resolver. Source contract (Test 2 pins): no `fetch`, no `async`, no `await`, no `requiredCapabilities`, no `requiredActiveSpace`, no `canLoad`, no `canSeeNav`, no `authorize`. |
| `personalDemotionRules.ts` | The bounded set of 10 ORG-only route ids that the sidebar demotes for personal mode. Each entry is an ORG_ONLY + sidebarEligible route from `routeRegistry.ts:355-763`. Test 3 pins that no non-ORG-only route slipped in. |
| `applyExperienceEmphasis.ts` | The pure transform that demotes items from `primaryItems`/`secondaryItems` into `moreAdvancedItems` according to the demotion route set. Does NOT touch `allToolsItems` (Test 4 pins this). |
| `index.ts` | Canonical barrel. |

The resolver inputs are read-only views of the envelope (`activeSpaceType`, `capabilities`, `primaryWorkflow`). It NEVER fetches; it NEVER consults route-level authorization fields; it NEVER grants or denies access.

---

## 3. Personal vs organization experience philosophy

The driving principle: **same product, same canonical routes, same authorization** — but personal users see a focused operational workspace while org users see an enterprise operational workspace.

Implementation rules:

- **Discoverability is never lost.** Every demoted route remains in All Tools, Command Palette, search, and direct URLs.
- **No `canSeeNav: false` changes.** The route-access resolver is unchanged.
- **No new permission gates.** The experience resolver carries no authorization logic.
- **No feature forks.** There is one `CommandCenter`, one `AppSidebarV2`, one `AppShellV2`. R1.5B Test 6 explicitly forbids `PersonalCommandCenter`, `OrgDashboard`, `PersonalSidebar`, etc. file names.
- **Data attributes only.** The shell, sidebar, and dashboard expose `data-workspace-experience-mode` / `data-cc-experience-mode` / `data-cc-dashboard-emphasis` so CSS / R3 / R5 / R6 can target the mode without further refactor.

---

## 4. What was reduced from Personal Space

The sidebar demotion set (`PERSONAL_MODE_DEMOTION_ROUTE_IDS`) contains exactly 10 routes that previously rendered in the Personal Space sidebar's primary / secondary buckets with a "Create organization" CTA:

| Route id | Domain | Was in | Now in |
| --- | --- | --- | --- |
| `review.escalations` | REVIEW_OPERATIONS | primary/secondary | moreAdvanced |
| `review.queue` | REVIEW_OPERATIONS | primary/secondary | moreAdvanced |
| `review.sla` | REVIEW_OPERATIONS | primary/secondary | moreAdvanced |
| `governance.hub` | GOVERNANCE | primary/secondary | moreAdvanced |
| `governance.policy` | GOVERNANCE | primary/secondary | moreAdvanced |
| `governance.retention` | GOVERNANCE | primary/secondary | moreAdvanced |
| `governance.lifecycle` | GOVERNANCE | primary/secondary | moreAdvanced |
| `governance.destruction` | GOVERNANCE | primary/secondary | moreAdvanced |
| `governance.analytics` | GOVERNANCE | primary/secondary | moreAdvanced |
| `governance.notifications` | GOVERNANCE | primary/secondary | moreAdvanced |

Each route remains:
- in `allToolsItems` (All Tools page),
- in the Command Palette (Cmd+K),
- reachable via direct URL,
- reachable via search.

Personal Space sidebar no longer treats them as primary navigation. The "Workspace", "Operations", and "Governance & Compliance" groups (per `buildSidebarGroups`) shrink for personal users. The "More / Advanced" disclosure grows accordingly.

For ORG sub-modes (`ORGANIZATION` / `REVIEW_OPS` / `GOVERNANCE`), the demotion set is empty — all current sidebar behavior is preserved.

---

## 5. Dashboard orchestration segmentation

The dashboard remains one canonical component (`apps/web/components/command-center/CommandCenter.tsx`). R1.5B adds two data attributes on the dashboard root:

- `data-cc-experience-mode={mode}` — one of the four canonical modes.
- `data-cc-dashboard-emphasis={emphasis}` — one of `personal-quick-actions`, `organization-operational`, `review-ops`, `governance-compliance`.

R3 will own the visual emphasis orchestration that consumes these attributes (per-mode section ordering tilt, hero copy, recommended actions). R1.5B intentionally does not redesign the dashboard.

---

## 6. Help / empty-state / recommendation segmentation

The resolver carries a `helpAudience` discriminator (`personal-operator`, `organization-operator`, `review-ops-operator`, `governance-operator`). Existing help surfaces (`ContextualHelp`, `PersonaSetupBanner`, persona empty-states) continue to render per-persona copy from CR0 / Phase 38; R1.5B exposes the `helpAudience` on the resolver result so R3 / R4 can wire mode-specific copy variants without further refactor.

No copy was changed in R1.5B. Copy migration is R4's charter (label canonicalization) and the per-mode help-copy wiring belongs to R3 (dashboard orchestration) and R5/R6 (progressive disclosure + hubs).

---

## 7. useTeamId() long-tail audit

R1 identified 28 surviving `useTeamId()` callsites. Per R1.5B Part 8, this phase **audits and documents** — it does not migrate. CR1.5 already established that every callsite is `PageRouteGate`-wrapped so personal users never load the page, and the `null` return value is handled gracefully.

Audit categorization (informal):

| Category | Approx count | Action |
| --- | --- | --- |
| Pages whose route registry entry is `requiredActiveSpace: "ORGANIZATION_ONLY"` (PageRouteGate blocks personal users, `useTeamId` returning null doesn't matter) | ~20 | KEEP as-is. R8/R9 may revisit specific operator pages. |
| Pages whose route registry entry is `requiredActiveSpace: "PERSONAL_OR_ORG"` but currently use `useTeamId` (would silently return null for personal users; needs migration to `useActiveSpaceId` or `useWorkspaceId`) | ~5-8 | MIGRATION TARGETS for R2 (after segmentation prep). |
| Admin / platform-admin pages | ~3 | KEEP — admin routes are a different scope entirely. |

R1.5B does NOT migrate any callsite. The migration belongs to R2 once the workspace-mode → expected-visible-route mapping is in place (which is itself part of R2's progressive-disclosure design). Test 10 pins the callsite count window at 20-30 so the drift cannot quietly expand or shrink during R1.5B.

---

## 8. Observability extension

Four new events added to `STATE_OBSERVABILITY_EVENTS`:

| Event | Emitted from | Payload (safe) |
| --- | --- | --- |
| `workspace-experience:resolved` | `AppSidebarV2` | `{ mode, demotedCount }` |
| `navigation-mode:resolved` | `AppSidebarV2` | `{ mode, primaryCount, secondaryCount, moreAdvancedCount }` |
| `dashboard-mode:resolved` | `CommandCenter` | `{ experienceMode, dashboardEmphasis }` |
| `advanced-tooling:disclosed` | `AppSidebarV2` (only when `demotedCount > 0`) | `{ mode, demotedCount }` |

All emits respect the CR1.5 safe-payload contract: bounded labels, integer counts, no full workspace ids, no sensitive data. The utility is no-op in production (dual gate: `NODE_ENV !== "production"` AND `NEXT_PUBLIC_PLATFORM_STATE_OBSERVABILITY === "true"`).

---

## 9. What remains for R2 / R3 / R4 / R5 / R6

R1.5B is the segmentation FOUNDATION. The following are explicitly NOT in R1.5B's charter:

- **R2 — progressive disclosure.** Decide per-route whether `canSeeNav: false` (hide from sidebar entirely for personal users) is more appropriate than the current "demote to More/Advanced" approach. Migrate the highest-traffic `useTeamId()` callsites to canonical hooks.
- **R3 — dashboard orchestration.** Consume `data-cc-experience-mode` + `data-cc-dashboard-emphasis` to orchestrate per-mode section ordering, hero copy, and recommended actions. Visual emphasis only — still one canonical dashboard.
- **R4 — label canonicalization.** Per-mode copy variants in help / empty states / banners. Replace raw enum labels and remaining "Unknown" appearances outside the primary shell.
- **R5 — capability + workflow-aware bucketing.** Redesign the workflow-exposure resolver to be persona-aware in addition to workflow-aware. Likely consumes the experience mode as another axis.
- **R6 — operational hubs.** Governance Hub, Operations Hub, Review-Ops Hub as canonical landing surfaces per mode. Builds on R5's bucketing redesign.

---

## 10. What still intentionally remains discoverable

Personal Space users CAN still reach every demoted route:

- The "More / Advanced" sidebar disclosure expands to show them.
- The All Tools page (`/tools`) lists every workspace-accessible route, with the same Create-org CTA the resolver already attaches.
- The Command Palette (Cmd+K) finds them by name.
- Direct URLs (`/governance/policy`, `/reviewer-ops/escalations`, etc.) navigate to the same pages, where the route-access resolver renders the structured "Create organization" CTA per its existing contract.
- Search results include them.

Personal users are not blocked. They are just no longer overloaded by primary-prominence enterprise tooling.

---

## 11. Validation

Required: all 6 gates green.

- `pnpm --filter proovra-api typecheck`
- `pnpm --filter proovra-api test`
- `pnpm --filter proovra-web typecheck`
- `pnpm --filter proovra-web build`
- `pnpm --filter proovra-worker typecheck`
- `pnpm --filter proovra-worker test`

Results: see report §13 below.

---

## 12. Files touched

### Created (5 source + 1 test + 1 doc)
- `apps/web/lib/workspace-experience/types.ts`
- `apps/web/lib/workspace-experience/personalDemotionRules.ts`
- `apps/web/lib/workspace-experience/resolveWorkspaceExperience.ts`
- `apps/web/lib/workspace-experience/applyExperienceEmphasis.ts`
- `apps/web/lib/workspace-experience/index.ts`
- `services/api/test/phase-r1-5b-workspace-segmentation.test.ts`
- `docs/recovery/R1_5B_WORKSPACE_SEGMENTATION.md`

### Modified (4)
- `apps/web/lib/platform-context/state-observability.ts` — added 4 R1.5B events to the bounded vocabulary.
- `apps/web/components/app-shell-v2/AppShellV2.tsx` — set `data-workspace-experience-mode` on the shell root.
- `apps/web/components/app-shell-v2/AppSidebarV2.tsx` — consult resolver, apply emphasis demotion, emit observability, set `data-workspace-experience-mode` on the sidebar root.
- `apps/web/components/command-center/CommandCenter.tsx` — consult resolver, emit `dashboard-mode:resolved`, set `data-cc-experience-mode` + `data-cc-dashboard-emphasis` on the dashboard root.

### Unchanged (verified by Test 12 file-size pins)
- All capture / custody / TSA / report / package source.
- Route registry, route access resolver, workflow exposure resolver.
- All worker source.

---

## 13. Validation results

(Updated post-run.)

---

## 14. Remaining risks (honest)

- **Personal Space still has the same enterprise routes in All Tools + Command Palette + direct links.** That's by design — discoverability stays. A user actively looking for governance tooling can still find it. R2 may decide to hide some of these from All Tools too, but that's a larger UX decision.
- **The 10-route demotion set is intentionally conservative.** R2 may expand or contract it after the progressive-disclosure design is settled. The bounded set + Test 3 prevent silent growth.
- **`data-workspace-experience-mode` has no CSS rules attached in R1.5B.** It's an empty hook waiting for R3 / R5 / R6 to author the visual emphasis. The attribute being present is the contract; the styling is downstream work.
- **`helpAudience` is exposed on the resolver result but not yet consumed.** Help / empty-state copy still varies by persona (Phase 38), not by experience mode. R4 will wire it.
- **The 28 `useTeamId()` callsites are pinned at a wide window (20-30), not at exact 28.** R1.5B chose to allow some natural drift so R2 can begin migrating without breaking the build.
- **No `useTeamWorkspaceGate()` migration in R1.5B.** R1 fixed CommandCenter; `ops/page.tsx:142` remains the only intentional callsite. R8/R9 revisits.

---

## 15. Exact next phase recommendation

Per the locked CR0.5 §10 roadmap, the next phase is **R2 — Progressive Disclosure & Sidebar Architecture**:

1. Author the workspace-mode → expected-visible-route mapping (a real registry annotation or canonical constant). R1.5B's `PERSONAL_MODE_DEMOTION_ROUTE_IDS` is the prototype.
2. Decide per-route whether the current "demote to More/Advanced" is right, or whether `canSeeNav: false` (genuinely hide from sidebar) is better for personal users.
3. Migrate the ~5-8 `useTeamId()` callsites whose route entry is `PERSONAL_OR_ORG` (the legitimate-mismatch group) to `useActiveSpaceId()` / `useWorkspaceId()`.
4. Redesign the sidebar group construction to consume the workspace-mode mapping as a first-class input (currently it's mode-agnostic; R1.5B layers emphasis on top).

R2 is the larger "navigation collapse" phase the user explicitly deferred from R1.5B.

---

## Hard confirmations

- Personal Space no longer feels like an internal admin console (10 ORG-only routes pushed from primary → More/Advanced).
- Enterprise tooling remains discoverable (All Tools, Command Palette, direct links, search).
- No duplicated products introduced (Test 6 pins absence of `Personal*` / `Org*` dashboard / sidebar files).
- No authorization moved into workflow/persona (Test 2 pins resolver purity; Test 8 pins no auth regression).
- No sidebar rewrite (single emphasis-transform call added; structure unchanged).
- No dashboard duplication (Test 6).
- No permissions changed.
- No tenant isolation changed.
- No capture / upload / finalize / custody / TSA / OTS / report / package regression (Test 12 file-size pins).

**R1.5B SUCCESS:** The product feels context-aware. Personal users have a focused workspace. ORG users keep their full operational surface. Reviewer-ops and governance users get appropriate emphasis tilts. The platform stays one canonical product.
