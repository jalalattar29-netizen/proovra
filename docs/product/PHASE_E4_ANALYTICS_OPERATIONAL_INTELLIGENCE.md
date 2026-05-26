# PHASE E4 — Analytics & Operational Intelligence

**Status:** CLOSED
**Closure date:** 2026-05-25
**Test suite:** `services/api/test/phase-e4-analytics.test.ts`
**Routes:** `services/api/src/routes/analytics-operations.routes.ts`
**Service:** `services/api/src/services/analytics/analytics.service.ts`
**Frontend:** `apps/web/app/(app)/ops/analytics/page.tsx`

---

## 1. Intent

Phase E4 introduces a bounded operational-analytics surface that answers
"what is happening in the workspace right now" with REAL counts taken
from REAL Prisma tables. The surface lives UNDER the Operations Center
hub at `/ops/analytics` — it is not a new root nav item, and it does
not redesign the dashboard.

The single guiding principle: **every number on the page must be
traceable to a source table + filter, and the page must render an
honest empty / degraded state rather than a fabricated value.**

This is operational signal, not business intelligence. Phase E4
deliberately does NOT add:

- a BI builder / arbitrary analytics query builder
- charts of fabricated KPIs
- ML/AI predictions or anomaly detection
- legal-admissibility / authenticity / trust scores
- cross-team analytics
- a data-warehouse project
- new root navigation
- AI / collaboration / automation features (those have their own phases)

---

## 2. Surface

Five sections rendered on a single page:

| Section            | Source models                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| Operations overview | `Evidence`, `Case`, `EvidenceReviewWorkflow`, `ReviewEscalation`, `TeamMember`                     |
| Reviewer activity  | `EvidenceReviewWorkflow`, `ReviewEscalation`                                                        |
| Governance posture | `EvidenceLegalHold`, `CaseLegalHold`                                                                |
| Automation health  | `AutomationRule`, `AutomationRun`, `AutomationWebhookDelivery`, `AutomationWebhookDestination`     |
| Artifact readiness | `Report`, `VerificationPackage` (scoped through `evidence.teamId`)                                  |

The selector at the top of the page lets the operator pick a window
of 7 / 14 / 30 / 60 / 90 / 180 days. The window value is clamped
server-side to `[1, 180]` with default `30`. Invalid windows resolve
to the default rather than 400-ing — analytics is read-only and must
degrade gracefully.

---

## 3. Envelope contract

Every public service function returns:

```ts
type AnalyticsEnvelope<TMetrics> = {
  generatedAt: string;        // ISO timestamp the envelope was assembled
  window: {                   // bounded window the metrics were computed against
    days: number;
    start: string;
    end: string;
  };
  sourceTrace: ReadonlyArray<{
    metric: string;           // canonical metric key
    source: string;           // Prisma model name
    filter: string;           // human-readable filter description
    windowed: boolean;        // true if the metric depends on the time window
  }>;
  degradedSources: ReadonlyArray<string>; // models whose query failed in this call
  metrics: TMetrics;          // bag of `number | null` — null means degraded
};
```

The frontend uses `sourceTrace` to render the per-card "source: …"
badge. It uses `degradedSources` to render the amber "Data source
unavailable" warning. The metric value is `null` when degraded; the
page shows `—` rather than `0` so operators are never misled into
thinking a real zero count exists.

---

## 4. REST endpoints

All endpoints live under `/v1/analytics/*` and are registered via
`analyticsOperationsRoutes` (separate from the existing
`/v1/admin/analytics/*` admin marketing-analytics surface):

| Endpoint                          | Capability       | Notes                                  |
| --------------------------------- | ---------------- | -------------------------------------- |
| `GET /v1/analytics/operations`    | `ANALYTICS_VIEW` | Workspace pulse                        |
| `GET /v1/analytics/reviewer`      | `ANALYTICS_VIEW` | Reviewer queue + SLA                   |
| `GET /v1/analytics/governance`    | `ANALYTICS_VIEW` | Legal-hold posture                     |
| `GET /v1/analytics/automation`    | `ANALYTICS_VIEW` | Rule + run + delivery counts           |
| `GET /v1/analytics/artifacts`     | `ANALYTICS_VIEW` | Reports + verification-package counts  |
| `GET /v1/analytics/_window`       | (auth only)      | Exposes the bounded window contract    |

Every endpoint:

1. Requires authentication (`requireAuth` preHandler).
2. Validates `teamId` as a uuid and `window` as a coerced positive int.
3. Resolves team membership; non-members get **403** (no cross-team
   leakage is structurally possible — the membership lookup happens
   before the analytics call).
4. Resolves capability via `resolveCapabilities()` and rejects with
   **403** if `ANALYTICS_VIEW` is not granted.
5. Returns **200** with the envelope on success. Even partial failures
   (some metrics degraded) still return 200 — analytics is best-effort
   and must not block ops dashboards.

No mutation verbs are registered in this file. Source-level tests
assert this.

---

## 5. Capability gating

`ANALYTICS_VIEW` is added to `CAPABILITY_KEYS` in both
`services/api/src/services/platform-context/types.ts` and
`apps/web/lib/platform-context/types.ts`. The resolver grants it to
team writers and admins (the same block as `AUTOMATION_VIEW`):

| Caller                          | `ANALYTICS_VIEW` |
| ------------------------------- | ---------------- |
| TEAM · OWNER                    | ✅               |
| TEAM · ADMIN                    | ✅               |
| TEAM · MEMBER                   | ✅               |
| TEAM · VIEWER                   | ❌               |
| PERSONAL · OWNER (self)         | ✅ (via writer)  |
| no workspace                    | ❌               |

Platform admins do **not** silently get cross-team analytics — they
still need explicit team membership. This preserves the no-leakage
guarantee.

---

## 6. Source-trace examples

The operations overview returns this `sourceTrace`:

```json
[
  { "metric": "evidenceCreated", "source": "Evidence",
    "filter": "teamId + createdAt>=window", "windowed": true },
  { "metric": "evidenceFinalized", "source": "Evidence",
    "filter": "teamId + status=REPORTED + createdAt>=window", "windowed": true },
  { "metric": "openCases", "source": "Case",
    "filter": "teamId + status=OPEN", "windowed": false },
  { "metric": "openReviewWorkflows", "source": "EvidenceReviewWorkflow",
    "filter": "teamId + status not in (APPROVED_INTERNAL, CLOSED)", "windowed": false },
  { "metric": "openEscalations", "source": "ReviewEscalation",
    "filter": "teamId + status=OPEN", "windowed": false },
  { "metric": "reviewerCount", "source": "TeamMember",
    "filter": "teamId + role in (OWNER, ADMIN, MEMBER)", "windowed": false }
]
```

The frontend renders each tile with a hover-revealing `title`
attribute showing the full source / filter / windowed triplet.

---

## 7. Report + VerificationPackage scoping

These two models are linked to a workspace **through `Evidence`**, not
via their own `teamId` column. The service scopes them as:

```ts
prisma.report.count({
  where: {
    generatedAtUtc: { gte: windowStart },
    evidence: { teamId: input.teamId },
  },
})
```

This is structurally important — it means a delete of the Evidence
row cascades the artifact away, and cross-team leakage requires
bypassing the relation filter (which Prisma does not allow). The E4
test suite pins this exact filter shape.

---

## 8. Frontend page

`apps/web/app/(app)/ops/analytics/page.tsx` is wrapped in
`PageRouteGate routeId="platform.analytics"`, which enforces the
ANALYTICS_VIEW capability and the OPS domain gate.

The page calls all 5 endpoints in parallel via `apiFetch` and renders
five sections of metric cards. Each card shows:

- the metric label
- the value (or `—` if degraded)
- a sub-line hint describing the filter applied
- the source-trace badge ("source: Evidence · windowed")
- an amber warning when the source is degraded

The window selector is bounded to exactly the canonical day values
(7 / 14 / 30 / 60 / 90 / 180). The frontend never invents windows or
allows arbitrary numeric input.

---

## 9. Architecture invariants preserved

- 32.8 IA: root nav stays at the 6 canonical primaries. The new page
  registers as `sidebarEligible: false`.
- No new client-state library (`react-query`, `swr`, `zustand`, etc.).
- No new queue / pubsub library on the API side.
- No new state-management framework on the web side.
- No mutation of evidence / custody / report / package state. Source-
  level test asserts the service contains zero `.create(` / `.update(`
  / `.delete(` calls.
- No `eval` / `new Function` / scripting.
- No remote fetch / Kafka / pubsub imports.
- File-size pins on the protected core files unchanged.
- No new Prisma migration in E4 — the schema is unchanged.

---

## 10. Test inventory

`services/api/test/phase-e4-analytics.test.ts` covers 9 test groups:

1. Bounded window constants + `clampWindow` (9 cases).
2. `ANALYTICS_VIEW` capability registered + role gating (7 cases).
3. Analytics service source contract — 5 functions, envelope shape,
   `safe()` wrapper, bounded queries, no mutation, no forbidden
   imports, no legal claims, non-empty `sourceTrace` per function
   (11 cases).
4. REST endpoints — 5 GETs registered, auth+capability gate, zod
   uuid validation, no mutation verbs, server registration order
   (8 cases).
5. Route registry — `platform.analytics` under `/ops/analytics`,
   ANALYTICS_VIEW required, `sidebarEligible: false`, 32.8 root
   nav still bounded at 6 (4 cases).
6. Frontend page — `PageRouteGate` wrapper, all 5 endpoints called,
   honest degraded sentinel, source-trace badges, no
   legal/admissibility language, no BI-builder affordances, bounded
   window options (7 cases).
7. File-size pins on the 5 protected core files (5 cases).
8. No new client-state / queue libraries on either web or api side
   (2 cases).
9. Documentation + master registry updated (2 cases).

Total: **55 cases**.

---

## 11. CR1.7 closure summary

- **Entry-gate checklist:** completed in writing before any code edit.
- **Files modified or added:**
  - `services/api/src/services/platform-context/types.ts` (added
    `ANALYTICS_VIEW`).
  - `services/api/src/services/platform-context/capability-registry.ts`
    (granted to writers).
  - `apps/web/lib/platform-context/types.ts` (mirror).
  - `services/api/src/services/analytics/analytics.service.ts` (new).
  - `services/api/src/routes/analytics-operations.routes.ts` (new).
  - `services/api/src/server.ts` (route registration).
  - `apps/web/lib/navigation/routeRegistry.ts` (platform.analytics).
  - `apps/web/app/(app)/ops/analytics/page.tsx` (new).
  - `services/api/test/phase-e4-analytics.test.ts` (new, 55 cases).
  - `docs/product/PHASE_E4_ANALYTICS_OPERATIONAL_INTELLIGENCE.md` (this file).
  - `docs/recovery/MASTER_PHASE_REGISTRY.md` (E4 row added).

- **No new DEFs opened.** Phase E4 is self-contained — the source-trace
  envelope, bounded window, and capability gate are all closed-form
  contracts. Future analytics work (per-rule timing histograms, escalation
  age distributions, CSV export) would be tracked as new phases rather
  than as open debt on E4.

- **No migration drift allow-list update required** — Phase E4 does not
  ship a Prisma migration.

- **Inverse-pin flips:** none required. No DEFs were resolved by E4.

---

## 12. Out of scope (deliberate)

These are explicitly NOT in Phase E4 and should not be retrofitted
without a new phase definition:

- per-reviewer or per-user activity feeds (would expose contributor
  identity beyond what governance allows)
- arbitrary user-defined metrics
- chart libraries beyond the bounded tile grid
- CSV / Excel export of analytics
- email / push digest of analytics changes
- comparison-to-previous-period bars
- ML-derived "predicted overdue" estimates
- legal admissibility scores, trust scores, authenticity scores
- cross-team aggregates for platform admins

The phase prompt forbade these explicitly, and the test suite pins the
forbidden surfaces by source-level grep.
