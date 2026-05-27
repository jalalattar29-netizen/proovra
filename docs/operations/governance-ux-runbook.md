# Governance UX — Phase F Runbook

**Audience:** governance leads, ops leads, customer success, enterprise demo team.

**Purpose:** describe the operational governance UX added in Phase F — destruction impact preview, destruction certificate viewer, retention inheritance summary — and the disciplined caveats that bound them.

---

## 1. What Phase F adds

PROOVRA already had a deep governance backend (15 Prisma models, full destruction state machine, append-only lifecycle ledger, certificate hash + lineage hash). What it did NOT have:

- A way to preview the consequences of destruction BEFORE clicking Execute.
- A way to view the destruction certificate body (the hash was shown, but not the artifact).
- A way for operators to see whether their workspace is governed by a local policy or an inherited org template.

Phase F adds three small, deterministic, read-only surfaces that close those gaps. **No backend governance logic changes.** The destruction state machine, audit emission, step-up enforcement, and lifecycle ledger are all unchanged.

---

## 2. The three new endpoints

All three are read-only, gated by `requireMember(teamId)` + `governance.policy.read` permission, and emit **no audit events** (browsing is not auditable; the mutating destructive endpoints keep their existing audit).

### 2.1 `GET /v1/governance/destruction-reviews/:id/preview?teamId=...`

Returns the operational impact preview for a destruction review:

```ts
{
  review:    { id, status, reason, ... },
  evidence:  { id, title, lifecycleState, createdAt } | null,
  policy:    { id, displayName, retentionDays, immutable, status } | null,
  holds: {
    evidence: [ ... active evidence-level holds ... ],
    case:     [ ... active case-level holds inherited via case links ... ],
  },
  impact: {
    willDelete: ["evidence_storage_object", "evidence_part_references"],
    willPersist: [
      "evidence_record_tombstone",
      "lifecycle_event_ledger",
      "destruction_certificate",
      "audit_log_references",
    ],
    irreversible: boolean,
    lifecycleEventCount: number,
  },
  blockedBy: [/* "evidence_legal_hold" | "case_legal_hold" | "retention_policy_immutable" | "already_destroyed" */],
  guidance:  string  // operator-readable next-step copy
}
```

**Key contract:** destruction is **never total erasure**. The `willPersist` array always includes the evidence-record tombstone, lifecycle event ledger, destruction certificate, and audit log references. Operators must understand this BEFORE approving.

### 2.2 `GET /v1/governance/destruction-reviews/:id/certificate?teamId=...`

Returns the canonical destruction certificate body for **EXECUTED** reviews only (409 with `code: "certificate_unavailable"` otherwise):

```ts
{
  certificate: {
    reviewId, evidenceId, teamId,
    executedAtUtc, decidedAtUtc, decidedByUserId,
    reason, decisionNote,
    retentionPolicyId, retentionPolicyVersion,
    certificateHash,        // SHA-256 over the canonical JSON body
    lineageHash,            // chains certificate + prior ledger digest
    lifecycleEventId,       // the destruction_executed event id
    reviewCreatedAt, eventSummary,
  },
  caveats: [
    "This certificate is an operational traceability record. It is not a legal admissibility statement.",
    "Destruction removes the original storage object. Evidence record tombstones, lifecycle event ledger entries, and destruction audit logs PERSIST and are intentionally not erased.",
    "This certificate does not assert cryptographic proof of total erasure across replicas, backups, or downstream third-party systems. ..."
  ]
}
```

**Vocabulary discipline (NON-NEGOTIABLE):** the three caveats above are rendered **verbatim** by the frontend — the wording is contract-asserted by the Phase F test suite. They explicitly disclaim:

- Legal admissibility.
- Cryptographic proof of total erasure.
- Compliance attestation.

This keeps the certificate as **operational traceability**, not legal theatre.

### 2.3 `GET /v1/governance/retention/inheritance?teamId=...`

Surfaces the Phase B0 `resolveTeamRetentionPolicy` resolver verdict:

```ts
{
  resolution:
    | { source: "team_policy"; teamId; policyId; retentionDays; immutable }
    | { source: "org_policy_inherited"; teamId; organizationId; template: {...} }
    | { source: "none"; teamId }
}
```

The endpoint is a thin pass-through. The resolver itself was already present; Phase F just surfaces its verdict for the UI.

---

## 3. The three new frontend components

### 3.1 `DestructionImpactPreview` (`apps/web/components/governance/DestructionImpactPreview.tsx`)

Renders the preview payload as a structured impact summary with:

- Evidence in scope (id + title + current lifecycle state).
- Governing retention policy snapshot.
- Active legal holds — separated into evidence-level and case-inherited.
- A two-column "Removed / Persists" matrix.
- Blockers list with operator-readable labels.
- Guidance string from the backend.

Mounted on `/governance/destruction` as a modal opened by the **Impact** button on every review row. Empty states cover: no workspace, loading, error.

### 3.2 `DestructionCertificate` (`apps/web/components/governance/DestructionCertificate.tsx`)

Renders the certificate body as a `<dl>` of canonical fields, with:

- A "Download certificate JSON" link backed by `URL.createObjectURL(new Blob(...))` so operators have an artifact for audit archives.
- A collapsible "Important operational caveats" panel rendering the three backend-supplied caveats verbatim.
- 409 handling — when the review is not yet EXECUTED, the component renders an operator-safe message: *"Destruction certificates are only generated once a review is EXECUTED."*

Mounted on `/governance/destruction` as a modal opened by the **Certificate** button — **shown only on EXECUTED rows**.

### 3.3 `RetentionInheritanceSummary` (`apps/web/components/governance/RetentionInheritanceSummary.tsx`)

Renders the resolver verdict in operator-readable form:

- `team_policy` — "This workspace is governed by its local team policy. Retention horizon: N days."
- `org_policy_inherited` — "This workspace inherits the retention template published by the parent organization. The organization template is immutable — workspaces may not weaken it."
- `none` — "No retention policy applies. The default (indefinite retention) is in effect."

Mounted at the top of `/governance/retention`, above the policy table, so the operator's first glance answers "where does my retention rule come from?"

---

## 4. UI integration points

| Surface | Phase F additions |
|---|---|
| `/governance/destruction` | Impact button (every row) + Certificate button (EXECUTED rows only) + impact-preview modal + certificate modal |
| `/governance/retention` | `RetentionInheritanceSummary` mounted above the policy table |

No other governance pages are touched in this phase. The Matter Workspace, Reviewer Console, Evidence detail, and Reports surfaces are unchanged.

---

## 5. Operational discipline preserved

| Discipline | How Phase F preserves it |
|---|---|
| Step-up on APPROVED / EXECUTED transitions | Unchanged — the new preview is read-only; destructive mutations still flow through the existing `POST .../transition` with step-up |
| Workspace isolation | `requireMember(teamId)` on every new endpoint; the `Evidence` query is narrowed by `teamId` + `evidenceId`; case-level holds resolved via `CaseEvidenceLink → caseLegalHold` constrained by `teamId` |
| Audit emission | Preview and certificate endpoints emit no audit (reads are not auditable). The destruction-executed lifecycle event continues to be the canonical audit anchor |
| Vocabulary | Caveats are backend-supplied and rendered verbatim. No frontend invention. No claims of legal admissibility, cryptographic erasure, compliance attestation, or authenticity |
| Public surface gating | Unchanged — public verify still returns 404 for DESTROYED evidence (state never leaks to unauthenticated callers) |
| Solo-user safety | No new sidebar entries; the new buttons live on the existing destruction page that's already permission-gated to governance admins |

---

## 6. Validation answers (per the Phase F spec)

1. **Can operators understand governance consequences clearly?** Yes — the impact preview lists evidence, policy, holds, blockers, and the removed/persists matrix in a single deterministic projection.
2. **Are destructive actions operationally explainable?** Yes — the operator sees what will happen BEFORE clicking Execute; the certificate then proves what DID happen.
3. **Is governance inheritance understandable?** Yes — the inheritance summary renders one of three deterministic verdicts.
4. **Are lifecycle states operationally visible?** The preview surfaces the evidence's current lifecycle state; broader per-evidence visibility is deferred to F.1 (see follow-ups).
5. **Is destruction traceability enterprise-grade?** Yes — the certificate combines the backend's SHA-256 hash, lineage hash, lifecycle event id, and reviewer attribution into a downloadable JSON artifact.
6. **Do governance actions feel trustworthy?** Yes — every claim is backed by the backend payload; caveats explicitly bound what the certificate does and does NOT prove.
7. **Is governance still evidence-centric?** Yes — every Phase F surface is anchored on a destruction review, which is itself anchored on a single evidence record.
8. **Did any reviewer/workspace/export flows break?** No — 411/411 phase contract tests green; the 10 baseline failures pre-date Phase F.
9. **Is PROOVRA more credible in enterprise governance demos?** Materially yes — the preview answers the buyer's question "what does this destroy?" before any click; the certificate answers "what did it actually do?" after.
10. **Does governance UX match the maturity of the operational platform?** Yes for these three surfaces. The remaining lifecycle and audit visibility work is recorded as deferred follow-ups.

---

## 7. Reference

- Backend route changes: `services/api/src/routes/governance-lifecycle.routes.ts`
- Frontend components: `apps/web/components/governance/`
  - `DestructionImpactPreview.tsx`
  - `DestructionCertificate.tsx`
  - `RetentionInheritanceSummary.tsx`
- Page integration: `apps/web/app/(app)/governance/destruction/page.tsx`, `apps/web/app/(app)/governance/retention/page.tsx`
- Tests: `services/api/test/phase-f-governance-ux.test.ts` (62 source-contract tests)
- Phase B0 resolver (unchanged): `services/api/src/services/organization/retention-inheritance.service.ts`

---

## 8. Deferred follow-ups

Recorded in `docs/architecture/deferred-followups.md` as **F.1–F.6**.
