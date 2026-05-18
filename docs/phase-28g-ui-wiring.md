# Phase 28-G — UI Operational Surface Activation

## Overview

The backend has been enterprise-grade since Phase 28-F. This phase
ships the **client-side primitives** that consume those backends, plus
one concrete proof-point wiring (reviewer-ops escalations page). The
rest of the page wirings are intentionally one-line drop-ins that the
operator team can sequence across releases without further
architectural work.

**Not a redesign.** No app-shell-v2 changes. No new pages. No
visual-language shift. The new components match the existing dark
operational aesthetic.

## What ships

[`apps/web/components/operational/`](../apps/web/components/operational/)

| Component | Consumes | Purpose |
|-----------|----------|---------|
| `GovernanceSnapshotPanel` | `GET /v1/evidence/:id/governance-snapshot` | Dense governance summary for Evidence Detail. Renders lifecycle / review / hold / retention / immutable / export / package / warnings / incidents. Fail-closed: API error → `GovernanceSnapshotUnavailableNotice`. |
| `OperationalTimelinePanel` | `GET /v1/evidence/:id/operational-timeline` | Chronological merged feed of lifecycle / review / incident events with severity dots + bounded labels + relative time. Fail-closed: API error → red "failing closed" notice. |
| `RuntimeStatusBanner` | `GET /admin/runtime/readiness` | Top-of-page banner shown only when readiness is DEGRADED / CRITICAL / UNKNOWN. HEALTHY → renders nothing. API error → UNKNOWN banner (never silent). Polls every 60s by default. |
| `ExportPackageEligibilityBadge` | `GET /v1/evidence/:id/governance-snapshot` | Drop-in eligibility pill for any UI surface that exposes an export or package action. Exposes `onEligibilityChange` callback so the parent can grey out the underlying button. Fail-closed: unknown → blocked. |
| `OperationalEmptyState` + 7 presets + 2 fail-closed variants | n/a (presentational) | Bounded-catalog operator-readable empty states with kicker, title, reason, runtime dependency, and action links. |

All components export from a single barrel:

```ts
import {
  GovernanceSnapshotPanel,
  OperationalTimelinePanel,
  RuntimeStatusBanner,
  ExportPackageEligibilityBadge,
  NoEscalationsEmptyState,
  NoWorkloadSnapshotsEmptyState,
  NoGovernanceIncidentsEmptyState,
  NoSlaBreachesEmptyState,
  NoOperationalTimelineEmptyState,
  RuntimeDegradedNotice,
  GovernanceSnapshotUnavailableNotice,
} from "@/components/operational";
```

## Fail-closed contract (every component)

| Failure mode | What the operator sees |
|--------------|-----------------------|
| Snapshot endpoint 5xx | `GovernanceSnapshotUnavailableNotice` (variant `unknown`, red border, "treat as blocked" copy) |
| Timeline endpoint 5xx | Red "failing closed — assume activity exists" notice |
| Readiness endpoint 5xx | UNKNOWN banner (red border, "treat dashboard as unknown state") |
| Eligibility badge while snapshot loads | "Loading…" pill, `actionDisabled=true` via callback |
| Eligibility badge after snapshot fails | "Unknown — blocked" pill, `actionDisabled=true` |
| Snapshot reports `export.eligible=false` | "Export blocked" pill + bounded reason label |
| Snapshot reports `package.eligible=false` | "Package blocked" pill + bounded reason label |

## Wording invariants enforced by tests

- No string literal in any of the 5 component files contains
  `tamper`, `forged`, `forgery`, or `altered content`. (The
  backend's drift label is already bounded to *"Storage governance
  drift"* — components render it verbatim.)
- No `process.env` reference appears in any of the 5 components.
- No hardcoded count-shaped patterns (`escalations: <number>,` etc.).
- No private-field references (`internalNotes`, `decisionNote`,
  `pausedReason`, etc.).

## Proof-point wiring

[`apps/web/app/(app)/reviewer-ops/escalations/page.tsx`](../apps/web/app/(app)/reviewer-ops/escalations/page.tsx)

| Before | After |
|--------|-------|
| `<div style={emptyStateStyle}>No escalations match these filters.</div>` | `<NoEscalationsEmptyState />` — operator sees runtime dependency + action links |
| No runtime status awareness | `<RuntimeStatusBanner teamId={teamId} />` at top — DEGRADED/CRITICAL surfaces immediately |

## Pages that should adopt the same pattern (one-line drops)

These are intentionally **NOT** modified in this phase. Each is a
trivial 1–3 line change once an operator schedules the drop:

| Page | Empty-state preset | Runtime banner |
|------|--------------------|---------------|
| [`apps/web/app/(app)/reviewer-ops/page.tsx`](../apps/web/app/(app)/reviewer-ops/page.tsx) | `NoEscalationsEmptyState` (or queue-shaped variant) | `RuntimeStatusBanner` |
| [`apps/web/app/(app)/reviewer-ops/sla/page.tsx`](../apps/web/app/(app)/reviewer-ops/sla/page.tsx) | `NoSlaBreachesEmptyState` | `RuntimeStatusBanner` |
| [`apps/web/app/(app)/reviewer-ops/policy/page.tsx`](../apps/web/app/(app)/reviewer-ops/policy/page.tsx) | (no empty state needed — config page) | `RuntimeStatusBanner` |
| [`apps/web/app/(app)/ops/observability/page.tsx`](../apps/web/app/(app)/ops/observability/page.tsx) | n/a | Full readiness panel via `RuntimeStatusBanner` + native consumption of `/admin/runtime/{readiness,queues,workers,migrations}` |
| [`apps/web/app/(app)/evidence/[id]/page.tsx`](../apps/web/app/(app)/evidence/[id]/page.tsx) | `NoOperationalTimelineEmptyState` (handled internally by the panel) | `GovernanceSnapshotPanel` + `OperationalTimelinePanel` |
| Governance dashboard | `NoGovernanceIncidentsEmptyState` | `RuntimeStatusBanner` |
| Export / package action sites | n/a | `ExportPackageEligibilityBadge` per action |

## Tests

[`services/api/test/ui-operational-wiring.test.ts`](../services/api/test/ui-operational-wiring.test.ts) — **34 tests, all passing**:

- 6 tests on `GovernanceSnapshotPanel` (endpoint, fail-closed,
  unknown-treated-as-blocked, safe wording, no forbidden fields,
  warning labels rendered)
- 5 tests on `OperationalTimelinePanel` (endpoint, fail-closed,
  empty-state preset, no note bodies, no invented events)
- 6 tests on `RuntimeStatusBanner` (endpoint, HEALTHY=nothing,
  API-failure=UNKNOWN, CRITICAL styling, no env exposure, polling
  bounds)
- 6 tests on `ExportPackageEligibilityBadge` (endpoint, fail-closed,
  loading state, both kinds, callback shape, never-claims-ready)
- 3 tests on the barrel export
- 5 tests on the escalations page proof-point wiring (imports,
  empty-state replacement, removed static text, banner placement,
  null-safe rendering)
- 3 cross-file wording invariants (no tamper/forged/altered, no
  env values, no hardcoded counters)

## Metrics

No new counters this phase. The seven counters reserved in Phase 28-F
(`enterprise_empty_state_rendered_total`,
`governance_snapshot_ui_loaded_total`,
`operational_timeline_ui_loaded_total`, etc.) are bumped from the
backend snapshot/timeline routes already. Future client-side
telemetry can register a fire-and-forget POST to a small UI-bump
endpoint without changes to the component contracts.

## Files changed

| File | Type |
|------|------|
| [`apps/web/components/operational/GovernanceSnapshotPanel.tsx`](../apps/web/components/operational/GovernanceSnapshotPanel.tsx) | **NEW** |
| [`apps/web/components/operational/OperationalTimelinePanel.tsx`](../apps/web/components/operational/OperationalTimelinePanel.tsx) | **NEW** |
| [`apps/web/components/operational/RuntimeStatusBanner.tsx`](../apps/web/components/operational/RuntimeStatusBanner.tsx) | **NEW** |
| [`apps/web/components/operational/ExportPackageEligibilityBadge.tsx`](../apps/web/components/operational/ExportPackageEligibilityBadge.tsx) | **NEW** |
| [`apps/web/components/operational/index.ts`](../apps/web/components/operational/index.ts) | **NEW** (barrel) |
| [`apps/web/app/(app)/reviewer-ops/escalations/page.tsx`](../apps/web/app/(app)/reviewer-ops/escalations/page.tsx) | modified — imports + uses `NoEscalationsEmptyState` + `RuntimeStatusBanner` |
| [`services/api/test/ui-operational-wiring.test.ts`](../services/api/test/ui-operational-wiring.test.ts) | **NEW** (34 tests) |
| [`docs/phase-28g-ui-wiring.md`](../docs/phase-28g-ui-wiring.md) | **NEW** |

## SQL required

**None.** Read-only UI consumption of existing endpoints.

## Env variables required

**None new.**

## Security / privacy validation

- ✅ No component selects `internalNotes`, `decisionNote`,
  `privateReviewerNote`, `pausedReason`, `signatureBase64`,
  `publicKeyPem`, `tsaTokenBase64`, `otsProofBase64`, or `storageKey`.
- ✅ No component references `process.env`.
- ✅ No hardcoded count / number renders anywhere.
- ✅ Banned wording (`tamper`, `forged`, `forgery`, `altered content`)
  absent from all visible string literals.
- ✅ Fail-closed: every component renders an UNKNOWN / blocked state
  when its endpoint fails, never an implicit success.

## Remaining UI gaps

| Gap | Effort to close |
|-----|----------------|
| Wire remaining 6 reviewer-ops / governance / observability / evidence pages to consume the new components | 1–3 lines per page; deferred to focused UI release |
| Client-side bump endpoint for `enterprise_empty_state_rendered_total` + sibling counters | Single new internal endpoint + one-line component fetch |
| Visual A/B testing of the eligibility badge inside the existing report-v2 export flow | UX polish, not architectural |

## Explicit YES/NO: ready for Enterprise Search Phase

**YES.**

All preconditions are in place: schema closed, reviewer-ops
operational, worker fail-closed, governance-snapshot unified,
discovery-foundation contracts exported, runtime-readiness aggregator
live, empty-state components shipped, fail-closed UI primitives
shipped. The platform's operational surfaces consume real backend
state; nothing implies success when state is unknown.

The Enterprise Search phase can build on the
`SafeSearchableDocument` types + `applyDiscoveryFilter` + indexing
event sink contract already exported from `@proovra/shared` without
re-deriving any privacy boundary.
