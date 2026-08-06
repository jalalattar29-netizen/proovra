# Phase 12 — STEP 3 Convergence: Route Wiring Map (2026-07-28)

Four bounded domain agents (A Identity/Security, B Evidence/Governance, C Commercial/Admin,
D Ops/Advanced) analyzed all 130 `MISSING_PRODUCT_CONSUMER` routes against the full
`apps/web` + `apps/mobile` + `services/worker` corpus (catching dynamic/template-literal
consumers the static extractor misses).

## Headline results

- **130 / 130 routes are GENUINELY_UNWIRED** — none has a product/worker/external consumer.
- **0 routes are SUPERSEDED_WITH_FULL_PARITY** — nothing is safely deletable.
- **The 6 assumed "duplicate" pairs were field-by-field DISPROVEN** (distinct capabilities;
  see closure-gate note). The convergence therefore reduces MISSING **only by wiring**, never
  by deletion — exactly as the capability-preservation audit requires.
- **The redaction derivative worker chain is genuinely INCOMPLETE** (highest-priority build).

Each route below has a concrete disposition: a **wiring host** (the exact product surface that
must consume it) or a **PRODUCT DECISION** (a scope choice a coding agent cannot make from code
+ approved architecture alone). No route is generic backlog.

---

## A. CRITICAL INCOMPLETE CHAIN — Redaction derivative pipeline (complete, do NOT delete)

`requestRedactionDerivative` (redaction-derivative.service.ts:88) sets state RENDERING + emits
`DERIVATIVE_RENDER_STARTED` but **enqueues no job**; there is **no worker processor**;
`mark-ready`/`mark-failed` (redaction.routes.ts:1504/1530) are user-session-authed (**no machine
path**); the UI has no request/download affordance. `ApprovalPanel.tsx:59` needs a READY
derivative to publish → **the redaction publish path is unreachable end-to-end**.

Routes: `POST /v1/redaction/derivatives/:id/mark-ready`, `.../mark-failed`, `GET /v1/redaction/derivatives/:id`.
Required build: (1) enqueue a render job in `requestRedactionDerivative`; (2) a
`services/worker` redaction-derivative processor that loads the immutable original + approved
regions/decisions, renders (sharp / pdf-lib / ffmpeg) to a separate storage key, then calls
mark-ready/mark-failed; (3) a machine-auth path for the callbacks; (4) UI request + download buttons.

## B. Unique enterprise capability — OrganizationSecurityPolicy (build editor)

Host: `apps/web/app/(app)/organizations/[id]/admin/security/page.tsx` (exists, currently static).
NOT superseded by mfa-policy+sessions (field-by-field distinct). Routes:
`GET/PATCH /v1/security-policy`, `GET /v1/security-policy/high-security/readiness`,
`POST /v1/security-policy/high-security/activate`, `GET /v1/security/{events,scans,summary}`.

## C. Wiring hosts that EXIST (need a panel; >25-line UI build)

| Target surface | Routes |
|---|---|
| admin Trust console (`organizations/[id]/admin/trust`) + public `/verify/[token]` | trust `articles/seed`, `drift/scan`+`drift/stale`, `security-claims`+`/scan`, `status/incidents`(+`/:id/updates`,`/maintenance`), `verification-package/preview`, `verify-references`, redaction `public/verify` |
| governance-platform dashboards | `access-reviews/escalated`, `departments/memberships/:id/revoke`, `me/department-scope`, `policies/effective`, `policy` (workspace), `retention-candidates`, `retention-policies/effective`, `destruction-executions`, `reconciliation-runs` |
| evidence/case detail panels | governance `legal-holds`(+`/:id/release`), `case-legal-holds`(+release), `provenance/:evidenceId` (EvidenceIntegrityTab already has the heading, never fetches) |
| redaction console panels | `policy/effective`, `policy/assignments`, `policy-assignments/:id` DELETE, `regions/:id` DELETE, `evidence/:evidenceId/detection-manifest` |
| lifecycle/exchange/packaging admin | `lifecycle/violations`(+`/counts`), `lifecycle/verification-package/preview`, `exchange/deliveries/:id/download`, `integrations/webhooks/deliveries`, `packaging/entitlements/grant` |
| investigation graph curation | graph `diagnostics`, `evidence/:evidenceId`, `search`, `relationships/manual` POST+DELETE |
| MFA admin management (security-center) | mfa-admin `events/:teamId`, `posture`, `recovery-events`, `digest-preferences/preview/send-test`, `factors/:…/revoke`, `factors/:…/require-reenrollment`, `trusted-devices/:…/reset` |
| org admin members/roles | identity `members`(+`:id/{role,revoke,capabilities,delegated-admin,restore,suspend}`), `delegated-admin/:id`, `access-reviews/regenerate`, `admin/identity/{elevations,role-matrix}`, `platform/rbac/matrix`, `capabilities/:id`, `policy` |
| SSO mapping (security-center/sso) | identity `external-mappings`(GET/POST/`:id`) |
| reviewer workspace | `reviewer-ops/queue-intelligence`, `review/queue` (evidence-requests) |
| settings / contact-methods | communications `preferences`, `verify/start`, `verify/check`; collaboration `catalogs` |
| cases list bulk toolbar | `cases/bulk` |
| evidence/case detail presence | `me/presence/here` ("who's viewing"; heartbeat write already wired) |
| admin audit / discovery | `admin/audit-log/export` (Export CSV button), `search/audit` (discovery-audit viewer) |
| ops analytics page | `analytics/_window` (drive the window selector; currently hardcoded) |
| billing surfaces | `billing/payments` (payment history), `billing/restore` (mobile Restore Purchases) |
| AI copilot panels | `ai/copilot-runs/:runId/observations` (operator add-observation) |
| intelligence settings | `intelligence/catalogs` (extraction catalog dropdowns) |
| executive dashboard | `executive/metrics` (companion tiles to the wired `/executive/trends`) |
| identity/service-accounts (NEW page) | `service-accounts` GET/POST/`:id/{disable,enable,hardening}` |
| SIU list/queue (NEW page) | siu `intake-templates`, `saved-views`(+`/custom`,`/:id`,`/:id/use`) |

## D. PRODUCT DECISIONS (cannot be made from code + approved architecture)

1. **Ops workflow-mutation family** (`ops/workflows/:id/{start,assign,escalate,mitigation,reopen,resolve,schedule-retry,suppress}`, `ops/workflows` GET(+`:id`), `ops/causality/chains`(+`:id`), `ops/bulk-actions`(+`:id`)): the CommandCenter renders this data via the wired `/v1/dashboard/command-center` envelope but is **read-only**. Decision: build an operator workflow-action UI, OR designate these as operator/machine API-only (then classify EXTERNAL/INTERNAL with a proof), OR retire the mutation family. **Do not infer scope from missing UI.**
2. **Intelligence-platform records feature** (`intelligence/records/:id`(+`/corrections`,`/version-chain`), `intelligence/corrections`(+`/:id/accept`,`/revert`), `executive/metrics`): the entire human-in-loop correction feature has **zero product surface**. Decision: build an Intelligence Record detail/corrections review UI, OR retire the family.
3. **`reviewer-ops/queue-intelligence`**: distinct insight panel, or fold into the wired `/queue`+`/console` projections?
4. **Admin analytics granularity** (`admin/analytics/{funnel,geography,pages,recent,summary,trends}`): capability already delivered by the wired composite `/v1/admin/analytics/dashboard` (same backing functions). Decision: keep granular endpoints as API-only, or converge the dashboard to per-tab lazy fetch of the granular routes.
5. **`users/legal-status`**: adopt as the canonical client re-acceptance gate (replacing client-side computation over `/v1/users/legal-acceptance`), or retire as redundant.

---

## Convergence accounting

- Deletions possible now: **0** (nothing proven superseded).
- MISSING → 0 requires **wiring** ~18 distinct product surfaces + completing the redaction
  worker chain, plus resolving the 5 product decisions above. Every route has a named home here.
- `slice-e.json` remains the machine-checked backlog; this document is its human-actionable plan.
- Route count may decrease ONLY when a specific removal is proven (full behavioral parity or a
  product-approved scope decision) — never by the "zero consumers" heuristic.
