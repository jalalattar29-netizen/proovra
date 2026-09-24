# B — COMPLETE ROUTE MATRIX (all 208 routes)

**Audited SHA:** `f822de79ad9397928cb59d1760e42bd63e583457`
**Machine source:** `route-matrix.json` in this directory (emitted by `emit-artifacts.mjs`).

Every route discovered under `apps/web/app` appears exactly once, including the
144 excluded ones with their rationale. Dispositions are re-derived from
`apps/web/lib/navigation/routeRegistry.ts`, not inherited.

| | Count |
|---|---:|
| Discovered | 208 |
| APPLICABLE | **64** |
| EXCLUDED — PLATFORM_ADMIN | 36 |
| EXCLUDED — Enterprise/org console | 92 |
| EXCLUDED — marketing funnel | 16 |
| Re-classified into scope by this audit | 2 |

Columns: **WebEP** = endpoints the page's own import closure calls (shell-level calls
excluded — see `inverse-coverage.mjs`); **Nat** = of those, called by the native
screen; **Gap** = called by web, never called anywhere in native; **Ctl** = interactive
controls on the native screen; **Tests** = mobile test files referencing it
(**R** = includes a render test).

## B.1 APPLICABLE (64)

| Route | Native screen | Ledger | Phys | WebEP | Nat | Gap | Ctl | Tests |
|---|---|---|---:|---:|---:|---:|---:|---|
| `/abuse-reporting` | `(stack)/legal/[slug].tsx` | CODE_PARITY | **no** | 0 | 0 | 0 | 2 | **0** |
| `/auth` | `(stack)/auth.tsx` | CODE_PARITY | **no** | 0 | 0 | 0 | 9 | 32 R |
| `/auth/callback/ui` | `(stack)/auth.tsx` | CODE_PARITY | **no** | 3 | 3 | 0 | 9 | 32 R |
| `/auth/mfa-challenge` | `(stack)/mfa.tsx` | CODE_PARITY | **no** | 8 | 5 | 2 | 4 | 5 R |
| `/auth/mfa-recovery/verify` | `(stack)/mfa-recovery-verify.tsx` | CODE_PARITY | **no** | 3 | 3 | 0 | 2 | 1 |
| `/auth/verify-email` | `(stack)/verify-email.tsx` | CODE_PARITY | **no** | 4 | 3 | 1 | 1 | 3 |
| `/billing` | `(stack)/billing.tsx` | CODE_PARITY | **no** | 17 | 6 | 11 | 1 | 5 R |
| `/capture` | `(stack)/capture.tsx` | CODE_PARITY | **no** | 22 | 7 | 13 | 26 | 21 R |
| `/cases` | `(tabs)/cases.tsx` | CODE_PARITY | **no** | 8 | 2 | 4 | 8 | 14 R |
| `/cases/[id]` | `(stack)/case/[id].tsx` | CODE_PARITY | **no** | 73 | 11 | 43 | 20 | **0** |
| `/collaboration-teams` | `(tabs)/teams.tsx` | CODE_PARITY | **no** | 24 | 4 | 8 | 8 | 4 |
| `/collaboration-teams/[teamId]` | `(stack)/collaboration-team/[id].tsx` | CODE_PARITY | **no** | 28 | 10 | 12 | 4 | **0** |
| `/collaboration-teams/[teamId]/collaboration` | `(stack)/collaboration-team/[id].tsx` | CODE_PARITY | **no** | 0 | 0 | 0 | 4 | **0** |
| `/collaboration-teams/invites/[token]/accept` | `(stack)/invite/[token].tsx` | CODE_PARITY | **no** | 24 | 1 | 8 | 3 | 2 |
| `/data-retention` | `(stack)/legal/[slug].tsx` | CODE_PARITY | **no** | 0 | 0 | 0 | 2 | **0** |
| `/evidence` | `(tabs)/evidence.tsx` | CODE_PARITY | **no** | 15 | 12 | 0 | 39 | 41 R |
| `/evidence-requests/[id]` | `(stack)/evidence-request/[id].tsx` | CODE_PARITY | **no** | 18 | 6 | 10 | 11 | 1 R |
| `/evidence/[id]` | `(stack)/evidence/[id].tsx` | CODE_PARITY | **no** | 110 | 24 | 42 | 29 | **0** |
| `/forgot-password` | `(stack)/forgot-password.tsx` | CODE_PARITY | **no** | 0 | 0 | 0 | 4 | **0** |
| `/home` | `(tabs)/index.tsx` | CODE_PARITY | **no** | 24 | 6 | 18 | 6 | 15 R |
| `/inbox` | `(tabs)/notifications.tsx` | CODE_PARITY | **no** | 6 | 5 | 1 | 9 | **0** |
| `/intake-links` | `(stack)/intake-links.tsx` | CODE_PARITY | **no** | 12 | 4 | 6 | 7 | 4 R |
| `/intake/[token]` | `(stack)/intake/[token].tsx` | CODE_PARITY | **no** | 6 | 3 | 1 | 7 | 2 |
| `/intake/[token]/capture` | `(stack)/intake/capture.tsx` | CODE_PARITY | **no** | 0 | 0 | 0 | 4 | 9 R |
| `/invite/[token]` | `(stack)/invite/[token].tsx` | CODE_PARITY | **no** | 2 | 0 | 2 | 3 | 2 |
| `/legal/[slug]` | `(stack)/legal/[slug].tsx` | CODE_PARITY | **no** | 0 | 0 | 0 | 2 | **0** |
| `/login` | `(stack)/auth.tsx` | CODE_PARITY | **no** | 7 | 6 | 1 | 9 | 32 R |
| `/notifications` | `(tabs)/notifications.tsx` | CODE_PARITY | **no** | 0 | 0 | 0 | 9 | **0** |
| `/operations` ⚠️ | **NONE** | NO_LEDGER_ROW | — | 19 | 0 | 19 | — | **0** |
| `/operations/batch-analysis` | `(stack)/operations/batch-analysis.tsx` | CODE_PARITY | **no** | 5 | 5 | 0 | 12 | 1 |
| `/operations/health` ⚠️ | **NONE** | NO_LEDGER_ROW | — | 2 | 0 | 2 | — | **0** |
| `/operations/quotas` | `(stack)/operations/quotas.tsx` | CODE_PARITY | **no** | 2 | 2 | 0 | 1 | 1 |
| `/org-invites/[token]/accept` | `(stack)/org-invite/[token].tsx` | CODE_PARITY | **no** | 1 | 1 | 0 | 5 | 2 |
| `/organizations` | `(stack)/organizations/index.tsx` | CODE_PARITY | **no** | 2 | 1 | 0 | 2 | **0** |
| `/organizations/[id]` | `(stack)/organizations/[id].tsx` | CODE_PARITY | **no** | 32 | 9 | 10 | 12 | 1 |
| `/people` | `(stack)/workspace-people.tsx` | CODE_PARITY | **no** | 0 | 0 | 0 | 25 | 1 |
| `/portal` | `(stack)/portal/index.tsx` | CODE_PARITY | **no** | 10 | 0 | 3 | 2 | 1 |
| `/portal/[token]` | `(stack)/portal/[token].tsx` | CODE_PARITY | **no** | 10 | 3 | 3 | 4 | 2 |
| `/portal/[token]/work/[workflowId]` | `(stack)/portal/work/[workflowId].tsx` | CODE_PARITY | **no** | 10 | 4 | 3 | 7 | 1 |
| `/portal/accept/[grantId]` | `(stack)/portal/accept/[grantId].tsx` | CODE_PARITY | **no** | 10 | 0 | 3 | 1 | 1 |
| `/pricing` | `(stack)/billing.tsx` | CODE_PARITY | **no** | 1 | 1 | 0 | 1 | 5 R |
| `/privacy` | `(stack)/legal/[slug].tsx` | CODE_PARITY | **no** | 0 | 0 | 0 | 2 | **0** |
| `/register` | `(stack)/register.tsx` | CODE_PARITY | **no** | 6 | 4 | 2 | 7 | 4 |
| `/reports` | `(stack)/reports.tsx` | CODE_PARITY | **no** | 6 | 2 | 1 | 5 | 15 R |
| `/reset-password` | `(stack)/reset-password.tsx` | CODE_PARITY | **no** | 1 | 1 | 0 | 3 | 3 |
| `/search` | `(stack)/search.tsx` | CODE_PARITY | **no** | 12 | 1 | 10 | 6 | 7 R |
| `/settings` | `(tabs)/settings.tsx` | CODE_PARITY | **no** | 47 | 3 | 19 | 32 | 8 R |
| `/settings/legal/[slug]` | `(stack)/legal/[slug].tsx` | CODE_PARITY | **no** | 0 | 0 | 0 | 2 | **0** |
| `/settings/reviewer-criteria` | `(stack)/settings/reviewer-criteria.tsx` | CODE_PARITY | **no** | 8 | 8 | 0 | 12 | 1 |
| `/share/[id]` | `(stack)/evidence/[id].tsx` | CODE_PARITY | **no** | 0 | 0 | 0 | 29 | **0** |
| `/subprocessors` | `(stack)/legal/[slug].tsx` | CODE_PARITY | **no** | 0 | 0 | 0 | 2 | **0** |
| `/support` | `(stack)/support.tsx` | CODE_PARITY | **no** | 0 | 0 | 0 | 3 | 19 R |
| `/teams/[id]` | `(stack)/workspace-people.tsx` | CODE_PARITY | **no** | 43 | 17 | 13 | 25 | 1 |
| `/terms` | `(stack)/legal/[slug].tsx` | CODE_PARITY | **no** | 0 | 0 | 0 | 2 | **0** |
| `/trust` | `(stack)/trust-center.tsx` | CODE_PARITY | **no** | 0 | 0 | 0 | 4 | 2 |
| `/trust-center` | `(stack)/trust-center.tsx` | CODE_PARITY | **no** | 0 | 0 | 0 | 4 | 2 |
| `/trust-center/ai-disclosure` | `(stack)/trust-center.tsx` | CODE_PARITY | **no** | 6 | 3 | 2 | 4 | 2 |
| `/trust-center/methodology` | `(stack)/trust-center.tsx` | CODE_PARITY | **no** | 4 | 3 | 1 | 4 | 2 |
| `/trust-center/security` | `(stack)/trust-center.tsx` | CODE_PARITY | **no** | 4 | 3 | 1 | 4 | 2 |
| `/trust-center/status` | `(stack)/trust-center.tsx` | CODE_PARITY | **no** | 1 | 0 | 1 | 4 | 2 |
| `/trust-center/subprocessors` | `(stack)/trust-center.tsx` | CODE_PARITY | **no** | 5 | 2 | 3 | 4 | 2 |
| `/verify` | `verify.tsx` | CODE_PARITY | **no** | 0 | 0 | 0 | 4 | 7 |
| `/verify/[token]` | `verify.tsx` | CODE_PARITY | **no** | 1 | 1 | 0 | 4 | 7 |
| `/workspaces` | `(stack)/spaces.tsx` | CODE_PARITY | **no** | 3 | 0 | 2 | 4 | 4 |

⚠️ = re-classified into scope by this audit.

### Re-classification rationale

**`/operations`** (workspace.operations, domain OPS, requiredActiveSpace PERSONAL_OR_ORG)

> Excluded by the deriver's `ENTERPRISE_DOMAINS` heuristic (domain=OPS). NOT in ENTERPRISE_ONLY_ROUTE_IDS, and requiredActiveSpace is PERSONAL_OR_ORG. The registry author listed operations.reliability/automation/analytics explicitly and deliberately omitted workspace.operations — so the heuristic over-excludes a personal-scope surface.

**`/operations/health`** (workspace.operations_health, domain OPS, requiredActiveSpace PERSONAL_OR_ORG)

> Same: domain=OPS heuristic, requiredActiveSpace PERSONAL_OR_ORG, id workspace.operations_health absent from ENTERPRISE_ONLY_ROUTE_IDS.

## B.2 EXCLUDED (144)

| Route | routeId | Class | Rationale |
|---|---|---|---|
| `/admin` | platform.admin | ADMIN_ONLY | PLATFORM_ADMIN surface (domain and/or requiredActiveSpace = PLATFORM_ADMIN). Operator console, out of scope by the brief. |
| `/admin/adoption` | platform.adoption | ADMIN_ONLY | PLATFORM_ADMIN surface (domain and/or requiredActiveSpace = PLATFORM_ADMIN). Operator console, out of scope by the brief. |
| `/admin/alerts` | platform.alerts | ADMIN_ONLY | PLATFORM_ADMIN surface (domain and/or requiredActiveSpace = PLATFORM_ADMIN). Operator console, out of scope by the brief. |
| `/admin/audit` | platform.audit | ADMIN_ONLY | PLATFORM_ADMIN surface (domain and/or requiredActiveSpace = PLATFORM_ADMIN). Operator console, out of scope by the brief. |
| `/admin/billing` | platform.billing | ADMIN_ONLY | PLATFORM_ADMIN surface (domain and/or requiredActiveSpace = PLATFORM_ADMIN). Operator console, out of scope by the brief. |
| `/admin/contact-sales` | platform.contact_sales | ADMIN_ONLY | PLATFORM_ADMIN surface (domain and/or requiredActiveSpace = PLATFORM_ADMIN). Operator console, out of scope by the brief. |
| `/admin/contact-sales/[id]` | platform.contact_sales_detail | ADMIN_ONLY | PLATFORM_ADMIN surface (domain and/or requiredActiveSpace = PLATFORM_ADMIN). Operator console, out of scope by the brief. |
| `/admin/costs` | platform.costs | ADMIN_ONLY | PLATFORM_ADMIN surface (domain and/or requiredActiveSpace = PLATFORM_ADMIN). Operator console, out of scope by the brief. |
| `/admin/customers` | platform.customers | ADMIN_ONLY | PLATFORM_ADMIN surface (domain and/or requiredActiveSpace = PLATFORM_ADMIN). Operator console, out of scope by the brief. |
| `/admin/customers/[id]` | platform.customer_detail | ADMIN_ONLY | PLATFORM_ADMIN surface (domain and/or requiredActiveSpace = PLATFORM_ADMIN). Operator console, out of scope by the brief. |
| `/admin/dashboard` | platform.dashboard | ADMIN_ONLY | PLATFORM_ADMIN surface (domain and/or requiredActiveSpace = PLATFORM_ADMIN). Operator console, out of scope by the brief. |
| `/admin/demo-requests` | platform.demo_requests | ADMIN_ONLY | PLATFORM_ADMIN surface (domain and/or requiredActiveSpace = PLATFORM_ADMIN). Operator console, out of scope by the brief. |
| `/admin/demo-requests/[id]` | platform.demo_request_detail | ADMIN_ONLY | PLATFORM_ADMIN surface (domain and/or requiredActiveSpace = PLATFORM_ADMIN). Operator console, out of scope by the brief. |
| `/admin/evidence-ops` | platform.evidence_ops | ADMIN_ONLY | PLATFORM_ADMIN surface (domain and/or requiredActiveSpace = PLATFORM_ADMIN). Operator console, out of scope by the brief. |
| `/admin/evidence-ops/records` | platform.evidence_records | ADMIN_ONLY | PLATFORM_ADMIN surface (domain and/or requiredActiveSpace = PLATFORM_ADMIN). Operator console, out of scope by the brief. |
| `/admin/executive` | platform.executive | ADMIN_ONLY | PLATFORM_ADMIN surface (domain and/or requiredActiveSpace = PLATFORM_ADMIN). Operator console, out of scope by the brief. |
| `/admin/operations` | platform.operations | ADMIN_ONLY | PLATFORM_ADMIN surface (domain and/or requiredActiveSpace = PLATFORM_ADMIN). Operator console, out of scope by the brief. |
| `/admin/platform-health` | platform.platform_health | ADMIN_ONLY | PLATFORM_ADMIN surface (domain and/or requiredActiveSpace = PLATFORM_ADMIN). Operator console, out of scope by the brief. |
| `/admin/platform/exports` | operations.exports | ADMIN_ONLY | PLATFORM_ADMIN surface (domain and/or requiredActiveSpace = PLATFORM_ADMIN). Operator console, out of scope by the brief. |
| `/admin/platform/media-graph` | platform.media_graph | ADMIN_ONLY | PLATFORM_ADMIN surface (domain and/or requiredActiveSpace = PLATFORM_ADMIN). Operator console, out of scope by the brief. |
| `/admin/platform/observability` | platform.observability | ADMIN_ONLY | PLATFORM_ADMIN surface (domain and/or requiredActiveSpace = PLATFORM_ADMIN). Operator console, out of scope by the brief. |
| `/admin/platform/queues` | platform.queue_ops | ADMIN_ONLY | PLATFORM_ADMIN surface (domain and/or requiredActiveSpace = PLATFORM_ADMIN). Operator console, out of scope by the brief. |
| `/admin/platform/readiness` | operations.readiness | ADMIN_ONLY | PLATFORM_ADMIN surface (domain and/or requiredActiveSpace = PLATFORM_ADMIN). Operator console, out of scope by the brief. |
| `/admin/platform/recovery` | operations.recovery | ADMIN_ONLY | PLATFORM_ADMIN surface (domain and/or requiredActiveSpace = PLATFORM_ADMIN). Operator console, out of scope by the brief. |
| `/admin/platform/runbooks` | platform.runbooks | ADMIN_ONLY | PLATFORM_ADMIN surface (domain and/or requiredActiveSpace = PLATFORM_ADMIN). Operator console, out of scope by the brief. |
| `/admin/platform/runbooks/[slug]` | platform.runbook_document | ADMIN_ONLY | PLATFORM_ADMIN surface (domain and/or requiredActiveSpace = PLATFORM_ADMIN). Operator console, out of scope by the brief. |
| `/admin/platform/signers` | operations.signers | ADMIN_ONLY | PLATFORM_ADMIN surface (domain and/or requiredActiveSpace = PLATFORM_ADMIN). Operator console, out of scope by the brief. |
| `/admin/provisioning` | platform.provisioning | ADMIN_ONLY | PLATFORM_ADMIN surface (domain and/or requiredActiveSpace = PLATFORM_ADMIN). Operator console, out of scope by the brief. |
| `/admin/search` | platform.search | ADMIN_ONLY | PLATFORM_ADMIN surface (domain and/or requiredActiveSpace = PLATFORM_ADMIN). Operator console, out of scope by the brief. |
| `/admin/support-access` | platform.support_access | ADMIN_ONLY | PLATFORM_ADMIN surface (domain and/or requiredActiveSpace = PLATFORM_ADMIN). Operator console, out of scope by the brief. |
| `/admin/timeline` | platform.timeline | ADMIN_ONLY | PLATFORM_ADMIN surface (domain and/or requiredActiveSpace = PLATFORM_ADMIN). Operator console, out of scope by the brief. |
| `/admin/users` | platform.users | ADMIN_ONLY | PLATFORM_ADMIN surface (domain and/or requiredActiveSpace = PLATFORM_ADMIN). Operator console, out of scope by the brief. |
| `/admin/users/[id]` | platform.person_detail | ADMIN_ONLY | PLATFORM_ADMIN surface (domain and/or requiredActiveSpace = PLATFORM_ADMIN). Operator console, out of scope by the brief. |
| `/admin/workspaces` | platform.workspaces | ADMIN_ONLY | PLATFORM_ADMIN surface (domain and/or requiredActiveSpace = PLATFORM_ADMIN). Operator console, out of scope by the brief. |
| `/admin/workspaces/[id]` | platform.workspace_detail | ADMIN_ONLY | PLATFORM_ADMIN surface (domain and/or requiredActiveSpace = PLATFORM_ADMIN). Operator console, out of scope by the brief. |
| `/tools` | workspace.tools | ADMIN_ONLY | PLATFORM_ADMIN surface (domain and/or requiredActiveSpace = PLATFORM_ADMIN). Operator console, out of scope by the brief. |
| `/audit-transparency` | workspace.audit_transparency | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains workspace.audit_transparency |
| `/budget-center` | workspace.budget_center | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains workspace.budget_center |
| `/communications` | workspace.communications | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains workspace.communications |
| `/evidence-lifecycle` | workspace.evidence_lifecycle | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains workspace.evidence_lifecycle |
| `/evidence-lifecycle/archive` | workspace.evidence_lifecycle | ENTERPRISE_ONLY | Enterprise/org console. Gate: ancestor:/evidence-lifecycle. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains workspace.evidence_lifecycle |
| `/evidence-lifecycle/chain-transfers` | workspace.evidence_lifecycle | ENTERPRISE_ONLY | Enterprise/org console. Gate: ancestor:/evidence-lifecycle. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains workspace.evidence_lifecycle |
| `/evidence-lifecycle/destruction` | workspace.evidence_lifecycle | ENTERPRISE_ONLY | Enterprise/org console. Gate: ancestor:/evidence-lifecycle. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains workspace.evidence_lifecycle |
| `/evidence-lifecycle/legal-holds` | workspace.evidence_lifecycle | ENTERPRISE_ONLY | Enterprise/org console. Gate: ancestor:/evidence-lifecycle. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains workspace.evidence_lifecycle |
| `/evidence-lifecycle/retention` | workspace.evidence_lifecycle | ENTERPRISE_ONLY | Enterprise/org console. Gate: ancestor:/evidence-lifecycle. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains workspace.evidence_lifecycle |
| `/evidence-lifecycle/webhooks` | workspace.evidence_lifecycle | ENTERPRISE_ONLY | Enterprise/org console. Gate: ancestor:/evidence-lifecycle. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains workspace.evidence_lifecycle |
| `/exchange` | workspace.exchange | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains workspace.exchange |
| `/executive` | workspace.executive | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains workspace.executive |
| `/governance` | governance.hub | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains governance.hub |
| `/governance-platform` | workspace.governance_platform | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains workspace.governance_platform |
| `/governance-platform/access-reviews` | workspace.governance_platform | ENTERPRISE_ONLY | Enterprise/org console. Gate: ancestor:/governance-platform. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains workspace.governance_platform |
| `/governance-platform/access-reviews/[campaignId]` | workspace.governance_platform | ENTERPRISE_ONLY | Enterprise/org console. Gate: ancestor:/governance-platform. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains workspace.governance_platform |
| `/governance-platform/cross-org` | workspace.governance_platform | ENTERPRISE_ONLY | Enterprise/org console. Gate: ancestor:/governance-platform. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains workspace.governance_platform |
| `/governance-platform/delegated-admin` | workspace.governance_platform | ENTERPRISE_ONLY | Enterprise/org console. Gate: ancestor:/governance-platform. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains workspace.governance_platform |
| `/governance-platform/departments` | workspace.governance_platform | ENTERPRISE_ONLY | Enterprise/org console. Gate: ancestor:/governance-platform. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains workspace.governance_platform |
| `/governance-platform/policies` | workspace.governance_platform | ENTERPRISE_ONLY | Enterprise/org console. Gate: ancestor:/governance-platform. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains workspace.governance_platform |
| `/governance/analytics` | governance.analytics | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains governance.analytics |
| `/governance/destruction` | governance.destruction | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains governance.destruction |
| `/governance/lifecycle` | governance.lifecycle | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains governance.lifecycle |
| `/governance/notifications` | governance.notifications | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains governance.notifications |
| `/governance/policy` | governance.policy | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains governance.policy |
| `/governance/retention` | governance.retention | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains governance.retention |
| `/integrations` | workspace.integrations | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains workspace.integrations |
| `/intelligence` | workspace.intelligence | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains workspace.intelligence |
| `/intelligence-quality` | workspace.intelligence_quality | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains workspace.intelligence_quality |
| `/investigation` | investigation.hub | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains investigation.hub |
| `/investigation/cases/[caseId]/graph` | investigation.hub | ENTERPRISE_ONLY | Enterprise/org console. Gate: ancestor:/investigation. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains investigation.hub |
| `/investigation/duplicates` | investigation.duplicates | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains investigation.duplicates |
| `/investigation/graph` | investigation.graph | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains investigation.graph |
| `/investigation/relationships` | investigation.relationships | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains investigation.relationships |
| `/investigation/reviewers` | investigation.reviewers | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains investigation.reviewers |
| `/investigation/timeline` | investigation.timeline | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains investigation.timeline |
| `/operations/analytics` | operations.analytics | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains operations.analytics |
| `/operations/automation` | operations.automation | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains operations.automation |
| `/operations/reliability` | operations.reliability | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains operations.reliability |
| `/organizations/[id]/admin` | account.organization_admin | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains account.organization_admin |
| `/organizations/[id]/admin/access-reviews` | account.organization_admin_access_reviews | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains account.organization_admin_access_reviews |
| `/organizations/[id]/admin/audit` | account.organization_admin_audit | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains account.organization_admin_audit |
| `/organizations/[id]/admin/billing` | account.organization_admin_billing | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains account.organization_admin_billing |
| `/organizations/[id]/admin/bulk-invite` | account.organization_admin_bulk_invite | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains account.organization_admin_bulk_invite |
| `/organizations/[id]/admin/departments` | account.organization_admin_departments | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains account.organization_admin_departments |
| `/organizations/[id]/admin/domains` | account.organization_admin_domains | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains account.organization_admin_domains |
| `/organizations/[id]/admin/governance` | account.organization_admin_governance | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains account.organization_admin_governance |
| `/organizations/[id]/admin/governance/external-reviewers` | account.organization_admin_governance_external_reviewers | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains account.organization_admin_governance_external_reviewers |
| `/organizations/[id]/admin/integrations` | account.organization_admin_integrations | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains account.organization_admin_integrations |
| `/organizations/[id]/admin/members` | account.organization_admin_members | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains account.organization_admin_members |
| `/organizations/[id]/admin/overview` | account.organization_admin_overview | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains account.organization_admin_overview |
| `/organizations/[id]/admin/readiness` | account.organization_admin_readiness | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains account.organization_admin_readiness |
| `/organizations/[id]/admin/reports` | account.organization_admin_reports | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains account.organization_admin_reports |
| `/organizations/[id]/admin/retention` | account.organization_admin_retention | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains account.organization_admin_retention |
| `/organizations/[id]/admin/roles` | account.organization_admin_roles | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains account.organization_admin_roles |
| `/organizations/[id]/admin/security` | account.organization_admin_security | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains account.organization_admin_security |
| `/organizations/[id]/admin/trust` | account.organization_admin_trust | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains account.organization_admin_trust |
| `/organizations/[id]/setup` | account.organization-setup | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains account.organization-setup |
| `/packaging` | workspace.packaging | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains workspace.packaging |
| `/redaction` | workspace.review_redaction | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains workspace.review_redaction |
| `/redaction/[projectId]` | workspace.review_redaction | ENTERPRISE_ONLY | Enterprise/org console. Gate: ancestor:/redaction. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains workspace.review_redaction |
| `/redaction/policy` | workspace.review_redaction | ENTERPRISE_ONLY | Enterprise/org console. Gate: ancestor:/redaction. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains workspace.review_redaction |
| `/review` | workspace.review | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains workspace.review |
| `/review/disagreements` | workspace.review_disagreements | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains workspace.review_disagreements |
| `/review/external` | workspace.review_external | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains workspace.review_external |
| `/review/metrics` | workspace.review_metrics | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains workspace.review_metrics |
| `/review/operations` | review.operations | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains review.operations |
| `/review/qc` | workspace.review_qc | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains workspace.review_qc |
| `/review/queues` | workspace.review_queues | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains workspace.review_queues |
| `/review/schemas` | workspace.coding_schemas | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains workspace.coding_schemas |
| `/review/workspace` | workspace.review_workspace | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains workspace.review_workspace |
| `/reviewer-ops/[reviewId]` | — | ENTERPRISE_ONLY | Enterprise/org console. Gate: n/a. registry gap → inherits review.escalations (same reviewer action surface as the reviewer-ops queue/escalations console, wider layout); routeRegistry ENTERP |
| `/reviewer-ops/escalations` | review.escalations | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains review.escalations |
| `/reviewer-ops/queue` | review.queue_detail | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains review.queue_detail |
| `/reviewer-ops/sla` | review.sla | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains review.sla |
| `/security-center` | workspace.security_center | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains workspace.security_center |
| `/security-center/identity` | security_center.identity | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains security_center.identity |
| `/security-center/identity/access-reviews` | security_center.identity_access_reviews | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains security_center.identity_access_reviews |
| `/security-center/identity/permission-matrix` | security_center.identity_permission_matrix | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains security_center.identity_permission_matrix |
| `/security-center/identity/runtime` | security_center.identity_runtime | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains security_center.identity_runtime |
| `/security-center/identity/scim` | security_center.identity_scim | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains security_center.identity_scim |
| `/security-center/identity/sessions` | security_center.identity_sessions | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains security_center.identity_sessions |
| `/security-center/identity/timeline` | security_center.identity_timeline | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains security_center.identity_timeline |
| `/security-center/mfa-recovery` | security_center.mfa_recovery | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains security_center.mfa_recovery |
| `/security-center/posture` | security_center.posture | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains security_center.posture |
| `/security-center/sso` | security_center.sso | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains security_center.sso |
| `/security-center/sso/health` | security_center.sso | ENTERPRISE_ONLY | Enterprise/org console. Gate: ancestor:/security-center/sso. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains security_center.sso |
| `/security-center/sso/mapping` | security_center.sso | ENTERPRISE_ONLY | Enterprise/org console. Gate: ancestor:/security-center/sso. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains security_center.sso |
| `/settings/notifications/deliveries` | workspace.notification_deliveries | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains workspace.notification_deliveries |
| `/settings/security/saml` | account.settings | ENTERPRISE_ONLY | Enterprise/org console. Gate: ancestor:/settings. registry gap (overrides inherited ancestor:/settings) → security_center.sso (procurement compatibility deep-link; the canonical console is / |
| `/workflows` | workspace.workflows | ENTERPRISE_ONLY | Enterprise/org console. Gate: self. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains workspace.workflows |
| `/workflows/[id]` | workspace.workflows | ENTERPRISE_ONLY | Enterprise/org console. Gate: ancestor:/workflows. routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains workspace.workflows |
| `/` | — | PUBLIC_INFORMATIONAL_ONLY | Public marketing funnel rendered on the marketing host (middleware split). An installed app has no in-app acquisition funnel. |
| `/about` | — | PUBLIC_INFORMATIONAL_ONLY | Public marketing funnel rendered on the marketing host (middleware split). An installed app has no in-app acquisition funnel. |
| `/contact-sales` | — | PUBLIC_INFORMATIONAL_ONLY | Public marketing funnel rendered on the marketing host (middleware split). An installed app has no in-app acquisition funnel. |
| `/faq` | — | PUBLIC_INFORMATIONAL_ONLY | Public marketing funnel rendered on the marketing host (middleware split). An installed app has no in-app acquisition funnel. |
| `/for-compliance` | — | PUBLIC_INFORMATIONAL_ONLY | Public marketing funnel rendered on the marketing host (middleware split). An installed app has no in-app acquisition funnel. |
| `/for-government` | — | PUBLIC_INFORMATIONAL_ONLY | Public marketing funnel rendered on the marketing host (middleware split). An installed app has no in-app acquisition funnel. |
| `/for-insurance` | — | PUBLIC_INFORMATIONAL_ONLY | Public marketing funnel rendered on the marketing host (middleware split). An installed app has no in-app acquisition funnel. |
| `/for-investigations` | — | PUBLIC_INFORMATIONAL_ONLY | Public marketing funnel rendered on the marketing host (middleware split). An installed app has no in-app acquisition funnel. |
| `/for-journalism` | — | PUBLIC_INFORMATIONAL_ONLY | Public marketing funnel rendered on the marketing host (middleware split). An installed app has no in-app acquisition funnel. |
| `/for-lawyers` | — | PUBLIC_INFORMATIONAL_ONLY | Public marketing funnel rendered on the marketing host (middleware split). An installed app has no in-app acquisition funnel. |
| `/platform` | — | PUBLIC_INFORMATIONAL_ONLY | Public marketing funnel rendered on the marketing host (middleware split). An installed app has no in-app acquisition funnel. |
| `/request-demo` | — | PUBLIC_INFORMATIONAL_ONLY | Public marketing funnel rendered on the marketing host (middleware split). An installed app has no in-app acquisition funnel. |
| `/request-demo/success` | — | PUBLIC_INFORMATIONAL_ONLY | Public marketing funnel rendered on the marketing host (middleware split). An installed app has no in-app acquisition funnel. |
| `/technology` | — | PUBLIC_INFORMATIONAL_ONLY | Public marketing funnel rendered on the marketing host (middleware split). An installed app has no in-app acquisition funnel. |
| `/verify/demo` | — | PUBLIC_INFORMATIONAL_ONLY | Public marketing funnel rendered on the marketing host (middleware split). An installed app has no in-app acquisition funnel. |
| `/why-proovra` | — | PUBLIC_INFORMATIONAL_ONLY | Public marketing funnel rendered on the marketing host (middleware split). An installed app has no in-app acquisition funnel. |
