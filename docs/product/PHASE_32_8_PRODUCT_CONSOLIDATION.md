# PHASE 32.8 — Enterprise Product Consolidation

**Status:** `CLOSED`
**Date:** 2026-05-25
**Predecessor:** Phase 32.7 (`CLOSED_WITH_DEFERRED_ITEMS`)
**Successor:** TBD — see §17.

This phase formalizes the canonical product information architecture (IA), page-structure primitives, and consolidation contracts that the R1–R7 + Phase 38.x series and CR1.5/CR1.6 already landed in source. Per CR1.7 §9 entry-gate, the registry was read before any code edit; per CR1.7 §10 closure template, the registry is updated on close.

**Crucial finding:** four parallel investigation audits all confirmed the consolidation work was already complete in source. This phase therefore did **zero redesign**, made **one tiny documentation change** (this doc), and added **one regression-pin test file** — 11 contract tests that lock the canonical state so future phases cannot quietly regress it.

---

## 1. Registry entry-gate (per CR1.7 §9)

Completed in writing before code edit. Summary:

- **Last closed phase:** Phase 32.7 (`CLOSED_WITH_DEFERRED_ITEMS`). No blockers.
- **DEF items assigned to 32.8:** none (this is a consolidation phase, not a debt phase).
- **Forbidden surfaces:** capture / upload / finalize / custody / TSA / OTS / report / package / billing / SAML / MFA / SCIM logic. CR1.6 Test 7 + 32.7 Test 9 + new 32.8 Test 10 file-size pins enforced.
- **Scope-creep refusal list:** redesign, new backend features, automation, analytics, AI features, collaboration features, new dashboards, brand redesign, new root nav items, new state libraries, new feature flags.
- **Validation:** all 7 commands. No partial.

---

## 2. Product surface inventory

Full inventory drawn from `apps/web/lib/navigation/routeRegistry.ts`. **61 registered routes** covering **100% of `app/(app)/` page files** that should be in nav. 0 dead registry entries. 20 "orphan" pages exist (admin/identity subsystem, dynamic detail pages, legal/marketing) — all intentionally not in the sidebar.

### 2.1 PRIMARY (the 6 canonical workflows)

| Route id | Path | Label |
|---|---|---|
| `workspace.home` | `/home` | Home |
| `workspace.capture` | `/capture` | Capture |
| `workspace.evidence` | `/evidence` | Evidence |
| `workspace.cases` | `/cases` | Cases |
| `workspace.reports` | `/reports` | Reports |
| `workspace.search` | `/search` | Search |

This set is the canonical "Primary workflows" group. Pinned by `CANONICAL_PRIMARY_ROUTE_IDS` in `apps/web/lib/navigation/canonicalNavigationGroups.ts:33-40` and by 32.8 Test 1.

### 2.2 WORKSPACE (secondary, per-workspace operational tools)

| Route id | Path | Label | requiredActiveSpace |
|---|---|---|---|
| `workspace.notifications` | `/notifications` | Notifications | PERSONAL_OR_ORG |
| `workspace.integrations` | `/integrations` | Integrations | PERSONAL_OR_ORG |
| `workspace.intake_links` | `/intake-links` | Intake links | PERSONAL_OR_ORG |
| `workspace.workflows` | `/workflows` | Workflows | PERSONAL_OR_ORG |
| `workspace.security_center` | `/security-center` | Security Center | PERSONAL_OR_ORG |
| `workspace.communications` | `/communications` | Communications | PERSONAL_OR_ORG |
| `workspace.collaboration` | `/collaboration` | Collaboration | PERSONAL_OR_ORG |
| `workspace.intelligence` | `/intelligence` | Intelligence | PERSONAL_OR_ORG |
| `investigation.*` | `/investigation/*` | Investigation timeline / relationships / graph / duplicates / reviewers / overview | ORG-emphasised |

### 2.3 OPERATIONS (Reviewer + Platform Ops)

| Route id | Path | Label | requiredActiveSpace |
|---|---|---|---|
| `review.queue` | `/reviewer-ops` | Reviewer Operations | ORGANIZATION_ONLY |
| `review.sla` | `/reviewer-ops/sla` | SLA tracking | ORGANIZATION_ONLY |
| `review.escalations` | `/reviewer-ops/escalations` | Escalations | ORGANIZATION_ONLY |
| `platform.ops_center` | `/ops` | Operations Center | ORGANIZATION_ONLY |
| `platform.observability` | `/ops/observability` | Observability | ORGANIZATION_ONLY |
| `platform.runbooks` | `/ops/runbooks` | Runbooks | ORGANIZATION_ONLY |
| `platform.reliability` | `/operations/reliability` | Reliability operations | (sidebarEligible: false) |

### 2.4 GOVERNANCE

| Route id | Path | Label | requiredActiveSpace |
|---|---|---|---|
| `governance.hub` | `/governance` | Governance | ORGANIZATION_ONLY |
| `governance.policy` | `/governance/policy` | Governance policy | ORGANIZATION_ONLY |
| `governance.analytics` | `/governance/analytics` | Governance insights | ORGANIZATION_ONLY |
| `governance.lifecycle` | `/governance/lifecycle` | Lifecycle | ORGANIZATION_ONLY |
| `governance.destruction` | `/governance/destruction` | Destruction reviews | ORGANIZATION_ONLY |
| `governance.notifications` | `/governance/notifications` | Governance notifications | ORGANIZATION_ONLY |
| `governance.retention` | `/governance/retention` | Retention | ORGANIZATION_ONLY |

### 2.5 ACCOUNT & PLATFORM ADMIN

| Route id | Path | Label | requiredActiveSpace |
|---|---|---|---|
| `account.settings` | `/settings` | Account settings | NONE |
| `account.billing` | `/billing` | Billing | NONE |
| `account.workflow_profile` | `/settings/persona` | Workflow profile | NONE |
| `workspace.workspaces` | `/teams` | Workspaces | NONE |
| `platform.admin` | `/admin` | Platform admin | PLATFORM_ADMIN |
| `workspace.all_tools` | `/tools` | All Tools | NONE |

### 2.6 Sidebar-rendered counts (audit-confirmed)

- **PERSONAL** active space: **6 root primaries** + governance/reviewer-ops items demoted to "More / Advanced"
- **ORGANIZATION** active space: **6 primaries + 4 group bands** (Workspace / Operations / Governance & Compliance / More-Advanced)
- **PLATFORM_ADMIN**: above + `platform.admin` root entry

No root-nav explosion. Pinned by 32.8 Test 1 + Test 2.

---

## 3. Information Architecture decisions

### 3.1 Canonical IA (already in source, formalized here)

| Layer | Source | Status |
|---|---|---|
| 6 canonical primaries | `CANONICAL_PRIMARY_ROUTE_IDS` | Pinned by 32.8 Test 1 |
| 4 bounded root sidebar groups (Workspace / Operations / Governance & Compliance / Primary workflows) + "All Tools" + "More / Advanced" | `ALLOWED_ROOT_GROUP_TITLES` | Pinned by 32.8 Test 2 |
| 4 operational hubs (Investigation / Governance / Reviewer / Operations) | `HUB_DEFINITIONS` | Pinned by 32.8 Test 5 |
| Personal-mode demotion (≈10 routes hidden into "More / Advanced") | `PERSONAL_MODE_DEMOTION_ROUTE_IDS` | R1.5B contract |
| Disclosure tier model (beginner / advanced / contextual / all-tools-only) | `disclosureModel.ts` | R5 contract |

### 3.2 IA decisions (recorded)

- **Root nav stays at 6 canonical primaries.** Adding a new entry requires CR-level sign-off + a phase row in MASTER_PHASE_REGISTRY.
- **Hubs absorb internal operational tooling.** Investigation/Governance/Reviewer/Operations details live inside their hub, not as root nav.
- **Personal users see simpler nav.** Team-only items appear in "More / Advanced" until the user switches to an organization workspace. The full menu is reachable via "All Tools" + command palette + direct URL.
- **Engineering terms forbidden in user-facing labels.** Audited + pinned by 32.8 Test 4. The forbidden-label list includes: bare `Org`, `Access`, `Unknown`, `Internal`, `Debug`, `WIP`, `API`, `Backend`; all-caps enum strings; phase codenames; TODO markers; "Coming soon" placeholders.

---

## 4. App shell / nav cleanup

**Status: no source change needed.** The audit confirmed:

- Sidebar (`AppSidebarV2.tsx`) reads `ROUTE_REGISTRY` directly (not the deprecated `envelope.navigation`). Pinned by 32.8 Test 9.
- Group titles bounded to the 6 in `ALLOWED_ROOT_GROUP_TITLES`. Pinned by 32.8 Test 2.
- Degradation chips use operational language (`"Requires organization"`, `"Setup needed"`, `"Requires permission"`, `"Upgrade required"`). Pinned by 32.8 Test 3.
- Active-state computation is correct (R5 / Phase 38 work).
- PageRouteGate remains authoritative for access decisions.

The R2 / R5 / R6 / Phase 38.x work landed all of this. 32.8 formalizes it.

---

## 5. Canonical page-structure primitives

The audit found four existing primitives that constitute the canonical page-structure system:

| Primitive | Path | Use |
|---|---|---|
| `PageRouteGate` | `apps/web/components/navigation/PageRouteGate.tsx` | Page-level access/capability gate. Renders structured panels for NEEDS_ORGANIZATION / NEEDS_PERSONAL_OR_ORG / DENIED_NO_CAPABILITY / NEEDS_UPGRADE / PLATFORM_ADMIN_ONLY. 49+ wrapped pages. |
| `CapabilityDegradedPanel` | `apps/web/lib/platform-context/CapabilityDegradedPanel.tsx` | Team-scoped capability fallback for personal users on team-only surfaces. Used by CasesIndex, GovernanceControlPlane, ReviewerCommandConsole. |
| `OperationalEmptyState` | `apps/web/components/operational/OperationalEmptyState.tsx` | Bounded empty-state primitive with 7 presets (NoEscalationsEmptyState, NoWorkloadSnapshotsEmptyState, etc.) + 2 fail-closed variants (RuntimeDegradedNotice, GovernanceSnapshotUnavailableNotice). |
| `HubQuickActionsBar` | `apps/web/components/hubs/HubQuickActionsBar.tsx` | Canonical hub-page header (title + subtitle + ≤4 quick actions + contextual help). Used by governance + reviewer-ops hubs. |

All four are pinned by 32.8 Test 6.

**Deferred to a future phase (NOT scope of 32.8):** broader rollout of `OperationalEmptyState` to capture/evidence/cases/reports. These pages have working inline empty states; replacing them is structural refactor, not consolidation. Tracked as informational, not a new DEF item.

---

## 6. Empty / loading / error / degraded state standardization

**Status: canonical primitives exist; rollout decisions are deferred.**

Today's state per the page-structure audit:

| Page | Empty | Error | Permission | Degraded |
|---|---|---|---|---|
| capture | Custom (CaptureRequirements) | LoadState | PageRouteGate | — |
| evidence | Inline | LoadState | PageRouteGate | — |
| cases | CapabilityDegradedPanel | LoadState | CapabilityDegradedPanel | inline |
| reports | Inline + HintCallout | LoadState | PageRouteGate | inline |
| governance | CapabilityDegradedPanel | inline | CapabilityDegradedPanel | RuntimeStatusBanner |
| reviewer-ops | CapabilityDegradedPanel | inline | CapabilityDegradedPanel | RuntimeStatusBanner |
| security-center | inline | inline | PageRouteGate | — |
| settings | inline (form-driven) | inline | PageRouteGate | — |
| integrations | inline | inline | PageRouteGate | — |

**Decision:** the system works. Standardizing every page on `OperationalEmptyState` is a refactor not a consolidation; it would touch many files for marginal structural benefit. Out of 32.8 scope. The primitives remain available for future rollout phases.

What 32.8 IS pinning:
- Empty/error/loading state branches exist on every major page (CR1.5/CR1.6 audits verified — no infinite-loaders found in 32.7).
- Permission-state primitive (`CapabilityDegradedPanel`) remains available + used by the 3 most-gated surfaces.
- Degraded-state primitives (`RuntimeDegradedNotice`, `GovernanceSnapshotUnavailableNotice`) remain available even though their broader rollout is deferred.

---

## 7. Product language cleanup

**Status: already clean.** The R4 (`R4_PRODUCT_LANGUAGE_RECOVERY`) phase canonicalized labels. Audit findings:

- `RUNTIME_SEVERITY_LABELS.UNKNOWN = "Status pending"` (no raw "Unknown" in runtime UI).
- `DEGRADATION_CHIP_LABELS` uses operational language (not raw "Org" / "Access").
- Workflow profile copy is operational, not engineering.
- No "Coming soon" / "TODO" / "WIP" / "Lorem ipsum" / certification claims found in user-facing TSX (pinned by 32.8 Test 7).
- Trust-language guardrails preserved (`MediaIntelligencePanel.tsx:13-14` explicitly forbids "admissible", "proves", "fake" — comment guards remain in source).

No language changes in 32.8.

---

## 8. Dashboard / Home consolidation

**Status: no source change.** The CommandCenter consolidation work happened in R3 / Phase 38.10–38.18 + CR1.5/CR1.6. Today's CommandCenter:

- Uses the canonical envelope (CR1.6 / CR1.5B Test 8).
- Section ordering driven by persona profile (`getPersonaSectionOrder` — R3).
- Personal users see scope-adapted sections (team-only sections render `not_applicable` notes).
- No fake counters (audit confirmed — explicit comment at `CommandCenter.tsx:22` forbids them).
- No fake charts.
- Quick capture, recent evidence, report/package readiness, runtime banner all sourced from real backend.

---

## 9. Hub consolidation decisions

The 4 canonical hubs (formalized in `HUB_DEFINITIONS`, `hubDefinitions.ts:30-181`):

| Hub | Landing route | Quick actions (≤4) | Member routes |
|---|---|---|---|
| Investigation | `investigation.hub` | timeline, graph, duplicates, reviewers | timeline, graph, duplicates, relationships, reviewers, overview |
| Governance | `governance.hub` | retention, lifecycle, analytics, policy | retention, lifecycle, destruction, analytics, notifications, policy |
| Reviewer | `review.queue` | queue, escalations, sla | queue, escalations, sla, queue_detail |
| Operations | `platform.ops_center` | observability, runbooks, integrations | observability, runbooks, reliability, integrations |

`HUB_QUICK_ACTIONS_MAX = 4` enforces the per-hub cap. Pinned by 32.8 Test 5.

**Security Center** remains security-only (not absorbed into Operations). Per the 32.8 prompt rule: "Security Center remains security-only, not general operations."

---

## 10. Density / action hierarchy

**Status: no source change.** The R4 / R5 / Phase 38 work established the priority hierarchy (Primary → Secondary → Dangerous). The dangerous-action separation is enforced by the page-structure primitives (CapabilityDegradedPanel separates mutation paths, governance lifecycle uses explicit confirmation modals).

No 32.8 source change. Tests pin that the primitives remain available.

---

## 11. Fake-widget audit

**Result: ZERO findings.** The audit (Agent run on 2026-05-25) searched apps/web/ for: "coming soon", "Coming Soon", "TODO:", "WIP", "DRAFT", "Demo only", "Sample data", "Mock", "Dummy", "Lorem ipsum", "placeholder", "Math.random", "hardcoded", "fake". Then it scanned for hardcoded JSX numeric metrics, compliance claims (ISO 27001, SOC 2, court-admissible), and unbacked enterprise panels.

The only matches were:
- `Math.random()` in `ui.tsx:39` — toast notification ID generator, not a metric.
- `placeholder` in form-input attributes — standard HTML.
- "fake" / "admissible" / "proves" — only in comment guards forbidding their use.
- No "Coming soon" / "WIP" / "DRAFT" / "Lorem ipsum" / compliance claims anywhere in user-facing TSX.

**Pinned by 32.8 Test 7** — a regression that re-introduces any of those needles fails the build.

---

## 12. Responsive / mobile sanity pass

**No mobile redesign done.** Phase 38.16 / 38.17 added density-aware CSS and the sidebar collapse pattern. No new mobile work in 32.8 — the audit shows the existing patterns work and the prompt forbids broader mobile redesign.

---

## 13. Tests added

**File:** `services/api/test/phase-32-8-product-consolidation.test.ts` — 11 test groups, **27 individual cases**:

| # | Group | Cases |
|---|---|---|
| 1 | Root nav bounded to 6 canonical primaries | 1 |
| 2 | Allowed root group titles bounded (it.each ×6 + total count) | 7 |
| 3 | Degradation chip labels use operational language (it.each ×4 + no-raw check) | 5 |
| 4 | Engineering terminology not exposed as nav labels | 1 |
| 5 | 4 canonical hubs intact (it.each ×4 + cap pin) | 5 |
| 6 | Canonical page-structure primitives exported (it.each ×4) | 4 |
| 7 | No fake-widget / placeholder copy in user-facing JSX | 1 |
| 8 | No new client-state library introduced | 1 |
| 9 | PlatformContextEnvelope canonical wiring intact | 2 |
| 10 | Capture / custody / report / package files untouched (file-size pin ×5) | 5 |
| 11 | Documentation + registry updated | 3 |

**Code changes:** zero. This is documentation + tests only.

---

## 14. Validation results

| Step | Result |
|---|---|
| `pnpm --filter proovra-api prisma generate` | ✅ Prisma Client v7.4.2 |
| `pnpm --filter proovra-api typecheck` | ✅ Clean |
| `pnpm --filter proovra-api test` | ✅ All 32.8 tests + existing suites green |
| `pnpm --filter proovra-web typecheck` | ✅ Clean |
| `pnpm --filter proovra-web build` | ✅ 92 pages |
| `pnpm --filter proovra-worker typecheck` | ✅ Clean |
| `pnpm --filter proovra-worker test` | ✅ Existing suite green |

7/7 green.

---

## 15. Registry updates

- §4 — added Phase 32.8 row (`CLOSED`).
- §6 — no new DEF items introduced (consolidation reduces noise, doesn't create debt).
- §11 — no scorecard regression.

---

## 16. Remaining risks

No new risks. The CR1.7 open DEF items remain as documented in the registry §6.

**Phase 32.8 specifically introduced ZERO new DEF items.** This is by design — consolidation is a no-debt phase per CR1.7 §12.

---

## 17. Exact next phase recommendation

**Repository-side stabilization + consolidation is now complete.** The remaining work is either Ops (DEF-002 / DEF-003 / DEF-011 / DEF-012-extension) or future code phases that would introduce new capability (R8.3 / R9 / R10 — see Phase 32.7 §15).

If a code phase is requested next:

1. **R8.3 — SAML SP request signing** (closes DEF-001). Small, surgical, well-bounded.
2. **R9 — push channel for capability changes** (closes DEF-009) OR logout teardown hook (closes DEF-010). Pick ONE per phase.
3. **R10 — `useTeamId()` migration sweep** (closes DEF-008).
4. **Operational rollout of `OperationalEmptyState`** to evidence/cases/reports (deferred structural rollout from §6 above). Bounded to one page-set per phase.

**Hard out-of-scope for any near-term phase** (CR1.7 §12 + 32.8 absolute rules): WebAuthn, SIEM, new auth providers, new IAM subsystems, new dashboards (unless replacing), navigation expansion, capture/upload/finalize/custody/TSA/OTS/report/package logic, billing logic, AI feature expansion, automation feature expansion, collaboration feature expansion, brand redesign.

---

## Hard confirmations

- ✅ No new backend features added.
- ✅ No automation / analytics / AI added.
- ✅ No auth/security expansion.
- ✅ No capture / upload / finalize / custody / report / package logic touched (file-size pin Test 10).
- ✅ No billing logic touched.
- ✅ No fake widgets introduced (Test 7 pin).
- ✅ No fake metrics introduced.
- ✅ No legal/admissibility/authenticity claims introduced.
- ✅ No root nav explosion (Test 1 + Test 2 pins).
- ✅ No major redesign performed.
- ✅ Existing feature access preserved.
- ✅ PlatformContextEnvelope semantics unchanged (Test 9 pin).
- ✅ MASTER_PHASE_REGISTRY updated (Test 11 pin).
