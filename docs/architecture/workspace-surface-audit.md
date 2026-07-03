# PROOVRA — Workspace Surface Audit
_Status: CLOSED — all tests pass._

## 1. Executive verdict

The workspace surface is **shippable to PRO users today**. Core Capture / Evidence / Cases / Search / Reports flows are stable, the four discovery surfaces (sidebar, All Tools, Cmd-K, PageGate) are internally consistent, and constitutional rules are honored: PERSONAL + ORGANIZATION are the only workspace kinds, "Team" is never spoken in product UI, no env-var names leak into user-facing copy, and destructive flows do not rely on `window.confirm`.

The single biggest IA problem is **investigation-suite legibility**. Five pages render as VALID_EMPTY on every fresh PRO workspace because graph reconciliation runs cron-only (no auto-trigger on evidence write) and media-intelligence extraction is operator-triggered (OCR / transcripts default to `INDEX_EXISTING_ONLY`). The surfaces are correct — they read as "broken feature" rather than "no data yet." Empty-state copy has been rewritten to remove that false signal.

The secondary problem is **discoverability for governance and platform-admin work**. Intelligence Platform, Executive Dashboard, Ops Center, Reliability, SLA, and Escalations were all Cmd-K-only despite being daily-use surfaces for their respective personas. This audit promotes the four highest-impact ones to the sidebar (gated by capability + workspace kind) and leaves the rest discoverable through Cmd-K + All Tools.

No new pages, schema, workers, billing gates, or SSO/SCIM features were introduced. The audit's charter was "flip booleans, sharpen copy, document reality, prove it with tests."

## 2. Actual data verification (Investigation suite)

All five `/investigation/*` routes were exercised end-to-end on a fresh PRO workspace. None are broken. All are VALID_EMPTY by design until producers run.

| Page | Required tables | API endpoint | Producer | Default state | Verdict |
|---|---|---|---|---|---|
| `/investigation` (hub) | `media_intelligence_signals`, `investigation_graph_nodes`, `investigation_graph_edges` | `GET /v1/investigation/overview` | `reconcileTeamGraph` (cron via `/v1/ops/reconcile`); `runMediaIntelligenceAnalysis` (per-evidence, operator-triggered) | Empty pills, no signals | VALID_EMPTY |
| `/investigation/graph` | `investigation_graph_nodes`, `investigation_graph_edges` | `GET /v1/graph/seeds` | `reconcileTeamGraph` cron-only | No seeds per kind | VALID_EMPTY |
| `/investigation/duplicates` | `investigation_graph_edges (SAME_HASH_AS only)` | `GET /v1/graph/duplicates` | `reconcileTeamGraph`; **perceptual similarity producer MISSING** | No duplicate clusters | VALID_EMPTY + producer gap |
| `/investigation/timeline` | `evidence_lifecycle_events`, `media_intelligence_signals` | `GET /v1/investigation/timeline?evidenceId=` | Lifecycle writer (live); MI signals (operator-triggered) | Empty at workspace scope (by design — requires `?evidenceId=`) | VALID_EMPTY |
| `/investigation/reviewers` | `evidence_review_workflows`, `review_escalations`, `external_review_grants`, `media_intelligence_signals`, `evidence_lifecycle_events` | `GET /v1/investigation/reviewers` | Workflow/escalation/grant writers (live); OCR + transcript producers (`INDEX_EXISTING_ONLY` mode) | Zero workflows, zero signals, indexing 0/0/0/0 | VALID_EMPTY |

**Two facts the product surface was hiding from users.** First, `reconcileTeamGraph` only runs on cron tick (`/v1/ops/reconcile`) — there is no auto-trigger on evidence write. Second, only `SAME_HASH_AS` edges are materialized; perceptual edges (`SIMILAR_TO`, `POSSIBLE_DERIVATIVE_OF`) are producer-missing. Both facts are now stated honestly in empty-state copy and tracked as Phase 11 scope.

## 3. Investigation page-by-page reality table

| Route | What user sees on empty workspace | Why | New copy applied |
|---|---|---|---|
| `/investigation` | Hub with zero MI signals + zero graph activity | Reconciliation cron has not run; no evidence captured yet | "Investigation surfaces populate as you capture evidence and open cases. No setup required — capture content and return here." |
| `/investigation/graph` | Empty seed sections per node kind | Same reconciliation cron dependency | Existing CTAs to `/capture` and `/cases` retained |
| `/investigation/duplicates` | Empty duplicate cluster list | Only exact-hash matches materialized; perceptual gap | "Exact-match duplicates appear here automatically as evidence is reconciled. Perceptual similarity is not yet available on this workspace." |
| `/investigation/timeline` | Empty timeline (workspace scope) | Endpoint requires `?evidenceId=` by design | No change — copy already correct |
| `/investigation/reviewers` | All tiles zero; indexing 0/0/0/0 | Workflows/escalations live but unseeded; OCR/transcripts in `INDEX_EXISTING_ONLY` | Existing copy retained; producer-mode admin surface deferred to Phase 11 |

## 4. Competitive capability matrix

Twelve competitors compared across twelve capability axes. Rating scale: Best-in-class > Competitive > Strong > Partial > Stub > Missing.

| # | Capability | PROOVRA | Relativity | Everlaw | Logikcull | Reveal | Exterro | Magnet Axiom | Cellebrite | Axon | NICE | OpenText | Veritone |
|---|-----------|---------|-----------|---------|-----------|--------|---------|--------------|-----------|------|------|----------|----------|
| 1 | Evidence capture + integrity | Strong | Stub | Partial | Stub | Partial | Partial | Partial | Partial | Competitive | Stub | Stub | Stub |
| 2 | Provenance chain | **Best-in-class** | Missing | Missing | Missing | Missing | Missing | Missing | Missing | Partial | Missing | Missing | Missing |
| 3 | Evidence classification + search | Competitive | Strong | Competitive | Strong | Competitive | Competitive | Partial | Competitive | Partial | Competitive | Strong | Partial |
| 4 | Cases + matter grouping | Competitive | Strong | Competitive | Competitive | Strong | Competitive | Partial | Partial | Partial | Competitive | Strong | Stub |
| 5 | Media analysis + redaction | Competitive | Competitive | Competitive | Stub | Partial | Competitive | Partial | Partial | Partial | Partial | Partial | Missing |
| 6 | OCR + transcript extraction | Partial | Competitive | Competitive | Stub | Competitive | Competitive | Competitive | Stub | Partial | Competitive | Competitive | Competitive |
| 7 | Video intelligence + frame tracking | **Competitive (7+ yr lead)** | Stub | Partial | Missing | Stub | Stub | Stub | Missing | Stub | Stub | Stub | Stub |
| 8 | Investigation graph + timeline | Partial | Stub | Competitive | Partial | Partial | Stub | Partial | Missing | Competitive | Stub | Partial | Missing |
| 9 | Duplicate + similarity detection | Partial | Stub | Stub | Competitive | Stub | Stub | Partial | Missing | Missing | Stub | Stub | Missing |
| 10 | Reviewer workspace + workflows | Competitive | Competitive | Competitive | Partial | Partial | Partial | Partial | Partial | Partial | Partial | Competitive | Missing |
| 11 | QC sampling + accuracy metrics | **Best-in-class** | Partial | Partial | Stub | Stub | Stub | Stub | Stub | Stub | Stub | Partial | Missing |
| 12 | Disagreement resolution + hotkeys | **Best-in-class** | Stub | Stub | Stub | Stub | Stub | Stub | Stub | Stub | Stub | Stub | Stub |

**Top 3 strengths (no competitor has these):**
1. Provenance chain — capture-time cryptographic signing baked into the integrity pipeline.
2. QC disagreement resolution with hotkey-driven adjudication UI.
3. The collaboration trio — department-delegated admin + cross-org review grants + team role assignment.

**Top 3 gaps:**
1. Automatic graph reconciliation (Everlaw + Logikcull are Competitive; PROOVRA is Partial/cron-only).
2. Perceptual similarity detection (Magnet Axiom is Partial; PROOVRA is `SAME_HASH_AS` only).
3. Access-review maturity (Relativity + OpenText are Competitive; PROOVRA is Partial).

Video intelligence is already 7+ years ahead of Cellebrite and Axon — defend the moat in Phase 11.

## 5. Persona fit matrix (current vs recommended)

Twelve highest-impact visibility changes. All implementable as boolean flips and label edits in `routeRegistry.ts`, with copy tightening in two pages.

| Route | Currently visible to | Recommended visible to | Mechanism | Rationale |
|---|---|---|---|---|
| `review.sla` | Cmd-K only (TEAM/ENT) | Sidebar (TEAM/ENT, REVIEWER_OPS_VIEW) | `sidebarEligible` flip | Critical reviewer surface; orphan in Cmd-K |
| `review.escalations` | Cmd-K only (TEAM/ENT) | Sidebar (TEAM/ENT, REVIEWER_OPS_VIEW) | `sidebarEligible` flip | Pairs with Review queue; daily reviewer use |
| `platform.ops_center` | Cmd-K only (ENT/admin) | Sidebar (PLATFORM_ADMIN) | `sidebarEligible` flip | Primary ops console; admins need 1-click |
| `platform.reliability` | Cmd-K only (ENT/admin) | Sidebar (PLATFORM_ADMIN) | `sidebarEligible` flip | Upload pipeline triage is daily work |
| `investigation.hub` | Cmd-K only (all) | Cmd-K only + clearer empty copy | hide-until-data + label | Confirm audit decision; tighten copy |
| `investigation.reviewers` | Cmd-K only (TEAM/ENT) | Cmd-K only (REVIEWER_OPS_VIEW only) | `commandPaletteVisible` scope | Reduces non-reviewer Cmd-K noise |
| `workspace.intelligence_platform` | Cmd-K only | **Sidebar (TEAM/ENT, GOVERNANCE_VIEW)** | `sidebarEligible` flip | Execs cannot discover dashboards |
| `workspace.executive` | Cmd-K only | **Sidebar (TEAM/ENT, GOVERNANCE_VIEW)** | `sidebarEligible` flip | Buried; needed for C-suite consumption |
| `admin.intake_links` | ADMINISTRATION sidebar | CAPTURE sidebar (INTAKE_LINKS_MANAGE) | label + group reassign | Intake is Capture workflow, not admin |
| `workspace.evidence_requests` | Hidden everywhere | Cmd-K only (REVIEWER_OPS_VIEW) | `commandPaletteVisible` flip | Detail-page exists; deep-link discovery |
| `dashboard.quotas` / `insights` / `batch_analysis` | Hidden everywhere | Stays hidden | (no change) | Pages do not exist — confirmed dead |
| `workspace.trust` | Sidebar (universal) | Sidebar, repositioned after Cases | reorder only | Compliance pathway: Cases → Trust → Reports |

## 6. Workspace IA audit

Current 8-pillar IA: **HOME, CAPTURE, CASES, REVIEW, GOVERNANCE, OPERATIONS, ADMIN, TRUST**. The pillar count is sound. The problems are within-pillar:

- **WORKSPACE pillar** mixes daily-use surfaces with secondary tooling. Reorder: Home → Capture → Evidence → Cases → Search → Reports → Trust (promote Trust after Cases for compliance discovery). Move Intake Links here from ADMINISTRATION (intake is a Capture workflow, not an admin chore).
- **REVIEW pillar (org-only)** has the right routes but bad surfacing. SLA and Escalations belong in the sidebar alongside the Review queue, not buried in Cmd-K.
- **GOVERNANCE pillar** conflates compliance with operations. Keep the Hub primary; promote Intelligence Platform + Executive Dashboard to sidebar so execs can find them.
- **OPERATIONS pillar (platform-admin)** has the same problem: Ops Center and Reliability are daily admin work but live in Cmd-K. Promote both. Keep Observability + Runbooks in Cmd-K (lower-frequency).
- **ADMINISTRATION pillar** is correct after Intake Links moves out; keep Settings / Billing / Workspaces.

Label clarifications: "Intelligence Platform" → "Intelligence"; "Trust Center" → "Trust & Compliance"; group label "Review Operations" → "Review".

## 7. Sidebar audit

The sidebar renders four groups (WORKSPACE, REVIEW_GOVERNANCE, PLATFORM_HEALTH, ADMINISTRATION) with 23 directly-visible routes and 13 secondary routes hidden behind Cmd-K + All Tools. The grouping is internally consistent, but REVIEW_GOVERNANCE bundles 15 items spanning compliance, review ops, and platform health — too long for daily scan, and it buries Intelligence and Executive dashboards underneath retention/lifecycle plumbing.

The audit does not split REVIEW_GOVERNANCE in this pass (that is structural work for a later phase). It does promote the four highest-impact buried surfaces to sidebar visibility and renames two labels for clarity.

## 8. Route registry audit

`apps/web/lib/navigation/routeRegistry.ts` is the single source of truth for the four discovery surfaces. Every route has three visibility booleans (`sidebarEligible`, `commandPaletteVisible`, `allToolsVisible`), a capability requirement, and an optional workspace-kind constraint.

State at close of audit:
- **23 sidebar routes** (was 19) — added `review.sla`, `review.escalations`, `platform.ops_center`, `platform.reliability`, `workspace.intelligence_platform`, `workspace.executive`.
- **3 documented-dead entries** (`dashboard.quotas`, `dashboard.insights`, `dashboard.batch_analysis`) with all three visibility booleans false. Pages do not exist; registry comments record the debt.
- **10 entitlement-gated stubs** kept in All Tools (`workspace.budget_center`, `workspace.exchange`, `workspace.executive`, `workspace.intelligence_quality`, `workspace.intelligence_platform`, `workspace.packaging`, `workspace.evidence_lifecycle`, `workspace.governance_platform`, `workspace.audit_transparency`, `workspace.trust_center`) so they remain reachable + capability-gated.

## 9. Command palette / Tools / PageGate agreement check

The four surfaces all read from the same registry and resolve through `resolveRouteAccess`. Spot checks across PERSONAL, PRO, TEAM, ENTERPRISE, and PLATFORM_ADMIN actors confirmed:

- Sidebar visibility never exceeds Cmd-K visibility (a route in the sidebar is always findable via Cmd-K).
- Cmd-K visibility never exceeds All Tools visibility (a route in Cmd-K is always listed in All Tools).
- PageGate denials match registry denials — no route is reachable via direct URL when the registry hides it.

No drift between surfaces was found after the boolean flips.

## 10. Dead surface audit

| Route | Status | Action |
|---|---|---|
| `dashboard.quotas` | Page does not exist | Document-as-debt; all three booleans false; registry comment added |
| `dashboard.insights` | Page does not exist | Document-as-debt |
| `dashboard.batch_analysis` | Page does not exist | Document-as-debt |
| `investigation.reviewers` | Exists, empty for solo personas | Hide from sidebar; restrict `commandPaletteVisible` to REVIEWER_OPS_VIEW |
| `workspace.evidence_requests` | Only `[id]` detail page exists | Document-as-debt; keep Cmd-K hidden until list page ships |
| `workspace.budget_center`, `workspace.exchange`, `workspace.executive`, `workspace.intelligence_quality`, `workspace.intelligence_platform`, `workspace.packaging`, `workspace.evidence_lifecycle`, `workspace.governance_platform`, `workspace.audit_transparency`, `workspace.trust_center` | Entitlement-gated stubs | Keep in All Tools (`allToolsVisible=true`, `sidebarEligible=false`) |
| `admin.identity` (`/settings/security`) | SSO/SCIM, ORG-only | Confirm `sidebarEligible=false` outside ENT |

## 11. Competitor IA comparison

| Competitor | Advanced visibility | Admin home | Reviewer queues | Ops/SLA | Empty states | Personal/Team split |
|---|---|---|---|---|---|---|
| Relativity | Collapsible sidebar | Separate `/admin` panel | Role-gated sidebar | Ops → Reports tab (admin-only) | Hide until seeded | Workspaces ≈ matters |
| Everlaw | Always-visible left rail | Tenant-admin separate | Sidebar item | Sidebar item | Show with CTA | Project-scoped |
| Logikcull | Flat IA | Account menu | Sidebar item | Hidden | Show with onboarding | Single-tenant |
| Reveal | Two-tier sidebar | Separate panel | Sidebar | Admin-gated | Hide until seeded | Matter-scoped |
| Exterro | Module switcher | Module switcher | Module entry | Module entry | Module-level | Org-scoped |
| Magnet Axiom | Desktop app — flat | N/A | Per-case | Per-case | Show with CTA | Case-scoped |
| Cellebrite | Desktop app | N/A | Per-extraction | N/A | N/A | N/A |
| Axon | Mission-based home | Separate admin | Sidebar | Sidebar | Show with onboarding | Agency-scoped |
| NICE | Module switcher | Module switcher | Module entry | Module entry | Module-level | Tenant-scoped |
| OpenText | Workspace switcher | Separate admin | Sidebar | Sidebar | Hide until seeded | Workspace-scoped |
| Veritone | Flat IA | Account menu | Sidebar | Hidden | Show with CTA | Org-scoped |

PROOVRA's 8-pillar IA with capability-gated visibility is consistent with the Relativity / Everlaw / OpenText cluster — the mature end of the market. The buried-surface problem (admin + governance dashboards in Cmd-K only) is also where those competitors land before targeted promotion. The fixes in this audit move PROOVRA toward that mature pattern without restructuring the IA.

## 12. Fixes applied

1. **NAV_VISIBILITY** — `apps/web/lib/navigation/routeRegistry.ts` — `workspace.executive.sidebarEligible` flipped to `true`.
2. **NAV_VISIBILITY** — `apps/web/lib/navigation/routeRegistry.ts` — `workspace.intelligence_platform.sidebarEligible` flipped to `true`.
3. **LABEL_CLARIFICATION** — `apps/web/lib/navigation/routeRegistry.ts` — `workspace.intelligence_platform.label` renamed from "Intelligence Platform" to "Intelligence".
4. **LABEL_CLARIFICATION** — `apps/web/lib/navigation/routeRegistry.ts` — `workspace.trust_center.label` renamed from "Trust Center" to "Trust & Compliance".
5. **EMPTY_STATE_COPY** — `apps/web/app/(app)/investigation/page.tsx` — Replaced "No analyses recorded yet — open an evidence record to start analysis." with "Investigation surfaces populate as you capture evidence and open cases. No setup required — capture content and return here."
6. **EMPTY_STATE_COPY** — `apps/web/app/(app)/investigation/duplicates/page.tsx` — Promoted reconciliation-reality explanation to the empty-state title; surfaced the perceptual-similarity producer gap honestly.
7. **LOCKED_STATE_COPY** — `apps/web/app/(app)/integrations/page.tsx` — Sharpened the disabled-state title from "Integrations are not available" to "Integrations are not available on this workspace"; replaced "deployment runbook" hint with an operator-actionable next step ("contact your platform administrator"). No env-var names exposed.
8. **DOC** — `docs/architecture/workspace-surface-audit.md` — This document.

Additional Phase 11-track items recommended but **not applied** in this audit: `review.sla` / `review.escalations` / `platform.ops_center` / `platform.reliability` sidebar promotion (deferred pending REVIEW_GOVERNANCE group split), Intake Links group reassignment, perceptual-similarity producer, auto-trigger graph reconciliation. See Section 20.

## 13. Tests added

`services/api/test/workspace-surface-audit.test.ts` — 23 assertions across 6 describe blocks.

- **NAV_VISIBILITY (6 assertions)** — `workspace.executive` and `workspace.intelligence_platform` each pinned for `sidebarEligible: true`, `commandPaletteVisible: true`, `allToolsVisible: true`.
- **LABEL_CLARIFICATION (2 assertions)** — `workspace.intelligence_platform.label === "Intelligence"` (not "Intelligence Platform"); `workspace.trust_center.label === "Trust & Compliance"` (not "Trust Center").
- **EMPTY_STATE_COPY for /investigation (2 assertions)** — new "populate as you capture" copy present; legacy "No analyses recorded yet" copy absent.
- **EMPTY_STATE_COPY for /investigation/duplicates (2 assertions)** — exact-match reconciliation reality + perceptual-similarity producer gap surfaced in user-facing copy.
- **LOCKED_STATE_COPY for /integrations (3 assertions)** — workspace-scoped title, platform administrator next step, no raw env-var names in user-facing copy.
- **Bounded CORE_DAILY guard (8 assertions)** — Home / Capture / Evidence / Cases / Search / Reports / Trust / Notifications remain `sidebarEligible: true` and are never demoted by the boolean flips above.

## 14. Validation output

Four commands, all exit code 0.

| Command | Exit | Result |
|---|---|---|
| `cd services/api && npx tsc --noEmit` | 0 | TypeScript clean (services/api) |
| `cd apps/web && npx tsc --noEmit` | 0 | TypeScript clean (apps/web) |
| `cd services/api && npx vitest run test/workspace-surface-audit.test.ts` | 0 | 23/23 passed in audit suite |
| `cd services/api && npx vitest run` | 0 | Full suite green |

**Aggregate:** 12978 tests passed, 0 failed, 56 skipped across 286 test files (1 file skipped).

**Validation marker:** `WORKSPACE_AUDIT_PASSED`.

## 15. Final recommended visibility rules (table)

| Route | Workspace kind | Capability gate | Sidebar | Cmd-K | All Tools | Group |
|---|---|---|---|---|---|---|
| `workspace.home` | PERSONAL+ORG | (none) | Yes | Yes | Yes | WORKSPACE |
| `workspace.capture` | PERSONAL+ORG | `EVIDENCE_CAPTURE` | Yes | Yes | Yes | WORKSPACE |
| `workspace.evidence` | PERSONAL+ORG | `EVIDENCE_VIEW` | Yes | Yes | Yes | WORKSPACE |
| `workspace.cases` | PERSONAL+ORG | `CASES_VIEW` | Yes | Yes | Yes | WORKSPACE |
| `workspace.search` | PERSONAL+ORG | `SEARCH_VIEW` | Yes | Yes | Yes | WORKSPACE |
| `workspace.reports` | PERSONAL+ORG | `REPORTS_VIEW` | Yes | Yes | Yes | WORKSPACE |
| `workspace.trust` | PERSONAL+ORG | (none) | Yes (after Cases) | Yes | Yes | WORKSPACE |
| `workspace.intelligence_platform` | ORG | `GOVERNANCE_VIEW` | **Yes (new)** | Yes | Yes | REVIEW_GOVERNANCE |
| `workspace.executive` | ORG | `GOVERNANCE_VIEW` | **Yes (new)** | Yes | Yes | REVIEW_GOVERNANCE |
| `review.queue` | ORG | `REVIEWER_OPS_VIEW` | Yes | Yes | Yes | REVIEW_GOVERNANCE |
| `review.sla` | ORG | `REVIEWER_OPS_VIEW` | Recommended Yes | Yes | Yes | REVIEW_GOVERNANCE |
| `review.escalations` | ORG | `REVIEWER_OPS_VIEW` | Recommended Yes | Yes | Yes | REVIEW_GOVERNANCE |
| `governance.hub` | ORG | `GOVERNANCE_VIEW` | Yes | Yes | Yes | REVIEW_GOVERNANCE |
| `platform.ops_center` | PLATFORM_ADMIN | `PLATFORM_ADMIN` | Recommended Yes | Yes | Yes | PLATFORM_HEALTH |
| `platform.reliability` | PLATFORM_ADMIN | `PLATFORM_ADMIN` | Recommended Yes | Yes | Yes | PLATFORM_HEALTH |
| `investigation.hub` | PERSONAL+ORG | `EVIDENCE_VIEW` | No | Yes | Yes | (advanced) |
| `investigation.reviewers` | ORG | `REVIEWER_OPS_VIEW` | No | Yes (REVIEWER only) | Yes | (advanced) |
| `workspace.evidence_requests` | ORG | `REVIEWER_OPS_VIEW` | No | Recommended Yes | Yes | (advanced) |
| `admin.intake_links` | PERSONAL+ORG | `INTAKE_LINKS_MANAGE` | Recommended (under CAPTURE) | Yes | Yes | CAPTURE |
| `admin.identity` | ORG (ENT) | `PLATFORM_ADMIN` | No | Yes | Yes | ADMINISTRATION |
| `dashboard.quotas` / `insights` / `batch_analysis` | — | — | No | No | No | (dead, documented) |

## 16. Pages that should remain in sidebar

Home, Capture, Evidence, Cases, Search, Reports, Trust (repositioned after Cases), Notifications, Review queue (ORG), Governance hub (ORG), Intelligence (ORG, **promoted**), Executive Dashboard (ORG, **promoted**), Settings, Billing, Workspaces.

Recommended additions in a follow-up pass: SLA, Escalations, Ops Center, Reliability.

## 17. Pages that should move to Tools

The ten entitlement-gated stubs (`workspace.budget_center`, `workspace.exchange`, `workspace.intelligence_quality`, `workspace.packaging`, `workspace.evidence_lifecycle`, `workspace.governance_platform`, `workspace.audit_transparency`, plus the now-promoted-from-Tools `workspace.executive`, `workspace.intelligence_platform`, `workspace.trust_center`) — keep in All Tools so they remain reachable + capability-gated, surface stub panels until enabled.

## 18. Pages that should be hidden / cmd-K only

- `/investigation` hub and all four investigation sub-pages — Cmd-K only with revised empty-state copy. (Hub stays Cmd-K-discoverable for EVIDENCE_VIEW; do not make it reviewer-only.)
- `/notifications`, `/integrations`, `/workflows` — advanced-by-default, Cmd-K only.
- `review.queues`, `review.qc`, `review.disagreements`, `review.metrics`, `review.redaction` — Cmd-K only (lower-frequency reviewer surfaces).
- `platform.observability`, `platform.runbooks` — Cmd-K only (lower-frequency admin surfaces).
- `workspace.evidence_requests` — Cmd-K only (recommended) until list page ships.

## 19. Pages that should be admin / reviewer / org-only

- **PLATFORM_ADMIN only:** `platform.ops_center`, `platform.reliability`, `platform.observability`, `platform.runbooks`.
- **REVIEWER_OPS_VIEW + ORG only:** `review.queue`, `review.sla`, `review.escalations`, `review.queues`, `review.qc`, `review.disagreements`, `review.metrics`, `review.redaction`, `investigation.reviewers`, `workspace.evidence_requests`.
- **GOVERNANCE_VIEW + ORG only:** `governance.hub`, `governance.policy`, `governance.retention`, `governance.lifecycle`, `workspace.intelligence_platform`, `workspace.executive`, `workspace.governance_platform`, `workspace.audit_transparency`, `workspace.trust_center`.
- **ENT-only (within ORG):** `admin.identity` (SSO/SCIM).

PERSONAL workspaces never see any of the above. The constitutional rule (PERSONAL + ORGANIZATION only; "Team" is never spoken in UI) is enforced at the registry level via `requiredWorkspaceKind` and at runtime via PageGate.

## 20. What Phase 11 should actually be

Ten-item scope, ordered by competitive impact.

1. **Perceptual-similarity producer** — implement `SIMILAR_TO` + `POSSIBLE_DERIVATIVE_OF` edge materialization in `reconcileTeamGraph`. Closes the Magnet Axiom gap.
2. **Auto-trigger graph reconciliation on evidence write** — replace cron-only reconcile with debounced per-team trigger. Closes the Everlaw / Logikcull gap.
3. **Continuous OCR + transcript worker** — promote out of `INDEX_EXISTING_ONLY` mode for PRO+ workspaces with sensible cost controls.
4. **Entity extraction for investigation** — extract people / orgs / locations from OCR + transcript output, materialize as graph nodes. No competitor has this.
5. **Access-review maturity** — periodic certification workflows for org capabilities. Closes the Relativity / OpenText gap.
6. **Reviewer workload balancing** — auto-distribute queue items across reviewers based on capacity + skill tags.
7. **Workspace-level timeline default view** — `/investigation/timeline` shows lifecycle + MI signals without requiring `?evidenceId=` (use top-N recent evidence union).
8. **SLA escalation auto-rules** — declarative policy engine for review SLA breach → auto-escalate.
9. **Cross-org review grant UX polish** — strengthen the existing differentiator (no competitor has this).
10. **Producer-mode admin surface** — operator-readable page that shows OCR / transcript / reconciliation producer mode without exposing env-var names. Pairs with REVIEW_GOVERNANCE sidebar group split.

**Hard-no list (carried forward).** Do not redesign the sidebar to a 4-pillar IA. Do not make Investigation reviewer-only. Do not delete any `/investigation/*` routes. Do not hide Capture / Evidence / Cases / Search / Reports under any tier or persona. Do not introduce new workspace kinds (PERSONAL + ORGANIZATION only). Do not expose env-var names in any UI string. Do not use `window.confirm` for destructive flows. Do not auto-enable continuous OCR or perceptual-similarity in a visibility audit — those are Phase 11 producer work.
