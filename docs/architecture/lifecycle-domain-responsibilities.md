# Lifecycle Domain Responsibilities

## Executive Summary

Proovra exposes two production lifecycle surfaces with distinct lineages — `/governance/lifecycle` (Phase 4A "Governance Posture") and `/evidence-lifecycle` (Phase 4B "Lifecycle Operations"). A forensic audit (Phase-X lifecycle audit, Option D) found both surfaces are real, both have honest data flows, and neither can be retired without losing capability. The two surfaces are NOT duplicates: Surface A is the mutation-first operational console for enterprise lifecycle features; Surface B is the read-only aggregate posture overlay for governance officers. This document is the canonical contract for which surface owns which capability, how worker enforcement status is reported, and the rules for adding new lifecycle functionality.

---

## 1. Why Both Pages Exist

`/governance/lifecycle` (Surface B) shipped first as part of Phase 4A — Organization Governance. It was designed as a single read-only posture overlay aggregating retention coverage, legal-hold coverage and archive throughput for the org-admin / compliance-officer persona, sitting alongside the rest of the Governance pillar (Departments, Delegated Admin, Policies, Access Reviews, Cross-Org).

`/evidence-lifecycle` (Surface A) shipped later as Phase 4B — Enterprise Lifecycle. It introduced the six lifecycle capabilities that Phase 4A had only described in summary form: gated retention policy editor, legal-hold create/release, archive tier transitions, destruction request → review → certification, webhook subscriptions, and chain-transfer issuance. Each capability is a mutation surface (not just a read), each is gated behind a `FEATURE_*` entitlement, and each mutation enforces `requireDelegatedTierAny([...])`.

Both surfaces are in production, both are referenced by manifests in the verification package, both have RBAC contracts in tests, and both have working code paths today. The audit (file refs in section 4) concluded that retiring either one would break a live persona path: removing Surface B leaves governance officers without their aggregate overlay; removing Surface A leaves enterprise operators without the mutation console for the Phase-4B feature flags. The audit therefore recommended **Option D — keep both surfaces with redefined responsibilities**, with labels disambiguated ("Governance Posture" vs "Lifecycle Operations") and a documented capability ownership map so future work routes to the correct surface.

---

## 2. `/governance/lifecycle` Responsibility — Governance Posture (Surface B)

**Label:** Governance Posture. **Persona:** Org admins, compliance officers, auditors. **Mode:** read-only aggregate.

Surface B is the governance officer's posture dashboard. It is rendered by `apps/web/app/(app)/governance/lifecycle/page.tsx`. It is registered in the navigation registry at `apps/web/lib/navigation/routeRegistry.ts:505-519` as `governance.lifecycle`, `sidebarEligible: true`, domain `GOVERNANCE`, capability `LIFECYCLE_VIEW`, active-space `ORGANIZATION_ONLY`.

Surface B reads from Phase-4A governance data stores and worker-enforced lifecycle tables. It does **not** issue mutations. Its responsibility is to render an aggregate posture view answering "what is the current compliance state of evidence lifecycle across this organization", with bounded numeric tiles for retention coverage, hold coverage, archive throughput, and destruction review backlog.

The page already has the correct loading and error state — `page.tsx:98-101` sets `error` from `err?.message`, line 133 renders the error box, line 138 the loading fallback. This is the reference pattern that Surface A must mirror.

For the precise capability ownership across the worker-enforced Phase-4B tables that Surface B reads from, see Section 4.

---

## 3. `/evidence-lifecycle` Responsibility — Lifecycle Operations (Surface A)

**Label:** Lifecycle Operations. **Persona:** Enterprise operators with delegated tier (ORG_ADMIN / COMPLIANCE_OFFICER / DATA_PROTECTION_OFFICER). **Mode:** mutation-first console.

Surface A is the operational console for the six Phase-4B lifecycle capabilities. It is rendered by `apps/web/app/(app)/evidence-lifecycle/page.tsx` (landing dashboard) plus six sub-pages. It is registered in the navigation registry at `apps/web/lib/navigation/routeRegistry.ts:1443-1458` as `workspace.evidence_lifecycle`, `sidebarEligible: false`, domain `GOVERNANCE`, capability `LIFECYCLE_VIEW`, active-space `ORGANIZATION_ONLY`, `advancedByDefault: true`. Sidebar visibility intentionally remains off; the surface is reached via the Governance pillar landing, command palette, or cross-link from Surface B (no nav-visibility change in this phase per the non-negotiables).

Surface A landing page renders the `LifecycleDashboardProjection` from `GET /v1/lifecycle/dashboard` plus a `SUB_PAGES` list (`page.tsx:66-73`) of seven sub-tabs:

1. `/evidence-lifecycle` — Landing (dashboard tiles + sub-tab index)
2. `/evidence-lifecycle/retention` — Retention policy editor (gated `FEATURE_*` + delegated tier)
3. `/evidence-lifecycle/legal-holds` — Legal hold issue / release
4. `/evidence-lifecycle/archive` — Archive tier transitions (manual override)
5. `/evidence-lifecycle/destruction` — Destruction request → review → certification
6. `/evidence-lifecycle/webhooks` — Webhook subscription management
7. `/evidence-lifecycle/chain-transfers` — Chain-of-custody transfer issuance

Every mutation route reached from these sub-pages is independently gated by an entitlement check (`assertFeatureEntitlement` on the `FEATURE_*` constants enumerated in Section 5) and a `requireDelegatedTierAny([...])` check on the backend.

---

## 4. Capability Ownership Table

This is the canonical map of which surface reads, which surface writes, which Prisma table, which service file, and which (if any) worker actually enforces each capability. Pulled from the read-only forensic audit. File:line citations are anchors against the repo state at the time of writing.

| Capability        | Surface A reads | Surface A writes | Surface B reads | Surface B writes | Tables (A / B-overlay)                            | Service file                                                            | Worker                                                                                            | Actual data owner                |
| ----------------- | --------------- | ---------------- | --------------- | ---------------- | ------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------- |
| Retention         | yes             | yes              | yes (aggregate) | no               | `retention_policy_configs` (A) / `EvidenceRetentionPolicy` (B-overlay) | `services/api/src/services/lifecycle/retention.service.ts`              | `services/worker/src/governance/retention-reconciliation.worker.ts` (gated `RETENTION_RECONCILIATION_ENABLED`, services/worker/src/index.ts:771) | `EvidenceRetentionPolicy` (Phase-4B enforced) |
| Legal Hold        | yes             | yes              | yes (aggregate) | no               | `legal_holds` (A) + `EvidenceLegalHold` (B-overlay) | `services/api/src/services/lifecycle/legal-hold.service.ts` (compatibility shim reads both at :290 and :307) | n/a — synchronous evaluation per write                                                            | Both (shim resolves union)       |
| Archive           | yes             | yes              | yes (aggregate) | no               | `archive_tier_transitions` (A-owned)              | `services/api/src/services/lifecycle/archive.service.ts`                | `services/worker/src/governance/archive-tier-auto-transition.worker.ts` (gated `ARCHIVE_AUTO_TRANSITION_ENABLED`, services/worker/src/index.ts:947) | `archive_tier_transitions` (A)   |
| Destruction       | yes             | yes              | yes (aggregate) | no               | `destruction_requests` (A) / `DestructionExecution` (B-overlay) | `services/api/src/services/lifecycle/destruction.service.ts` (`executeDestruction` runs sync in-thread) | `services/worker/src/governance/destruction-orchestrator.worker.ts` (gated `DESTRUCTION_ORCHESTRATOR_ENABLED`, services/worker/src/index.ts:840) | `DestructionExecution` only — `destruction_requests` writes are NOT consumed by any worker |
| Webhooks          | yes             | yes              | no              | no               | webhook subscription tables (A-owned)             | `services/api/src/services/lifecycle/webhooks.service.ts`               | `services/worker/src/webhook-dispatcher.ts` (gated `WEBHOOK_DISPATCHER_ENABLED`, services/worker/src/index.ts:992) | A                                |
| Chain Transfers   | yes             | yes              | no              | no               | chain transfer tables (A-owned)                   | `services/api/src/services/lifecycle/chain-transfer.service.ts`         | n/a — runs inline on API request thread                                                           | A                                |

Backend dashboard endpoint: `services/api/src/routes/product-and-lifecycle.routes.ts:1204-1218` (`GET /v1/lifecycle/dashboard`, returns `{ dashboard }` envelope, projected by `projectLifecycleDashboard` into `LifecycleDashboardProjection` defined at `packages/shared/src/product-and-lifecycle.ts:341-390`).
Archive mutation endpoint: `services/api/src/routes/product-and-lifecycle.routes.ts:986-1010` (`POST /v1/lifecycle/archive/transition` — SINGULAR).

---

## 5. Worker / Enforcement Status Table

A capability is **fully operational** only when both (a) its `FEATURE_*` entitlement is granted to the team and (b) its enforcing worker is enabled in the worker process. If either is false the capability reports a lower status. The shared capability-status helper (introduced by Stream A under `packages/shared`) emits one of the values below and the dashboard projection extends `LifecycleDashboardProjection` with a `capabilities` map keyed by capability name.

| Capability      | Entitlement key                                           | Worker env flag                          | Status when both true              | Status when entitlement true + worker disabled | Status when entitlement true + writes-but-no-worker-reads | Status when entitlement false |
| --------------- | --------------------------------------------------------- | ---------------------------------------- | ---------------------------------- | ---------------------------------------------- | --------------------------------------------------------- | ----------------------------- |
| Retention       | `FEATURE_RETENTION` (covered under FEATURE_LIFECYCLE_DASHBOARD aggregate; per-capability key per shared constants L39-44) | `RETENTION_RECONCILIATION_ENABLED` (default `true`) | `FULLY_ENFORCED`                   | `WRITES_BUT_NOT_ENFORCED`                      | `WRITES_BUT_NOT_ENFORCED` (writes to `retention_policy_configs` w/o downstream reader) | `DISABLED`                    |
| Legal Hold      | `FEATURE_LEGAL_HOLD`                                       | n/a (synchronous evaluation)             | `FULLY_ENFORCED`                   | n/a                                            | n/a                                                       | `DISABLED`                    |
| Archive         | `FEATURE_ARCHIVE_TIERS`                                    | `ARCHIVE_AUTO_TRANSITION_ENABLED` (default `true`) | `FULLY_ENFORCED`                   | `WRITES_BUT_NOT_ENFORCED` (manual transitions still land; auto-tier promotion stops) | n/a                                                       | `DISABLED`                    |
| Destruction     | `FEATURE_DESTRUCTION_GOVERNANCE`                           | `DESTRUCTION_ORCHESTRATOR_ENABLED` (default `true`) | `FULLY_ENFORCED` (orchestrator path) | `WRITES_BUT_NOT_ENFORCED`                      | `WRITES_BUT_NOT_ENFORCED` (Surface A writes `destruction_requests` and runs `executeDestruction` inline — orchestrator path through `DestructionExecution` only fires when worker enabled) | `DISABLED`                    |
| Webhooks        | `FEATURE_WEBHOOKS`                                         | `WEBHOOK_DISPATCHER_ENABLED` (default `true`)       | `FULLY_ENFORCED`                   | `CONFIGURATION_ONLY` (subscriptions persisted, no delivery) | n/a                                                       | `DISABLED`                    |
| Chain Transfers | `FEATURE_CHAIN_TRANSFER`                                   | n/a (inline on API thread)               | `FULLY_ENFORCED`                   | n/a                                            | n/a                                                       | `DISABLED`                    |
| Lifecycle Dashboard | `FEATURE_LIFECYCLE_DASHBOARD`                          | n/a (read aggregate)                     | `READ_ONLY`                        | n/a                                            | n/a                                                       | `DISABLED` (403 with denial `ENTITLEMENT_REQUIRED` per `routes:1213`) |

All seven `FEATURE_*` constants are declared in `packages/shared/src/product-and-lifecycle.ts:39-45`. Worker flags are declared at `services/worker/src/index.ts:771`, `:840`, `:947`, `:992`. The capability-status helper introduced by Stream A is the single source of truth — UI surfaces MUST consume the projection's `capabilities` map; they MUST NOT recompute status client-side from raw counts.

Status vocabulary (frozen, additive only):

- `FULLY_ENFORCED` — entitlement granted AND enforcing worker (or synchronous path) active. Capability behaves as advertised.
- `READ_ONLY` — capability is a read aggregate; "enforcement" is not applicable.
- `WRITES_BUT_NOT_ENFORCED` — UI accepts mutations and persists them, but no downstream worker consumes them. Surface MUST display a warning chip.
- `CONFIGURATION_ONLY` — configuration is persisted; runtime side-effect (delivery / transition / orchestration) is paused.
- `DISABLED` — entitlement absent. UI must render the denial pattern (403 `ENTITLEMENT_REQUIRED`).
- `NOT_APPLICABLE` — reserved for capability/persona combinations where the question doesn't apply.

---

## 6. Permission Model

### Surface A (`/evidence-lifecycle`)

- Page-level gate: `LIFECYCLE_VIEW` capability (`routeRegistry.ts:1450`) + `requiredActiveSpace: "ORGANIZATION_ONLY"`.
- Sub-page gates: each sub-page requires the matching Phase-4B `FEATURE_*` entitlement on the team (Retention → `FEATURE_RETENTION`-aligned key; Legal Hold → `FEATURE_LEGAL_HOLD`; Archive → `FEATURE_ARCHIVE_TIERS`; Destruction → `FEATURE_DESTRUCTION_GOVERNANCE`; Webhooks → `FEATURE_WEBHOOKS`; Chain Transfers → `FEATURE_CHAIN_TRANSFER`; Landing dashboard → `FEATURE_LIFECYCLE_DASHBOARD`).
- Mutation gates: every mutation route applies `requireDelegatedTierAny([...])` (e.g. archive transition at `routes:988` uses `requireDelegatedTier("ORG_ADMIN")`).
- Denial response: HTTP 403 `{ denial, requiredTier, requestId }` — handled by `applyDenial` in `evidence-lifecycle/page.tsx:33-64`. Stream A widens `applyDenial` to handle ALL non-200 responses so non-entitlement errors no longer leave the page stuck on "Loading…".

### Surface B (`/governance/lifecycle`)

- Page-level gate: `LIFECYCLE_VIEW` capability (`routeRegistry.ts:511`) + `requiredActiveSpace: "ORGANIZATION_ONLY"`. Surface B additionally relies on the same `LIFECYCLE_VIEW` umbrella to authorize the read aggregate (no separate `governance.policy.read` capability exists in the routeRegistry today — the brief's reference to that capability is an aspirational target; the de-facto behaviour is `LIFECYCLE_VIEW`).
- No delegated-tier requirement (read-only).
- Denial response: standard 403; rendered by the page's `error` state at `page.tsx:98-101`,`:133`.

### Out-of-scope capability drift

The route registry declares `requiredCapabilities: ["DASHBOARD_VIEW"]` on four other routes (`routeRegistry.ts:239`, `:813`, `:831`, `:847`), while the lifecycle routes use `LIFECYCLE_VIEW`. The brief flagged a drift between a legacy `navigation-registry.ts:203` and `routeRegistry.ts:1450`; the legacy `navigation-registry.ts` file no longer exists in the tree, so the drift in practice is now only between `DASHBOARD_VIEW`-gated routes and `LIFECYCLE_VIEW`-gated routes elsewhere in `routeRegistry.ts`. This drift is **out of scope** for this phase — recorded in Section 8 (Remaining Debt) and not touched here.

---

## 7. Route Strategy

- **URLs are unchanged.** `/governance/lifecycle` and `/evidence-lifecycle` (with its six sub-pages) keep their current paths. No new pages, no v2 routes.
- **No 308 redirects.** Neither surface is being collapsed into the other. The audit's Option D explicitly preserves both.
- **Labels updated.** Surface A label is "Lifecycle Operations" everywhere it appears (route registry, command palette, breadcrumbs, page heading). Surface B label is "Governance Posture" everywhere it appears. The two are NEVER both labelled "Lifecycle".
- **Cross-links added.** Surface B's landing renders a "Open Lifecycle Operations" call-to-action linking to `/evidence-lifecycle` for officers with the necessary entitlement + tier; Surface A's landing renders a "View Governance Posture" link back to `/governance/lifecycle` for the read aggregate.
- **Sidebar visibility unchanged.** Surface B remains `sidebarEligible: true` (governance pillar). Surface A remains `sidebarEligible: false`; it is reached through Governance landing, command palette, or the cross-link from Surface B. Per the non-negotiables, no global sidebar refactor and no workspace-model changes.
- **Backend routes unchanged.** No new HTTP routes are introduced. The pre-existing dashboard endpoint at `services/api/src/routes/product-and-lifecycle.routes.ts:1204-1218` and the existing mutation endpoints (e.g. archive transition at `:986-1010`) remain the canonical contracts.

---

## 8. Remaining Debt

These items are KNOWN gaps documented honestly. None are fixed in this phase. Each is tracked so future work routes correctly.

a. **Retention write-without-reader (Surface A).** Surface A writes `retention_policy_configs` via `retention.service.ts`. NO worker reads this table. Worker enforcement runs against `EvidenceRetentionPolicy` (Phase-4B), populated by a separate ingestion path. Until a reconciler bridges `retention_policy_configs` → `EvidenceRetentionPolicy`, the Retention capability MUST report `WRITES_BUT_NOT_ENFORCED` whenever Surface A is the active writer.

b. **Destruction async orchestrator gap (Surface A).** Surface A writes `destruction_requests` and calls `executeDestruction` synchronously on the API thread. The `destruction-orchestrator.worker.ts` enforces against `DestructionExecution` rows produced by a different path. The two paths are not yet bridged, so a destruction queued through Surface A is executed inline (no async orchestration, no retry, no idempotency window). Capability status reports `WRITES_BUT_NOT_ENFORCED` for the orchestrator path until the bridge ships.

c. **Three audit-event channels.** Lifecycle mutations currently emit through three independent channels: `EvidenceLifecycleEvent` (4A), `CustodyEvent` (legacy custody stream), and a structured-log stub used by the orchestrator workers. These are not yet unified. Downstream consumers (verification package, audit transparency federator) read from one or two but not all three.

d. **Sub-tab mutation gating is partial.** Per Stream A's report, not every Surface-A sub-tab applies the `FEATURE_*` entitlement check on the front-end before showing the mutation control — backend gates always fire, but the UI sometimes shows a disabled-but-not-explained input rather than the standard denial chip. Closure of this gap is tracked separately.

e. **`DASHBOARD_VIEW` vs `LIFECYCLE_VIEW` capability drift.** Four non-lifecycle routes in `routeRegistry.ts` gate on `DASHBOARD_VIEW`, while the lifecycle routes gate on `LIFECYCLE_VIEW`. This is a vocabulary drift that should be resolved one direction or the other in a future cleanup. It is NOT a security gap (capabilities map to the same role hierarchy in `routeAccessResolver`), but it makes the capability vocabulary unnecessarily noisy.

---

## 9. Future Consolidation Rules

When adding a new lifecycle capability, follow these rules — they are the rule-of-record for future review:

1. **Pick ONE stack, then stay on it.** Either write through the Phase-4A `EvidenceRetentionPolicy` / `EvidenceLegalHold` / `DestructionExecution` lineage (worker-enforced) OR through the Phase-4B `retention_policy_configs` / `legal_holds` / `destruction_requests` lineage (operator-console). Do NOT write to both. If a new capability must straddle, add a one-way reconciler in the worker; do not let Surface A and Surface B both write the same table.

2. **New mutation → Surface A.** Any new mutation control (create, update, release, transition, certify, dispatch) lives on `/evidence-lifecycle` (or a new sub-tab thereof). It does NOT go on `/governance/lifecycle`. Surface B remains read-only by contract.

3. **New read aggregate → Surface B.** Any new aggregate posture metric (coverage %, backlog, throughput, lag) extends the `LifecycleDashboardProjection` and is rendered as a tile on `/governance/lifecycle`. It does NOT add a new chart to Surface A; Surface A's dashboard tiles are for operator situational awareness, not org-wide posture.

4. **Never expose a third lifecycle URL.** No `/lifecycle`, no `/v2/lifecycle`, no `/admin/lifecycle`, no `/compliance/lifecycle`. Two surfaces, forever. If the desire arises, the answer is to extend an existing surface or add a sub-tab to Surface A.

5. **New `FEATURE_*` entitlement → declare in `packages/shared/src/product-and-lifecycle.ts`.** All entitlement keys live in the frozen list at lines 39-44. Do not introduce ad-hoc string keys elsewhere.

6. **New worker → declare its enforcement status.** If you ship a new lifecycle capability and its worker is gated by a new env flag, you MUST extend the capability-status helper (Section 5) so the dashboard reports `WRITES_BUT_NOT_ENFORCED` when the worker is off. Silent partial enforcement is forbidden.

7. **Every error response MUST be HTTP-clean with a `requestId`.** No stack traces, no raw exception messages. The dashboard route (`product-and-lifecycle.routes.ts:1204`) and every mutation route use the central error handler. The frontend `applyDenial` widens to cover ALL non-200 responses so the page never silently hangs on Loading.

---

Audit reference: phase-X lifecycle forensic audit, Option D recommendation, file refs in section 4.
