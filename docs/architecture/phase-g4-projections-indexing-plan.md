# Phase G4.4 — Projections + Indexing Plan

**Status:** living document. Captures the current index inventory + the
restrained set of candidates that need real query-plan validation before
landing.

**Rule:** the G4 phase explicitly forbids adding `organizationId` everywhere
blindly, premature analytics tables, or unjustified composite indexes. New
indexes ship only when query-plan data on a representative dataset
demonstrates a measurable win — and never as a side effect of an unrelated
PR.

---

## 1. Current index inventory (the indexes G4 inherits)

The schema is mature. The hot read paths already have indexes:

### Evidence (`evidence`)
- `[deletedAt]`, `[lifecycleState]`, `[retentionPolicyVersionId]`
- `[deletedAtUtc]`, `[deleteScheduledForUtc]`
- `[ownerUserId, deletedAt]`, `[ownerUserId, deleteScheduledForUtc]`,
  `[ownerUserId, createdAt(Desc)]`, `[ownerUserId, archivedAt]`,
  `[ownerUserId, status]`
- `[organizationId, createdAt(Desc)]`
- `[fileSha256]`, `[fingerprintHash]`
- `[teamId]`, `[status]`, `[archivedAt]`, `[lockedAt]`
- `[verificationStatus]`, `[recordedIntegrityVerifiedAtUtc]`,
  `[lastVerifiedAtUtc]`

### EvidenceReviewWorkflow (`evidence_review_workflows`)
- `[teamId]`, `[assignedToUserId]`, `[assignedByUserId]`, `[status]`,
  `[priority]`, `[dueAt]`
- `[slaStatus, dueAt]`, `[escalationLevel, status]`
- `[assignmentDueAtUtc]`, `[completionDueAtUtc]`

### ReviewEscalation (`review_escalations`)
- `[teamId, status]`, `[teamId, severity]`, `[teamId, reason]`
- `[workflowId, createdAt(Desc)]`, `[workflowInstanceId]`
- `[assignedToUserId, status]`, `[incidentId]`
- `unique [teamId, fingerprint]`

### Cases (Matters)
- `[ownerUserId]`, `[teamId]`, `[teamId, status]`, `[teamId, priority]`

### Audit / changelog
- `[caseId, changedAtUtc(Desc)]`, `[teamId, changedAtUtc(Desc)]`

### Reports + VerificationPackages
- Indexed via the `evidence_id` FK + sibling lifecycle columns
  (`status`, `version`).

### EvidenceLegalHold
- Indexed via `teamId` + `evidenceId` composite paths (existing schema).

---

## 2. Typed query helpers (shipped in G4)

| Helper | File | Purpose |
| --- | --- | --- |
| `resolveTenancyForWrite` | `services/api/src/services/organization/tenancy-resolver.service.ts` | Write-path tenancy projection (pre-G4) |
| `getOrganizationIdForTeam` | same | Direct team→org lookup, throws on Stage-6 violation (pre-G4) |
| `checkEvidenceTenancyInvariant` | same | Diagnostic, used by `evidence-tenancy-diagnostic.mjs` (pre-G4) |
| **`resolveEvidenceTenancyForRead`** | same | **NEW (G4.1).** Compatibility-read projection. Returns deterministic `{effectiveTeamId, effectiveOrganizationId, source}` for any evidence row — including legacy null-teamId rows — without mutating the row. |

The G4.1 helper is the only new query helper this phase ships. It is a pure
read projection (no DB writes) and is safe to use on the hot read paths:
governance rollups, audit feeds, cross-matter views, reports projection.

---

## 3. Restrained index candidates (NOT shipped — require query-plan data)

The G4.0 audit identified five composite indexes that **might** be justified
on a production-scale dataset. We deliberately did NOT ship them in G4
because:

1. The schema already has tightly-targeted indexes covering the same
   predicates (e.g. `[slaStatus, dueAt]` is a strong overlap with the
   proposed `[teamId, slaStatus, dueAt]`).
2. Adding more indexes increases write amplification on
   `EvidenceReviewWorkflow` (already 11+ indexes) without proven read wins.
3. The G4 spec is explicit: "Add only justified composite indexes."
   Justification requires real query-plan data, not theoretical analysis.

The candidates, with the EXPLAIN ANALYZE evidence each one needs before
landing:

### Candidate 1 — `EvidenceReviewWorkflow [teamId, assignedToUserId, status]`
- **Predicate it would serve:** the Reviewer Console "Mine" + "Unassigned"
  queue queries (`teamId=X AND assignedToUserId={null|me} AND status NOT IN
  (closed)`).
- **Evidence required:** EXPLAIN ANALYZE on a dataset with ≥50k workflows
  showing a plan switch from index scan on `[teamId]` (then filtered) to a
  bitmap index scan that includes assignedToUserId + status.
- **Decision rule:** ship ONLY if the win is >25% on the realistic query at
  ≥10k matching rows.

### Candidate 2 — `EvidenceReviewWorkflow [teamId, status, dueAt]`
- **Predicate it would serve:** dashboard SLA rollups
  (`teamId=X AND status NOT IN closed AND dueAt < now`).
- **Evidence required:** plan analyze showing the current
  `[slaStatus, dueAt]` index is bypassed because the predicate uses `status`
  rather than `slaStatus`.
- **Decision rule:** ship ONLY if `slaStatus` is provably NULL on a
  measurable fraction of rows (denormalised lag).

### Candidate 3 — `ReviewEscalation [teamId, status, createdAt(Desc)]`
- **Predicate it would serve:** the bounded escalations list paginated by
  recency (`teamId=X AND status=OPEN ORDER BY createdAt DESC LIMIT N`).
- **Evidence required:** the existing `[teamId, status]` index does not
  cover the orderBy; EXPLAIN must show a sort step in production.
- **Decision rule:** ship if the sort step is >100ms on ≥5k escalation rows.

### Candidate 4 — `EvidenceLegalHold [teamId, status, placedAtUtc(Desc)]`
- **Predicate it would serve:** governance rollups listing active holds by
  recency.
- **Evidence required:** confirm no existing composite covers
  `[teamId, status]` (audit at landing time — the schema has been evolving).

### Candidate 5 — `Evidence [organizationId, lifecycleState, deletedAt]`
- **Predicate it would serve:** org-wide lifecycle rollups for governance.
- **Evidence required:** the existing `[organizationId, createdAt(Desc)]`
  may already cover this if the planner can filter on `lifecycleState` from
  the projection — verify with EXPLAIN.

---

## 4. What G4.4 deliberately does NOT do

- **No new indexes** beyond what the schema already carries. Restraint per
  the G4 spec.
- **No new `organizationId` columns** on Report or VerificationPackage.
  Tenancy resolves through `evidence.teamId → team.organizationId`. Adding
  a direct column was reviewed and deferred — it would duplicate the source
  of truth, which the G4 spec explicitly forbids ("duplicate source of
  truth unsafely").
- **No analytics rollup tables.** The reviewer-ops + governance surfaces
  compute their projections on demand from indexed read paths; persistent
  rollups would add write amplification + drift risk for marginal read
  speedups.
- **No projection caches.** Operators see deterministic data from the
  source tables. Caching layers (Redis projection cache) are a future
  scaling concern documented separately in
  `shared-presence-deployment.md`'s style — not a code change in G4.

---

## 5. Acceptance criteria

- [x] G4.1 typed query helper (`resolveEvidenceTenancyForRead`) shipped.
- [x] Existing index inventory documented above.
- [x] Five restrained candidates documented with their pre-conditions for
      future PRs.
- [x] No new indexes added without justification.
- [x] No premature rollup tables.
- [x] No duplicated source of truth (Report/Package tenancy stays
      evidence-rooted).

---

## 6. Reference

- Tenancy resolver: [services/api/src/services/organization/tenancy-resolver.service.ts](../../services/api/src/services/organization/tenancy-resolver.service.ts)
- Schema: [services/api/prisma/schema.prisma](../../services/api/prisma/schema.prisma)
- Phase A1 migration (org tenancy NOT NULL): [services/api/prisma/migrations/20261001000000_phase_a1_evidence_org_tenancy](../../services/api/prisma/migrations/20261001000000_phase_a1_evidence_org_tenancy)
- Diagnostic script: [services/api/scripts/evidence-tenancy-diagnostic.mjs](../../services/api/scripts/evidence-tenancy-diagnostic.mjs)
