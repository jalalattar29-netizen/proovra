# Target Platform Constitution (Phase 12A system-truth baseline, 2026-07-28)

This document encodes the **target product contract** as the authority against which the
current system is reconciled. Ledger entries, code comments and prior completion claims are
NOT authoritative. The sources of truth are: this contract, current production code + schema,
the actual route/page/worker/writer dependency graphs, and executable behavioral tests.

## 1. Core semantics (subject separation)

| Concept | Meaning | Never |
|---|---|---|
| **Account** | Global user identity, profile, personal billing | — |
| **Persona** | Presentation only | never authorization |
| **Plan** | Commercial features + limits | never permissions |
| **Role** | Permissions | never tenant scope |
| **Workspace** | Evidence / Case / data scope | never billing owner by itself |
| **Organization** | Enterprise governance, security, identity, contract owner | — |
| **Collaboration Team** | Collaboration grouping | never tenant/billing authority |

## 2. Workspace kinds

- **PERSONAL** — personal data scope; account entitlement; no team-membership authority; may be
  forbidden by a managed Organization `noPersonalSpace` policy.
- **OWNED** — collaborative Workspace explicitly provisioned by a PRO/TEAM creation allowance;
  persists its **own** commercial state; **never inherits the owner's plan at runtime**.
- **ORGANIZATION** — belongs to exactly one Organization; contract-backed commercial coverage;
  OrganizationSecurityPolicy / SSO / SCIM / managed identity are **Organization-owned**;
  Evidence remains **Workspace-scoped**.

## 3. Login / context establishment

Authentication proves **global identity only**. Every context establishment MUST load + enforce:
Workspace kind · Organization lifecycle · ACTIVE membership · canonical authorization ·
Organization security/session policy · commercial subject + lifecycle · context generation.

Forbidden: silent Personal fallback · implicit Evidence transfer · client-declared tenant/role/plan/policy.

## 4. Plans (commercial contract)

- **FREE** — Personal Workspace only (as owner); core Capture/Evidence/Cases/Verify/basic Reports;
  no owned collaboration Workspaces; no invitations/members; honest locked collaboration/upgrade state.
- **PAYG** — Personal Workspace; one-time Evidence/workflow entitlement; no recurring Workspace-plan
  upgrade; no owned collaboration Workspace; no plan inheritance beyond the purchased operation.
- **PRO** — Personal professional entitlement; creation allowance **up to 2** owned collaborative
  Workspaces/Teams; **up to 5** members per Team; professional Evidence/Case/Intake/Reports/Search/
  collaboration; every created Workspace persists explicit commercial state.
- **TEAM** — team-first shared operations; creation allowance **up to 5** owned Teams; **up to 5**
  members per Team; assignments/tasks/review queues/intake/shared operations/team governance;
  explicit Workspace commercial state.
- **ENTERPRISE** — Organization contract; provisioned Workspaces; custom limits; SSO/SCIM/managed
  identity; OrganizationSecurityPolicy; Organization-wide governance; service accounts; enterprise
  audit/integrations; break-glass/support access; Personal Workspace only when Organization policy permits.

## 5. Commercial rule

- Personal subject → personal entitlement.
- Owned Workspace → its **persisted** commercial state.
- Organization Workspace → Organization contract.
- **Owner-plan fallback for an Owned Workspace = FORBIDDEN.**
- Provider state flows through **one** lifecycle authority.
- Over-limit NEVER deletes Evidence/custody.

## 6. Evidence rule

Every Evidence / Case / Request / Review / Report / Package / Redaction / Hold / Destruction object
is bound to an **authoritative persisted Workspace scope**. Workers **reload** persisted scope + policy.
Original Evidence and historical custody remain **immutable**.

## 7. Frontend rule

Frontend/Mobile render **server projections** and collect intent only. They do NOT decide: tenant
kind · membership · authorization · commercial plan · security policy · retention/legal-hold precedence ·
worker policy. **Frontend raw-plan decisions = 0.**

## 8. Verticals (registry taxonomy)

`PLATFORM_CORE` · `EVIDENCE_OPERATIONS` · `ENTERPRISE_IDENTITY_SECURITY` ·
`OPERATIONS_INTELLIGENCE` · `TRUST_ADMINISTRATION`.

## 9. Reconciliation classifications (system truth)

Every capability/production symbol is exactly one of: `TARGET_COMPLETE` · `TARGET_PARTIAL` ·
`LEGACY_ACTIVE` · `PARALLEL_SYSTEM` · `BACKEND_ONLY_UNWIRED` · `FRONTEND_ONLY_BROKEN` ·
`INTERNAL_REQUIRED` · `FUTURE_NOT_SHIPPING` · `HISTORICAL_PRESERVE` · `COMPATIBILITY_TEMPORARY` ·
`UNCLASSIFIED`. Classification by "zero consumers" alone or by file age/name alone = 0.

The machine-checked baseline lives in `current-runtime-capability-map.json`,
`target-replacement-matrix.json`, `plan-page-visibility-matrix.json`,
`user-journey-coverage.json`, `schema-migration-classification.json`, and the executable gate
`services/api/test/phase-12a-reconciliation-gate.test.ts`.
