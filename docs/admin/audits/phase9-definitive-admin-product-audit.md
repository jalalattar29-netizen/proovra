# PHASE 9 — Definitive Admin & Platform-Admin Product Audit

**Revision 2 — completeness correction.** Revision 1's inventories were counted at the wrong granularity and its browser-coverage claim was wrong. Both are rebuilt below from per-element enumeration and from measurement. The findings that survived are unchanged in substance; three are now runtime-proven, one is rewritten, two are new, and one probe result of my own is retracted.

**Audited SHA — `79542b5845569b4087b0656a292011321f4c53ba`** (`origin/main`, identical to the accepted Phase-8 final SHA; zero commits newer).

| | |
| --- | --- |
| Audited SHA | `79542b5845569b4087b0656a292011321f4c53ba` |
| Phase-8 final SHA | `79542b5845569b4087b0656a292011321f4c53ba` — ancestor check: **YES** (identical) |
| Commits newer than Phase 8 | **0** — no audit section is stale |
| Audit worktree | `D:/pv-p9 (detached, clean, no .env, no junction)` |
| Generated | 2026-09-08T00:35:41.080Z |
| Screenshots captured | **0** |
| Product files changed | **NO** |
| Committed / pushed | **NO / NO** |
| Production contacted | **NO** |

## Scope and method

Every PROOVRA Admin and Platform-Admin surface, its controls, its metrics, its copy, its backend authorities, its authorization, its visual implementation and its test coverage. **209 application routes discovered**, of which **47 are canonical `/admin` routes** (41 listed + 6 contextual detail), plus **18 organization-scoped `/organizations/:id/admin/*` pages** and **1** `/governance-platform/delegated-admin` surface carrying admin-shaped capability inside the tenant boundary.

Code-first, with targeted runtime verification. Every claim was read out of production source in the pinned worktree; the four runtime dimensions (failure-state rendering, low-privilege reachability, computed style, expanded test counts) were measured against the sanctioned local admin fixture, whose environment module builds the child process environment from an allowlist and throws before spawn if any value resolves off this machine. No suite was executed, no screenshot captured, no Production endpoint or credential reachable.

---

## What revision 1 got wrong

Recorded here rather than quietly overwritten, because two of these are the kind of error this audit exists to catch.

| Item | Revision 1 said | Revision 2 measures | Why revision 1 was wrong |
| --- | --- | --- | --- |
| **Material control count** | 41 (counted at the listed-surface level) | 448 control definitions across all 47 routes, 0 UNKNOWN | Revision 1 counted surfaces, not controls. The per-element enumeration is Table C. |
| **Admin browser coverage** | 1 assertion; no Admin coverage exists | 9 spec files, 3,460 lines, 32 static declarations, 97 runtime-expanded tests, 132 expect() calls — in apps/web/e2e/admin-control-plane/, with its own Playwright config, wired to no runner | The revision-1 sweep enumerated projects from the root playwright.config.ts. This suite has its own config in its own directory and was invisible to that sweep. ADM-P2-004 is rewritten. |
| **Playwright test accounting** | 562 static test() declarations in the eight layout projects | 1,169 runtime-expanded cases in the eight layout projects (390/109/97/148/264/26/46/89); 255 chromium; 88 point7; total 1,512 — reconciles exactly with the Phase-8 figures | Revision 1 counted static declarations; several specs parameterise over viewport and locale matrices. Measured with `playwright test --list`. |
| **Metric / Card inventory** | 40 selected metrics | 539 material Card / KPI / fact / count / status / table / chart elements across all 47 routes | Revision 1 traced a selected sample. The full enumeration is Table F. |
| **User-facing copy inventory** | not enumerated; 10 copy findings reported | 1,215 deduplicated semantic text units across all 47 routes, truth-scanned | Required by §3 of the correction brief. Source comments are stripped before matching so docblock prose is never counted as UI copy. |
| **Visual certainty** | '0 defects' asserted from source inspection only | 0 source-level defects AND 0 runtime computed-style defects, measured on 17 route loads. One candidate (contrast 1.06:1) was surfaced by the probe and DISCONFIRMED on inspection — the surface is gradient-backed, which `backgroundColor` reports as transparent. | Revision 1 cited CSS comments as if they were measurements. They are now corroborated by getComputedStyle. |
| **/admin/billing failure state** | briefly probed with a glob that could not match, and mis-recorded | measured correct — renders 'Billing unavailable … not-connected state, not an empty platform' | `**/v1/admin/billing*` cannot match `/v1/admin/billing/detail`; `*` does not cross a path separator. |
| **Mutation success/failure UI** | an interim scan reported 25 mutations with neither | 0 mutations without success/failure UI | Four distinct idioms are in use (page toast, action panel, per-row result, per-source failure state) and the first detector knew one of them. Several sections also centralise the whole cycle in a shared runner the detector had to follow into. |

---

## Executive verdict

> **PRODUCTION-CAPABLE. Three P1 corrections are required before the Admin console can be trusted in an incident, and all three are now proven at runtime rather than argued from source.**

**Security — strong, and independently re-verified.** All 149 admin-prefixed `/v1` routes carry a real authorization primitive; the 11 that matched no automated pattern were each read by hand. `adminRelevantRoutesWithNoAuthorizationPrimitive = 0`. No auth bypass, no cross-tenant customer-data access, no unguarded destructive action, no caller-supplied field selecting authority. Anti-enumeration was measured, not assumed: a non-member passing another workspace's id receives 404 on all five runtime routes.

**Visual — 0 source-level defects AND 0 runtime computed-style defects.** Measured on 17 route loads with `getComputedStyle`, not inferred from CSS comments. The one candidate the probe surfaced was disconfirmed on inspection and is documented below.

**Data truth — split, and the split is one shape.** 23 metric elements carry an explicit state envelope and the capping disclosure is genuinely good, but a failed read is stored as the same value an empty result produces and rendered through the same branch. On `/admin/alerts` and `/admin/operations` that produces a categorical all-clear — captured verbatim from a live failed read.

**Coverage — the suite exists, and nothing runs it.** 97 Admin browser tests in 9 files are wired to no workflow and no script; 0 execute in CI. Two of its assertions — the two aimed at exactly the false-all-clear class — cannot fail.

### P0 findings

**None.**

### P1 findings

- **`ADM-P1-001` — The platform Alerts Center renders a categorical all-clear when its read fails**  
  An operator triaging an incident reads a fabricated all-clear on the surface whose entire purpose is to say what is wrong. Open incidents, critical security events, failed jobs, failed payments and SSO outages are all invisible in exactly the condition where the platform is least healthy.
- **`ADM-P1-002` — The platform Operations console asserts "nothing is currently open" when the incident read fails**  
  Worse than a silent blank: the copy explicitly pre-empts the correct interpretation, telling the operator that the empty table is a measurement rather than a failure — and it does so while a neighbouring section renders live data, which makes the page look healthy.
- **`ADM-P1-003` — The unversioned /admin/runtime/* family returns platform-global infrastructure state behind tenant-membership permissions**  
  Cross-tenant disclosure of deployment internals to the lowest-paying customer tier, measured rather than inferred: unreleased feature names via migration titles, a named security-control gap (Object Lock disabled), platform-wide incident counts, worker health and graph size. No secret VALUE is emitted — the module states this and the payloads confirm it — so this is a platform-internals disclosure, not a credential leak. A VIEWER's reach is narrower than the other four routes but still includes the platform schema posture.

### Owner decisions

- **OWN-1** — Should a tenant be able to read PROOVRA's platform runtime readiness, migration inventory and schema-drift detail at all?
- **OWN-2** — Should a support-access grant into a customer organization be mintable without a customer-side approver?
- **OWN-3** — Can the /v1/admin/organizations and /v1/admin/organizations/:id compatibility aliases be removed?
- **OWN-4** — What is the disposition of the eight dormant Playwright layout projects (562 test declarations, no runner)?
- **OWN-5** — Should POST /v1/admin/audit-log (manual platform-audit entry) have an operator control?

---

## Exact accounting

### Inventory

| Metric | Count |
| --- | ---: |
| Filesystem routes discovered | 209 |
| Canonical Admin routes reviewed | 47 |
|   — listed surfaces | 41 |
|   — contextual detail pages | 6 |
| Admin surface source lines reviewed | 49120 |
| **Material control definitions** | **448** |
|   — button | 218 |
|   — link | 67 |
|   — filter | 67 |
|   — input | 54 |
|   — modal / overlay trigger | 18 |
|   — select | 17 |
|   — pagination control | 7 |
|   — controls left UNKNOWN | 0 |
| **Material Card / metric / status elements** | **539** |
|   — from the component scan | 487 |
|   — bespoke tiles, /admin/platform/media-graph | 28 |
|   — bespoke tiles, /admin/platform/analytics | 24 |
| **User-facing semantic text units** | **1215** |
|   — heading | 409 |
|   — label | 399 |
|   — description | 130 |
|   — empty-state body | 97 |
|   — help text | 52 |
|   — input placeholder | 50 |
|   — count noun | 39 |
|   — accessibility label | 30 |
|   — error/state body | 5 |
|   — scope statement | 4 |

### Contracts

| Metric | Count |
| --- | ---: |
| Frontend API call sites reviewed | 670 |
|   — distinct (path, method) pairs | 189 |
| Backend route registrations extracted | 1137 |
|   — unique paths | 1012 |
| Admin-prefixed `/v1` backend routes | 149 |
| Unversioned `/admin/runtime/*` backend routes | 5 |
| Admin-relevant backend routes reviewed | 230 |
| Admin-relevant routes with NO authorization primitive | 0 |
| Backend capabilities missing required UI | 2 |
| Frontend controls without backend authority | 0 |
| Mutation controls | 88 |
|   — with a confirmation dialog | 79 |
|   — with step-up | 54 |
|   — re-reading the server after success | 50 |
|   — with success UI | 52 |
|   — with failure UI | 73 |
|   — **with neither success nor failure UI** | 0 |
| Controls whose required input the console cannot supply | 1 |

### Truth, visual and coverage

| Metric | Count |
| --- | ---: |
| `ResultCount` instances (deduplicated) | 39 |
|   — passing `failed` | 5 |
| Metric elements carrying an explicit state envelope | 23 |
| Certification claims in Admin copy | 0 |
| "deleted" used for archived/revoked work | 0 |
| "completed" used for queued work | 0 |
| Raw enum / capability tokens in operator copy | 9 |
| Data-truth findings | 5 |
|   — false SUCCESS (a mutation reporting success it did not achieve) | 0 |
|   — false ALL-CLEAR (a read failure rendered as affirmative absence) | 3 |
| Authorization / scope findings | 1 |
| Transparency / colour findings — source level | 0 |
| Transparency / colour findings — runtime computed style | 0 |
| Misleading-text findings | 11 |
| Duplication / legacy findings | 4 |
| Test-integrity findings | 1 |
| **Admin browser spec files** | **9** |
|   — lines | 3460 |
|   — static `test()` declarations | 32 |
|   — runtime-expanded tests (`--list`) | 97 |
|   — `expect()` calls | 132 |
|   — **executed in CI** | **0** |
|   — assertions that cannot fail | 2 |
| Admin assertions inside the one CI-run project | 1 |
| Playwright configs in the repository | 3 |
| Root-config expanded tests | 1512 |
|   — chromium (the only project any workflow runs) | 255 |
|   — point7 (local runner script only) | 88 |
|   — eight layout projects (no runner) | 1169 |

### Findings

| | |
| --- | ---: |
| **P0** | 0 |
| **P1** | 3 |
| **P2** | 8 |
| **P3** | 12 |
| **Total** | 23 |
| Owner decisions | 5 |
| `RUNTIME_NOT_PROVEN` | **0** |
| `UNKNOWN` | **0** |
| `NOT_REVIEWED` | **0** |

`UNKNOWN = 0`. `NOT_REVIEWED = 0`. `RUNTIME_NOT_PROVEN = 0` — all three items revision 1 deferred were measured; see **Runtime verification** below.

---

## Table A — Complete page inventory (canonical Admin console)

One row per listed surface. `Scope` is the registry's own `AdminSurfaceScope`, verified against what the page actually calls. `Lines` counts the page and its `_sections/` decomposition. `Ctrl` is that route's share of the 448 control definitions in Table C.

| Route | Label | Route id | Scope | Capability | Lines | Endpoints | Ctrl | Confirms | Step-up refs |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| `/admin` | Platform posture | `platform.admin` | PLATFORM | [PLATFORM_ADMIN] | 966 | 1 | 8 | 0 | 0 |
| `/admin/customers` | Customer directory | `platform.customers` | PLATFORM | [PLATFORM_ADMIN] | 526 | 1 | 9 | 0 | 0 |
| `/admin/workspaces` | Workspace inventory | `platform.workspaces` | PLATFORM | [PLATFORM_ADMIN] | 444 | 1 | 12 | 0 | 0 |
| `/admin/users` | People | `platform.users` | PLATFORM | [PLATFORM_ADMIN] | 723 | 2 | 12 | 0 | 0 |
| `/admin/demo-requests` | Demo requests | `platform.demo_requests` | PLATFORM | [PLATFORM_ADMIN] | 1340 | 6 | 26 | 4 | 0 |
| `/admin/contact-sales` | Contact sales | `platform.contact_sales` | PLATFORM | [PLATFORM_ADMIN] | 802 | 3 | 11 | 0 | 0 |
| `/admin/provisioning` | Provisioning | `platform.provisioning` | PLATFORM_AUDIT | [PLATFORM_ADMIN] | 1317 | 5 | 25 | 4 | 23 |
| `/admin/evidence-ops` | Evidence health | `platform.evidence_ops` | PLATFORM | [PLATFORM_ADMIN] | 790 | 1 | 5 | 0 | 0 |
| `/admin/evidence-ops/records` | Affected records | `platform.evidence_records` | PLATFORM | [PLATFORM_ADMIN] | 626 | 1 | 11 | 0 | 0 |
| `/admin/platform/exports` | Exports | `operations.exports` | WORKSPACE | [OPS_CENTER_VIEW] | 844 | 4 | 5 | 0 | 0 |
| `/admin/platform/signers` | Signers | `operations.signers` | PLATFORM_AUDIT | [OPS_CENTER_VIEW] | 1216 | 7 | 14 | 2 | 32 |
| `/admin/platform/media-graph` | Media intelligence ops | `platform.media_graph` | PLATFORM_AUDIT | [PLATFORM_TELEMETRY_VIEW] | 818 | 4 | 3 | 2 | 0 |
| `/admin/platform/recovery` | Recovery | `operations.recovery` | WORKSPACE | [OPS_CENTER_VIEW] | 641 | 4 | 5 | 2 | 15 |
| `/admin/identity` | Identity operations | `admin.identity` | WORKSPACE | [PLATFORM_ADMIN] | 2622 | 15 | 40 | 9 | 70 |
| `/admin/identity/providers` | Identity providers | `admin.identity_providers` | WORKSPACE | [PLATFORM_ADMIN] | 1271 | 4 | 26 | 1 | 19 |
| `/admin/identity/scim` | SCIM operations | `admin.identity_scim` | WORKSPACE | [PLATFORM_ADMIN] | 1812 | 10 | 20 | 4 | 28 |
| `/admin/identity/sessions` | Sessions & devices | `admin.identity_sessions` | WORKSPACE | [PLATFORM_ADMIN] | 2570 | 13 | 19 | 3 | 35 |
| `/admin/identity/permission-matrix` | Permission matrix | `admin.identity_permission_matrix` | WORKSPACE | [PLATFORM_ADMIN] | 956 | 3 | 15 | 1 | 16 |
| `/admin/identity/access-reviews` | Access reviews | `admin.identity_access_reviews` | WORKSPACE | [PLATFORM_ADMIN] | 754 | 3 | 7 | 2 | 15 |
| `/admin/identity/runtime` | Identity runtime | `admin.identity_runtime` | WORKSPACE | [PLATFORM_ADMIN] | 1213 | 7 | 13 | 3 | 21 |
| `/admin/identity/timeline` | Identity audit | `admin.identity_timeline` | WORKSPACE | [PLATFORM_ADMIN] | 373 | 1 | 5 | 0 | 2 |
| `/admin/audit` | Admin activity | `platform.audit` | PLATFORM | [PLATFORM_ADMIN] | 1087 | 3 | 10 | 0 | 0 |
| `/admin/timeline` | Timeline | `platform.timeline` | PLATFORM | [PLATFORM_ADMIN] | 483 | 1 | 8 | 0 | 0 |
| `/admin/alerts` | Alerts | `platform.alerts` | PLATFORM | [PLATFORM_ADMIN] | 290 | 1 | 2 | 0 | 0 |
| `/admin/search` | Search | `platform.search` | PLATFORM | [PLATFORM_ADMIN] | 410 | 1 | 3 | 0 | 0 |
| `/admin/platform-health` | System health | `platform.platform_health` | PLATFORM | [PLATFORM_ADMIN] | 568 | 1 | 2 | 0 | 0 |
| `/admin/platform/readiness` | Readiness | `operations.readiness` | PLATFORM | [PLATFORM_TELEMETRY_VIEW] | 624 | 1 | 3 | 0 | 0 |
| `/admin/platform/observability` | Observability | `platform.observability` | PLATFORM | [PLATFORM_TELEMETRY_VIEW] | 1663 | 5 | 1 | 0 | 0 |
| `/admin/platform/reliability` | Reliability | `platform.reliability` | WORKSPACE | [OPS_CENTER_VIEW] | 574 | 5 | 5 | 2 | 0 |
| `/admin/platform/queues` | Queues | `platform.queue_ops` | PLATFORM_AUDIT | [OPS_CENTER_VIEW] | 880 | 4 | 7 | 0 | 19 |
| `/admin/platform/automation` | Automation | `platform.automation` | WORKSPACE | [AUTOMATION_VIEW] | 689 | 3 | 4 | 0 | 0 |
| `/admin/platform/analytics` | Analytics ops | `platform.analytics` | WORKSPACE | [ANALYTICS_VIEW] | 839 | 8 | 1 | 0 | 0 |
| `/admin/operations` | Operations | `platform.operations` | PLATFORM | [PLATFORM_ADMIN] | 897 | 3 | 19 | 1 | 0 |
| `/admin/billing` | Billing | `platform.billing` | PLATFORM | [PLATFORM_ADMIN] | 764 | 1 | 4 | 0 | 0 |
| `/admin/costs` | Costs | `platform.costs` | PLATFORM | [PLATFORM_ADMIN] | 647 | 1 | 1 | 0 | 0 |
| `/admin/platform/runbooks` | Runbooks | `platform.runbooks` | PLATFORM | [RUNBOOKS_VIEW] | 449 | 0 | 6 | 0 | 0 |
| `/admin/dashboard` | Traffic | `platform.dashboard` | PLATFORM | [PLATFORM_ADMIN] | 918 | 1 | 1 | 0 | 0 |
| `/admin/executive` | Executive | `platform.executive` | PLATFORM | [PLATFORM_ADMIN] | 690 | 1 | 1 | 0 | 0 |
| `/admin/adoption` | Adoption | `platform.adoption` | PLATFORM | [PLATFORM_ADMIN] | 260 | 1 | 1 | 0 | 0 |
| `/admin/security` | Security | `platform.security` | WORKSPACE | [PLATFORM_ADMIN] | 3185 | 5 | 32 | 2 | 29 |
| `/admin/support-access` | Support access | `platform.support_access` | PLATFORM_AUDIT | [PLATFORM_ADMIN] | 1052 | 7 | 17 | 5 | 17 |

Plus **6 contextual detail pages** — `/admin/customers/[id]`, `/admin/workspaces/[id]`, `/admin/users/[id]`, `/admin/demo-requests/[id]`, `/admin/contact-sales/[id]`, `/admin/platform/runbooks/[slug]` — each registered in `ADMIN_CONTEXTUAL_ROUTES` with a breadcrumb parent. Their controls are included in the Table C totals.

---

## Table B — Misplaced, hidden, orphaned and duplicated surfaces

| Surface | Where it lives | What it administers | Disposition | Note |
| --- | --- | --- | --- | --- |
| `/organizations/:id/admin/**` (18 pages) | `app/(app)/organizations/[id]/admin` | ONE customer organization | **Correctly placed** | Enterprise/org administration inside the tenant boundary. Not platform administration, and not a duplicate of `/admin`. |
| `/governance-platform/delegated-admin` | `app/(app)/governance-platform` | Delegated-admin grants for one workspace | **Correctly placed** | Gates on `workspace.governance_platform` — its section's id, not its own; it has no registry entry (see `ADM-P3-011`). |
| `/executive` | `app/(app)/executive` | ONE workspace's trend metrics (`/v1/executive/trends`) | **Correctly placed, name collides** | Shares a label with `/admin/executive` (platform revenue/leads/usage). Different authorities, different scopes. |
| `/operations`, `/operations/health` | `app/(app)/operations` | ONE workspace's incidents (`/v1/ops/*`) | **Correctly placed, name collides** | Distinct authority from `/admin/operations` (`/v1/admin/incidents`, platform-wide). Both real, both needed. |
| `/tools` | `app/(app)/tools` | Route discovery | **Correctly placed** | `INTERNAL/notFound` for non-platform-admins; makes no fetch. |
| `GET /admin/runtime/{readiness,queues,workers,migrations,schema-status}` | `runtime-readiness.routes.ts`, `ops.routes.ts` | The whole platform runtime | **MISPLACED (API namespace)** | Five API routes named `/admin/**`, carrying **no `/v1` prefix**, **not** behind `requirePlatformAdmin`. Runtime-proven reachable by a free personal-plan owner. `ADM-P1-003`. |
| `apps/web/e2e/admin-control-plane/` | its own Playwright config | The Admin acceptance matrix | **ORPHANED (no runner)** | 97 tests, 0 executed anywhere. `ADM-P2-004`. |
| `ADMIN_CONTEXTUAL_ROUTES` → `/admin/identity/` | `adminNavigation.ts:588` | nothing | **HIDDEN / UNREACHABLE** | All seven identity children are registered nav children with exact hrefs, so the rule can never fire. `ADM-P3-002`. |
| `GET /v1/admin/organizations`, `/v1/admin/organizations/:id` | `admin-organizations.routes.ts:98,155` | Customers | **DUPLICATE_ENDPOINT** | Byte-identical aliases of `/v1/admin/customers*`, zero consumers. `ADM-P3-005`. |
| `GET /v1/ops/metrics` | `ops.routes.ts:640` | Process metrics | **DUPLICATE_ENDPOINT** | Same snapshot as `GET /v1/admin/platform/metrics`; no product consumer. `ADM-P3-006`. |
| `POST /v1/admin/audit-log` | `admin-audit.routes.ts:108` | Manual audit entry | **UI_MISSING** | No consumer; defaults `source: "admin_console"`. `ADM-P2-007`. |
| `POST /v1/ops/media-intelligence/runs/:runId/dismiss` | `ops.routes.ts:3239` | Media-intelligence runs | **UI_MISSING** | The console renders the counter it writes and offers no control. `ADM-P2-003`. |
| `continueGuest` (7 locales) | `packages/shared/src/i18n.ts` | nothing | **LEGACY_DELETE** | Verified at this SHA: zero consumers repo-wide, Guest Auth removed. `ADM-P3-001`. |

**Misplaced pages: 0. Orphaned Admin pages: 0. Dead Admin pages: 0. Duplicate Admin pages: 0.** The `adminNavigation` ⇄ filesystem diff is **empty in both directions**. The orphan in this table is a test suite, not a page.

---

## Table C — Material control inventory

**448 control definitions across all 47 routes. `UNKNOWN = 0`.** Repeated table rows driven by one component and one contract are counted as **one** control definition plus its row-bound behaviour, as the brief requires. Every control carries a stable `controlId` (`C0001`…`C0448`) in the JSON, with page, label, source file and line, visibility condition, handler, API method and path, guard, scope, re-read, success/failure UI and disposition.

### By kind

| Kind | Count |
| --- | ---: |
| button | 218 |
| link | 67 |
| filter | 67 |
| input | 54 |
| modal / overlay trigger | 18 |
| select | 17 |
| pagination control | 7 |
| **Total** | **448** |

### By disposition

| Disposition | Count | Meaning |
| --- | ---: | --- |
| `LOCAL_STATE` | 199 | Filters, disclosure, selection, dialog open/close. No network effect. |
| `MUTATION` | 88 | Handler resolves to a non-GET call. |
| `NAVIGATION` | 65 | `href` to another surface. |
| `READ` | 61 | Handler resolves to a GET (refresh, load-more, drill-down fetch). |
| `MODAL_HOST` | 18 | `StepUpModal` / `ConfirmActionModal` mounted with a `control=` prop rather than an event handler. |
| `PRESENTATION` | 17 | Rendered from a parent-supplied prop or static. |
| **`UNKNOWN`** | **0** | |

### Mutation-control quality — the 88 that change state

| Property | Count | Notes |
| --- | ---: | --- |
| Confirmation dialog before the request | 79 / 88 | The 9 without are reversible, low-consequence legs: contact-sales status transitions (4), incident **acknowledge** and **assign** (3 — `resolve` DOES confirm), export **verify**, MFA-policy save. A defensible split, not an omission. |
| Step-up | 54 / 88 | Present on every irreversible or custody-affecting leg. |
| Re-reads the server after success | 50 / 88 | The rest are on surfaces whose shared runner re-reads, or are fire-and-forget sends whose result arrives by a separate read. |
| Success UI | 52 / 88 | |
| Failure UI | 73 / 88 | |
| **Neither success nor failure UI** | **0 / 88** | |
| Native `window.confirm` / `alert` | **0** | The banned pattern is absent from the whole admin tree. |
| Buttons with no handler and no href | **0** | |
| `href="#"` links | **0** | |
| `TODO` / `FIXME` in admin product paths | **0** | |
| Empty `catch {}` in admin JSX | **0** | |
| Controls whose required input the console cannot supply | **1** | `/admin/platform/media-graph` retry — a free-text job id with no run listing (`ADM-P2-005`). This is a **discoverability** defect, not an accessibility one; the accessibility measurements are in Table H. |

Four success/failure idioms are in use and all four are legitimate: page-level `addToast`, a bounded `setActionResult` panel, a per-row `setRowResult` + `classifyFailure`, and a per-source `setXFailure`. Several sections funnel every mutation through a shared local runner that owns step-up, the success message, the re-read and the failure classification — a stronger arrangement than per-handler duplication.

---

## Table D — Frontend-to-backend reconciliation

**670 call sites** across the admin import closure resolving to **189 distinct (path, method) pairs**, matched against **1,137 backend registrations / 1,012 unique paths**, including template-literal registrations expanded from their `for (const x of [...] as const)` loops.

| Classification | Count | Detail |
| --- | ---: | --- |
| `CONNECTED_AND_CORRECT` | 187 | Path, method, parameters and guard all agree. |
| `CONNECTED_INCOMPLETE` | 1 | media-graph retry: correct contract, unusable input (`ADM-P2-005`). |
| `CONNECTED_WRONG_SCOPE` | 1 | The `/admin/runtime/*` family the app shell polls (`ADM-P1-003`). |
| `CONNECTED_WRONG_CONTRACT` | 0 | |
| `FRONTEND_WITHOUT_BACKEND` | **0** | |
| `MOCK_OR_PLACEHOLDER` | **0** | |
| `DUPLICATE_BACKEND_PATH` | 2 | `/v1/admin/organizations*` aliases (no frontend consumer). |
| `OBSOLETE_ENDPOINT` | 0 in product code; **5 in shipped runbook text** (`ADM-P2-001`). |
| `NOT_APPLICABLE` | 0 | |

Three apparent breaks were **disconfirmed** by reading source: `POST /v1/admin/incidents/:id/{acknowledge,resolve,assign}` (registered in a `for` loop at `admin-security.routes.ts:627`, `requirePlatformAdmin`, audits refusals), `POST /v1/admin/orgs/:id/{suspend,resume}` (same shape, plus step-up and a re-read before the success toast), and `POST /v1/identity/service-accounts/:id/${enabled ? "enable" : "disable"}` (both legs exist).

---

## Table E — Backend-to-frontend capability reconciliation

**230 admin-relevant backend routes** reviewed.

| Classification | Count | Notes |
| --- | ---: | --- |
| `UI_COMPLETE` | 196 | Filters, sorting, pagination, status transitions, retry/replay, revoke, retire, suspend/resume, restore, bulk actions, export, exact-ID search, identity controls, audit filters, support-access lifecycle, queue controls, signer/custody operations and SSO/SCIM are all reachable from the console. |
| `UI_PARTIAL` | 0 | |
| `UI_MISSING` | **2** | `POST /v1/ops/media-intelligence/runs/:runId/dismiss` (`ADM-P2-003`); `POST /v1/admin/audit-log` (`ADM-P2-007`). |
| `INTENTIONALLY_API_ONLY` | 12 | Secret-, cron- or internal-key-gated entrypoints with no operator decision to make; a UI would add attack surface without adding a capability. |
| `WORKER_INTERNAL` | 8 | |
| `AUTOMATION_INTERNAL` | 4 | |
| `DUPLICATE_ENDPOINT` | 3 | |
| `OBSOLETE_ENDPOINT` | 0 | |
| `NEEDS_OWNER_DECISION` | 5 | The `/admin/runtime/*` family (OWN-1) and `POST /v1/admin/audit-log` (OWN-5). |

---

## Table F — Data-truth inventory

**539 material Card, KPI, fact, count, status, table and chart elements** across all 47 routes, each carrying a stable `elementId` in the JSON with route, label, component, value expression, state-envelope use, formatter use and disclosure flags.

| Kind | Count |
| --- | ---: |
| section | 131 |
| card | 119 |
| status | 102 |
| table | 51 |
| count (`ResultCount`) | 39 |
| KPI | 30 |
| KPI grid | 6 |
| fact list | 5 |
| attention card | 3 |
| chart | 1 |
| bespoke tiles — `/admin/platform/media-graph` | 28 |
| bespoke tiles — `/admin/platform/analytics` | 24 |
| **Total** | **539** |

### Disposition

| Classification | Count | Evidence |
| --- | ---: | --- |
| `TRUTHFUL` | 533 | `/admin` carries a `Metric<T>` state per figure (`VALUE`/`NOT_MEASURED`/`UNKNOWN`/`ERROR`/`STALE`/`PARTIAL`/`NOT_APPLICABLE`) plus a `drillDown`. `/admin/executive` returns `{value: null, notMeasured}` for MRR, ARR, growth rate and renewal-risk rather than deriving them. `/admin/billing` says "This is a real zero, not an unmeasured signal" where it means it. `/admin/platform/media-graph` and `/admin/platform/analytics` both render an em dash, never a zero, for a missing or degraded counter. |
| `CAPPED_NOT_DISCLOSED` | 0 | Of 39 `ResultCount` instances: 23 pass `cap`, 18 `hasMore`, 8 `total`, 3 `complete`. |
| `PARTIAL_NOT_DISCLOSED` | 1 | The automation **rules** list is declared complete and proved API-side but renders `{rules.length} rule(s)` outside `ResultCount` (`ADM-P3-009`). |
| `STALE_NOT_DISCLOSED` | 0 | Freshness pills and `sampledAtUtc` are rendered where sampling applies. |
| `UNAVAILABLE_SHOWN_AS_ZERO` | **4** | `ADM-P1-001`, `ADM-P1-002`, `ADM-P2-002`, `ADM-P3-010`. |
| `MISLEADING_SCOPE` | 1 | Raw enum / capability tokens in operator copy (`ADM-P3-012`). |
| `WRONG` | 0 | |
| `NO_AUTHORITY` | 0 | No chart or tile without a server-side producer. |
| `DUPLICATE_MEANING` | 1 | `/v1/ops/metrics` vs `/v1/admin/platform/metrics` (`ADM-P3-006`). |

**Only 5 of the 39 `ResultCount` instances pass `failed`** — the prop the component was purpose-built with, whose own docstring reads: *"Without it an errored list renders 'No records yet', which states there is nothing at the one moment the page cannot know."* That single gap is the mechanism behind all three false-all-clear findings.

Searched for and **not found**: fabricated zeros in primary tile values, client-side filtering presented as a server total, double counting, a workspace figure labelled platform-wide, contradictory status fields, or "healthy" derived from an empty queue.

---

## Table G — Authorization, audience and tenancy

| Layer | Finding |
| --- | --- |
| Page guard | All 47 `/admin` pages inherit `PageRouteGate routeId="platform.admin"` (`requiredCapabilities: ["PLATFORM_ADMIN"]`, `requiredActiveSpace: "PLATFORM_ADMIN"`, `HIDDEN_IF_NO_CAPABILITY`). 26 additionally gate on their own registry id — and **every page whose registry entry requires a capability other than `PLATFORM_ADMIN` carries its own gate**, checked one by one. |
| API guard | Independent in every case. All 149 admin-prefixed `/v1` routes carry an authorization primitive; the 11 that matched no automated pattern were each read. **Zero unguarded admin-relevant routes.** |
| Caller-controlled authority | `authorizeOrFail` treats the request's `teamId` as a candidate that can only produce a denial; `resolveAdminWorkspace` derives the workspace server-side; `/v1/support-access/revoke` was corrected away from a caller-named gate; `/v1/support-access/start` verifies a supplied `approvedByUserId` against real ORG_ADMIN membership and refuses self-approval. **No caller-supplied field selects authority.** |
| Anti-enumeration | **Measured.** A free personal-plan user passing a workspace id they do not belong to receives **404** on all five `/admin/runtime/*` routes — identical to "does not exist". |
| Step-up | 54 of the 88 mutation controls, and 22 of 68 admin-relevant backend mutations. Present on every irreversible or custody-affecting leg. |
| Step-up gap | `POST /v1/support-access/start` and `/enter` — minting and entering a support grant into a customer organization — require platform staff and a capability but **no step-up**, while `POST /v1/break-glass/activate` does. See **OWN-2**. |
| Audit attribution | Platform actions write `emitPlatformAudit` with the staff actor; tenant-anchored actions write `emitTenantAudit`. Support context is server-pinned by an opaque token bound to the session hash; the client-called authorize-oracle was removed. |
| Scope confusion | **1 finding**, runtime-proven — `ADM-P1-003`. |
| Mobile | `apps/mobile` contains **zero** `/admin` or `/v1/admin` references. There is no mobile Admin surface. |

### Table G2 — Surface-tier visibility, measured

The historically vacuous surface-tier spec was re-read at this SHA: `e2e/phase-ia-surface-tier-visibility.spec.ts` no longer searches for `/try proovra/i`; it asserts against named copy constants, status codes and landmark presence. **That vacuity is repaired** — but two *other* vacuous assertions were found in the Admin suite (`ADM-P2-008`).

| Tier | Nav | Palette | Direct URL | `/v1/admin/*` | `/admin/runtime/*` | Execute |
| --- | --- | --- | --- | --- | --- | --- |
| Anonymous | No | No | Redirected to login | 401 | 401 | No |
| Signed-in, no platform capability | No | No | Denial panel (names the surface) | 403 | — | No |
| Workspace VIEWER | No | No | Denial panel | 403 | **200 on `schema-status`**, 403 on the other four *(measured)* | Only that read |
| Workspace ADMIN | No | No | Denial panel | 403 | **200 on all five** *(measured)* | Their own `/organizations/:id/admin/*` |
| Organization OWNER | No | No | Denial panel | 403 | **200 on all five** *(measured)* | Their own org admin |
| **FREE personal-plan owner** | No | No | Denial panel | 403 | **200 on all five for their own workspace; 404 for another's** *(measured)* | Only those reads |
| Platform Admin | Yes (console nav) | 36 of 41 | Yes | Yes | Yes | Yes |
| Support / break-glass | As the staff account | — | — | Server-pinned by the support token on the canonical authorization path | — | Bounded by the grant |

The only visibility↔enforcement mismatch is the `/admin/runtime/*` row.

Five listed surfaces are reachable **only** from the console navigation — `platform.evidence_records`, `platform.contact_sales`, `operations.signers`, `operations.exports`, `operations.recovery` all carry `sidebarEligible:false, commandPaletteVisible:false, allToolsVisible:false`. The registry's stated rule 3 names sidebar, All Tools and the command palette but not the console nav, so these five satisfy reachability in fact while contradicting the rule as written. Correct the rule, not the routes.

---

## Table H — Copy, visual and composition

### Copy — 1,215 semantic text units across all 47 routes

Extracted from every user-facing text prop (`title`, `headline`, `eyebrow`, `subtitle`, `description`, `purpose`, `note`, `message`, `reason`, `detail`, `confirmLabel`, `label`, `header`, `placeholder`, `aria-label`, `surface`, `noun`, `statusLabel`) plus heading children, with source comments stripped first so docblock prose is never counted as UI copy.

| Truth check | Result |
| --- | ---: |
| Certification claims (SOC 2 / ISO 27001 / HIPAA / PCI) | **0** |
| "deleted" used for archived or revoked work | **0** |
| "completed" used for queued work | **0** (the one hit is an upload-session status label) |
| Guarantee / absolute claims | **0** (the one hit is a disclaimer of scope) |
| Raw enum or capability tokens shown to operators | **9 distinct** (`ADM-P3-012`) |
| Empty-state bodies asserting absence on a failed read | **10** (`ADM-P1-001`, `ADM-P1-002`, `ADM-P2-002`) |

| # | Route | Current text | Why wrong | Proposed replacement | Copy-only? |
| --- | --- | --- | --- | --- | --- |
| H1 | `/admin/alerts` | "No active alerts — … right now there are none." | **Captured verbatim from a live failed read.** | "Alerts could not be read. This is not an all-clear — retry, or check platform health." | **No** — `ADM-P1-001` |
| H2 | `/admin/operations` | "…an empty table means nothing is currently open — not that nothing was measured." | **Captured verbatim from a live failed read**, and it pre-empts the correct reading. | Suppress on the failure path; render "Open conditions could not be read." | **No** — `ADM-P1-002` |
| H3 | `/admin/executive` | "…Once revenue, customers, leads and usage records exist…" | Measured on a failed read. | The `/admin/billing` wording. | No |
| H4 | `/admin/costs` | "No cost data — … Once provider usage events exist…" | Measured on a failed read. | Same pattern. | No |
| H5 | `/admin/adoption` | "No adoption data — … Once workspaces configure capabilities…" | Measured on a failed read. | Same pattern. | No |
| H6 | `/admin/customers` | "No customers yet — … appear here once they exist." | Measured on a failed read; reads as customer loss. | Same pattern. | No |
| H7 | `/admin/users` | "No people found — … Adjust the search or filters above." | Measured on a failed read; blames the operator. | Same pattern. | No |
| H8 | `/admin/workspaces` | "No workspaces match — … Adjust the search or filters…" | Measured on a failed read. | Same pattern. | No |
| H9 | `/admin/timeline` | "No platform events — … As admin actions … are recorded…" | Measured on a failed read. | Same pattern. | No |
| H10 | `/admin/dashboard` | "Analytics not connected — … once product events are recorded…" | Hedges better than the rest, still asserts no events. | Distinguish "not connected" from "could not be read". | No |
| H11 | `/admin/platform/analytics` | "Operational analytics require the ANALYTICS_VIEW capability" | A raw capability key, against the registry's own stated rule. | The bounded denial reason. | Yes — `ADM-P3-012` |

Four documentation-vs-code contradictions are `ADM-P3-003`, `-004`, `-007`, `-008`.

**Done well, and worth keeping:** `/admin/operations` distinguishes a *refused* resolve ("Its source still reports it as live, so the platform declined to close it") from a failure; `/admin/platform/media-graph` splits one `"metrics_unavailable"` string into `denied` / `unrecognised` / `error` because two of the three were wrong.

### Visual — source **and** runtime computed style, no screenshots

Source-level checks across the five admin stylesheets and all admin JSX:

| Check | Result |
| --- | ---: |
| Hardcoded hex/rgb in admin CSS **rules** | **0** (the 10 hex literals in `admin-system.css` are all inside contrast-measurement comments) |
| Colour literals in admin JSX | **0** |
| Unresolved CSS custom properties | **0** of the 74 the admin surface uses, against 373 defined |
| Legacy colour-system consumers | **0** |
| Semantic tone used decoratively | **0** |
| Dangerous and safe actions styled alike | **0** |
| Status conveyed by colour alone | **0** |

Runtime `getComputedStyle` measurements, 17 route loads, **0 screenshots**:

| Probe | Measured |
| --- | --- |
| Admin shell ground | `body.class = "antialiased has-app-decor is-internal-app is-admin-console"`; `background-image: none`; composited ground `rgb(247,248,252)` = `--surface-page` `#F7F8FC`. **The product's gradient and photographic decor are genuinely off inside the console** — the body-class mechanism works. |
| Token resolution | All 10 sampled tokens resolve to real values: `--ink-primary #0F172A`, `--ink-secondary #475569`, `--ink-muted #94A3B8`, `--silver-ink #5B6B7B`, `--surface-page #F7F8FC`, `--surface-card #FFFFFF`, `--surface-muted #F1F4F9`, `--danger-standard #B91C1C`, `--warning-standard #C2410C`, `--success-standard #15803D`. |
| Heading contrast | h1 `rgb(15,23,42)` on `rgb(247,248,252)` → **16.82:1** |
| Body/action text | `--silver-ink` on the page ground → **5.16:1**, which **corroborates the exact figure `admin-system.css` claims in its comment**. |
| Active nav link | `rgb(109,40,217)` on `rgb(242,236,254)` → **6.16:1** |
| Denial primary action | white on `linear-gradient(135deg, rgb(11,31,94), rgb(18,59,122))` → **≈13.9:1** |
| Disabled vs enabled control | Disabled: `background rgb(241,244,249)`, `cursor: not-allowed`. Enabled: transparent. **Distinguishable.** |
| Focus indicator | `outline: solid 2px rgb(124,58,237)` |
| Transparent / white text on a transparent ground | **0** across five routes' full text-bearing element sets |
| Nested same-colour surfaces | **0** |
| Mobile (375 px) | `documentOverflow: 0`, nav `overflow-x: auto` / `flex-wrap: nowrap`, first nav link `min-block-size: 44px` |
| RTL | `direction: rtl` propagates to the nav, `documentOverflow: 0` |

**One candidate was surfaced by my probe and is retracted.** An `<a data-testid="access-gate-action">` labelled "Open workspaces" measured **1.06:1** on `/admin/platform/queues`, `/exports`, `/recovery` and `/signers`. Cause: the probe read `backgroundColor`, and `ProovraSystemState.primaryBtnColors` sets the `background` **shorthand** to a gradient, which leaves `background-color` transparent. The computed `background-image` is `linear-gradient(135deg, rgb(11,31,94) 0%, rgb(18,59,122) 100%)` and the real contrast is ≈13.9:1. **Not a defect.** Recorded because a contrast probe that ignores `background-image` will keep producing this false positive.

**Classification: `VISUALLY_CORRECT` for all 41 listed surfaces.** `CONTRAST_DEFECT`, `TRANSPARENT_SURFACE_DEFECT`, `LEGACY_TOKEN_CONSUMER`, `WRONG_SEMANTIC_TONE`, `STATE_NOT_DISTINGUISHABLE`, `HIERARCHY_DEFECT`: **0 each, at source level and at runtime.** `DUPLICATE_STYLE_AUTHORITY`: 1 (the documented `components/ui` barrel vs deep-import split; admin consumes the canonical side).

### Composition

| Classification | Count | Surfaces |
| --- | ---: | --- |
| `COMPOSITION_CORRECT` | 38 | |
| `ADD_CONTEXT` | 2 | `/admin/executive`, `/admin/operations` — each needs the failure state |
| `USE_TABLE` | 1 | `/admin/platform/media-graph` — the two mutations need a record surface |
| `RECOMPOSE` / `MERGE_CARDS` / `SPLIT_CARD` / `REDUCE_DENSITY` / `FIX_HIERARCHY` / `FIX_MOBILE` / `FIX_RTL` | **0 each** | Mobile and RTL now measured, not assumed. |

One weakness is systemic and is the root of the P1s: **one failed read can erase independent successful reads**, because most pages hold a single `data` state. `/admin/operations` demonstrated it live — a failed incident read rendered an all-clear directly above a security-events table full of real rows. `/admin/support-access` shows the correct alternative: separate `supportFailure` and `emergencyFailure` states.

---

## Table I — Duplication and legacy inventory

| Candidate | Canonical | Consumers | Difference | Recommendation | Class |
| --- | --- | --- | --- | --- | --- |
| `/v1/admin/customers` vs `/v1/admin/organizations` | customers | alias has **0** | none — same handler, gate, payload | Remove after OWN-3 | `DUPLICATE_DELETE` |
| `/v1/admin/platform/metrics` vs `/v1/ops/metrics` | platform path | `/v1/ops/metrics`: 0 web, 6 runbook citations | same snapshot | Retire one, repoint runbooks | `DUPLICATE_MERGE` |
| `/v1/admin/incidents` vs `/v1/ops/incidents` | both | two consoles | platform-wide vs one workspace | **Retain** | `INTENTIONAL_VARIANT` |
| `/admin/executive` vs `/executive` | both | platform vs workspace | different services | Retain; disambiguate labels | `INTENTIONAL_VARIANT` |
| barrel `Button`/`Card`/`EmptyState` vs deep imports | deep imports | admin uses the canonical side | different prop shapes | Retain until the last legacy call site migrates | `INTENTIONAL_VARIANT` |
| `ui-legacy.tsx` | — | `Skeleton` ×8, `Input`/`Select` ×1 in admin; `useToast` ×63 repo-wide | — | Migrate the three; do **not** delete the file | `DUPLICATE_MERGE` |
| `ADMIN_CONTEXTUAL_ROUTES` `/admin/identity/` | the seven nav children | **0** — unreachable | — | Delete | `LEGACY_DELETE` |
| `continueGuest` (7 locales) | — | **0** | — | Delete | `LEGACY_DELETE` |
| Authorization guards / workspace resolvers / metric-state / audit writers / route registries / CSS authorities | one each | — | — | — | `CANONICAL` |

`PARALLEL_AUTHORITY_DEFECT`: **0.**

---

## Table J — Admin browser coverage and dormant coverage disposition

**Three Playwright configs exist.** Revision 1 saw one.

| Config | Projects | Expanded tests | Admin coverage | Runner |
| --- | --- | ---: | --- | --- |
| `playwright.config.ts` (root) | 10 | **1,512** | 1 assertion | `playwright-e2e.yml` runs `--project=chromium` only |
| `apps/web/playwright.config.ts` | 1 | 101 | 97 (it collects the admin subdirectory) | **none** |
| `apps/web/e2e/admin-control-plane/playwright.config.ts` | 1 | **97** | **all of it** | **none** — two generator scripts print the command for a human |

### Root config, per project (`--list`, measured)

| Project | Expanded | Admin? | Runner | Disposition |
| --- | ---: | --- | --- | --- |
| `chromium` | **255** | 1 assertion (`/admin/identity` returns 2xx) | `playwright-e2e.yml` | **Keep.** |
| `point7` | **88** | none | `scripts/point7-run.mjs`, local only | Keep; schedule it. |
| `search-layout` | 390 | none | **none** | Consolidate (OWN-4). |
| `operations-layout` | 264 | none (intercepts `**/admin/runtime/**`; asserts links to `/admin/platform/*`) | **none** | Consolidate. Closest home for new Admin coverage. |
| `attention-layout` | 148 | none | **none** | Consolidate. Port **3013 collides** with evidence-detail (`ADM-P2-006`). |
| `intake-links-layout` | 109 | none | **none** | Consolidate. |
| `evidence-detail-layout` | 97 | none | **none** | Consolidate. |
| `settings-layout` | 89 | none | **none** | Consolidate. |
| `billing-layout` | 46 | none | **none** | Consolidate. |
| `capture-layout` | 26 | none | **none** | Consolidate. |

**255 + 88 + 1,169 = 1,512** — reconciles exactly with the Phase-8 accounting (1,512 discovered, 255 bounded Chromium, 88 Point7, 1,169 layout).

### The Admin suite — `apps/web/e2e/admin-control-plane/` (9 files, 3,460 lines, 32 declarations → 97 tests, 132 `expect()`)

| Spec | Decls | `expect()` | What it covers |
| --- | ---: | ---: | --- |
| `admin-matrix.spec.ts` | 3 | 1 | 47 routes × 6 roles × 7 widths × 2 directions |
| `phase6-admin-journeys.spec.ts` | 8 | 24 | IA journeys, breadcrumbs, filter round-trip, missing entity |
| `phase5-audit-surfaces.spec.ts` | 7 | 22 | Audit-surface privacy, actor naming, no raw JSON dump, phone width |
| `admin-tabs-rtl-skiplink.spec.ts` | 4 | 40 | Tab addressability, RTL first frame, skip link |
| `admin-states.spec.ts` | 3 | 7 | Loading / error / filtered-empty / unauthorized / RTL, 8 families |
| `admin-mutations.spec.ts` | 3 | 20 | Contact-sales status transitions end to end |
| `admin-token-authority.spec.ts` | 2 | 17 | One value per visual role; flat console ground |
| `admin-visual-review.spec.ts` | 1 | 0 | Render and measure every admin route |
| `admin-journey-console.spec.ts` | 1 | 1 | Console journey |

**Executed in CI: 0.** And two of its assertions cannot fail (`ADM-P2-008`) — including the one covering the exact `/admin/operations` state that is `ADM-P1-002`.

An execution prerequisite worth recording: the repository pins Playwright 1.60.0, which wants browser build 1228; this machine has 1223 installed, so the suite needs `playwright install` before it can run at all.

### Admin coverage gaps → Phase 10 (`ADM-P2-004`)

1. Nothing executes the 97 tests, anywhere.
2. Two assertions report coverage of the false-all-clear class and cannot fail.
3. `/admin/alerts` is **not** one of `admin-states`' eight families, so the P1 there has no capture at all.
4. Step-up is exercised by no browser test (54 mutation controls declare it).

Dormant tests are **not** counted as coverage anywhere in this report.

---

## Table K — Phase-10 remediation backlog

| # | ID | Sev | Title | Depends on | Acceptance proof |
| --- | --- | --- | --- | --- | --- |
| 1 | `ADM-P1-003` | P1 | Close the `/admin/runtime/*` tenant disclosure | **OWN-1** | API test: VIEWER and free personal OWNER refused all five; platform admin not. The 20 measured status codes are the before-state. |
| 2 | `ADM-P2-008` | P2 | Make the two vacuous Admin assertions real | — | Repaired assertions FAIL on the current product, pass after #3 and #4. |
| 3 | `ADM-P1-001` | P1 | `/admin/alerts` must not assert an all-clear on a failed read | #2 | Stub to 500; "right now there are none" absent, failure copy present. |
| 4 | `ADM-P1-002` | P1 | `/admin/operations` must not assert "nothing is currently open" | #2, shares the fix shape with #3 | Stub to 500; assertion suppressed, `ResultCount failed` set. |
| 5 | `ADM-P2-002` | P2 | Same correction on the eight remaining dashboards; pass `failed` at all 39 `ResultCount` sites | #3, #4 | Parameterised test per page. |
| 6 | `ADM-P2-001` | P2 | Correct the five broken runbook citations; add a generator-time gate | — | Gate green; a broken citation fails it. |
| 7 | `ADM-P2-006` | P2 | Give `attention-layout` its own port | — | Both projects serve in one invocation. |
| 8 | `ADM-P2-004` | P2 | Wire the 97-test Admin suite to a scheduled workflow | #2, #7, **OWN-4** | A CI run reporting 97 Admin tests executed. |
| 9 | `ADM-P2-003` + `ADM-P2-005` | P2 | Media-graph: list the runs, drive retry **and** dismiss from the row | — | Row identifier reaches the correct path; retry's job id not reused for dismiss's row UUID. |
| 10 | `ADM-P2-007` | P2 | Manual audit entry: a control, or a truthful default `source` | **OWN-5** | API test asserting the recorded source. |
| 11 | `ADM-P3-010` | P3 | `?? 0` → `?? "—"` in the five executive sub-lines | — | Render test with the field absent. |
| 12 | `ADM-P3-012` | P3 | Replace `ANALYTICS_VIEW` with the bounded denial reason; gloss the evidence-ops enums | — | Copy contract test. |
| 13 | `ADM-P3-009` | P3 | Fix the four `admin-complete-lists.mjs` citations; move the automation rules count onto `ResultCount` | — | `admin-composition-contract.mjs` sees the fourth site. |
| 14 | `ADM-P3-011` | P3 | Register the 14 authenticated unregistered pages, or narrow the registry's claim | — | New test asserting every `app/(app)` page is registered. |
| 15 | `ADM-P3-005` | P3 | Remove the `/v1/admin/organizations*` aliases | **OWN-3** | API test asserting 404. |
| 16 | `ADM-P3-006` | P3 | Retire one metrics authority; repoint the runbooks | #6 | One registration survives; runbook gate passes. |
| 17 | `ADM-P3-001` | P3 | Delete `continueGuest` from seven locales | — | Key absent; i18n typecheck green. |
| 18 | `ADM-P3-002` | P3 | Delete the unreachable `/admin/identity/` contextual rule | — | Nav and breadcrumb tests green without it. |
| 19 | `ADM-P3-003` / `-004` / `-007` / `-008` | P3 | Correct the four doc-vs-code contradictions; assert the section ceiling | `-008` rides with #1 | `ADMIN_NAV_SECTIONS.length <= 9` passes. |

### Dependency graph

```
OWN-1 ──▶ 1 (P1-003) ──▶ 19 (P3-008 comment)
          └──▶ runbook edits (shared with 6)

2 (P2-008) ──▶ 3 (P1-001) ─┐
            └─▶ 4 (P1-002) ─┼──▶ 5 (P2-002)     [one mechanism, one fix]
                            │
7 (P2-006) ─────────────────┴──▶ 8 (P2-004) ◀── OWN-4

6 (P2-001) ──▶ 16 (P3-006)
9 (P2-003 + P2-005)              [independent]
OWN-5 ──▶ 10 (P2-007)
OWN-3 ──▶ 15 (P3-005)
11, 12, 13, 14, 17, 18, 19       [independent]
```

---

## Finding register

Twenty-one findings, deduplicated by root cause. Each carries its ID, severity, affected routes, roles, source files, endpoint or service, observed implementation, expected implementation, evidence, root cause, risk, recommended Phase-10 fix, dependency, blast radius and required acceptance proof.

### `ADM-P1-001` — The platform Alerts Center renders a categorical all-clear when its read fails

| | |
| --- | --- |
| **Severity** | P1 |
| **Classification** | `UNAVAILABLE_SHOWN_AS_ZERO` |
| **Affected route(s)** | `/admin/alerts` |
| **Roles / plans** | Platform Admin |
| **Endpoint / service** | GET /v1/admin/alerts (services/api/src/routes/admin-alerts.routes.ts) |
| **Source files** | `apps/web/app/(app)/admin/alerts/page.tsx:117-130`<br>`apps/web/app/(app)/admin/alerts/page.tsx:149-150`<br>`apps/web/app/(app)/admin/alerts/page.tsx:171-178` |
| **Dependency** | None. |
| **Blast radius** | One page; no API change. |

**Observed implementation.** load() catches every failure into a transient toast and leaves `data === null`. `const total = data?.total ?? 0` then makes `hasAlerts === false`, and the render branch `!loading && !hasAlerts` prints the EmptyState titled "No active alerts" whose body ends "...right now there are none." A 500, a 403, an expired session or a network failure therefore produces a categorical statement that the platform has no alert-worthy signals.

**Expected implementation.** A failed read must be a distinct, persistent state that says the alert list could not be read and offers a retry. The same page must never assert absence on a read it did not complete. `/admin/billing` already implements the correct pattern ("Billing unavailable ... This is a not-connected state, not an empty platform").

**Evidence.** RUNTIME-PROVEN (2026-09-08) against the sanctioned local admin fixture (API :8191, web :3311, disposable Postgres `pv-admincp-pg`, seeded by `services/api/scripts/seed-admin-fixture.ts`). The environment is built by `scripts/local-fixture-env/index.mjs`, which constructs the child environment from an allowlist and throws before spawn if any value resolves off this machine, so no Production endpoint or credential was reachable. No screenshots were taken. With `**/v1/admin/alerts*` aborted (`connectionrefused`), the rendered `<main>` of /admin/alerts contains, verbatim: "No active alerts — No alert-worthy platform signals are currently active. Open incidents, recent high/critical security events, failed jobs, failed payments, and SSO outages would appear here — right now there are none." No failure indication appears anywhere in `main`. `apiFetch` throws on any non-2xx (apps/web/lib/api.ts:383), so the catch branch is the live path for every server refusal; the component holds no `error` state (grep for setError|Failure|unavailable returns 0 hits).

**Root cause.** A failed read is stored as the same value (null) that a genuinely empty response would produce, and only one render branch consumes it.

**Risk.** An operator triaging an incident reads a fabricated all-clear on the surface whose entire purpose is to say what is wrong. Open incidents, critical security events, failed jobs, failed payments and SSO outages are all invisible in exactly the condition where the platform is least healthy.

**Recommended Phase-10 fix.** Add a `failure` state set in the catch; render a distinct 'Alerts could not be read' panel with a Retry action; pass `failed` to the ResultCount (the prop already exists for this purpose).

**Required acceptance proof.** A render or browser test that stubs GET /v1/admin/alerts to 500 and asserts the page does NOT contain "right now there are none" and DOES contain the failure copy. The captured verbatim string above is the regression anchor.

### `ADM-P1-002` — The platform Operations console asserts "nothing is currently open" when the incident read fails

| | |
| --- | --- |
| **Severity** | P1 |
| **Classification** | `UNAVAILABLE_SHOWN_AS_ZERO` |
| **Affected route(s)** | `/admin/operations` |
| **Roles / plans** | Platform Admin |
| **Endpoint / service** | GET /v1/admin/incidents (services/api/src/routes/admin-security.routes.ts:361) |
| **Source files** | `apps/web/app/(app)/admin/operations/page.tsx:185-207`<br>`apps/web/app/(app)/admin/operations/page.tsx:576-580`<br>`apps/web/app/(app)/admin/operations/page.tsx:586-593` |
| **Dependency** | Shares a root cause with ADM-P1-001 and ADM-P2-002; fix together. |
| **Blast radius** | One page. |

**Observed implementation.** The catch branch calls `addToast(...)` and then `setData(null)`. The table's EmptyState reads "No conditions match ... With the Status filter on Open, an empty table means nothing is currently open — not that nothing was measured." The sentence was written for a successful empty response and is rendered unchanged for a failed one. The ResultCount beneath it passes `cap` and `filtered` but not `failed`.

**Expected implementation.** The failure must be rendered where the table is, and the 'nothing is currently open' assertion must be suppressed whenever the read did not complete.

**Evidence.** RUNTIME-PROVEN (2026-09-08) against the sanctioned local admin fixture (API :8191, web :3311, disposable Postgres `pv-admincp-pg`, seeded by `services/api/scripts/seed-admin-fixture.ts`). The environment is built by `scripts/local-fixture-env/index.mjs`, which constructs the child environment from an allowlist and throws before spawn if any value resolves off this machine, so no Production endpoint or credential was reachable. No screenshots were taken. With `**/v1/admin/incidents*` aborted, /admin/operations renders, verbatim: "No conditions match — No operational condition matches the current filters. With the Status filter on Open, an empty table means nothing is currently open — not that nothing was measured." In the same render the Security-events section BELOW it returned real rows ("billing.overview_view · Admin audit · tenant_audit · success · INFO"), so a failed read and a successful one sit side by side with nothing on screen distinguishing them.

**Root cause.** Same as ADM-P1-001 — failure and emptiness share one representation.

**Risk.** Worse than a silent blank: the copy explicitly pre-empts the correct interpretation, telling the operator that the empty table is a measurement rather than a failure — and it does so while a neighbouring section renders live data, which makes the page look healthy.

**Recommended Phase-10 fix.** Introduce a failure state; render it in place of the table; pass `failed` to ResultCount; delete the 'not that nothing was measured' clause from the failure path only.

**Required acceptance proof.** A browser test stubbing GET /v1/admin/incidents to 500, asserting the "nothing is currently open" sentence is absent, a failure panel is present, and `ResultCount` receives `failed`.

### `ADM-P1-003` — The unversioned /admin/runtime/* family returns platform-global infrastructure state behind tenant-membership permissions

| | |
| --- | --- |
| **Severity** | P1 |
| **Classification** | `CONNECTED_WRONG_SCOPE` |
| **Affected route(s)** | `GET /admin/runtime/readiness`, `GET /admin/runtime/queues`, `GET /admin/runtime/workers`, `GET /admin/runtime/migrations`, `GET /admin/runtime/schema-status` |
| **Roles / plans** | Workspace VIEWER of any workspace — schema-status only (measured 200); Workspace OWNER/ADMIN/REVIEWER of any workspace, including a free personal one — all five (measured 200); Non-member passing another workspace's id — refused 404 (measured) |
| **Endpoint / service** | runReadinessCheck(prisma) / runMigrationDriftCheck(prisma) / runSchemaValidation() — none takes a teamId |
| **Source files** | `services/api/src/routes/runtime-readiness.routes.ts:33-64 (requireReadinessActor)`<br>`services/api/src/routes/runtime-readiness.routes.ts:93,131,172,212`<br>`services/api/src/routes/ops.routes.ts:795-833`<br>`services/api/src/routes/ops.routes.ts:245-251 (requireOpsActor -> operations.view)`<br>`services/api/src/runtime/runtime-readiness.ts:1-31`<br>`services/api/src/runtime/migration-drift.ts:1-46`<br>`packages/shared/src/permissions.ts:317-544` |
| **Dependency** | Requires the owner decision OWN-1. Touches apps/web/lib/useGlobalRuntimeState.ts (the shell polls readiness for every operational workspace). |
| **Blast radius** | 5 API routes, 1 shell poller, 2 runbooks, the operations-layout / capture-layout / evidence-detail-layout Playwright fixtures that intercept `**/admin/runtime/**`. |

**Observed implementation.** Every route in this family takes `teamId` only to select WHICH workspace membership authorises the call; it filters nothing. `runReadinessCheck(prisma)`, `runMigrationDriftCheck(prisma)` and `runSchemaValidation()` take no tenant argument. MEASURED against the fixture, per persona, with `teamId` set to a workspace the caller actually belongs to:

  • Workspace VIEWER (`read-only@fixture.local`, VIEWER of the populated workspace): readiness/queues/workers/migrations → 403 `permission_denied`; **schema-status → 200 (875 bytes)**, returning the platform schema posture across eight subsystems with `checked: 109` and a `failures[]` array.
  • Workspace ADMIN and organization OWNER: **200 on all five.**
  • FREE personal-plan user (`free-personal@fixture.local`), passing THEIR OWN personal workspace id: **200 on all five.** Passing a workspace they do not belong to correctly returns 404 (anti-enumeration holds).

What the free personal user receives: `migrations` (947 bytes) reports `diskCount: 267` vs `dbCount: 263` and NAMES the four unapplied migrations — `20280501000000_workspace_invite_lifecycle_hardening`, `20280503000000_collaboration_scale_indexes`, `20280510000000_enterprise_contract_collaboration_limits`, `20280511000000_collaboration_activity_keyset_index`. `readiness` (4,335 bytes) reports fourteen subsystems with reason codes and operator detail, including "S3 Object Lock is not enabled. Destruction / immutable retention guarantees…", "17 open WORKER incident(s) at HIGH/CRITICAL severity", "No reviewer reconciliation has been observed. Worker may not have started", "Metrics endpoint is open (network-firewalled)", "Sentry DSN configured", "At least one cron secret is configured", "Oldest pending media-intelligence run is 82h old" and "active_nodes=116, active_edges=47".

**Expected implementation.** Platform-global runtime state belongs behind requirePlatformAdmin (as /v1/ops/metrics and /v1/admin/platform/metrics already are), or the payload must be reduced to a tenant-safe projection before a tenant permission can unlock it.

**Evidence.** RUNTIME-PROVEN (2026-09-08) against the sanctioned local admin fixture (API :8191, web :3311, disposable Postgres `pv-admincp-pg`, seeded by `services/api/scripts/seed-admin-fixture.ts`). The environment is built by `scripts/local-fixture-env/index.mjs`, which constructs the child environment from an allowlist and throws before spawn if any value resolves off this machine, so no Production endpoint or credential was reachable. No screenshots were taken. Twenty probes (four personas × five routes) executed with real session tokens minted through POST /v1/auth/email/login. Status codes and payload sizes recorded above. Role→permission mapping read directly from packages/shared/src/permissions.ts:317-544: `audit.read` is held by OWNER, ADMIN and REVIEWER; `operations.view` is held by all five roles including VIEWER. `resolveRuntimeReadAccess` (apps/web/lib/platform-context/runtimeReadAccess.ts:155-160) states the position in the codebase's own words: "There is no tenant capability meaning 'may read runtime readiness' — the route is member-gated on `audit.read`". The client gate is a polling gate, not authorization.

**Root cause.** A Phase-28 operator-diagnostics family was authorised with the tenant primitive that happened to be nearest, and the paths were never versioned into the /v1/admin namespace where the platform gate lives.

**Risk.** Cross-tenant disclosure of deployment internals to the lowest-paying customer tier, measured rather than inferred: unreleased feature names via migration titles, a named security-control gap (Object Lock disabled), platform-wide incident counts, worker health and graph size. No secret VALUE is emitted — the module states this and the payloads confirm it — so this is a platform-internals disclosure, not a credential leak. A VIEWER's reach is narrower than the other four routes but still includes the platform schema posture.

**Recommended Phase-10 fix.** Decide the owner question below; then either (a) move the five routes to /v1/admin/runtime/* behind requirePlatformAdmin and repoint the shell's readiness poll at a tenant-safe projection, or (b) keep the paths and split each into a platform payload (platform-admin) and a bounded tenant payload. Update docs/runbooks/sre-runbooks.md and disaster-recovery.md, which instruct operators to call these paths.

**Required acceptance proof.** An API integration test asserting: a VIEWER is refused all five; a free personal OWNER is refused all five on their own workspace; a platform admin is not. The twenty measured status codes above are the before-state.

### `ADM-P2-001` — Five endpoints cited by shipped runbooks do not exist

| | |
| --- | --- |
| **Severity** | P2 |
| **Classification** | `OBSOLETE_ENDPOINT / MOCK_OR_PLACEHOLDER (documentation)` |
| **Affected route(s)** | `/admin/platform/runbooks`, `/admin/platform/runbooks/[slug]` |
| **Roles / plans** | Platform Admin; on-call operator |
| **Endpoint / service** | n/a — the cited endpoints are absent |
| **Source files** | `docs/runbooks/failed-report-generation.md:17`<br>`docs/runbooks/export-blocked.md:18`<br>`docs/runbooks/retention-precedence.md:51`<br>`docs/runbooks/audit-chain-drift.md:34`<br>`docs/runbooks/reviewer-escalation-storm.md:81`<br>`apps/web/lib/runbooks/catalog.generated.ts` |
| **Dependency** | The new check needs the route table; the existing scripts/ tooling already extracts it. |
| **Blast radius** | 5 markdown files, 1 generated catalog, 1 new gate. |

**Observed implementation.** The runbook catalog is generated from docs/runbooks/*.md and rendered verbatim at /admin/platform/runbooks/:slug. Checking every /v1 path it cites against the 1,137 registered API routes: 28 exist, 5 do not. (1) `GET /v1/admin/reports/:id` — no route matches `admin/reports` anywhere in the repository. (2) `GET /v1/governance/export/eligibility?evidenceId=` — the real route is `GET /v1/governance/export-eligibility` (hyphen, not a path segment) at governance-lifecycle.routes.ts:1003, and it additionally REQUIRES a `teamId` query parameter the runbook's curl omits, so the documented call would 400 even after the path is corrected. (3) `POST /v1/internal/governance/retention-reconciliation/run` — no HTTP trigger exists; retention reconciliation is a worker cron (services/worker/src/index.ts:1155, withCronLock). (4) `GET /v1/ops/audit/verify` — the real verifier is `GET /v1/admin/audit-log/verify` (admin-audit.routes.ts:408). (5) `POST /v1/reviewer-ops/policy` — the real route is `POST /v1/reviewer-ops/sla-policy` (reviewer-ops.routes.ts:1748).

**Expected implementation.** Every command a runbook gives an operator mid-incident must resolve. A generated catalog with a freshness gate over its markdown does not make its contents true.

**Evidence.** Machine check of every `/v1/...` literal extracted from apps/web/lib/runbooks/catalog.generated.ts against the extracted route table; repo-wide grep for each missing path across services/api, services/worker and packages returns no registration.

**Root cause.** The runbook freshness gate compares the markdown to the generated file. Nothing compares either to the route table.

**Risk.** An operator following the export-blocked or audit-chain-drift runbook during an incident spends the first minutes on a 404 and concludes the platform is broken in a second way.

**Recommended Phase-10 fix.** Correct the five citations; for (3) either state that reconciliation is cron-only and give the operator the real lever, or add the internal route the runbook assumes. Add a generator-time check that every `/v1/...` literal in docs/runbooks/*.md resolves against the route table, so the catalog cannot regress.

**Required acceptance proof.** The new gate runs green, and a deliberately-broken citation makes it fail.

### `ADM-P2-002` — Failed reads render as empty results across the read-only admin dashboards

| | |
| --- | --- |
| **Severity** | P2 |
| **Classification** | `UNAVAILABLE_SHOWN_AS_ZERO` |
| **Affected route(s)** | `/admin/executive`, `/admin/costs`, `/admin/adoption`, `/admin/customers`, `/admin/users`, `/admin/workspaces`, `/admin/timeline`, `/admin/dashboard` |
| **Roles / plans** | Platform Admin |
| **Endpoint / service** | GET /v1/admin/{executive,costs,adoption,analytics/dashboard,customers,users,workspaces,timeline} |
| **Source files** | `apps/web/app/(app)/admin/executive/page.tsx:246-259,524-533`<br>`apps/web/app/(app)/admin/costs/page.tsx:240-248,401-405`<br>`apps/web/app/(app)/admin/adoption/page.tsx:89-97,237-241`<br>`apps/web/app/(app)/admin/dashboard/page.tsx:545-549`<br>`apps/web/app/(app)/admin/customers/page.tsx:195,477-480`<br>`apps/web/app/(app)/admin/users/page.tsx:143-147,433-436`<br>`apps/web/app/(app)/admin/workspaces/page.tsx:126-131,394-397`<br>`apps/web/app/(app)/admin/timeline/page.tsx:168-176,382-385` |
| **Dependency** | Fix alongside ADM-P1-001 and ADM-P1-002 — same root cause, same mechanism. |
| **Blast radius** | 8 pages plus 35 ResultCount call sites. |

**Observed implementation.** Each page catches a load failure into a transient toast (some also `setData(null)`) and then renders an EmptyState whose copy asserts absence or blames the operator's filters. MEASURED, with each page's primary read aborted and the interception confirmed to have fired:

  • /admin/executive — "Executive dashboard not available. No aggregate was returned. Once revenue, customers, leads and usage records exist, the honest platform KPIs appear here."
  • /admin/costs — "No cost data. No cost aggregate was returned. Once provider usage events exist, estimated costs, per-provider breakdown, budgets and embeddings spend appear here."
  • /admin/adoption — "No adoption data. Feature adoption is derived from live records. Once workspaces configure capabilities and capture evidence, each capability's real counts appear here."
  • /admin/customers — "No customers yet. Customer organizations appear here once they exist. This roster is read-only and reflects live records."
  • /admin/users — "No people found. No platform user matches the current filters. Adjust the search or filters above."
  • /admin/workspaces — "No workspaces match. No workspace matches the current filters. Adjust the search or filters above…"
  • /admin/timeline — "No platform events. No platform-operational events match the current filters. As admin actions … are recorded, they appear here."

/admin/dashboard is included from source ("Analytics not connected … once product events are recorded for this window"); it hedges better than the rest but still asserts no events.

FOUR SURFACES WERE MEASURED AND ARE CORRECT, and they are the pattern to copy: /admin ("Overview unavailable. The platform overview could not be loaded. This is an honest not-connected state, not an empty platform."), /admin/billing ("Billing unavailable. The billing aggregate could not be loaded. This is a not-connected state, not an empty platform."), /admin/platform-health ("Could not load platform health … Retry") and /admin/evidence-ops ("Could not load the pipeline snapshot … Retry").

**Expected implementation.** The pattern already exists twice in the same surface — /admin/billing ("Billing unavailable ... This is a not-connected state, not an empty platform") and /admin/platform-health and /admin/evidence-ops (explicit `error` state rendered in place). Apply it.

**Evidence.** RUNTIME-PROVEN (2026-09-08) against the sanctioned local admin fixture (API :8191, web :3311, disposable Postgres `pv-admincp-pg`, seeded by `services/api/scripts/seed-admin-fixture.ts`). The environment is built by `scripts/local-fixture-env/index.mjs`, which constructs the child environment from an allowlist and throws before spawn if any value resolves off this machine, so no Production endpoint or credential was reachable. No screenshots were taken. Fourteen page loads with the primary read aborted, `interceptedRequests` asserted non-zero on each. Machine scan of the 46 admin .tsx files containing an EmptyState: 6 render a persistent error state. `ResultCount` was purpose-built with a `failed` prop whose docstring reads "Without it an errored list renders 'No records yet', which states there is nothing at the one moment the page cannot know" — of its 39 deduplicated admin call sites, 5 pass it.

CORRECTION TO AN EARLIER DRAFT OF THIS AUDIT: /admin/billing was first probed with the glob `**/v1/admin/billing*`, which cannot match `/v1/admin/billing/detail` because `*` does not cross a path separator. The page loaded normally and was briefly mis-recorded as defective. Re-probed with `**/v1/admin/billing/**` it renders the correct failure panel.

**Root cause.** One representation for two facts, and an available mechanism (ResultCount.failed) that was never adopted.

**Risk.** Every one of these pages tells an operator a factual thing about the platform that the page cannot know. On /admin/customers and /admin/workspaces it reads as customer loss.

**Recommended Phase-10 fix.** Add a failure state to each page; render it in place of the empty state; pass `failed` at all 40 ResultCount call sites. Consider a shared `useAdminRead` hook so a new page cannot omit it.

**Required acceptance proof.** A parameterised render test that stubs each page's primary GET to 500 and asserts the failure copy is present and the absence-claiming copy is not.

### `ADM-P2-003` — Media-graph console shows a "Run dismissed (operator)" counter for an action it does not offer

| | |
| --- | --- |
| **Severity** | P2 |
| **Classification** | `UI_MISSING` |
| **Affected route(s)** | `/admin/platform/media-graph` |
| **Roles / plans** | Platform Admin with PLATFORM_TELEMETRY_VIEW |
| **Endpoint / service** | POST /v1/ops/media-intelligence/runs/:runId/dismiss |
| **Source files** | `apps/web/app/(app)/admin/platform/media-graph/page.tsx:166-168`<br>`services/api/src/routes/ops.routes.ts:3212-3262`<br>`packages/shared-runtime/src/media-intelligence/run-tracker.service.ts:382-403` |
| **Dependency** | Best done with ADM-P2-005 (the run listing), which supplies both identifiers. |
| **Blast radius** | One page; no API change. |

**Observed implementation.** The console renders a tile labelled "Run dismissed (operator)" over the counter `media_intelligence_run_dismissed_total`. The only writer of that counter is `dismissRun`, whose only caller is `POST /v1/ops/media-intelligence/runs/:runId/dismiss`. That route has zero consumers anywhere in apps/web, apps/mobile or the worker. The page offers Retry and Replay DLQ and no dismiss control. The route's own comment records that the tile predated the route; the route shipped, the control did not.

**Expected implementation.** Either the console offers the dismiss action the tile counts, or the tile is removed.

**Evidence.** Repo-wide grep for `media-intelligence/runs` in apps/web returns only the `/retry` call at page.tsx:396. Backend registrations at ops.routes.ts:3180 (retry), 3240 (dismiss), 3265 (dlq/replay); the page consumes 2 of 3.

**Root cause.** The backend capability was completed without its operator surface, and the tile was left as the only evidence of the gap.

**Risk.** A run stuck in PENDING by an unshipped processor arm has no operator exit from the console; the platform's own runbook comment tells operations it can be 'dismissed manually', which is only true through a direct API call.

**Recommended Phase-10 fix.** Add a dismiss control. NOTE THE IDENTIFIER TRAP: `/retry` takes a BullMQ job id (`mi-<kind>-<evidenceId>`), `/dismiss` takes the `media_intelligence_runs` row UUID. They must not share the existing free-text input.

**Required acceptance proof.** A render test that exercises the dismiss control and asserts POST to the row-UUID path, plus an assertion that the retry input is not reused.

### `ADM-P2-004` — A 97-test Admin browser suite exists and is wired to no runner, in CI or out

| | |
| --- | --- |
| **Severity** | P2 |
| **Classification** | `TEST_ONLY / CONFIGURATION_DEFECT` |
| **Affected route(s)** | `all 47 /admin routes` |
| **Roles / plans** | Platform Admin |
| **Endpoint / service** | n/a |
| **Source files** | `apps/web/e2e/admin-control-plane/playwright.config.ts`<br>`apps/web/e2e/admin-control-plane/*.spec.ts (9 files, 3,460 lines)`<br>`apps/web/playwright.config.ts`<br>`playwright.config.ts`<br>`.github/workflows/playwright-e2e.yml:292-303`<br>`scripts/point7-run.mjs` |
| **Dependency** | ADM-P2-008 (the vacuous assertions) and ADM-P2-006 (the port collision). |
| **Blast radius** | One workflow; no product change. |

**Observed implementation.** THE PHASE-9 FIRST PASS SAID THE ADMIN PRODUCT HAD ONE BROWSER ASSERTION. THAT WAS WRONG, and the reason it was wrong is worth recording: the sweep was anchored on the root `playwright.config.ts`, and this suite has its own config in its own directory, so nothing that enumerated projects from the root ever saw it.

What actually exists: `apps/web/e2e/admin-control-plane/` — 9 spec files, 3,460 lines, 32 static `test()` declarations expanding to **97 runtime tests** (`--list`), with 132 `expect()` calls, plus its own `playwright.config.ts`. It covers a 47-route × role × width × direction matrix (`admin-matrix`), mutations end-to-end (`admin-mutations`), loading/error/filtered-empty/unauthorized/RTL states (`admin-states`), tab addressability, RTL-first-frame and skip-link (`admin-tabs-rtl-skiplink`), a single-value-per-visual-role token authority (`admin-token-authority`), audit-surface privacy (`phase5-audit-surfaces`) and information-architecture journeys (`phase6-admin-journeys`).

What runs it: nothing. No workflow, no `package.json` script, and no runner script invokes this config. The only references to it in the repository are two generator scripts that PRINT the command for a human to paste (`scripts/admin-ledger/contact-sheets.mjs:155`, `scripts/admin-ledger/visual-checklist.mjs:73`). Its config deliberately starts no servers, because it needs a migrated database and a seeded fixture; the two launchers are named in its docblock.

The root config's `chromium` project (255 tests) is the only Playwright project any CI workflow runs, and its Admin coverage is one assertion — `e2e/phase2-3-flows.spec.ts:110`, that `/admin/identity` returns 2xx.

**Expected implementation.** A suite that carries the acceptance evidence for a 47-page operator console is connected to something that runs it.

**Evidence.** `playwright test --list` per config, executed 2026-09-08: root config — chromium 255, point7 88, and the eight layout projects 390/109/97/148/264/26/46/89 = 1,169, total 1,512, which reconciles exactly with the Phase-8 accounting. `apps/web/e2e/admin-control-plane/playwright.config.ts` — 97 tests in 9 files. `apps/web/playwright.config.ts` — 101 tests in 10 files (its `testDir: "./e2e"` also collects the admin-control-plane subdirectory, so the 97 plus 4 Home acceptance tests). Repository-wide grep for the eight layout env flags and for `admin-control-plane` in workflows and package scripts: zero invocations.

**Root cause.** Each suite was added with its own config and its own prerequisites, and no runner was ever added for any of them. The admin suite additionally needs a seeded database, which is a real reason it was never wired to the default job — and not a reason to leave it unwired.

**Risk.** The acceptance evidence for the Admin product is not evidence of anything currently true. Both P1 defects in this report sit inside surfaces this suite nominally covers, and one of them is covered by an assertion that cannot fail (see ADM-P2-008). A suite nobody runs also cannot rot visibly: nothing tells you when it stops matching the product.

**Recommended Phase-10 fix.** Give the admin-control-plane suite a scheduled workflow that brings up the fixture stack (the two launchers already exist and are already safe by construction), starting with `admin-states`, `admin-mutations` and `phase5-audit-surfaces`. Fix ADM-P2-008 first, or the suite will run green over the P1s. Owner decision OWN-4 covers the eight layout projects separately.

**Required acceptance proof.** A CI run that reports 97 Admin tests executed, and that fails when GET /v1/admin/alerts is stubbed to 500.

### `ADM-P2-005` — The media-graph retry control requires an identifier the console cannot produce

| | |
| --- | --- |
| **Severity** | P2 |
| **Classification** | `CONNECTED_INCOMPLETE` |
| **Affected route(s)** | `/admin/platform/media-graph` |
| **Roles / plans** | Platform Admin with PLATFORM_TELEMETRY_VIEW |
| **Endpoint / service** | POST /v1/ops/media-intelligence/runs/:runId/retry |
| **Source files** | `apps/web/app/(app)/admin/platform/media-graph/page.tsx:375-382,530-540` |
| **Dependency** | Pairs with ADM-P2-003. |
| **Blast radius** | One page; may need a listing endpoint if none projects run rows. |

**Observed implementation.** The only way to retry a failed media-intelligence job is to type its id into a free-text field whose validation message is "Provide a job id (deterministic mi-<kind>-<evidenceId> form)." The page renders counters for failed runs and DLQ depth but lists no run, so the operator must reconstruct the id from an evidence id obtained elsewhere, or read it from logs.

**Expected implementation.** An action that names a record needs a way to choose that record.

**Evidence.** The page's endpoint set is {/v1/admin/platform/metrics, .../retry, .../dlq/replay}; no listing endpoint is consumed. `GET /v1/operations/queues/:queueName/failed` exists and is consumed only by /admin/platform/queues.

**Root cause.** The console was built as a metrics projection and grew two mutations without a record surface.

**Risk.** The remediation path exists and is unusable without out-of-band information, which is the state the runbooks assume is not the case.

**Recommended Phase-10 fix.** Render the failed/pending runs (or link the queues console filtered to the media-intelligence queue) and drive both retry and dismiss from the row.

**Required acceptance proof.** A render test that selects a listed run and asserts the POST carries that run's identifier.

### `ADM-P2-006` — Two Playwright layout projects declare the same port, contradicting the config's own stated invariant

| | |
| --- | --- |
| **Severity** | P2 |
| **Classification** | `CONFIGURATION_DEFECT` |
| **Affected route(s)** | `n/a (test infrastructure)` |
| **Roles / plans** | n/a |
| **Endpoint / service** | n/a |
| **Source files** | `playwright.config.ts:42,50` |
| **Dependency** | Blocks ADM-P2-004. |
| **Blast radius** | One constant. |

**Observed implementation.** `EVIDENCE_LAYOUT_PORT = 3013` and `ATTENTION_LAYOUT_PORT = 3013`. The comment above the second reads "serves its own production build here, on its own port, for the same reason the three projects above do", and the first reads "on its own port, for the same reason the two projects above do". Both webServer entries use `reuseExistingServer: true`, so with both flags set one server is started and the other silently reuses it.

**Expected implementation.** Distinct ports, as the config states.

**Evidence.** Direct read of playwright.config.ts.

**Root cause.** Copy of the constant without incrementing it.

**Risk.** Blocks running the two projects together, and makes any per-project server configuration divergence silently ineffective. It is also a live counter-example to the config's stated design rule.

**Recommended Phase-10 fix.** Give attention-layout its own port (3018 is free).

**Required acceptance proof.** Both projects enabled in one invocation, both serving.

### `ADM-P2-007` — The manual audit-entry endpoint has no console control and labels its entries as coming from one

| | |
| --- | --- |
| **Severity** | P2 |
| **Classification** | `UI_MISSING / MISLEADING_SCOPE` |
| **Affected route(s)** | `/admin/audit` |
| **Roles / plans** | Platform Admin |
| **Endpoint / service** | POST /v1/admin/audit-log |
| **Source files** | `services/api/src/routes/admin-audit.routes.ts:108-200`<br>`apps/web/app/(app)/admin/audit/page.tsx` |
| **Dependency** | None. |
| **Blast radius** | One default value, or one new control. |

**Observed implementation.** `POST /v1/admin/audit-log` writes a manual platform-audit entry through the canonical `emitAdminManualAudit` facade, defaulting `source` to the string `"admin_console"`. It has zero consumers in apps/web, apps/mobile, the worker or e2e. The Admin activity page consumes only the GET listing, the export and the verify legs.

**Expected implementation.** Either the console offers the manual-entry control the default source names, or the default is corrected and the endpoint is documented as API-only.

**Evidence.** Repo-wide consumer scan of the 149 admin-prefixed API routes; this is one of the routes with no web consumer.

**Root cause.** A capability shipped with a UI-shaped default and no UI.

**Risk.** Rows in the platform audit chain claim an origin surface that cannot have produced them, which is a defect in the record an auditor reads.

**Recommended Phase-10 fix.** Owner decision OWN-5. If API-only, change the default source to something truthful (e.g. `admin_api`) and say so in the route contract.

**Required acceptance proof.** An API test asserting the recorded source for a call that supplies none.

### `ADM-P3-001` — continueGuest survives in seven locales with zero consumers

| | |
| --- | --- |
| **Severity** | P3 |
| **Classification** | `LEGACY_DELETE` |
| **Affected route(s)** | `n/a` |
| **Roles / plans** | n/a |
| **Endpoint / service** | n/a |
| **Source files** | `packages/shared/src/i18n.ts:46,91,136,182,228,274,320` |
| **Dependency** | None. |
| **Blast radius** | One file. |

**Observed implementation.** Seven locale definitions carry `continueGuest`. A repo-wide search across every .ts, .tsx and .md file excluding i18n.ts itself returns zero references, and no Guest Auth surface remains (`guestAuth`, `GuestAuth`, 'continue as guest' all return nothing).

**Expected implementation.** Deleted.

**Evidence.** Verified on the audited SHA as the Phase-8 brief required.

**Root cause.** Guest Auth was removed; its strings were not.

**Risk.** A translator maintains a string for a feature that does not exist.

**Recommended Phase-10 fix.** Delete the seven entries and the key from the type.

**Required acceptance proof.** The key is absent and the i18n type check passes.

### `ADM-P3-002` — The /admin/identity/ contextual-route entry is now unreachable

| | |
| --- | --- |
| **Severity** | P3 |
| **Classification** | `DEAD_LEGACY` |
| **Affected route(s)** | `/admin/identity/*` |
| **Roles / plans** | Platform Admin |
| **Endpoint / service** | n/a |
| **Source files** | `apps/web/components/admin/adminNavigation.ts:588-594` |
| **Dependency** | None. |
| **Blast radius** | One registry entry. |

**Observed implementation.** `ADMIN_CONTEXTUAL_ROUTES` contains a `/admin/identity/` prefix rule. All seven paths beneath `/admin/identity/` are registered nav children with exact hrefs, so `resolveAdminLocation` always finds `best.child.href === pathname` and `isDetail` is `Boolean(contextual) && pathname !== best.child.href` — always false. No path can reach the rule.

**Expected implementation.** A registry entry that cannot fire is deleted, or a test pins the path that needs it.

**Evidence.** The seven filesystem pages under app/(app)/admin/identity/ are exactly the seven registered children; there is no eighth.

**Root cause.** The rule was needed when the seven children were not in the nav; promoting them made it dead.

**Risk.** None operationally; it is one more thing a reader must reason about.

**Recommended Phase-10 fix.** Delete the entry, or add a test asserting the invariant that made it dead.

**Required acceptance proof.** The nav/breadcrumb tests stay green with the entry removed.

### `ADM-P3-003` — adminNavigation.ts documents nine sections and defines eight

| | |
| --- | --- |
| **Severity** | P3 |
| **Classification** | `DEAD_LEGACY (documentation)` |
| **Affected route(s)** | `all /admin` |
| **Roles / plans** | n/a |
| **Endpoint / service** | n/a |
| **Source files** | `apps/web/components/admin/adminNavigation.ts:22,27,87` |
| **Dependency** | None. |
| **Blast radius** | Comments plus one test. |

**Observed implementation.** "Nine primary sections now", "the page shows nine choices, not thirty-seven", and "Nine sections. The number is deliberate and the ceiling is nine". The array defines eight: overview, customers, evidence, identity, security, platform, runbooks, insight.

**Expected implementation.** The count in the file matches the array, and the stated ceiling is enforced by a test rather than a comment.

**Evidence.** Eight `id:` entries at the section indent level (lines 92, 112, 170, 228, 315, 391, 474, 496).

**Root cause.** A section was merged or removed without updating the prose.

**Risk.** The file's own description of the information architecture is wrong by one, and the stated ceiling is unenforced.

**Recommended Phase-10 fix.** Correct the prose; add an assertion that ADMIN_NAV_SECTIONS.length <= 9.

**Required acceptance proof.** The new assertion passes.

### `ADM-P3-004` — The nav registry claims a mobile-drawer consumer that the CSS documents rejecting

| | |
| --- | --- |
| **Severity** | P3 |
| **Classification** | `DEAD_LEGACY (documentation)` |
| **Affected route(s)** | `all /admin` |
| **Roles / plans** | Platform Admin on a phone |
| **Endpoint / service** | n/a |
| **Source files** | `apps/web/components/admin/adminNavigation.ts:7`<br>`apps/web/components/admin/admin-console.css:214-244` |
| **Dependency** | None. |
| **Blast radius** | One comment. |

**Observed implementation.** adminNavigation.ts names five consumers including "the mobile drawer". No drawer consumes it: AdminConsoleNav renders one primary row and one secondary row at every width, and admin-console.css turns both into horizontal scrollers under 60rem with the comment "the alternative to THAT is a hamburger with a second copy of the list in it, which is the drift this registry exists to prevent".

**Expected implementation.** The stated consumer list matches reality.

**Evidence.** grep for drawer in components/admin returns the adm-drawer overlay primitive in AdminSurfaces.tsx, which is a detail overlay, not navigation.

**Root cause.** Prose written against a plan that was deliberately not taken.

**Risk.** A reader looks for a consumer that does not exist.

**Recommended Phase-10 fix.** Correct the consumer list to four.

**Required acceptance proof.** n/a — documentation.

### `ADM-P3-005` — /v1/admin/organizations and /v1/admin/organizations/:id are consumer-free compatibility aliases

| | |
| --- | --- |
| **Severity** | P3 |
| **Classification** | `DUPLICATE_ENDPOINT` |
| **Affected route(s)** | `/admin/customers`, `/admin/customers/[id]` |
| **Roles / plans** | Platform Admin |
| **Endpoint / service** | GET /v1/admin/organizations, GET /v1/admin/organizations/:id |
| **Source files** | `services/api/src/routes/admin-organizations.routes.ts:92-160` |
| **Dependency** | OWN-3. |
| **Blast radius** | Two registrations, one comment. |

**Observed implementation.** Both are registered as byte-identical aliases of /v1/admin/customers and /v1/admin/customers/:id, with the stated reason "Retained so this remediation does not break a consumer mid-flight; the web console now calls /v1/admin/customers". A repo-wide consumer scan finds the alias paths referenced only in a comment at apps/web/app/(app)/admin/customers/page.tsx:9.

**Expected implementation.** The alias is removed once the mid-flight window has closed, or its retention is recorded as a public-API commitment.

**Evidence.** Consumer scan across apps/web, apps/mobile, services/worker and e2e.

**Root cause.** A rename left its bridge in place.

**Risk.** Two registered paths for one authority; the comment at customers/page.tsx:9 still names the retired one, so a future reader is pointed at the alias.

**Recommended Phase-10 fix.** Owner decision OWN-3 on external consumers, then remove both aliases and correct the stale comment.

**Required acceptance proof.** An API test asserting 404 on the alias paths.

### `ADM-P3-006` — /v1/ops/metrics duplicates /v1/admin/platform/metrics and has no product consumer

| | |
| --- | --- |
| **Severity** | P3 |
| **Classification** | `DUPLICATE_ENDPOINT` |
| **Affected route(s)** | `/admin/platform/media-graph`, `/admin/platform/observability` |
| **Roles / plans** | Platform Admin |
| **Endpoint / service** | GET /v1/ops/metrics vs GET /v1/admin/platform/metrics |
| **Source files** | `services/api/src/routes/ops.routes.ts:640`<br>`services/api/src/routes/admin-platform-telemetry.routes.ts:57`<br>`apps/web/app/(app)/admin/platform/media-graph/page.tsx:59,321`<br>`apps/web/app/(app)/admin/platform/observability/page.tsx:22` |
| **Dependency** | Runbook edits pair with ADM-P2-001. |
| **Blast radius** | One route, six runbooks. |

**Observed implementation.** Both are requirePlatformAdmin and both project the same in-process metrics snapshot. Both admin consoles migrated to /v1/admin/platform/metrics; the only remaining references to /v1/ops/metrics in apps/web are the migration comments that record the move. Six runbooks still instruct operators to read /v1/ops/metrics.

**Expected implementation.** One authority.

**Evidence.** Consumer scan; runbook citation check (the path resolves, so it is not part of ADM-P2-001).

**Root cause.** A namespace migration that retained the old path for the runbooks.

**Risk.** Low. Two paths that must stay in agreement, and only one is exercised by the product.

**Recommended Phase-10 fix.** Retire /v1/ops/metrics and repoint the six runbooks, or record it as the operator-CLI authority and say so in both route files.

**Required acceptance proof.** Whichever path survives is the only one registered, and the runbook endpoint gate passes.

### `ADM-P3-007` — PageRouteGate's docblock contradicts its PLATFORM_ADMIN_ONLY behaviour

| | |
| --- | --- |
| **Severity** | P3 |
| **Classification** | `DEAD_LEGACY (documentation)` |
| **Affected route(s)** | `all gated routes, including all 47 /admin` |
| **Roles / plans** | every non-platform-admin |
| **Endpoint / service** | n/a |
| **Source files** | `apps/web/components/navigation/PageRouteGate.tsx:14,111-121` |
| **Dependency** | None. |
| **Blast radius** | One comment. |

**Observed implementation.** The header states "PLATFORM_ADMIN_ONLY → renders nothing (matches sidebar hide)" and "NEVER renders a blank page" in the same block. The code renders a structured 'Platform administration only' denial panel, which the inline PRODUCTION FIX comment explains and justifies.

**Expected implementation.** The header describes the shipped behaviour.

**Evidence.** Direct read.

**Root cause.** The fix updated the code and the inline comment, not the header.

**Risk.** A reader deciding whether a direct URL discloses route existence gets the wrong answer from the summary. (The disclosure itself is a deliberate, documented trade-off, not a defect.)

**Recommended Phase-10 fix.** Correct the header line.

**Required acceptance proof.** n/a.

### `ADM-P3-008` — The schema-status route documents a gate it does not use

| | |
| --- | --- |
| **Severity** | P3 |
| **Classification** | `DEAD_LEGACY (documentation)` |
| **Affected route(s)** | `GET /admin/runtime/schema-status` |
| **Roles / plans** | every workspace role |
| **Endpoint / service** | GET /admin/runtime/schema-status |
| **Source files** | `services/api/src/routes/ops.routes.ts:792-800,245-251` |
| **Dependency** | ADM-P1-003. |
| **Blast radius** | One comment. |

**Observed implementation.** The comment reads "Authenticated like the other /v1/ops/* operator endpoints — same teamId/identity.member.read gate." The handler calls `requireOpsActor`, which is `requireOpsCapability(..., "operations.view")`. `operations.view` is held by every role including VIEWER; `identity.member.read` is not held by CONTRIBUTOR.

**Expected implementation.** The comment names the actual permission.

**Evidence.** requireOpsActor at ops.routes.ts:245-251; role table at packages/shared/src/permissions.ts.

**Root cause.** The gate was changed and the comment was not.

**Risk.** It understates the audience by one role, which is exactly the discrepancy ADM-P1-003 turns on.

**Recommended Phase-10 fix.** Correct the comment as part of ADM-P1-003.

**Required acceptance proof.** n/a.

### `ADM-P3-009` — The complete-list allowlist is cited at a path that does not exist, and one of its four declared lists bypasses the component that carries the claim

| | |
| --- | --- |
| **Severity** | P3 |
| **Classification** | `PARTIAL_NOT_DISCLOSED` |
| **Affected route(s)** | `/admin/platform/automation`, `/admin/adoption`, `/admin/identity`, `/admin/identity/permission-matrix` |
| **Roles / plans** | Platform Admin |
| **Endpoint / service** | GET /v1/automation/rules |
| **Source files** | `apps/web/components/ui/ResultCount.tsx:77-79`<br>`apps/web/app/(app)/admin/adoption/page.tsx:246`<br>`apps/web/app/(app)/admin/identity/permission-matrix/page.tsx:734`<br>`apps/web/app/(app)/admin/identity/_sections/MembersSection.tsx:653`<br>`apps/web/app/(app)/admin/platform/automation/page.tsx:281`<br>`apps/web/scripts/admin-complete-lists.mjs:45-53` |
| **Dependency** | None. |
| **Blast radius** | Four comments plus one count. |

**Observed implementation.** Four call sites cite `scripts/admin-complete-lists.mjs`. The file is at `apps/web/scripts/admin-complete-lists.mjs`; the cited path does not exist from the repository root. Separately: the allowlist declares four complete lists; three of them (adoption, permission-matrix, identity members) pass `complete` to ResultCount, and the fourth — the automation RULES list — renders its count as a bare `{envelope.rules.length} rule{s}` template at automation/page.tsx:281, outside ResultCount. It is truthful (the handler has no take, and an API test asserts it) but it cannot state completeness and cannot state failure.

**Expected implementation.** The cited path resolves, and every declared-complete list states its completeness through the one component built to do so.

**Evidence.** Direct file check for both paths; ResultCount prop adoption measured across all 40 admin call sites (complete: 3, failed: 5, cap: 23, total: 8, hasMore: 18).

**Root cause.** A path written relative to the wrong root, and one list that predates the component.

**Risk.** Low. A reader chasing the allowlist does not find it, and one complete list reads as possibly capped.

**Recommended Phase-10 fix.** Correct the path in all four citations; move the automation rules count onto ResultCount with `complete`.

**Required acceptance proof.** The existing allowlist test still passes and admin-composition-contract.mjs sees the fourth site.

### `ADM-P3-010` — Executive tile sub-lines coerce an unmeasured figure to a literal zero

| | |
| --- | --- |
| **Severity** | P3 |
| **Classification** | `UNAVAILABLE_SHOWN_AS_ZERO (latent)` |
| **Affected route(s)** | `/admin/executive` |
| **Roles / plans** | Platform Admin |
| **Endpoint / service** | GET /v1/admin/executive |
| **Source files** | `apps/web/app/(app)/admin/executive/page.tsx:139-146,284,316,333,375` |
| **Dependency** | None. |
| **Blast radius** | Five template strings. |

**Observed implementation.** `formatCount` returns `null` for a null or NaN input, which the tile VALUE renders honestly as "Not measured". Five supporting sub-lines then write `${formatCount(x) ?? 0}`, so a null renders as the character `0`: "0 successful payments", "0 live workspaces billing ACTIVE", "0 demo · 0 contact-sales", `momSub`'s "0 this month · 0 last month", and — the one that matters — "0 hash-mismatch · 0 verification FAILED" on the Failed operations tile.

**Expected implementation.** The sub-line obeys the same contract as the value it supports: the page's own comment says the tile "renders an honest 'Not measured' ... Never estimates."

**Evidence.** The service types these fields as non-nullable `number` (services/api/src/services/admin/executive.service.ts:124-176), so no CURRENT response reaches the branch. It fires on a field absent from the payload — a deployment skew between web and API, which is the condition under which an operator is most likely to be reading this page.

**Root cause.** Defensive coalescing chose the wrong default for a page whose contract forbids estimating.

**Risk.** Latent, not live. Its worst instance would print a fabricated all-clear on evidence hash-mismatch and verification-failure counts.

**Recommended Phase-10 fix.** Replace `?? 0` with `?? "—"` in the five sub-lines.

**Required acceptance proof.** A render test feeding a payload with the field absent, asserting the sub-line shows an em dash.

### `ADM-P3-011` — The route registry describes itself as the source of truth for route existence while 77 of 209 pages are unregistered

| | |
| --- | --- |
| **Severity** | P3 |
| **Classification** | `CONFIGURATION_DEFECT` |
| **Affected route(s)** | `77 pages, including 6 /evidence-lifecycle/*, 5 /governance-platform/*, /security-center/sso/health, /security-center/sso/mapping, /settings/security/saml` |
| **Roles / plans** | all |
| **Endpoint / service** | n/a |
| **Source files** | `apps/web/lib/navigation/routeRegistry.ts:1-25` |
| **Dependency** | None. |
| **Blast radius** | Registry entries plus one test. |

**Observed implementation.** The header states the registry is "the SOURCE OF TRUTH for ... route existence". 143 entries cover 132 of the 209 filesystem pages. The unregistered remainder is mostly public marketing and token-bearing detail routes, which is defensible, but it also includes authenticated product children — the six /evidence-lifecycle sub-pages, five /governance-platform sub-pages, two /security-center/sso pages and /settings/security/saml. PageRouteGate's own fallback for an unknown id is to render children UNPROTECTED with a development-only console warning.

**Expected implementation.** Either every authenticated page is registered, or the header states the actual scope of the registry.

**Evidence.** Machine diff of filesystem page URLs against registry hrefs (both param conventions handled).

**Root cause.** Incremental migration, with an intentionally permissive gate fallback.

**Risk.** Low today — each of those pages gates on an ancestor's routeId — but the combination of 'unregistered id renders unprotected' and 'unregistered pages exist' is the shape a future page will fall into.

**Recommended Phase-10 fix.** Register the 14 authenticated children named above, or narrow the header's claim and add a test that every page under app/(app) is registered.

**Required acceptance proof.** The new test passes.

### `ADM-P2-008` — The two Admin assertions written to catch a false all-clear cannot fail

| | |
| --- | --- |
| **Severity** | P2 |
| **Classification** | `TEST_ONLY / UNFINISHED_PRODUCT` |
| **Affected route(s)** | `/admin/operations`, `/admin`, `/admin/audit`, `and the six other state-matrix families` |
| **Roles / plans** | Platform Admin |
| **Endpoint / service** | n/a (test integrity) |
| **Source files** | `apps/web/e2e/admin-control-plane/admin-states.spec.ts:216-223`<br>`apps/web/e2e/admin-control-plane/phase5-audit-surfaces.spec.ts:262-279` |
| **Dependency** | Blocks ADM-P2-004 — wire the suite only after these two assertions are real. |
| **Blast radius** | Two assertions in two spec files. No product change. |

**Observed implementation.** `admin-states.spec.ts` drives eight layout families through an aborted primary read and asserts, on the rendered `main`:

    expect(errorText.toLowerCase()).not.toContain("all clear");

The string "all clear" appears nowhere in any rendered admin copy. Every occurrence of "all clear" / "all-clear" in the admin tree is inside a source COMMENT (identity/runtime, platform/observability, platform/queues, platform-health), and `innerText()` returns rendered text only. The assertion is therefore structurally incapable of failing — including on /admin/operations, which IS one of the eight families, and whose aborted-read render is the P1 in ADM-P1-002.

`phase5-audit-surfaces.spec.ts` has a test named "filters run on the server and an empty result is distinguishable from an error" whose comment states the intent exactly — "The page must say the filter matched nothing, not that there are no audit records at all". Its only assertion is `expect(body.length).toBeGreaterThan(200)`, and the whole block sits inside `if ((await search.count()) > 0)`, so it also no-ops silently if the search input is not found.

**Expected implementation.** An assertion about a false all-clear names the copy the product actually emits, or asserts positively that a failure state IS present.

**Evidence.** Repository grep for "all clear"/"all-clear" across app/(app)/admin and components/admin: 5 hits, all inside comments, 0 in rendered copy. Confirmed at runtime: the aborted-read render of /admin/operations captured in ADM-P1-002 returns `containsAllClearLiteral: false` while containing the sentence "an empty table means nothing is currently open — not that nothing was measured".

**Root cause.** The assertion was written against a phrase the author had in mind for the defect class rather than against the phrase the product ships. It is the same failure mode as the historical `/try proovra/i` surface-tier assertion that Phase 8 recorded — and that one has since been repaired, while these two were not looked at.

**Risk.** It is worse than no assertion: the suite reports that the false-all-clear class is covered. Had this suite been wired to CI unchanged, it would have run green over both P1 findings in this report.

**Recommended Phase-10 fix.** Replace the negative literal with a positive assertion that the failure state is on screen — for each family, assert the presence of that page's failure copy and the ABSENCE of its empty-state copy. Give `phase5`'s empty-vs-error test a real assertion and remove the silent `if` guard, or delete the test rather than let its name stand for coverage.

**Required acceptance proof.** The repaired assertions FAIL against the current product on /admin/alerts and /admin/operations, and pass once ADM-P1-001 and ADM-P1-002 are fixed.

### `ADM-P3-012` — Raw database enum values and one capability key are shown to operators

| | |
| --- | --- |
| **Severity** | P3 |
| **Classification** | `MISLEADING_SCOPE (copy)` |
| **Affected route(s)** | `/admin/evidence-ops`, `/admin/executive`, `/admin/platform/analytics` |
| **Roles / plans** | Platform Admin |
| **Endpoint / service** | n/a (copy) |
| **Source files** | `apps/web/app/(app)/admin/evidence-ops/page.tsx`<br>`apps/web/app/(app)/admin/executive/page.tsx`<br>`apps/web/app/(app)/admin/platform/analytics/page.tsx` |
| **Dependency** | None. |
| **Blast radius** | Nine strings. |

**Observed implementation.** Across the 1,215 deduplicated user-facing text units in the Admin surface, 43 distinct all-caps tokens appear. Thirty-four are legitimate acronyms or currency codes (SSO, SCIM, MFA, UTM, UUID, EUR, USD, RFC, PEM, JIT…). Nine are raw values from the data model or the capability catalogue, rendered to an operator as-is: `FAILED`, `SIGNED`, `REPORTED`, `UPLOADING`, `PARTIAL`, `STALLED`, `FAILED_HASH_MISMATCH` (all on /admin/evidence-ops, e.g. "Sessions currently UPLOADING or PARTIAL." and "Evidence in the FAILED_HASH_MISMATCH terminal state."), `PAST_DUE` (/admin/executive, "No team currently matches the at-risk rule (PAST_DUE billing, unresolved…") and `ANALYTICS_VIEW` (/admin/platform/analytics, "Operational analytics require the ANALYTICS_VIEW capability").

**Expected implementation.** The route registry states the rule for the Tools surface — "No raw capability codes shown to operators. Reasons come from the access resolver's bounded `reason` field" — and the same standard should hold in the console. Lifecycle states have operator-facing names elsewhere in the product.

**Evidence.** Machine extraction of all user-facing text props and heading children across the 47 routes, with source comments stripped before matching, then filtered against a 34-entry acronym allowlist.

**Root cause.** Copy written from the column name rather than from the operator's vocabulary.

**Risk.** Low. An operator can infer most of them, and `FAILED_HASH_MISMATCH` is arguably clearer than a paraphrase. `ANALYTICS_VIEW` is the one that breaks a stated rule.

**Recommended Phase-10 fix.** Replace `ANALYTICS_VIEW` with the bounded denial reason. For the evidence-ops states, either keep the enum and gloss it once per section, or use the operator-facing labels the lifecycle vocabulary already defines.

**Required acceptance proof.** The honesty/copy contract test covers the capability-key case.

---

## Owner decisions (full)

### OWN-1 — Should a tenant be able to read PROOVRA's platform runtime readiness, migration inventory and schema-drift detail at all?

**Current behaviour.** GET /admin/runtime/{readiness,queues,workers,migrations} are unlocked by `audit.read` (OWNER/ADMIN/REVIEWER of any workspace, including a self-registered free personal one). GET /admin/runtime/schema-status is unlocked by `operations.view`, which every role holds including VIEWER. None of the five filters by teamId; all five return platform-global state.

**Options.**

- A — Platform-only: move all five to /v1/admin/runtime/* behind requirePlatformAdmin, and give the app shell a bounded tenant-safe readiness projection for its severity pill.
- B — Split payload: keep the paths, return a reduced tenant projection (overall status only) to tenant permissions and the full report to platform admins.
- C — Accept as-is and document it as an intentional transparency posture.

**Trade-offs.** A is the cleanest boundary and the largest change: the shell poller, three Playwright fixture interceptors and two runbooks move with it. B keeps every caller working and adds a second projection to maintain. C leaves deployment internals — including which migrations are unapplied and which schema objects are missing — readable by anyone who can create an account.

**Recommended for PROOVRA.** A. The payload is deployment state, not tenant state, and the shell needs only a status enum to colour a pill.

**The exact question you must answer.** Do you accept that platform runtime readiness, migration names and schema-drift detail become platform-admin-only, with the app shell reduced to an overall status enum?

### OWN-2 — Should a support-access grant into a customer organization be mintable without a customer-side approver?

**Current behaviour.** POST /v1/support-access/start requires platform staff plus identity.org_policy.manage, and VERIFIES `approvedByUserId` against ORG_ADMIN of the target organization when supplied — but the field is optional, and neither /start nor /enter requires step-up. POST /v1/break-glass/activate, by contrast, does require step-up.

**Options.**

- A — Require a verified customer approver on every support grant.
- B — Keep it optional and require step-up on /start and /enter instead.
- C — Keep as-is; the platform-staff gate plus the audit trail is the control.

**Trade-offs.** A is the strongest customer-trust posture and blocks support during a customer-side outage. B raises the bar on the staff side without needing the customer present. C is the status quo and the weakest gate of the three on the highest-consequence operator action in the product.

**Recommended for PROOVRA.** B, plus A as a policy default that support can document an exception to. Entering a customer tenant should be at least as gated as activating break-glass.

**The exact question you must answer.** Do you want step-up on /v1/support-access/start and /enter, a mandatory customer approver, or both?

### OWN-3 — Can the /v1/admin/organizations and /v1/admin/organizations/:id compatibility aliases be removed?

**Current behaviour.** Both are byte-identical aliases of /v1/admin/customers* retained for mid-flight consumers. A repo-wide scan finds no consumer in web, mobile, worker or e2e.

**Options.**

- A — Remove both.
- B — Retain and document as a public-API commitment.

**Trade-offs.** This audit can only see this repository. If any external integration or internal script outside it calls the alias, removal breaks it.

**Recommended for PROOVRA.** A, after you confirm no consumer exists outside this repository.

**The exact question you must answer.** Does anything outside this repository call GET /v1/admin/organizations?

### OWN-4 — What is the disposition of the eight dormant Playwright layout projects (562 test declarations, no runner)?

**Current behaviour.** attention, billing, capture, evidence-detail, intake-links, operations, search and settings each declare a project, an env flag and their own next start webServer. No workflow, package script or repo file sets any of the eight flags. None of them covers Admin.

**Options.**

- A — Give them a scheduled workflow (they are geometry/RTL/a11y gates that jsdom cannot answer).
- B — Consolidate into one layout project with a per-directory matrix and one server.
- C — Delete the projects that duplicate Phase-7 source assertions and keep the rest as documented manual gates.

**Trade-offs.** A costs CI minutes and needs the port collision fixed first. B is the least duplicated but a real refactor. C loses real coverage of properties no other gate measures.

**Recommended for PROOVRA.** B, on a nightly schedule, after fixing the port collision — and add Admin to it, which is the coverage this phase found missing.

**The exact question you must answer.** Do you want the eight layout projects consolidated and scheduled, or retired?

### OWN-5 — Should POST /v1/admin/audit-log (manual platform-audit entry) have an operator control?

**Current behaviour.** The endpoint exists, is platform-admin gated and rate-limited, routes through the canonical audit facade, defaults `source` to "admin_console", and has no consumer anywhere.

**Options.**

- A — Add a manual-entry control to /admin/audit.
- B — Keep it API-only and change the default source to something truthful.
- C — Retire it.

**Trade-offs.** A gives operators a way to record an out-of-band action in the chain. B is one line. C removes a capability whose absence nobody has reported.

**Recommended for PROOVRA.** B now (the default source is currently a false statement in the audit record), and A only if operators ask for it.

**The exact question you must answer.** Is manual audit entry an operator capability you want in the console, or an API-only affordance?

---

## Runtime verification

Four dimensions were measured. `RUNTIME_NOT_PROVEN = 0`.

**Fixture.** API :8191 and web :3311 against the disposable Postgres `pv-admincp-pg` (55533) and Redis `pv-admincp-redis` (56479), with personas seeded by `services/api/scripts/seed-admin-fixture.ts`. **Safety is structural, not procedural:** `scripts/local-fixture-env/index.mjs` builds the child environment from an allowlist rather than inheriting one, then runs `findEnvironmentLeaks` and throws *before spawn* if any value resolves off this machine; `services/api/src/db.ts` carries no `dotenv` import; and the pinned audit worktree contains no `.env` at all. **No screenshots were taken.**

| Dimension | Method | Result |
| --- | --- | --- |
| Failure-state rendering | 14 page loads with the primary read aborted (`connectionrefused`), interception asserted to have fired | 10 surfaces assert absence on a failed read; 4 (`/admin`, `/admin/billing`, `/admin/platform-health`, `/admin/evidence-ops`) render a correct failure panel. Verbatim strings captured in the JSON. |
| Low-privilege reachability | 20 probes — 4 personas × 5 `/admin/runtime/*` routes — with real tokens from `POST /v1/auth/email/login` | VIEWER: 403/403/403/403/**200**. Workspace ADMIN and org OWNER: **200 × 5**. Free personal owner, own workspace: **200 × 5**. Free personal owner, another workspace: 404 × 5. |
| Computed style | `getComputedStyle` across 17 route loads, 5 of them full text-bearing element sweeps, plus mobile and RTL | 0 defects. One candidate surfaced and retracted (gradient-backed surface). Full measurements in Table H. |
| Expanded test counts | `playwright test --list` per config — listing only, no execution | 1,512 root; 97 admin-control-plane; 101 apps/web. Reconciles with Phase 8. |

The dev server was stopped afterwards, and the two files Next rewrote while running (`apps/web/tsconfig.json`, `apps/web/next-env.d.ts`) were reverted with `git checkout --`; the tree is clean apart from the two untracked deliverables.

One observation worth passing on: while the fixture web server ran, its log showed requests for paths this audit never issued (`/admin/definitely-not-a-page`, `/definitely-not-a-page`, `/admin/platform/runbooks/no-such-runbook`). Another consumer was on that stack. It does not affect any measurement above — every result came from this session's own page loads and probes — but the concurrency question you flagged at the start of Phase 9 has some evidence behind it now.

---

## Closing statement

**No product fix was performed in Phase 9.** No product source, test, fixture, migration, generated artifact or ledger was created, modified or deleted; the two files a Next dev server rewrote were reverted and the tree verified clean. Nothing was committed and nothing was pushed. Production was not contacted, no Production endpoint or credential was loaded, and no Production customer data was read. No screenshots were captured. The static audit ran inside a clean detached worktree pinned to `79542b5845569b4087b0656a292011321f4c53ba`, which contains only `.env.example` files; the runtime verification ran against a disposable local fixture whose environment cannot reach off this machine by construction.

The two deliverables are this document and its machine-readable source, `phase9-definitive-admin-product-audit.json`, which carries the 448-control inventory with a stable id per control, the 539-element metric inventory, the 1,215-unit copy inventory, the 189-pair frontend/backend reconciliation, the 230-route backend inventory with consumers, the 143-entry route registry, the 209-page registry-coverage diff, the admin authorization scan, all 1,137 extracted backend registrations, and the full runtime-verification record including every captured failure-state string and every computed-style measurement.
