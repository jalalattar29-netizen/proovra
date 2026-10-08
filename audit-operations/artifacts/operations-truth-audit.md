# PROOVRA Operations truth audit

Generated from `audit-operations/artifacts/*.json` by `audit-operations/generator/generate.mjs`. Do not edit by hand.

- Baseline: `85c8800778e4c09e7681f83c1ee8fed4661beff9`
- Verdict: **INCOMPLETE** — 3 external blocker(s) remain: BLK-NATIVE-DEVICE, BLK-PRODUCTION-DATA, BLK-STEP-UP-FACTORS
- Production contacted: false
- Product files changed: 0

## Totals

| Measure | Value |
|---|---|
| findings | 36 |
| bySeverity | {"P0":0,"P1":7,"P2":20,"P3":9} |
| byStatus | {"CONFIRMED":22,"REFUTED":0,"PARTIALLY_CONFIRMED":2,"SUPERSEDED_BY_MORE_PRECISE_FINDING":0,"UNDECIDABLE_WITH_RECORDED_BLOCKER":0,"NEW":12} |
| proofs | 38 |
| cells | 54 |
| cellStatus | {"EXERCISED_ALLOWED":42,"EXERCISED_REFUSED":8,"NOT_APPLICABLE":3,"BLOCKED_EXTERNAL":1} |
| endpoints | 81 |
| webRoutes | 9 |
| webControls | 82 |
| nativeControls | 84 |
| sources | 39 |
| producers | 36 |
| resolvers | 8 |
| scheduledReconcilers | 15 |

## Conservation gates

| Gate | Result | Detail |
|---|---|---|
| G01 Every proof's Product source fingerprints match the current tree | PASS |  |
| G02 Findings: contiguous unique ids, allowed vocabulary, grep-verified source symbols, existing proofs, all 24 prior findings reconciled | PASS |  |
| G03 Every required persona/plan/workspace/commercial cell is exercised (evidence row found) or explicitly NOT_APPLICABLE / BLOCKED_EXTERNAL with a reason | PASS |  |
| G04 Discovered Operations endpoints (route registrations in each inventoried route file) = dispositioned endpoints | PASS |  |
| G05 Discovered Operations web routes = classified routes | PASS |  |
| G06 Incident write call sites in Product source = registered producers; every producer sourceId registered | PASS |  |
| G07 Incident codes in OPERATIONS_SOURCE_LIFECYCLES = registered codes = conservation rows | PASS |  |
| G08 Every auto-resolve claim has a wired resolver or a finding | PASS |  |
| G09 Every discovered web/native control is classified; every action control maps to an API call | PASS |  |
| G10 Every BLOCKED_EXTERNAL cell is backed by an external-blocker record | PASS |  |
| G11 No UNKNOWN / NOT_REVIEWED disposition anywhere | PASS |  |

## Findings

| ID | Sev | Status | Prior | Title | Proof |
|---|---|---|---|---|---|
| OPS-001 | P1 | CONFIRMED | CONFIRMED | Workspace 'Queue telemetry sampler delayed' is derived from Home page loads, not from the worker sampler | BROWSER_PROVEN, REAL_DB_PROVEN |
| OPS-002 | P1 | CONFIRMED | CONFIRMED | 'Queue retry storm' counts this workspace's re-observed conditions, not queue retries; its drill-down lists only itself; Home counts it twice | BROWSER_PROVEN, REAL_DB_PROVEN |
| OPS-003 | P1 | CONFIRMED | CONFIRMED | Personal storage add-on obligation: never auto-resolves, can be manually 'resolved' while live, drawer blames platform infrastructure | BROWSER_PROVEN, REAL_DB_PROVEN |
| OPS-004 | P1 | CONFIRMED | CONFIRMED | Report failure condition auto-resolves while a newer version is failed or still processing | REAL_DB_PROVEN |
| OPS-005 | P2 | CONFIRMED | CONFIRMED | /v1/ops/* enforces role only; plan/entitlement is enforced in the web alone | BROWSER_PROVEN, RUNTIME_PROVEN |
| OPS-006 | P1 | CONFIRMED | CONFIRMED | Worker scheduled sweeps send x-cron-secret; the API authenticates x-proovra-integration-cron-secret (deterministic 401) | RUNTIME_PROVEN |
| OPS-007 | P2 | PARTIALLY_CONFIRMED | CONFIRMED (P1) | Detail and list reads share one request counter: after any action with the drawer open the list never refreshes and Refresh stays disabled | BROWSER_PROVEN |
| OPS-008 | P1 | CONFIRMED | CONFIRMED | Scheduled Operations sweep only ranks the 500 oldest workspaces | REAL_DB_PROVEN |
| OPS-009 | P2 | CONFIRMED | CONFIRMED | Per-workspace worker-heartbeat conditions never auto-resolve and open SLA cycles | REAL_DB_PROVEN |
| OPS-010 | P2 | CONFIRMED | CONFIRMED | GET /v1/ops/health gives any workspace member (VIEWER, FREE) process-global configuration and unscoped counts | RUNTIME_PROVEN |
| OPS-011 | P2 | CONFIRMED | CONFIRMED | Web bulk outcome counts SUCCEEDED; the API returns COMPLETED — every successful bulk run is shown as failed | BROWSER_PROVEN, RUNTIME_PROVEN |
| OPS-012 | P2 | CONFIRMED | CONFIRMED | Default Grouped view: group drawer has only 'Close'; no actions and no route to the condition drawer | BROWSER_PROVEN |
| OPS-013 | P2 | CONFIRMED | CONFIRMED | 'Retry after exhausted failure' (supersede) is never offered; the offered action tells the user to use it | REAL_DB_PROVEN |
| OPS-014 | P2 | CONFIRMED | CONFIRMED | Expected 403 refusals become a customer-visible 'Identity security condition' | REAL_DB_PROVEN |
| OPS-015 | P2 | CONFIRMED | CONFIRMED | Failures for personal records stored with team_id NULL become LEGACY_UNSCOPED and are invisible to their owner | REAL_DB_PROVEN |
| OPS-016 | P2 | CONFIRMED | CONFIRMED | Raw error text becomes the customer summary (verbatim to VIEWERs) and part of the fingerprint | REAL_DB_PROVEN |
| OPS-017 | P3 | CONFIRMED | CONFIRMED | 'Search index reconciliation failing' opens when no reconciliation has ever run (and when work is already scheduled) | REAL_DB_PROVEN, RUNTIME_PROVEN |
| OPS-018 | P2 | CONFIRMED | CONFIRMED | Sources declared PROBE_AUTO_RESOLVE that nothing closes (one is permanently stuck) | REAL_DB_PROVEN |
| OPS-019 | P2 | CONFIRMED | CONFIRMED (P3, TSA only) | TSA and OTS failure conditions resolve on any non-FAILED status (NULL, PENDING, unvalidated STAMPED) | REAL_DB_PROVEN |
| OPS-020 | P3 | CONFIRMED | CONFIRMED | Drawer/page UX and accessibility: no focus move/trap, wrong focus restore, English-only in de/ar, no deep link, Load-more in grouped view | BROWSER_PROVEN |
| OPS-021 | P3 | CONFIRMED | CONFIRMED | Web capability envelope disagrees with API authority (revoked rows counted, expired access, suspended org) | REAL_DB_PROVEN, RUNTIME_PROVEN |
| OPS-022 | P2 | CONFIRMED | CONFIRMED | Real BullMQ failures and retries never reach any Operations surface; persisted retryCount is hard-coded 0 | RUNTIME_PROVEN |
| OPS-023 | P2 | CONFIRMED | CONFIRMED | Storage add-on condition wording/category: PENDING titled 'still billing', MANUAL title replaced, category STORAGE | REAL_DB_PROVEN |
| OPS-024 | P3 | PARTIALLY_CONFIRMED | CONFIRMED | Queue replay eligibility admits completed jobs; BullMQ then refuses and the API reports 404 'job_not_found' | RUNTIME_PROVEN |
| OPS-025 | P1 | NEW |  | /v1/investigation/diagnostics returns another tenant's queue job failure text to any workspace member | RUNTIME_PROVEN |
| OPS-026 | P2 | NEW |  | /v1/runtime/secrets-health gives any member (VIEWER) the secrets posture: secret names, presence, AWS secret/region, fallback mode | RUNTIME_PROVEN |
| OPS-027 | P2 | NEW |  | No writer produces PLATFORM scope; provider-credential conditions are stored LEGACY_UNSCOPED with an hourly fingerprint and no resolver | REAL_DB_PROVEN |
| OPS-028 | P3 | NEW |  | Report-failure recovery is proven by a DB row without verifying the stored object | REAL_DB_PROVEN |
| OPS-029 | P2 | NEW |  | Resolve is a dead control for sources that require a resolution note: the web sends no note and has no field | REAL_DB_PROVEN |
| OPS-030 | P2 | NEW |  | 'Stop notifying' (suppress) hides a live source-truth condition with no confirmation and no recorded reason | BROWSER_PROVEN, REAL_DB_PROVEN |
| OPS-031 | P2 | NEW |  | Remediation guidance and deep links are keyed by category, not source: wrong guidance and generic targets | BROWSER_PROVEN, REAL_DB_PROVEN |
| OPS-032 | P3 | NEW |  | POST /v1/ops/workspace-reconcile reports started:false for the request that ran the reconciliation | REAL_DB_PROVEN |
| OPS-033 | P3 | NEW |  | Projected titles replace stored titles with the source label: 120 distinct conditions all read 'Governance policy condition' | BROWSER_PROVEN, REAL_DB_PROVEN |
| OPS-034 | P3 | NEW |  | Enterprise has no organization roll-up; Operations is strictly per workspace | REAL_DB_PROVEN |
| OPS-035 | P3 | NEW |  | Native Operations: no reset on workspace switch, no refresh on foreground, English-only | SOURCE_AND_TEST_PROVEN |
| OPS-036 | P2 | NEW |  | A failed grouped read renders '0 groups · 0 conditions … match these filters' in the default view | BROWSER_PROVEN |

### OPS-001 — Workspace 'Queue telemetry sampler delayed' is derived from Home page loads, not from the worker sampler

- Severity / status: P1 / CONFIRMED (prior: CONFIRMED)
- Category: FABRICATED_TELEMETRY; scope: WORKSPACE row describing a fact that is not about the workspace
- Affected: plans ALL (sweep runs for every workspace regardless of plan); personas any workspace member with operations.view; workspaces personal, owned team, organization
- Source: `services/api/src/services/operations/operations-source-probes.ts` (`probeKey: "platform.telemetry_age"`); `services/worker/src/telemetry.ts` (`teamId: null,`); `services/api/src/services/dashboard/command-center.service.ts` (`recordDbDerivedSnapshotsForWorkspace({ teamId })`); `services/worker/src/index.ts` (`worker.queue_health.sampled`)
- Reproduction: Insert fresh worker BULLMQ snapshots (team_id NULL) and one 17h-old DB_DERIVED workspace snapshot; run reconcileWorkspaceOperations; condition opens HIGH at 1020 minutes. A Home GET resolves it; 31 minutes later it reopens even after another Home GET (lazy refill only when no row in 240 minutes). A workspace that never loaded Home never gets the condition even with zero worker samples.
- Expected: A sampler-delay condition measures the real BullMQ sampler and belongs to the platform control plane.
- Actual: The probe reads QueueTelemetrySnapshot WHERE teamId = workspace; only Home's lazy DB-derived writer produces such rows; the worker writes team_id NULL and its queue_health log line is never persisted. The condition says 'The worker remains operational; the sampler may be delayed' while measuring Home visits.
- User impact: Every workspace that ever opened Home shows a permanent false HIGH 'sampler delayed' condition that also feeds OPS-002.
- Security/privacy: None (false information, no disclosure).
- Canonical owner: Platform Admin control plane (worker-liveness.service.ts / queue-inventory.service.ts); Operations duplicates: true Second, invented queue-health detector per workspace beside the platform queue inventory and worker liveness authorities.
- Remediation boundary: Remove platform.telemetry_stale from tenant discovery (or make it PLATFORM_INTERNAL and measure team_id NULL BULLMQ rows); never write telemetry from a GET; close existing rows with an explicit reconciliation.
- Regression proof required: With fresh worker samples and an old workspace DB_DERIVED row, no tenant-visible condition exists; with no worker samples for > window, a single platform condition exists and closes when a sample lands.
- Files a remediation may touch: services/api/src/services/operations/operations-source-probes.ts, packages/shared-runtime/src/ops/source-lifecycle.ts, services/api/src/services/dashboard/command-center.service.ts; must not duplicate: services/api/src/services/operations/worker-liveness.service.ts, services/api/src/services/operations/queue-inventory.service.ts
- Data reconciliation: Yes: resolve all open platform.telemetry_stale WORKSPACE rows with an audited reconciliation note.; Production/owner action: Deploy + one-off reconciliation of existing rows.
- Proofs: PR-A1-telemetry-fabricated (REAL_DB_PROVEN, `audit-operations/evidence/runtime/PR-A1-telemetry-fabricated.json`); PR-B01-reem-view (BROWSER_PROVEN, `audit-operations/evidence/browser/PR-B01-reem-view.json`)

### OPS-002 — 'Queue retry storm' counts this workspace's re-observed conditions, not queue retries; its drill-down lists only itself; Home counts it twice

- Severity / status: P1 / CONFIRMED (prior: CONFIRMED)
- Category: MISLEADING_CONDITION; scope: WORKSPACE
- Affected: plans ALL; personas any workspace member; workspaces personal, owned team, organization
- Source: `services/api/src/services/operations/operations-source-probes.ts` (`probeKey: "queue.retry_storm_count"`); `services/api/src/services/observability/incident.service.ts` (`occurrenceCount: { increment: 1 }`); `services/api/src/services/operations/operations-group-drilldown.service.ts` (`listGroupAffectedRecords`); `services/api/src/services/dashboard/command-center.service.ts` (`retryStormIncidents`)
- Reproduction: Leave any two conditions open for 5 sweeps: the storm opens (WARNING, HIGH at 3) naming no queue; the drill-down returns the storm row only; Home's retryStormIncidents read 3 while only 2 other conditions qualified.
- Expected: A retry storm is measured from BullMQ retries/failures and names the queues/jobs; otherwise it does not exist.
- Actual: occurrenceCount is incremented by every sweep re-observation, so any persistent condition (telemetry, storage, search) becomes a 'queue retry storm'.
- User impact: Reem's 'Queue retry storm — 2 repeatedly observed conditions' was this artefact; tenants are told queues are retrying when none are.
- Security/privacy: None.
- Canonical owner: Platform Admin queue console (queue-inventory / queue-replay-safety); Operations duplicates: true Invents a queue signal from incident bookkeeping.
- Remediation boundary: Retire queue.retry_storm as a tenant source; if kept for platform, compute from BullMQ attempts/failed counts. Separate 'observation count' from 'occurrence count'.
- Regression proof required: Persistent unrelated conditions never open a retry storm; a BullMQ job failing N times does (platform scope).
- Files a remediation may touch: services/api/src/services/operations/operations-source-probes.ts, packages/shared-runtime/src/ops/source-lifecycle.ts, services/api/src/services/dashboard/command-center.service.ts; must not duplicate: services/api/src/services/operations/queue-inventory.service.ts
- Data reconciliation: Yes: close open queue.retry_storm rows.; Production/owner action: Deploy + reconciliation.
- Proofs: PR-A1-retry-storm-meta (REAL_DB_PROVEN, `audit-operations/evidence/runtime/PR-A1-retry-storm-meta.json`); PR-B01-reem-view (BROWSER_PROVEN, `audit-operations/evidence/browser/PR-B01-reem-view.json`)

### OPS-003 — Personal storage add-on obligation: never auto-resolves, can be manually 'resolved' while live, drawer blames platform infrastructure

- Severity / status: P1 / CONFIRMED (prior: CONFIRMED)
- Category: BILLING_TRUTH; scope: BILLING_ACCOUNT (personal) surfaced in the Personal Space
- Affected: plans PRO/PAYG/TEAM personal payers (team_id NULL add-ons); personas personal owner; workspaces personal
- Source: `services/api/src/services/operations/operations-source-probes.ts` (`async function observeDependentCancellation`); `services/api/src/services/dashboard/incident-generator.service.ts` (`syncDependentCancellationConditions`); `services/api/src/services/operations/remediation-registry.ts` (`This is platform infrastructure`)
- Reproduction: Personal add-on (team_id NULL) in PENDING/RETRY_SCHEDULED/ACTION_REQUIRED/MANUAL_INTERVENTION: POST /v1/ops/incidents/:id/resolve returns 200 in every state. Set CONFIRMED, or let the retry sweep withdraw the obligation to NONE: three sweeps later the condition is still OPEN with occurrenceCount frozen (first = last seen). TEAM and Enterprise payers correctly refuse manual close (409) but also never auto-close after CONFIRMED.
- Expected: The condition closes when the provider confirms or the obligation is withdrawn; manual close is refused while the obligation is live; the drawer links to Billing.
- Actual: No sweep calls the source-truth recovery for this source; the probe matches teamId strictly so personal add-ons read NOT_APPLICABLE, which ALLOW_OPERATOR_CLOSE turns into a permitted manual resolve. The drawer says 'cannot be marked resolved by hand' and 'platform infrastructure'.
- User impact: Reem's 'still billing after cancellation' row was stuck open; a user can hide a live billing obligation with one click.
- Security/privacy: Financial truth: a live charge can be concealed from the operator surface.
- Canonical owner: Billing (dependent-cancellation.service.ts) + provider reconciliation; Operations duplicates: true Re-implements 'resolved' as CONFIRMED\|\|NONE instead of the billing UNRESOLVED_STATES authority.
- Remediation boundary: Resolve by owner (personal) or team; wire sweepSourceTruthRecoveries for the source; refuse manual close while UNRESOLVED; deep-link to /billing retry.
- Regression proof required: CONFIRMED and NONE close the condition (personal and team); manual resolve while live returns 409 for personal add-ons; drawer offers the Billing link.
- Files a remediation may touch: services/api/src/services/operations/operations-source-probes.ts, services/api/src/services/dashboard/incident-generator.service.ts, services/api/src/services/operations/remediation-registry.ts, packages/shared-runtime/src/ops/source-lifecycle.ts; must not duplicate: services/api/src/services/billing/dependent-cancellation.service.ts
- Data reconciliation: Yes: re-evaluate every open billing.dependent_cancellation_failed row against its add-on.; Production/owner action: Read the specific Production add-on behind Reem's row (owner), deploy, reconcile.
- Proofs: PR-A3-storage-addon (REAL_DB_PROVEN, `audit-operations/evidence/runtime/PR-A3-storage-addon.json`); PR-A3b-billing-subjects (REAL_DB_PROVEN, `audit-operations/evidence/runtime/PR-A3b-billing-subjects.json`); PR-B01-reem-view (BROWSER_PROVEN, `audit-operations/evidence/browser/PR-B01-reem-view.json`)

### OPS-004 — Report failure condition auto-resolves while a newer version is failed or still processing

- Severity / status: P1 / CONFIRMED (prior: CONFIRMED)
- Category: INTEGRITY_TRUTH; scope: EVIDENCE_RECORD
- Affected: plans Report-entitled plans; personas any; workspaces all
- Source: `services/api/src/services/operations/operations-source-probes.ts` (`stage: { not: "REPORT_COMMITTED" }`)
- Reproduction: Evidence with report v1; a newer REPORT request FAILED_TERMINAL or PROCESSING (stage NULL, as every non-committed attempt has); sweep -> condition RESOLVED 'no longer reported by its source'.
- Expected: The condition stays open until the failed version exists.
- Actual: A Prisma `not` filter excludes NULL stage rows, so every failed/live newer attempt is invisible and v1 reads as recovery.
- User impact: A failed updated report silently disappears from Operations.
- Security/privacy: Evidence-output truth.
- Canonical owner: Evidence output lifecycle (evidence-output-lifecycle.ts IN_FLIGHT states); Operations duplicates: true Own in-flight predicate instead of the canonical one.
- Remediation boundary: Use the canonical in-flight/terminal predicate with explicit NULL-stage handling and version from the fingerprint.
- Regression proof required: v2 FAILED_TERMINAL or PROCESSING with v1 present keeps the condition OPEN; v2 committed resolves it.
- Files a remediation may touch: services/api/src/services/operations/operations-source-probes.ts; must not duplicate: packages/shared/src/evidence-output-lifecycle.ts
- Data reconciliation: Yes: re-open conditions resolved by this predicate whose newer request is not committed.; Production/owner action: Deploy + reconciliation query.
- Proofs: PR-A4-report-package (REAL_DB_PROVEN, `audit-operations/evidence/runtime/PR-A4-report-package.json`)

### OPS-005 — /v1/ops/* enforces role only; plan/entitlement is enforced in the web alone

- Severity / status: P2 / CONFIRMED (prior: CONFIRMED)
- Category: ENTITLEMENT_ENFORCEMENT; scope: WORKSPACE
- Affected: plans FREE, expired/revoked internal grant, cancelled/inactive TEAM; personas owner/admin/member; workspaces personal, owned
- Source: `services/api/src/routes/ops.routes.ts` (`async function requireOpsCapability`)
- Reproduction: FREE personal owner (envelope OPERATIONS_VIEW=false): GET incidents/summary/detail/health 200; POST ack/suppress 200; workspace-reconcile 202. Same for expired/revoked grant and CANCELED/INACTIVE owned TEAM.
- Expected: The API refuses Operations for a workspace whose plan does not include it, with a typed reason consistent with the web.
- Actual: No plan check anywhere in ops.routes.ts; web shows 'Missing required capability: OPERATIONS_VIEW'.
- User impact: Inconsistent entitlement; downgraded workspaces keep full Operations via API/native clients.
- Security/privacy: Entitlement bypass on own data (no cross-tenant read).
- Canonical owner: Capability authority (capability-registry.ts) + plan catalog; Operations duplicates: false 
- Remediation boundary: Derive the API gate from the same capability resolution the envelope uses (OPERATIONS_VIEW etc.), not a second plan table.
- Regression proof required: Matrix cells PERSONAL_FREE_OWNER / PERSONAL_EXPIRED_GRANT / OWNED_TEAM_CANCELED_OWNER return 403 with the same reason the web shows.
- Files a remediation may touch: services/api/src/routes/ops.routes.ts; must not duplicate: services/api/src/services/platform-context/capability-registry.ts
- Data reconciliation: No.; Production/owner action: Product decision on what FREE sees (see recommendation).
- Proofs: PR-A2-matrix (RUNTIME_PROVEN, `audit-operations/evidence/runtime/PR-A2-matrix.json`); PR-B05-free-gate (BROWSER_PROVEN, `audit-operations/evidence/browser/PR-B05-free-gate.json`)

### OPS-006 — Worker scheduled sweeps send x-cron-secret; the API authenticates x-proovra-integration-cron-secret (deterministic 401)

- Severity / status: P1 / CONFIRMED (prior: CONFIRMED)
- Category: SCHEDULER_TRUTH; scope: PLATFORM_GLOBAL
- Affected: plans ALL; personas system; workspaces all
- Source: `services/api/src/middleware/cron-secret.ts` (`x-proovra-integration-cron-secret`); `services/worker/src/org-invite-delivery.worker.ts` (`"x-cron-secret"`); `services/worker/src/automation-dispatch.ts` (`"x-cron-secret"`)
- Reproduction: With INTEGRATION_CRON_SECRET set, POST /v1/org-invite-deliveries/process and /v1/automation/runs/process: worker header -> 401, canonical header -> 200.
- Expected: Worker and API use one header contract.
- Actual: Every worker sweep is refused; the failure is logged only and never reaches any Operations surface.
- User impact: Org-invite retry outbox and automation dispatch/webhook outbox never run (matches the Production 401 warnings).
- Security/privacy: None directly.
- Canonical owner: middleware/cron-secret.ts; Operations duplicates: false 
- Remediation boundary: One shared header constant used by worker and API; surface sustained sweep refusals on the platform control plane.
- Regression proof required: Integration test: worker client against API route returns 200.
- Files a remediation may touch: services/worker/src/org-invite-delivery.worker.ts, services/worker/src/automation-dispatch.ts; must not duplicate: services/api/src/middleware/cron-secret.ts
- Data reconciliation: Re-drive stranded invite deliveries/automation runs after deploy.; Production/owner action: Deploy worker; verify sweeps return 200.
- Proofs: PR-A8-cron-header (RUNTIME_PROVEN, `audit-operations/evidence/runtime/PR-A8-cron-header.json`)

### OPS-007 — Detail and list reads share one request counter: after any action with the drawer open the list never refreshes and Refresh stays disabled

- Severity / status: P2 / PARTIALLY_CONFIRMED (prior: CONFIRMED (P1))
- Category: WEB_STATE; scope: WEB
- Affected: plans Operations-entitled; personas operators; workspaces all
- Source: `apps/web/app/(app)/operations/page.tsx` (`requestSeq`)
- Reproduction: Open a condition drawer in 'All conditions', press Acknowledge: server row is ACKNOWLEDGED, drawer still shows 'Open', Refresh shows 'Refreshing…' disabled, also after closing the drawer.
- Expected: A successful action refreshes list, summary and drawer.
- Actual: Refresh deadlock confirmed in the browser. The previously claimed 'old workspace rows after switching' was NOT reproduced: the modal drawer blocks the workspace switcher, and a switch with the drawer closed rendered only the new workspace. Severity lowered to P2 (stale presentation; server state correct).
- User impact: Operators see stale status and a stuck Refresh until reload.
- Security/privacy: None.
- Canonical owner: Web Operations page; Operations duplicates: false 
- Remediation boundary: Separate sequence counters per read (or AbortController per request); clear refreshing in all branches.
- Regression proof required: Browser: ack with drawer open updates the badge and re-enables Refresh.
- Files a remediation may touch: apps/web/app/(app)/operations/page.tsx; must not duplicate: —
- Data reconciliation: No.; Production/owner action: Deploy web.
- Proofs: PR-B02-drawer-refresh-deadlock (BROWSER_PROVEN, `audit-operations/evidence/browser/PR-B02-drawer-refresh-deadlock.json`); PR-B03-workspace-switch-inflight (BROWSER_PROVEN, `audit-operations/evidence/browser/PR-B03-workspace-switch-inflight.json`); PR-B15-two-tabs (BROWSER_PROVEN, `audit-operations/evidence/browser/PR-B15-two-tabs.json`)

### OPS-008 — Scheduled Operations sweep only ranks the 500 oldest workspaces

- Severity / status: P1 / CONFIRMED (prior: CONFIRMED)
- Category: SCHEDULER_COVERAGE; scope: PLATFORM_GLOBAL
- Affected: plans ALL; personas all; workspaces every workspace created after the 500th
- Source: `services/api/src/jobs/workspace-operations-reconciliation.job.ts` (`take: limit * 20`)
- Reproduction: 509+ teams, all but the newest with a fresh run: runWorkspaceOperationsSweep reconciles 0 and the never-run newest workspace is never selected.
- Expected: Every workspace is eventually swept.
- Actual: The candidate list is truncated before ranking; newer workspaces depend on a manual 'Check again'.
- User impact: Home, Notifications and Operations for newer tenants go stale; conditions are neither opened nor auto-resolved.
- Security/privacy: None.
- Canonical owner: Workspace operations reconciliation job; Operations duplicates: false 
- Remediation boundary: Rank in SQL (never-run first, oldest run next) without a creation-order truncation; report coverage on the platform plane.
- Regression proof required: With N > 500 teams, a never-run workspace is selected on the next tick.
- Files a remediation may touch: services/api/src/jobs/workspace-operations-reconciliation.job.ts; must not duplicate: packages/shared-runtime/src/workspace-operations-reconciliation.ts
- Data reconciliation: No.; Production/owner action: Deploy; check Production team count to size impact (blocked: no Production access).
- Proofs: PR-A6-scheduler-coverage (REAL_DB_PROVEN, `audit-operations/evidence/runtime/PR-A6-scheduler-coverage.json`)

### OPS-009 — Per-workspace worker-heartbeat conditions never auto-resolve and open SLA cycles

- Severity / status: P2 / CONFIRMED (prior: CONFIRMED)
- Category: RESOLVER_TRUTH; scope: PLATFORM_GLOBAL written as WORKSPACE
- Affected: plans ALL; personas platform admin (rows hidden from tenants); workspaces all
- Source: `services/api/src/services/observability/incident.service.ts` (`export async function resolveConditionFromSourceRecovery`)
- Reproduction: Stale heartbeat -> CRITICAL WORKSPACE row (hidden); fresh heartbeat + 2 sweeps -> still OPEN; one SLA cycle opened on the hidden row.
- Expected: One platform condition that closes when a heartbeat lands.
- Actual: The resolver looks the row up through the tenant predicate that excludes PLATFORM_INTERNAL sources; it never finds it.
- User impact: Platform console accumulates one permanent CRITICAL per workspace per outage.
- Security/privacy: None.
- Canonical owner: worker-liveness.service.ts; Operations duplicates: true Second heartbeat detector (15 min) beside worker liveness (180 s).
- Remediation boundary: Write heartbeat staleness once at PLATFORM scope from the liveness authority; resolve with a platform predicate.
- Regression proof required: Fresh heartbeat closes the single platform row; no per-workspace copies.
- Files a remediation may touch: services/api/src/services/operations/operations-source-probes.ts, services/api/src/services/observability/incident.service.ts; must not duplicate: services/api/src/services/operations/worker-liveness.service.ts
- Data reconciliation: Yes: close existing per-workspace heartbeat rows.; Production/owner action: Deploy + reconciliation.
- Proofs: PR-A6-heartbeat (REAL_DB_PROVEN, `audit-operations/evidence/runtime/PR-A6-heartbeat.json`)

### OPS-010 — GET /v1/ops/health gives any workspace member (VIEWER, FREE) process-global configuration and unscoped counts

- Severity / status: P2 / CONFIRMED (prior: CONFIRMED)
- Category: DISCLOSURE; scope: PLATFORM_GLOBAL exposed to WORKSPACE
- Affected: plans ALL; personas VIEWER and up; workspaces all
- Source: `services/api/src/routes/ops.routes.ts` (`getFeatureSnapshot()`)
- Reproduction: VIEWER GET /v1/ops/health: snapshot/violations/observability/alerts with env-var names (TWILIO_ACCOUNT_SID, TWILIO_API_KEY, TWILIO_API_SECRET); incidents.openCritical=1 counts a hidden platform heartbeat row while the tenant list shows 0.
- Expected: Platform configuration only on the platform control plane; tenant counts use the tenant predicate.
- Actual: Gate is operations.view; counts filter teamId only.
- User impact: Workspace members see infrastructure posture and counts that disagree with their queue.
- Security/privacy: Configuration/infra disclosure to customer roles.
- Canonical owner: Platform Admin readiness/observability; Operations duplicates: true Duplicates platform readiness in a customer route.
- Remediation boundary: Move to requirePlatformAdmin (as /v1/ops/metrics and /v1/ops/alerts were) or reduce to tenant-scoped counts via workspaceIncidentWhere.
- Regression proof required: VIEWER gets 403 or a tenant-only payload without env names.
- Files a remediation may touch: services/api/src/routes/ops.routes.ts; must not duplicate: —
- Data reconciliation: No.; Production/owner action: Deploy.
- Proofs: PR-A8-health-exposure (RUNTIME_PROVEN, `audit-operations/evidence/runtime/PR-A8-health-exposure.json`); PR-A2-matrix (RUNTIME_PROVEN, `audit-operations/evidence/runtime/PR-A2-matrix.json`)

### OPS-011 — Web bulk outcome counts SUCCEEDED; the API returns COMPLETED — every successful bulk run is shown as failed

- Severity / status: P2 / CONFIRMED (prior: CONFIRMED)
- Category: CONTRACT_MISMATCH; scope: WEB
- Affected: plans Operations-entitled; personas operators with ack/suppress/assign; workspaces all
- Source: `apps/web/app/(app)/operations/page.tsx` (`"SUCCEEDED"`); `services/api/src/services/dashboard/bulk-actions.service.ts` (`BulkOperationalActionItemStatus.COMPLETED`)
- Reproduction: Server: runBulkAction -> items COMPLETED. Browser: a fully successful bulk acknowledge renders '0 of 2 updated. 2 could not be changed and remain selected.' The web also sends no idempotencyKey.
- Expected: The web reads the server's vocabulary.
- Actual: Mismatch; native reads COMPLETED correctly.
- User impact: Operators retry successful bulk actions.
- Security/privacy: None.
- Canonical owner: bulk-actions.service.ts; Operations duplicates: false 
- Remediation boundary: Share the item-status type from the API contract; send idempotencyKey.
- Regression proof required: Browser: successful bulk shows 'N updated'.
- Files a remediation may touch: apps/web/app/(app)/operations/page.tsx; must not duplicate: —
- Data reconciliation: No.; Production/owner action: Deploy web.
- Proofs: PR-A8-bulk-vocabulary (RUNTIME_PROVEN, `audit-operations/evidence/runtime/PR-A8-bulk-vocabulary.json`); PR-B07-bulk-outcome (BROWSER_PROVEN, `audit-operations/evidence/browser/PR-B07-bulk-outcome.json`)

### OPS-012 — Default Grouped view: group drawer has only 'Close'; no actions and no route to the condition drawer

- Severity / status: P2 / CONFIRMED (prior: CONFIRMED)
- Category: ACTIONABILITY; scope: WEB
- Affected: plans Operations-entitled; personas all; workspaces all
- Source: `apps/web/app/(app)/operations/_components/GroupInspector.tsx` (`export function GroupInspector`)
- Reproduction: Open /operations (Grouped default), open the storage or retry-storm group: controls = ['Close'].
- Expected: Every group exposes its members' canonical actions or a link to each condition.
- Actual: Only counts; this is why Reem saw no recovery action for the report failure.
- User impact: Actionable conditions look non-actionable in the default view.
- Security/privacy: None.
- Canonical owner: Web Operations page; Operations duplicates: false 
- Remediation boundary: Group members open the condition drawer; group header shows the source's canonical action when uniform.
- Regression proof required: Browser: group drawer -> condition drawer -> canonical action.
- Files a remediation may touch: apps/web/app/(app)/operations/_components/GroupInspector.tsx; must not duplicate: —
- Data reconciliation: No.; Production/owner action: Deploy web.
- Proofs: PR-B01-reem-view (BROWSER_PROVEN, `audit-operations/evidence/browser/PR-B01-reem-view.json`)

### OPS-013 — 'Retry after exhausted failure' (supersede) is never offered; the offered action tells the user to use it

- Severity / status: P2 / CONFIRMED (prior: CONFIRMED)
- Category: ACTIONABILITY; scope: EVIDENCE_RECORD
- Affected: plans Report-entitled; personas owner/admin (operations.resolve); workspaces all
- Source: `services/api/src/routes/ops.routes.ts` (`permissionCache`); `services/api/src/services/operations/remediation-registry.ts` (`operatorPermission: "operations.resolve"`)
- Reproduction: TEAM workspace, exhausted TECHNICAL failure: detail offers only report.regenerate_artifacts; executing it returns 409 'Use "Retry after exhausted failure"'; POST of report.supersede_failed_generation directly returns 202 QUEUED through requestOutputRecovery; a double submit is refused (no second request).
- Expected: The supersede action is offered to an operator holding operations.resolve.
- Actual: The detail route's permission cache never loads operations.resolve, so the action is filtered out.
- User impact: Dead end for exhausted report failures.
- Security/privacy: None.
- Canonical owner: Evidence output recovery (requestOutputRecovery); Operations duplicates: false Executor correctly delegates to requestOutputRecovery.
- Remediation boundary: Load operations.resolve into the cache (or ask the canonical authority).
- Regression proof required: Detail for an exhausted technical failure lists the supersede action for owner/admin only.
- Files a remediation may touch: services/api/src/routes/ops.routes.ts; must not duplicate: services/api/src/services/reports/output-recovery.service.ts
- Data reconciliation: No.; Production/owner action: Deploy.
- Proofs: PR-A4b-recovery-entitled (REAL_DB_PROVEN, `audit-operations/evidence/runtime/PR-A4b-recovery-entitled.json`); PR-A4-report-package (REAL_DB_PROVEN, `audit-operations/evidence/runtime/PR-A4-report-package.json`)

### OPS-014 — Expected 403 refusals become a customer-visible 'Identity security condition'

- Severity / status: P2 / CONFIRMED (prior: CONFIRMED)
- Category: SECURITY_SIGNAL_AS_INCIDENT; scope: SECURITY_RESTRICTED written as WORKSPACE
- Affected: plans ALL; personas any refused member; visible to all operators; workspaces shared
- Source: `services/api/src/services/security/security-event.service.ts` (`maybeAutoCreateIncident`)
- Reproduction: A VIEWER requests /v1/ops/assignable-operators and a MEMBER suppresses (both 403): owner's queue shows 'Identity security condition' (stored title 'Security signal: permission_denied'), occurrences 2.
- Expected: Routine authorization refusals stay in the security log.
- Actual: permission_denied is mapped to a tenant-visible condition that also feeds the retry storm.
- User impact: Noise; reveals who attempted what to all operators.
- Security/privacy: Security telemetry exposed as customer incident.
- Canonical owner: Security event log; Operations duplicates: true Security events re-surfaced as operations conditions.
- Remediation boundary: Classify permission_denied as routine (no incident).
- Regression proof required: 403s produce no OperationalIncident.
- Files a remediation may touch: services/api/src/services/security/security-event.service.ts; must not duplicate: —
- Data reconciliation: Yes: close identity.security_condition rows fingerprinted on permission_denied.; Production/owner action: Deploy + reconciliation.
- Proofs: PR-A1-denial-incident (REAL_DB_PROVEN, `audit-operations/evidence/runtime/PR-A1-denial-incident.json`)

### OPS-015 — Failures for personal records stored with team_id NULL become LEGACY_UNSCOPED and are invisible to their owner

- Severity / status: P2 / CONFIRMED (prior: CONFIRMED)
- Category: SCOPE_VISIBILITY; scope: EVIDENCE_RECORD stored as LEGACY_UNSCOPED
- Affected: plans personal payers; personas personal owner; workspaces personal (legacy NULL-team records)
- Source: `services/worker/src/governance/incident-emitter.ts` (`LEGACY_UNSCOPED`)
- Reproduction: recordWorkerIncident(teamId NULL) for a personal record: scope LEGACY_UNSCOPED; not in the owner's Personal Space list; summary open = 0.
- Expected: The condition is attributed to the record's canonical workspace (workspaceEvidenceWhere).
- Actual: Invisible on every tenant surface.
- User impact: Report/package failures on legacy personal records are never shown.
- Security/privacy: None.
- Canonical owner: resolveEvidenceWorkspaceId (shared-runtime); Operations duplicates: false 
- Remediation boundary: Writers resolve the record's workspace before recording.
- Regression proof required: Personal NULL-team record failure appears in the owner's Personal Space.
- Files a remediation may touch: services/worker/src/processor.ts, services/worker/src/governance/incident-emitter.ts; must not duplicate: —
- Data reconciliation: Yes: re-scope LEGACY_UNSCOPED pipeline rows whose record resolves to a workspace.; Production/owner action: Deploy + reconciliation.
- Proofs: PR-A4-report-package (REAL_DB_PROVEN, `audit-operations/evidence/runtime/PR-A4-report-package.json`)

### OPS-016 — Raw error text becomes the customer summary (verbatim to VIEWERs) and part of the fingerprint

- Severity / status: P2 / CONFIRMED (prior: CONFIRMED)
- Category: DISCLOSURE; scope: EVIDENCE_RECORD
- Affected: plans ALL; personas VIEWER and up; workspaces all
- Source: `services/worker/src/processor.ts` (`safeSummary: rawMessage.slice(0, 380)`)
- Reproduction: A worker-written condition whose summary contains an S3 bucket and KMS ARN is projected verbatim to a VIEWER (runtime); the processor derives that summary and the fingerprint from Error.message (source).
- Expected: Customer text is a bounded, classified code; identity is per record.
- Actual: No sanitisation (coerceSafeSummary only trims).
- User impact: Internal infrastructure names reach customers; one record can open several conditions.
- Security/privacy: Bucket/KMS/provider identifiers disclosed.
- Canonical owner: Worker incident emitter; Operations duplicates: false 
- Remediation boundary: Classify errors to closed codes before recording; fingerprint per (record, class).
- Regression proof required: Error messages with bucket/ARN never appear in projected summaries.
- Files a remediation may touch: services/worker/src/processor.ts, services/worker/src/governance/incident-emitter.ts; must not duplicate: —
- Data reconciliation: Yes: rewrite stored summaries of open pipeline rows.; Production/owner action: Deploy + data rewrite.
- Proofs: PR-A4-report-package (REAL_DB_PROVEN, `audit-operations/evidence/runtime/PR-A4-report-package.json`)

### OPS-017 — 'Search index reconciliation failing' opens when no reconciliation has ever run (and when work is already scheduled)

- Severity / status: P3 / CONFIRMED (prior: CONFIRMED)
- Category: WORDING_TRUTH; scope: WORKSPACE
- Affected: plans ALL; personas any; workspaces any with records
- Source: `services/api/src/services/search/search-health.service.ts` (`PROVEN_FAILURE_STATES`)
- Reproduction: Workspace with records and zero SEARCH_INDEX runs -> STALLED -> FAILING -> condition opens. Canonical classifier: 'never run, work scheduled' is also STALLED; RUNNING with live lease is PARTIAL/indeterminate (correct); empty workspace and READY close the condition (correct, DB-proven).
- Expected: 'Not yet measured' distinct from 'failing'.
- Actual: Title claims failure.
- User impact: False failure claim on new workspaces.
- Security/privacy: None.
- Canonical owner: Search readiness (search-readiness.ts); Operations duplicates: false Delegates to the canonical classifier.
- Remediation boundary: Wording/state: open as 'not yet indexed' (advisory) for never-run; keep FAILED/STALLED-with-history as failing.
- Regression proof required: Never-run workspace shows a not-yet-measured state, not 'failing'.
- Files a remediation may touch: services/api/src/services/operations/search-index-conditions.service.ts; must not duplicate: packages/shared/src/search-readiness.ts
- Data reconciliation: No.; Production/owner action: Deploy.
- Proofs: PR-A1-search-never-run (REAL_DB_PROVEN, `audit-operations/evidence/runtime/PR-A1-search-never-run.json`); PR-A5-search (RUNTIME_PROVEN, `audit-operations/evidence/runtime/PR-A5-search.json`)

### OPS-018 — Sources declared PROBE_AUTO_RESOLVE that nothing closes (one is permanently stuck)

- Severity / status: P2 / CONFIRMED (prior: CONFIRMED)
- Category: RESOLVER_TRUTH; scope: mixed
- Affected: plans ALL; personas operators; workspaces all
- Source: `services/api/src/services/dashboard/incident-generator.service.ts` (`sweepSourceTruthRecoveries`)
- Reproduction: With the source healthy, two sweeps leave OPEN: evidence_integrity.ots_budget_exhausted, pipeline.package_generation_denied, review.escalation, identity.idp_outage (plus billing.dependent_cancellation_failed OPS-003 and platform.worker_heartbeat_stale OPS-009). Three then accept a manual close; package_generation_denied refuses even that (409 CONDITION_STILL_ACTIVE) and can never close.
- Expected: Every auto-resolve claim has a wired resolver.
- Actual: Claims without resolvers.
- User impact: Permanently open conditions; manual closes without source proof.
- Security/privacy: None.
- Canonical owner: Each source's domain authority; Operations duplicates: false 
- Remediation boundary: Either wire sweepSourceTruthRecoveries per source or change the declared recovery policy; conservation test over the registry.
- Regression proof required: Registry gate: every PROBE_AUTO_RESOLVE source has an executed resolver test.
- Files a remediation may touch: services/api/src/services/dashboard/incident-generator.service.ts, packages/shared-runtime/src/ops/source-lifecycle.ts; must not duplicate: —
- Data reconciliation: Yes.; Production/owner action: Deploy + reconciliation.
- Proofs: PR-A6-no-auto-resolver (REAL_DB_PROVEN, `audit-operations/evidence/runtime/PR-A6-no-auto-resolver.json`)

### OPS-019 — TSA and OTS failure conditions resolve on any non-FAILED status (NULL, PENDING, unvalidated STAMPED)

- Severity / status: P2 / CONFIRMED (prior: CONFIRMED (P3, TSA only))
- Category: INTEGRITY_TRUTH; scope: EVIDENCE_RECORD
- Affected: plans ALL; personas any; workspaces all
- Source: `services/api/src/services/operations/evidence-integrity-conditions.service.ts` (`export function isCurrentlyFailing`)
- Reproduction: FAILED -> NULL / PENDING / STAMPED-without-validation all RESOLVED 'tsaStatus is no longer FAILED'; OTS FAILED -> PENDING / NULL also RESOLVED although the registry states 'otsStatus reaches ANCHORED or UPGRADED'. Original failure stays in history (correct).
- Expected: TSA closes on a validated stamp; OTS on ANCHORED/UPGRADED.
- Actual: 'not FAILED'. Severity raised from P3: OTS registry contract is contradicted at runtime.
- User impact: A trust failure can disappear without proof of recovery.
- Security/privacy: Trust truth.
- Canonical owner: Evidence trust authority; Operations duplicates: true Own predicate instead of the trust authority's verified state.
- Remediation boundary: Resolve on the canonical verified/anchored predicate.
- Regression proof required: PENDING/NULL never resolve; validated stamp / ANCHORED do.
- Files a remediation may touch: services/api/src/services/operations/evidence-integrity-conditions.service.ts; must not duplicate: —
- Data reconciliation: Review resolved integrity rows whose record is not verified.; Production/owner action: Deploy + review.
- Proofs: PR-A5-trust (REAL_DB_PROVEN, `audit-operations/evidence/runtime/PR-A5-trust.json`)

### OPS-020 — Drawer/page UX and accessibility: no focus move/trap, wrong focus restore, English-only in de/ar, no deep link, Load-more in grouped view

- Severity / status: P3 / CONFIRMED (prior: CONFIRMED)
- Category: UX_ACCESSIBILITY; scope: WEB
- Affected: plans Operations-entitled; personas all, esp. keyboard/screen-reader users; workspaces all
- Source: `apps/web/app/(app)/operations/_components/IncidentInspector.tsx` (`Stop notifying`)
- Reproduction: Browser: opening a drawer leaves focus outside it; one Tab leaves the drawer; Escape restores focus to a row checkbox; no live region announces action results; German and Arabic render the page in English (Arabic sets dir=rtl correctly); the drawer is not URL-addressable; grouped view shows a 'Load 50 more' that appends hidden rows. Correct: no overflow 320–1440px or at 200% root text, no sub-24px targets, no nested interactive controls, headings H1/H2, reduced motion respected, failed reads never render all-clear, 1 detail read per open, no idle polling.
- Expected: WCAG dialog pattern; localized copy; addressable conditions.
- Actual: As reproduced.
- User impact: Keyboard/screen-reader and non-English users disadvantaged.
- Security/privacy: None.
- Canonical owner: Web Operations page; Operations duplicates: false 
- Remediation boundary: Use the shared dialog primitive with trap/restore; route i18n through the shared dictionary; add ?incident= deep link; gate Load more on flat view.
- Regression proof required: Browser a11y suite (focus trap, restore, live region), de/ar snapshots.
- Files a remediation may touch: apps/web/app/(app)/operations/page.tsx, apps/web/app/(app)/operations/_components/IncidentInspector.tsx, apps/web/app/(app)/operations/_components/GroupInspector.tsx; must not duplicate: packages/shared/src/i18n.ts
- Data reconciliation: No.; Production/owner action: Deploy web.
- Proofs: PR-B08-pagination (BROWSER_PROVEN, `audit-operations/evidence/browser/PR-B08-pagination.json`); PR-B09-responsive (BROWSER_PROVEN, `audit-operations/evidence/browser/PR-B09-responsive.json`); PR-B10-locales (BROWSER_PROVEN, `audit-operations/evidence/browser/PR-B10-locales.json`); PR-B11-accessibility (BROWSER_PROVEN, `audit-operations/evidence/browser/PR-B11-accessibility.json`); PR-B12-history-deeplink (BROWSER_PROVEN, `audit-operations/evidence/browser/PR-B12-history-deeplink.json`); PR-B13-drawer-churn-polling (BROWSER_PROVEN, `audit-operations/evidence/browser/PR-B13-drawer-churn-polling.json`); PR-B06-error-states (BROWSER_PROVEN, `audit-operations/evidence/browser/PR-B06-error-states.json`); PR-B14-empty-state (BROWSER_PROVEN, `audit-operations/evidence/browser/PR-B14-empty-state.json`); PR-B04-viewer-controls (BROWSER_PROVEN, `audit-operations/evidence/browser/PR-B04-viewer-controls.json`)

### OPS-021 — Web capability envelope disagrees with API authority (revoked rows counted, expired access, suspended org)

- Severity / status: P3 / CONFIRMED (prior: CONFIRMED)
- Category: CAPABILITY_CONSISTENCY; scope: WORKSPACE
- Affected: plans ALL; personas sole owner with revoked ex-members; expired-access member; suspended-org owner; workspaces owned, organization
- Source: `services/api/src/services/platform-context/platform-context.service.ts` (`_count: { select: { members: true } }`); `services/api/src/services/platform-context/capability-registry.ts` (`(input.memberCount ?? 0) > 1`)
- Reproduction: FREE owned workspace with one ACTIVE owner and one REVOKED row: envelope grants OPERATIONS_VIEW/ACK/RESOLVE/SUPPRESS/ASSIGN. Member with expired access and owner of a suspended org: envelope OPERATIONS_VIEW=true, API 403. Assignment to revoked/viewer is correctly refused (400).
- Expected: One authority; envelope mirrors evaluateMemberAccess.
- Actual: Two predicates.
- User impact: Visible controls that the API refuses.
- Security/privacy: None (API is stricter).
- Canonical owner: evaluateMemberAccess; Operations duplicates: false 
- Remediation boundary: Count ACTIVE, unexpired members; apply org lifecycle in the envelope.
- Regression proof required: Matrix cells agree (apiAgreesWithWeb=true) for those three cells.
- Files a remediation may touch: services/api/src/services/platform-context/platform-context.service.ts; must not duplicate: services/api/src/services/identity/access-policy.service.ts
- Data reconciliation: No.; Production/owner action: Deploy.
- Proofs: PR-A2-matrix (RUNTIME_PROVEN, `audit-operations/evidence/runtime/PR-A2-matrix.json`); PR-A9-enterprise (REAL_DB_PROVEN, `audit-operations/evidence/runtime/PR-A9-enterprise.json`)

### OPS-022 — Real BullMQ failures and retries never reach any Operations surface; persisted retryCount is hard-coded 0

- Severity / status: P2 / CONFIRMED (prior: CONFIRMED)
- Category: OBSERVABILITY_GAP; scope: PLATFORM_GLOBAL
- Affected: plans ALL; personas platform admin; workspaces n/a
- Source: `services/worker/src/telemetry.ts` (`retryCount: 0,`)
- Reproduction: A job failing 3 attempts on search-indexing: 0 OperationalIncident rows anywhere; the real worker sampler persisted failedCount 1, retryCount 0. Platform queue console shows queue health (outage during a Redis pause); customer summary unaffected (correct separation).
- Expected: Repeated job failure is a platform condition with stable identity.
- Actual: job.background_failure has no producer.
- User impact: Platform operators learn of failures only from logs.
- Security/privacy: None.
- Canonical owner: Platform queue console; Operations duplicates: false 
- Remediation boundary: Platform-scope producer from worker failed events (final attempt), keyed (queue, jobName, errorClass).
- Regression proof required: Failing job N times -> one PLATFORM condition; success closes it.
- Files a remediation may touch: services/worker/src/index.ts, services/worker/src/telemetry.ts; must not duplicate: services/api/src/services/operations/queue-inventory.service.ts
- Data reconciliation: No.; Production/owner action: Deploy worker.
- Proofs: PR-A7-queue-truth (RUNTIME_PROVEN, `audit-operations/evidence/runtime/PR-A7-queue-truth.json`)

### OPS-023 — Storage add-on condition wording/category: PENDING titled 'still billing', MANUAL title replaced, category STORAGE

- Severity / status: P2 / CONFIRMED (prior: CONFIRMED)
- Category: WORDING_TRUTH; scope: BILLING_ACCOUNT
- Affected: plans paid personal/team/enterprise payers; personas owners; workspaces all
- Source: `services/api/src/services/billing/dependent-cancellation-conditions.service.ts` (`billing_dependent_cancellation`)
- Reproduction: PENDING obligation seconds after request is titled 'still billing after cancellation'; MANUAL_INTERVENTION stored title 'support needed' is projected as the generic label; provider-unavailable retry is not distinguished; category STORAGE routes to platform-storage guidance.
- Expected: Wording reflects state (pending / retrying / provider unavailable / needs support).
- Actual: One label for all.
- User impact: Misstates billing status.
- Security/privacy: None.
- Canonical owner: Billing; Operations duplicates: false 
- Remediation boundary: State-specific wording from the billing authority; a BILLING category or source-keyed remediation.
- Regression proof required: Each state renders its own title and the Billing deep link.
- Files a remediation may touch: services/api/src/services/billing/dependent-cancellation-conditions.service.ts, services/api/src/services/operations/remediation-registry.ts; must not duplicate: —
- Data reconciliation: No.; Production/owner action: Deploy.
- Proofs: PR-A3-storage-addon (REAL_DB_PROVEN, `audit-operations/evidence/runtime/PR-A3-storage-addon.json`)

### OPS-024 — Queue replay eligibility admits completed jobs; BullMQ then refuses and the API reports 404 'job_not_found'

- Severity / status: P3 / PARTIALLY_CONFIRMED (prior: CONFIRMED)
- Category: REPLAY_SAFETY; scope: PLATFORM_GLOBAL
- Affected: plans n/a; personas platform admin; workspaces n/a
- Source: `services/api/src/services/operations/queue-replay-action.service.ts` (`job.retry()`)
- Reproduction: Replay of a completed job: 404 'Replay failed.' and the job stays completed. Two concurrent replays of a failed job: one 200, one 400 job_not_failed (BullMQ state prevents the duplicate). Customer owner: 403.
- Expected: Completed work is refused with a precise reason; idempotency is explicit.
- Actual: Duplicate side effects were NOT observed (refuted half); the misleading completed-job eligibility and 404 mapping are confirmed.
- User impact: Misleading operator feedback.
- Security/privacy: None.
- Canonical owner: queue-replay-action.service.ts; Operations duplicates: false 
- Remediation boundary: Refuse completed jobs in the eligibility check; map retry errors precisely; record previousState from BullMQ.
- Regression proof required: Replay of completed -> 409 job_completed; audit carries the true previous state.
- Files a remediation may touch: services/api/src/services/operations/queue-replay-action.service.ts; must not duplicate: —
- Data reconciliation: No.; Production/owner action: Deploy.
- Proofs: PR-A7-queue-truth (RUNTIME_PROVEN, `audit-operations/evidence/runtime/PR-A7-queue-truth.json`)

### OPS-025 — /v1/investigation/diagnostics returns another tenant's queue job failure text to any workspace member

- Severity / status: P1 / NEW (prior: )
- Category: CROSS_TENANT_DISCLOSURE; scope: PLATFORM_GLOBAL exposed to WORKSPACE
- Affected: plans ALL; personas VIEWER and up of any workspace; workspaces all
- Source: `services/api/src/services/investigation-diagnostics.service.ts` (`lastError = top.failureReason`)
- Reproduction: A tenant-B report job fails with a message naming B's evidence/team; a VIEWER of tenant A GETs /v1/investigation/diagnostics?teamId=A: queues.report.lastError contains tenant B's message and identifiers.
- Expected: Workspace diagnostics contain only the workspace's own data; global queue state only on the platform plane.
- Actual: Newest failed job of each global queue is returned verbatim.
- User impact: Cross-tenant data leakage.
- Security/privacy: Cross-tenant disclosure of identifiers and error text (P1).
- Canonical owner: Platform queue console; Operations duplicates: true Customer route duplicates platform queue inspection.
- Remediation boundary: Remove global queue fields from tenant diagnostics (or move the route behind requirePlatformAdmin).
- Regression proof required: Tenant-A VIEWER never receives another tenant's failure text or ids.
- Files a remediation may touch: services/api/src/services/investigation-diagnostics.service.ts; must not duplicate: services/api/src/services/operations/queue-inventory.service.ts
- Data reconciliation: No (read path).; Production/owner action: Deploy promptly; assess Production exposure (blocked: no Production access).
- Proofs: PR-A9-exposure (RUNTIME_PROVEN, `audit-operations/evidence/runtime/PR-A9-exposure.json`)

### OPS-026 — /v1/runtime/secrets-health gives any member (VIEWER) the secrets posture: secret names, presence, AWS secret/region, fallback mode

- Severity / status: P2 / NEW (prior: )
- Category: DISCLOSURE; scope: PLATFORM_GLOBAL exposed to WORKSPACE
- Affected: plans ALL; personas VIEWER and up; workspaces all
- Source: `services/api/src/routes/runtime-secrets-health.routes.ts` (`/v1/runtime/secrets-health`)
- Reproduction: VIEWER GET /v1/runtime/secrets-health -> 200 with health.secretName/region/fallbackMode and migrated[] of secret names with presence flags.
- Expected: Platform admin only.
- Actual: Gate identity.member.read.
- User impact: Infrastructure posture disclosure.
- Security/privacy: Secret inventory and configuration disclosure.
- Canonical owner: Platform Admin; Operations duplicates: false No admin page exists for it.
- Remediation boundary: requirePlatformAdmin; add to the platform control plane.
- Regression proof required: VIEWER 403; platform admin 200.
- Files a remediation may touch: services/api/src/routes/runtime-secrets-health.routes.ts; must not duplicate: —
- Data reconciliation: No.; Production/owner action: Deploy.
- Proofs: PR-A9-exposure (RUNTIME_PROVEN, `audit-operations/evidence/runtime/PR-A9-exposure.json`)

### OPS-027 — No writer produces PLATFORM scope; provider-credential conditions are stored LEGACY_UNSCOPED with an hourly fingerprint and no resolver

- Severity / status: P2 / NEW (prior: )
- Category: SCOPE_MODEL; scope: PROVIDER_GLOBAL stored as LEGACY_UNSCOPED
- Affected: plans n/a; personas platform admin; workspaces n/a
- Source: `services/api/src/services/billing/pending-payments.service.ts` (`billing.provider_authorization`); `services/api/src/services/observability/incident-scope.ts` (`export function platformIncidentWhere`)
- Reproduction: recordIncident(teamId null, billing.provider_authorization) twice in different hours -> two LEGACY_UNSCOPED rows; platformIncidentWhere (scope=PLATFORM) excludes them; nothing resolves them.
- Expected: Provider-wide conditions are PLATFORM scope, deduplicated, and close on recovery.
- Actual: Unscoped accumulation.
- User impact: Platform operators miss or drown in provider credential conditions.
- Security/privacy: None.
- Canonical owner: Incident scope authority; Operations duplicates: false 
- Remediation boundary: Use scopeForDeclaration({kind:'PLATFORM'}) for provider/platform writers; stable fingerprint; recovery on next successful provider call.
- Regression proof required: Provider auth failure -> one PLATFORM row; success closes it.
- Files a remediation may touch: services/api/src/services/billing/pending-payments.service.ts; must not duplicate: services/api/src/services/observability/incident-scope.ts
- Data reconciliation: Yes: classify existing LEGACY_UNSCOPED provider rows.; Production/owner action: Deploy + classification.
- Proofs: PR-A6-no-auto-resolver (REAL_DB_PROVEN, `audit-operations/evidence/runtime/PR-A6-no-auto-resolver.json`)

### OPS-028 — Report-failure recovery is proven by a DB row without verifying the stored object

- Severity / status: P3 / NEW (prior: )
- Category: INTEGRITY_TRUTH; scope: EVIDENCE_RECORD
- Affected: plans Report-entitled; personas any; workspaces all
- Source: `services/api/src/services/operations/operations-source-probes.ts` (`async function observeEvidenceArtifact`)
- Reproduction: Report row with a non-existent bucket/key created after the failure -> condition RESOLVED.
- Expected: Recovery requires the canonical artifact authority's verified state.
- Actual: Row presence only.
- User impact: A missing artifact can close its failure condition.
- Security/privacy: Output integrity.
- Canonical owner: Evidence output lifecycle / artifact verification; Operations duplicates: false 
- Remediation boundary: Use the canonical 'artifact published & verified' predicate.
- Regression proof required: Row without object keeps the condition open.
- Files a remediation may touch: services/api/src/services/operations/operations-source-probes.ts; must not duplicate: —
- Data reconciliation: No.; Production/owner action: Deploy.
- Proofs: PR-A4-report-package (REAL_DB_PROVEN, `audit-operations/evidence/runtime/PR-A4-report-package.json`)

### OPS-029 — Resolve is a dead control for sources that require a resolution note: the web sends no note and has no field

- Severity / status: P2 / NEW (prior: )
- Category: DEAD_ACTION; scope: WEB + API
- Affected: plans Operations-entitled; personas owner/admin/member; workspaces all
- Source: `apps/web/app/(app)/operations/page.tsx` (`runTransition`); `packages/shared-runtime/src/incident-transition-authority.ts` (`RESOLUTION_NOTE_REQUIRED`)
- Reproduction: POST resolve without a note on a governance.policy_condition -> 409 RESOLUTION_NOTE_REQUIRED (runtime); the web posts only {teamId} (source).
- Expected: A visible Resolve collects the required note.
- Actual: Every such Resolve fails with a generic banner.
- User impact: Operators cannot close operator-decision conditions from the web.
- Security/privacy: None.
- Canonical owner: incident-transition-authority; Operations duplicates: false 
- Remediation boundary: Note field driven by lifecycle.requiresResolutionNote.
- Regression proof required: Browser: resolve with note succeeds; without note the button is disabled.
- Files a remediation may touch: apps/web/app/(app)/operations/page.tsx, apps/web/app/(app)/operations/_components/IncidentInspector.tsx; must not duplicate: —
- Data reconciliation: No.; Production/owner action: Deploy web.
- Proofs: PR-A8-action-semantics (REAL_DB_PROVEN, `audit-operations/evidence/runtime/PR-A8-action-semantics.json`)

### OPS-030 — 'Stop notifying' (suppress) hides a live source-truth condition with no confirmation and no recorded reason

- Severity / status: P2 / NEW (prior: )
- Category: RISK_ACCEPTANCE; scope: WORKSPACE
- Affected: plans Operations-entitled; personas owner/admin; workspaces all
- Source: `apps/web/app/(app)/operations/_components/IncidentInspector.tsx` (`Stop notifying`)
- Reproduction: POST suppress with a reason -> 200, row SUPPRESSED, resolutionNote null (reason dropped); audit row observability.incident.suppressed exists; web/native have no confirm; refusal copy tells users to 'suppress it with a recorded reason'.
- Expected: Suppression is explicit risk acceptance: confirmation, reason, authority, audit.
- Actual: Reason silently discarded.
- User impact: A live billing/output/trust defect can be hidden without a record of why.
- Security/privacy: Governance/audit completeness.
- Canonical owner: incident.service transitionIncident; Operations duplicates: false 
- Remediation boundary: Require and persist a reason; confirmation in web/native.
- Regression proof required: Suppress without reason 400; with reason persisted and shown in history.
- Files a remediation may touch: services/api/src/routes/ops.routes.ts, services/api/src/services/observability/incident.service.ts, apps/web/app/(app)/operations/_components/IncidentInspector.tsx; must not duplicate: —
- Data reconciliation: No.; Production/owner action: Deploy.
- Proofs: PR-A8-action-semantics (REAL_DB_PROVEN, `audit-operations/evidence/runtime/PR-A8-action-semantics.json`); PR-B01-reem-view (BROWSER_PROVEN, `audit-operations/evidence/browser/PR-B01-reem-view.json`)

### OPS-031 — Remediation guidance and deep links are keyed by category, not source: wrong guidance and generic targets

- Severity / status: P2 / NEW (prior: )
- Category: ACTIONABILITY; scope: WORKSPACE
- Affected: plans Operations-entitled; personas all; workspaces all
- Source: `services/api/src/services/operations/remediation-registry.ts` (`This is platform infrastructure`); `services/api/src/services/operations/remediation-registry.ts` (`label: "Open evidence record"`)
- Reproduction: Billing condition (category STORAGE) shows 'platform infrastructure' guidance with no Billing link (runtime); 'Open evidence record' links to the /evidence library rather than the record (source).
- Expected: Source-specific canonical owner page links.
- Actual: Category-generic guidance.
- User impact: Wrong next action.
- Security/privacy: None.
- Canonical owner: Remediation registry (per source lifecycle); Operations duplicates: false 
- Remediation boundary: Key remediation by sourceId from OPERATIONS_SOURCE_LIFECYCLES; record-specific hrefs.
- Regression proof required: Each source renders its owner-page link.
- Files a remediation may touch: services/api/src/services/operations/remediation-registry.ts; must not duplicate: packages/shared-runtime/src/ops/source-lifecycle.ts
- Data reconciliation: No.; Production/owner action: Deploy.
- Proofs: PR-A3-storage-addon (REAL_DB_PROVEN, `audit-operations/evidence/runtime/PR-A3-storage-addon.json`); PR-B01-reem-view (BROWSER_PROVEN, `audit-operations/evidence/browser/PR-B01-reem-view.json`)

### OPS-032 — POST /v1/ops/workspace-reconcile reports started:false for the request that ran the reconciliation

- Severity / status: P3 / NEW (prior: )
- Category: CONTRACT_TRUTH; scope: WORKSPACE
- Affected: plans ALL; personas any operations.view; workspaces all
- Source: `services/api/src/routes/ops.routes.ts` (`"/v1/ops/workspace-reconcile"`)
- Reproduction: Five concurrent POSTs on a never-run workspace: exactly one run created (lock correct); the request that executed it inline answered started:false readiness READY, the others started:true alreadyRunning:true.
- Expected: The response states what happened.
- Actual: Inverted signal; no actor recorded on the run.
- User impact: Clients poll unnecessarily or misreport.
- Security/privacy: None.
- Canonical owner: operations-reconciliation.service; Operations duplicates: false 
- Remediation boundary: Return ran/alreadyRunning truthfully; pass triggeredByUserId.
- Regression proof required: The executing request reports ran:true.
- Files a remediation may touch: services/api/src/routes/ops.routes.ts; must not duplicate: —
- Data reconciliation: No.; Production/owner action: Deploy.
- Proofs: PR-A6-detector-failure (REAL_DB_PROVEN, `audit-operations/evidence/runtime/PR-A6-detector-failure.json`)

### OPS-033 — Projected titles replace stored titles with the source label: 120 distinct conditions all read 'Governance policy condition'

- Severity / status: P3 / NEW (prior: )
- Category: WORDING_TRUTH; scope: WORKSPACE
- Affected: plans Operations-entitled; personas all; workspaces all
- Source: `services/api/src/services/observability/incident.service.ts` (`conditionDisplayLabel`)
- Reproduction: Org workspace with 120 governance conditions titled 'ORG condition NNN' renders every row as 'Governance policy condition'; storage MANUAL_INTERVENTION 'support needed' renders as the generic label.
- Expected: Per-condition specific title (bounded, safe) with the source label as secondary.
- Actual: Indistinguishable rows.
- User impact: Operators cannot tell conditions apart.
- Security/privacy: None.
- Canonical owner: incident projection; Operations duplicates: false 
- Remediation boundary: Project a safe per-condition title.
- Regression proof required: Distinct stored titles render distinctly.
- Files a remediation may touch: services/api/src/services/observability/incident.service.ts; must not duplicate: —
- Data reconciliation: No.; Production/owner action: Deploy.
- Proofs: PR-B08-pagination (BROWSER_PROVEN, `audit-operations/evidence/browser/PR-B08-pagination.json`); PR-A3-storage-addon (REAL_DB_PROVEN, `audit-operations/evidence/runtime/PR-A3-storage-addon.json`)

### OPS-034 — Enterprise has no organization roll-up; Operations is strictly per workspace

- Severity / status: P3 / NEW (prior: )
- Category: PRODUCT_GAP; scope: ORGANIZATION
- Affected: plans ENTERPRISE; personas org owner/admin; workspaces organization
- Source: `services/api/src/routes/ops.routes.ts` (`async function requireOpsCapability`)
- Reproduction: One organization, three workspaces: isolation correct (each sees only its own; cross-workspace ack 404; org admin without membership 404; assignment excludes revoked/viewer). No organization-level incident route exists.
- Expected: If Enterprise promises roll-up, it reuses the same incident authority over authorized workspaces.
- Actual: Absent (no second engine — correct — but no roll-up).
- User impact: Org owners must open each workspace.
- Security/privacy: None.
- Canonical owner: Operations summary authority; Operations duplicates: false 
- Remediation boundary: Product decision; if built, union of buildOperationsSummary over authorized workspaces.
- Regression proof required: Roll-up count equals the union of per-workspace authorized counts.
- Files a remediation may touch: —; must not duplicate: services/api/src/services/operations/operations-summary.service.ts
- Data reconciliation: No.; Production/owner action: Product decision.
- Proofs: PR-A9-enterprise (REAL_DB_PROVEN, `audit-operations/evidence/runtime/PR-A9-enterprise.json`)

### OPS-035 — Native Operations: no reset on workspace switch, no refresh on foreground, English-only

- Severity / status: P3 / NEW (prior: )
- Category: NATIVE_STATE; scope: NATIVE
- Affected: plans Operations-entitled; personas mobile users; workspaces all
- Source: `apps/mobile/app/(stack)/operations/index.tsx` (`const teamId = platform.context?.activeTeamId ?? null;`)
- Reproduction: Source: filters, selection, open sheets not reset when activeTeamId changes; no AppState listener; ops strings hard-coded English. 156/156 mobile Operations tests pass but none covers these behaviours.
- Expected: Switch resets state; foreground refresh; localized.
- Actual: As described (source-proven; device runtime blocked).
- User impact: Stale or mis-targeted state on mobile.
- Security/privacy: A bulk action could carry previous-workspace ids (rejected server-side by tenancy).
- Canonical owner: Native Operations screen; Operations duplicates: false 
- Remediation boundary: Key screen state by teamId; AppState refresh; i18n.
- Regression proof required: Native unit tests for switch reset and foreground refresh.
- Files a remediation may touch: apps/mobile/app/(stack)/operations/index.tsx; must not duplicate: apps/mobile/src/product/ops-console.ts
- Data reconciliation: No.; Production/owner action: Mobile release.
- Proofs: PR-N01-mobile-ops-tests (SOURCE_AND_TEST_PROVEN, `audit-operations/evidence/native/PR-N01-mobile-ops-tests.json`)

### OPS-036 — A failed grouped read renders '0 groups · 0 conditions … match these filters' in the default view

- Severity / status: P2 / NEW (prior: )
- Category: FALSE_EMPTY; scope: WEB
- Affected: plans Operations-entitled; personas all; workspaces all
- Source: `apps/web/app/(app)/operations/page.tsx` (`// A failed grouped read leaves the groups EMPTY rather than stale.`)
- Reproduction: Browser: fulfil GET /v1/ops/incident-groups with 500 on a workspace with 5 unresolved conditions: summary cards show 5, the default Grouped list shows '0 groups · 0 conditions' and the no-match state. A genuinely empty reconciled workspace correctly shows 'Workspace operations are clear' (B14); a failed flat read correctly shows 'temporarily unavailable' (B06).
- Expected: A failed read is shown as unavailable, never as an empty result.
- Actual: The catch branch sets groups to [] and the page renders the empty/no-match state; native shows 'Grouped conditions could not be loaded' (source).
- User impact: Operators read 'nothing here' while conditions exist.
- Security/privacy: None (false-empty presentation).
- Canonical owner: Web Operations page; Operations duplicates: false 
- Remediation boundary: Track a grouped-read error state and render UnavailableState, as the flat read and the native screen already do.
- Regression proof required: Browser: grouped 500 renders the unavailable state with Retry.
- Files a remediation may touch: apps/web/app/(app)/operations/page.tsx; must not duplicate: —
- Data reconciliation: No.; Production/owner action: Deploy web.
- Proofs: PR-B06-error-states (BROWSER_PROVEN, `audit-operations/evidence/browser/PR-B06-error-states.json`); PR-B14-empty-state (BROWSER_PROVEN, `audit-operations/evidence/browser/PR-B14-empty-state.json`)

## Persona / plan / workspace cells

| Cell | Dimension | Status | Proof |
|---|---|---|---|
| FREE (personal owner) | plan | EXERCISED_ALLOWED | PR-A2-matrix |
| PAYG (personal owner) | plan | EXERCISED_ALLOWED | PR-A2-matrix |
| PRO (personal owner) | plan | EXERCISED_ALLOWED | PR-A2-matrix |
| TEAM entitlement (personal owner) | plan | EXERCISED_ALLOWED | PR-A2-matrix |
| TEAM owned workspace (ACTIVE) | plan | EXERCISED_ALLOWED | PR-A2-matrix |
| ENTERPRISE organization workspace | plan | EXERCISED_ALLOWED | PR-A2-matrix |
| Internal TEAM grant (personal) | plan | EXERCISED_ALLOWED | PR-A2-matrix |
| Expired internal grant | plan | EXERCISED_ALLOWED | PR-A2-matrix |
| Revoked internal grant | plan | EXERCISED_ALLOWED | PR-A2-matrix |
| Cancelled paid subscription (owned TEAM CANCELED) | commercial | EXERCISED_ALLOWED | PR-A2-matrix |
| Lapsed paid subscription (owned TEAM PAST_DUE) | commercial | EXERCISED_ALLOWED | PR-A2-matrix |
| No active entitlement (owned TEAM INACTIVE) | commercial | EXERCISED_ALLOWED | PR-A2-matrix |
| Personal PRO entitlement past validUntil | commercial | EXERCISED_ALLOWED | PR-A2-matrix |
| Suspended account | commercial | NOT_APPLICABLE | No product authority for user-account suspension: the envelope hard-codes accountStatus "active" (services/api/src/services/platform-context/platform-context.service.ts) and no User column models suspension. Organization suspension is covered by ENT_SUSPENDED_ORG_OWNER. |
| Add-on cancellation pending | billing | EXERCISED_ALLOWED | PR-A3-storage-addon |
| Add-on cancellation failed (retrying) | billing | EXERCISED_ALLOWED | PR-A3-storage-addon |
| Add-on cancellation needs support | billing | EXERCISED_ALLOWED | PR-A3-storage-addon |
| Cancelled locally, active at provider (ACTION_REQUIRED) | billing | EXERCISED_ALLOWED | PR-A3-storage-addon |
| Provider confirmed, local row still ACTIVE (paid-through) | billing | EXERCISED_ALLOWED | PR-A3-storage-addon |
| Obligation withdrawn (NONE) by integrity guard | billing | EXERCISED_ALLOWED | PR-A3-storage-addon |
| Storage add-on active, nothing owed | billing | EXERCISED_ALLOWED | PR-A3b-billing-subjects |
| TEAM payer, provider unavailable | billing | EXERCISED_ALLOWED | PR-A3-storage-addon |
| Enterprise payer | billing | EXERCISED_ALLOWED | PR-A3b-billing-subjects |
| Workspace ownership transferred | billing | EXERCISED_ALLOWED | PR-A3b-billing-subjects |
| Lapsed personal payer | billing | EXERCISED_ALLOWED | PR-A3b-billing-subjects |
| Stale provider webhook | billing | NOT_APPLICABLE | No provider webhook confirms or reopens a dependent add-on obligation; CONFIRMED is written only by a provider call, reconciliation, or refused activation (services/api/src/services/billing/dependent-cancellation.service.ts). Provider read error is covered by ADDON_TEAM_PAYER (RETRY_SCHEDULED, PROVIDER_UNAVAILABLE). |
| Personal workspace owner | role | EXERCISED_ALLOWED | PR-A2-matrix |
| Personal workspace non-owner user | role | NOT_APPLICABLE | A personal workspace has exactly one member by construction (ensurePersonalWorkspace); there is no second-user shape. |
| TEAM owner | role | EXERCISED_ALLOWED | PR-A2-matrix |
| TEAM admin | role | EXERCISED_ALLOWED | PR-A2-matrix |
| TEAM member | role | EXERCISED_ALLOWED | PR-A2-matrix |
| TEAM viewer | role | EXERCISED_ALLOWED | PR-A2-matrix |
| Invited, not accepted | role | EXERCISED_REFUSED | PR-A2-matrix |
| Revoked member | role | EXERCISED_REFUSED | PR-A2-matrix |
| Suspended member | role | EXERCISED_REFUSED | PR-A2-matrix |
| Member with expired access | role | EXERCISED_REFUSED | PR-A2-matrix |
| Enterprise organization owner | role | EXERCISED_ALLOWED | PR-A2-matrix |
| Enterprise organization admin (no workspace membership) | role | EXERCISED_REFUSED | PR-A2-matrix |
| Enterprise workspace admin | role | EXERCISED_ALLOWED | PR-A2-matrix |
| Enterprise workspace member | role | EXERCISED_ALLOWED | PR-A2-matrix |
| Enterprise workspace viewer | role | EXERCISED_ALLOWED | PR-A2-matrix |
| Owner of a suspended organization | role | EXERCISED_REFUSED | PR-A2-matrix |
| Platform Admin on a tenant /v1/ops route (no membership) | role | EXERCISED_REFUSED | PR-A2-matrix |
| Platform Admin console /v1/admin/incidents | role | EXERCISED_ALLOWED | PR-A2-matrix |
| Unauthenticated | role | EXERCISED_REFUSED | PR-A2-matrix |
| User belonging to multiple workspaces | workspace | EXERCISED_ALLOWED | PR-A2-matrix |
| Enterprise organization with three workspaces | workspace | EXERCISED_ALLOWED | PR-A9-enterprise |
| Legacy personal record with no teamId | workspace | EXERCISED_ALLOWED | PR-A4-report-package |
| Evidence owned by a TEAM workspace | workspace | EXERCISED_ALLOWED | PR-A4b-recovery-entitled |
| Cross-workspace modification attempt | workspace | EXERCISED_ALLOWED | PR-A9-enterprise |
| Platform-scoped incident on tenant surface | workspace | EXERCISED_ALLOWED | PR-A2-matrix |
| Legacy-unscoped incident on tenant surface | workspace | EXERCISED_ALLOWED | PR-A2-matrix |
| Workspace switch in the browser | workspace | EXERCISED_ALLOWED | PR-B03-workspace-switch-inflight |
| Native app on a device/emulator | workspace | BLOCKED_EXTERNAL | No Android SDK/emulator, no Java runtime, and no iOS toolchain on this Windows host; native logic covered by 156 node tests (PR-N01) and source review. |

## Producer / resolver conservation

- **producersWithoutResolvers** (6): billing.dependent_cancellation_failed, evidence_integrity.ots_budget_exhausted, identity.idp_outage, pipeline.package_generation_denied, platform.worker_heartbeat_stale, review.escalation
- **resolversWithoutProducers** (0): none
- **unreachableCategories** (5): ai.condition, database.condition, integration.configuration_failure, job.background_failure, storage.condition
- **misleadingNames** (4): platform.telemetry_stale (OPS-001), queue.retry_storm (OPS-002), billing.dependent_cancellation_failed (OPS-023), search.indexing_failure (OPS-017)
- **rawMessageFingerprints** (2): P-package-generation-failed services/worker/src/processor.ts:6045, P-report-failure-dlq services/worker/src/processor.ts:5972
- **rawMessageSummaries** (1): P-report-failure-dlq services/worker/src/processor.ts:5972
- **leakingInternalData** (4): OPS-010 /v1/ops/health, OPS-016 raw worker summaries, OPS-025 /v1/investigation/diagnostics, OPS-026 /v1/runtime/secrets-health
- **duplicatedAcrossApiAndWorker** (0): none
- **wrongRecordVersionOrResource** (4): pipeline.report_generation_failed (OPS-004, OPS-028), billing.dependent_cancellation_failed personal add-ons (OPS-003), platform.worker_heartbeat_stale (OPS-009), evidence_integrity.tsa_failed / ots_failed (OPS-019)

## External blockers

- **BLK-NATIVE-DEVICE** — No Android SDK / emulator and no Java runtime on this Windows host, and no iOS toolchain on Windows. Native Operations UI could not be executed on a device or simulator. (affects: WS_NATIVE_DEVICE)
- **BLK-PRODUCTION-DATA** — Production must not be contacted. The exact Production rows behind the six observed conditions (Reem's add-on state, occurrence counts, reconciler interval/replicas, total team count for OPS-008 sizing) cannot be read. (affects: OPS-003, OPS-008, OPS-025)
- **BLK-STEP-UP-FACTORS** — Bulk actions require SMS or TOTP step-up; no SMS provider is configured locally and no TOTP enrolment exists for fixture users. (affects: PR-B07-bulk-outcome)
