# PHASE UI-TRUTH — definitive dashboard, admin, platform-admin and enterprise audit

Generated from `docs/admin/audits/definitive-dashboard-ui-truth.json` by `audit/ui-truth/harness/render.mjs`. Do not hand-edit: every total below is read from that file.

## Executive verdict

See the findings table; the closing line of this report states the verdict.

| Item | Value |
|---|---|
| Audited SHA | d6371ecc5a374a20fe7a96d9717c0eb2ad7082e8 |
| origin/main when the audit began | d6371ecc5a374a20fe7a96d9717c0eb2ad7082e8 |
| origin/main at report time | 5e20dc77 |
| Commits on main newer than the audit | 14 |
| Audit branch | audit/definitive-dashboard-ui-truth |
| Audit worktree | D:/pv-uitruth |
| Product files changed | 0 |
| Production contacted | no |
| Findings | 16 |
| P0 / P1 / P2 / P3 | 0 / 1 / 6 / 9 |
| Blocked proofs | 0 |
| Owner decisions | 2 |

The audit measured d6371ecc, which was origin/main when the branch was cut. While the audit ran, 14 commits landed on main (UC-3 Android continuous capture). Nothing in this report was re-measured against them, and no finding here should be read as describing that work.

## Method

- Surface universe generated from the Next.js app router (208 pages, 168 in scope).
- Every surface joined to the canonical authorities it already has: routeRegistry.ts, adminNavigation.ts, adminScopeDispositions.ts, surface tiers, and the generated capability map.
- Role/plan/workspace expectations computed by calling the product's OWN resolvers (capability-registry.ts and routeAccessResolver.ts) for 12 personas.
- Controls extracted statically with the TypeScript compiler API and matched to endpoints through the capability map.
- Runtime authorization probed against a disposable loopback fixture (fresh PostgreSQL, fresh Redis, fixture API on 127.0.0.1:8931, GET only) for 7 personas.
- Layout, state and accessibility evidence re-measured once on the audit SHA with the eight layout Playwright projects, which intercept every /v1 call with contract-shaped fixtures.

### Limitations

- The runtime probe issues GET requests only, so mutation behaviour is proven from source and from the existing admin mutation matrix, not re-executed here.
- 105 of 326 read endpoints could not be probed because the fixture holds no record for their path parameter; they are recorded as BLOCKED_FIXTURE_CAPABILITY rather than assumed.
- Integrations, notifications, AI and communications are flag-disabled in the fixture, so their surfaces answer 503 INTEGRATIONS_DISABLED and their states could not be exercised.
- Static control extraction cannot resolve 1,231 controls whose handler is supplied by a parent component; these are marked UNRESOLVED_DYNAMIC, never guessed.
- The layout projects mock the API at the browser boundary, so their evidence is about rendering and state, not about live data.

## Surface accounting

| Measure | Count |
|---|---|
| Filesystem pages | 208 |
| In scope | 168 |
| Out of scope | 40 |
| Detail pages (dynamic parameters) | 43 |
| Distinct endpoints consumed | 683 |
| Surfaces with at least one mutation | 87 |

### By area

| Area | Pages |
|---|---|
| WORKSPACE_DASHBOARD | 76 |
| PLATFORM_ADMIN_NAMESPACE | 35 |
| PUBLIC_MARKETING | 23 |
| ORGANIZATION_NAMESPACE | 21 |
| GOVERNANCE | 14 |
| SECURITY_CENTER | 13 |
| AUTH | 9 |
| PUBLIC_EXCHANGE | 7 |
| SETTINGS | 5 |
| EXTERNAL_PORTAL | 4 |
| PUBLIC_PLATFORM | 1 |

### Registration and gating

| Accounting | Surfaces |
|---|---|
| REGISTERED_OWN_ROUTE_ID | 131 |
| GATED_BY_ANCESTOR_ROUTE_ID | 31 |
| NO_REGISTRY_ENTRY_AND_NO_GATE | 6 |

## Placement: backend authority versus filesystem position

| Verdict | Surfaces |
|---|---|
| AGREES | 113 |
| NO_BACKEND_EVIDENCE | 29 |
| DISAGREES | 12 |
| AGREES_WITH_SECONDARY_AUTHORITY | 7 |
| MIXED_AUTHORITY | 5 |
| ACCOUNT_LEVEL_ONLY | 2 |

17 surface(s) whose backend disagreed with their position carry a reviewed decision:

| Route | Observed | Backend says | Decision |
|---|---|---|---|
| /admin/provisioning | PLATFORM_ADMIN_NAMESPACE | ORGANIZATION | CORRECT_AS_IS |
| /billing | WORKSPACE_DASHBOARD | ORGANIZATION | CORRECT_AS_IS |
| /operations | WORKSPACE_DASHBOARD | PLATFORM | CORRECT_BUT_AUTHORITY_MISLABELLED |
| /operations/reliability | WORKSPACE_DASHBOARD | PLATFORM | CORRECT_BUT_AUTHORITY_MISLABELLED |
| /organizations | ORGANIZATION_NAMESPACE | WORKSPACE | CORRECT_AS_IS |
| /organizations/[id]/admin/governance/external-reviewers | ORGANIZATION_NAMESPACE | WORKSPACE | CORRECT_AS_IS |
| /organizations/[id]/admin/readiness | ORGANIZATION_NAMESPACE | WORKSPACE | CORRECT_AS_IS |
| /organizations/[id]/admin/trust | ORGANIZATION_NAMESPACE | WORKSPACE | CORRECT_AS_IS |
| /redaction | WORKSPACE_DASHBOARD | ORGANIZATION | CORRECT_BUT_AUTHORITY_MISLABELLED |
| /redaction/[projectId] | WORKSPACE_DASHBOARD | ORGANIZATION | CORRECT_BUT_AUTHORITY_MISLABELLED |
| /redaction/policy | WORKSPACE_DASHBOARD | ORGANIZATION | CORRECT_BUT_AUTHORITY_MISLABELLED |
| /review/disagreements | WORKSPACE_DASHBOARD | PLATFORM | CORRECT_BUT_AUTHORITY_MISLABELLED |
| /review/qc | WORKSPACE_DASHBOARD | PLATFORM | CORRECT_BUT_AUTHORITY_MISLABELLED |
| /review/schemas | WORKSPACE_DASHBOARD | PLATFORM | CORRECT_BUT_AUTHORITY_MISLABELLED |
| /settings | SETTINGS | WORKSPACE | CORRECT_AS_IS |
| /settings/notifications/deliveries | SETTINGS | WORKSPACE | MOVE_RECOMMENDED |
| /settings/reviewer-criteria | SETTINGS | WORKSPACE | MOVE_RECOMMENDED |

## Role, plan and workspace matrix

2016 cells: 168 surfaces × 12 personas, resolved through the product's own capability and route-access resolvers.

| Persona | Access states |
|---|---|
| anonymous | UNAUTHENTICATED 162, NO_REGISTRY_GATE 6 |
| authenticated-no-workspace | NEEDS_ORGANIZATION 57, NEEDS_PERSONAL_OR_ORG 38, PLATFORM_ADMIN_ONLY 36, NEEDS_UPGRADE 20, ALLOWED 9, NO_REGISTRY_GATE 6, DENIED_NO_CAPABILITY 2 |
| free-personal-owner | NEEDS_ORGANIZATION 57, NEEDS_UPGRADE 38, PLATFORM_ADMIN_ONLY 36, ALLOWED 28, NO_REGISTRY_GATE 6, DENIED_NO_CAPABILITY 3 |
| pro-personal-owner | NEEDS_ORGANIZATION 57, PLATFORM_ADMIN_ONLY 36, NEEDS_UPGRADE 36, ALLOWED 30, NO_REGISTRY_GATE 6, DENIED_NO_CAPABILITY 3 |
| team-owned-owner | NEEDS_UPGRADE 93, PLATFORM_ADMIN_ONLY 36, ALLOWED 33, NO_REGISTRY_GATE 6 |
| org-owner | ALLOWED 124, PLATFORM_ADMIN_ONLY 36, NO_REGISTRY_GATE 6, NEEDS_UPGRADE 2 |
| org-admin | ALLOWED 124, PLATFORM_ADMIN_ONLY 36, NO_REGISTRY_GATE 6, NEEDS_UPGRADE 2 |
| org-member-reviewer | ALLOWED 102, PLATFORM_ADMIN_ONLY 36, DENIED_NO_CAPABILITY 22, NO_REGISTRY_GATE 6, NEEDS_UPGRADE 2 |
| org-viewer | ALLOWED 98, PLATFORM_ADMIN_ONLY 36, DENIED_NO_CAPABILITY 26, NO_REGISTRY_GATE 6, NEEDS_UPGRADE 2 |
| team-member | NEEDS_UPGRADE 93, PLATFORM_ADMIN_ONLY 36, ALLOWED 33, NO_REGISTRY_GATE 6 |
| team-viewer | NEEDS_UPGRADE 93, PLATFORM_ADMIN_ONLY 36, ALLOWED 31, NO_REGISTRY_GATE 6, DENIED_NO_CAPABILITY 2 |
| platform-admin | ALLOWED 162, NO_REGISTRY_GATE 6 |

### Runtime authorization

221 read endpoints probed against the disposable loopback fixture across 1547 requests; 105 endpoints could not be probed and are recorded as blocked, never assumed.

## Controls

| Measure | Count |
|---|---|
| Interactive controls inventoried | 7439 |
| Surfaces with controls | 166 |
| Mutations resolved to an endpoint | — |

| Kind | Count |
|---|---|
| LOCAL_ONLY | 4433 |
| UNRESOLVED_DYNAMIC | 1231 |
| NAVIGATIONAL | 958 |
| MUTATION | 615 |
| READ | 202 |

| Type | Count |
|---|---|
| BUTTON | 2911 |
| OTHER | 1801 |
| INPUT | 1080 |
| LINK | 952 |
| SELECT | 427 |
| FORM | 106 |
| CHECKBOX | 85 |
| TAB | 37 |
| RADIO | 24 |
| TOGGLE | 10 |
| UPLOAD | 6 |

## Content and data truth

| Measure | Count |
|---|---|
| User-visible strings inventoried | 23894 |
| Raw-value exposures | 117 |
| Data elements inventoried | 3003 |
| Data-truth hazards | 90 |

## Layout, responsive and accessibility

234 failing layout tests were measured on the audited SHA and every one is classified:

| Classification | Count |
|---|---|
| STALE_TEST | 112 |
| FIXTURE_DEFECT | 105 |
| DUPLICATE_ASSERTION | 12 |
| REAL_PRODUCT_DEFECT | 4 |
| EXPECTED_BY_DESIGN | 1 |

## Conservation and quality gates

13 met, 7 partial, 0 not met. The audit is complete only when every gate is met; this one is INCOMPLETE.

| # | Gate | Status | Measure | Remainder |
|---|---|---|---|---|
| 1 | All discovered routes are dispositioned. | MET | 1152 routes, 0 undisposed | — |
| 2 | All registered navigation entries are reconciled. | PARTIAL | 209 entries from three registries, 201 resolved | 8 unresolved: 6 are /settings hash panes (documented as legitimate), 1 is a template href, 1 is finding UIT-016 |
| 3 | Every listed page has a filesystem page or an explicit justified exception. | MET | 37 surfaces carry no navigation entry, each with a recorded justification | — |
| 4 | Every filesystem surface has a placement decision. | MET | 168 verdicts for 168 in-scope surfaces, 17 reviewed decisions for the candidates | — |
| 5 | Every interactive control has a stable row. | MET | 7439 controls across 166 surfaces; 2 surfaces are server redirects with none | — |
| 6 | Every control is classified navigational, read, mutation or local-only. | PARTIAL | 7439 classified | 1231 are UNRESOLVED_DYNAMIC because their handler is a parent-supplied prop; each carries a reason |
| 7 | Every mutation has an endpoint or is explicitly proven local-only. | PARTIAL | 411 of 615 mutation controls resolved to an endpoint | 204 unmatched, each with a stated reason (non-literal path, or a handler beyond the traversal depth) |
| 8 | Every endpoint referenced by the UI has a backend registration or a finding. | MET | 1151 of 1152 routes production-registered; the single exception is recorded in the map | — |
| 9 | Every visible data element has a source or a finding. | PARTIAL | 1060 of 3003 data elements resolved to an endpoint | 1943 unresolved, each labelled with why (render lambdas and props-fed shared components) |
| 10 | Every raw internal label rendered to users has a disposition. | PARTIAL | 117 raw-value strings at 51 sites, all carried by finding UIT-012 | They are dispositioned as one finding with a per-site list, not as 117 individually reviewed decisions |
| 11 | Every tab is exercised. | PARTIAL | 84 tab clicks across three personas, 84 became selected | Tabs on surfaces that answered not-found or a gate refusal for a persona were not exercised for that persona; the control inventory lists 41 tab controls in source |
| 12 | Every page has success, empty, error and refusal coverage as applicable. | PARTIAL | 154 surfaces probed signed-in for three personas (462 page loads), each recording the state the product itself marked | 14 surfaces blocked by fixture capability; error and stale states were not force-injected per page, so each surface has the states its data produced, not all four |
| 13 | Every layout failure is classified. | MET | 234 classified for 234 measured failures | — |
| 14 | Every finding id is unique. | MET | 16 findings | — |
| 15 | Severity totals equal unique findings. | MET | 16 findings across P0-P3 | — |
| 16 | Markdown totals equal JSON totals. | MET | The markdown is rendered from the JSON artifact alone; it computes no total of its own | — |
| 17 | The renderer aborts on missing required fields. | MET | assemble.mjs aborts on a missing input, an absent required field, an unknown evidence class, a duplicate id or the literal "undefined"; it aborted twice during this audit | — |
| 18 | Regeneration twice produces zero diff. | MET | assemble + render run twice produce byte-identical JSON and markdown | — |
| 19 | No undefined, placeholder, TODO or incomplete audit row remains. | MET | Checked by the assembler over every finding row | — |
| 20 | The audit branch contains no product-code change. | MET | 0 product files changed | — |

## Runtime state matrix

154 surfaces probed signed-in for each of three personas (462 page loads), 84 tabs clicked. 14 surfaces are blocked by fixture capability and were never probed with an invented id.

| Persona | Routes | States |
|---|---|---|
| org-owner | 154 | NOT_FOUND 56, CONTENT_OR_EMPTY 55, GATE_PLATFORM_ADMIN_ONLY 35, GATE_NEEDS_UPGRADE 8 |
| free-personal | 154 | NOT_FOUND 56, CONTENT_OR_EMPTY 49, GATE_PLATFORM_ADMIN_ONLY 35, GATE_NEEDS_UPGRADE 5, GATE_NEEDS_ORGANIZATION 4, GATE_DENIED_NO_CAPABILITY 3, READ_FAILURE_STATED 2 |
| platform-admin | 154 | CONTENT_OR_EMPTY 153, READ_FAILURE_STATED 1 |

## Findings

| ID | Severity | Category | Title | Evidence |
|---|---|---|---|---|
| UIT-001 | P2 | AUTHORITY_ACCURACY | The generated capability map labels workspace-anchored routes as multi-tenant platform-admin data | SOURCE_AND_RUNTIME_PROVEN |
| UIT-002 | P2 | ERROR_HANDLING | Trust Center status returns a 500 DATABASE_ERROR for a FREE personal workspace | RUNTIME_PROVEN |
| UIT-003 | P3 | OPERATIONAL_TRUTH | The system opens LEGACY_UNSCOPED incidents that no surface can ever display or resolve | RUNTIME_PROVEN |
| UIT-004 | P3 | API_CONSISTENCY | Three different error envelopes for the same validation failure | RUNTIME_PROVEN |
| UIT-005 | P2 | PLAN_REFUSAL_PRESENTATION | A plan refusal reaches paying customers as "We couldn't find that page", with no upgrade path | SOURCE_AND_RUNTIME_PROVEN |
| UIT-006 | P2 | CORRECTNESS | The Operations grouped read is issued for a workspace the page gate has refused | SOURCE_PROVEN |
| UIT-007 | P2 | TEST_INTEGRITY | The layout suite is not a working gate: 216 of its 233 failures prove nothing about the product | SOURCE_PROVEN |
| UIT-008 | P3 | VISUAL_CONSISTENCY | The billing purchase call to action paints as a secondary outline beside filled siblings | SOURCE_PROVEN |
| UIT-009 | P3 | RESPONSIVE | The intake timeline date escapes its cell at 125% text scale | SOURCE_PROVEN |
| UIT-010 | P3 | INFORMATION_ARCHITECTURE | Two authenticated surfaces run no canonical route gate | SOURCE_PROVEN |
| UIT-011 | P1 | DATA_TRUTH | A failed read renders as empty or zero on 36 verified sites, with nothing recorded for the user | SOURCE_PROVEN |
| UIT-012 | P2 | CONTENT | Raw enum values are rendered to customers as labels and control options | SOURCE_PROVEN |
| UIT-013 | P3 | DATA_TRUTH | Six surfaces call a polled or cached value live | SOURCE_PROVEN |
| UIT-014 | P3 | DATA_TRUTH | A drift count is printed beside a capped read without disclosing the cap | SOURCE_PROVEN |
| UIT-015 | P3 | INFORMATION_ARCHITECTURE | The in-app Trust Center index throws a signed-in user out to the marketing site | SOURCE_AND_RUNTIME_PROVEN |
| UIT-016 | P3 | NAVIGATION | A registered navigation destination has no page: /evidence-requests | SOURCE_AND_RUNTIME_PROVEN |

### UIT-001 — The generated capability map labels workspace-anchored routes as multi-tenant platform-admin data

**Severity** P2 · **Category** AUTHORITY_ACCURACY · **Evidence** SOURCE_AND_RUNTIME_PROVEN

**Routes** /review/disagreements, /review/qc, /review/schemas, /operations, /operations/reliability, /redaction

**Actors** platform-operator, auditor, release-gate

**Reproduction.** Read docs/architecture/current-runtime-capability-map.json for GET /v1/reviewer/disagreements, GET /v1/coding/schemas and GET /v1/ops/incidents, then call each against the fixture API as org-owner with the fixture organization workspace and again with another tenant's workspace.

**Expected.** A route that refuses another tenant's workspace and requires ACTIVE membership is recorded as WORKSPACE tenancy.

**Observed.** The map records tenantType PLATFORM with dataScope MULTI_TENANT_PLATFORM_ADMIN (reviewer, coding) or PLATFORM_GLOBAL (ops), while at runtime the same routes answer 200 for a member, 403/404 for another tenant, and 400 when the workspace is not named. 64 routes carry MULTI_TENANT_PLATFORM_ADMIN outside /v1/admin and /v1/platform, 56 of them with web callers.

**Evidence.**
- services/api/src/routes/reviewer-workspace.routes.ts:26-27 — "Every route is workspace-anchored. Personal-space callers receive a bounded 403 with denial WORKSPACE_NOT_FOUND"
- runtime: GET /v1/reviewer/disagreements own workspace 200, other tenant 403; GET /v1/coding/schemas 200/403; GET /v1/ops/incidents 400 without teamId, 404 for another tenant in both directions
- audit/ui-truth/data/runtime-authz.json
- audit/ui-truth/data/placement-verdicts.json — the mislabel produces 9 of the 17 placement disagreements

**Root cause.** The tenancy classifier credits the route to the table family it reads rather than to the authority that scopes the query, so a workspace-anchored reviewer or operations route reading a platform-wide table is recorded as platform data.

**Blast radius.** The map gates release decisions and feeds the admin scope reporting, so every consumer of it inherits a wrong tenancy fact for up to 56 routes. No user-facing behaviour is wrong.

**Recommended fix.** Derive tenantType from the resolved tenant binding authority (the evaluator guard that produced the teamId), not from the table family, and re-run the generator.

**Required acceptance proof.** The three named routes report tenantType WORKSPACE; the generator reruns with zero diff; the placement disagreements drop from 17 to the 8 that are not caused by the label.

### UIT-002 — Trust Center status returns a 500 DATABASE_ERROR for a FREE personal workspace

**Severity** P2 · **Category** ERROR_HANDLING · **Evidence** RUNTIME_PROVEN

**Routes** /trust-center/status

**Actors** free-personal-owner

**Reproduction.** Sign in as free-personal@fixture.local against the fixture API and GET /v1/trust/status.

**Expected.** Either the status projection, or a bounded refusal that the page can render as a decision.

**Observed.** HTTP 500 with {"error":{"code":"DATABASE_ERROR","message":"Request failed."}}. The same call succeeds for the organization and platform personas.

**Evidence.**
- runtime: GET /v1/trust/status as free-personal -> 500 DATABASE_ERROR; as org-owner -> 200
- audit/ui-truth/data/runtime-authz.json — free-personal is the only persona with 6 SERVER_FAULT outcomes

**Root cause.** Not established from source in this audit; the failure is specific to the personal-workspace shape, which suggests a query that assumes an organization row exists.

**Blast radius.** Every FREE personal user opening the Trust Center status page gets a server fault rather than content or a refusal.

**Recommended fix.** Reproduce with the personal persona, make the missing organization row a bounded empty projection, and pin it with a test that runs as a personal workspace.

**Required acceptance proof.** GET /v1/trust/status returns 200 or a typed refusal for a FREE personal owner, with a regression test using a personal-space fixture.

### UIT-003 — The system opens LEGACY_UNSCOPED incidents that no surface can ever display or resolve

**Severity** P3 · **Category** OPERATIONAL_TRUTH · **Evidence** RUNTIME_PROVEN

**Routes** /operations

**Actors** platform-operator, org-admin

**Reproduction.** Cause permission denials against the fixture API (any 403), then query operational_incidents: a row appears with team_id NULL and scope LEGACY_UNSCOPED. Every /v1/ops read requires teamId, so no query returns it.

**Expected.** An incident the product opens is reachable on some surface, or it is not opened.

**Observed.** One OPEN incident, scope LEGACY_UNSCOPED, team_id NULL, title "Security signal: permission_denied", opened_by_system true, created by this audit's own probing and invisible to every surface.

**Evidence.**
- runtime: select scope, source_id, title, opened_by_system from operational_incidents where team_id is null -> LEGACY_UNSCOPED | identity.security_condition | Security signal: permission_denied | t
- runtime: GET /v1/ops/incidents without teamId -> 400 INVALID_INPUT, so an unscoped row cannot be listed

**Root cause.** The security-signal writer opens an incident without a workspace binding, while every read path requires one.

**Blast radius.** A silently growing set of open incidents that no operator can see, action or close; it also inflates any count taken directly from the table.

**Recommended fix.** Bind the security-signal incident to the workspace whose request produced it, or route unscoped signals to a platform surface that can display and close them.

**Required acceptance proof.** After a permission denial, the resulting incident is returned by a surface a human can open, or no row is written.

### UIT-004 — Three different error envelopes for the same validation failure

**Severity** P3 · **Category** API_CONSISTENCY · **Evidence** RUNTIME_PROVEN

**Routes** /admin/identity, /admin/search, /operations/analytics

**Actors** every-authenticated-user

**Reproduction.** Call GET /v1/admin/identity/providers, GET /v1/admin/search and GET /v1/analytics/artifacts without their required query parameter.

**Expected.** One envelope shape for a validation refusal, so one client helper can render it.

**Observed.** {"error":{"code":"INVALID_INPUT","fields":[...]}}, {"error":{"code":"validation_error","detail":{...}}} and a bare {"message":"Invalid query","issues":[...]} — three shapes, two casings of the code, and one response with no error wrapper at all.

**Evidence.**
- runtime: GET /v1/admin/identity/providers -> INVALID_INPUT with fields[]
- runtime: GET /v1/admin/search -> validation_error with detail.fieldErrors
- runtime: GET /v1/analytics/artifacts -> {message, issues} with no error envelope

**Root cause.** Three validation paths (canonical refusal helper, a local zod handler, and a raw zod flush) reach the wire without a shared serializer.

**Blast radius.** Client error rendering has to special-case each shape; the bare shape has no code at all, so a generic handler cannot classify it and falls back to a generic failure message.

**Recommended fix.** Route every validation refusal through the canonical refusal helper and pin the envelope with a contract test.

**Required acceptance proof.** All three routes answer with one envelope shape and one code vocabulary, pinned by a test that enumerates validation refusals.

### UIT-005 — A plan refusal reaches paying customers as "We couldn't find that page", with no upgrade path

**Severity** P2 · **Category** PLAN_REFUSAL_PRESENTATION · **Evidence** SOURCE_AND_RUNTIME_PROVEN

**Routes** /security-center, /governance, /governance-platform, /review, /redaction, /investigation, /intelligence, /integrations, /packaging, /workflows, /executive, /budget-center, /communications, /audit-transparency, /reviewer-ops/queue

**Actors** team-owned-owner, org-owner, free-personal-owner, pro-personal-owner

**Reproduction.** Sign in to the fixture as org-owner@fixture.local (a TEAM workspace) and open /security-center, /governance-platform or /budget-center. Then open the same URLs as platform-admin@fixture.local.

**Expected.** A surface withheld by plan says so and offers the upgrade path, as the canonical route gate does: it resolves NEEDS_UPGRADE with the reason "This surface is part of the Enterprise workspace experience" and a "View plans" action, and PageRouteGate renders that as a structured panel.

**Observed.** 56 of the 154 probed surfaces render the product not-found state (data-system-state-kind="not-found") for a TEAM organization owner, and the same 56 for a FREE personal owner. All 56 render for a platform admin (55 content, 1 stated read failure), so the pages exist and work. In the same run the product DID produce the intended upgrade panel on 8 surfaces and the correct platform-admin refusal on 35, so both honest shapes exist and the wrong one is used 56 times. The cause is a second gate: 20 layout areas wrap their children in SurfaceGate, which reads the surface-tier table and calls next/navigation notFound() before the canonical gate can explain anything.

**Evidence.**
- audit/ui-truth/data/browser-probe-org-owner.json — 154 surfaces probed: 56 NOT_FOUND, 35 GATE_PLATFORM_ADMIN_ONLY, 8 GATE_NEEDS_UPGRADE, 55 content or empty; every verdict decided by the product own data-system-state-kind or data-page-route-gate-state marker
- audit/ui-truth/data/browser-probe-platform-admin.json — the same 56 routes render for a platform admin (0 NOT_FOUND across all 154)
- audit/ui-truth/data/browser-probe-free-personal.json — the same 56 NOT_FOUND
- apps/web/components/surface/SurfaceGate.tsx:204-205 — if (decision.kind === "notFound") notFound()
- apps/web/lib/navigation/routeAccessResolver.ts:241-253 — the canonical gate NEEDS_UPGRADE carries a reason and a View plans action

**Root cause.** Two gating authorities decide the same question in sequence. The tier table's notFound policy runs first inside SurfaceGate and destroys the refusal's meaning; the route registry's plan gate, which knows how to explain and where to send the customer, never runs.

**Blast radius.** Every non-enterprise customer, including paying TEAM and PRO workspaces, is told that 56 of the product surfaces do not exist — governance, security centre, review, redaction, investigation, intelligence, executive and budget among them. There is no upgrade affordance on any of them, support cannot tell a plan refusal from a broken link, and a genuine 404 is indistinguishable from a withheld feature.

**Recommended fix.** Let the canonical gate answer plan questions: have SurfaceGate defer to routeAccessResolver and render the NEEDS_UPGRADE panel instead of calling notFound(), and keep notFound() only for surfaces that genuinely do not exist for anyone.

**Required acceptance proof.** Re-run the signed-in state matrix for a TEAM and a FREE persona over all 154 probed surfaces: no surface answers with the not-found state where a platform admin sees content, and every plan-withheld surface renders the upgrade panel with its action.

### UIT-006 — The Operations grouped read is issued for a workspace the page gate has refused

**Severity** P2 · **Category** CORRECTNESS · **Evidence** SOURCE_PROVEN

**Routes** /operations

**Actors** org-viewer, team-member, any-refused-actor

**Reproduction.** Open /operations in a workspace whose gate refuses the operations capability and watch the network: the grouped read fires anyway.

**Expected.** Every read on the page is guarded by the same gate; a refused workspace issues none of them.

**Observed.** The grouped read is guarded by `!teamId || !grouped` while every sibling read is guarded by `gate || !teamId`, so a gate-refused workspace still issues GET /v1/ops/incident-groups.

**Evidence.**
- apps/web/app/(app)/operations/page.tsx:388 — the grouped effect omits the gate term that its siblings carry
- audit/ui-truth/data/layout-classification.json — LAY-0967

**Root cause.** A guard clause written per-effect rather than from one gate predicate.

**Blast radius.** A refused actor triggers an authorized-looking request the server then refuses; the denial also opens a security-signal incident (see UIT-003).

**Recommended fix.** Use the same gate predicate for every read effect on the page.

**Required acceptance proof.** With the gate refusing, no /v1/ops request leaves the page; pinned by the existing operations layout spec.

### UIT-007 — The layout suite is not a working gate: 216 of its 233 failures prove nothing about the product

**Severity** P2 · **Category** TEST_INTEGRITY · **Evidence** SOURCE_PROVEN

**Routes** /operations, /evidence/[id], /intake-links, /notifications, /settings

**Actors** maintainer, release-gate

**Reproduction.** Run the eight layout Playwright projects and classify each failure against the spec and the current product source.

**Expected.** A failing suite names product defects.

**Observed.** 233 failures: 112 stale tests pinning contracts the product deliberately changed, 104 fixture defects where the test never reached the state it asserts, 12 duplicate assertions, 1 expected by design — and only 4 real product defects.

**Evidence.**
- audit/ui-truth/data/layout-classification-summary.json
- audit/ui-truth/data/layout-classification.json — e.g. OPS-DEFAULT-VIEW-IS-GROUPED (70 rows) pins a flat table the page no longer renders by default
- apps/web/app/(app)/operations/page.tsx:352,1797 — grouped is the default view

**Root cause.** The suite was left red across a product change, so it stopped being read and then stopped being maintained.

**Blast radius.** A permanently red suite hides the four real defects inside it and cannot gate a release.

**Recommended fix.** Repair or retire by group: re-point the operations specs at the grouped view, suppress the consent overlay in the three fixtures that lack it, seed /evidence/:id, and fix the four real defects.

**Required acceptance proof.** The eight layout projects run green on an unchanged tree, twice in a row.

### UIT-008 — The billing purchase call to action paints as a secondary outline beside filled siblings

**Severity** P3 · **Category** VISUAL_CONSISTENCY · **Evidence** SOURCE_PROVEN

**Routes** /billing

**Actors** any-purchasing-actor

**Reproduction.** Open /billing and compare the "Start <tier> subscription" button with the other primary actions on the page.

**Expected.** The primary commercial action carries the filled primary treatment.

**Observed.** The button omits app-secondary-action--filled and renders outlined-secondary next to dark-filled siblings.

**Evidence.**
- audit/ui-truth/data/layout-classification.json — LAY-1035, LAY-1036

**Root cause.** A missing modifier class on the purchase action.

**Blast radius.** The most consequential action on the page reads as the least important one.

**Recommended fix.** Apply the filled primary treatment to the purchase action.

**Required acceptance proof.** The billing layout spec passes and a screenshot shows the filled treatment at 1440 and 390.

### UIT-009 — The intake timeline date escapes its cell at 125% text scale

**Severity** P3 · **Category** RESPONSIVE · **Evidence** SOURCE_PROVEN

**Routes** /intake-links

**Actors** any-actor-with-enlarged-text

**Reproduction.** Open /intake-links at 125% text scale and read the timeline column.

**Expected.** The date stays inside its cell at every supported text scale.

**Observed.** The key is sized in rem against a ch-based column cap computed for fixed 12.5px type, so the nowrap date overflows its td.

**Evidence.**
- audit/ui-truth/data/layout-classification.json — LAY-0452

**Root cause.** Two different sizing units for the same column budget.

**Blast radius.** Text overflow on a tenant-facing list at an accessibility setting users really use.

**Recommended fix.** Express the column cap and the key in the same unit.

**Required acceptance proof.** The intake layout spec passes at 100% and 125% text scale.

### UIT-010 — Two authenticated surfaces run no canonical route gate

**Severity** P3 · **Category** INFORMATION_ARCHITECTURE · **Evidence** SOURCE_PROVEN

**Routes** /collaboration-teams/[teamId]/collaboration, /settings/security/saml

**Actors** any-authenticated-user

**Reproduction.** Search both page files for PageRouteGate and for a routeRegistry entry matching their href.

**Expected.** Every authenticated surface is gated by its own routeId or an ancestor's.

**Observed.** Neither page declares a gate nor has a registry entry. /settings/security/saml is a redirect shim to /security-center/sso, which is harmless; /collaboration-teams/[teamId]/collaboration renders a real surface with no canonical gate.

**Evidence.**
- audit/ui-truth/data/placement.json — accounting NO_REGISTRY_ENTRY_AND_NO_GATE
- audit/ui-truth/data/controls-coverage.json — /settings/security/saml is a 22-line redirect page

**Root cause.** A child surface added under a gated parent without inheriting the parent's routeId.

**Blast radius.** The collaboration child page depends entirely on its parent layout and the API for refusal; the canonical web gate never runs for it.

**Recommended fix.** Declare the parent's routeId on the collaboration child; retire the saml redirect shim or register it.

**Required acceptance proof.** The route-registry coverage test reports zero ungated pages under app/(app).

### UIT-011 — A failed read renders as empty or zero on 36 verified sites, with nothing recorded for the user

**Severity** P1 · **Category** DATA_TRUTH · **Evidence** SOURCE_PROVEN

**Routes** /security-center, /budget-center, /redaction, /investigation, /search, /review/external, /teams/[id], /cases, /audit-transparency, /executive

**Actors** every-authenticated-user

**Reproduction.** Make the named read fail (block the endpoint, or sign in as a persona it refuses) and open the surface: the list renders empty and the counters render zero, with no banner, no toast and no state change.

**Expected.** A failed read is distinguishable from a genuine empty result.

**Observed.** 36 catch blocks write an empty array, a zero or a null into rendered state and record nothing else. /budget-center is the clearest: the catch nulls both reads, the header then prints "0 total, 0 soft, 0 hard" and the table prints "No breaches in window." /security-center swallows the devices, sessions, risk and recovery reads individually, so a security page can report no trusted devices and no revoked sessions when neither read succeeded.

**Evidence.**
- audit/ui-truth/data/empty-on-failure-verification.json — 65 flagged, 36 CONFIRMED_SILENT, 19 demoted because they record a typed failure, 9 documented as deliberate, 1 unverifiable
- apps/web/app/(app)/budget-center/page.tsx:53-56 — catch sets spend and breaches to null; :142-145 renders 0/0/0 and the table; :217-219 prints "No breaches in window."
- apps/web/app/(app)/security-center/page.tsx:150-171 — four reads carry .catch(() => empty) with no failure state

**Root cause.** Per-read catch blocks substitute an empty value for the missing answer instead of a read state the surface can render.

**Blast radius.** Any of these surfaces can state an all-clear the data never supported. On the security and budget surfaces that is a safety-relevant false negative.

**Recommended fix.** Give every read a state (ready, refused, failed) exactly as /governance/destruction and /evidence-lifecycle already do with classifyReadFailure, and render the failure where the empty state would have gone.

**Required acceptance proof.** For each of the 36 sites a forced read failure renders a visible failure state; render tests pin at least the security-center and budget-center cases.

### UIT-012 — Raw enum values are rendered to customers as labels and control options

**Severity** P2 · **Category** CONTENT · **Evidence** SOURCE_PROVEN

**Routes** /redaction/[projectId], /redaction, /workspaces, /security-center/sso/mapping, /reviewer-ops/[reviewId], /organizations/[id]/admin/billing, /admin/platform/exports, /admin/evidence-ops/records

**Actors** tenant-user, platform-operator

**Reproduction.** Open the redaction viewer mode picker, the workspace administration table, or the SSO role mapping, and read the option text and column headers.

**Expected.** A customer-facing control offers human wording; the technical token belongs in details, if anywhere.

**Observed.** 117 raw-value occurrences at 51 distinct sites. Redaction offers BLACKOUT, BLUR, PIXELATE and REMOVE_CONTENT as option text; workspace administration uses OWNER as a column header; SSO mapping and reviewer operations show OWNER/ADMIN/MEMBER/VIEWER and FIRST/SECOND/ADJUDICATION; billing shows FREE and NONE; three operator panels fall back to the strings governance_snapshot_unavailable, timeline_unavailable and readiness_unavailable when the API returns no safe message.

**Evidence.**
- apps/web/components/redaction/ImageRedactionViewer.tsx:182-184 — <option value="BLACKOUT">BLACKOUT</option> and its siblings
- apps/web/components/workspace-admin/WorkspaceAdminPanel.tsx:443 — <th>OWNER</th>
- audit/ui-truth/data/labels.json — 84 RAW_ENUM, 32 SNAKE_CASE, 1 SCREAMING_SNAKE and 61 DEVELOPER_LANGUAGE strings, each with file and line

**Root cause.** Enum values are rendered directly where a display mapping was never written.

**Blast radius.** Customer-facing vocabulary reads as internal database values, and the three fallback codes put an internal token in front of a user at exactly the moment something failed.

**Recommended fix.** Map each enum to human wording at the render boundary and replace the three fallback codes with sentences.

**Required acceptance proof.** The 51 sites render human wording, and the existing raw-operator-language scanner covers the tenant surfaces, not only the admin console.

### UIT-013 — Six surfaces call a polled or cached value live

**Severity** P3 · **Category** DATA_TRUTH · **Evidence** SOURCE_PROVEN

**Routes** /admin/billing, /admin/evidence-ops, /inbox, /organizations/[id]/admin/readiness, /home

**Actors** tenant-user, platform-operator

**Reproduction.** Read the labels beside the figures on each named surface and compare them with the read that supplies the figure.

**Expected.** Live means the figure is current at render, or the surface states when it was measured.

**Observed.** Six labels assert liveness over values that arrive from an interval poll or a cached projection, with no measurement time beside them.

**Evidence.**
- audit/ui-truth/data/data-elements.json — CACHED_VALUE_PRESENTED_AS_LIVE, six rows with file and line
- apps/web/app/(app)/organizations/[id]/admin/readiness/page.tsx:301 — "Live operational health"

**Root cause.** Copy written for a streaming source that was implemented as a periodic read.

**Blast radius.** An operator can act on a figure believing it is current.

**Recommended fix.** State the measurement time beside the figure, or drop the word.

**Required acceptance proof.** No surface asserts liveness without a measured-at value beside it.

### UIT-014 — A drift count is printed beside a capped read without disclosing the cap

**Severity** P3 · **Category** DATA_TRUTH · **Evidence** SOURCE_PROVEN

**Routes** /security-center

**Actors** tenant-user

**Reproduction.** Open the panel that renders the access-anomaly drift count and compare its denominator with the read limit.

**Expected.** A count taken over a capped list says so.

**Observed.** The panel prints a drift count out of rows.length checked, where rows is the capped access-anomalies read, so both numbers describe the fetched page rather than the workspace. A further 62 files cap a read and render a count whose collection could not be traced to that read; they are recorded as undecidable rather than asserted.

**Evidence.**
- apps/web/components/hidden-feature-panels/HiddenFeaturePanels.tsx:545
- audit/ui-truth/data/data-elements.json — COUNT_BESIDE_AN_UNDISCLOSED_CAP, plus capRuleUndecidable.files

**Root cause.** The count is derived from the fetched page rather than from a server total.

**Blast radius.** A reader can believe the workspace has no drift when only the first page was checked.

**Recommended fix.** Print the server total, or say "of the first N checked".

**Required acceptance proof.** The count names its denominator, and the 62 undecidable files are each dispositioned.

### UIT-015 — The in-app Trust Center index throws a signed-in user out to the marketing site

**Severity** P3 · **Category** INFORMATION_ARCHITECTURE · **Evidence** SOURCE_AND_RUNTIME_PROVEN

**Routes** /trust-center

**Actors** every-authenticated-user

**Reproduction.** Sign in and open /trust-center, then open /trust-center/security.

**Expected.** An in-app surface keeps the application shell, exactly as its own children do.

**Observed.** /trust-center is a redirect shim to the public /trust page, so a signed-in user lands on the marketing site with its Platform/Solutions/Pricing navigation, a "Sign in" link and a "Request a demo" call to action. Its children (/trust-center/security, /methodology, /status, /subprocessors, /ai-disclosure) stay inside the app and render through the canonical route gate, so one family answers in two different shells.

**Evidence.**
- apps/web/app/(app)/trust-center/page.tsx:1-5 — the whole page is redirect("/trust")
- apps/web/app/(app)/trust-center/security/page.tsx:1-6 — the sibling renders in-app behind PageRouteGate
- audit/ui-truth/data/browser-probe-org-owner.json — /trust-center renders "Platform Technology Solutions Resources Company Pricing Verify EN Sign in Request a demo" to a signed-in org owner

**Root cause.** The index was left as a redirect when the in-app trust pages were added.

**Blast radius.** A signed-in customer is shown a sign-in link and a sales call to action, and loses the workspace context and navigation.

**Recommended fix.** Render the in-app trust index (the section list its children already use), or point the navigation entry at a child that stays in the shell.

**Required acceptance proof.** A signed-in visit to /trust-center keeps the application shell, and no app route links out to the marketing site.

### UIT-016 — A registered navigation destination has no page: /evidence-requests

**Severity** P3 · **Category** NAVIGATION · **Evidence** SOURCE_AND_RUNTIME_PROVEN

**Routes** /evidence-requests

**Actors** any-actor-holding-intake-links-manage

**Reproduction.** Read the route registry entry workspace.evidence_requests, list apps/web/app/(app)/evidence-requests, then open /evidence-requests signed in.

**Expected.** Every registered destination resolves to a surface, or is not registered.

**Observed.** The registry declares workspace.evidence_requests with href /evidence-requests, the label "Evidence requests" and required capability INTAKE_LINKS_MANAGE, but the only page under that directory is [id]. A signed-in platform admin visiting /evidence-requests gets the not-found state. I could not surface the entry on /tools or in the command palette as a platform admin (both build from the same registry but filter by capability), so the practical exposure is limited to a direct visit or to a persona whose capabilities admit it — which I did not prove either way.

**Evidence.**
- apps/web/lib/navigation/routeRegistry.ts:1663-1670 — the entry, its href and its label
- apps/web/app/(app)/evidence-requests/ — contains only [id]
- audit/ui-truth/data/nav-reconciliation.json — 8 registry entries resolve to no surface; 6 of them are legitimate /settings hash panes, this one is not
- runtime: a signed-in platform admin opening /evidence-requests renders data-system-state-kind="not-found"

**Root cause.** The list page was never built, or was removed, while its registry entry stayed.

**Blast radius.** A destination that exists in the canonical registry but nowhere in the product. Anything that renders the registry without a capability filter would show a dead link, and the registry is the authority other surfaces trust.

**Recommended fix.** Build the list surface, or delete the registry entry and point the detail page's breadcrumb at the surface that lists requests.

**Required acceptance proof.** The navigation reconciliation reports zero registry entries that resolve to no surface, apart from the /settings hash panes it documents.

## Owner decisions

### UIT-OD-001 — Should /settings/notifications/deliveries and /settings/reviewer-criteria stay in the ACCOUNT settings namespace while acting on the active workspace, or move under workspace settings?

Both pages read and write workspace-scoped data from an account-domain route, so their meaning changes on a workspace switch while the URL does not.

Options: Move under workspace settings; Keep and state the active workspace in the header and on every write.

Recommendation: Move under workspace settings; it is the only option that makes the URL honest.

### UIT-OD-002 — Which authority should answer "may this surface load" — the route registry's plan gate, or the surface-tier table?

Both exist. The tier table is enforced client-side by SurfaceGate and answers notFound; the registry gate resolves NEEDS_UPGRADE with an upgrade action. For 63 surfaces they disagree, and where the tier wins the customer is told the page does not exist (UIT-005).

Options: Registry gate only; SurfaceGate defers to it and the tier table is retired; Tier table only, but changed to render an explained refusal rather than notFound; Keep both, with the tier table reduced to surfaces that must be concealed from everyone.

Recommendation: Registry gate only. It already carries the reason and the upgrade action, and one authority per question is the rule the rest of this codebase follows.

## Remediation backlog

| # | ID | Severity | Route family | Title | Depends on |
|---|---|---|---|---|---|
| 1 | UIT-011 | P1 | security-center | A failed read renders as empty or zero on 36 verified sites, with nothing recorded for the user | — |
| 2 | UIT-006 | P2 | operations | The Operations grouped read is issued for a workspace the page gate has refused | — |
| 3 | UIT-012 | P2 | redaction | Raw enum values are rendered to customers as labels and control options | — |
| 4 | UIT-001 | P2 | review | The generated capability map labels workspace-anchored routes as multi-tenant platform-admin data | — |
| 5 | UIT-005 | P2 | security-center | A plan refusal reaches paying customers as "We couldn't find that page", with no upgrade path | — |
| 6 | UIT-002 | P2 | trust-center | Trust Center status returns a 500 DATABASE_ERROR for a FREE personal workspace | — |
| 7 | UIT-007 | P2 | operations | The layout suite is not a working gate: 216 of its 233 failures prove nothing about the product | UIT-006 |
| 8 | UIT-004 | P3 | admin | Three different error envelopes for the same validation failure | — |
| 9 | UIT-013 | P3 | admin | Six surfaces call a polled or cached value live | — |
| 10 | UIT-008 | P3 | billing | The billing purchase call to action paints as a secondary outline beside filled siblings | — |
| 11 | UIT-010 | P3 | collaboration-teams | Two authenticated surfaces run no canonical route gate | — |
| 12 | UIT-016 | P3 | evidence-requests | A registered navigation destination has no page: /evidence-requests | — |
| 13 | UIT-009 | P3 | intake-links | The intake timeline date escapes its cell at 125% text scale | — |
| 14 | UIT-003 | P3 | operations | The system opens LEGACY_UNSCOPED incidents that no surface can ever display or resolve | — |
| 15 | UIT-014 | P3 | security-center | A drift count is printed beside a capped read without disclosing the cap | — |
| 16 | UIT-015 | P3 | trust-center | The in-app Trust Center index throws a signed-in user out to the marketing site | — |

