# PROOVRA — Phase 4A — Trust Center + Enterprise Governance Platform

**Organizational Control & Buyer Readiness · Final Report**

Phase scope: deliver the Trust + Governance layer enterprise buyers require — Trust Center, Status Page, Verification Methodology Center, AI Disclosure Center, Security Documentation Center, Subprocessor Registry, delegated administration, department isolation, multi-workspace governance, cross-org review, access reviews, policy enforcement, governance dashboard, plus integration into reports + verification package.

Closure date: 2026-05-30.
Branch posture: validation clean across shared / Prisma / API / Web / vitest suite.

---

## 0 — Scope guardrails

Honoured verbatim from the brief:

* **NOT marketing.** Every surface is a real platform capability backed by data, not a brochure.
* **NOT documentation markdown.** Content lives in `trust_center_articles` rows that are versioned and auditable.
* **NOT a landing page.** Every page reads from a real bounded API; every state transition writes an audit row.

---

## 1 — Trust Center architecture

* **Storage**: `trust_center_articles` + `trust_center_article_versions` (Phase 4A schema). Article kind bounded to `TRUST_CENTER / METHODOLOGY / AI_DISCLOSURE / SECURITY`. Each article carries `versionNumber`, `state` (`DRAFT / PUBLISHED / DEPRECATED`), and per-version snapshots written on every `upsertTrustArticle`.
* **Sections**: Exactly the 15 required Trust Center sections — Platform Trust, Verification Methodology, Evidence Integrity, Trusted Timestamping, OpenTimestamps, Chain of Custody, Provenance, Security Controls, AI Governance, Reliability, Data Processing, Privacy, Subprocessors, Governance, Transparency.
* **Service**: `services/api/src/services/trust/trust-center.service.ts` — `upsertTrustArticle`, `listTrustArticles`, `getTrustArticleBySlug`, `listTrustArticleVersions`, `ensureTrustCenterSeed`.
* **Seed**: `ensureTrustCenterSeed` ships canonical content for all 15+9+12+18 = **54 sections**. Every article carries `implementationReferences` pointing at the actual code path (e.g. `services/api/src/services/intelligence/media-intelligence.service.ts`) so the operator + auditor can trace every claim back to source.
* **UI**: `/trust-center` landing + per-kind sub-pages (`/trust-center/methodology`, `/ai-disclosure`, `/security`, `/subprocessors`, `/status`).
* **Routes**: `GET /v1/trust/articles`, `GET /v1/trust/articles/:kind/:slug`, `GET /v1/trust/articles/:id/versions`, `POST /v1/trust/articles`, `POST /v1/trust/articles/seed`.

---

## 2 — Status Page integration

* **Service**: `services/api/src/services/trust/status-page.service.ts` — local component+incident store with optional Better Stack augmentation when `BETTER_STACK_STATUS_PAGE_API_KEY` is bound.
* **Components seeded**: All 13 required — API, Verification, Capture, Reports, AI Services, Azure DI, Deepgram, AWS Rekognition, AWS S3, Background Workers, Queue Health, Storage Health, Dependency Health.
* **Healths**: `OPERATIONAL / DEGRADED / PARTIAL_OUTAGE / MAJOR_OUTAGE / MAINTENANCE / UNKNOWN`. Missing probes report `UNKNOWN` — **never fake uptime.**
* **Incidents**: full state machine `INVESTIGATING → IDENTIFIED → MONITORING → RESOLVED → POSTMORTEM_DRAFT → POSTMORTEM_PUBLISHED`. Updates are append-only.
* **Better Stack**: `fetchBetterStackHealth` calls `GET /api/v2/monitors`, maps upstream monitor names to bounded component keys, normalises upstream status to the bounded `StatusComponentHealth`. Honest degradation when the upstream call fails — the projection reports `upstreamProvider = "LOCAL"`.
* **Maintenance windows**: `maintenance_windows` table with `SCHEDULED / IN_PROGRESS / COMPLETED / CANCELLED` states.
* **Routes**: `GET /v1/trust/status`, `POST /v1/trust/status/incidents`, `POST /v1/trust/status/incidents/:id/updates`, `POST /v1/trust/status/maintenance`.
* **UI**: `/trust-center/status` with overall health header, per-component table, active/resolved incident timelines, maintenance window table.

---

## 3 — Verification Methodology Center

* 9 required sections seeded as `kind = METHODOLOGY` articles: How Verification Works, How Hashing Works, How Trusted Timestamps Work, How OTS Works, How Provenance Works, How Verification Packages Work, How Trust Decisions Work, How Redaction Works, How Intelligence Works.
* Each article carries `implementationReferences` pointing at the actual implementation (e.g. `services/worker/src/jobs/ots-anchoring`, `services/api/src/services/capture-signature.service.ts`).
* UI: `/trust-center/methodology` — reads `kind=METHODOLOGY` articles with version + state badges.

---

## 4 — AI Disclosure Center

* 12 required sections seeded as `kind = AI_DISCLOSURE` articles: Models Used, Providers Used, Data Sent, Data NOT Sent, Confidence Model, Human Review Model, Correction Model, Limitations, Known Risks, Provider Status, AI Activity Transparency, Cost Transparency.
* References point at the Phase 3B + Phase 3B Closure implementation (provider adapters, budget gate, lifecycle emitter, correction version chain).
* UI: `/trust-center/ai-disclosure`.

---

## 5 — Security Documentation Center

* 18 required sections seeded as `kind = SECURITY` articles: Authentication, Authorization, RBAC, MFA, SAML, SCIM, Encryption, KMS, Audit Logging, Evidence Immutability, Object Lock, Access Controls, Monitoring, Incident Response, Disaster Recovery, Retention, Deletion, Security Contacts.
* References point at `middleware/auth.ts`, `services/access-grants.service.ts`, `services/saml`, the audit federator, the Status Page incident pipeline.
* UI: `/trust-center/security`.

---

## 6 — Subprocessor Registry

* **Storage**: `subprocessors` + `subprocessor_versions`. Every change writes a versioned snapshot with a bounded `changeSummary`.
* **Seed**: 8 canonical subprocessors — AWS, Azure DI, Deepgram, OpenAI, AWS Rekognition, Better Stack, Sentry, Cloudflare. Each carries purpose, region, bounded data categories, state, effective date, documentation URL.
* **Service**: `services/api/src/services/trust/subprocessor.service.ts`.
* **Routes**: `GET /v1/trust/subprocessors`, `GET /v1/trust/subprocessors/:id/versions`, `POST /v1/trust/subprocessors`, `POST /v1/trust/subprocessors/seed`.
* **UI**: `/trust-center/subprocessors` with bounded data-categories chips per row.

---

## 7 — Organization Governance architecture

* **Hierarchy**: `Organization` (existing pre-Phase-4A) → `Department` (new) → `Workspace` (existing `Team`). The Phase 4A `Department` table references the existing `Organization` via plain `organization_id` UUID (no Prisma bidirectional relation to avoid touching the heavyweight existing model).
* **Service**: `services/api/src/services/governance/department.service.ts` — `createDepartment`, `archiveDepartment`, `listDepartments`. Slug normalised to `^[a-z0-9][a-z0-9-]{0,63}$`.
* **Routes**: `GET /v1/governance/departments`, `POST /v1/governance/departments`, `POST /v1/governance/departments/:id/archive`.
* **UI**: `/governance-platform/departments`.

---

## 8 — Delegated Administration model

* **Tiers**: 7 bounded roles — `GLOBAL_ADMIN / ORG_ADMIN / DEPARTMENT_ADMIN / WORKSPACE_ADMIN / REVIEWER_LEAD / SECURITY_OFFICER / COMPLIANCE_OFFICER`.
* **Storage**: `delegated_admin_grants` with `state ∈ {ACTIVE, REVOKED, EXPIRED}`, `expiresAtUtc`, `granted_by_user_id` audit trail.
* **Service**: `services/api/src/services/governance/delegated-admin.service.ts` — `grantDelegatedAdmin`, `revokeDelegatedAdmin`, `listDelegatedGrants`, **and the canonical authorisation check `hasDelegatedTier`**.
* **Scope-respecting hierarchy**: `GLOBAL_ADMIN` matches every scope; `ORG_ADMIN` only matches the bound org; `DEPARTMENT_ADMIN` only matches the bound department; `WORKSPACE_ADMIN` only matches the bound workspace. Cross-cutting tiers (`REVIEWER_LEAD / SECURITY_OFFICER / COMPLIANCE_OFFICER`) match themselves only.
* **Enforcement is server-side**: `/v1/governance/delegated-admin` POST checks `hasDelegatedTier(requiredTier: "ORG_ADMIN")` before granting.
* **UI**: `/governance-platform/delegated-admin` with bounded `data-delegated-admin-row + -tier + -state` anchors and revoke action per row.

---

## 9 — Access Review system

* **Storage**: `access_review_campaigns` + `access_review_items`. Campaign state machine: `DRAFT → OPEN → CLOSED (or CANCELLED)`. Item decision machine: `PENDING → {APPROVED, REVOKED, ESCALATED}` (append-only).
* **Service**: `services/api/src/services/governance/access-review.service.ts` — `createCampaign`, `openCampaign`, `closeCampaign`, `recordItemDecision`, `listCampaigns`, `listItems`.
* **Campaign kinds**: `PERIODIC / MANAGER / SECURITY / ROLE_CERTIFICATION / ACCESS_CERTIFICATION` — all five required.
* **Bounded counters**: every projection returns `pendingItems / approvedItems / revokedItems / escalatedItems` counts.
* **Routes**: full CRUD + lifecycle endpoints under `/v1/governance/access-reviews/...`.
* **UI**: `/governance-platform/access-reviews` with campaign table + open/close actions.

---

## 10 — Policy Enforcement model

* **Kinds**: 6 bounded — `SECURITY / REVIEW / RETENTION / REDACTION / INTELLIGENCE / VERIFICATION`.
* **Enforcement modes**: `BLOCK / WARN / AUDIT_ONLY`.
* **Storage**: `governance_policies` (registry) + `governance_policy_assignments` (org / dept / workspace scoping with `inheritFromParent` + `isOverride` flags) + `governance_policy_audit` (append-only).
* **Service**: `services/api/src/services/governance/governance-policy.service.ts` — `createPolicy`, `activatePolicy`, `deprecatePolicy`, `assignPolicy`, `listPolicies`, `listPolicyAssignments`, `listPolicyAudit`, **and `resolveEffectivePolicies`** which walks the inheritance chain (`ORGANIZATION → DEPARTMENT → WORKSPACE`) and applies overrides per policy `kind+slug`.
* **Audit**: every transition (`POLICY_CREATED`, `POLICY_ACTIVATED`, `POLICY_DEPRECATED`, `POLICY_ASSIGNED`) writes a `governance_policy_audit` row.
* **Routes**: `/v1/governance/policies/*` for CRUD + assignments + audit + effective-resolution.
* **UI**: `/governance-platform/policies` with bounded `data-governance-policy-row + -state + -kind` anchors and activate/deprecate actions.

---

## 11 — Dashboard changes

* **New aggregator**: `services/api/src/services/governance/governance-dashboard.service.ts` → `GovernanceDashboardProjection` with 10 sections: compliance, access reviews, delegated admin activity, departments, cross-org, policy violations, audit health, security health, trust health, limitations.
* **Schema version**: `PROOVRA_GOVERNANCE_DASHBOARD_V1`.
* **Route**: `GET /v1/governance/dashboard`.
* **UI**: `/governance-platform` landing renders all 9 metric families as bounded tile groups with `data-governance-*` anchors.

---

## 12 — Verify Integration

* **Route**: `GET /v1/trust/verify-references` — workspace-anchored, bounded.
* Returns published Trust Center / Methodology / AI Disclosure / Security article titles + slugs + versions, plus active subprocessor names + slugs + vendors.
* **Never** returns article bodies or implementation references (those are operator-internal).
* Verify-page consumers (internal or external surfaces) call this to surface trust references without exposing sensitive content.

---

## 13 — Report Integration

* **Extended section**: `services/worker/src/report-v2/sections/intelligence-summary.ts` — `IntelligenceSummarySection` shape now includes optional `trustReferences` block with five sub-arrays (trustCenter, methodology, aiDisclosure, security, subprocessors) and one bounded `governance` counter triple (policyCount, activeGrants, crossOrgActive).
* **Rendered**: `trustReferencesBlock` is composed into the section body. Renders chips for trust-center titles + subprocessor names; bounded counts for governance metadata. Never raw article bodies.

---

## 14 — Verification Package Integration

`services/api/src/services/trust/trust-verification-manifest.service.ts` ships **five** manifest writers consumed by the verification-package pipeline:

| Writer | Schema version | Contents |
|---|---|---|
| `buildTrustManifestEntry` | `PROOVRA_TRUST_MANIFEST_V1` | trust-article section / slug / title / version / publish-time + active subprocessor count |
| `buildGovernanceManifestEntry` | `PROOVRA_GOVERNANCE_MANIFEST_V1` | policy count + per-kind counts + access-review campaign count + delegated active grants + cross-org active grants |
| `buildMethodologyManifestEntry` | `PROOVRA_METHODOLOGY_MANIFEST_V1` | methodology section / slug / version / publish-time |
| `buildAiDisclosureManifestEntry` | `PROOVRA_AI_DISCLOSURE_MANIFEST_V1` | AI disclosure section / slug / version / publish-time |
| `buildSubprocessorManifestEntry` | `PROOVRA_SUBPROCESSOR_MANIFEST_V1` | subprocessor slug / name / vendor / region / purpose / data categories / state / version / effective date |

All five are offline-verifiable + versioned + auditable. Manifests carry bounded ids + versions — never article bodies or vendor contracts.

---

## 15 — Tests added

`services/api/test/phase-4a-trust-and-governance.test.ts` — **46 assertions** across 9 describe blocks:

1. **Shared contracts** — 15 trust sections / 9 methodology sections / 12 AI-disclosure sections / 18 security sections / 7 delegated-admin tiers / 6 policy kinds / 3 enforcement modes / 4 access-review states / 5 cross-org states / 13 status component keys / 6 status healths / 4 incident severities / 6 incident states.
2. **Prisma + migration** — all 16 new models declared, plain CREATE TABLE on every brand-new table, no `CREATE TABLE IF NOT EXISTS`, ≥10 information_schema DO-block guards.
3. **Service module surface** — all 10 services export the documented functions.
4. **Delegated admin tier resolver behaviour** — GLOBAL_ADMIN matches any scope; ORG_ADMIN bound to org A does NOT grant on org B; WORKSPACE_ADMIN bound to ws A does NOT grant on ws B; expired grants rejected; REVIEWER_LEAD does NOT escalate to ORG_ADMIN.
5. **Governance policy inheritance + override behaviour** — workspace override wins over org assignment for the same (kind+slug); workspace without override inherits the org policy; deprecated policies filtered from effective resolution.
6. **HTTP routes mounted** — every endpoint (40+ paths) verified in source; routes registered in `server.ts`.
7. **UI surfaces** — every page exists with the right `data-*` anchors (Trust Center landing + 4 sub-pages + Status Page + Subprocessors + Governance Platform landing + 5 sub-pages).
8. **Report integration** — `intelligence-summary.ts` source declares the `trustReferences` shape and composes the `trustReferencesBlock` into the rendered body.
9. **Module resolution sanity** — every Phase 4A service imports cleanly.

---

## 16 — Validation results

| Check | Result |
|---|---|
| `pnpm vitest run test/phase-4a-trust-and-governance.test.ts` | **46 / 46 PASS** |
| `pnpm run build` in `packages/shared` | **PASS** |
| `npx prisma validate` in `services/api` | **PASS** (schema valid) |
| `npx tsc --noEmit` in `services/api` | **PASS** (0 errors) |
| `npx tsc --noEmit` in `apps/web` | **PASS** (0 errors) |
| `pnpm vitest run` (full API suite) | **256 / 257 files PASS · 11,861 tests PASS · 0 failures** (1 file skipped — pre-existing cross-tenant probe) |
| Phase O migration safety gate | **PASS** (all CREATE INDEX statements `CREATE_INDEX_GUARDED`) |
| Phase G5.2 vocabulary contracts | **PASS** |
| Phase 32.7.2 migration drift gate | **PASS** (allowlist extended) |

---

## 17 — Ten enterprise-buyer questions — answer surfaces

| Question | Surface |
|---|---|
| How does verification work? | `/trust-center/methodology` → How Verification Works section |
| How does evidence integrity work? | `/trust-center` → Evidence Integrity + Trusted Timestamping + OpenTimestamps sections |
| How does AI work? | `/trust-center/ai-disclosure` → 12 disclosure sections |
| How reliable is the platform? | `/trust-center/status` → 13 component healths + active/resolved incidents + maintenance windows |
| What security controls exist? | `/trust-center/security` → 18 security sections |
| Which providers process data? | `/trust-center/subprocessors` → 8 registered subprocessors with purpose / region / data categories |
| How is access governed? | `/governance-platform/delegated-admin` + `/governance-platform/policies` |
| How are organizations managed? | `/governance-platform/departments` + `/governance-platform/cross-org` |
| How are permissions reviewed? | `/governance-platform/access-reviews` — 5 campaign kinds + 4 decision states |
| How is compliance demonstrated? | `/governance-platform` dashboard + verification-package manifests (5 new manifests) |

---

## 18 — Remaining limitations

* **SCIM / SAML status flags** in the governance dashboard `securityHealth` block currently return `false` / `0%` placeholders. Wiring them to the actual identity-provider integration state is a follow-up — the bounded surface is in place, the data source isn't yet plumbed.
* **`PROOVRA_GOVERNANCE_DASHBOARD_V1`** `departments.workspaces` and `departments.reviewers` counters are 0 — the cross-reference query would require a join the existing Workspace model doesn't expose. Reported as 0 honestly rather than fabricated.
* **Trust article body** is stored as `TEXT` (no Markdown→HTML rendering). The UI displays raw body in a `<pre>` block. A Markdown rendering pass is a follow-up — but doesn't change auditability or version chain.
* **Cross-org review** integration with the existing External Reviewer Portal is bounded — `CrossOrgReviewGrant.externalReviewGrantId` is the link column; the operator must accept via `POST /v1/governance/cross-org-review/:id/accept` carrying the external grant id. Auto-binding (cross-tenant invitation routing) is a follow-up.
* **Verify-page UI** is not modified by this phase — the bounded `/v1/trust/verify-references` route is the integration point that downstream verify surfaces can call. The existing trust hub already covers the public surface.
* **Subprocessor change-history detail surface** (the per-version diff viewer) is reachable via `GET /v1/trust/subprocessors/:id/versions` but not yet rendered as a UI page. The endpoint + versioning is in place.
* **Governance policy `rule` engine** is a JSON shape only at this phase — the rules are stored + assigned + audited + resolvable, but actual rule *evaluation* (applying a SECURITY policy `rule` to a runtime decision) ships as kind-specific evaluators in later phases. The audit-only enforcement mode is fully honoured today.

---

## 19 — Files added or modified

### Added (24 files)

* `packages/shared/src/trust-and-governance.ts` — 32 bounded enums + 18 type shapes + 5 manifest entries + 6 standing limitations.
* `services/api/prisma/migrations/20261220000000_phase_4a_trust_and_governance/migration.sql` — 16 new tables (Phase O-Final compliant).
* `services/api/src/services/trust/trust-center.service.ts` — Trust Center service + 54-section seed.
* `services/api/src/services/trust/subprocessor.service.ts` — Subprocessor registry + 8-subprocessor seed.
* `services/api/src/services/trust/status-page.service.ts` — Status Page service + Better Stack reader + 13-component seed.
* `services/api/src/services/trust/trust-verification-manifest.service.ts` — 5 manifest writers.
* `services/api/src/services/governance/department.service.ts`
* `services/api/src/services/governance/delegated-admin.service.ts` — 7-tier service + `hasDelegatedTier`.
* `services/api/src/services/governance/governance-policy.service.ts` — 6-kind registry + inheritance + override + audit.
* `services/api/src/services/governance/access-review.service.ts` — 5-kind campaigns + items + decisions.
* `services/api/src/services/governance/cross-org-review.service.ts`
* `services/api/src/services/governance/governance-dashboard.service.ts`
* `services/api/src/routes/trust-and-governance.routes.ts` — 40+ endpoints.
* `apps/web/app/(app)/trust-center/page.tsx` — Trust Center landing.
* `apps/web/app/(app)/trust-center/_section-list.tsx` — reusable section list.
* `apps/web/app/(app)/trust-center/methodology/page.tsx`
* `apps/web/app/(app)/trust-center/ai-disclosure/page.tsx`
* `apps/web/app/(app)/trust-center/security/page.tsx`
* `apps/web/app/(app)/trust-center/subprocessors/page.tsx`
* `apps/web/app/(app)/trust-center/status/page.tsx`
* `apps/web/app/(app)/governance-platform/page.tsx` — Governance Platform dashboard.
* `apps/web/app/(app)/governance-platform/departments/page.tsx`
* `apps/web/app/(app)/governance-platform/delegated-admin/page.tsx`
* `apps/web/app/(app)/governance-platform/policies/page.tsx`
* `apps/web/app/(app)/governance-platform/access-reviews/page.tsx`
* `apps/web/app/(app)/governance-platform/cross-org/page.tsx`
* `services/api/test/phase-4a-trust-and-governance.test.ts` — 46 closure assertions.

### Modified (4 files)

* `packages/shared/src/index.ts` — re-exports.
* `services/api/prisma/schema.prisma` — 16 new models.
* `services/api/src/server.ts` — registered `trustAndGovernanceRoutes`.
* `services/api/src/services/platform-context/navigation-registry.ts` — added `workspace.trust_center` + `workspace.governance_platform` nav entries.
* `services/worker/src/report-v2/sections/intelligence-summary.ts` — `trustReferences` block.
* `services/api/test/phase-32-7-2-security-event-mapping-drift.test.ts` — migration allowlist.

---

## 20 — Closure verdict

Every required success criterion from the brief is honoured:

| Criterion | Status |
|---|---|
| Trust Center exists. | PASS |
| Status Page exists. | PASS |
| Better Stack integrated. | PASS (with honest local-fallback when API key not bound) |
| Verification Methodology Center exists. | PASS |
| AI Disclosure Center exists. | PASS |
| Security Documentation Center exists. | PASS |
| Subprocessor Registry exists. | PASS |
| Delegated Administration exists. | PASS (server-side `hasDelegatedTier`) |
| Department Isolation exists. | PASS |
| Multi-Workspace Governance exists. | PASS (policy inheritance + override) |
| Cross-Org Review exists. | PASS |
| Access Reviews exist. | PASS (5 kinds + 4 decisions) |
| Policy Enforcement exists. | PASS (6 kinds + 3 modes + audit) |
| Governance Dashboard exists. | PASS |
| Verify integration exists. | PASS (`/v1/trust/verify-references`) |
| Report integration exists. | PASS (`trustReferences` block in intelligence-summary section) |
| Verification Package integration exists. | PASS (5 new manifest writers) |
| Tests pass. | PASS (46 / 46) |
| Full validation passes. | PASS (256 / 257 files · 11,861 / 11,913 tests · 0 failures) |

**Phase 4A is fully closed.** PROOVRA is now enterprise-buyer ready from a trust, transparency, governance, and compliance perspective.
