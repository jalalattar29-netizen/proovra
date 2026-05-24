# PHASE R3 — Dashboard Orchestration & Workspace Focus — Final Report

**Status:** Complete.
**Scope:** Orchestration layer on top of the existing single CommandCenter dashboard. NO duplicate dashboards. NO permission forks. NO new features beyond contextual shortcuts to existing routes. NO visual redesign of the dashboard itself.

R3 transforms the dashboard from a generic enterprise widget surface into a contextual operational workspace. Same component, same backend envelope, same canonical pipeline — but the orchestration layer reorders sections, surfaces mode-aware quick actions, and shows contextual onboarding hints.

---

## 1. Orchestration philosophy

There is **one canonical dashboard** (`apps/web/components/command-center/CommandCenter.tsx`). The orchestration layer is a thin set of pure functions that decide:

- which sections lead and which are de-emphasized for the current mode,
- which bounded shortcuts surface as quick actions,
- which contextual onboarding hint shows while setup is incomplete.

Authorization stays in `resolveRouteAccess`. Capability checks stay in `ctx.can(...)`. Workflow exposure stays in `resolveWorkflowExposure`. R1.5B's experience mode stays in `resolveWorkspaceExperience`. R3 layers emphasis on top — never below.

---

## 2. Dashboard mode system

| Mode | Section priority leaders | Quick actions | Onboarding hint |
| --- | --- | --- | --- |
| `PERSONAL` | summary, recentEvidence, caseOperations, pipelineDetail, timeline | Capture evidence → `/capture`; Review evidence → `/evidence`; Continue reports → `/reports` | "Create your first evidence record" → `/capture` |
| `ORGANIZATION` | operationalPressure, caseOperations, reviewerOrchestration, pipelineDetail, governancePosture | Open reviewer queue → `/reviewer-ops`; Review escalations → `/reviewer-ops/escalations`; Manage intake links → `/intake-links`; Open collaboration → `/collaboration` | "Configure intake operations" → `/intake-links` |
| `REVIEW_OPS` | reviewerOrchestration, operationalPressure, queueCongestion, caseOperations, workloadEngine | Open reviewer queue → `/reviewer-ops`; Review escalations → `/reviewer-ops/escalations`; Check SLA → `/reviewer-ops/sla` | "Open the reviewer queue to assign your first workflow" → `/reviewer-ops` |
| `GOVERNANCE` | governancePosture, auditReadiness, operationalPressure, organizationalIntelligence, caseOperations | Review governance posture → `/governance`; Review retention policy → `/governance/retention`; Lifecycle reviews → `/governance/lifecycle` | "Review your workspace's governance posture" → `/governance` |

All entries live in `apps/web/lib/dashboard/dashboardModeRules.ts` as a single bounded source of truth. R5/R6 can revise this table; R3 just establishes the canonical shape.

---

## 3. Section hierarchy + emphasis labels

`resolveDashboardSections({ mode, persona, availableSectionIds })` produces an ordered list with per-section emphasis:

- **`primary`** — pulled by mode priority. Renders at the top.
- **`secondary`** — pulled by persona priority (legacy Phase 38 helper). Renders next.
- **`de-emphasized`** — remaining available sections in canonical order. Still rendered (the orchestrator NEVER removes a section); R5/R6 may fold these into a collapsible "Advanced" group later.

The contract is pinned by tests:

- Every available section id ends up in the output (no removal).
- Mode wins over persona; persona wins over canonical order.
- The function is pure — no fetches, no async, no authorization predicates.

---

## 4. Contextual emphasis (not separate dashboards)

R3 explicitly forbids `ReviewerDashboard.tsx`, `GovernanceDashboard.tsx`, `PersonalDashboard.tsx`, etc. (Test 4 pins this.) The same `CommandCenter` component renders for every mode — only the orchestration result differs.

- Reviewer context: `MODE_SECTION_PRIORITY.REVIEW_OPS` brings `reviewerOrchestration` + `queueCongestion` + `workloadEngine` to the top.
- Governance context: `MODE_SECTION_PRIORITY.GOVERNANCE` brings `governancePosture` + `auditReadiness` + `organizationalIntelligence` to the top.
- Personal context: `MODE_SECTION_PRIORITY.PERSONAL` brings `summary` + `recentEvidence` + `caseOperations` to the top.
- Organization context (default ORG sub-mode): `operationalPressure` + `caseOperations` + `reviewerOrchestration` lead.

The data attributes already wired in R1.5B (`data-cc-experience-mode`, `data-cc-dashboard-emphasis`) remain available for future CSS / R5 / R6 styling.

---

## 5. Onboarding / empty-state recovery

`resolveDashboardOnboarding({ mode, onboardingCompleted })` returns `null` once setup is complete, or a contextual hint with `{ label, href, tone }`. The hint renders inside the dashboard hero — a single operationally-meaningful action link.

- Personal: `"Create your first evidence record" → /capture`
- Organization: `"Configure intake operations" → /intake-links`
- Review-Ops: `"Open the reviewer queue to assign your first workflow" → /reviewer-ops`
- Governance: `"Review your workspace's governance posture" → /governance`

The hint NEVER reads as "No workspace selected" or generic enterprise emptiness — those were the R1 bug markers. Test 5 pins this.

---

## 6. Quick action philosophy

The quick-actions row is a bounded operational shortcut surface:

- Max 4 actions per mode (`QUICK_ACTIONS_MAX_PER_MODE = 4`).
- Every `href` is a registered route in `lib/navigation/routeRegistry.ts` (Test 7 cross-checks this).
- No authorization decisions in the component or the resolver. If the destination isn't loadable for the user, the destination's own `PageRouteGate` renders the structured recovery panel — the shortcut still appears (hiding it would be a permission fork, which R3 forbids).
- The component (`CommandCenterQuickActions.tsx`) is a thin presentation wrapper around `next/link` with the existing `.cc-quick-action` CSS class. No new CSS introduced.

---

## 7. Dashboard / navigation coherence

R2's pipeline wired the sidebar to `resolveWorkspaceExperience`. R3 wires the dashboard to the same resolver (already present from R1.5B) and to the new orchestration layer. Test 8 pins that:

- CommandCenter consumes `resolveDashboardSections` + `resolveDashboardQuickActions` + `resolveDashboardOnboarding`.
- CommandCenter mounts `<CommandCenterQuickActions>`.
- Both the dashboard and the sidebar consume the same `resolveWorkspaceExperience` helper.

The two surfaces' experience-mode reading is therefore structurally coherent. Personal Space dashboard won't surface governance-heavy primary sections while the sidebar simultaneously shows a quiet personal nav.

---

## 8. What R3 intentionally did NOT do

| Out of scope | Owner |
| --- | --- |
| Visual redesign of the dashboard (CSS, hero, layout) | R5/R6 |
| Per-mode CSS rules consuming `data-cc-experience-mode` | R5/R6 |
| Route label canonicalization ("Governance Analytics" → "Governance Insights") | R4 |
| Fake KPIs / executive analytics widgets | NEVER |
| Multiple dashboard components / forks | NEVER |
| Permission logic inside orchestration | NEVER |
| Hard-deleting any section or route | NEVER |
| Changing capture / custody / TSA / OTS / report / package | NEVER |

---

## 9. Observability extension

Three new events added to `STATE_OBSERVABILITY_EVENTS`:

| Event | Emitted from | Payload (safe) |
| --- | --- | --- |
| `dashboard-sections:resolved` | `CommandCenterReady` | `{ mode, sectionCount }` |
| `dashboard-priority:resolved` | `CommandCenterReady` | `{ mode, primarySectionCount }` |
| `dashboard-quick-actions:resolved` | `CommandCenterReady` | `{ mode, count }` |

All payloads respect the CR1.5 safe-payload contract. The utility is no-op in production (dual gate: `NODE_ENV !== "production"` AND `NEXT_PUBLIC_PLATFORM_STATE_OBSERVABILITY === "true"`).

---

## 10. Files touched

### Created (6 source + 1 test + 1 doc)
- `apps/web/lib/dashboard/types.ts`
- `apps/web/lib/dashboard/dashboardModeRules.ts`
- `apps/web/lib/dashboard/resolveDashboardSections.ts`
- `apps/web/lib/dashboard/resolveDashboardQuickActions.ts`
- `apps/web/lib/dashboard/resolveDashboardOnboarding.ts`
- `apps/web/lib/dashboard/index.ts`
- `apps/web/components/command-center/CommandCenterQuickActions.tsx`
- `services/api/test/phase-r3-dashboard-orchestration.test.ts`
- `docs/recovery/R3_DASHBOARD_ORCHESTRATION.md`

### Modified (2)
- `apps/web/lib/platform-context/state-observability.ts` — added 3 R3 events.
- `apps/web/components/command-center/CommandCenter.tsx` — wired the orchestrator into `CommandCenterReady`; replaced the inline `getPersonaSectionOrder` call with `resolveDashboardSections`; mounted the quick-actions row and onboarding hint in the hero; emit the 3 R3 events.

### Unchanged (verified by Test 12 file-size pins)
- All capture / custody / TSA / report / package source.
- Backend `command-center.service.ts` and `dashboard.routes.ts`.
- Route registry, route access resolver, workflow exposure resolver, workspace-experience package, navigation pipeline.

---

## 11. Validation

Required: all 6 gates green.

- `pnpm --filter proovra-api typecheck`
- `pnpm --filter proovra-api test`
- `pnpm --filter proovra-web typecheck`
- `pnpm --filter proovra-web build`
- `pnpm --filter proovra-worker typecheck`
- `pnpm --filter proovra-worker test`

---

## 12. Remaining risks (honest)

- **R3 doesn't add CSS to reflect the per-section emphasis labels.** The `data-cc-experience-mode` + `data-cc-dashboard-emphasis` attributes are wired; styling is R5/R6 work.
- **Quick actions are intentionally not capability-filtered.** If a user lacks permission to enter a destination, the destination's PageRouteGate handles it. Hiding the shortcut would be a permission fork — explicitly forbidden.
- **The orchestration tables (mode priority + quick actions + hints) are conservative.** R5/R6 may expand or contract them; R3 pins their bounded shape, not their exact contents.
- **The dashboard still renders every available section.** "De-emphasized" sections appear at the end, not in a collapsible group. Folding them into a collapsible "Advanced" section is a presentation decision deferred to R5/R6.
- **No copy was changed inside the dashboard sections themselves.** Section headers, hero copy, footer copy — all unchanged. R4 owns label canonicalization.

---

## 13. Exact next phase recommendation

Per the locked CR0.5 §10 roadmap, the next phase is **R4 — Label Canonicalization**:

1. Replace raw architecture labels in route registry + section headers ("Governance Analytics" → "Governance Insights", "Destruction Internals" → "Lifecycle Reviews", etc.).
2. Sweep remaining "Unknown" appearances outside the primary shell (verify, share, admin dashboard, billing addon).
3. Per-mode help / empty-state copy variants consuming the `helpAudience` discriminator R1.5B exposed.
4. Pin the canonical label dictionary in source so future drift fails CI.

R4 is the "make the words feel professional" phase. R3 unlocked it by establishing the orchestration layer; R4 makes the language match the layered experience.

---

## Hard confirmations

- ✅ There is still ONE canonical dashboard system (Test 10 — exactly one `CommandCenter.tsx`; Test 4 — no per-mode dashboard forks).
- ✅ No dashboard forks introduced (Test 4 explicitly forbids `PersonalDashboard.tsx` / `ReviewerDashboard.tsx` / `GovernanceDashboard.tsx` / `OrgCommandCenter.tsx` / etc.).
- ✅ No permission logic in orchestration (Test 1 + Test 10 — resolvers carry no `authorize(`, no `requiredCapabilities`, no `canLoad`).
- ✅ Personal dashboard feels calmer (mode priority leads with summary + recent evidence + cases).
- ✅ Organization dashboard feels operationally focused (mode priority leads with operational pressure + reviewer orchestration).
- ✅ Governance / reviewer tooling is contextual emphasis only (Test 4).
- ✅ No sidebar explosion returned (Test 8 — sidebar still consumes the canonical resolver chain from R2).
- ✅ No discoverability collapse (orchestrator never removes sections; quick actions are shortcuts, not gates).
- ✅ No capture / upload / finalize / custody / TSA / OTS / report / package regression (Test 12 file-size pins).

**R3 SUCCESS:** The dashboard finally feels like a real operational workspace — instead of a generic enterprise widget surface. Same product, same canonical CommandCenter, same envelope — but the operator's mode shapes the experience.
