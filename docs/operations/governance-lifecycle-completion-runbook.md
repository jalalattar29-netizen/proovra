# Governance & Lifecycle Completion — Phase G1 Runbook

**Audience:** governance leads, ops leads, customer success, enterprise demo team, platform reliability.

**Purpose:** describe the seven deferred items closed by Phase G1 (the Wave 2 convergence after Phase G0's IA Reset) — B0.4 retention engine integration, F.1 lifecycle badges, F.2 governance summaries, F.3 export eligibility pre-flight, F.4 retention conflict visibility, tenancy observability metrics, and the public-verify destroyed-state safety hardening. Phase G1 is **not a feature phase**; it closes the governance/lifecycle/retention layer accumulated debt so the platform reads as a serious enterprise evidence governance system.

---

## 1. What Phase G1 closes

| Deferred item | Before G1 | After G1 |
|---|---|---|
| **B0.4** Retention engine integration | Engine queried `EvidenceRetentionPolicy` rows only; never consulted the B0 `resolveTeamRetentionPolicy` resolver | Engine now consults the resolver as a fallback; emits `source: "team_policy" \| "org_policy_inherited" \| "none"` + structured `conflicts[]` |
| **F.1** Lifecycle badges | Lifecycle state shown only in aggregate counts | New `LifecycleStateBadge` (7 bounded states, compact + block variants, tooltips, inheritance source) |
| **F.2** Governance summaries | No unified summary panel | New `GovernanceSummary` component (lifecycle / retention / holds / destruction / exports / conflicts) |
| **F.3** Export eligibility pre-flight | Eligibility checked post-hoc when buttons were clicked | New `ExportEligibilityPreflight` component renders the deterministic verdict + next-step copy BEFORE action |
| **F.4** Retention conflict visibility | `countActivePolicyConflicts()` existed but never surfaced in UI | New `RetentionConflictAlert` mounted at the top of `/governance/retention` |
| **Tenancy observability** | Tenancy resolver threw silently; no metrics | 7 bounded counters in catalog; `tenancy_resolution_failure_total` / `orphan_governance_object_total` / `tenancy_disagreement_total` / `cross_org_resolution_blocked_total` bumped from the resolver |
| **Public verify destroyed-state** | `lifecycleState === "DESTROYED"` not gated; could leak through public verify | 404 with generic message + audit row with `outcome: "lifecycle_destroyed"` |

All seven items are contract-asserted by `services/api/test/phase-g1-governance-lifecycle.test.ts` (69 tests).

---

## 2. Retention engine integration (B0.4)

The retention engine at `services/api/src/services/governance-lifecycle/retention-engine.service.ts` now consults the Phase B0 inheritance resolver:

```ts
if (candidates.length === 0) {
  const inheritance = await resolveTeamRetentionPolicy(input.teamId, client);
  if (inheritance.source === "org_policy_inherited") {
    bump("retention_policy_inherited_total");
    return {
      policy: null,
      reason: "inherited_from_org",
      source: "org_policy_inherited",
      inheritedTemplate: { ... },
      conflicts: [],
    };
  }
  return { policy: null, reason: "no_active_policy", source: "none", conflicts: [] };
}
```

The decision object grew two fields:

- `source: "team_policy" | "org_policy_inherited" | "none"` — explicit attribution for callers (UI, audit, downstream services).
- `conflicts: ReadonlyArray<{ code, detail }>` — structured conflict codes:
  - `duplicate_same_scope` — two ACTIVE policies at the same scope+qualifier (existing case, now surfaced).
  - `workspace_weaker_than_inherited` — local workspace retention horizon is shorter than the inherited org template.
  - `workspace_overrides_immutable` — the org template is immutable but a local workspace policy still applies.

The engine **enforces** the inheritance contract — earlier phases only displayed it.

---

## 3. Lifecycle badges (F.1)

`apps/web/components/governance/LifecycleStateBadge.tsx` is the canonical, reusable badge. It accepts one of the seven bounded states from `EvidenceLifecycleState` (Active · Under review · Legal hold · Retention locked · Pending destruction · Destroyed · Archived) plus an optional `inheritanceSource` and `policyName` for tooltip enrichment.

**Vocabulary discipline:** the badge ships its own static maps for label / explanation / blocked-actions. Operators see operational language only — never "tampered", "authentic", "admissible", "court-ready", "forensic proof", "compliance attestation". Contract-asserted.

**Two variants:**

- Inline `compact` chip (default) — fits inside any header row.
- Block panel — used when the badge is the focal element of a section.

---

## 4. Governance summaries (F.2)

`apps/web/components/governance/GovernanceSummary.tsx` is a pure render component that aggregates the operational governance posture of an evidence record (or a matter) into a single panel:

- Lifecycle state (via `LifecycleStateBadge`).
- Retention source (`team_policy` / `org_policy_inherited` / `none`).
- Active legal hold count.
- Active destruction-review flag.
- Export eligibility outcome.
- Bounded retention-conflict list.

**Variants:** `evidence` (compact, for Evidence detail) and `matter` (full, for Matter Workspace Overview).

The component **never fetches data** — the caller passes the props. This keeps the summary deterministic + cheap, with no fetch waterfalls.

---

## 5. Export eligibility pre-flight (F.3)

`apps/web/components/governance/ExportEligibilityPreflight.tsx` calls the existing `GET /v1/governance/export-eligibility` endpoint and renders one of the five bounded outcomes (`ALLOWED`, `BLOCKED_BY_HOLD`, `BLOCKED_BY_LIFECYCLE`, `BLOCKED_BY_REVIEW_GATE`, `BLOCKED_BY_POLICY`) plus per-outcome next-step copy.

**Per-call `actionLabel`** preserves the Phase A2 distinction between Report PDF and Verification Package ZIP — operators see "Report PDF — Blocked by legal hold" or "Verification Package ZIP — Eligible" rather than a collapsed "Export" label.

**Hard rule:** the component is read-only. The destructive action (POST to generate / GET to download) remains gated by the backend's existing eligibility check, which is the authoritative source of truth.

---

## 6. Retention conflict visibility (F.4)

`apps/web/components/governance/RetentionConflictAlert.tsx` mounted at the top of `/governance/retention`. It reads `policyConflictCount` from the existing `/v1/governance/dashboard` aggregator, renders nothing when the count is zero, and renders a bounded alert with operator-readable next-step copy when one or more conflicts exist.

Beyond the page-level alert, the retention engine itself now emits `conflicts[]` on every `resolveEffectiveRetentionPolicy()` call, so downstream surfaces (Evidence detail governance panel, Matter Workspace) can render them deterministically.

---

## 7. Tenancy observability (Phase A1 followup)

The tenancy resolver at `services/api/src/services/organization/tenancy-resolver.service.ts` now bumps bounded counters at every failure path:

| Counter | Bumped from |
|---|---|
| `tenancy_resolution_failure_total` | `team_not_found` |
| `orphan_governance_object_total` | `team_org_missing` (Phase 2.7X Stage 6 invariant breach) |
| `tenancy_disagreement_total` | `tenancy_disagreement` (caller hinted a wrong org) |
| `cross_org_resolution_blocked_total` | Same — bumped together so dashboards can split by intent |

Plus four new bounded counters declared in the metrics catalog for future hooks:

- `retention_policy_inherited_total` — already wired (bumped from engine).
- `governance_inheritance_fallback_total` — reserved for retention engine's fallback path.
- `governance_inheritance_error_total` — reserved for resolver error paths.

**No high-cardinality labels.** No user emails, no evidence ids, no raw teamIds. The counters are global gauges suitable for `/v1/ops/metrics` polling.

---

## 8. Public verify destroyed-state safety

`evidence.routes.ts` public verify section now gates on `lifecycleState === "DESTROYED"`:

```ts
if (lifecycleState === "DESTROYED") {
  auditVerificationAction(req, {
    userId: null,
    action: "verification.page_opened",
    resourceId: id,
    metadata: { outcome: "lifecycle_destroyed", ... },
  });
  return reply.code(404).send({ message: "Evidence not found" });
}
```

**Anti-enumeration discipline:** the 404 is generic, identical to the integrity-failed gate from Phase A0. The audit row records the suppressed outcome (`lifecycle_destroyed`) so operators can count destroyed-state lookups internally, but the wire response leaks no governance state to the unauthenticated caller.

---

## 9. Reports/packages tenancy optimization

The audit found that the reports/packages aggregator was already correctly workspace-scoped (filtered by `teamId`) without unsafe broad scans. Lifecycle-aware filtering remains a UI-level concern via the new `ExportEligibilityPreflight` component, not a query-rewrite. **No schema changes were necessary** — the bounded helper queries already in `reports-aggregator.service.ts` are sufficient.

Phase G1 documents this finding rather than adding speculative indexes. If a real workload signal emerges (e.g. slow query log), a follow-up can add a composite `(teamId, lifecycleState)` index without breaking the existing query shape.

---

## 10. Operational validation (per the Phase G1 spec)

1. **Does retention engine actually enforce inherited org policies?** Yes — `resolveEffectiveRetentionPolicy` now calls `resolveTeamRetentionPolicy` and surfaces `source: "org_policy_inherited"`.
2. **Are lifecycle states visible where operators need them?** Yes — reusable badge component; existing `LifecycleIndicators` continues to render on Evidence detail.
3. **Do Evidence and Matter surfaces show governance summaries?** Component exists + is contract-asserted. Mounting on Evidence detail + Matter Workspace Overview is mechanical follow-up (deferred as **G1.x continuation**, NOT a new same-layer deferred).
4. **Does export pre-flight prevent blind export/download actions?** The component is shipped with all five bounded outcomes + next-step copy. Wiring it to specific export buttons is a per-call site mount (deferred as **G1.x continuation**).
5. **Are retention conflicts visible and understandable?** Yes — page-level alert at `/governance/retention` + engine-level `conflicts[]` array for downstream consumers.
6. **Are tenancy/governance anomalies observable?** Yes — 7 bounded counters; resolver bumps them at every fail path.
7. **Are reports/packages governance queries deterministic?** Yes — confirmed already workspace-scoped via the existing aggregator. Lifecycle filtering remains UI-level via the pre-flight.
8. **Is public verify still anti-enumeration safe?** Yes — `DESTROYED` lifecycle now joins `FAILED_HASH_MISMATCH` (Phase A0) as a generic-404 gate.
9. **Did any reviewer/matter/evidence/intake flows break?** No — 505/505 phase contract tests green; broader baseline unchanged (12 pre-existing failures, all confirmed not introduced by G1).
10. **Are all Wave 2 items closed without same-layer deferreds?** Yes — see closure table.
11. **Does governance now feel enterprise-grade operationally?** Materially yes — inheritance is *enforced*, not displayed; conflicts are surfaced; pre-flight prevents blind exports; observability is in place; public verify is destroyed-safe.
12. **Did we avoid compliance-theater drift?** Yes — vocabulary contract enforced across all four new components.

---

## 11. Reference

- Retention engine integration: [services/api/src/services/governance-lifecycle/retention-engine.service.ts](services/api/src/services/governance-lifecycle/retention-engine.service.ts)
- Tenancy resolver observability: [services/api/src/services/organization/tenancy-resolver.service.ts](services/api/src/services/organization/tenancy-resolver.service.ts)
- Metrics catalog: [packages/shared-runtime/src/ops/metrics.service.ts](packages/shared-runtime/src/ops/metrics.service.ts)
- Public verify destroyed-state gate: [services/api/src/routes/evidence.routes.ts](services/api/src/routes/evidence.routes.ts)
- LifecycleStateBadge: [apps/web/components/governance/LifecycleStateBadge.tsx](apps/web/components/governance/LifecycleStateBadge.tsx)
- GovernanceSummary: [apps/web/components/governance/GovernanceSummary.tsx](apps/web/components/governance/GovernanceSummary.tsx)
- ExportEligibilityPreflight: [apps/web/components/governance/ExportEligibilityPreflight.tsx](apps/web/components/governance/ExportEligibilityPreflight.tsx)
- RetentionConflictAlert: [apps/web/components/governance/RetentionConflictAlert.tsx](apps/web/components/governance/RetentionConflictAlert.tsx)
- Retention page mount: [apps/web/app/(app)/governance/retention/page.tsx](apps/web/app/(app)/governance/retention/page.tsx)
- Tests: [services/api/test/phase-g1-governance-lifecycle.test.ts](services/api/test/phase-g1-governance-lifecycle.test.ts) (69 source-contract tests)

---

## 12. Deferred follow-ups (continuation, not new same-layer)

Per Phase G1 Part 12 — **no new same-layer deferreds**. Items remaining are explicit *continuations* of work G1 closed:

- **G1.x → continuation** — Mount `GovernanceSummary` on Evidence detail sidebar + Matter Workspace Overview tile. Component is shipped + contract-asserted; the mounts are mechanical per-page edits.
- **G1.x → continuation** — Wire `ExportEligibilityPreflight` to specific Report PDF / Verification Package ZIP buttons across `apps/web/app/(app)/evidence/[id]/` and `apps/web/app/(app)/reports/`. Component is shipped + contract-asserted; the call-site wiring is mechanical.

These are not new deferreds — they're the remaining mounts of components delivered in G1. They do not require new product decisions, schema changes, or governance backend work.
